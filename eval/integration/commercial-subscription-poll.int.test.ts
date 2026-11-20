import { createHmac } from "node:crypto"

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

import { APPROVED_COMMERCIAL_CATALOG_VERSION } from "@/lib/approved-commercial-catalog"
import { FOUNDER_PILOT_PRICE } from "@/lib/commercial-billing"
import { WORKER_KINDS, runCommercialBillingWorker, type WorkerDeps } from "@/lib/commercial-billing-worker"
import { assessCommercialExecution } from "@/lib/commercial-execution-gate"
import { createSubscriptionPollReader, type PolledList, type SubscriptionPollReader } from "@/lib/commercial-subscription-poll"
import { runSubscriptionPollSweep } from "@/lib/commercial-subscription-poll-service"
import { handleCommercialWebhook } from "@/lib/commercial-webhook-service"
import { FAKE_CONFIG, sql, transient, uniq } from "./_commercial-fixture"
import { exactFixtureItems } from "../_commercial-item-fixtures"
import { INTEGRATION_WITH_SESSION, anonClient, cleanup, ownerSessionClient, seedShop, serviceClient, type Seeded } from "./_db"

const PW = "Synthetic-password-123!"
const SECRET = "whsec_" + "f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3"
const NOW_S = Math.floor(Date.now() / 1000)
const DAY = 86_400
const iso = (s: number) => new Date(s * 1000).toISOString()

let db: SupabaseClient
let anon: SupabaseClient
const seeded: Seeded[] = []

// ---------- a bound workspace exactly as PR C leaves it: customer + open Checkout session ----------
type Bound = { s: Seeded; customerId: string; attemptId: string; sessionId: string; sub: string }
async function bound(): Promise<Bound> {
  const s = await transient(() => seedShop(db, { password: PW }))
  seeded.push(s)
  const customerId = `cus_F3${uniq()}`
  const sessionId = `cs_test_F3${uniq()}`
  const begun = await db.rpc("commercial_checkout_begin", {
    p_shop: s.shopId, p_actor: s.ownerId, p_catalog_version: APPROVED_COMMERCIAL_CATALOG_VERSION,
    p_plan_key: "founder-pilot", p_lookup_key: FOUNDER_PILOT_PRICE.lookupKey, p_return_target: "agents", p_fingerprint: "e".repeat(64),
  })
  expect(begun.error).toBeNull()
  const attemptId = (begun.data as { attempt_id: string }).attempt_id
  expect((await db.rpc("commercial_checkout_bind_customer", { p_shop: s.shopId, p_actor: s.ownerId, p_attempt: attemptId, p_customer: customerId })).error).toBeNull()
  expect((await db.rpc("commercial_checkout_record_session", { p_shop: s.shopId, p_actor: s.ownerId, p_attempt: attemptId, p_session: sessionId })).error).toBeNull()
  return { s, customerId, attemptId, sessionId, sub: `sub_F3${uniq()}` }
}

// ---------- signed webhook delivery (the path polling must agree with, and never override) ----------
const signFor = (raw: string) => {
  const t = Math.floor(Date.now() / 1000)
  return `t=${t},v1=${createHmac("sha256", SECRET).update(`${t}.${raw}`).digest("hex")}`
}
let evSeq = 0
type SubOpts = { status?: string; start?: number; ps?: number; pe?: number; created?: number; lookup?: string; metaShop?: string; attempt?: string | null; sub?: string; canceledAt?: number | null }
const itemSet = (lookup?: string) =>
  exactFixtureItems().map((item) =>
    item.price.lookup_key === FOUNDER_PILOT_PRICE.lookupKey && lookup ? { ...item, price: { ...item.price, lookup_key: lookup } } : item
  )
const metadataFor = (b: Bound, o: SubOpts) => ({
  shop_id: o.metaShop ?? b.s.shopId, catalog_version: "2026-11-03.v1", plan_key: "founder-pilot",
  ...(o.attempt === null ? {} : { checkout_attempt_id: o.attempt ?? b.attemptId }),
})
const subObject = (b: Bound, o: SubOpts = {}) => {
  const start = o.start ?? NOW_S - DAY
  return {
    id: o.sub ?? b.sub, object: "subscription", customer: b.customerId, status: o.status ?? "active", livemode: false, start_date: start,
    current_period_start: o.ps ?? start, current_period_end: o.pe ?? (o.ps ?? start) + 30 * DAY,
    cancel_at_period_end: false, canceled_at: o.canceledAt ?? null, metadata: metadataFor(b, o),
    items: { data: itemSet(o.lookup), has_more: false },
  }
}
async function webhook(b: Bound, o: SubOpts = {}) {
  const raw = JSON.stringify({
    id: `evt_F3${uniq()}${++evSeq}`, object: "event", type: "customer.subscription.updated", created: o.created ?? NOW_S, livemode: false,
    data: { object: subObject(b, o) },
  })
  const result = await handleCommercialWebhook({ getService: () => db, config: { ok: true, secret: SECRET } }, { rawBody: raw, signatureHeader: signFor(raw) })
  expect(result.status).toBe(200)
  return result
}

