import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { BASELINE_CATALOG_VERSION, BASELINE_QUESTIONS, METRICS } from "@/lib/onboarding-baseline/catalog"
import { readComparison, readStartingPoint } from "@/lib/onboarding-baseline/service"
import { INTEGRATION_WITH_SESSION, anonClient, cleanup, ownerSessionClient, seedShop, serviceClient, type Seeded } from "./_db"
import { validAnswers } from "../_baseline-fixtures"

const PW = "Synthetic-password-123!"
const PERIOD = { p_period_start: "2026-08-01", p_period_end: "2026-09-30" }
let db: SupabaseClient
let shop: Seeded, other: Seeded, manager: Seeded, staff: Seeded, revoked: Seeded
let owner: SupabaseClient, otherOwner: SupabaseClient, mgr: SupabaseClient, stf: SupabaseClient, rev: SupabaseClient
const all: Seeded[] = []

async function member(user: Seeded, role: string, capabilities: string[], active = true) {
  const r = await db.from("shop_memberships").upsert(
    { shop_id: shop.shopId, user_id: user.ownerId, role, capabilities, active, display_name: role }, { onConflict: "shop_id,user_id" })
  expect(r.error).toBeNull()
}
const submit = (c: SupabaseClient, patch: Record<string, unknown> = {}, shopId = shop.shopId) =>
  c.rpc("baseline_submit", { p_shop: shopId, p_answers: validAnswers(), ...PERIOD, p_expected_baseline: null, p_expected_draft_version: null, ...patch })
const save = (c: SupabaseClient, answers: unknown, expected: number | null = null, shopId = shop.shopId) =>
  c.rpc("baseline_save_draft", { p_shop: shopId, p_answers: answers, p_expected_draft_version: expected })
const measure = (patch: Record<string, unknown> = {}) =>
  db.rpc("baseline_record_measurement", {
    p_shop: shop.shopId, p_metric_key: "inquiry_volume", p_definition_version: "v1", p_evidence_class: "gradia_observed",
    p_value: 100, p_unit: "count", p_window_start: "2026-08-01T00:00:00Z", p_window_end: "2026-08-31T00:00:00Z",
    p_source_system: null, p_source_ref: "interactions", p_formula_version: null, p_inputs: [], ...patch,
  })

