import { createHmac } from "node:crypto"

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

import { runCustomAgent, runEventRecipe } from "@/lib/agent-runtime"
import { APPROVED_COMMERCIAL_CATALOG_VERSION } from "@/lib/approved-commercial-catalog"
import { COMMERCIAL_CATALOG_VERSION, FOUNDER_PILOT_PRICE } from "@/lib/commercial-billing"
import { requestCommercialBillingPortal, type PortalRuntime } from "@/lib/commercial-billing-service"
import { assessCommercialExecution } from "@/lib/commercial-execution-gate"
import { previewCommercialSettlement } from "@/lib/commercial-settlement-service"
import { handleCommercialWebhook } from "@/lib/commercial-webhook-service"
import type { PlatformPortalClient } from "@/lib/stripe-commercial"
import {
  INTEGRATION_WITH_SESSION,
  anonClient,
  assertDisposableTarget,
  cleanup,
  ownerSessionClient,
  seedShop,
  serviceClient,
  type Seeded,
} from "./_db"

const PW = "Synthetic-password-123!"
const SECRET = "whsec_" + "e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1"
const ORIGIN = "https://app.gradia.example"
const TABLES = [
  "commercial_webhook_receipts",
  "commercial_provider_facts",
  "commercial_subscription_periods",
  "commercial_settlement_adjustments",
  "commercial_adjustment_reviews",
] as const

let db: SupabaseClient
let anon: SupabaseClient
const seeded: Seeded[] = []
let seq = 0
const uniq = () => `${Date.now().toString(36)}${(++seq).toString(36)}`.replace(/[^A-Za-z0-9]/g, "")

async function transient<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown
  for (let i = 0; i < 4; i++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      if (!/invalid response was received from the upstream server/i.test(String((e as Error)?.message))) throw e
      await new Promise((r) => setTimeout(r, 250 * (i + 1)))
    }
  }
  throw last
}
async function newShop(): Promise<Seeded> {
  const s = await transient(() => seedShop(db, { password: PW }))
  seeded.push(s)
  return s
}
async function addMember(shopId: string, user: Seeded, role: string, active = true) {
  const r = await db
    .from("shop_memberships")
    .upsert({ shop_id: shopId, user_id: user.ownerId, role, capabilities: [], active, display_name: role }, { onConflict: "shop_id,user_id" })
  expect(r.error).toBeNull()
}

/** Fixture-only SQL through the disposable stack's pg-meta endpoint (target asserted). */
async function sql(query: string): Promise<{ ok: boolean; rows: unknown; message?: string }> {
  assertDisposableTarget()
  const key = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY as string
  const res = await fetch(`${process.env.SUPABASE_TEST_URL}/pg/query`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: key, authorization: `Bearer ${key}` },
    body: JSON.stringify({ query }),
  })
  const body = (await res.json()) as unknown
  if (!res.ok) return { ok: false, rows: null, message: String((body as { message?: string })?.message ?? res.status) }
  return { ok: true, rows: body }
}

// ---------- a bound workspace: customer + an open Checkout session, exactly as PR C leaves it ----------
type Bound = { s: Seeded; customerId: string; attemptId: string; sessionId: string; sub: string }
async function bound(opts: { customer?: boolean } = {}): Promise<Bound> {
  const s = await newShop()
  const customerId = `cus_E1${uniq()}`
  const sessionId = `cs_test_E1${uniq()}`
  const begun = await db.rpc("commercial_checkout_begin", {
    p_shop: s.shopId, p_actor: s.ownerId, p_catalog_version: APPROVED_COMMERCIAL_CATALOG_VERSION,
    p_plan_key: "founder-pilot", p_lookup_key: FOUNDER_PILOT_PRICE.lookupKey, p_return_target: "agents", p_fingerprint: "d".repeat(64),
  })
  expect(begun.error).toBeNull()
  const attemptId = (begun.data as { attempt_id: string }).attempt_id
  if (opts.customer !== false) {
    expect((await db.rpc("commercial_checkout_bind_customer", { p_shop: s.shopId, p_actor: s.ownerId, p_attempt: attemptId, p_customer: customerId })).error).toBeNull()
    expect((await db.rpc("commercial_checkout_record_session", { p_shop: s.shopId, p_actor: s.ownerId, p_attempt: attemptId, p_session: sessionId })).error).toBeNull()
  }
  return { s, customerId, attemptId, sessionId, sub: `sub_E1${uniq()}` }
}

// ---------- signed delivery ----------
const config = { ok: true as const, secret: SECRET }
const signFor = (raw: string) => {
  const t = Math.floor(Date.now() / 1000)
  return `t=${t},v1=${createHmac("sha256", SECRET).update(`${t}.${raw}`).digest("hex")}`
}
const deliverRaw = (raw: string) =>
  handleCommercialWebhook({ getService: () => db, config }, { rawBody: raw, signatureHeader: signFor(raw) })
const deliver = (body: unknown) => deliverRaw(JSON.stringify(body))

let evSeq = 0
const evId = () => `evt_E1${uniq()}${++evSeq}`
const NOW_S = Math.floor(Date.now() / 1000)
const DAY = 86_400
const utc = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d) / 1000)

const envelope = (type: string, object: Record<string, unknown>, o: { id?: string; created?: number; account?: string; livemode?: boolean } = {}) => ({
  id: o.id ?? evId(), object: "event", type, created: o.created ?? NOW_S, livemode: o.livemode ?? false,
  ...(o.account ? { account: o.account } : {}), data: { object },
})
type SubOpts = {
  sub?: string; customer?: string; status?: string; start?: number; ps?: number; pe?: number; cap?: boolean; canceledAt?: number | null
  metaShop?: string; attempt?: string; lookup?: string; qty?: number; noPeriod?: boolean
}
const subObj = (b: Bound, o: SubOpts = {}) => {
  const start = o.start ?? NOW_S - DAY
  return {
    id: o.sub ?? b.sub, object: "subscription", customer: o.customer ?? b.customerId, status: o.status ?? "active", livemode: false,
    start_date: start, ...(o.noPeriod ? {} : { current_period_start: o.ps ?? start, current_period_end: o.pe ?? (o.ps ?? start) + 30 * DAY }),
    cancel_at_period_end: o.cap ?? false, canceled_at: o.canceledAt ?? null,
    metadata: { shop_id: o.metaShop ?? b.s.shopId, catalog_version: "2026-11-03.v1", plan_key: "founder-pilot", checkout_attempt_id: o.attempt ?? b.attemptId },
    items: { data: [{ quantity: o.qty ?? 1, price: { lookup_key: o.lookup ?? FOUNDER_PILOT_PRICE.lookupKey } }] },
  }
}
const subEvent = (b: Bound, o: SubOpts & { created?: number; id?: string; type?: string } = {}) =>
  envelope(o.type ?? "customer.subscription.updated", subObj(b, o), { created: o.created, id: o.id })