// ---------- a fake provider READER (the interface admits GET only) ----------
class FakeProvider implements SubscriptionPollReader {
  subs = new Map<string, unknown[]>()
  sessions = new Map<string, unknown>()
  incomplete = new Set<string>()
  failing = false
  calls: string[] = []
  async listCustomerSubscriptions(customerId: string): Promise<PolledList> {
    this.calls.push(`list:${customerId}`)
    if (this.failing) throw new Error("provider down sk_test_SECRET")
    return { complete: !this.incomplete.has(customerId), data: this.subs.get(customerId) ?? [] }
  }
  async retrieveCheckoutSession(sessionId: string): Promise<unknown> {
    this.calls.push(`session:${sessionId}`)
    if (this.failing) throw new Error("provider down")
    return this.sessions.get(sessionId) ?? {}
  }
  set(customerId: string, ...subs: unknown[]) {
    this.subs.set(customerId, subs)
  }
}
const sessionFor = (b: Bound, over: Record<string, unknown> = {}) => ({
  id: b.sessionId, object: "checkout.session", livemode: false, mode: "subscription", status: "complete",
  client_reference_id: b.attemptId, customer: b.customerId, subscription: b.sub, ...over,
})

// ---------- reads ----------
type Obs = { claim_token: string; outcome: string; reason: string | null; evidence_id: string | null; provider_status: string | null; observed_at: string; requested_at: string; observation_digest: string }
const observations = async (shopId: string) => {
  const r = await db.from("commercial_subscription_poll_observations").select("*").eq("shop_id", shopId).order("recorded_at")
  expect(r.error).toBeNull()
  return r.data as Obs[]
}
type Sched = { next_due_at: string; claim_token: string | null; consecutive_failures: number; polls_total: number; last_outcome: string | null }
const schedule = async (shopId: string) => (await db.from("commercial_subscription_poll_schedule").select("*").eq("shop_id", shopId).maybeSingle()).data as Sched | null
const account = async (shopId: string) =>
  (await db.from("commercial_billing_accounts").select("*").eq("shop_id", shopId).single()).data as { state: string; state_reason: string | null; version: number; current_evidence_id: string | null }
type Ev = { id: string; derived_state: string; provider_status: string; evidence_source: string; source_event_id: string; source_event_created_at: string; derived_reason: string | null; attempt_id: string | null; period_end: string | null }
const evidence = async (shopId: string) => {
  const r = await db.from("commercial_subscription_evidence").select("*").eq("shop_id", shopId).order("recorded_at")
  expect(r.error).toBeNull()
  return r.data as Ev[]
}
const periods = async (shopId: string) => (await db.from("commercial_subscription_periods").select("period_start,period_end").eq("shop_id", shopId).order("period_start")).data as { period_start: string; period_end: string }[]
const sweep = (provider: SubscriptionPollReader, shopId: string, limit = 5) => runSubscriptionPollSweep(db, provider, { shopId, limit })
const forceDue = async (shopId: string) => {
  const r = await sql(`UPDATE public.commercial_subscription_poll_schedule SET next_due_at = clock_timestamp() - interval '1 minute' WHERE shop_id='${shopId}'`)
  expect(r.ok, r.message).toBe(true)
}
const claimFor = async (shopId: string) => (await db.rpc("commercial_subscription_poll_claim", { p_shop: shopId })).data as Record<string, unknown>

/** A webhook-established ACTIVE workspace whose verified period has ELAPSED: the exact "webhooks stopped" situation. */
async function stalledActive(): Promise<Bound> {
  const b = await bound()
  await webhook(b, { start: NOW_S - 40 * DAY, ps: NOW_S - 40 * DAY, pe: NOW_S - 10 * DAY, created: NOW_S - 10 * DAY })
  expect((await account(b.s.shopId)).state).toBe("active")
  return b
}
const RENEWED_PERIOD = { start: NOW_S - 40 * DAY, ps: NOW_S - 10 * DAY, pe: NOW_S + 20 * DAY }
const renewed = (b: Bound, o: SubOpts = {}) => subObject(b, { ...RENEWED_PERIOD, ...o })

const maybe = INTEGRATION_WITH_SESSION ? describe : describe.skip

