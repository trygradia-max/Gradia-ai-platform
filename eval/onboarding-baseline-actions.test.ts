import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { unk, v, validAnswers } from "./_baseline-fixtures"

/**
 * Action seam: the shop and actor come from the session, never from the caller. The database stays the
 * authority (it is exercised in eval/integration/onboarding-baseline.int.test.ts); here we prove which
 * shop the seam addresses, what it refuses before any database call, and how failures are reported.
 */
const state = vi.hoisted(() => ({
  user: { id: "user-1" } as { id: string } | null,
  owned: null as { id: string; name: string } | null,
  workspaces: { data: [] as unknown[], error: null as unknown },
  rpc: vi.fn(),
}))

vi.mock("@/lib/shop", () => ({
  requireUser: vi.fn(async () => {
    if (!state.user) throw new Error("NEXT_REDIRECT")
    return state.user
  }),
  getOptionalShop: vi.fn(async () => state.owned),
}))
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: (name: string, args: Record<string, unknown>) => {
      if (name === "team_workspaces") return Promise.resolve(state.workspaces)
      return state.rpc(name, args)
    },
  }),
}))

import {
  getBaselineComparison,
  getBaselineStartingPoint,
  saveBaselineDraft,
  submitBaselineAssessment,
} from "@/app/actions/onboarding-baseline"

const SHOP = "11111111-1111-4111-8111-111111111111"
const OTHER = "22222222-2222-4222-8222-222222222222"
const baselineCalls = () => state.rpc.mock.calls.map((c) => c[0] as string)
const ws = (role: string, capabilities: string[], id = SHOP) => ({ id, name: "Shop", role, capabilities, location_id: id })
const empty = { role: "owner", pointer: null, revision: null, measurements: [], draft: null }

beforeEach(() => {
  state.user = { id: "user-1" }
  state.owned = { id: SHOP, name: "North Shore" }
  state.workspaces = { data: [], error: null }
  state.rpc.mockReset()
  state.rpc.mockResolvedValue({ data: empty, error: null })
})
afterEach(() => vi.useRealTimers())

describe("session-derived workspace", () => {
  it("addresses the owner's active shop and ignores any argument the caller adds", async () => {
    const stray = getBaselineStartingPoint as unknown as (shopId: string) => Promise<unknown>
    await stray(OTHER)
    expect(state.rpc).toHaveBeenCalledWith("baseline_read", { p_shop: SHOP, p_revision: null })
    expect(JSON.stringify(state.rpc.mock.calls)).not.toContain(OTHER)
  })

  it("lets an active manager with the baseline.draft grant read and draft their workspace", async () => {
    state.owned = null
    state.workspaces = { data: [ws("manager", ["crm.read", "baseline.draft"], OTHER)], error: null }
    state.rpc.mockResolvedValueOnce({ data: { ...empty, role: "manager" }, error: null })
    expect(await getBaselineStartingPoint()).toMatchObject({ status: "not_started", role: "manager" })
    expect(state.rpc.mock.calls[0]).toEqual(["baseline_read", { p_shop: OTHER, p_revision: null }])

    state.rpc.mockResolvedValueOnce({ data: { draft_version: 1 }, error: null })
    const saved = await saveBaselineDraft({ answers: { calls_per_week: v(3, "count_per_week") }, expectedDraftVersion: null })
    expect(saved).toEqual({ ok: true, data: { draftVersion: 1 } })
    expect(state.rpc.mock.calls[1][1]).toMatchObject({ p_shop: OTHER })
  })

  it.each([
    ["a manager without the grant", [ws("manager", ["crm.read"])]],
    ["staff, even with the grant string", [ws("staff", ["baseline.draft"])]],
    ["no membership at all", []],
  ])("denies %s before any baseline call", async (_name, data) => {
    state.owned = null
    state.workspaces = { data, error: null }
    expect(await getBaselineStartingPoint()).toEqual({ status: "forbidden" })
    expect(await saveBaselineDraft({ answers: {}, expectedDraftVersion: null })).toEqual({ ok: false, code: "forbidden" })
    expect(await submitBaselineAssessment({ answers: validAnswers(), expectedBaseline: null, expectedDraftVersion: null })).toEqual({ ok: false, code: "forbidden" })
    expect(state.rpc).not.toHaveBeenCalled()
  })

  it("reports unavailable, not forbidden or empty, when membership cannot be verified", async () => {
    state.owned = null
    state.workspaces = { data: [], error: { code: "XX000" } }
    expect(await getBaselineStartingPoint()).toEqual({ status: "unavailable" })
    expect(await saveBaselineDraft({ answers: {}, expectedDraftVersion: null })).toEqual({ ok: false, code: "unavailable" })
    expect(state.rpc).not.toHaveBeenCalled()
  })

  it("never reaches the database for an anonymous caller", async () => {
    state.user = null
    await expect(getBaselineStartingPoint()).rejects.toThrow("NEXT_REDIRECT")
    await expect(saveBaselineDraft({ answers: {}, expectedDraftVersion: null })).rejects.toThrow("NEXT_REDIRECT")
    expect(state.rpc).not.toHaveBeenCalled()
  })

  it("surfaces the database's own refusal (cross-shop, revoked, staff) as forbidden", async () => {
    state.rpc.mockResolvedValue({ data: null, error: { code: "42501" } })
    expect(await getBaselineStartingPoint()).toEqual({ status: "forbidden" })
    expect(await saveBaselineDraft({ answers: {}, expectedDraftVersion: null })).toEqual({ ok: false, code: "forbidden" })
    expect(await submitBaselineAssessment({ answers: validAnswers(), expectedBaseline: null, expectedDraftVersion: null })).toEqual({ ok: false, code: "forbidden" })
  })
})

