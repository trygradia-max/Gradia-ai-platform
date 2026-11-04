import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

import { APPROVED_COMMERCIAL_CATALOG_VERSION } from "@/lib/approved-commercial-catalog"
import { recognitionInputSchema, toRecognitionRpcParams } from "@/lib/commercial-usage"
import {
  correctCommercialUsage,
  readCommercialUsagePreview,
  recognizeCommercialUsage,
} from "@/lib/commercial-usage-service"
import {
  INTEGRATION_WITH_SESSION,
  anonClient,
  cleanup,
  ownerSessionClient,
  seedShop,
  serviceClient,
  type Seeded,
} from "./_db"

const PW = "Synthetic-password-123!"
const WINDOW = { windowStart: "2026-10-01T00:00:00Z", windowEnd: "2026-11-01T00:00:00Z" }
const NEXT = { windowStart: "2026-11-01T00:00:00Z", windowEnd: "2026-12-01T00:00:00Z" }
const AT = (day: number, hour = 12) => `2026-10-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00Z`

let db: SupabaseClient
let shop: Seeded, other: Seeded, manager: Seeded, staff: Seeded, revoked: Seeded
let owner: SupabaseClient, otherOwner: SupabaseClient, mgr: SupabaseClient, stf: SupabaseClient, rev: SupabaseClient
const all: Seeded[] = []
let seq = 0
const uniq = () => `${Date.now().toString(36)}${(++seq).toString(36)}`

async function member(user: Seeded, role: string, active = true) {
  const r = await db.from("shop_memberships").upsert(
    { shop_id: shop.shopId, user_id: user.ownerId, role, capabilities: [], active, display_name: role },
    { onConflict: "shop_id,user_id" }
  )
  expect(r.error).toBeNull()
}

async function ledger(kind: "voice_minute" | "sms_segment", quantity: number, shopId = shop.shopId) {
  const r = await db
    .from("usage_events")
    .insert({ shop_id: shopId, kind, quantity, credits: 0, vendor_ref: `int-${uniq()}`, ref_id: `ref-${uniq()}` })
    .select("id")
    .single()
  expect(r.error).toBeNull()
  return r.data!.id as string
}

const outcome = (metric: string, workflowKey: string, recognizedAt = AT(5), patch: Record<string, unknown> = {}) => ({
  kind: "outcome" as const,
  shopId: shop.shopId,
  metric: metric as "confirmed_appointment",
  workflowKey,
  sourceRef: `wf:${workflowKey}`,
  outcome: { state: "confirmed", humanCompleted: false },
  recognizedAt,
  ...patch,
})
const provider = (
  metric: "inbound_voice_agent_minute" | "sms_segment",
  usageEventId: string,
  quantity: string,
  cost: string | null,
  recognizedAt = AT(6)
) => ({
  kind: "provider_usage" as const,
  shopId: shop.shopId,
  metric,
  usageEventId,
  sourceRef: `provider:${usageEventId}`,
  quantity,
  direction: "inbound" as const,
  recognizedAt,
  ...(cost === null ? {} : { wholesale: { unitCostCents: cost, basis: "provider_reported" as const } }),
})

const rawParams = (input: ReturnType<typeof outcome> | ReturnType<typeof provider>) =>
  toRecognitionRpcParams(recognitionInputSchema.parse(input))
const recognize = (input: ReturnType<typeof outcome> | ReturnType<typeof provider>) => recognizeCommercialUsage(db, input)
const countFacts = async (shopId = shop.shopId) =>
  (await db.from("commercial_usage_recognitions").select("*", { count: "exact", head: true }).eq("shop_id", shopId)).count

