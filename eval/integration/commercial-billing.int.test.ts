import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

import { authorizeAgentActivation } from "@/lib/agent-os/activation"
import { APPROVED_COMMERCIAL_CATALOG_VERSION } from "@/lib/approved-commercial-catalog"
import { COMMERCIAL_CATALOG_VERSION, FOUNDER_PILOT_PRICE } from "@/lib/commercial-billing"
import {
  readBillingSnapshot,
  readCommercialBillingDto,
  requestFounderPilotCheckout,
  type BillingRuntime,
} from "@/lib/commercial-billing-service"
import { StripeError } from "@/lib/stripe"
import type { PlatformCheckoutSession, PlatformStripeClient, PriceVerification } from "@/lib/stripe-commercial"
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
const TABLES = [
  "commercial_billing_accounts",
  "commercial_checkout_attempts",
  "commercial_billing_events",
  "commercial_subscription_evidence",
] as const
const ORIGIN = "https://app.gradia.example"

let db: SupabaseClient
const seeded: Seeded[] = []
let shop: Seeded, other: Seeded, manager: Seeded, staff: Seeded, revoked: Seeded, stranger: Seeded
let owner: SupabaseClient, otherOwner: SupabaseClient, mgr: SupabaseClient, stf: SupabaseClient, rev: SupabaseClient, anon: SupabaseClient

let seq = 0
const uniq = () => `${Date.now().toString(36)}${(++seq).toString(36)}`

// The local gateway occasionally reuses a keep-alive connection PostgREST has just
// closed ("Connection reset by peer" -> 502). That is harness transport noise, not
// product behaviour, so fixture creation (only) retries it.
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

// ---------- A fake platform Stripe client that behaves like Stripe's idempotency ----------
type FakeOpts = {
  price?: () => Promise<PriceVerification>
  customer?: () => Promise<void>
  session?: () => Promise<void>
}
function fakeStripe(opts: FakeOpts = {}) {
  const calls = { price: 0, customer: 0, sessionCreate: 0, retrieve: 0 }
  const customers = new Map<string, string>() // idempotency key -> customer
  const sessions = new Map<string, { id: string; attemptId: string; shopId: string; customerId: string; status: "open" | "complete" | "expired"; successUrl: string; cancelUrl: string }>()
  const byKey = new Map<string, string>()
  const received: { customerKeys: string[]; sessionKeys: string[]; lastSession?: { shopId: string; attemptId: string; successUrl: string; cancelUrl: string } } = { customerKeys: [], sessionKeys: [] }
  const toSession = (s: { id: string; status: "open" | "complete" | "expired" }): PlatformCheckoutSession => ({
    id: s.id,
    status: s.status,
    url: s.status === "open" ? `https://checkout.stripe.com/c/pay/${s.id}` : null,
  })
  const client: PlatformStripeClient = {
    async verifyFounderPilotPrice() {
      calls.price += 1
      return opts.price ? opts.price() : { ok: true, priceId: "price_fake_founder_pilot" }
    },
    async createCustomer({ idempotencyKey }) {
      calls.customer += 1
      received.customerKeys.push(idempotencyKey)
      if (opts.customer) await opts.customer()
      if (!customers.has(idempotencyKey)) customers.set(idempotencyKey, `cus_Fake${uniq().replace(/[^A-Za-z0-9]/g, "")}`)
      return { customerId: customers.get(idempotencyKey)! }
    },
    async createCheckoutSession(input) {
      calls.sessionCreate += 1
      received.sessionKeys.push(input.idempotencyKey)
      received.lastSession = { shopId: input.shopId, attemptId: input.attemptId, successUrl: input.successUrl, cancelUrl: input.cancelUrl }
      if (opts.session) await opts.session()
      const existing = byKey.get(input.idempotencyKey)
      if (existing) return toSession(sessions.get(existing)!)
      const id = `cs_test_Fake${uniq().replace(/[^A-Za-z0-9]/g, "")}`
      const record = { id, attemptId: input.attemptId, shopId: input.shopId, customerId: input.customerId, status: "open" as const, successUrl: input.successUrl, cancelUrl: input.cancelUrl }
      sessions.set(id, record)
      byKey.set(input.idempotencyKey, id)
      return toSession(record)
    },
    async retrieveCheckoutSession({ sessionId, binding }) {
      calls.retrieve += 1
      const s = sessions.get(sessionId)
      if (!s || s.shopId !== binding.shopId || s.attemptId !== binding.attemptId || s.customerId !== binding.customerId) {
        return { ok: false, code: "session_binding_mismatch" }
      }
      return { ok: true, session: toSession(s) }
    },
  }
  return {
    client,
    calls,
    received,
    sessions,
    runtime: { ok: true, stripe: client, returnOrigin: ORIGIN } as BillingRuntime,
    setStatus(status: "open" | "complete" | "expired") {
      for (const s of sessions.values()) s.status = status
    },
  }
}

const request = (fake: ReturnType<typeof fakeStripe>, s: Seeded, extra: { returnTarget?: "agents" | "billing"; actorId?: string } = {}) =>
  requestFounderPilotCheckout({ service: db, runtime: fake.runtime }, { shopId: s.shopId, actorId: extra.actorId ?? s.ownerId, returnTarget: extra.returnTarget })

async function rows<T = Record<string, unknown>>(table: string, shopId: string, order = "recorded_at"): Promise<T[]> {
  const r = await db.from(table).select("*").eq("shop_id", shopId).order(order)
  expect(r.error).toBeNull()
  return r.data as T[]
}
const attempts = (shopId: string) => rows<{ id: string; attempt_no: number; status: string; provider_session_id: string | null; failure_code: string | null; request_fingerprint: string; return_target: string }>("commercial_checkout_attempts", shopId, "attempt_no")
const events = (shopId: string) => rows<{ kind: string; shop_seq: number; details: Record<string, unknown>; state_after: string }>("commercial_billing_events", shopId, "shop_seq")
async function account(shopId: string) {
  const r = await db.from("commercial_billing_accounts").select("*").eq("shop_id", shopId).maybeSingle()
  expect(r.error).toBeNull()
  return r.data as { state: string; state_reason: string | null; platform_customer_id: string | null; catalog_version: string; current_attempt_id: string | null; version: number } | null
}

