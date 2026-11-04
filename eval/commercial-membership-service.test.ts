import type { SupabaseClient } from "@supabase/supabase-js"
import { describe, expect, it, vi } from "vitest"

import {
  correctMembershipBilling,
  readCommercialPeriodPreview,
  readCommercialUsagePreview,
} from "@/lib/commercial-usage-service"

const SHOP = "11111111-1111-4111-8111-111111111111"
const USER = "22222222-2222-4222-8222-222222222222"
const EVENT = "33333333-3333-4333-8333-333333333333"
const WINDOW = { shopId: SHOP, windowStart: "2026-11-01T00:00:00Z", windowEnd: "2026-12-01T00:00:00Z" }
const AS_OF = "2027-01-01T00:00:00+00:00"

type Reply = { data?: unknown; error?: { code?: string } | null }
const usageDto = { as_of: AS_OF, facts: [], corrections: [], prior_workflow_metrics: {} }
const membershipOf = (events: unknown[], coveredFrom = "2026-09-01T00:00:00+00:00") => ({
  coverage: { covered_from: coveredFrom, basis: "migration_snapshot", recorded_at: "2026-09-01T00:00:00+00:00" },
  events,
})
const event = (user: string, at: string, billable: boolean, seq: number) => ({
  id: `e-${seq}`,
  shop_seq: seq,
  user_id: user,
  kind: "change",
  new_billable: billable,
  effective_at: at,
  recorded_at: at,
})

function client(replies: Record<string, Reply>) {
  const rpc = vi.fn(async (name: string) => {
    const reply = replies[name]
    return { data: reply?.data ?? null, error: reply?.error ?? null }
  })
  return { client: { rpc } as unknown as SupabaseClient, rpc }
}