maybe("commercial subscription polling reconciliation (PR F3)", () => {
  beforeAll(() => {
    db = serviceClient()
    anon = anonClient()
  })
  afterAll(async () => {
    for (const s of seeded) await cleanup(db, s)
  }, 120_000)

  describe("when signed webhooks stop", () => {
    it("a renewal that no webhook delivered is learned by polling, through the one writer, and the lapse gate recovers", async () => {
      const b = await stalledActive()
      expect(await assessCommercialExecution(db, b.s.shopId)).toMatchObject({ allowed: false }) // period elapsed, no newer evidence
      const provider = new FakeProvider()
      provider.set(b.customerId, renewed(b))

      const report = await sweep(provider, b.s.shopId)
      expect(report).toMatchObject({ claimed: 1, recordFailed: 0, claimFailed: false })
      expect(report.outcomes.applied).toBe(1)

      expect((await account(b.s.shopId)).state).toBe("active")
      const ev = (await evidence(b.s.shopId)).at(-1)!
      expect(ev).toMatchObject({ evidence_source: "provider_poll", derived_state: "active", provider_status: "active", attempt_id: null })
      expect(ev.source_event_id).toMatch(/^poll_[0-9a-f]{32}$/)
      // Ordered at claim time minus the 5-minute skew margin, never at an invented time.
      const skew = Date.now() - Date.parse(ev.source_event_created_at)
      expect(skew).toBeGreaterThan(4 * 60_000)
      expect(skew).toBeLessThan(6 * 60_000)
      expect(Date.parse((await periods(b.s.shopId)).at(-1)!.period_end)).toBe((NOW_S + 20 * DAY) * 1000) // a verified period, bound to settlement
      expect(await assessCommercialExecution(db, b.s.shopId)).toEqual({ allowed: true, mode: "commercial" })
      const [obs] = await observations(b.s.shopId)
      expect(obs).toMatchObject({ outcome: "applied", provider_status: "active", evidence_id: ev.id })
      expect(provider.calls).toEqual([`list:${b.customerId}`])
    })

    it("a cancellation or payment failure that no webhook delivered is applied (the fail-closed direction)", async () => {
      const b = await stalledActive()
      const provider = new FakeProvider()
      provider.set(b.customerId, renewed(b, { status: "past_due" }))
      expect((await sweep(provider, b.s.shopId)).outcomes.applied).toBe(1)
      expect(await account(b.s.shopId)).toMatchObject({ state: "past_due" })
      expect(await assessCommercialExecution(db, b.s.shopId)).toMatchObject({ allowed: false })

      await forceDue(b.s.shopId)
      provider.set(b.customerId, renewed(b, { status: "canceled", canceledAt: NOW_S - 60 }))
      expect((await sweep(provider, b.s.shopId)).outcomes.applied).toBe(1)
      expect(await account(b.s.shopId)).toMatchObject({ state: "canceled" })
      // Terminal: a later poll that claims `active` again cannot resurrect it. (Canceled is not even polled.)
      await forceDue(b.s.shopId)
      provider.set(b.customerId, renewed(b))
      const again = await sweep(provider, b.s.shopId)
      expect(again.claimed).toBe(0)
      expect((await account(b.s.shopId)).state).toBe("canceled")
    })

    it("when provider and database agree, only an observation is written (no evidence row, no state change)", async () => {
      const b = await bound()
      await webhook(b) // active, period running
      const before = await evidence(b.s.shopId)
      const version = (await account(b.s.shopId)).version
      const provider = new FakeProvider()
      provider.set(b.customerId, subObject(b))
      expect((await sweep(provider, b.s.shopId)).outcomes.unchanged).toBe(1)
      expect(await evidence(b.s.shopId)).toEqual(before)
      expect((await account(b.s.shopId)).version).toBe(version)
      expect((await observations(b.s.shopId))[0]).toMatchObject({ outcome: "unchanged", evidence_id: before[0].id })
    })

    it("discovers a subscription that no webhook announced ONLY through the server-held Checkout session", async () => {
      const b = await bound()
      expect((await account(b.s.shopId)).state).toBe("checkout_pending")
      const provider = new FakeProvider()
      provider.sessions.set(b.sessionId, sessionFor(b))
      provider.set(b.customerId, subObject(b, { attempt: null }))
      expect((await sweep(provider, b.s.shopId)).outcomes.applied).toBe(1)
      expect(await account(b.s.shopId)).toMatchObject({ state: "active" })
      const ev = (await evidence(b.s.shopId))[0]
      expect(ev).toMatchObject({ evidence_source: "provider_poll", attempt_id: b.attemptId }) // the attempt is the SERVER's, metadata had none
      expect(provider.calls).toEqual([`session:${b.sessionId}`, `list:${b.customerId}`])
    })

    it("a session that is still open, or a stray subscription with no server-held session, changes nothing", async () => {
      const b = await bound()
      const provider = new FakeProvider()
      provider.sessions.set(b.sessionId, sessionFor(b, { status: "open", subscription: null }))
      provider.set(b.customerId, subObject(b))
      expect((await sweep(provider, b.s.shopId)).outcomes.session_pending).toBe(1)
      expect(await account(b.s.shopId)).toMatchObject({ state: "checkout_pending" })
      expect(await evidence(b.s.shopId)).toHaveLength(0)

      // A session that names a DIFFERENT subscription than the one on the list is ambiguous, never adopted.
      await forceDue(b.s.shopId)
      provider.sessions.set(b.sessionId, sessionFor(b, { subscription: "sub_NotOnTheList01" }))
      expect((await sweep(provider, b.s.shopId)).outcomes.ambiguous).toBe(1)
      expect(await evidence(b.s.shopId)).toHaveLength(0)
      expect((await account(b.s.shopId)).state).toBe("checkout_pending")
    })
  })

  describe("never active from ambiguous or unverified evidence", () => {
    it.each([
      ["a truncated list", (p: FakeProvider, b: Bound) => { p.set(b.customerId, renewed(b)); p.incomplete.add(b.customerId) }, "list_incomplete"],
      ["another live subscription on the customer", (p: FakeProvider, b: Bound) => p.set(b.customerId, renewed(b), renewed(b, { sub: "sub_StrayLive000001" })), "unexpected_subscription"],
      ["an already-elapsed period", (p: FakeProvider, b: Bound) => p.set(b.customerId, subObject(b, { start: NOW_S - 40 * DAY, ps: NOW_S - 40 * DAY, pe: NOW_S - 5 * DAY })), "period_elapsed"],
      ["a subscription the provider no longer lists", (p: FakeProvider, b: Bound) => p.set(b.customerId, renewed(b, { sub: "sub_SomethingElse0001" })), "target_missing"],
    ])("%s is ambiguous: the account stays exactly where it was", async (_name, arrange, code) => {
      const b = await stalledActive()
      const before = { acct: await account(b.s.shopId), ev: await evidence(b.s.shopId) }
      const provider = new FakeProvider()
      arrange(provider, b)
      const report = await sweep(provider, b.s.shopId)
      expect(report.outcomes.ambiguous).toBe(1)
      expect(report.outcomes.applied).toBe(0)
      expect((await observations(b.s.shopId))[0]).toMatchObject({ outcome: "ambiguous", reason: code, evidence_id: null })
      expect(await account(b.s.shopId)).toEqual(before.acct)
      expect(await evidence(b.s.shopId)).toEqual(before.ev)
      expect(await assessCommercialExecution(db, b.s.shopId)).toMatchObject({ allowed: false })
    })

    it("an unreadable provider records an unreadable observation (never the error text), changes nothing and backs off", async () => {
      const b = await stalledActive()
      const provider = new FakeProvider()
      provider.failing = true
      const report = await sweep(provider, b.s.shopId)
      expect(report.outcomes.unreadable).toBe(1)
      expect(JSON.stringify(await observations(b.s.shopId))).not.toContain("SECRET")
      expect((await account(b.s.shopId)).state).toBe("active")
      const sched = (await schedule(b.s.shopId))!
      expect(sched).toMatchObject({ consecutive_failures: 1, polls_total: 1, last_outcome: "unreadable", claim_token: null })
      expect(Date.parse(sched.next_due_at) - Date.now()).toBeGreaterThan(10 * 60_000)

      // The backoff doubles and is capped at six hours.
      for (let i = 0; i < 7; i++) {
        await forceDue(b.s.shopId)
        await sweep(provider, b.s.shopId)
      }
      const later = (await schedule(b.s.shopId))!
      expect(later.consecutive_failures).toBe(8)
      const wait = Date.parse(later.next_due_at) - Date.now()
      expect(wait).toBeGreaterThan(5.9 * 3600_000)
      expect(wait).toBeLessThanOrEqual(6 * 3600_000 + 5_000)
    })

    it("a recovery is applied only when the evidence is clean, and never over a fresher signed webhook", async () => {
      // Fresh webhook (inside the 5-minute skew margin) says past_due; a poll that says active must lose.
      const fresh = await bound()
      await webhook(fresh, { status: "past_due", created: NOW_S - 60 })
      const p1 = new FakeProvider()
      p1.set(fresh.customerId, subObject(fresh))
      expect((await sweep(p1, fresh.s.shopId)).outcomes.not_current).toBe(1)
      expect((await observations(fresh.s.shopId))[0]).toMatchObject({ outcome: "not_current", reason: "out_of_order" })
      expect((await account(fresh.s.shopId)).state).toBe("past_due")

      // The same recovery, with the last webhook ten minutes old, is applied.
      const stale = await bound()
      await webhook(stale, { status: "past_due", created: NOW_S - 600 })
      const p2 = new FakeProvider()
      p2.set(stale.customerId, subObject(stale))
      expect((await sweep(p2, stale.s.shopId)).outcomes.applied).toBe(1)
      expect((await account(stale.s.shopId)).state).toBe("active")
    })
  })

  describe("sticky integrity failures are preserved", () => {
    it("a reconciliation_required account is not polled at all (no provider read)", async () => {
      const b = await bound()
      await webhook(b, { lookup: "some_other_price" }) // catalog mismatch: sticky
      expect(await account(b.s.shopId)).toMatchObject({ state: "reconciliation_required", state_reason: "catalog_mismatch" })
      const provider = new FakeProvider()
      provider.set(b.customerId, subObject(b))
      const report = await sweep(provider, b.s.shopId)
      expect(report.claimed).toBe(0)
      expect(provider.calls).toEqual([])
      expect(await account(b.s.shopId)).toMatchObject({ state: "reconciliation_required", state_reason: "catalog_mismatch" })
    })

    it("a block that lands between claim and record still wins: the polled `active` is recorded but blocked, never cleared", async () => {
      const b = await stalledActive()
      const claim = await claimFor(b.s.shopId)
      expect(claim.claimed).toBe(true)
      await webhook(b, { lookup: "some_other_price", created: NOW_S - 1, ...RENEWED_PERIOD }) // the account turns sticky mid-poll
      expect((await account(b.s.shopId)).state).toBe("reconciliation_required")
      const observation = {
        kind: "subscription", customer_id: b.customerId, session_subscription_id: null, digest: "a".repeat(64),
        facts: { ...(await factsOf(renewed(b))) },
      }
      const r = await db.rpc("commercial_subscription_poll_record", { p_shop: b.s.shopId, p_claim_token: claim.claim_token, p_observation: observation })
      expect(r.error).toBeNull()
      expect(r.data).toMatchObject({ outcome: "not_current", reason: "blocked_pending_review" })
      expect(await account(b.s.shopId)).toMatchObject({ state: "reconciliation_required", state_reason: "catalog_mismatch" })
    })

    it("a polled catalog mismatch is the same sticky failure the webhook produces", async () => {
      const b = await stalledActive()
      const provider = new FakeProvider()
      provider.set(b.customerId, renewed(b, { lookup: "some_other_price" }))
      await sweep(provider, b.s.shopId)
      expect(await account(b.s.shopId)).toMatchObject({ state: "reconciliation_required", state_reason: "catalog_mismatch" })
      expect((await evidence(b.s.shopId)).at(-1)).toMatchObject({ evidence_source: "provider_poll", derived_state: "reconciliation_required" })
    })

    it("an `active` observation that arrives after a signed cancellation cannot resurrect the subscription", async () => {
      const b = await stalledActive()
      const claim = await claimFor(b.s.shopId)
      await webhook(b, { status: "canceled", canceledAt: NOW_S - 30, created: NOW_S - 30, start: NOW_S - 40 * DAY, ps: NOW_S - 40 * DAY, pe: NOW_S - 10 * DAY })
      expect((await account(b.s.shopId)).state).toBe("canceled")
      const r = await db.rpc("commercial_subscription_poll_record", {
        p_shop: b.s.shopId, p_claim_token: claim.claim_token,
        p_observation: { kind: "subscription", customer_id: b.customerId, session_subscription_id: null, digest: "b".repeat(64), facts: await factsOf(renewed(b)) },
      })
      expect(r.data).toMatchObject({ outcome: "not_current", reason: "subscription_terminal" })
      expect((await account(b.s.shopId)).state).toBe("canceled")
    })
  })

  describe("tenant binding: provider metadata never chooses the tenant", () => {
    it("a metadata shop id that names ANOTHER shop blocks only the customer's own shop", async () => {
      const a = await stalledActive()
      const other = await stalledActive()
      const otherBefore = { acct: await account(other.s.shopId), ev: await evidence(other.s.shopId), sched: await schedule(other.s.shopId) }
      const provider = new FakeProvider()
      provider.set(a.customerId, renewed(a, { metaShop: other.s.shopId, attempt: other.attemptId }))
      const report = await sweep(provider, a.s.shopId)
      expect(report.outcomes.refused).toBe(1)
      expect(await account(a.s.shopId)).toMatchObject({ state: "reconciliation_required", state_reason: "tenant_conflict" })
      expect((await observations(a.s.shopId))[0]).toMatchObject({ outcome: "refused", reason: "tenant_conflict", evidence_id: null })
      // The shop the metadata named is untouched; the only reads were for the BOUND customer.
      expect(await account(other.s.shopId)).toEqual(otherBefore.acct)
      expect(await evidence(other.s.shopId)).toEqual(otherBefore.ev)
      expect(await schedule(other.s.shopId)).toEqual(otherBefore.sched)
      expect(await observations(other.s.shopId)).toHaveLength(0)
      expect(provider.calls).toEqual([`list:${a.customerId}`])
    })

    it("an observation about a different customer than the server-held binding is refused and changes nothing", async () => {
      const a = await stalledActive()
      const other = await stalledActive()
      const claim = await claimFor(a.s.shopId)
      const before = await account(a.s.shopId)
      const r = await db.rpc("commercial_subscription_poll_record", {
        p_shop: a.s.shopId, p_claim_token: claim.claim_token,
        p_observation: { kind: "subscription", customer_id: other.customerId, session_subscription_id: null, digest: "c".repeat(64), facts: await factsOf(renewed(other)) },
      })
      expect(r.data).toMatchObject({ outcome: "refused", reason: "customer_mismatch" })
      expect(await account(a.s.shopId)).toEqual(before)
      expect(await evidence(a.s.shopId)).toHaveLength(1)
    })

    it("a claim is shop-bound: another shop's claim token (or a made-up one) can record nothing", async () => {
      const a = await stalledActive()
      const other = await stalledActive()
      const claim = await claimFor(a.s.shopId)
      const obs = { kind: "none", customer_id: other.customerId, class: "no_subscription", code: "nothing_to_compare", digest: "d".repeat(64) }
      const crossed = await db.rpc("commercial_subscription_poll_record", { p_shop: other.s.shopId, p_claim_token: claim.claim_token, p_observation: obs })
      expect(crossed.error?.code).toBe("CB409")
      const made = await db.rpc("commercial_subscription_poll_record", { p_shop: a.s.shopId, p_claim_token: "00000000-0000-4000-8000-0000000000aa", p_observation: { ...obs, customer_id: a.customerId } })
      expect(made.error?.code).toBe("CB409")
      expect(await observations(other.s.shopId)).toHaveLength(0)
      expect(await observations(a.s.shopId)).toHaveLength(0)
    })
  })

  describe("replay safety, the rate limit and lease-safe concurrency", () => {
    it("records one observation per claim: an identical replay returns the stored result, changed content is CB409", async () => {
      const b = await stalledActive()
      const claim = await claimFor(b.s.shopId)
      const observation = { kind: "none", customer_id: b.customerId, class: "ambiguous", code: "list_incomplete", digest: "e".repeat(64) }
      const first = await db.rpc("commercial_subscription_poll_record", { p_shop: b.s.shopId, p_claim_token: claim.claim_token, p_observation: observation })
      expect(first.data).toMatchObject({ outcome: "ambiguous", reason: "list_incomplete", replayed: false })
      const replay = await db.rpc("commercial_subscription_poll_record", { p_shop: b.s.shopId, p_claim_token: claim.claim_token, p_observation: observation })
      expect(replay.data).toMatchObject({ outcome: "ambiguous", reason: "list_incomplete", replayed: true })
      const changed = await db.rpc("commercial_subscription_poll_record", { p_shop: b.s.shopId, p_claim_token: claim.claim_token, p_observation: { ...observation, digest: "f".repeat(64) } })
      expect(changed.error?.code).toBe("CB409")
      expect(await observations(b.s.shopId)).toHaveLength(1)
      expect((await schedule(b.s.shopId))!.polls_total).toBe(1)
    })

    it("concurrent identical records of one claim write one observation and one evidence row", async () => {
      const b = await stalledActive()
      const claim = await claimFor(b.s.shopId)
      const observation = { kind: "subscription", customer_id: b.customerId, session_subscription_id: null, digest: "1".repeat(64), facts: await factsOf(renewed(b)) }
      const results = await Promise.all(
        Array.from({ length: 6 }, () => db.rpc("commercial_subscription_poll_record", { p_shop: b.s.shopId, p_claim_token: claim.claim_token, p_observation: observation }))
      )
      expect(results.every((r) => r.error === null)).toBe(true)
      expect(results.filter((r) => (r.data as { replayed: boolean }).replayed === false)).toHaveLength(1)
      expect(await observations(b.s.shopId)).toHaveLength(1)
      expect((await evidence(b.s.shopId)).filter((e) => e.evidence_source === "provider_poll")).toHaveLength(1)
    })

    it("a polled shop is not due again until its interval passes: repeated sweeps make no provider read", async () => {
      const b = await stalledActive()
      const provider = new FakeProvider()
      provider.set(b.customerId, renewed(b))
      expect((await sweep(provider, b.s.shopId)).claimed).toBe(1)
      for (let i = 0; i < 3; i++) expect((await sweep(provider, b.s.shopId)).claimed).toBe(0)
      expect(provider.calls).toHaveLength(1)
      expect(await observations(b.s.shopId)).toHaveLength(1)
      // A healthy active shop with a long period left backs off to hours; once due it is polled again.
      const sched = (await schedule(b.s.shopId))!
      expect(Date.parse(sched.next_due_at) - Date.now()).toBeGreaterThan(5 * 3600_000)
      await forceDue(b.s.shopId)
      expect((await sweep(provider, b.s.shopId)).claimed).toBe(1)
      expect((await observations(b.s.shopId)).map((o) => o.outcome)).toEqual(["applied", "unchanged"])
    })

    it("many concurrent claimers: exactly one wins the shop", async () => {
      const b = await stalledActive()
      const results = await Promise.all(Array.from({ length: 10 }, () => db.rpc("commercial_subscription_poll_claim", { p_shop: b.s.shopId })))
      expect(results.every((r) => r.error === null)).toBe(true)
      const claims = results.map((r) => r.data as { claimed: boolean })
      expect(claims.filter((c) => c.claimed)).toHaveLength(1)
      expect((await schedule(b.s.shopId))!.claim_token).not.toBeNull()
    })

    it("concurrent sweeps (a lost lease, or two crons) read the provider once and write one observation", async () => {
      const b = await stalledActive()
      const provider = new FakeProvider()
      provider.set(b.customerId, renewed(b))
      const reports = await Promise.all(Array.from({ length: 5 }, () => sweep(provider, b.s.shopId)))
      expect(reports.reduce((n, r) => n + r.claimed, 0)).toBe(1)
      expect(provider.calls).toHaveLength(1)
      expect(await observations(b.s.shopId)).toHaveLength(1)
      expect((await evidence(b.s.shopId)).filter((e) => e.evidence_source === "provider_poll")).toHaveLength(1)
    })

    it("an expired claim is superseded; the dead worker's token can record nothing and the shop backs off", async () => {
      const b = await stalledActive()
      const dead = await claimFor(b.s.shopId)
      expect(dead.claimed).toBe(true)
      expect((await claimFor(b.s.shopId)).claimed).toBe(false) // a live claim holds the shop
      const r = await sql(`UPDATE public.commercial_subscription_poll_schedule SET claim_until = clock_timestamp() - interval '1 second' WHERE shop_id='${b.s.shopId}'`)
      expect(r.ok, r.message).toBe(true)
      const late = await db.rpc("commercial_subscription_poll_record", {
        p_shop: b.s.shopId, p_claim_token: dead.claim_token,
        p_observation: { kind: "subscription", customer_id: b.customerId, session_subscription_id: null, digest: "2".repeat(64), facts: await factsOf(renewed(b)) },
      })
      expect(late.error?.code).toBe("CB409") // an expired claim cannot record, even before anyone supersedes it
      const live = await claimFor(b.s.shopId)
      expect(live).toMatchObject({ claimed: true })
      expect(live.claim_token).not.toBe(dead.claim_token)
      expect((await schedule(b.s.shopId))!.consecutive_failures).toBe(1) // the abandoned claim counted as a failed poll
      const stale = await db.rpc("commercial_subscription_poll_record", {
        p_shop: b.s.shopId, p_claim_token: dead.claim_token,
        p_observation: { kind: "none", customer_id: b.customerId, class: "no_subscription", code: "nothing_to_compare", digest: "3".repeat(64) },
      })
      expect(stale.error?.code).toBe("CB409")
      expect(await evidence(b.s.shopId)).toHaveLength(1)
      expect(await observations(b.s.shopId)).toHaveLength(0)
    })

    it("only eligible accounts are claimed: canceled, unconfigured and shops with nothing server-held are skipped", async () => {
      const bare = await transient(() => seedShop(db, { password: PW }))
      seeded.push(bare)
      expect((await claimFor(bare.shopId)).claimed).toBe(false) // no billing account at all
      const b = await bound()
      const noSession = await db.from("commercial_checkout_attempts").select("status").eq("id", b.attemptId).single()
      expect(noSession.data?.status).toBe("session_open")
      expect((await claimFor(b.s.shopId)).claimed).toBe(true) // account has a session-bound attempt
    })
  })

  describe("the worker (leased, bounded) runs polling as a fourth task and never mutates the provider", () => {
    it("runs all four tasks; the poll task reads GET-only and reports counts and finite codes", async () => {
      const b = await stalledActive()
      const requests: { method: string; path: string }[] = []
      const transport = (async (_cfg: unknown, input: { method: string; path: string; body?: Record<string, unknown> }) => {
        requests.push({ method: input.method, path: input.path })
        if (input.path === "/subscriptions") return { data: [renewed(b)], has_more: false }
        throw new Error("unexpected provider request")
      }) as never
      const deps: WorkerDeps = {
        settlementRuntime: { ok: false, reason: "billing_unconfigured" },
        adjustmentRuntime: { ok: false, reason: "billing_unconfigured" },
        evidenceReader: null,
        subscriptionPollReader: createSubscriptionPollReader(FAKE_CONFIG, transport),
        sandboxReady: async () => false,
        shopId: b.s.shopId,
      }
      const report = await runCommercialBillingWorker(db, deps)
      const poll = report.tasks.find((t) => t.worker === "subscription_poll")!
      expect(report.tasks.map((t) => t.worker)).toEqual([...WORKER_KINDS])
      // `partial` (not `failed`) only if some unrelated eligible shop on this shared test stack is an hour overdue.
      expect(poll).toMatchObject({ status: "ran", counts: { claimed: 1, applied: 1, recordFailed: 0 } })
      expect(["completed", "partial"]).toContain((poll as { outcome: string }).outcome)
      expect(requests).toEqual([{ method: "GET", path: "/subscriptions" }])
      expect(JSON.stringify(report)).not.toMatch(/cus_|sub_|sk_test|whsec_|https?:/)
      expect((await account(b.s.shopId)).state).toBe("active")
    })

    it("a held lease skips only the poll task; a full outage of the provider is a failed (alerting) run", async () => {
      const b = await stalledActive()
      const provider = new FakeProvider()
      provider.failing = true
      const deps: WorkerDeps = {
        settlementRuntime: { ok: false, reason: "billing_unconfigured" }, adjustmentRuntime: { ok: false, reason: "billing_unconfigured" },
        evidenceReader: null, subscriptionPollReader: provider, sandboxReady: async () => false, shopId: b.s.shopId,
      }
      const held = (await db.rpc("commercial_worker_lease_acquire", { p_worker: "subscription_poll", p_ttl_seconds: 60 })).data as { acquired: boolean; token: string }
      expect(held.acquired).toBe(true)
      const skipped = await runCommercialBillingWorker(db, deps)
      expect(skipped.tasks.find((t) => t.worker === "subscription_poll")).toEqual({ worker: "subscription_poll", status: "skipped", reason: "lease_held" })
      expect(provider.calls).toHaveLength(0)
      await db.rpc("commercial_worker_lease_release", { p_worker: "subscription_poll", p_token: held.token, p_outcome: "completed" })

      const outage = await runCommercialBillingWorker(db, deps)
      expect(outage.tasks.find((t) => t.worker === "subscription_poll")).toMatchObject({ status: "ran", outcome: "failed", counts: { claimed: 1, unreadable: 1 } })
      expect(outage.ok).toBe(false)
    })
  })

  describe("observability, authority and immutability", () => {
    it("the overview reports counts only and is service-role only", async () => {
      const b = await stalledActive()
      const provider = new FakeProvider()
      provider.set(b.customerId, renewed(b))
      await sweep(provider, b.s.shopId)
      const overview = (await db.rpc("commercial_subscription_poll_overview")).data as Record<string, unknown>
      expect(Object.keys(overview).sort()).toEqual(["claimed", "due", "eligible", "failing", "never_polled", "oldest_last_observed_at", "outcomes_24h", "overdue"])
      expect(JSON.stringify(overview)).not.toMatch(/cus_|sub_|shop|token|[0-9a-f]{8}-[0-9a-f]{4}-/)
      expect((overview.outcomes_24h as Record<string, number>).applied).toBeGreaterThanOrEqual(1)
      expect((await anon.rpc("commercial_subscription_poll_overview")).error).not.toBeNull()
    })

    it("browser roles can call none of it and read none of it (anonymous and the shop's own owner session)", async () => {
      const b = await stalledActive()
      const owner = await ownerSessionClient(b.s.email, PW)
      for (const client of [anon, owner]) {
        expect((await client.rpc("commercial_subscription_poll_claim", { p_shop: b.s.shopId })).error?.code).toBe("42501")
        expect((await client.rpc("commercial_subscription_poll_record", { p_shop: b.s.shopId, p_claim_token: "00000000-0000-4000-8000-0000000000bb", p_observation: {} })).error?.code).toBe("42501")
        expect((await client.rpc("commercial_subscription_poll_overview")).error?.code).toBe("42501")
        expect((await client.from("commercial_subscription_poll_schedule").select("*")).error).not.toBeNull()
        expect((await client.from("commercial_subscription_poll_observations").select("*")).error).not.toBeNull()
      }
    })

    it("observations and the schedule are tamper-proof: append-only, no truncate, identity and counter protected", async () => {
      const b = await stalledActive()
      const provider = new FakeProvider()
      provider.set(b.customerId, renewed(b))
      await sweep(provider, b.s.shopId)
      const id = (await observations(b.s.shopId))[0].claim_token
      for (const query of [
        `UPDATE public.commercial_subscription_poll_observations SET outcome='unchanged' WHERE claim_token='${id}'`,
        `DELETE FROM public.commercial_subscription_poll_observations WHERE claim_token='${id}'`,
        `TRUNCATE public.commercial_subscription_poll_observations`,
        `DELETE FROM public.commercial_subscription_poll_schedule WHERE shop_id='${b.s.shopId}'`,
        `TRUNCATE public.commercial_subscription_poll_schedule`,
        `UPDATE public.commercial_subscription_poll_schedule SET polls_total = 0 WHERE shop_id='${b.s.shopId}'`,
        `UPDATE public.commercial_subscription_poll_schedule SET shop_id = '${bare()}' WHERE shop_id='${b.s.shopId}'`,
      ]) {
        const r = await sql(query)
        expect(r.ok, query).toBe(false)
      }
      expect(await observations(b.s.shopId)).toHaveLength(1)
    })

    it("polled evidence cannot be written without a required verified period, and live mode stays unrepresentable", async () => {
      const b = await stalledActive()
      const base = {
        p_shop: b.s.shopId, p_subscription: b.sub, p_customer: b.customerId, p_status: "active", p_catalog_version: "2026-11-03.v1",
        p_plan_key: "founder-pilot", p_lookup_key: FOUNDER_PILOT_PRICE.lookupKey, p_source: "provider_poll", p_event_id: `poll_${uniq()}abcdef`,
        p_event_created_at: iso(NOW_S), p_livemode: false,
      }
      const noPeriod = await db.rpc("commercial_subscription_apply_evidence", { ...base, p_require_period: false })
      expect(noPeriod.error?.code).toBe("22023")
      const defaulted = await db.rpc("commercial_subscription_apply_evidence", base)
      expect(defaulted.error?.code).toBe("22023")
      const live = await db.rpc("commercial_subscription_apply_evidence", { ...base, p_livemode: true, p_require_period: true })
      expect(live.error?.code).toBe("22023")
      const unknownSource = await db.rpc("commercial_subscription_apply_evidence", { ...base, p_source: "polling", p_require_period: true })
      expect(unknownSource.error?.code).toBe("22023")
      expect(await evidence(b.s.shopId)).toHaveLength(1)
    })

    it("deleting a shop removes its schedule and observations (and nothing else's)", async () => {
      const keep = await stalledActive()
      const gone = await stalledActive()
      const provider = new FakeProvider()
      provider.set(keep.customerId, renewed(keep))
      provider.set(gone.customerId, renewed(gone))
      await sweep(provider, keep.s.shopId)
      await sweep(provider, gone.s.shopId)
      await cleanup(db, gone.s)
      seeded.splice(seeded.indexOf(gone.s), 1)
      expect(await observations(gone.s.shopId)).toHaveLength(0)
      expect(await schedule(gone.s.shopId)).toBeNull()
      expect(await observations(keep.s.shopId)).toHaveLength(1)
    })
  })
})

/** The facts a poll would hand the database for a provider subscription (the SAME normalizer as the signed webhook). */
async function factsOf(subscription: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { normalizeSubscription } = await import("@/lib/commercial-webhook")
  return { ...normalizeSubscription(subscription)!, checkout_attempt_id: null }
}
const bare = () => "00000000-0000-4000-8000-000000000000"