let eventSeq = 0
async function applyEvidence(s: Seeded, patch: Partial<{
  subscription: string; customer: string; status: string; catalog: string; plan: string; lookup: string
  source: string; eventId: string; createdAt: string; livemode: boolean; attempt: string | null
}> = {}) {
  const acct = await account(s.shopId)
  eventSeq += 1
  return db.rpc("commercial_subscription_apply_evidence", {
    p_shop: s.shopId,
    p_subscription: patch.subscription ?? "sub_FakeSubscription1",
    p_customer: patch.customer ?? acct?.platform_customer_id ?? "cus_FakeCustomerX",
    p_status: patch.status ?? "active",
    p_catalog_version: patch.catalog ?? COMMERCIAL_CATALOG_VERSION,
    p_plan_key: patch.plan ?? "founder-pilot",
    p_lookup_key: patch.lookup ?? FOUNDER_PILOT_PRICE.lookupKey,
    p_source: patch.source ?? "signed_webhook",
    p_event_id: patch.eventId ?? `evt_fake_${uniq()}_${eventSeq}`,
    p_event_created_at: patch.createdAt ?? new Date(Date.now() - 60_000 + eventSeq * 1000).toISOString(),
    p_livemode: patch.livemode ?? false,
    p_attempt: patch.attempt ?? null,
  })
}

let agentSeq = 0
async function newAgent(shopId: string, ownerId: string, enabled = false): Promise<string> {
  // The service role (fixtures/operators) may seed an enabled row directly; the
  // browser/owner session may not (see the activation guard tests).
  const name = `Synthetic agent ${++agentSeq}`
  for (let i = 0; i < 4; i++) {
    const { data, error } = await db
      .from("custom_agents")
      .insert({ shop_id: shopId, owner_id: ownerId, name, problem_text: "Synthetic", config: {}, enabled })
      .select("id")
      .single()
    if (!error) return data!.id as string
    if (!/invalid response was received from the upstream server/i.test(error.message) || i === 3) expect(error).toBeNull()
    await new Promise((r) => setTimeout(r, 250 * (i + 1)))
  }
  throw new Error("unreachable")
}
const agentEnabled = async (id: string) =>
  (await db.from("custom_agents").select("enabled").eq("id", id).single()).data?.enabled as boolean
const activeCount = async (shopId: string) =>
  (await db.from("custom_agents").select("id", { count: "exact", head: true }).eq("shop_id", shopId).eq("enabled", true)).count ?? 0

const activation = async (
  fake: ReturnType<typeof fakeStripe>,
  s: Seeded,
  sessionClient: SupabaseClient,
  patch: Partial<Parameters<typeof authorizeAgentActivation>[1]> = {}
) =>
  authorizeAgentActivation(
    { sessionClient, serviceClient: () => db, runtime: fake.runtime },
    {
      shopId: s.shopId,
      actorId: s.ownerId,
      agentId: patch.agentId ?? (await newAgent(s.shopId, s.ownerId)),
      existing: { ready: true },
      ...patch,
    }
  )

const maybe = INTEGRATION_WITH_SESSION ? describe : describe.skip