async function one<T = Record<string, unknown>>(table: string, shopId: string, order = "recorded_at"): Promise<T[]> {
  const r = await db.from(table).select("*").eq("shop_id", shopId).order(order)
  expect(r.error).toBeNull()
  return r.data as T[]
}
const acct = async (shopId: string) =>
  (await db.from("commercial_billing_accounts").select("*").eq("shop_id", shopId).single()).data as {
    state: string; state_reason: string | null; version: number; current_evidence_id: string | null }
const receipts = (shopId: string) => one<{ event_id: string; outcome: string; reason: string | null; payload_digest: string }>("commercial_webhook_receipts", shopId, "received_at")
const evidence = (shopId: string) => one<{ derived_state: string; provider_status: string; source_event_id: string; derived_reason: string | null; provider_subscription_id: string }>("commercial_subscription_evidence", shopId)
const facts = (shopId: string) => one<{ kind: string; amount_cents: number | null; provider_subscription_id: string | null }>("commercial_provider_facts", shopId)
const periods = (shopId: string) => one<{ period_start: string; period_end: string; provider_subscription_id: string }>("commercial_subscription_periods", shopId, "period_start")
const lastReason = async (shopId: string) => (await receipts(shopId)).at(-1)?.reason
const gate = (shopId: string) => assessCommercialExecution(db, shopId)

let agentSeq = 0
async function newAgent(shopId: string, ownerId: string, enabled = false) {
  const { data, error } = await db
    .from("custom_agents")
    .insert({ shop_id: shopId, owner_id: ownerId, name: `E1 agent ${++agentSeq}`, problem_text: "Synthetic", config: {}, enabled })
    .select("*")
    .single()
  expect(error).toBeNull()
  return data as Record<string, unknown> & { id: string }
}

async function activate(b: Bound) {
  const agent = await newAgent(b.s.shopId, b.s.ownerId)
  const r = await db.rpc("commercial_agent_activate", { p_shop: b.s.shopId, p_actor: b.s.ownerId, p_agent: agent.id })
  expect(r.error).toBeNull()
  return r.data as { outcome: string; code: string | null }
}

const maybe = INTEGRATION_WITH_SESSION ? describe : describe.skip