describe.skipIf(!INTEGRATION_WITH_SESSION)("onboarding baseline persistence", () => {
  beforeAll(async () => {
    db = serviceClient()
    ;[shop, other, manager, staff, revoked] = await Promise.all([1, 2, 3, 4, 5].map(() => seedShop(db, { password: PW })))
    all.push(shop, other, manager, staff, revoked)
    ;[owner, otherOwner, mgr, stf, rev] = await Promise.all([shop, other, manager, staff, revoked].map((s) => ownerSessionClient(s.email, PW)))
    // `manager`/`staff`/`revoked` each own a throwaway shop of their own; they are members of `shop` only.
    await member(manager, "manager", ["baseline.draft"])
    await member(staff, "staff", [])
    await member(revoked, "manager", ["baseline.draft"])
  })
  afterAll(async () => { for (const s of all) await cleanup(db, s) })

  it("keeps the TypeScript catalog identical to the immutable database catalog", async () => {
    const q = await db.from("baseline_catalog_questions").select("*").eq("version", BASELINE_CATALOG_VERSION).order("ordinal")
    expect(q.error).toBeNull()
    expect(q.data!.map((r) => r.key)).toEqual(BASELINE_QUESTIONS.map((x) => x.key))
    q.data!.forEach((r, i) => {
      const t = BASELINE_QUESTIONS[i]
      expect({ kind: r.kind, optional: r.optional, unk: r.allows_unknown, section: r.section }).toEqual({ kind: t.kind, optional: t.optional, unk: t.allowsUnknown, section: t.section })
      if (t.kind === "number") {
        expect(r.allows_range).toBe(t.allowsRange)
        expect(r.units).toEqual(Object.fromEntries(Object.entries(t.units).map(([k, s]) => [k, { min: s.min, max: s.max, integer: s.integer }])))
      }
      if ("choices" in t) expect(r.choices).toEqual([...t.choices])
    })
    const m = await db.from("baseline_metric_definitions").select("*")
    expect(m.data!.map((r) => r.metric_key).sort()).toEqual(Object.keys(METRICS).sort())
    expect((await db.from("baseline_catalog_questions").update({ optional: true }).eq("version", "baseline.v1").eq("key", "calls_per_week")).error).not.toBeNull()
  })

  it("denies anonymous, staff, revoked and cross-shop callers for every command and read", async () => {
    await member(revoked, "manager", ["baseline.draft"], false)
    for (const [name, client] of [["anon", anonClient()], ["staff", stf], ["revoked", rev], ["cross-shop", otherOwner]] as const) {
      for (const result of [await submit(client), await save(client, {}), await client.rpc("baseline_read", { p_shop: shop.shopId }),
        await client.rpc("baseline_read_window", { p_shop: shop.shopId, p_window_start: "2026-09-01T00:00:00Z", p_window_end: "2026-10-01T00:00:00Z" })])
        expect(result.error?.code, name).toBe("42501")
    }
    expect(await readStartingPoint(stf, shop.shopId)).toEqual({ status: "forbidden" })
    // Browser roles cannot touch the tables or the evidence writer directly.
    for (const t of ["baseline_assessment_revisions", "baseline_pointer", "baseline_drafts", "baseline_measurements"]) {
      const r = await owner.from(t).select("*")
      expect(r.error !== null || (r.data ?? []).length === 0, t).toBe(true)
      expect((await owner.from(t).insert({ shop_id: shop.shopId })).error, t).not.toBeNull()
    }
    expect((await owner.rpc("baseline_record_measurement", { p_shop: shop.shopId, p_metric_key: "inquiry_volume", p_definition_version: "v1", p_evidence_class: "gradia_observed", p_value: 1, p_unit: "count", p_window_start: "2026-08-01T00:00:00Z", p_window_end: "2026-08-31T00:00:00Z", p_source_ref: "x" })).error).not.toBeNull()
    await member(revoked, "manager", ["baseline.draft"], true)
  })

  it("lets a delegated manager draft and read but never submit; the owner submits", async () => {
    expect((await submit(mgr)).error?.code).toBe("42501")
    const draft = await save(mgr, { calls_per_week: { state: "value", value: 3, unit: "count_per_week" } })
    expect(draft.error).toBeNull()
    expect(draft.data).toEqual({ draft_version: 1 })
    const view = await mgr.rpc("baseline_read", { p_shop: shop.shopId })
    expect(view.data).toMatchObject({ role: "manager", revision: null, draft: { updated_by_role: "manager", draft_version: 1 } })
    expect((await save(owner, validAnswers(), null)).error?.code).toBe("PT409") // stale: a draft exists
    expect((await save(owner, validAnswers(), 1)).data).toEqual({ draft_version: 2 })
    // Submitting against an outdated draft version is refused and keeps the draft.
    expect((await submit(owner, { p_expected_draft_version: 1 })).error?.code).toBe("PT409")
    const ok = await submit(owner, { p_expected_draft_version: 2 })
    expect(ok.error).toBeNull()
    expect(ok.data).toEqual({ revision: 1, kind: "submitted", supersedes_revision: null })
    expect((await db.from("baseline_drafts").select("*").eq("shop_id", shop.shopId)).data).toEqual([])
    const r = await db.from("baseline_assessment_revisions").select("*").eq("shop_id", shop.shopId).single()
    expect(r.data).toMatchObject({ submitted_by: shop.ownerId, submitted_by_role: "owner", drafted_by: shop.ownerId, drafted_by_role: "owner" })
  })

  it("rejects invalid units, ranges and incomplete submissions in the database", async () => {
    const bad = (patch: Record<string, unknown>) => save(owner, { ...validAnswers(), ...patch }, null).then((r) => r.error?.code)
    expect(await bad({ calls_per_week: { state: "value", value: 5, unit: "count_per_month" } })).toBe("22023")
    expect(await bad({ calls_per_week: { state: "value", value: -1, unit: "count_per_week" } })).toBe("22023")
    expect(await bad({ operating_days: { state: "value", value: 9, unit: "days_per_week" } })).toBe("22023")
    expect(await bad({ confirmed_bookings: { state: "value", value: 120, unit: "percent" } })).toBe("22023")
    expect(await bad({ first_response_minutes: { state: "range", min: 10, max: 5, unit: "minutes" } })).toBe("22023")
    expect(await bad({ pilot_primary_outcome: { state: "unknown" } })).toBe("22023")
    expect(await bad({ missed_calls_per_week: { state: "value", value: 99, unit: "count_per_week" } })).toBe("22023")
    expect(await bad({ made_up: { state: "unknown" } })).toBe("22023")
    const partial: Record<string, unknown> = validAnswers()
    delete partial.calls_per_week
    expect((await submit(owner, { p_answers: partial, p_expected_baseline: 1 })).error?.code).toBe("22023")
    expect((await submit(owner, { p_expected_baseline: 1, p_period_end: "2999-01-01" })).error?.code).toBe("22023")
  })

  it("keeps unknown distinct from zero through persistence", async () => {
    const zero = { ...validAnswers(), scheduling_conflicts_per_month: { state: "value", value: 0, unit: "count_per_month" }, calls_per_week: { state: "unknown" } }
    expect((await submit(owner, { p_answers: zero, p_expected_baseline: 1 })).data).toMatchObject({ revision: 2, kind: "superseded", supersedes_revision: 1 })
    const dto = await readStartingPoint(owner, shop.shopId)
    if (dto.status !== "ready") throw new Error("expected ready")
    expect(dto.revision).toBe(2)
    expect(dto.sections.response[1]).toMatchObject({ status: "unknown", value: null })
    const stored = (await db.from("baseline_assessment_revisions").select("answers").eq("shop_id", shop.shopId).eq("revision", 2).single()).data!.answers
    expect(stored.scheduling_conflicts_per_month.value).toBe(0)
    expect(stored.calls_per_week).toEqual({ state: "unknown" })
  })

  it("never mutates prior revisions and the pointer only moves forward", async () => {
    const before = (await db.from("baseline_assessment_revisions").select("*").eq("shop_id", shop.shopId).eq("revision", 1).single()).data
    expect((await db.from("baseline_assessment_revisions").update({ answers: {} }).eq("shop_id", shop.shopId).eq("revision", 1)).error).not.toBeNull()
    expect((await db.from("baseline_assessment_revisions").delete().eq("shop_id", shop.shopId).eq("revision", 1)).error).not.toBeNull()
    expect((await db.from("baseline_pointer_events").delete().eq("shop_id", shop.shopId)).error).not.toBeNull()
    expect((await db.from("baseline_pointer").update({ revision: 1 }).eq("shop_id", shop.shopId)).error).not.toBeNull()
    expect((await db.from("baseline_assessment_revisions").select("*").eq("shop_id", shop.shopId).eq("revision", 1).single()).data).toEqual(before)
    expect((await db.from("baseline_pointer").select("revision").eq("shop_id", shop.shopId).single()).data).toEqual({ revision: 2 })
    const events = (await db.from("baseline_pointer_events").select("kind,from_revision,to_revision").eq("shop_id", shop.shopId).order("id")).data
    expect(events).toEqual([{ kind: "submitted", from_revision: null, to_revision: 1 }, { kind: "superseded", from_revision: 1, to_revision: 2 }])
    // The original revision stays readable and pinned for the day-30 comparison.
    const pinned = await owner.rpc("baseline_read", { p_shop: shop.shopId, p_revision: 1 })
    expect(pinned.data.revision.revision).toBe(1)
    expect(pinned.data.pointer.revision).toBe(2)
  })

  it("serializes concurrent supersedes: exactly one wins, none overwrites", async () => {
    const results = await Promise.all([1, 2, 3, 4].map(() => submit(owner, { p_expected_baseline: 2 })))
    expect(results.filter((r) => !r.error)).toHaveLength(1)
    expect(results.filter((r) => r.error?.code === "PT409")).toHaveLength(3)
    const revs = (await db.from("baseline_assessment_revisions").select("revision").eq("shop_id", shop.shopId).order("revision")).data
    expect(revs).toEqual([{ revision: 1 }, { revision: 2 }, { revision: 3 }])
    expect((await db.from("baseline_pointer").select("revision").eq("shop_id", shop.shopId).single()).data).toEqual({ revision: 3 })
  })

  it("applies revocation immediately, including against an in-flight write", async () => {
    await member(manager, "manager", ["baseline.draft"], true)
    expect((await mgr.rpc("baseline_read", { p_shop: shop.shopId })).error).toBeNull()
    // Dropping only the grant, or deactivating, ends read and draft at once.
    await member(manager, "manager", [])
    expect((await mgr.rpc("baseline_read", { p_shop: shop.shopId })).error?.code).toBe("42501")
    expect((await save(mgr, {})).error?.code).toBe("42501")
    await member(manager, "manager", ["baseline.draft"], false)
    expect((await mgr.rpc("baseline_read", { p_shop: shop.shopId })).error?.code).toBe("42501")
    await member(manager, "manager", ["baseline.draft"], true)
    const racing = await Promise.all([
      Promise.resolve(member(manager, "manager", ["baseline.draft"], false)),
      ...[1, 2, 3].map(() => save(mgr, { calls_per_week: { state: "value", value: 1, unit: "count_per_week" } }, null)),
    ])
    expect(racing).toHaveLength(4)
    expect((await save(mgr, {}, null)).error?.code).toBe("42501") // after revocation, always denied
  })

  it("records evidence with windows, sources and formula versions; unknown is never zero", async () => {
    const id = (await measure()).data as string
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect((await measure()).data).toBe(id) // idempotent replay
    expect((await measure({ p_value: 101 })).error?.code).toBe("PT409") // never overwritten
    expect((await measure({ p_evidence_class: "unknown", p_value: 0, p_source_ref: "interactions", p_window_start: "2026-07-01T00:00:00Z", p_window_end: "2026-07-31T00:00:00Z" })).error).not.toBeNull()
    expect((await measure({ p_evidence_class: "unknown", p_value: null, p_window_start: "2026-07-01T00:00:00Z", p_window_end: "2026-07-31T00:00:00Z" })).error).toBeNull()
    expect((await measure({ p_evidence_class: "connected_evidence", p_source_system: null })).error).not.toBeNull()
    expect((await measure({ p_unit: "percent" })).error?.code).toBe("22023")
    expect((await measure({ p_metric_key: "efficiency_score" })).error?.code).toBe("22023")
    expect((await measure({ p_window_end: "2026-08-01T00:00:00Z" })).error).not.toBeNull()
    expect((await measure({ p_metric_key: "booking_rate", p_unit: "percent", p_value: 120, p_source_ref: "z" })).error).not.toBeNull()
    expect((await db.from("baseline_measurements").update({ value: 5 }).eq("id", id)).error).not.toBeNull()
    // Derived evidence must cite same-shop, same-window inputs and a formula version.
    const derived = (patch: Record<string, unknown>) => measure({ p_metric_key: "booking_rate", p_unit: "percent", p_value: 30, p_evidence_class: "derived", p_source_ref: null, p_formula_version: "booking_rate.v1", p_inputs: [{ measurement_id: id }], ...patch })
    expect((await derived({})).error).toBeNull()
    expect((await derived({ p_formula_version: null })).error).not.toBeNull()
    expect((await derived({ p_inputs: [] })).error).not.toBeNull()
    expect((await derived({ p_inputs: [{ measurement_id: crypto.randomUUID() }], p_value: 31 })).error?.code).toBe("22023")
    expect((await derived({ p_window_end: "2026-09-02T00:00:00Z", p_value: 32 })).error?.code).toBe("22023")
  })

  it("is atomic and lineage-exact for measurement replays", async () => {
    const w = { p_window_start: "2026-05-01T00:00:00Z", p_window_end: "2026-05-31T00:00:00Z" }
    const base = measure({ ...w, p_source_ref: "replay-base" })
    const baseId = (await base).data as string
    const racing = await Promise.all(Array.from({ length: 8 }, () => measure({ ...w, p_source_ref: "race", p_value: 7 })))
    expect(racing.map((r) => r.error)).toEqual(Array(8).fill(null))
    const ids = new Set(racing.map((r) => r.data))
    expect(ids.size).toBe(1)
    const rows = await db.from("baseline_measurements").select("id").eq("shop_id", shop.shopId).eq("source_ref", "race")
    expect(rows.data).toEqual([{ id: [...ids][0] }])
    const derived = (patch: Record<string, unknown>) => measure({ ...w, p_metric_key: "booking_rate", p_unit: "percent", p_value: 30, p_evidence_class: "derived", p_source_ref: null, p_formula_version: "booking_rate.v1", p_inputs: [{ measurement_id: baseId }], ...patch })
    const first = (await derived({})).data as string
    expect((await derived({})).data).toBe(first) // exact replay returns the original id
    expect((await derived({ p_formula_version: "booking_rate.v2" })).error?.code).toBe("PT409")
    const second = (await measure({ ...w, p_source_ref: "replay-other" })).data as string
    expect((await derived({ p_inputs: [{ measurement_id: second }] })).error?.code).toBe("PT409")
    expect((await derived({ p_inputs: [{ measurement_id: baseId }, { measurement_id: second }] })).error?.code).toBe("PT409")
    expect((await derived({})).data).toBe(first)
  })

  it("freezes attached evidence into a revision and compares only like-for-like windows", async () => {
    const baselineId = (await measure()).data as string
    // A racing manager save may or may not have landed before revocation; submit against whatever exists.
    const left = (await db.from("baseline_drafts").select("draft_version").eq("shop_id", shop.shopId).maybeSingle()).data
    const draftVersion = left?.draft_version ?? null
    const sub = await submit(owner, { p_expected_baseline: 3, p_expected_draft_version: draftVersion, p_evidence: [baselineId], p_period_end: "2026-08-31" })
    expect(sub.error, JSON.stringify(sub.error)).toBeNull()
    expect(sub.data).toMatchObject({ revision: 4 })
    expect((await submit(owner, { p_expected_baseline: 4, p_expected_draft_version: null, p_evidence: [crypto.randomUUID()] })).error?.code).toBe("22023")
    const foreign = await db.rpc("baseline_record_measurement", { p_shop: other.shopId, p_metric_key: "inquiry_volume", p_definition_version: "v1", p_evidence_class: "gradia_observed", p_value: 1, p_unit: "count", p_window_start: "2026-08-01T00:00:00Z", p_window_end: "2026-08-31T00:00:00Z", p_source_ref: "interactions" })
    expect((await submit(owner, { p_expected_baseline: 4, p_expected_draft_version: null, p_evidence: [foreign.data] })).error?.code).toBe("22023")

    const win = { start: "2026-09-01T00:00:00Z", end: "2026-10-01T00:00:00Z" } // 30 days vs baseline 30 days
    const cur = (patch: Record<string, unknown>) => measure({ p_window_start: win.start, p_window_end: win.end, p_value: 140, ...patch })
    expect((await readComparison(owner, shop.shopId, win)).status).toBe("ready")
    let dto = await readComparison(owner, shop.shopId, win)
    if (dto.status !== "ready") throw new Error("expected ready")
    expect(dto.items.find((i) => i.key === "inquiry_volume")).toMatchObject({ status: "not_comparable", reason: "current_not_measured" })
    await cur({})
    dto = await readComparison(owner, shop.shopId, win)
    if (dto.status !== "ready") throw new Error("expected ready")
    expect(dto.items.find((i) => i.key === "inquiry_volume")).toMatchObject({ status: "comparable", delta: 40 })
    const short = { start: "2026-09-01T00:00:00Z", end: "2026-09-16T00:00:00Z" }
    await cur({ p_window_start: short.start, p_window_end: short.end, p_value: 70 })
    const shortDto = await readComparison(owner, shop.shopId, short)
    if (shortDto.status !== "ready") throw new Error("expected ready")
    expect(shortDto.items.find((i) => i.key === "inquiry_volume")).toMatchObject({ status: "not_comparable", reason: "window_length_differs" })
    expect(await readComparison(otherOwner, shop.shopId, win)).toEqual({ status: "forbidden" })
    expect((await readComparison(otherOwner, other.shopId, win)).status).toBe("not_started")
  })

  it("does not alter existing onboarding records or create shops", async () => {
    const shops = await db.from("shops").select("id").in("id", all.map((s) => s.shopId))
    expect(shops.data).toHaveLength(5)
    expect((await db.from("shops").select("settings").eq("id", shop.shopId).single()).data?.settings ?? {}).not.toHaveProperty("baseline")
  })
})