maybe("commercial billing state and Checkout handoff (PR C)", () => {
  beforeAll(async () => {
    db = serviceClient()
    anon = anonClient()
    shop = await newShop()
    other = await newShop()
    manager = await newShop()
    staff = await newShop()
    revoked = await newShop()
    stranger = await newShop()
    await addMember(shop.shopId, manager, "manager")
    await addMember(shop.shopId, staff, "staff")
    await addMember(shop.shopId, revoked, "manager", false) // a revoked operator
    owner = await ownerSessionClient(shop.email, PW)
    otherOwner = await ownerSessionClient(other.email, PW)
    mgr = await ownerSessionClient(manager.email, PW)
    stf = await ownerSessionClient(staff.email, PW)
    rev = await ownerSessionClient(revoked.email, PW)
  })

  afterAll(async () => {
    for (const s of seeded) await cleanup(db, s)
  })

  describe("authority", () => {
    it("a live workspace owner can request Checkout for that workspace", async () => {
      const fake = fakeStripe()
      const dto = await request(fake, shop)
      expect(dto).toMatchObject({ state: "checkout_pending", blockingReason: "checkout_required", eligibleToActivate: false })
      expect(dto.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.com\//)
    })

    it.each([
      ["manager", () => manager, "manager", true],
      ["staff", () => staff, "staff", true],
      ["a revoked operator", () => revoked, "manager", false],
      ["a user with no membership", () => stranger, null, true],
      ["another shop's owner", () => other, null, true],
    ] as const)("denies %s and creates nothing", async (_name, who, role, active) => {
      const target = await newShop()
      const fake = fakeStripe()
      if (role) await addMember(target.shopId, who(), role, active)
      const dto = await request(fake, target, { actorId: who().ownerId })
      expect(dto).toMatchObject({ blockingReason: "owner_required", eligibleToActivate: false, checkoutUrl: null })
      expect(fake.calls).toEqual({ price: 0, customer: 0, sessionCreate: 0, retrieve: 0 })
      expect(await attempts(target.shopId)).toHaveLength(0)
      expect(await account(target.shopId)).toBeNull()
    })

    it("denies an owner of ANOTHER workspace naming this workspace", async () => {
      const fake = fakeStripe()
      const dto = await request(fake, stranger, { actorId: other.ownerId })
      expect(dto.blockingReason).toBe("owner_required")
      expect(fake.calls.sessionCreate).toBe(0)
      expect(await account(stranger.shopId)).toBeNull()
    })

    it("denies an unknown/missing actor", async () => {
      const fake = fakeStripe()
      const dto = await request(fake, stranger, { actorId: "00000000-0000-4000-8000-00000000dead" })
      expect(dto.blockingReason).toBe("owner_required")
      expect(fake.calls.price).toBe(0)
    })

    it("browser roles cannot call any writer function", async () => {
      const args = {
        commercial_checkout_begin: { p_shop: shop.shopId, p_actor: shop.ownerId, p_catalog_version: COMMERCIAL_CATALOG_VERSION, p_plan_key: "founder-pilot", p_lookup_key: FOUNDER_PILOT_PRICE.lookupKey, p_return_target: "agents", p_fingerprint: "a".repeat(64) },
        commercial_checkout_bind_customer: { p_shop: shop.shopId, p_actor: shop.ownerId, p_attempt: shop.shopId, p_customer: "cus_FakeCustomerZ" },
        commercial_checkout_record_session: { p_shop: shop.shopId, p_actor: shop.ownerId, p_attempt: shop.shopId, p_session: "cs_test_FakeZ123" },
        commercial_checkout_reject: { p_shop: shop.shopId, p_actor: shop.ownerId, p_attempt: shop.shopId, p_code: "nope_nope" },
        commercial_checkout_mark_unknown: { p_shop: shop.shopId, p_actor: shop.ownerId, p_attempt: shop.shopId, p_code: "nope_nope" },
        commercial_checkout_observe: { p_shop: shop.shopId, p_actor: shop.ownerId, p_attempt: shop.shopId, p_observed: "complete" },
        commercial_subscription_apply_evidence: {
          p_shop: shop.shopId, p_subscription: "sub_FakeBrowser1", p_customer: "cus_FakeBrowser1", p_status: "active",
          p_catalog_version: COMMERCIAL_CATALOG_VERSION, p_plan_key: "founder-pilot", p_lookup_key: FOUNDER_PILOT_PRICE.lookupKey,
          p_source: "signed_webhook", p_event_id: "evt_browser_asserted", p_event_created_at: new Date().toISOString(), p_livemode: false, p_attempt: null,
        },
      } as const
      for (const [name, params] of Object.entries(args)) {
        for (const [who, client] of [["owner", owner], ["manager", mgr], ["staff", stf], ["anon", anon], ["other owner", otherOwner]] as const) {
          const r = await client.rpc(name, params)
          expect(r.error, `${who} must not execute ${name}`).not.toBeNull()
          expect(["42501", "PGRST202"]).toContain(r.error!.code)
        }
      }
      // And the claim "this is active" left no trace anywhere.
      expect((await rows("commercial_subscription_evidence", shop.shopId)).filter((e) => (e as { source_event_id: string }).source_event_id === "evt_browser_asserted")).toHaveLength(0)
    })

    it("browser roles have no table access: no select, insert, update or delete", async () => {
      for (const table of TABLES) {
        for (const [who, client] of [["owner", owner], ["manager", mgr], ["anon", anon]] as const) {
          const sel = await client.from(table).select("*").limit(1)
          expect(sel.error?.code, `${who} select ${table}`).toBe("42501")
          const ins = await client.from(table).insert({ shop_id: shop.shopId })
          expect(ins.error, `${who} insert ${table}`).not.toBeNull()
          const upd = await client.from(table).update({ shop_id: shop.shopId }).eq("shop_id", shop.shopId)
          expect(upd.error, `${who} update ${table}`).not.toBeNull()
          const del = await client.from(table).delete().eq("shop_id", shop.shopId)
          expect(del.error, `${who} delete ${table}`).not.toBeNull()
        }
      }
    })

    it("the service role is narrowly scoped: it reads, but cannot write tables directly", async () => {
      for (const table of TABLES) {
        expect((await db.from(table).select("*").limit(1)).error).toBeNull()
        expect((await db.from(table).insert({ shop_id: shop.shopId })).error?.code).toBe("42501")
        expect((await db.from(table).update({ shop_id: shop.shopId }).eq("shop_id", shop.shopId)).error?.code).toBe("42501")
        expect((await db.from(table).delete().eq("shop_id", shop.shopId)).error?.code).toBe("42501")
      }
    })

    it("only the live owner can read state; others and anonymous are refused", async () => {
      expect((await readBillingSnapshot(owner, shop.shopId)).ok).toBe(true)
      for (const [who, client] of [["manager", mgr], ["staff", stf], ["revoked", rev], ["anon", anon], ["other owner", otherOwner]] as const) {
        const read = await readBillingSnapshot(client, shop.shopId)
        expect(read, who).toEqual({ ok: false, reason: "forbidden" })
      }
    })
  })

  describe("Checkout creation", () => {
    it("creates one customer, one session and one local authority, bound to shop, catalog and attempt", async () => {
      const s = await newShop()
      const fake = fakeStripe()
      const dto = await request(fake, s)
      expect(dto.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.com\//)
      expect(fake.calls).toEqual({ price: 1, customer: 1, sessionCreate: 1, retrieve: 0 })

      const [attempt] = await attempts(s.shopId)
      expect(attempt).toMatchObject({ attempt_no: 1, status: "session_open" })
      const acct = (await account(s.shopId))!
      expect(acct).toMatchObject({ state: "checkout_pending", catalog_version: APPROVED_COMMERCIAL_CATALOG_VERSION, current_attempt_id: attempt.id })
      expect(acct.platform_customer_id).toMatch(/^cus_/)
      expect(acct.platform_customer_id).not.toMatch(/^acct_/)

      // Provider call identity is derived from LOCAL ids.
      expect(fake.received.sessionKeys).toEqual([`gradia-cb-session-${attempt.id}`])
      expect(fake.received.customerKeys).toEqual([`gradia-cb-customer-${s.shopId}`])
      expect(fake.received.lastSession).toMatchObject({ shopId: s.shopId, attemptId: attempt.id })
      // Return URLs are server-owned.
      expect(fake.received.lastSession!.successUrl).toBe(`${ORIGIN}/agents?billing_return=success`)
      expect(fake.received.lastSession!.cancelUrl).toBe(`${ORIGIN}/agents?billing_return=canceled`)

      expect((await events(s.shopId)).map((e) => e.kind)).toEqual(["account_opened", "checkout_attempt_started", "customer_bound", "session_created"])
    })

    it("creating a Checkout is not an active subscription", async () => {
      const s = await newShop()
      const fake = fakeStripe()
      await request(fake, s)
      const dto = await readCommercialBillingDto(await ownerSessionClient(s.email, PW), fake.runtime, s.shopId)
      expect(dto).toMatchObject({ state: "checkout_pending", eligibleToActivate: false })
      expect((await rows("commercial_subscription_evidence", s.shopId))).toHaveLength(0)
    })

    it("exact replays reuse the open session: no new customer, session or local authority", async () => {
      const s = await newShop()
      const fake = fakeStripe()
      const first = await request(fake, s)
      const replays = [await request(fake, s), await request(fake, s), await request(fake, s)]
      for (const r of replays) expect(r).toEqual(first)
      expect(fake.calls).toMatchObject({ price: 1, customer: 1, sessionCreate: 1, retrieve: 3 })
      expect(await attempts(s.shopId)).toHaveLength(1)
    })

    it("concurrent first requests create exactly one authority and one session", async () => {
      const s = await newShop()
      const fake = fakeStripe()
      const results = await Promise.all(Array.from({ length: 8 }, () => request(fake, s)))
      expect(fake.calls.customer).toBe(1)
      expect(fake.calls.sessionCreate).toBe(1)
      expect(await attempts(s.shopId)).toHaveLength(1)
      for (const r of results) {
        expect(r.state).toBe("checkout_pending")
        expect(["checkout_in_progress", "checkout_required"]).toContain(r.blockingReason)
        expect(r.eligibleToActivate).toBe(false)
      }
      const urls = new Set(results.map((r) => r.checkoutUrl).filter(Boolean))
      expect(urls.size).toBe(1)
      expect((await events(s.shopId)).filter((e) => e.kind === "session_created")).toHaveLength(1)
    })

    it("a changed request conflicts while one is in flight and creates nothing", async () => {
      const s = await newShop()
      const fake = fakeStripe()
      await request(fake, s, { returnTarget: "agents" })
      const changed = await request(fake, s, { returnTarget: "billing" })
      expect(changed).toMatchObject({ blockingReason: "checkout_conflict", eligibleToActivate: false, checkoutUrl: null })
      expect(fake.calls.sessionCreate).toBe(1)
      expect(await attempts(s.shopId)).toHaveLength(1)
    })

    it("the database itself refuses a second in-flight attempt", async () => {
      const s = await newShop()
      const fake = fakeStripe()
      await request(fake, s)
      const [open] = await attempts(s.shopId)
      const dup = await db.rpc("commercial_checkout_begin", {
        p_shop: s.shopId, p_actor: s.ownerId, p_catalog_version: COMMERCIAL_CATALOG_VERSION, p_plan_key: "founder-pilot",
        p_lookup_key: FOUNDER_PILOT_PRICE.lookupKey, p_return_target: "agents", p_fingerprint: open.request_fingerprint,
      })
      expect(dup.error).toBeNull()
      expect((dup.data as { action: string }).action).toBe("replay") // same request replays, never a second create
      const changed = await db.rpc("commercial_checkout_begin", {
        p_shop: s.shopId, p_actor: s.ownerId, p_catalog_version: COMMERCIAL_CATALOG_VERSION, p_plan_key: "founder-pilot",
        p_lookup_key: FOUNDER_PILOT_PRICE.lookupKey, p_return_target: "agents", p_fingerprint: "b".repeat(64),
      })
      expect(changed.error?.code).toBe("CB409")
      expect(await attempts(s.shopId)).toHaveLength(1)
    })

    it("an expired session is closed and replaced by a new attempt that reuses the bound customer", async () => {
      const s = await newShop()
      const fake = fakeStripe()
      const first = await request(fake, s)
      fake.setStatus("expired")
      const second = await request(fake, s)
      expect(second.checkoutUrl).not.toBeNull()
      expect(second.checkoutUrl).not.toBe(first.checkoutUrl)
      const list = await attempts(s.shopId)
      expect(list.map((a) => [a.attempt_no, a.status])).toEqual([[1, "expired"], [2, "session_open"]])
      expect(fake.calls.customer).toBe(1) // one platform customer per shop
      expect(fake.calls.sessionCreate).toBe(2)
    })

    it("a completed session is NOT payment proof and is never repeated", async () => {
      const s = await newShop()
      const fake = fakeStripe()
      await request(fake, s)
      fake.setStatus("complete")
      for (let i = 0; i < 3; i += 1) {
        const dto = await request(fake, s)
        expect(dto).toMatchObject({
          state: "checkout_pending",
          eligibleToActivate: false,
          blockingReason: "checkout_completed_awaiting_evidence",
          checkoutUrl: null,
        })
      }
      expect(fake.calls.sessionCreate).toBe(1)
      expect((await account(s.shopId))!.state).toBe("checkout_pending")
      expect((await attempts(s.shopId))[0].status).toBe("completed_unverified")
      expect((await rows("commercial_subscription_evidence", s.shopId))).toHaveLength(0)
      // The activation gate agrees.
      const decision = await activation(fake, s, await ownerSessionClient(s.email, PW))
      expect(decision).toMatchObject({ proceed: false, code: "checkout_completed_awaiting_evidence" })
    })

    it("a provider read failure on replay changes nothing and creates nothing", async () => {
      const s = await newShop()
      const fake = fakeStripe()
      await request(fake, s)
      const throwing = { ...fake.client, retrieveCheckoutSession: async () => { throw new StripeError(0, "down", "timeout") } }
      const dto = await requestFounderPilotCheckout({ service: db, runtime: { ok: true, stripe: throwing, returnOrigin: ORIGIN } }, { shopId: s.shopId, actorId: s.ownerId })
      expect(dto).toMatchObject({ state: "checkout_pending", blockingReason: "provider_unavailable", checkoutUrl: null })
      expect(await attempts(s.shopId)).toHaveLength(1)
      expect((await attempts(s.shopId))[0].status).toBe("session_open")
    })

    it("a session that is not bound to this shop/attempt is quarantined, not trusted", async () => {
      const s = await newShop()
      const fake = fakeStripe()
      await request(fake, s)
      const mismatching = { ...fake.client, retrieveCheckoutSession: async () => ({ ok: false as const, code: "session_binding_mismatch" as const }) }
      const dto = await requestFounderPilotCheckout({ service: db, runtime: { ok: true, stripe: mismatching, returnOrigin: ORIGIN } }, { shopId: s.shopId, actorId: s.ownerId })
      expect(dto).toMatchObject({ state: "reconciliation_required", blockingReason: "session_binding_mismatch", eligibleToActivate: false, checkoutUrl: null })
      expect((await attempts(s.shopId))[0].status).toBe("unknown")
    })
  })

  describe("ambiguous and rejected provider outcomes", () => {
    it("a Checkout Session timeout becomes reconciliation_required and is never retried blindly", async () => {
      const s = await newShop()
      const fake = fakeStripe({ session: async () => { throw new StripeError(0, "timed out", "timeout") } })
      const first = await request(fake, s)
      expect(first).toMatchObject({ state: "reconciliation_required", blockingReason: "session_outcome_unknown", eligibleToActivate: false, checkoutUrl: null })
      expect((await attempts(s.shopId))[0]).toMatchObject({ status: "unknown", failure_code: "session_outcome_unknown" })

      const before = { ...fake.calls }
      for (let i = 0; i < 3; i += 1) {
        const again = await request(fake, s)
        expect(again).toMatchObject({ state: "reconciliation_required", blockingReason: "session_outcome_unknown" })
      }
      expect(fake.calls).toEqual(before) // nothing was sent again
      expect(await attempts(s.shopId)).toHaveLength(1)
      expect((await events(s.shopId)).map((e) => e.kind)).toContain("provider_outcome_unknown")
    })

    it("a 5xx on session creation is ambiguous too", async () => {
      const s = await newShop()
      const fake = fakeStripe({ session: async () => { throw new StripeError(502, "bad gateway") } })
      expect(await request(fake, s)).toMatchObject({ state: "reconciliation_required" })
      expect(fake.calls.sessionCreate).toBe(1)
    })

    it("a customer-creation timeout is ambiguous and creates no session", async () => {
      const s = await newShop()
      const fake = fakeStripe({ customer: async () => { throw new StripeError(0, "timed out", "timeout") } })
      expect(await request(fake, s)).toMatchObject({ state: "reconciliation_required", blockingReason: "customer_outcome_unknown" })
      expect(fake.calls.sessionCreate).toBe(0)
      expect((await account(s.shopId))!.platform_customer_id).toBeNull()
      await request(fake, s)
      expect(fake.calls.customer).toBe(1)
    })

    it("a definitive provider rejection closes the attempt and a later attempt may proceed", async () => {
      const s = await newShop()
      let reject = true
      const fake = fakeStripe({ session: async () => { if (reject) throw new StripeError(400, "invalid request") } })
      const first = await request(fake, s)
      expect(first).toMatchObject({ state: "checkout_required", eligibleToActivate: false, checkoutUrl: null })
      expect((await attempts(s.shopId))[0]).toMatchObject({ status: "rejected", failure_code: "session_rejected" })
      reject = false
      const second = await request(fake, s)
      expect(second.checkoutUrl).not.toBeNull()
      expect((await attempts(s.shopId)).map((a) => a.status)).toEqual(["rejected", "session_open"])
    })

    it.each([
      ["a missing price", { ok: false, code: "price_missing" } as PriceVerification],
      ["a wrong amount", { ok: false, code: "price_amount_mismatch" } as PriceVerification],
      ["a wrong currency", { ok: false, code: "price_currency_mismatch" } as PriceVerification],
      ["a wrong interval", { ok: false, code: "price_interval_mismatch" } as PriceVerification],
      ["an inactive price", { ok: false, code: "price_inactive" } as PriceVerification],
      ["a lookup mismatch", { ok: false, code: "price_lookup_mismatch" } as PriceVerification],
    ])("%s fails closed before any customer or session exists", async (_name, verdict) => {
      const s = await newShop()
      const fake = fakeStripe({ price: async () => verdict })
      const dto = await request(fake, s)
      expect(dto).toMatchObject({ state: "checkout_required", blockingReason: "price_verification_failed", eligibleToActivate: false, checkoutUrl: null })
      expect(fake.calls.customer).toBe(0)
      expect(fake.calls.sessionCreate).toBe(0)
      expect((await attempts(s.shopId))[0]).toMatchObject({ status: "rejected", failure_code: (verdict as { code: string }).code })
    })

    it("an unreachable Price lookup (read-only) is not a billing failure and creates nothing", async () => {
      const s = await newShop()
      const fake = fakeStripe({ price: async () => { throw new StripeError(0, "down", "network_error") } })
      expect(await request(fake, s)).toMatchObject({ state: "checkout_required", blockingReason: "provider_unavailable" })
      expect(fake.calls.customer + fake.calls.sessionCreate).toBe(0)
    })

    it("unconfigured or misconfigured billing touches neither Stripe nor the database", async () => {
      const s = await newShop()
      for (const reason of ["billing_unconfigured", "billing_misconfigured"] as const) {
        const dto = await requestFounderPilotCheckout({ service: db, runtime: { ok: false, reason } }, { shopId: s.shopId, actorId: s.ownerId })
        expect(dto).toMatchObject({ state: "unconfigured", blockingReason: reason, eligibleToActivate: false, checkoutUrl: null })
      }
      const noOrigin = await requestFounderPilotCheckout(
        { service: db, runtime: { ok: true, stripe: fakeStripe().client, returnOrigin: null } },
        { shopId: s.shopId, actorId: s.ownerId }
      )
      expect(noOrigin).toMatchObject({ state: "unconfigured", blockingReason: "return_origin_unconfigured" })
      expect(await account(s.shopId)).toBeNull()
    })

    it("the same Stripe customer can never be bound to two workspaces", async () => {
      const a = await newShop()
      const b = await newShop()
      const fa = fakeStripe()
      await request(fa, a)
      const acctA = (await account(a.shopId))!
      // Workspace B starts a request, then tries to bind A's customer.
      const fb = fakeStripe({ session: async () => { throw new StripeError(0, "stop", "timeout") } })
      await request(fb, b)
      const [attemptB] = await attempts(b.shopId)
      const bound = await db.rpc("commercial_checkout_bind_customer", { p_shop: b.shopId, p_actor: b.ownerId, p_attempt: attemptB.id, p_customer: acctA.platform_customer_id })
      expect(bound.error).not.toBeNull()
      // Customer ids must look like platform customers, never a connected account.
      const connect = await db.rpc("commercial_checkout_bind_customer", { p_shop: b.shopId, p_actor: b.ownerId, p_attempt: attemptB.id, p_customer: "acct_FakeConnected1" })
      expect(connect.error?.code).toBe("22023")
    })

    it("a different customer cannot replace the bound one", async () => {
      const s = await newShop()
      const fake = fakeStripe()
      await request(fake, s)
      fake.setStatus("expired")
      await request(fake, s) // attempt 2 in flight, customer already bound
      const [, second] = await attempts(s.shopId)
      const swap = await db.rpc("commercial_checkout_bind_customer", { p_shop: s.shopId, p_actor: s.ownerId, p_attempt: second.id, p_customer: "cus_FakeOtherOne" })
      // attempt 2 is session_open (not 'started'), and a swap is refused regardless.
      expect(swap.error).not.toBeNull()
      expect((await account(s.shopId))!.platform_customer_id).toMatch(/^cus_Fake/)
    })
  })

  describe("subscription evidence and the activation gate", () => {
    it("activation is blocked with a typed checkout_required carrying the server-created destination", async () => {
      const s = await newShop()
      const fake = fakeStripe()
      const session = await ownerSessionClient(s.email, PW)
      const decision = await activation(fake, s, session)
      expect(decision).toMatchObject({ proceed: false, code: "checkout_required" })
      if (decision.proceed) throw new Error("unreachable")
      expect(decision.billing).toMatchObject({ state: "checkout_pending", eligibleToActivate: false })
      expect(decision.billing?.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.com\//)
    })

    it("repeated activation requests are deterministic and never create another session", async () => {
      const s = await newShop()
      const fake = fakeStripe()
      const session = await ownerSessionClient(s.email, PW)
      const first = await activation(fake, s, session)
      const second = await activation(fake, s, session)
      const third = await activation(fake, s, session)
      expect(second).toEqual(first)
      expect(third).toEqual(first)
      expect(fake.calls.sessionCreate).toBe(1)
      expect(fake.calls.customer).toBe(1)
      expect(await attempts(s.shopId)).toHaveLength(1)
    })

    it("a non-owner session cannot reach Checkout through activation", async () => {
      const fake = fakeStripe()
      const decision = await activation(fake, shop, mgr, { actorId: manager.ownerId })
      expect(decision).toMatchObject({ proceed: false, code: "owner_required" })
      expect(fake.calls).toEqual({ price: 0, customer: 0, sessionCreate: 0, retrieve: 0 })
    })

    it("reviewed active Founder Pilot evidence is the only thing that allows activation", async () => {
      const s = await newShop()
      const fake = fakeStripe()
      await request(fake, s)
      const session = await ownerSessionClient(s.email, PW)
      expect(await activation(fake, s, session)).toMatchObject({ proceed: false })

      const applied = await applyEvidence(s, { status: "active" })
      expect(applied.error).toBeNull()
      expect(applied.data).toMatchObject({ advanced: true, state: "active" })
      expect(await activation(fake, s, session)).toEqual({ proceed: true })
      const dto = await readCommercialBillingDto(session, fake.runtime, s.shopId)
      expect(dto).toMatchObject({ state: "active", eligibleToActivate: true, blockingReason: null, checkoutUrl: null })

      // Active also stops any new Checkout.
      const before = { ...fake.calls }
      expect(await request(fake, s)).toMatchObject({ state: "active", eligibleToActivate: true, checkoutUrl: null })
      expect(fake.calls.sessionCreate).toBe(before.sessionCreate)
    })

    it.each([
      ["past_due", "past_due", "past_due", "subscription_past_due"],
      ["canceled", "canceled", "canceled", "subscription_canceled"],
      ["incomplete", "incomplete", "incomplete", "subscription_incomplete"],
      ["incomplete_expired", "incomplete_expired", "incomplete", "subscription_incomplete"],
      ["trialing (no trial is approved)", "trialing", "unknown", "subscription_unknown"],
      ["unpaid", "unpaid", "unknown", "subscription_unknown"],
      ["paused", "paused", "unknown", "subscription_unknown"],
    ])("provider status %s blocks activation (%s -> %s)", async (_name, providerStatus, state, reason) => {
      const s = await newShop()
      const fake = fakeStripe()
      await request(fake, s)
      expect((await applyEvidence(s, { status: providerStatus })).error).toBeNull()
      const decision = await activation(fake, s, await ownerSessionClient(s.email, PW))
      expect(decision).toMatchObject({ proceed: false, code: reason })
      if (!decision.proceed) expect(decision.billing).toMatchObject({ state, eligibleToActivate: false, checkoutUrl: null })
      // None of these may start another Checkout (that would duplicate a subscription).
      const before = fake.calls.sessionCreate
      await request(fake, s)
      expect(fake.calls.sessionCreate).toBe(before)
    })

    it("evidence for another catalog, plan or price is mismatched and blocks", async () => {
      for (const patch of [{ catalog: "2025-01-01.v1" }, { plan: "growth" }, { lookup: "gradia_growth_2026_11_monthly" }]) {
        const s = await newShop()
        const fake = fakeStripe()
        await request(fake, s)
        const r = await applyEvidence(s, patch)
        // A catalog/plan the account is not bound to may be refused outright; a price mismatch is quarantined.
        if (r.error) {
          expect(["22023", "23514", "CB409"]).toContain(r.error.code)
        } else {
          expect(r.data).toMatchObject({ state: "reconciliation_required" })
        }
        const decision = await activation(fake, s, await ownerSessionClient(s.email, PW))
        expect(decision.proceed).toBe(false)
      }
    })

    it("evidence for a different platform customer is quarantined", async () => {
      const s = await newShop()
      const fake = fakeStripe()
      await request(fake, s)
      const r = await applyEvidence(s, { customer: "cus_SomeoneElse001" })
      expect(r.data).toMatchObject({ state: "reconciliation_required" })
      expect(await activation(fake, s, await ownerSessionClient(s.email, PW))).toMatchObject({ proceed: false, code: "customer_mismatch" })
    })

    it("a second, different subscription for a live one forces reconciliation (no silent duplicate)", async () => {
      const s = await newShop()
      const fake = fakeStripe()
      await request(fake, s)
      expect((await applyEvidence(s, { subscription: "sub_FakeFirst001", status: "active" })).error).toBeNull()
      const dup = await applyEvidence(s, { subscription: "sub_FakeSecond02", status: "active" })
      expect(dup.data).toMatchObject({ state: "reconciliation_required" })
      expect(await activation(fake, s, await ownerSessionClient(s.email, PW))).toMatchObject({ proceed: false, code: "duplicate_subscription" })
    })

    it("out-of-order evidence is recorded but does not move the current pointer", async () => {
      const s = await newShop()
      const fake = fakeStripe()
      await request(fake, s)
      const now = Date.now()
      await applyEvidence(s, { status: "active", createdAt: new Date(now - 1_000).toISOString() })
      const late = await applyEvidence(s, { status: "past_due", createdAt: new Date(now - 60_000).toISOString() })
      expect(late.data).toMatchObject({ advanced: false })
      expect((await account(s.shopId))!.state).toBe("active")
      expect(await activation(fake, s, await ownerSessionClient(s.email, PW))).toEqual({ proceed: true })
      expect((await rows("commercial_subscription_evidence", s.shopId))).toHaveLength(2) // history preserved
      expect((await events(s.shopId)).map((e) => e.kind)).toContain("subscription_evidence_not_current")
    })

    it("evidence replays are idempotent and a changed replay conflicts", async () => {
      const s = await newShop()
      const fake = fakeStripe()
      await request(fake, s)
      const eventId = `evt_replay_${uniq()}`
      const created = new Date(Date.now() - 5_000).toISOString()
      const first = await applyEvidence(s, { eventId, createdAt: created })
      const replay = await applyEvidence(s, { eventId, createdAt: created })
      expect(replay.data).toMatchObject({ replayed: true, advanced: false })
      expect((first.data as { id: string }).id).toBe((replay.data as { id: string }).id)
      const changed = await applyEvidence(s, { eventId, createdAt: created, status: "canceled" })
      expect(changed.error?.code).toBe("CB409")
      expect((await rows("commercial_subscription_evidence", s.shopId))).toHaveLength(1)
    })

    it("live-mode and unreviewed-source evidence is unrepresentable", async () => {
      const s = await newShop()
      const fake = fakeStripe()
      await request(fake, s)
      expect((await applyEvidence(s, { livemode: true })).error?.code).toBe("22023")
      for (const source of ["browser_redirect", "client_assertion", "checkout_success", ""]) {
        expect((await applyEvidence(s, { source })).error?.code, source).toBe("22023")
      }
      expect((await rows("commercial_subscription_evidence", s.shopId))).toHaveLength(0)
      expect((await account(s.shopId))!.state).toBe("checkout_pending")
    })

    it("a legacy shops.plan = 'active' (voice add-on too) is not Founder Pilot proof", async () => {
      const s = await newShop()
      const upd = await db.from("shops").update({ plan: "active", voice_addon: true }).eq("id", s.shopId)
      expect(upd.error).toBeNull()
      const fake = fakeStripe()
      const decision = await activation(fake, s, await ownerSessionClient(s.email, PW))
      expect(decision).toMatchObject({ proceed: false, code: "checkout_required" })
    })

    it("billing never bypasses the existing gates or the two-agent entitlement", async () => {
      const s = await newShop()
      const fake = fakeStripe()
      await request(fake, s)
      await applyEvidence(s, { status: "active" })
      const session = await ownerSessionClient(s.email, PW)
      const base = { ...fake.calls }

      // existing policy/review/connector/memory gate not ready -> refused, billing untouched
      const gate = await activation(fake, s, session, { existing: { ready: false, reasons: ["knowledge_review_required", "tool_not_ready"] } })
      expect(gate).toEqual({ proceed: false, code: "existing_gate_blocked", billing: null, reasons: ["knowledge_review_required", "tool_not_ready"] })

      // one active agent -> the second is allowed, and the database enabled it
      await newAgent(s.shopId, s.ownerId, true)
      const second = await newAgent(s.shopId, s.ownerId)
      expect(await activation(fake, s, session, { agentId: second })).toEqual({ proceed: true })
      expect(await agentEnabled(second)).toBe(true)
      expect(await activeCount(s.shopId)).toBe(2)
      // two agents active -> a third is refused by the database count even with an active subscription
      const third = await newAgent(s.shopId, s.ownerId)
      expect(await activation(fake, s, session, { agentId: third })).toMatchObject({ proceed: false, code: "active_agent_limit_reached" })
      expect(await agentEnabled(third)).toBe(false)
      expect(await activeCount(s.shopId)).toBe(2)
      expect(fake.calls).toEqual(base)
    })

    it("a refused existing gate or the limit never creates a Checkout", async () => {
      const s = await newShop()
      const fake = fakeStripe()
      const session = await ownerSessionClient(s.email, PW)
      await activation(fake, s, session, { existing: { ready: false, reasons: ["evaluation_required"] } })
      expect(await account(s.shopId)).toBeNull() // gate refusal never reached billing at all
      await newAgent(s.shopId, s.ownerId, true)
      await newAgent(s.shopId, s.ownerId, true)
      expect(await activation(fake, s, session)).toMatchObject({ proceed: false, code: "active_agent_limit_reached" })
      expect(fake.calls).toEqual({ price: 0, customer: 0, sessionCreate: 0, retrieve: 0 })
    })

    it("an agent that is already active is an idempotent no-op and is not re-gated", async () => {
      const s = await newShop()
      const fake = fakeStripe()
      const id = await newAgent(s.shopId, s.ownerId, true)
      expect(await activation(fake, s, await ownerSessionClient(s.email, PW), { agentId: id })).toEqual({ proceed: true })
      expect(fake.calls.price).toBe(0)
      expect(await account(s.shopId)).toBeNull()
      expect(await activeCount(s.shopId)).toBe(1)
    })
  })

  describe("atomic activation writer (commercial_agent_activate)", () => {
    const activate = (client: SupabaseClient, shopId: string, actor: string, agent: string) =>
      client.rpc("commercial_agent_activate", { p_shop: shopId, p_actor: actor, p_agent: agent })

    async function activeShop() {
      const s = await newShop()
      await request(fakeStripe(), s)
      expect((await applyEvidence(s, { status: "active" })).error).toBeNull()
      return s
    }

    it("browser and anonymous roles cannot call the writer", async () => {
      const s = await activeShop()
      const id = await newAgent(s.shopId, s.ownerId)
      const own = await ownerSessionClient(s.email, PW)
      for (const client of [own, anon]) {
        const r = await activate(client, s.shopId, s.ownerId, id)
        expect(r.error).not.toBeNull()
        expect(r.data).toBeNull()
      }
      expect(await agentEnabled(id)).toBe(false)
    })

    it("the service role must name a live owner of the exact shop", async () => {
      const s = await activeShop()
      const id = await newAgent(s.shopId, s.ownerId)
      await addMember(s.shopId, manager, "manager")
      await addMember(s.shopId, staff, "staff")
      await addMember(s.shopId, revoked, "manager", false)
      for (const actor of [manager, staff, revoked, stranger, other]) {
        const r = await activate(db, s.shopId, actor.ownerId, id)
        expect(r.error?.code, actor.ownerId).toBe("42501")
      }
      expect((await activate(db, s.shopId, "00000000-0000-4000-8000-00000000dead", id)).error?.code).toBe("42501")
      expect(await agentEnabled(id)).toBe(false)
    })

    it("only activates an agent that belongs to the named shop", async () => {
      const s = await activeShop()
      const foreign = await newAgent(other.shopId, other.ownerId)
      const r = await activate(db, s.shopId, s.ownerId, foreign)
      expect(r.error).toBeNull()
      expect(r.data).toMatchObject({ outcome: "blocked", code: "agent_not_found" })
      expect(await agentEnabled(foreign)).toBe(false)
      const missing = await activate(db, s.shopId, s.ownerId, "00000000-0000-4000-8000-00000000beef")
      expect(missing.data).toMatchObject({ outcome: "blocked", code: "agent_not_found" })
    })

    it("rechecks the exact reviewed evidence: no account, no evidence, or wrong evidence never activates", async () => {
      const bare = await newShop()
      const a1 = await newAgent(bare.shopId, bare.ownerId)
      expect((await activate(db, bare.shopId, bare.ownerId, a1)).data).toMatchObject({ outcome: "blocked", code: "billing_not_active" })
      const pending = await newShop()
      await request(fakeStripe(), pending)
      const a2 = await newAgent(pending.shopId, pending.ownerId)
      expect((await activate(db, pending.shopId, pending.ownerId, a2)).data).toMatchObject({ outcome: "blocked", code: "billing_not_active" })
      for (const status of ["past_due", "canceled", "incomplete", "trialing"]) {
        const s = await newShop()
        await request(fakeStripe(), s)
        await applyEvidence(s, { status })
        const id = await newAgent(s.shopId, s.ownerId)
        expect((await activate(db, s.shopId, s.ownerId, id)).data, status).toMatchObject({ outcome: "blocked", code: "billing_not_active" })
        expect(await agentEnabled(id)).toBe(false)
      }
      expect(await agentEnabled(a1)).toBe(false)
      expect(await agentEnabled(a2)).toBe(false)
    })

    it("activates one agent, is idempotent for it, and never lets a third in", async () => {
      const s = await activeShop()
      const [x, y, z] = [await newAgent(s.shopId, s.ownerId), await newAgent(s.shopId, s.ownerId), await newAgent(s.shopId, s.ownerId)]
      expect((await activate(db, s.shopId, s.ownerId, x)).data).toMatchObject({ outcome: "activated", active_count: 1 })
      expect((await activate(db, s.shopId, s.ownerId, x)).data).toMatchObject({ outcome: "already_active" })
      expect((await activate(db, s.shopId, s.ownerId, y)).data).toMatchObject({ outcome: "activated", active_count: 2 })
      expect((await activate(db, s.shopId, s.ownerId, z)).data).toMatchObject({ outcome: "blocked", code: "active_agent_limit_reached" })
      // already-active stays a no-op even at the limit
      expect((await activate(db, s.shopId, s.ownerId, y)).data).toMatchObject({ outcome: "already_active" })
      expect(await activeCount(s.shopId)).toBe(2)
    })

    it("CONCURRENCY: from one active agent, two simultaneous activations leave at most two active and exactly one succeeds", async () => {
      for (let round = 0; round < 5; round++) {
        const s = await activeShop()
        await newAgent(s.shopId, s.ownerId, true)
        const [x, y] = [await newAgent(s.shopId, s.ownerId), await newAgent(s.shopId, s.ownerId)]
        const results = await Promise.all([activate(db, s.shopId, s.ownerId, x), activate(db, s.shopId, s.ownerId, y)])
        for (const r of results) expect(r.error).toBeNull()
        const outcomes = results.map((r) => (r.data as { outcome: string }).outcome).sort()
        expect(outcomes, `round ${round}`).toEqual(["activated", "blocked"])
        expect(results.map((r) => (r.data as { code: string | null }).code).filter(Boolean)).toEqual(["active_agent_limit_reached"])
        expect(await activeCount(s.shopId)).toBe(2)
        expect((await agentEnabled(x)) !== (await agentEnabled(y))).toBe(true)
      }
    })

    it("CONCURRENCY through the application seam enforces the same limit", async () => {
      const s = await activeShop()
      await newAgent(s.shopId, s.ownerId, true)
      const [x, y] = [await newAgent(s.shopId, s.ownerId), await newAgent(s.shopId, s.ownerId)]
      const fake = fakeStripe()
      const session = await ownerSessionClient(s.email, PW)
      const decisions = await Promise.all([
        activation(fake, s, session, { agentId: x }),
        activation(fake, s, session, { agentId: y }),
      ])
      expect(decisions.filter((d) => d.proceed)).toHaveLength(1)
      expect(decisions.filter((d) => !d.proceed)).toMatchObject([{ code: "active_agent_limit_reached" }])
      expect(await activeCount(s.shopId)).toBe(2)
    })

    it("the same agent requested twice at once is activated once and the replay is a no-op", async () => {
      const s = await activeShop()
      const id = await newAgent(s.shopId, s.ownerId)
      const results = await Promise.all([activate(db, s.shopId, s.ownerId, id), activate(db, s.shopId, s.ownerId, id)])
      expect(results.map((r) => (r.data as { outcome: string }).outcome).sort()).toEqual(["activated", "already_active"])
      expect(await activeCount(s.shopId)).toBe(1)
    })

    it("the owner's direct RLS update cannot turn an agent on around the writer, but can turn it off", async () => {
      const s = await newShop() // no subscription at all
      const id = await newAgent(s.shopId, s.ownerId)
      const own = await ownerSessionClient(s.email, PW)
      const on = await own.from("custom_agents").update({ enabled: true }).eq("id", id)
      expect(on.error).not.toBeNull()
      expect(await agentEnabled(id)).toBe(false)
      const ins = await own.from("custom_agents").insert({ shop_id: s.shopId, owner_id: s.ownerId, name: "x", problem_text: "x", config: {}, enabled: true })
      expect(ins.error).not.toBeNull()
      // a draft insert and disabling remain available, with no billing involved
      const draft = await own.from("custom_agents").insert({ shop_id: s.shopId, owner_id: s.ownerId, name: "d", problem_text: "d", config: {} }).select("id").single()
      expect(draft.error).toBeNull()
      const live = await newAgent(s.shopId, s.ownerId, true)
      const off = await own.from("custom_agents").update({ enabled: false }).eq("id", live)
      expect(off.error).toBeNull()
      expect(await agentEnabled(live)).toBe(false)
    })
  })

  describe("tenant isolation and audit evidence", () => {
    it("each workspace has its own account, customer and attempts", async () => {
      const a = await newShop()
      const b = await newShop()
      const fa = fakeStripe()
      const fb = fakeStripe()
      await request(fa, a)
      await request(fb, b)
      expect((await account(a.shopId))!.platform_customer_id).not.toBe((await account(b.shopId))!.platform_customer_id)
      await applyEvidence(a, { status: "active" })
      expect(await activation(fb, b, await ownerSessionClient(b.email, PW))).toMatchObject({ proceed: false })
      expect(await activation(fa, a, await ownerSessionClient(a.email, PW))).toEqual({ proceed: true })
    })

    it("history is append-only and never contains a URL or key", async () => {
      const s = await newShop()
      const fake = fakeStripe()
      await request(fake, s)
      fake.setStatus("expired")
      await request(fake, s)
      await applyEvidence(s, { status: "active" })
      const all = await events(s.shopId)
      expect(all.map((e) => e.shop_seq)).toEqual(all.map((_, i) => i + 1))
      expect(JSON.stringify(all)).not.toMatch(/https?:|sk_(live|test)|whsec_|client_secret|checkout\.stripe/i)
      // Attempts keep their identity after later attempts and evidence.
      const list = await attempts(s.shopId)
      expect(list.map((a) => a.attempt_no)).toEqual([1, 2])
      expect(list[0].status).toBe("expired")
    })

    it("every account is bound to the approved, registered catalog version", async () => {
      expect(COMMERCIAL_CATALOG_VERSION).toBe(APPROVED_COMMERCIAL_CATALOG_VERSION)
      const { data, error } = await db.from("commercial_catalog_versions").select("version").eq("version", COMMERCIAL_CATALOG_VERSION)
      expect(error).toBeNull()
      expect(data).toHaveLength(1)
    })

    it("deleting a workspace removes its billing state (existing tenant-deletion contract)", async () => {
      const s = await newShop()
      await request(fakeStripe(), s)
      expect(await account(s.shopId)).not.toBeNull()
      await db.from("shops").delete().eq("id", s.shopId)
      expect(await account(s.shopId)).toBeNull()
      expect(await attempts(s.shopId)).toHaveLength(0)
      expect(await events(s.shopId)).toHaveLength(0)
    })
  })
})