describe.skipIf(!INTEGRATION_WITH_SESSION)("commercial usage recognition", () => {
  beforeAll(async () => {
    db = serviceClient()
    ;[shop, other, manager, staff, revoked] = await Promise.all([1, 2, 3, 4, 5].map(() => seedShop(db, { password: PW })))
    all.push(shop, other, manager, staff, revoked)
    ;[owner, otherOwner, mgr, stf, rev] = await Promise.all(
      [shop, other, manager, staff, revoked].map((s) => ownerSessionClient(s.email, PW))
    )
    // manager/staff/revoked each own a throwaway shop; they are members of `shop` only.
    await member(manager, "manager")
    await member(staff, "staff")
    await member(revoked, "manager", false)
  })
  afterAll(async () => {
    for (const s of all) await cleanup(db, s)
  })

  it("registers exactly the approved catalog version", async () => {
    const r = await db.from("commercial_catalog_versions").select("version")
    expect(r.data).toEqual([{ version: APPROVED_COMMERCIAL_CATALOG_VERSION }])
    expect((await db.from("commercial_catalog_versions").update({ version: "2026-11-03.v2" }).eq("version", APPROVED_COMMERCIAL_CATALOG_VERSION)).error).not.toBeNull()
  })

  it("gives browser roles no direct access to the new or the historical ledger tables", async () => {
    const id = await ledger("sms_segment", 1)
    const fact = await recognize(provider("sms_segment", id, "1", "1"))
    expect(fact.ok).toBe(true)
    for (const [name, client] of [["owner", owner], ["anon", anonClient()], ["staff", stf]] as const) {
      for (const table of ["commercial_usage_recognitions", "commercial_usage_corrections", "commercial_catalog_versions"]) {
        const read = await client.from(table).select("*").limit(1)
        expect(read.data ?? [], `${name} read ${table}`).toEqual([])
        expect(read.error, `${name} read ${table}`).not.toBeNull()
        expect((await client.from(table).insert({ shop_id: shop.shopId }).select()).error, `${name} insert ${table}`).not.toBeNull()
        expect((await client.from(table).update({ quantity: 99 }).eq("shop_id", shop.shopId).select()).error, `${name} update ${table}`).not.toBeNull()
        expect((await client.from(table).delete().eq("shop_id", shop.shopId).select()).error, `${name} delete ${table}`).not.toBeNull()
      }
    }
    // The owner may read but never write their own provider ledger (existing P0-005 contract, preserved).
    expect((await owner.from("usage_events").select("id").eq("id", id)).data).toHaveLength(1)
    const tamper = await owner.from("usage_events").update({ quantity: 99 }).eq("id", id).select()
    expect(tamper.error !== null || (tamper.data ?? []).length === 0).toBe(true)
    expect((await owner.from("usage_events").insert({ shop_id: shop.shopId, kind: "voice_minute", quantity: -5 }).select()).error).not.toBeNull()
    expect((await db.from("usage_events").select("quantity").eq("id", id).single()).data?.quantity).toBe(1)
    // Even the service role has no direct table write; only the functions write.
    expect((await db.from("commercial_usage_recognitions").insert({ shop_id: shop.shopId }).select()).error).not.toBeNull()
    expect((await db.from("commercial_usage_recognitions").update({ quantity: 9 }).eq("id", fact.ok ? fact.id : "").select()).error).not.toBeNull()
    expect((await db.from("commercial_usage_recognitions").delete().eq("id", fact.ok ? fact.id : "").select()).error).not.toBeNull()
  })

  it("refuses the writer functions to every non-service caller", async () => {
    const id = await ledger("sms_segment", 1)
    const params = rawParams(provider("sms_segment", id, "1", "1"))
    for (const [name, client] of [["owner", owner], ["manager", mgr], ["staff", stf], ["anon", anonClient()], ["cross-shop", otherOwner]] as const) {
      const r = await client.rpc("commercial_recognize_usage", params)
      expect(r.error?.code ?? "denied", name).toMatch(/42501|PGRST202|permission/i)
      expect(r.data, name).toBeNull()
      const c = await client.rpc("commercial_correct_usage", {
        p_shop: shop.shopId, p_recognition_id: id, p_quantity: 1, p_reason: "duplicate", p_note: null, p_idempotency_key: "x".repeat(20),
      })
      expect(c.error, name).not.toBeNull()
    }
    expect(await countFacts()).toBeGreaterThanOrEqual(0)
    expect((await db.from("commercial_usage_recognitions").select("id").eq("source_usage_event_id", id)).data).toEqual([])
  })

  describe("recognition is atomic and idempotent", () => {
    it("replays the original id for an identical fact", async () => {
      const input = outcome("qualified_lead", `wf-${uniq()}`)
      const first = await recognize(input)
      const again = await recognize(input)
      expect(first).toMatchObject({ ok: true, replayed: false })
      expect(again).toMatchObject({ ok: true, replayed: true })
      if (first.ok && again.ok) expect(again.id).toBe(first.id)
    })

    it("conflicts when any immutable part of the fact changes under the same identity", async () => {
      const wf = `wf-${uniq()}`
      const base = rawParams(outcome("qualified_lead", wf))
      expect((await db.rpc("commercial_recognize_usage", base)).error).toBeNull()
      const changes: Record<string, unknown>[] = [
        { p_recognized_at: AT(9) },
        { p_source_ref: "different-evidence" },
        { p_evidence: { ...(base.p_evidence as object), note: "changed" } },
        { p_metric: "confirmed_appointment" },
        { p_workflow_key: `${wf}-other` },
      ]
      for (const change of changes) {
        const r = await db.rpc("commercial_recognize_usage", { ...base, ...change })
        expect(r.error?.code, JSON.stringify(change)).toBe("CB409")
      }
      const v = await db.rpc("commercial_recognize_usage", { ...base, p_catalog_version: "2099-01-01.v1" })
      expect(v.error?.code).toBe("22023") // unregistered catalog version
    })

    it("conflicts for changed quantity, wholesale cost or basis on provider usage", async () => {
      const id = await ledger("voice_minute", 4)
      const input = provider("inbound_voice_agent_minute", id, "4", "10")
      const base = rawParams(input)
      expect((await db.rpc("commercial_recognize_usage", base)).error).toBeNull()
      for (const change of [
        { p_wholesale_unit_cost_cents: "11" },
        { p_wholesale_basis: "provider_rate_card" },
        { p_wholesale_unit_cost_cents: null, p_wholesale_basis: null },
      ]) {
        const r = await db.rpc("commercial_recognize_usage", { ...base, ...change })
        expect(r.error?.code, JSON.stringify(change)).toBe("CB409")
      }
      // The same ledger row under a different identity cannot be recognized twice.
      const second = await db.rpc("commercial_recognize_usage", { ...base, p_idempotency_key: `other.${"k".repeat(24)}` })
      expect(second.error?.code).toBe("CB409")
      expect((await db.from("commercial_usage_recognitions").select("id").eq("source_usage_event_id", id)).data).toHaveLength(1)
    })

    it("creates exactly one fact and one id under concurrent identical recognition", async () => {
      const input = outcome("confirmed_appointment", `wf-${uniq()}`)
      const results = await Promise.all(Array.from({ length: 12 }, () => recognize(input)))
      const ids = new Set(results.map((r) => (r.ok ? r.id : "fail")))
      expect(ids.size).toBe(1)
      expect(results.every((r) => r.ok)).toBe(true)
      expect(results.filter((r) => r.ok && !r.replayed)).toHaveLength(1)
      const rows = await db.from("commercial_usage_recognitions").select("id").eq("workflow_key", input.workflowKey)
      expect(rows.data).toHaveLength(1)
    })

    it("treats concurrent recognition of one ledger row under rival identities as one winner", async () => {
      const id = await ledger("sms_segment", 2)
      const base = rawParams(provider("sms_segment", id, "2", "1"))
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          db.rpc("commercial_recognize_usage", { ...base, p_idempotency_key: `rival.${i}.${"z".repeat(20)}` })
        )
      )
      expect(results.filter((r) => !r.error)).toHaveLength(1)
      expect(results.filter((r) => r.error?.code === "CB409")).toHaveLength(5)
    })

    it("refuses non-billable outcomes at the database boundary and stores nothing", async () => {
      const wf = `wf-${uniq()}`
      const base = rawParams(outcome("qualified_lead", wf))
      for (const evidence of [
        { outcome_state: "draft", human_completed: false },
        { outcome_state: "proposal", human_completed: false },
        { outcome_state: "escalation", human_completed: false },
        { outcome_state: "failure", human_completed: false },
        { outcome_state: "unknown", human_completed: false },
        { outcome_state: "confirmed", human_completed: true },
        { outcome_state: "confirmed" },
        {},
      ]) {
        const r = await db.rpc("commercial_recognize_usage", { ...base, p_evidence: evidence })
        expect(r.error?.code, JSON.stringify(evidence)).toBe("CB422")
      }
      expect((await db.from("commercial_usage_recognitions").select("id").eq("workflow_key", wf)).data).toEqual([])
    })

    it("accepts only exact metrics and ties provider usage to its own ledger evidence", async () => {
      const base = rawParams(outcome("qualified_lead", `wf-${uniq()}`))
      for (const metric of ["voice_minute", "agent_run", "message", "number_monthly"]) {
        expect((await db.rpc("commercial_recognize_usage", { ...base, p_metric: metric })).error?.code, metric).toBe("22023")
      }
      const voiceRow = await ledger("voice_minute", 3)
      const smsRow = await ledger("sms_segment", 3)
      const foreign = await ledger("voice_minute", 3, other.shopId)
      const good = rawParams(provider("inbound_voice_agent_minute", voiceRow, "3", "10"))
      expect((await db.rpc("commercial_recognize_usage", { ...good, p_source_usage_event_id: smsRow })).error?.code).toBe("22023") // wrong ledger kind
      expect((await db.rpc("commercial_recognize_usage", { ...good, p_quantity: 4 })).error?.code).toBe("22023") // quantity differs from ledger
      expect((await db.rpc("commercial_recognize_usage", { ...good, p_source_usage_event_id: foreign })).error?.code).toBe("22023") // cross-shop ledger row
      expect((await db.rpc("commercial_recognize_usage", { ...good, p_evidence: { direction: "outbound" } })).error?.code).toBe("22023")
      expect((await db.rpc("commercial_recognize_usage", { ...good, p_evidence: {} })).error?.code).toBe("22023") // direction is not in the old ledger
      expect((await db.rpc("commercial_recognize_usage", { ...good, p_wholesale_basis: null })).error?.code).toBe("22023") // cost without basis
      expect((await db.rpc("commercial_recognize_usage", { ...good, p_recognized_at: "2099-01-01T00:00:00Z" })).error?.code).toBe("22023")
      expect((await db.rpc("commercial_recognize_usage", { ...good, p_shop: "00000000-0000-4000-8000-0000000000ff" })).error?.code).toBe("22023")
      expect((await db.from("commercial_usage_recognitions").select("id").eq("source_usage_event_id", voiceRow)).data).toEqual([])
    })

    it("stores unknown wholesale evidence as NULL, never zero", async () => {
      const id = await ledger("voice_minute", 2)
      const r = await recognize(provider("inbound_voice_agent_minute", id, "2", null))
      expect(r.ok).toBe(true)
      const row = (await db.from("commercial_usage_recognitions").select("wholesale_unit_cost_cents, wholesale_basis").eq("source_usage_event_id", id).single()).data
      expect(row).toEqual({ wholesale_unit_cost_cents: null, wholesale_basis: null })
    })
  })

  describe("compensating corrections", () => {
    it("are traceable, replay safely, and cannot over-correct", async () => {
      const id = await ledger("voice_minute", 5)
      const fact = await recognize(provider("inbound_voice_agent_minute", id, "5", "20"))
      if (!fact.ok) throw new Error("setup")
      const base = { shopId: shop.shopId, recognitionId: fact.id, reason: "provider_adjustment" as const }
      const a = await correctCommercialUsage(db, { ...base, quantity: "2", correctionRef: "adj-1" })
      expect(a).toMatchObject({ ok: true, replayed: false })
      const replay = await correctCommercialUsage(db, { ...base, quantity: "2", correctionRef: "adj-1" })
      expect(replay).toMatchObject({ ok: true, replayed: true })
      if (a.ok && replay.ok) expect(replay.id).toBe(a.id)
      expect(await correctCommercialUsage(db, { ...base, quantity: "3", correctionRef: "adj-1" })).toMatchObject({ ok: false, reason: "conflict" })
      expect(await correctCommercialUsage(db, { ...base, quantity: "4", correctionRef: "adj-2" })).toMatchObject({ ok: false, reason: "conflict" })
      expect(await correctCommercialUsage(db, { ...base, quantity: "3", correctionRef: "adj-3" })).toMatchObject({ ok: true })
      expect(await correctCommercialUsage(db, { ...base, quantity: "0.000001", correctionRef: "adj-4" })).toMatchObject({ ok: false, reason: "conflict" })
      const rows = (await db.from("commercial_usage_corrections").select("recognition_id, quantity").eq("recognition_id", fact.id)).data!
      expect(rows.map((r) => Number(r.quantity)).sort()).toEqual([2, 3])
    })

    it("cannot be recorded against another shop's recognition", async () => {
      const wf = `wf-${uniq()}`
      const fact = await recognize(outcome("qualified_lead", wf))
      if (!fact.ok) throw new Error("setup")
      expect(await correctCommercialUsage(db, { shopId: other.shopId, recognitionId: fact.id, quantity: "1", reason: "duplicate", correctionRef: "x-shop" })).toMatchObject({ ok: false, reason: "invalid" })
    })

    it("lets exactly one of two racing corrections win when together they would over-correct", async () => {
      const id = await ledger("voice_minute", 5)
      const fact = await recognize(provider("inbound_voice_agent_minute", id, "5", "20"))
      if (!fact.ok) throw new Error("setup")
      const results = await Promise.all(
        ["a", "b", "c"].map((ref) =>
          correctCommercialUsage(db, { shopId: shop.shopId, recognitionId: fact.id, quantity: "3", reason: "duplicate", correctionRef: ref })
        )
      )
      expect(results.filter((r) => r.ok)).toHaveLength(1)
      expect(results.filter((r) => !r.ok && r.reason === "conflict")).toHaveLength(2)
    })
  })

  describe("owner read and deterministic preview", () => {
    it("refuses staff, manager, revoked, anonymous and cross-shop callers", async () => {
      await member(revoked, "manager", false)
      for (const [name, client] of [["staff", stf], ["manager", mgr], ["revoked", rev], ["anon", anonClient()], ["cross-shop", otherOwner]] as const) {
        const r = await client.rpc("commercial_usage_read", {
          p_shop: shop.shopId, p_window_start: WINDOW.windowStart, p_window_end: WINDOW.windowEnd, p_as_of: null,
        })
        expect(r.error?.code, name).toBe("42501")
        expect(r.data, name).toBeNull()
        expect(await readCommercialUsagePreview(client, { shopId: shop.shopId, ...WINDOW }), name).toEqual({ status: "forbidden" })
      }
    })

    it("lets the live owner and the service role read, and rejects a bad window", async () => {
      for (const client of [owner, db]) {
        const r = await readCommercialUsagePreview(client, { shopId: shop.shopId, ...WINDOW })
        expect(r.status).toBe("ready")
      }
      const bad = await owner.rpc("commercial_usage_read", {
        p_shop: shop.shopId, p_window_start: WINDOW.windowEnd, p_window_end: WINDOW.windowStart, p_as_of: null,
      })
      expect(bad.error?.code).toBe("22023")
    })

    it("computes the real period preview from recognized facts and reports seats honestly", async () => {
      const iso = await seedShop(db, { password: PW })
      all.push(iso)
      const sess = await ownerSessionClient(iso.email, PW)
      const w = async (input: Record<string, unknown>) => {
        const r = await recognizeCommercialUsage(db, { ...input, shopId: iso.shopId } as never)
        expect(r.ok, JSON.stringify(input)).toBe(true)
        return r.ok ? r.id : ""
      }
      const voiceLedger = await ledger("voice_minute", 120, iso.shopId)
      const smsLedger = await ledger("sms_segment", 10, iso.shopId)
      await w(outcome("standard_digital_outcome", "wf-a", AT(3)))
      await w(outcome("qualified_lead", "wf-a", AT(4)))
      await w(outcome("confirmed_appointment", "wf-a", AT(5)))
      await w(outcome("qualified_lead", "wf-b", AT(6)))
      const voiceFact = await w(provider("inbound_voice_agent_minute", voiceLedger, "120", "20", AT(7)))
      await w(provider("sms_segment", smsLedger, "10", "2", AT(8)))
      const read = await readCommercialUsagePreview(sess, { shopId: iso.shopId, ...WINDOW })
      expect(read.status).toBe("ready")
      if (read.status !== "ready" || read.preview.state !== "ok") throw new Error(JSON.stringify(read))
      // appointment $10 + lead $5 + voice 20 billed * 50c = $10 + sms 10 * 6c = $0.60 -> 1000+500+1000+60
      expect(read.preview.usage.totalCents).toBe(2560)
      expect(read.preview.subscription.invoiceTotal.state).toBe("unavailable")
      expect(read.preview.subscription.seatProration.state).toBe("seat_proration_unavailable")

      // A compensating correction changes the next preview; the original facts are untouched.
      await correctCommercialUsage(db, { shopId: iso.shopId, recognitionId: voiceFact, quantity: "20", reason: "provider_adjustment", correctionRef: "fix-1" })
      const after = await readCommercialUsagePreview(sess, { shopId: iso.shopId, ...WINDOW })
      if (after.status !== "ready" || after.preview.state !== "ok") throw new Error("expected ok")
      expect(after.preview.usage.totalCents).toBe(1560)
      // Reproducible: reading as of the earlier instant still yields the earlier answer.
      const earlier = await readCommercialUsagePreview(sess, { shopId: iso.shopId, ...WINDOW, asOf: read.preview.asOf })
      if (earlier.status !== "ready" || earlier.preview.state !== "ok") throw new Error("expected ok")
      expect(earlier.preview.usage.totalCents).toBe(2560)
    })

    it("does not double-count an event at the half-open rollover boundary", async () => {
      const iso = await seedShop(db, { password: PW })
      all.push(iso)
      const ledgerStart = await ledger("sms_segment", 1, iso.shopId)
      const ledgerEnd = await ledger("sms_segment", 1, iso.shopId)
      for (const [id, at] of [[ledgerStart, "2026-10-01T00:00:00Z"], [ledgerEnd, "2026-11-01T00:00:00Z"]] as const) {
        const r = await recognizeCommercialUsage(db, { ...provider("sms_segment", id, "1", "1", at), shopId: iso.shopId })
        expect(r.ok).toBe(true)
      }
      const october = await readCommercialUsagePreview(db, { shopId: iso.shopId, ...WINDOW })
      const november = await readCommercialUsagePreview(db, { shopId: iso.shopId, ...NEXT })
      const count = (r: typeof october) => {
        if (r.status !== "ready" || r.preview.state !== "ok") throw new Error("expected ok")
        return r.preview.usage.lines.find((l) => l.metric === "sms_segment")!.evidence.map((e) => e.factId)
      }
      expect(count(october)).toHaveLength(1)
      expect(count(november)).toHaveLength(1)
      expect(count(october)[0]).not.toBe(count(november)[0])
    })

    it("charges a workflow once across periods and refuses to guess an upgrade", async () => {
      const iso = await seedShop(db, { password: PW })
      all.push(iso)
      const w = async (input: Record<string, unknown>) => {
        const r = await recognizeCommercialUsage(db, { ...input, shopId: iso.shopId } as never)
        expect(r.ok, JSON.stringify(input)).toBe(true)
      }
      await w(outcome("confirmed_appointment", "wf-done", AT(4)))
      await w(outcome("standard_digital_outcome", "wf-done", "2026-11-02T00:00:00Z"))
      await w(outcome("standard_digital_outcome", "wf-up", AT(4)))
      const first = await readCommercialUsagePreview(db, { shopId: iso.shopId, ...NEXT })
      if (first.status !== "ready") throw new Error("expected ready")
      expect(first.preview.state).toBe("ok")
      if (first.preview.state === "ok") {
        expect(first.preview.usage.totalCents).toBe(0)
        expect(first.preview.usage.excluded.map((e) => e.reason)).toEqual(["already_recognized_earlier_period"])
      }
      await w(outcome("confirmed_appointment", "wf-up", "2026-11-03T00:00:00Z"))
      const second = await readCommercialUsagePreview(db, { shopId: iso.shopId, ...NEXT })
      if (second.status !== "ready") throw new Error("expected ready")
      expect(second.preview.state).toBe("conflict")
    })

    it("surfaces missing wholesale evidence as unavailable, not as zero usage", async () => {
      const iso = await seedShop(db, { password: PW })
      all.push(iso)
      const id = await ledger("sms_segment", 3, iso.shopId)
      await recognizeCommercialUsage(db, { ...provider("sms_segment", id, "3", null), shopId: iso.shopId })
      const read = await readCommercialUsagePreview(db, { shopId: iso.shopId, ...WINDOW })
      if (read.status !== "ready") throw new Error("expected ready")
      expect(read.preview.state).toBe("unavailable")
      expect(JSON.stringify(read.preview)).not.toContain("totalCents")
    })
  })

  it("follows the tenant-deletion contract: deleting a shop removes its facts, nothing else can", async () => {
    const doomed = await seedShop(db, { password: PW })
    const id = await ledger("sms_segment", 1, doomed.shopId)
    const fact = await recognizeCommercialUsage(db, { ...provider("sms_segment", id, "1", "1"), shopId: doomed.shopId })
    expect(fact.ok).toBe(true)
    expect(fact.ok && (await correctCommercialUsage(db, { shopId: doomed.shopId, recognitionId: fact.id, quantity: "1", reason: "duplicate", correctionRef: "bye" })).ok).toBe(true)
    // The referenced ledger row cannot be deleted out from under its recognition.
    expect((await db.from("usage_events").delete().eq("id", id)).error).not.toBeNull()
    await cleanup(db, doomed)
    expect(await countFacts(doomed.shopId)).toBe(0)
    expect((await db.from("commercial_usage_corrections").select("id", { count: "exact", head: true }).eq("shop_id", doomed.shopId)).count).toBe(0)
  })
})
