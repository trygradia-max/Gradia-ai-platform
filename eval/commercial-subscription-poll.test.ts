import { describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

import {
  createSubscriptionPollReader,
  decideSubscriptionObservation,
  interpretCheckoutSession,
  observationDigest,
  type PolledList,
  type SubscriptionPollReader,
} from "@/lib/commercial-subscription-poll"
import {
  observeClaim,
  recordSubscriptionPoll,
  runSubscriptionPollSweep,
  type SubscriptionPollClaim,
} from "@/lib/commercial-subscription-poll-service"
import { exactFixtureItems, fixtureItem } from "./_commercial-item-fixtures"
import { FOUNDER_PILOT_ITEM_SLOTS } from "@/lib/commercial-subscription-items"

const CUSTOMER = "cus_PollCustomer01"
const SUB = "sub_PollSubscription01"
const SHOP = "11111111-1111-4111-8111-111111111111"
const OTHER_SHOP = "99999999-9999-4999-8999-999999999999"
const ATTEMPT = "22222222-2222-4222-8222-222222222222"
const SESSION = "cs_test_PollSession01"
const NOW = Date.UTC(2026, 10, 19, 12, 0, 0)
const S = (ms: number) => Math.floor(ms / 1000)
const DAY = 86_400_000

type SubOver = Record<string, unknown>
const subscription = (over: SubOver = {}) => ({
  id: SUB,
  object: "subscription",
  livemode: false,
  customer: CUSTOMER,
  status: "active",
  start_date: S(NOW - 10 * DAY),
  current_period_start: S(NOW - 3 * DAY),
  current_period_end: S(NOW + 27 * DAY),
  cancel_at_period_end: false,
  canceled_at: null,
  metadata: { shop_id: SHOP, catalog_version: "2026-11-03.v1", plan_key: "founder-pilot", checkout_attempt_id: ATTEMPT },
  items: { object: "list", data: exactFixtureItems(), has_more: false },
  ...over,
})
const list = (...subs: unknown[]): PolledList => ({ complete: true, data: subs })
const decide = (l: PolledList, over: Partial<Parameters<typeof decideSubscriptionObservation>[0]> = {}) =>
  decideSubscriptionObservation({ customerId: CUSTOMER, targetSubscriptionId: SUB, sessionSubscriptionId: null, list: l, nowMs: NOW, ...over })

describe("decideSubscriptionObservation: the evidence comparison", () => {
  it("a complete, exact, verified ACTIVE subscription becomes a subscription observation (same normalizer as the webhook)", () => {
    const o = decide(list(subscription()))
    expect(o.kind).toBe("subscription")
    if (o.kind !== "subscription") return
    expect(o.facts).toMatchObject({
      object: "subscription", subscription_id: SUB, customer_id: CUSTOMER, status: "active",
      price_lookup_key: "gradia_founder_pilot_2026_11_monthly",
      period_start: new Date(NOW - 3 * DAY).toISOString(), period_end: new Date(NOW + 27 * DAY).toISOString(),
    })
  })

  it("provider metadata never supplies the Checkout attempt (it is discarded); a metadata shop id survives only as a cross-check", () => {
    const o = decide(list(subscription({ metadata: { shop_id: OTHER_SHOP, checkout_attempt_id: ATTEMPT } })))
    expect(o.kind).toBe("subscription")
    if (o.kind !== "subscription") return
    expect(o.facts.checkout_attempt_id).toBeNull()
    expect(o.facts.metadata_shop_id).toBe(OTHER_SHOP) // handed to the database to REFUSE, never to select a tenant
    // The observation carries no field through which provider data could name the shop to write.
    expect(Object.keys(o).sort()).toEqual(["customer_id", "facts", "kind", "session_subscription_id"])
  })

  it("an incomplete list (has_more) is ambiguous: nothing is concluded from a truncated read", () => {
    expect(decide({ complete: false, data: [subscription()] })).toMatchObject({ kind: "none", class: "ambiguous", code: "list_incomplete" })
  })

  it("truncated items are ambiguous (the exact set cannot be proven)", () => {
    const sub = subscription({ items: { data: exactFixtureItems(), has_more: true } })
    expect(decide(list(sub))).toMatchObject({ class: "ambiguous", code: "items_incomplete" })
    expect(decide(list(subscription({ items: { data: exactFixtureItems() } })))).toMatchObject({ class: "ambiguous", code: "items_incomplete" })
  })

  it("a live-mode object, a foreign customer, an unreadable entry or a missing target is ambiguous and changes nothing", () => {
    expect(decide(list(subscription({ livemode: true })))).toMatchObject({ class: "ambiguous", code: "live_object_refused" })
    expect(decide(list(subscription({ livemode: undefined })))).toMatchObject({ class: "ambiguous", code: "live_object_refused" })
    expect(decide(list(subscription({ customer: "cus_SomeoneElse01" })))).toMatchObject({ class: "ambiguous", code: "customer_mismatch" })
    expect(decide(list(subscription(), { id: "garbage" }))).toMatchObject({ class: "ambiguous", code: "subscription_unreadable" })
    expect(decide(list(subscription({ id: "sub_NotTheTarget01" })))).toMatchObject({ class: "ambiguous", code: "target_missing" })
    expect(decide(list(subscription(), subscription()))).toMatchObject({ class: "ambiguous", code: "subscription_duplicated" })
    expect(decide(list())).toMatchObject({ class: "ambiguous", code: "target_missing" })
  })

  it("never ACTIVE while another live subscription exists on the customer, but a restrictive state is still reported", () => {
    const stray = subscription({ id: "sub_StraySubscription01" })
    expect(decide(list(subscription(), stray))).toMatchObject({ class: "ambiguous", code: "unexpected_subscription" })
    // Past due is the fail-closed direction: it is applied even though the read is otherwise ambiguous.
    expect(decide(list(subscription({ status: "past_due" }), stray)).kind).toBe("subscription")
    expect(decide(list(subscription({ status: "canceled", canceled_at: S(NOW) }), stray)).kind).toBe("subscription")
    // A finished stray subscription is not a duplicate.
    expect(decide(list(subscription(), subscription({ id: "sub_OldCanceled0001", status: "canceled" }))).kind).toBe("subscription")
    expect(decide(list(subscription(), subscription({ id: "sub_OldExpired00001", status: "incomplete_expired" }))).kind).toBe("subscription")
    // An unreadable stray status counts as live.
    expect(decide(list(subscription(), subscription({ id: "sub_UnknownStatus001", status: undefined })))).toMatchObject({ class: "ambiguous" })
  })

  it("never ACTIVE from an unverified or already-elapsed period", () => {
    expect(decide(list(subscription({ current_period_end: S(NOW - 1000) })))).toMatchObject({ class: "ambiguous", code: "period_elapsed" })
    expect(decide(list(subscription({ current_period_end: S(NOW) })))).toMatchObject({ class: "ambiguous", code: "period_elapsed" })
    // Item periods that disagree with the top-level period leave the period unverified.
    const items = exactFixtureItems().map((item, i) => (i === 0 ? { ...item, current_period_end: S(NOW + 5 * DAY) } : item))
    expect(decide(list(subscription({ items: { data: items, has_more: false } })))).toMatchObject({ class: "ambiguous", code: "period_not_verified" })
    expect(decide(list(subscription({ current_period_start: undefined, current_period_end: undefined })))).toMatchObject({ class: "ambiguous", code: "period_not_verified" })
    expect(decide(list(subscription({ start_date: undefined })))).toMatchObject({ class: "ambiguous", code: "period_not_verified" })
    // A non-active status with no period is still reported (restrictive).
    expect(decide(list(subscription({ status: "past_due", current_period_start: undefined, current_period_end: undefined }))).kind).toBe("subscription")
  })

  it("an item set that is not exact is reported with the same marker the webhook uses (the database makes it a sticky catalog mismatch)", () => {
    const extra = [...exactFixtureItems(), fixtureItem({ ...FOUNDER_PILOT_ITEM_SLOTS[1], lookupKey: "unknown_price_key" })]
    const o = decide(list(subscription({ items: { data: extra, has_more: false } })))
    expect(o.kind).toBe("subscription")
    if (o.kind === "subscription") expect(o.facts.price_lookup_key).toBe("invalid_items")
  })

  it("an unrecognised provider status is ambiguous, never guessed", () => {
    expect(decide(list(subscription({ status: "something_new" })))).toMatchObject({ class: "ambiguous", code: "status_unrecognized" })
  })

  it("carries the session-named subscription only when the caller says the server-held session named it", () => {
    const o = decide(list(subscription()), { sessionSubscriptionId: SUB })
    expect(o.kind === "subscription" && o.session_subscription_id).toBe(SUB)
  })
})

describe("observation digest (the replay fingerprint)", () => {
  const base = () => decide(list(subscription()))
  it("is stable across key order and changes with any material difference", () => {
    const a = base()
    const b = JSON.parse(JSON.stringify(a))
    // Re-order the keys of the facts; the digest must not change.
    const reordered = { ...b, facts: Object.fromEntries(Object.entries(b.facts).reverse()) }
    expect(observationDigest(reordered)).toBe(observationDigest(a))
    expect(observationDigest(a)).toMatch(/^[0-9a-f]{64}$/)
    const changed = decide(list(subscription({ status: "past_due" })))
    expect(observationDigest(changed)).not.toBe(observationDigest(a))
    expect(observationDigest({ kind: "unreadable", customer_id: CUSTOMER, code: "provider_unreadable" })).not.toBe(observationDigest(a))
  })
  it("never contains a secret, URL or token-shaped value", () => {
    const text = JSON.stringify(base())
    expect(text).not.toMatch(/sk_(live|test)|rk_(live|test)|whsec_|https?:|client_secret/)
  })
})

describe("interpretCheckoutSession: only the server-held session may name a subscription", () => {
  const expected = { sessionId: SESSION, attemptId: ATTEMPT, customerId: CUSTOMER }
  const session = (over: SubOver = {}) => ({
    id: SESSION, object: "checkout.session", livemode: false, mode: "subscription", status: "complete",
    client_reference_id: ATTEMPT, customer: CUSTOMER, subscription: SUB, ...over,
  })
  it("a complete, bound session names its subscription (string or expanded object)", () => {
    expect(interpretCheckoutSession(session(), expected)).toEqual({ kind: "complete", subscriptionId: SUB })
    expect(interpretCheckoutSession(session({ subscription: { id: SUB } }), expected)).toEqual({ kind: "complete", subscriptionId: SUB })
  })
  it("open and expired sessions are pending, not an error", () => {
    expect(interpretCheckoutSession(session({ status: "open", subscription: null }), expected)).toEqual({ kind: "pending", code: "session_open" })
    expect(interpretCheckoutSession(session({ status: "expired", subscription: null }), expected)).toEqual({ kind: "pending", code: "session_expired" })
  })
  it("everything else is ambiguous: wrong attempt, wrong customer, wrong id, wrong mode, live, no subscription, unreadable", () => {
    const code = (over: SubOver) => interpretCheckoutSession(session(over), expected)
    expect(code({ client_reference_id: "other" })).toMatchObject({ kind: "ambiguous", code: "session_binding_mismatch" })
    expect(code({ customer: "cus_SomeoneElse01" })).toMatchObject({ kind: "ambiguous", code: "session_binding_mismatch" })
    expect(code({ id: "cs_test_Different0001" })).toMatchObject({ kind: "ambiguous", code: "session_binding_mismatch" })
    expect(code({ mode: "payment" })).toMatchObject({ kind: "ambiguous", code: "session_binding_mismatch" })
    expect(code({ livemode: true })).toMatchObject({ kind: "ambiguous", code: "live_object_refused" })
    expect(code({ subscription: null })).toMatchObject({ kind: "ambiguous", code: "session_subscription_missing" })
    expect(code({ subscription: "garbage" })).toMatchObject({ kind: "ambiguous", code: "session_subscription_missing" })
    expect(code({ status: "weird" })).toMatchObject({ kind: "ambiguous", code: "session_unreadable" })
    expect(interpretCheckoutSession(null, expected)).toMatchObject({ kind: "ambiguous", code: "session_unreadable" })
    // Metadata is never consulted: a session whose metadata names the right shop but whose binding is wrong is still refused.
    expect(code({ client_reference_id: "other", metadata: { shop_id: SHOP, checkout_attempt_id: ATTEMPT } })).toMatchObject({ kind: "ambiguous" })
  })
})

describe("the provider reader is GET only", () => {
  const config = { secretKey: "sk_test_FAKEFAKEFAKEFAKE0123", apiBase: "https://api.stripe.com/v1", timeoutMs: 1000 }
  it("issues only GETs, scoped to one customer, with the reviewed API version and no body secrets", async () => {
    const seen: { method: string; path: string; body?: unknown; apiVersion?: string; idempotencyKey?: string }[] = []
    const request = vi.fn(async (_cfg: unknown, input: { method: string; path: string; body?: unknown; apiVersion?: string; idempotencyKey?: string }) => {
      seen.push(input)
      return input.path === "/subscriptions" ? { data: [subscription()], has_more: false } : { id: SESSION }
    }) as never
    const reader = createSubscriptionPollReader(config, request)
    expect(await reader.listCustomerSubscriptions(CUSTOMER)).toEqual({ complete: true, data: [subscription()] })
    await reader.retrieveCheckoutSession(SESSION)
    expect(seen.map((s) => s.method)).toEqual(["GET", "GET"])
    expect(seen[0]).toMatchObject({ path: "/subscriptions", body: { customer: CUSTOMER, status: "all", limit: 100 }, apiVersion: "2024-09-30.acacia" })
    expect(seen.every((s) => s.idempotencyKey === undefined)).toBe(true)
    expect(seen[1].path).toBe(`/checkout/sessions/${SESSION}`)
  })
  it("reports has_more as incomplete and refuses ids that are not test-shaped (no path injection)", async () => {
    const request = vi.fn(async () => ({ data: [], has_more: true })) as never
    const reader = createSubscriptionPollReader(config, request)
    expect(await reader.listCustomerSubscriptions(CUSTOMER)).toEqual({ complete: false, data: [] })
    await expect(reader.listCustomerSubscriptions("cus_x/../../v1/charges")).rejects.toThrow()
    await expect(reader.retrieveCheckoutSession("cs_live_abcdefgh")).rejects.toThrow()
    await expect(reader.retrieveCheckoutSession("cs_test_x/../customers")).rejects.toThrow()
    const unreadable = createSubscriptionPollReader(config, vi.fn(async () => ({ data: "nope" })) as never)
    await expect(unreadable.listCustomerSubscriptions(CUSTOMER)).rejects.toThrow()
  })
})

const claim = (over: Partial<SubscriptionPollClaim> = {}): SubscriptionPollClaim => ({
  claimed: true, claim_token: "33333333-3333-4333-8333-333333333333", shop_id: SHOP, customer_id: CUSTOMER, state: "active",
  known_subscription_id: SUB, attempt_id: null, session_id: null, requested_at: "2026-11-19T12:00:00Z", observed_at: "2026-11-19T11:55:00Z", ...over,
})
const fakeReader = (over: Partial<SubscriptionPollReader> = {}): SubscriptionPollReader => ({
  listCustomerSubscriptions: vi.fn(async () => list(subscription())),
  retrieveCheckoutSession: vi.fn(async () => ({})),
  ...over,
})

describe("observeClaim: what is read, and in what order", () => {
  it("a known subscription is compared with ONE list read (no session read)", async () => {
    const reader = fakeReader()
    const o = await observeClaim(reader, claim(), NOW)
    expect(o.kind).toBe("subscription")
    expect(reader.listCustomerSubscriptions).toHaveBeenCalledTimes(1)
    expect(reader.listCustomerSubscriptions).toHaveBeenCalledWith(CUSTOMER)
    expect(reader.retrieveCheckoutSession).not.toHaveBeenCalled()
  })

  it("a never-seen subscription is discovered ONLY through the server-held session, then compared", async () => {
    const reader = fakeReader({
      retrieveCheckoutSession: vi.fn(async () => ({
        id: SESSION, object: "checkout.session", livemode: false, mode: "subscription", status: "complete",
        client_reference_id: ATTEMPT, customer: CUSTOMER, subscription: SUB,
      })),
    })
    const o = await observeClaim(reader, claim({ known_subscription_id: null, attempt_id: ATTEMPT, session_id: SESSION, state: "checkout_pending" }), NOW)
    expect(o).toMatchObject({ kind: "subscription", session_subscription_id: SUB })
    expect(reader.retrieveCheckoutSession).toHaveBeenCalledWith(SESSION)
    expect(reader.listCustomerSubscriptions).toHaveBeenCalledTimes(1)
  })

  it("a session that is still open (or expired) is pending and the subscription list is not even read", async () => {
    const reader = fakeReader({
      retrieveCheckoutSession: vi.fn(async () => ({
        id: SESSION, object: "checkout.session", livemode: false, mode: "subscription", status: "open",
        client_reference_id: ATTEMPT, customer: CUSTOMER, subscription: null,
      })),
    })
    const o = await observeClaim(reader, claim({ known_subscription_id: null, attempt_id: ATTEMPT, session_id: SESSION }), NOW)
    expect(o).toMatchObject({ kind: "none", class: "session_pending", code: "session_open" })
    expect(reader.listCustomerSubscriptions).not.toHaveBeenCalled()
  })

  it("a stray subscription on the customer is NOT adopted when the server has no recorded subscription and no session to name it", async () => {
    const reader = fakeReader()
    const o = await observeClaim(reader, claim({ known_subscription_id: null, attempt_id: null, session_id: null }), NOW)
    expect(o).toMatchObject({ kind: "none", class: "no_subscription" })
    expect(reader.listCustomerSubscriptions).not.toHaveBeenCalled()
    expect(reader.retrieveCheckoutSession).not.toHaveBeenCalled()
  })

  it("a session naming a subscription that the list does not contain is ambiguous", async () => {
    const reader = fakeReader({
      listCustomerSubscriptions: vi.fn(async () => list(subscription({ id: "sub_SomethingElse001" }))),
      retrieveCheckoutSession: vi.fn(async () => ({
        id: SESSION, object: "checkout.session", livemode: false, mode: "subscription", status: "complete",
        client_reference_id: ATTEMPT, customer: CUSTOMER, subscription: SUB,
      })),
    })
    const o = await observeClaim(reader, claim({ known_subscription_id: null, attempt_id: ATTEMPT, session_id: SESSION }), NOW)
    expect(o).toMatchObject({ kind: "none", class: "ambiguous", code: "target_missing" })
  })

  it("a provider failure is an UNREADABLE observation with a finite code and never the error text", async () => {
    const reader = fakeReader({ listCustomerSubscriptions: vi.fn(async () => { throw new Error("boom sk_test_SECRET https://x") }) })
    const o = await observeClaim(reader, claim(), NOW)
    expect(o).toEqual({ kind: "unreadable", customer_id: CUSTOMER, code: "provider_unreadable" })
    expect(JSON.stringify(o)).not.toContain("SECRET")
  })
})

describe("recording and the sweep", () => {
  const recordRpc = (data: unknown = { outcome: "applied", reason: null, replayed: false }, error: { code: string } | null = null) =>
    vi.fn(async (name: string) => {
      if (name === "commercial_subscription_poll_overview") return { data: { eligible: 1, due: 0, claimed: 0, never_polled: 0, failing: 0, overdue: 0 }, error: null }
      return { data: error ? null : data, error }
    })

  it("the database call binds the SHOP and CLAIM from the server-held claim, never from provider data", async () => {
    const rpc = recordRpc()
    const observation = decide(list(subscription({ metadata: { shop_id: OTHER_SHOP } })))
    const result = await recordSubscriptionPoll({ rpc } as unknown as SupabaseClient, claim(), observation)
    expect(result).toEqual({ outcome: "applied" })
    const [name, args] = rpc.mock.calls[0] as unknown as [string, { p_shop: string; p_claim_token: string; p_observation: { digest: string } }]
    expect(name).toBe("commercial_subscription_poll_record")
    expect(args.p_shop).toBe(SHOP)
    expect(args.p_shop).not.toBe(OTHER_SHOP)
    expect(args.p_claim_token).toBe(claim().claim_token)
    expect(args.p_observation.digest).toBe(observationDigest(observation))
  })

  it("a lost or superseded claim (CB409) and any other failure are reported, not retried or guessed", async () => {
    const observation = decide(list(subscription()))
    expect(await recordSubscriptionPoll({ rpc: recordRpc(null, { code: "CB409" }) } as unknown as SupabaseClient, claim(), observation)).toEqual({ outcome: "record_failed", code: "claim_lost" })
    expect(await recordSubscriptionPoll({ rpc: recordRpc(null, { code: "XX000" }) } as unknown as SupabaseClient, claim(), observation)).toEqual({ outcome: "record_failed", code: "record_failed" })
    expect(await recordSubscriptionPoll({ rpc: recordRpc({ outcome: "paid_in_full" }) } as unknown as SupabaseClient, claim(), observation)).toEqual({ outcome: "record_failed", code: "record_failed" })
  })

  it("sweeps until nothing is due, bounded by the limit, and counts outcomes", async () => {
    let n = 0
    const rpc = vi.fn(async (name: string) => {
      if (name === "commercial_subscription_poll_claim") {
        return { data: { ...claim(), claim_token: `33333333-3333-4333-8333-${String(++n).padStart(12, "0")}` }, error: null }
      }
      if (name === "commercial_subscription_poll_record") return { data: { outcome: n % 2 ? "unchanged" : "applied", reason: null, replayed: false }, error: null }
      return { data: { eligible: 4, due: 2, claimed: 0, never_polled: 1, failing: 1, overdue: 2 }, error: null }
    })
    const report = await runSubscriptionPollSweep({ rpc } as unknown as SupabaseClient, fakeReader(), { limit: 3, nowMs: () => NOW })
    expect(report.claimed).toBe(3)
    expect(report.outcomes.unchanged + report.outcomes.applied).toBe(3)
    expect(report).toMatchObject({ overdue: 2, failing: 1, claimFailed: false, recordFailed: 0 })
    expect(rpc.mock.calls.filter(([name]) => name === "commercial_subscription_poll_claim")).toHaveLength(3)
  })

  it("stops when nothing is due, when the gate refuses (lease lost / budget) and when claiming itself fails", async () => {
    const none = vi.fn(async (name: string) => (name === "commercial_subscription_poll_claim" ? { data: { claimed: false, reason: "nothing_due" }, error: null } : { data: null, error: { code: "x" } }))
    expect(await runSubscriptionPollSweep({ rpc: none } as unknown as SupabaseClient, fakeReader(), { limit: 5 })).toMatchObject({ claimed: 0, claimFailed: false })

    const gate = vi.fn(async () => false)
    const gated = await runSubscriptionPollSweep({ rpc: none } as unknown as SupabaseClient, fakeReader(), { limit: 5, gate })
    expect(gated.stoppedEarly).toBe(true)
    expect(none.mock.calls.filter(([name]) => name === "commercial_subscription_poll_claim")).toHaveLength(1) // only the earlier run's claim

    const broken = vi.fn(async () => ({ data: null, error: { code: "42501" } }))
    expect(await runSubscriptionPollSweep({ rpc: broken } as unknown as SupabaseClient, fakeReader(), { limit: 5 })).toMatchObject({ claimed: 0, claimFailed: true })
  })

  it("an unreadable provider is recorded (so the shop backs off), not skipped", async () => {
    let recorded: { p_observation: { kind: string; code: string } } | undefined
    const rpc = vi.fn(async (name: string, args?: unknown) => {
      if (name === "commercial_subscription_poll_claim") return { data: claim(), error: null }
      if (name === "commercial_subscription_poll_record") {
        recorded = args as typeof recorded
        return { data: { outcome: "unreadable", reason: "provider_unreadable", replayed: false }, error: null }
      }
      return { data: null, error: null }
    })
    const reader = fakeReader({ listCustomerSubscriptions: vi.fn(async () => { throw new Error("timeout") }) })
    const report = await runSubscriptionPollSweep({ rpc } as unknown as SupabaseClient, reader, { limit: 1 })
    expect(recorded?.p_observation).toMatchObject({ kind: "unreadable", code: "provider_unreadable" })
    expect(report.outcomes.unreadable).toBe(1)
  })
})