maybe("commercial reconciliation (PR E1)", () => {
  beforeAll(() => {
    db = serviceClient()
    anon = anonClient()
  })
  afterAll(async () => {
    for (const s of seeded) await cleanup(db, s)
  })

  describe("platform vs Connect, live vs test, signature (end to end)", () => {
    it("never touches the database for a Connect envelope, a live event, a live object, or a bad signature", async () => {
      const b = await bound()
      const before = await receipts(b.s.shopId)
      const ev = subEvent(b)
      expect((await deliver({ ...ev, account: "acct_Connected1" })).body).toEqual({ received: false, error: "connect_event_refused" })
      expect((await deliver({ ...ev, livemode: true })).body).toEqual({ received: false, error: "live_event_refused" })
      expect((await deliver({ ...ev, data: { object: { ...subObj(b), livemode: true } } })).body).toEqual({ received: false, error: "live_object_refused" })
      const raw = JSON.stringify(ev)
      const bad = await handleCommercialWebhook({ getService: () => db, config }, { rawBody: raw, signatureHeader: `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}` })
      expect(bad).toEqual({ status: 400, body: { received: false, error: "invalid_signature" } })
      expect(await receipts(b.s.shopId)).toEqual(before)
      expect(await evidence(b.s.shopId)).toHaveLength(0)
      expect((await acct(b.s.shopId)).state).toBe("checkout_pending")
    })
    it("the database itself refuses live-mode input even from the service role", async () => {
      const r = await db.rpc("commercial_webhook_ingest", {
        p_event_id: evId(), p_event_type: "customer.subscription.updated", p_event_created: new Date().toISOString(),
        p_payload_digest: "a".repeat(64), p_livemode: true, p_facts: { object: "subscription" },
      })
      expect(r.error?.code).toBe("22023")
    })
  })

  describe("replay claims are durable and exact", () => {
    it("an identical redelivery returns the original outcome and writes nothing new", async () => {
      const b = await bound()
      const ev = subEvent(b)
      const first = await deliver(ev)
      expect(first).toEqual({ status: 200, body: { received: true, outcome: "applied", replayed: false } })
      const afterFirst = await acct(b.s.shopId)
      const again = await deliver(ev)
      expect(again).toEqual({ status: 200, body: { received: true, outcome: "applied", replayed: true } })
      expect(await receipts(b.s.shopId)).toHaveLength(1)
      expect(await evidence(b.s.shopId)).toHaveLength(1)
      expect(await periods(b.s.shopId)).toHaveLength(1)
      expect(await acct(b.s.shopId)).toEqual(afterFirst) // a replay does not even advance the account version
    })
    it("the same event id with different content is a conflict and changes nothing", async () => {
      const b = await bound()
      const id = evId()
      expect((await deliver(subEvent(b, { id, status: "active" }))).status).toBe(200)
      const state = await acct(b.s.shopId)
      const conflict = await deliver(subEvent(b, { id, status: "canceled" }))
      expect(conflict).toEqual({ status: 409, body: { received: false, error: "event_conflict" } })
      expect(await acct(b.s.shopId)).toEqual(state)
      expect(await evidence(b.s.shopId)).toHaveLength(1)
    })
    it("eight concurrent identical deliveries produce exactly one receipt, one evidence row and one period", async () => {
      const b = await bound()
      const ev = subEvent(b)
      const results = await Promise.all(Array.from({ length: 8 }, () => deliver(ev)))
      expect(results.every((r) => r.status === 200)).toBe(true)
      expect(results.filter((r) => r.body.replayed === false)).toHaveLength(1)
      expect(await receipts(b.s.shopId)).toHaveLength(1)
      expect(await evidence(b.s.shopId)).toHaveLength(1)
      expect(await periods(b.s.shopId)).toHaveLength(1)
      expect((await acct(b.s.shopId)).state).toBe("active")
    })
    it("concurrent DIFFERENT events for one workspace converge on the newest evidence", async () => {
      const b = await bound()
      const base = NOW_S - 600
      const states = ["incomplete", "past_due", "active", "past_due", "active", "past_due"]
      const events = states.map((status, i) => subEvent(b, { status, created: base + i }))
      const results = await Promise.all(events.map((e) => deliver(e)))
      expect(results.every((r) => r.status === 200)).toBe(true)
      expect(await receipts(b.s.shopId)).toHaveLength(6)
      expect(await evidence(b.s.shopId)).toHaveLength(6)
      expect((await acct(b.s.shopId)).state).toBe("past_due") // the newest event wins whatever the arrival order
    })
  })

  describe("tenant binding comes only from server-held bindings", () => {
    it("an unknown customer is unresolved even when the metadata names a real shop", async () => {
      const b = await bound()
      const before = await acct(b.s.shopId)
      const r = await deliver(subEvent(b, { customer: "cus_NobodyOwnsThis1" }))
      expect(r.body).toMatchObject({ received: true, outcome: "unresolved" })
      expect(await acct(b.s.shopId)).toEqual(before)
      expect(await evidence(b.s.shopId)).toHaveLength(0)
    })
    it("a subscription we never created through our Checkout is unresolved and applies nothing", async () => {
      const b = await bound()
      const r = await deliver(subEvent(b, { attempt: "00000000-0000-4000-8000-000000000000" }))
      expect(r.body).toMatchObject({ outcome: "unresolved" })
      expect((await receipts(b.s.shopId))[0]).toMatchObject({ outcome: "unresolved", reason: "subscription_unbound" })
      expect((await acct(b.s.shopId)).state).toBe("checkout_pending")
      const garbage = await deliver(subEvent(b, { attempt: "not-a-uuid" }))
      expect(garbage.body).toMatchObject({ outcome: "unresolved" })
      expect(await evidence(b.s.shopId)).toHaveLength(0)
    })
    it("another workspace's attempt id cannot bind a subscription to this customer", async () => {
      const a = await bound()
      const c = await bound()
      const r = await deliver(subEvent(c, { attempt: a.attemptId }))
      expect(r.body).toMatchObject({ outcome: "unresolved" })
      expect(await evidence(a.s.shopId)).toHaveLength(0)
      expect(await evidence(c.s.shopId)).toHaveLength(0)
      expect((await acct(a.s.shopId)).state).toBe("checkout_pending")
    })
    it("metadata naming a different shop is an integrity conflict that blocks the customer's shop and never touches the named one", async () => {
      const a = await bound()
      const c = await bound()
      const aBefore = await acct(a.s.shopId)
      const r = await deliver(subEvent(c, { metaShop: a.s.shopId }))
      expect(r.body).toMatchObject({ outcome: "refused" })
      expect(await acct(a.s.shopId)).toEqual(aBefore)
      expect(await acct(c.s.shopId)).toMatchObject({ state: "reconciliation_required", state_reason: "tenant_conflict" })
      expect(await evidence(c.s.shopId)).toHaveLength(0)
    })
    it("a customer id bound to one workspace can never be bound to another (database uniqueness)", async () => {
      const a = await bound()
      const c = await bound({ customer: false })
      const r = await db.rpc("commercial_checkout_bind_customer", { p_shop: c.s.shopId, p_actor: c.s.ownerId, p_attempt: c.attemptId, p_customer: a.customerId })
      expect(r.error).not.toBeNull()
    })
  })

  describe("checkout completion alone is never active", () => {
    it("a completed Checkout is recorded as completed-unverified and activation stays blocked", async () => {
      const b = await bound()
      const r = await deliver(envelope("checkout.session.completed", { id: b.sessionId, object: "checkout.session", livemode: false, mode: "subscription", customer: b.customerId, subscription: b.sub }))
      expect(r.body).toMatchObject({ outcome: "observed" })
      expect(await acct(b.s.shopId)).toMatchObject({ state: "checkout_pending", state_reason: "checkout_completed_awaiting_evidence" })
      expect((await one<{ status: string }>("commercial_checkout_attempts", b.s.shopId, "created_at"))[0].status).toBe("completed_unverified")
      expect(await evidence(b.s.shopId)).toHaveLength(0)
      expect(await activate(b)).toMatchObject({ outcome: "blocked", code: "billing_not_active" })
      expect(await gate(b.s.shopId)).toMatchObject({ allowed: false })
    })
    it("an expired session reopens Checkout; an unknown session is unresolved; a customer mismatch blocks", async () => {
      const b = await bound()
      expect((await deliver(envelope("checkout.session.expired", { id: b.sessionId, object: "checkout.session", livemode: false, mode: "subscription", customer: b.customerId }))).body).toMatchObject({ outcome: "observed" })
      expect(await acct(b.s.shopId)).toMatchObject({ state: "checkout_required", state_reason: "checkout_expired" })
      const stray = await deliver(envelope("checkout.session.completed", { id: "cs_test_NoSuchSession1", object: "checkout.session", livemode: false, mode: "subscription" }))
      expect(stray.body).toMatchObject({ outcome: "unresolved" })
      const m = await bound()
      const mismatch = await deliver(envelope("checkout.session.completed", { id: m.sessionId, object: "checkout.session", livemode: false, mode: "subscription", customer: "cus_SomebodyElse1" }))
      expect(mismatch.body).toMatchObject({ outcome: "refused" })
      expect(await lastReason(m.s.shopId)).toBe("session_binding_mismatch")
      expect(await acct(m.s.shopId)).toMatchObject({ state: "reconciliation_required", state_reason: "session_binding_mismatch" })
    })
    it("a completion that arrives AFTER the subscription evidence does not regress the account", async () => {
      const b = await bound()
      await deliver(subEvent(b, { created: NOW_S - 50 }))
      expect((await acct(b.s.shopId)).state).toBe("active")
      await deliver(envelope("checkout.session.completed", { id: b.sessionId, object: "checkout.session", livemode: false, mode: "subscription", customer: b.customerId, subscription: b.sub }))
      expect((await acct(b.s.shopId)).state).toBe("active")
    })
  })

  describe("subscription lifecycle is deterministic", () => {
    it("active evidence with a verified period makes the account active and lets the existing activation proceed", async () => {
      const b = await bound()
      expect(await activate(b)).toMatchObject({ outcome: "blocked", code: "billing_not_active" })
      const r = await deliver(subEvent(b, { type: "customer.subscription.created" }))
      expect(r.body).toMatchObject({ outcome: "applied" })
      expect(await acct(b.s.shopId)).toMatchObject({ state: "active", state_reason: null })
      expect(await periods(b.s.shopId)).toHaveLength(1)
      expect(await gate(b.s.shopId)).toEqual({ allowed: true, mode: "commercial" })
      expect(await activate(b)).toMatchObject({ outcome: "activated" })
    })
    it("each provider status maps to exactly one finite state and only active allows new work", async () => {
      const cases: [string, string][] = [
        ["past_due", "past_due"], ["incomplete", "incomplete"], ["incomplete_expired", "incomplete"], ["canceled", "canceled"],
        ["unpaid", "unknown"], ["paused", "unknown"], ["trialing", "unknown"],
      ]
      for (const [status, state] of cases) {
        const b = await bound()
        await deliver(subEvent(b, { status, canceledAt: status === "canceled" ? NOW_S - 5 : null }))
        const a = await acct(b.s.shopId)
        expect(a.state, status).toBe(state)
        expect(await gate(b.s.shopId), status).toMatchObject({ allowed: false })
        expect(await activate(b), status).toMatchObject({ outcome: "blocked", code: "billing_not_active" })
      }
    })
    it("an active signed event with no verified period is NOT active", async () => {
      const b = await bound()
      await deliver(subEvent(b, { noPeriod: true }))
      expect(await acct(b.s.shopId)).toMatchObject({ state: "reconciliation_required", state_reason: "period_unverified" })
      expect(await gate(b.s.shopId)).toMatchObject({ allowed: false, reason: "period_unverified" })
    })
    it("a wrong price, wrong quantity or wrong catalog is reconciliation_required, never active, and is sticky until reviewed", async () => {
      for (const o of [{ lookup: "gradia_other_price" }, { qty: 2 }]) {
        const b = await bound()
        await deliver(subEvent(b, { ...o, created: NOW_S - 100 }))
        expect(await acct(b.s.shopId)).toMatchObject({ state: "reconciliation_required", state_reason: "catalog_mismatch" })
        // A later, correct, newer webhook cannot clear an integrity block...
        const later = await deliver(subEvent(b, { created: NOW_S - 10 }))
        expect(later.body).toMatchObject({ outcome: "not_current" })
      expect(await lastReason(b.s.shopId)).toBe("blocked_pending_review")
        expect(await acct(b.s.shopId)).toMatchObject({ state: "reconciliation_required", state_reason: "catalog_mismatch" })
        expect(await periods(b.s.shopId)).toHaveLength(0)
        // ...only a reviewed reconciliation can.
        const cleared = await db.rpc("commercial_subscription_apply_evidence", {
          p_shop: b.s.shopId, p_subscription: b.sub, p_customer: b.customerId, p_status: "active", p_catalog_version: COMMERCIAL_CATALOG_VERSION,
          p_plan_key: "founder-pilot", p_lookup_key: FOUNDER_PILOT_PRICE.lookupKey, p_source: "reviewed_reconciliation", p_event_id: evId(),
          p_event_created_at: new Date().toISOString(), p_livemode: false,
        })
        expect(cleared.error).toBeNull()
        expect((await acct(b.s.shopId)).state).toBe("active")
      }
    })
    it("a second live subscription forces reconciliation (no silent duplicate) and stays blocked", async () => {
      const b = await bound()
      await deliver(subEvent(b, { created: NOW_S - 100 }))
      await deliver(subEvent(b, { sub: `sub_E1dup${uniq()}`, created: NOW_S - 50 }))
      expect(await acct(b.s.shopId)).toMatchObject({ state: "reconciliation_required", state_reason: "duplicate_subscription" })
      const rec = await deliver(subEvent(b, { created: NOW_S - 5 })) // the original, still active, newer
      expect(rec.body).toMatchObject({ outcome: "not_current" })
      expect((await acct(b.s.shopId)).state).toBe("reconciliation_required")
      expect(await gate(b.s.shopId)).toMatchObject({ allowed: false })
    })
    it("canceled is terminal for its subscription; a late 'active' for it never revives it", async () => {
      const b = await bound()
      await deliver(subEvent(b, { created: NOW_S - 100 }))
      await deliver(subEvent(b, { type: "customer.subscription.deleted", status: "canceled", canceledAt: NOW_S - 40, created: NOW_S - 50 }))
      expect((await acct(b.s.shopId)).state).toBe("canceled")
      const late = await deliver(subEvent(b, { created: NOW_S - 10 }))
      expect(late.body).toMatchObject({ outcome: "not_current" })
      expect(await lastReason(b.s.shopId)).toBe("subscription_terminal")
      expect((await acct(b.s.shopId)).state).toBe("canceled")
      expect((await facts(b.s.shopId)).filter((f) => f.kind === "cancellation")).toHaveLength(1)
    })
    it("past_due recovers to active only through newer signed evidence", async () => {
      const b = await bound()
      await deliver(subEvent(b, { status: "past_due", created: NOW_S - 100 }))
      expect(await gate(b.s.shopId)).toMatchObject({ allowed: false, reason: "subscription_past_due" })
      await deliver(subEvent(b, { created: NOW_S - 50 }))
      expect(await gate(b.s.shopId)).toEqual({ allowed: true, mode: "commercial" })
    })
  })

  describe("out-of-order and same-instant events never regress newer evidence", () => {
    it("an older 'active' arriving after a newer 'past_due' is recorded but does not move the account", async () => {
      const b = await bound()
      await deliver(subEvent(b, { status: "past_due", created: NOW_S - 10 }))
      const old = await deliver(subEvent(b, { created: NOW_S - 500 }))
      expect(old.body).toMatchObject({ outcome: "not_current" })
      expect(await lastReason(b.s.shopId)).toBe("out_of_order")
      expect((await acct(b.s.shopId)).state).toBe("past_due")
      expect(await evidence(b.s.shopId)).toHaveLength(2)
      // The older period was still verified at its time, so it is kept as a verified period.
      expect(await periods(b.s.shopId)).toHaveLength(1)
    })
    it("same-instant events converge on the same state in either arrival order", async () => {
      const finals: string[] = []
      for (const order of [0, 1]) {
        const b = await bound()
        await deliver(subEvent(b, { created: NOW_S - 100 }))
        const tie = NOW_S - 50
        const pastDue = subEvent(b, { status: "past_due", created: tie })
        const canceled = subEvent(b, { type: "customer.subscription.deleted", status: "canceled", canceledAt: tie, created: tie })
        for (const e of order === 0 ? [pastDue, canceled] : [canceled, pastDue]) await deliver(e)
        finals.push((await acct(b.s.shopId)).state)
      }
      expect(finals).toEqual(["canceled", "canceled"])
    })
    it("an event about a non-current canceled subscription cannot move a live account", async () => {
      const b = await bound()
      await deliver(subEvent(b, { created: NOW_S - 100 }))
      const r = await deliver(subEvent(b, { sub: `sub_E1old${uniq()}`, status: "canceled", canceledAt: NOW_S - 1, created: NOW_S - 5 }))
      expect(r.body).toMatchObject({ outcome: "not_current" })
      expect(await lastReason(b.s.shopId)).toBe("other_subscription")
      expect((await acct(b.s.shopId)).state).toBe("active")
    })
  })

  describe("provider facts are recorded, never acted on", () => {
    it("payment failure, success, refund, credit note and scheduled cancellation are append-only facts with no state change and no money movement", async () => {
      const b = await bound()
      await deliver(subEvent(b, { created: NOW_S - 100 }))
      const before = await acct(b.s.shopId)
      const evBefore = await evidence(b.s.shopId)
      const invoice = { id: `in_E1${uniq()}`, object: "invoice", livemode: false, customer: b.customerId, subscription: b.sub, amount_due: 19900, amount_paid: 0, currency: "usd", attempt_count: 1 }
      expect((await deliver(envelope("invoice.payment_failed", invoice))).body).toMatchObject({ outcome: "recorded_fact", replayed: false })
      expect((await deliver(envelope("invoice.paid", { ...invoice, amount_due: 0, amount_paid: 19900 }))).body).toMatchObject({ outcome: "recorded_fact" })
      expect((await deliver(envelope("charge.refunded", { id: `ch_E1${uniq()}`, object: "charge", livemode: false, customer: b.customerId, invoice: invoice.id, amount_refunded: 5000, currency: "usd" }))).body).toMatchObject({ outcome: "recorded_fact" })
      expect((await deliver(envelope("credit_note.created", { id: `cn_E1${uniq()}`, object: "credit_note", livemode: false, customer: b.customerId, invoice: invoice.id, amount: 2500, currency: "usd" }))).body).toMatchObject({ outcome: "recorded_fact" })
      // Setting cancel_at_period_end records ONE scheduled-cancellation fact, not one per update.
      await deliver(subEvent(b, { cap: true, created: NOW_S - 50 }))
      await deliver(subEvent(b, { cap: true, created: NOW_S - 40 }))
      const rows = await facts(b.s.shopId)
      expect(rows.map((f) => f.kind).sort()).toEqual(["cancellation_scheduled", "credit_note", "payment_failed", "payment_succeeded", "refund"])
      expect(rows.find((f) => f.kind === "refund")?.amount_cents).toBe(5000)
      expect(rows.find((f) => f.kind === "credit_note")?.amount_cents).toBe(2500)
      // Nothing was decided: the account is still active, no settlement or adjustment exists.
      const after = await acct(b.s.shopId)
      expect(after.state).toBe("active")
      expect((await evidence(b.s.shopId)).length).toBe(evBefore.length + 2)
      expect(after.version).toBeGreaterThanOrEqual(before.version)
      expect(await one("commercial_settlements", b.s.shopId, "created_at")).toHaveLength(0)
      expect(await one("commercial_settlement_adjustments", b.s.shopId, "created_at")).toHaveLength(0)
    })
    it("a payment failure alone does not flip the account: the subscription status is the single truth", async () => {
      const b = await bound()
      await deliver(subEvent(b, { created: NOW_S - 100 }))
      await deliver(envelope("invoice.payment_failed", { id: `in_E1${uniq()}`, object: "invoice", livemode: false, customer: b.customerId, subscription: b.sub, amount_due: 19900, amount_paid: 0, currency: "usd", attempt_count: 3 }))
      expect((await acct(b.s.shopId)).state).toBe("active")
      expect(await gate(b.s.shopId)).toEqual({ allowed: true, mode: "commercial" })
    })
    it("facts for an unknown subscription are unresolved; a refund for an unknown customer resolves to nothing", async () => {
      const b = await bound()
      const unknownSub = await deliver(envelope("invoice.payment_failed", { id: `in_E1${uniq()}`, object: "invoice", livemode: false, customer: b.customerId, subscription: "sub_NeverSeen001", amount_due: 100, amount_paid: 0, currency: "usd" }))
      expect(unknownSub.body).toMatchObject({ outcome: "unresolved" })
      const stray = await deliver(envelope("charge.refunded", { id: `ch_E1${uniq()}`, object: "charge", livemode: false, customer: "cus_Stranger0001", invoice: null, amount_refunded: 100, currency: "usd" }))
      expect(stray.body).toMatchObject({ outcome: "unresolved" })
      expect(await facts(b.s.shopId)).toHaveLength(0)
    })
  })

  describe("lapse enforcement blocks NEW paid work without erasing anything", () => {
    it("a workspace with no commercial account is legacy and unchanged", async () => {
      const s = await newShop()
      expect(await gate(s.shopId)).toEqual({ allowed: true, mode: "legacy_no_commercial_account" })
    })
    it("an elapsed verified period with no newer evidence blocks as uncertain", async () => {
      const b = await bound()
      await deliver(subEvent(b, { start: NOW_S - 40 * DAY, ps: NOW_S - 40 * DAY, pe: NOW_S - 10 * DAY, created: NOW_S - 100 }))
      expect((await acct(b.s.shopId)).state).toBe("active")
      expect(await gate(b.s.shopId)).toMatchObject({ allowed: false, reason: "subscription_period_elapsed" })
    })
    it("a database read failure blocks (fail closed)", async () => {
      const broken = { rpc: async () => ({ data: null, error: { code: "XX000", message: "down" } }) } as unknown as SupabaseClient
      expect(await assessCommercialExecution(broken, "00000000-0000-4000-8000-000000000000")).toMatchObject({ allowed: false, reason: "billing_state_unavailable" })
    })
    it("agent entry points refuse to start new work when billing is not active, and nothing is deleted, disabled or revoked", async () => {
      const b = await bound()
      await deliver(subEvent(b, { created: NOW_S - 100 }))
      const agent = await newAgent(b.s.shopId, b.s.ownerId, true) // enabled by the service role
      const allowed = await runCustomAgent(db, agent as never)
      expect(allowed.reason).not.toMatch(/billing is not active/)
      await deliver(subEvent(b, { status: "past_due", created: NOW_S - 50 }))
      const evBefore = (await evidence(b.s.shopId)).length
      const blocked = await runCustomAgent(db, agent as never)
      expect(blocked).toMatchObject({ fired: false })
      expect(blocked.reason).toMatch(/billing is not active \(subscription_past_due\)/)
      const eventRun = await runEventRecipe(db, { id: b.s.shopId } as never, agent as never, { kind: "lead_created", payload: {} } as never)
      expect(eventRun.fired).toBe(false)
      expect(eventRun.reason).toMatch(/billing is not active/)
      // Nothing erased or revoked: the agent is still enabled, evidence is intact, the owner still reads billing.
      expect((await db.from("custom_agents").select("enabled").eq("id", agent.id).single()).data?.enabled).toBe(true)
      expect((await evidence(b.s.shopId)).length).toBe(evBefore)
      const owner = await ownerSessionClient(b.s.email, PW)
      expect((await owner.rpc("commercial_billing_read", { p_shop: b.s.shopId })).error).toBeNull()
      expect((await db.from("shop_memberships").select("active").eq("shop_id", b.s.shopId).eq("user_id", b.s.ownerId).single()).data?.active).toBe(true)
      // Recovery needs no manual step: newer active evidence reopens the gate.
      await deliver(subEvent(b, { created: NOW_S - 5 }))
      expect(await gate(b.s.shopId)).toEqual({ allowed: true, mode: "commercial" })
    })
  })

  describe("owner-only Customer Portal handoff", () => {
    const fakePortal = (fail = false) => {
      const calls: { customerId: string; returnUrl: string }[] = []
      const portal: PlatformPortalClient = {
        async createBillingPortalSession(input) {
          calls.push(input)
          if (fail) throw new Error("provider down")
          return { url: `https://billing.stripe.com/p/session/test_${uniq()}` }
        },
      }
      return { portal, calls, runtime: { ok: true, portal, returnOrigin: ORIGIN } as PortalRuntime }
    }

    it("a live owner gets a portal for the EXACT bound customer, in any billing state, with a server-built return URL", async () => {
      for (const status of ["active", "past_due", "canceled"]) {
        const b = await bound()
        await deliver(subEvent(b, { status, canceledAt: status === "canceled" ? NOW_S - 5 : null }))
        const fake = fakePortal()
        const r = await requestCommercialBillingPortal({ service: db, runtime: fake.runtime }, { shopId: b.s.shopId, actorId: b.s.ownerId })
        expect(r.ok, status).toBe(true)
        expect(fake.calls).toEqual([{ customerId: b.customerId, returnUrl: `${ORIGIN}/billing?billing_return=portal` }])
        const agentsTarget = await requestCommercialBillingPortal({ service: db, runtime: fake.runtime }, { shopId: b.s.shopId, actorId: b.s.ownerId, returnTarget: "agents" })
        expect(agentsTarget.ok).toBe(true)
        expect(fake.calls[1].returnUrl).toBe(`${ORIGIN}/agents?billing_return=portal`)
      }
    })
    it("managers, staff, revoked operators, other owners and strangers are refused and the provider is never called", async () => {
      const b = await bound()
      const manager = await newShop(), staff = await newShop(), revoked = await newShop(), other = await newShop(), stranger = await newShop()
      await addMember(b.s.shopId, manager, "manager")
      await addMember(b.s.shopId, staff, "staff")
      await addMember(b.s.shopId, revoked, "manager", false)
      const fake = fakePortal()
      for (const who of [manager, staff, revoked, other, stranger]) {
        const r = await requestCommercialBillingPortal({ service: db, runtime: fake.runtime }, { shopId: b.s.shopId, actorId: who.ownerId })
        expect(r).toEqual({ ok: false, reason: "owner_required" })
      }
      // Another shop's owner asking about THIS shop gets nothing, even though they own a real shop.
      expect(await requestCommercialBillingPortal({ service: db, runtime: fake.runtime }, { shopId: b.s.shopId, actorId: other.ownerId })).toEqual({ ok: false, reason: "owner_required" })
      expect(fake.calls).toHaveLength(0)
    })
    it("fails closed without a bound customer, without configuration, on a provider failure and on a bad target", async () => {
      const noCustomer = await bound({ customer: false })
      const fake = fakePortal()
      expect(await requestCommercialBillingPortal({ service: db, runtime: fake.runtime }, { shopId: noCustomer.s.shopId, actorId: noCustomer.s.ownerId })).toEqual({ ok: false, reason: "no_platform_customer" })
      const bare = await newShop()
      expect(await requestCommercialBillingPortal({ service: db, runtime: fake.runtime }, { shopId: bare.shopId, actorId: bare.ownerId })).toEqual({ ok: false, reason: "no_platform_customer" })
      const b = await bound()
      expect(await requestCommercialBillingPortal({ service: db, runtime: { ok: false, reason: "billing_unconfigured" } }, { shopId: b.s.shopId, actorId: b.s.ownerId })).toEqual({ ok: false, reason: "billing_unconfigured" })
      expect(await requestCommercialBillingPortal({ service: db, runtime: { ok: true, portal: fake.portal, returnOrigin: null } }, { shopId: b.s.shopId, actorId: b.s.ownerId })).toEqual({ ok: false, reason: "return_origin_unconfigured" })
      expect(await requestCommercialBillingPortal({ service: db, runtime: fakePortal(true).runtime }, { shopId: b.s.shopId, actorId: b.s.ownerId })).toEqual({ ok: false, reason: "portal_unavailable" })
      expect(await requestCommercialBillingPortal({ service: db, runtime: fake.runtime }, { shopId: b.s.shopId, actorId: b.s.ownerId, returnTarget: "https://evil.example" as never })).toEqual({ ok: false, reason: "billing_state_unavailable" })
      expect(fake.calls).toHaveLength(0)
    })
    it("the portal URL is never stored anywhere in the commercial tables", async () => {
      const b = await bound()
      await deliver(subEvent(b))
      const fake = fakePortal()
      const r = await requestCommercialBillingPortal({ service: db, runtime: fake.runtime }, { shopId: b.s.shopId, actorId: b.s.ownerId })
      expect(r.ok).toBe(true)
      const everything = JSON.stringify([
        await one("commercial_billing_events", b.s.shopId), await one("commercial_billing_accounts", b.s.shopId, "shop_id"),
        await one("commercial_subscription_evidence", b.s.shopId), await receipts(b.s.shopId),
      ])
      expect(everything).not.toMatch(/billing\.stripe\.com|https?:/)
      expect((await one<{ kind: string }>("commercial_billing_events", b.s.shopId, "shop_seq")).some((e) => e.kind === "portal_session_requested")).toBe(true)
    })
  })

  describe("settlement binds to the exact verified Stripe subscription period", () => {
    const P1 = { s: utc(2026, 6, 1), e: utc(2026, 7, 1) }
    const P2 = { s: utc(2026, 7, 1), e: utc(2026, 8, 1) }
    const P3 = { s: utc(2026, 8, 1), e: utc(2026, 9, 1) }
    const iso = (sec: number) => new Date(sec * 1000).toISOString()
    const win = (p: { s: number; e: number }) => ({ windowStart: iso(p.s), windowEnd: iso(p.e) })
    const blocksFor = async (b: Bound, p: { windowStart: string; windowEnd: string }) => {
      const owner = await ownerSessionClient(b.s.email, PW)
      const r = await previewCommercialSettlement(owner, { shopId: b.s.shopId, ...p })
      return r.status === "blocked" ? r.blocks : []
    }
    const period = (b: Bound, p: { s: number; e: number }, created: number, start = P1.s) =>
      deliver(subEvent(b, { start, ps: p.s, pe: p.e, created }))

    it("only the exact period is verified; a calendar-aligned window that is not the period is not", async () => {
      const b = await bound()
      await period(b, P1, NOW_S - 100)
      expect(await blocksFor(b, win(P1))).not.toContain("subscription_period_not_verified")
      for (const other of [
        { windowStart: iso(P1.s + 3600), windowEnd: iso(P1.e) },
        { windowStart: iso(P1.s), windowEnd: iso(P1.e + DAY) },
        win({ s: utc(2026, 6, 2), e: utc(2026, 7, 2) }),
      ]) {
        expect(await blocksFor(b, other)).toContain("subscription_period_not_verified")
      }
    })
    it("a renewal extends a contiguous chain from the subscription's own start; a gap leaves history incomplete", async () => {
      const b = await bound()
      await period(b, P1, NOW_S - 300)
      await period(b, P2, NOW_S - 200)
      expect(await blocksFor(b, win(P2))).not.toContain("subscription_period_history_incomplete")
      expect(await blocksFor(b, win(P2))).not.toContain("subscription_period_not_verified")
      await period(b, P3, NOW_S - 100, P1.s)
      expect(await blocksFor(b, win(P3))).not.toContain("subscription_period_history_incomplete")
      const gap = await bound()
      await period(gap, P1, NOW_S - 300)
      await period(gap, P3, NOW_S - 100) // July was never verified
      expect(await blocksFor(gap, win(P3))).toContain("subscription_period_history_incomplete")
    })
    it("an overlapping period is a conflict that blocks the account and is never recorded", async () => {
      const b = await bound()
      await period(b, P1, NOW_S - 300)
      await deliver(subEvent(b, { start: P1.s, ps: P1.s + 10 * DAY, pe: P1.e + 10 * DAY, created: NOW_S - 100 }))
      expect(await acct(b.s.shopId)).toMatchObject({ state: "reconciliation_required", state_reason: "period_conflict" })
      expect(await periods(b.s.shopId)).toHaveLength(1)
      expect(await blocksFor(b, win(P1))).toContain("account_requires_reconciliation")
    })
    it("the database refuses to settle without a verified period even for a hand-built request", async () => {
      const b = await bound()
      await period(b, P1, NOW_S - 100)
      const base = {
        p_shop: b.s.shopId, p_actor: b.s.ownerId, p_catalog_version: APPROVED_COMMERCIAL_CATALOG_VERSION, p_plan_key: "founder-pilot",
        p_as_of: iso(utc(2026, 9, 2)), p_evidence_digest: "a".repeat(64), p_document: { state: "ok" }, p_document_digest: "b".repeat(64),
        p_mapping_version: "e1-fixture", p_deliveries: [], p_idempotency_key: `cset.v1.${"c".repeat(40)}`,
      }
      for (const w of [{ s: utc(2026, 6, 2), e: utc(2026, 7, 2) }, { s: utc(2026, 8, 1), e: utc(2026, 9, 1) }, { s: P1.s, e: P1.e + DAY }]) {
        const r = await db.rpc("commercial_settlement_begin", { ...base, p_window_start: iso(w.s), p_window_end: iso(w.e) })
        expect(r.error?.code).toBe("CB422")
      }
      expect(await one("commercial_settlements", b.s.shopId, "created_at")).toHaveLength(0)
    })
    it("a first period must begin at the subscription start (first activation)", async () => {
      const b = await bound()
      // Period 2 only, whose subscription started in June: no earlier period exists.
      await period(b, P2, NOW_S - 100, P1.s)
      expect(await blocksFor(b, win(P2))).toContain("subscription_period_history_incomplete")
    })
  })

  describe("late evidence becomes a signed append-only adjustment contract (never a rewrite, never applied)", () => {
    const makeSettlement = async (b: Bound) => {
      const key = `cset.v1.${uniq()}${"x".repeat(20)}`
      const r = await sql(`INSERT INTO public.commercial_settlements (shop_id, catalog_version, plan_key, window_start, window_end, as_of,
        evidence_digest, document_digest, document, base_cents, seat_cents, usage_cents, usage_cap_cents, total_cents, mapping_version,
        stripe_customer_id, account_version, requested_by, idempotency_key)
        VALUES ('${b.s.shopId}','${APPROVED_COMMERCIAL_CATALOG_VERSION}','founder-pilot','2026-08-01Z','2026-09-01Z','2026-09-02Z',
        repeat('a',64), repeat('b',64), '{}'::jsonb, 19900, 0, 0, 10000, 19900, 'e1-fixture', '${b.customerId}', 1, '${b.s.ownerId}', '${key}') RETURNING id`)
      expect(r.ok, r.message).toBe(true)
      return (r.rows as { id: string }[])[0].id
    }
    const propose = (shopId: string, settlement: string, patch: Record<string, unknown> = {}) =>
      db.rpc("commercial_adjustment_propose", {
        p_shop: shopId, p_settlement: settlement, p_kind: "late_usage_evidence", p_signed_amount_cents: -300,
        p_reason_code: "late_outcome_correction", p_evidence_fact: null, p_idempotency_key: `adj.v1.${"k".repeat(24)}`,
        p_proposed_by: "system_reconciliation", ...patch,
      })

    it("proposes a signed adjustment for the NEXT invoice, replays exactly, and conflicts on a changed replay", async () => {
      const b = await bound()
      const st = await makeSettlement(b)
      const key = `adj.v1.${uniq()}${"k".repeat(12)}`
      const first = await propose(b.s.shopId, st, { p_idempotency_key: key })
      expect(first.error).toBeNull()
      expect(first.data).toMatchObject({ action: "created", status: "pending_review" })
      const replay = await propose(b.s.shopId, st, { p_idempotency_key: key })
      expect(replay.data).toMatchObject({ action: "replay", adjustment_id: (first.data as { adjustment_id: string }).adjustment_id })
      const changed = await propose(b.s.shopId, st, { p_idempotency_key: key, p_signed_amount_cents: -301 })
      expect(changed.error?.code).toBe("CB409")
      const [row] = await one<{ signed_amount_cents: number; target_period_start: string; currency: string }>("commercial_settlement_adjustments", b.s.shopId, "created_at")
      expect(Number(row.signed_amount_cents)).toBe(-300)
      expect(Date.parse(row.target_period_start)).toBe(Date.parse("2026-09-01T00:00:00Z")) // = the settled window's end
      expect(row.currency).toBe("usd")
    })
    it("refuses a zero amount, an unsettled period, another workspace's settlement and another workspace's fact", async () => {
      const b = await bound()
      const other = await bound()
      const st = await makeSettlement(b)
      expect((await propose(b.s.shopId, st, { p_signed_amount_cents: 0, p_idempotency_key: `adj.v1.${uniq()}zero${"z".repeat(12)}` })).error).not.toBeNull()
      expect((await propose(b.s.shopId, "00000000-0000-4000-8000-000000000000", { p_idempotency_key: `adj.v1.${uniq()}nost${"z".repeat(12)}` })).error?.code).toBe("CB422")
      expect((await propose(other.s.shopId, st, { p_idempotency_key: `adj.v1.${uniq()}xten${"z".repeat(12)}` })).error?.code).toBe("CB422")
      await deliver(subEvent(other, { created: NOW_S - 100 }))
      await deliver(envelope("charge.refunded", { id: `ch_E1${uniq()}`, object: "charge", livemode: false, customer: other.customerId, invoice: null, amount_refunded: 100, currency: "usd" }))
      const [foreignFact] = await facts(other.s.shopId).then(async () => one<{ id: string }>("commercial_provider_facts", other.s.shopId))
      expect((await propose(b.s.shopId, st, { p_evidence_fact: foreignFact.id, p_idempotency_key: `adj.v1.${uniq()}fact${"z".repeat(12)}` })).error?.code).toBe("22023")
      expect(await one("commercial_settlement_adjustments", b.s.shopId, "created_at")).toHaveLength(0)
    })
    it("records exactly one human decision per adjustment; there is no applied state and the settlement never changes", async () => {
      const b = await bound()
      const st = await makeSettlement(b)
      const a = await propose(b.s.shopId, st, { p_idempotency_key: `adj.v1.${uniq()}rev${"r".repeat(12)}` })
      const id = (a.data as { adjustment_id: string }).adjustment_id
      const settlementBefore = (await db.from("commercial_settlements").select("*").eq("id", st).single()).data
      expect((await db.rpc("commercial_adjustment_review", { p_shop: b.s.shopId, p_adjustment: id, p_decision: "applied", p_reviewer_ref: "reviewer:abcdefgh" })).error?.code).toBe("22023")
      expect((await db.rpc("commercial_adjustment_review", { p_shop: b.s.shopId, p_adjustment: id, p_decision: "approved", p_reviewer_ref: "someone@example.com" })).error).not.toBeNull()
      const ok = await db.rpc("commercial_adjustment_review", { p_shop: b.s.shopId, p_adjustment: id, p_decision: "approved", p_reviewer_ref: "reviewer:abcdefgh", p_note: "checked the invoice" })
      expect(ok.data).toMatchObject({ action: "recorded", decision: "approved" })
      expect((await db.rpc("commercial_adjustment_review", { p_shop: b.s.shopId, p_adjustment: id, p_decision: "approved", p_reviewer_ref: "reviewer:abcdefgh" })).data).toMatchObject({ action: "replay" })
      expect((await db.rpc("commercial_adjustment_review", { p_shop: b.s.shopId, p_adjustment: id, p_decision: "rejected", p_reviewer_ref: "reviewer:abcdefgh" })).error?.code).toBe("CB409")
      expect((await db.rpc("commercial_adjustment_review", { p_shop: b.s.shopId, p_adjustment: id, p_decision: "approved", p_reviewer_ref: "reviewer:otherrev1" })).error?.code).toBe("CB409")
      const owner = await ownerSessionClient(b.s.email, PW)
      const read = await owner.rpc("commercial_adjustment_read", { p_shop: b.s.shopId })
      expect(read.error).toBeNull()
      expect(JSON.stringify(read.data)).toContain('"status":"approved"')
      expect(JSON.stringify(read.data)).not.toContain("applied")
      expect((await db.from("commercial_settlements").select("*").eq("id", st).single()).data).toEqual(settlementBefore)
      // Nothing applied it: no line, no event, no provider state, the account is untouched.
      expect(await one("commercial_settlement_lines", b.s.shopId, "id")).toHaveLength(0)
    })
    it("late provider facts never rewrite a settlement and never create an adjustment by themselves", async () => {
      const b = await bound()
      await deliver(subEvent(b, { created: NOW_S - 100 }))
      const st = await makeSettlement(b)
      const before = (await db.from("commercial_settlements").select("*").eq("id", st).single()).data
      await deliver(envelope("charge.refunded", { id: `ch_E1${uniq()}`, object: "charge", livemode: false, customer: b.customerId, invoice: null, amount_refunded: 4900, currency: "usd" }))
      expect((await db.from("commercial_settlements").select("*").eq("id", st).single()).data).toEqual(before)
      expect(await one("commercial_settlement_adjustments", b.s.shopId, "created_at")).toHaveLength(0)
    })
    it("the adjustment tables are append-only for every role including the table owner", async () => {
      const b = await bound()
      const st = await makeSettlement(b)
      const a = await propose(b.s.shopId, st, { p_idempotency_key: `adj.v1.${uniq()}imm${"i".repeat(12)}` })
      const id = (a.data as { adjustment_id: string }).adjustment_id
      for (const q of [
        `UPDATE public.commercial_settlement_adjustments SET signed_amount_cents = 1 WHERE id='${id}'`,
        `DELETE FROM public.commercial_settlement_adjustments WHERE id='${id}'`,
        `TRUNCATE public.commercial_settlement_adjustments`,
        `UPDATE public.commercial_provider_facts SET amount_cents = 1`,
        `DELETE FROM public.commercial_webhook_receipts`,
        `UPDATE public.commercial_subscription_periods SET period_end = period_end`,
        `UPDATE public.commercial_webhook_receipts SET outcome = 'applied'`,
      ]) {
        const r = await sql(q)
        expect(r.ok, q).toBe(false)
      }
    })
  })

  describe("authority, grants and immutability", () => {
    it("browser roles cannot execute any new writer or gate, and cannot read or write the new tables", async () => {
      const b = await bound()
      const owner = await ownerSessionClient(b.s.email, PW)
      const stranger = await newShop()
      const outsider = await ownerSessionClient(stranger.email, PW)
      const args = {
        commercial_webhook_ingest: { p_event_id: "evt_browser0001", p_event_type: "customer.subscription.updated", p_event_created: new Date().toISOString(), p_payload_digest: "a".repeat(64), p_livemode: false, p_facts: {} },
        commercial_execution_gate: { p_shop: b.s.shopId },
        commercial_portal_authorize: { p_shop: b.s.shopId, p_actor: b.s.ownerId, p_return_target: "billing" },
        commercial_adjustment_propose: { p_shop: b.s.shopId, p_settlement: b.s.shopId, p_kind: "correction", p_signed_amount_cents: -1, p_reason_code: "nope_nope", p_evidence_fact: null, p_idempotency_key: "adj.v1.browser00000000", p_proposed_by: "system_reconciliation" },
        commercial_adjustment_review: { p_shop: b.s.shopId, p_adjustment: b.s.shopId, p_decision: "approved", p_reviewer_ref: "reviewer:browser01" },
        commercial_subscription_period_status: { p_shop: b.s.shopId, p_start: "2026-01-01T00:00:00Z", p_end: "2026-02-01T00:00:00Z" },
        commercial_subscription_apply_evidence: {
          p_shop: b.s.shopId, p_subscription: "sub_BrowserAsserted", p_customer: b.customerId, p_status: "active", p_catalog_version: COMMERCIAL_CATALOG_VERSION,
          p_plan_key: "founder-pilot", p_lookup_key: FOUNDER_PILOT_PRICE.lookupKey, p_source: "signed_webhook", p_event_id: "evt_browser_claim",
          p_event_created_at: new Date().toISOString(), p_livemode: false,
        },
      } as const
      for (const [name, params] of Object.entries(args)) {
        for (const [who, client] of [["owner", owner], ["other owner", outsider], ["anon", anon]] as const) {
          const r = await client.rpc(name, params)
          expect(r.error, `${who} must not execute ${name}`).not.toBeNull()
          expect(["42501", "PGRST202"]).toContain(r.error!.code)
        }
      }
      for (const table of TABLES) {
        for (const client of [owner, anon]) {
          const read = await client.from(table).select("*").limit(1)
          expect(read.data ?? []).toHaveLength(0)
          expect(read.error?.code === "42501" || read.error?.code === "PGRST205" || (read.data ?? []).length === 0).toBe(true)
          const write = await client.from(table).insert({ shop_id: b.s.shopId })
          expect(write.error).not.toBeNull()
        }
        // The service role has SELECT only: it cannot write the tables directly.
        const direct = await db.from(table).insert({ shop_id: b.s.shopId })
        expect(direct.error, table).not.toBeNull()
      }
      expect((await one("commercial_subscription_evidence", b.s.shopId)).filter((e) => (e as { source_event_id: string }).source_event_id === "evt_browser_claim")).toHaveLength(0)
    })
    it("only the live owner reads adjustment facts, tenant-bound", async () => {
      const b = await bound()
      const manager = await newShop()
      await addMember(b.s.shopId, manager, "manager")
      const mgr = await ownerSessionClient(manager.email, PW)
      const other = await bound()
      const otherOwner = await ownerSessionClient(other.s.email, PW)
      for (const client of [mgr, otherOwner, anon]) {
        const r = await client.rpc("commercial_adjustment_read", { p_shop: b.s.shopId })
        expect(r.error?.code).toBe("42501")
      }
      const owner = await ownerSessionClient(b.s.email, PW)
      expect((await owner.rpc("commercial_adjustment_read", { p_shop: b.s.shopId })).error).toBeNull()
    })
    it("event details and receipts can never carry a URL or a key-shaped value", async () => {
      const b = await bound()
      const r = await db.rpc("commercial_billing_emit", { p_shop: b.s.shopId, p_kind: "portal_session_requested", p_attempt: null, p_actor: null, p_state: "active", p_details: { u: "https://billing.stripe.com/x" } })
      expect(r.error).not.toBeNull()
      const bad = await sql(`INSERT INTO public.commercial_webhook_receipts (event_id,event_type,event_created_at,payload_digest,livemode,outcome) VALUES ('evt_live000001','x.yy',now(),repeat('a',64),true,'applied')`)
      expect(bad.ok).toBe(false)
    })
  })
})