describe("readCommercialPeriodPreview", () => {
  it("computes seat proration from recorded membership evidence at the same as-of instant", async () => {
    const team = ["a", "b", "c", "d"].map((u, i) => event(u, "2026-09-01T00:00:00+00:00", true, i + 1))
    const { client: c, rpc } = client({
      commercial_usage_read: { data: usageDto },
      commercial_membership_read: { data: membershipOf(team) },
    })
    const read = await readCommercialPeriodPreview(c, WINDOW)
    expect(read.status).toBe("ready")
    if (read.status === "ready" && read.preview.state === "ok") {
      expect(read.preview.subscription.seatProration).toMatchObject({ state: "computed", roundedCents: 3900 })
      expect(read.preview.subscription.invoiceTotal).toMatchObject({ state: "available", totalCents: 19_900 + 3900 })
    } else throw new Error("expected an ok preview")
    const membershipCall = rpc.mock.calls.find(([name]) => name === "commercial_membership_read")
    expect((membershipCall as unknown as [string, Record<string, unknown>])[1]).toMatchObject({
      p_shop: SHOP,
      p_as_of: AS_OF,
    })
  })

  it("leaves seats unavailable, never zero, when the membership read fails", async () => {
    const { client: c } = client({
      commercial_usage_read: { data: usageDto },
      commercial_membership_read: { error: { code: "XX000" } },
    })
    const read = await readCommercialPeriodPreview(c, WINDOW)
    if (read.status !== "ready" || read.preview.state !== "ok") throw new Error("expected usage to survive")
    expect(read.preview.subscription.seatProration).toMatchObject({ code: "membership_read_failed" })
    expect(read.preview.subscription.invoiceTotal.state).toBe("unavailable")
  })

  it("treats malformed membership evidence as unavailable seats", async () => {
    const { client: c } = client({
      commercial_usage_read: { data: usageDto },
      commercial_membership_read: { data: { coverage: "nope", events: 3 } },
    })
    const read = await readCommercialPeriodPreview(c, WINDOW)
    if (read.status !== "ready" || read.preview.state !== "ok") throw new Error("expected usage to survive")
    expect(read.preview.subscription.seatProration).toMatchObject({ code: "malformed_membership_evidence" })
  })

  it("reports a gap rather than computing when coverage starts mid-period", async () => {
    const { client: c } = client({
      commercial_usage_read: { data: usageDto },
      commercial_membership_read: {
        data: membershipOf([event("a", "2026-11-16T00:00:00+00:00", true, 1)], "2026-11-16T00:00:00+00:00"),
      },
    })
    const read = await readCommercialPeriodPreview(c, WINDOW)
    if (read.status !== "ready" || read.preview.state !== "ok") throw new Error("expected ok")
    expect(read.preview.subscription.seatProration).toMatchObject({
      code: "coverage_gap",
      gap: { start: "2026-11-01T00:00:00.000Z", end: "2026-11-16T00:00:00.000Z" },
    })
  })

  it("is forbidden if either half refuses the caller, and unavailable if usage cannot be read", async () => {
    expect(
      await readCommercialPeriodPreview(
        client({ commercial_usage_read: { data: usageDto }, commercial_membership_read: { error: { code: "42501" } } }).client,
        WINDOW
      )
    ).toEqual({ status: "forbidden" })
    expect(
      await readCommercialPeriodPreview(client({ commercial_usage_read: { error: { code: "42501" } } }).client, WINDOW)
    ).toEqual({ status: "forbidden" })
    expect(
      await readCommercialPeriodPreview(client({ commercial_usage_read: { error: { code: "XX000" } } }).client, WINDOW)
    ).toEqual({ status: "unavailable", reason: "read_failed" })
  })

  it("refuses a malformed window before touching the database", async () => {
    const { client: c, rpc } = client({})
    expect(await readCommercialPeriodPreview(c, { ...WINDOW, windowStart: "2026-11-01" })).toEqual({
      status: "unavailable",
      reason: "invalid_window",
    })
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe("readCommercialUsagePreview is unchanged usage-only behavior", () => {
  it("never reads membership and keeps seats unavailable", async () => {
    const { client: c, rpc } = client({ commercial_usage_read: { data: usageDto } })
    const read = await readCommercialUsagePreview(c, WINDOW)
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(["commercial_usage_read"])
    if (read.status !== "ready" || read.preview.state !== "ok") throw new Error("expected ok")
    expect(read.preview.subscription.seatProration).toMatchObject({ code: "no_membership_evidence" })
  })
})

describe("correctMembershipBilling", () => {
  const input = {
    shopId: SHOP,
    userId: USER,
    effectiveAt: "2026-11-10T00:00:00Z",
    billable: true,
    correctsEventId: EVENT,
    reason: "owner confirmed the operator worked from Nov 10",
    correctionRef: "review-1",
  }

  it("sends a deterministic key and maps database outcomes", async () => {
    const ok = client({ commercial_membership_correct: { data: { id: EVENT, replayed: false } } })
    expect(await correctMembershipBilling(ok.client, input)).toEqual({ ok: true, id: EVENT, replayed: false })
    await correctMembershipBilling(ok.client, input)
    const [first, second] = ok.rpc.mock.calls.map((call) => (call as unknown as [string, Record<string, unknown>])[1])
    expect(first.p_idempotency_key).toBe(second.p_idempotency_key)
    expect(first.p_idempotency_key).toMatch(/^[A-Za-z0-9_.:-]{16,200}$/)
    await correctMembershipBilling(ok.client, { ...input, correctionRef: "review-2" })
    expect(
      (ok.rpc.mock.calls[2] as unknown as [string, Record<string, unknown>])[1].p_idempotency_key
    ).not.toBe(first.p_idempotency_key)

    for (const [code, reason] of [
      ["CB409", "conflict"],
      ["42501", "forbidden"],
      ["22023", "invalid"],
      ["08006", "failed"],
    ] as const) {
      const failing = client({ commercial_membership_correct: { error: { code } } })
      expect(await correctMembershipBilling(failing.client, input)).toMatchObject({ ok: false, reason })
    }
  })

  it("passes a microsecond-exact instant through unchanged (a JS Date would truncate it)", async () => {
    const { client: c, rpc } = client({ commercial_membership_correct: { data: { id: EVENT, replayed: false } } })
    const exact = "2026-11-04T21:32:06.950248+00:00"
    await correctMembershipBilling(c, { ...input, effectiveAt: exact })
    expect((rpc.mock.calls[0] as unknown as [string, Record<string, unknown>])[1].p_effective_at).toBe(exact)
  })

  it("rejects invalid input before the database", async () => {
    const { client: c, rpc } = client({})
    expect(await correctMembershipBilling(c, { ...input, effectiveAt: "2026-11-10" })).toMatchObject({ reason: "invalid" })
    expect(await correctMembershipBilling(c, { ...input, userId: "nope" })).toMatchObject({ reason: "invalid" })
    expect(await correctMembershipBilling(c, { ...input, reason: "  " })).toMatchObject({ reason: "invalid" })
    expect(rpc).not.toHaveBeenCalled()
  })
})