describe("caller-supplied authority is refused", () => {
  const stray: Array<[string, Record<string, unknown>]> = [
    ["shopId", { shopId: OTHER }],
    ["userId", { userId: "someone" }],
    ["role", { role: "owner" }],
    ["period", { periodStart: "2020-01-01", periodEnd: "2020-12-31" }],
    ["evidence", { evidence: [OTHER] }],
  ]
  it.each(stray)("save draft rejects %s", async (_n, extra) => {
    const r = await saveBaselineDraft({ answers: {}, expectedDraftVersion: null, ...extra })
    expect(r).toEqual({ ok: false, code: "invalid" })
    expect(state.rpc).not.toHaveBeenCalled()
  })
  it.each(stray)("submit rejects %s", async (_n, extra) => {
    const r = await submitBaselineAssessment({ answers: validAnswers(), expectedBaseline: null, expectedDraftVersion: null, ...extra })
    expect(r).toEqual({ ok: false, code: "invalid" })
    expect(state.rpc).not.toHaveBeenCalled()
  })
  it("rejects malformed versions and a comparison that names a shop", async () => {
    expect(await saveBaselineDraft({ answers: {}, expectedDraftVersion: 0 })).toEqual({ ok: false, code: "invalid" })
    expect(await saveBaselineDraft({ answers: {}, expectedDraftVersion: "1" })).toEqual({ ok: false, code: "invalid" })
    expect(await getBaselineComparison({ shopId: OTHER, windowStart: "2026-10-01T00:00:00Z", windowEnd: "2026-10-31T00:00:00Z" })).toEqual({ status: "unavailable" })
    expect(state.rpc).not.toHaveBeenCalled()
  })
})

describe("saving and submitting", () => {
  it("validates answers before the database and returns plain issues", async () => {
    const r = await saveBaselineDraft({ answers: { calls_per_week: v(5, "count_per_month") }, expectedDraftVersion: null })
    expect(r).toEqual({ ok: false, code: "invalid", issues: [{ key: "calls_per_week", code: "unit_not_allowed" }] })
    const s = await submitBaselineAssessment({ answers: { calls_per_week: unk }, expectedBaseline: null, expectedDraftVersion: null })
    expect(s.ok).toBe(false)
    expect(state.rpc).not.toHaveBeenCalled()
  })

  it("keeps unknown as unknown on the wire and never turns it into zero", async () => {
    state.rpc.mockResolvedValueOnce({ data: { draft_version: 2 }, error: null })
    await saveBaselineDraft({ answers: { calls_per_week: unk }, expectedDraftVersion: 1 })
    const sent = state.rpc.mock.calls[0][1] as { p_answers: Record<string, unknown>; p_expected_draft_version: number }
    expect(sent.p_answers.calls_per_week).toEqual({ state: "unknown" })
    expect(sent.p_expected_draft_version).toBe(1)
  })

  it("computes the reporting period on the server and passes the optimistic versions through", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-11-18T03:00:00Z"))
    state.rpc.mockResolvedValueOnce({ data: { revision: 2, kind: "superseded", supersedes_revision: 1 }, error: null })
    const r = await submitBaselineAssessment({ answers: validAnswers(), expectedBaseline: 1, expectedDraftVersion: 4 })
    expect(r).toEqual({ ok: true, data: { revision: 2, kind: "superseded", supersedesRevision: 1 } })
    expect(state.rpc.mock.calls[0][0]).toBe("baseline_submit")
    expect(state.rpc.mock.calls[0][1]).toMatchObject({
      p_shop: SHOP, p_period_start: "2026-08-20", p_period_end: "2026-11-17",
      p_expected_baseline: 1, p_expected_draft_version: 4, p_evidence: [],
    })
  })

  it("maps a stale version to conflict so the UI can ask for a reload", async () => {
    state.rpc.mockResolvedValue({ data: null, error: { code: "PT409" } })
    expect(await saveBaselineDraft({ answers: {}, expectedDraftVersion: 1 })).toEqual({ ok: false, code: "conflict" })
    expect(await submitBaselineAssessment({ answers: validAnswers(), expectedBaseline: null, expectedDraftVersion: null })).toEqual({ ok: false, code: "conflict" })
  })

  it("reports a thrown database client as unavailable, never as success", async () => {
    state.rpc.mockRejectedValue(new Error("network"))
    expect(await saveBaselineDraft({ answers: {}, expectedDraftVersion: null })).toEqual({ ok: false, code: "unavailable" })
    expect(await getBaselineStartingPoint()).toEqual({ status: "unavailable" })
  })
})
