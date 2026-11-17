import { createHmac } from "node:crypto"

import { describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

import { FOUNDER_PILOT_PRICE, buildPortalReturnUrl } from "@/lib/commercial-billing"
import { interpretExecutionGate } from "@/lib/commercial-execution-gate"
import {
  COMMERCIAL_WEBHOOK_MAX_BODY_BYTES,
  parseVerifiedWebhook,
  payloadDigest,
  resolveCommercialWebhookConfig,
  verifyCommercialSignature,
} from "@/lib/commercial-webhook"
import { handleCommercialWebhook } from "@/lib/commercial-webhook-service"
import { StripeError } from "@/lib/stripe"
import { createPlatformPortalClient } from "@/lib/stripe-commercial"

const SECRET = "whsec_" + "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"
const NOW = 1_800_000_000_000
const sign = (body: string, secret = SECRET, t = Math.floor(NOW / 1000)) =>
  `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`

const SUB = {
  id: "sub_Unit0001",
  object: "subscription",
  customer: "cus_Unit0001",
  status: "active",
  livemode: false,
  start_date: 1_790_000_000,
  current_period_start: 1_790_000_000,
  current_period_end: 1_792_592_000,
  cancel_at_period_end: false,
  canceled_at: null,
  metadata: { shop_id: "11111111-1111-4111-8111-111111111111", catalog_version: "2026-11-03.v1", plan_key: "founder-pilot", checkout_attempt_id: "22222222-2222-4222-8222-222222222222" },
  items: { data: [{ quantity: 1, price: { id: "price_x", lookup_key: FOUNDER_PILOT_PRICE.lookupKey } }] },
}
const event = (over: Record<string, unknown> = {}, object: Record<string, unknown> = SUB) =>
  JSON.stringify({ id: "evt_Unit000001", object: "event", type: "customer.subscription.updated", created: 1_790_000_100, livemode: false, data: { object }, ...over })

describe("commercial webhook configuration", () => {
  const good = { GRADIA_COMMERCIAL_BILLING_STRIPE_MODE: "test", GRADIA_COMMERCIAL_STRIPE_WEBHOOK_SECRET: SECRET }
  it("is disabled unless the dedicated secret and the test-mode flag are both present", () => {
    expect(resolveCommercialWebhookConfig({})).toEqual({ ok: false, reason: "webhook_unconfigured" })
    expect(resolveCommercialWebhookConfig({ GRADIA_COMMERCIAL_BILLING_STRIPE_MODE: "test" })).toEqual({ ok: false, reason: "webhook_unconfigured" })
    expect(resolveCommercialWebhookConfig({ GRADIA_COMMERCIAL_STRIPE_WEBHOOK_SECRET: SECRET })).toEqual({ ok: false, reason: "webhook_unconfigured" })
    expect(resolveCommercialWebhookConfig(good)).toEqual({ ok: true, secret: SECRET })
  })
  it("refuses live-shaped, malformed or shared configuration without echoing it", () => {
    expect(resolveCommercialWebhookConfig({ ...good, GRADIA_COMMERCIAL_BILLING_STRIPE_MODE: "live" })).toEqual({ ok: false, reason: "webhook_misconfigured" })
    expect(resolveCommercialWebhookConfig({ ...good, GRADIA_COMMERCIAL_STRIPE_WEBHOOK_SECRET: "whsec_short" })).toEqual({ ok: false, reason: "webhook_misconfigured" })
    expect(resolveCommercialWebhookConfig({ ...good, GRADIA_COMMERCIAL_STRIPE_WEBHOOK_SECRET: "not-a-secret-at-all-xxxxxxxx" })).toEqual({ ok: false, reason: "webhook_misconfigured" })
    expect(resolveCommercialWebhookConfig({ ...good, STRIPE_SECRET_KEY: "sk_live_" + "x".repeat(24) })).toEqual({ ok: false, reason: "webhook_misconfigured" })
    expect(resolveCommercialWebhookConfig({ ...good, STRIPE_SECRET_KEY: "sk_test_" + "x".repeat(24) })).toEqual({ ok: true, secret: SECRET })
    // The Connect webhook secret can never double as the commercial one.
    expect(resolveCommercialWebhookConfig({ ...good, STRIPE_WEBHOOK_SECRET: SECRET })).toEqual({ ok: false, reason: "webhook_misconfigured" })
    expect(resolveCommercialWebhookConfig({ ...good, STRIPE_WEBHOOK_SECRET: "whsec_" + "z".repeat(32) })).toEqual({ ok: true, secret: SECRET })
  })
})

describe("raw-body signature verification", () => {
  const body = event()
  const v = (header: string | null, rawBody = body, secret = SECRET) => verifyCommercialSignature({ rawBody, header, secret, nowMs: NOW })
  it("accepts a fresh, correct signature over the exact raw body (any matching v1)", () => {
    expect(v(sign(body))).toEqual({ ok: true })
    const t = Math.floor(NOW / 1000)
    expect(v(`${sign(body)},v1=${"0".repeat(64)}`)).toEqual({ ok: true })
    expect(v(`t=${t},v1=${"0".repeat(64)},v1=${createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex")}`)).toEqual({ ok: true })
  })
  it("refuses a tampered body, a wrong secret, a stale timestamp and malformed headers", () => {
    expect(v(sign(body), body.replace("sub_Unit0001", "sub_Unit0002"))).toEqual({ ok: false, code: "signature_invalid" })
    expect(v(sign(body, "whsec_" + "b".repeat(32)))).toEqual({ ok: false, code: "signature_invalid" })
    expect(v(sign(body, SECRET, Math.floor(NOW / 1000) - 3600))).toEqual({ ok: false, code: "signature_stale" })
    expect(v(null)).toEqual({ ok: false, code: "signature_missing" })
    expect(v("")).toEqual({ ok: false, code: "signature_missing" })
    expect(v("v1=abcd")).toEqual({ ok: false, code: "signature_malformed" })
    expect(v("t=abc,v1=abcd")).toEqual({ ok: false, code: "signature_malformed" })
    expect(v(`t=${Math.floor(NOW / 1000)}`)).toEqual({ ok: false, code: "signature_malformed" })
    expect(v(`t=${Math.floor(NOW / 1000)},v1=nothex`)).toEqual({ ok: false, code: "signature_invalid" })
  })
  it("a body whose JSON was re-serialized is a different body (the signature binds the bytes)", () => {
    expect(v(sign(body), JSON.stringify(JSON.parse(body), null, 2))).toEqual({ ok: false, code: "signature_invalid" })
  })
  it("digests the raw body deterministically", () => {
    expect(payloadDigest(body)).toMatch(/^[0-9a-f]{64}$/)
    expect(payloadDigest(body)).toBe(payloadDigest(body))
    expect(payloadDigest(body)).not.toBe(payloadDigest(body + " "))
  })
})

describe("envelope refusal and normalization (after the signature)", () => {
  it("refuses Connect envelopes, live events and live or unmarked objects", () => {
    expect(parseVerifiedWebhook(event({ account: "acct_Connected1" }))).toEqual({ ok: false, code: "connect_event_refused" })
    expect(parseVerifiedWebhook(event({ livemode: true }))).toEqual({ ok: false, code: "live_event_refused" })
    expect(parseVerifiedWebhook(event({}, { ...SUB, livemode: true }))).toEqual({ ok: false, code: "live_object_refused" })
    const { livemode: _omit, ...unmarked } = SUB
    expect(parseVerifiedWebhook(event({}, unmarked))).toEqual({ ok: false, code: "live_object_refused" })
    expect(parseVerifiedWebhook(event({}, { ...SUB, id: "sub_live_Something" }))).toEqual({ ok: false, code: "live_object_refused" })
  })
  it("refuses malformed input without throwing", () => {
    expect(parseVerifiedWebhook("not json")).toEqual({ ok: false, code: "invalid_json" })
    expect(parseVerifiedWebhook(JSON.stringify({ id: "x" }))).toEqual({ ok: false, code: "invalid_envelope" })
    expect(parseVerifiedWebhook(event({ id: "evt_" }))).toEqual({ ok: false, code: "invalid_envelope" })
    expect(parseVerifiedWebhook(event({}, { ...SUB, customer: "acct_NotACustomer" }))).toEqual({ ok: false, code: "invalid_object" })
  })
  it("ignores event types it does not own and non-subscription Checkouts", () => {
    expect(parseVerifiedWebhook(event({ type: "customer.created" }))).toMatchObject({ ok: true, kind: "ignored" })
    expect(parseVerifiedWebhook(event({ type: "checkout.session.completed" }, { id: "cs_test_Pay00001", object: "checkout.session", livemode: false, mode: "payment", customer: "cus_Unit0001" }))).toMatchObject({ kind: "ignored" })
  })
  it("normalizes a subscription: exact approved item, verified period, server-checkable bindings", () => {
    const parsed = parseVerifiedWebhook(event())
    expect(parsed).toMatchObject({ ok: true, kind: "handled" })
    if (!parsed.ok || parsed.kind !== "handled") throw new Error("unreachable")
    expect(parsed.event.facts).toMatchObject({
      object: "subscription", subscription_id: "sub_Unit0001", customer_id: "cus_Unit0001", status: "active",
      price_lookup_key: FOUNDER_PILOT_PRICE.lookupKey, catalog_version: "2026-11-03.v1", plan_key: "founder-pilot",
      period_start: new Date(1_790_000_000_000).toISOString(), period_end: new Date(1_792_592_000_000).toISOString(),
      started_at: new Date(1_790_000_000_000).toISOString(),
    })
  })
  it("a wrong price, quantity or extra line is not the approved item; a period that disagrees is unverified", () => {
    const facts = (object: Record<string, unknown>) => {
      const p = parseVerifiedWebhook(event({}, object))
      if (!p.ok || p.kind !== "handled") throw new Error("unreachable")
      return p.event.facts
    }
    const price = (lookup_key: string) => ({ ...SUB, items: { data: [{ quantity: 1, price: { lookup_key } }] } })
    expect(facts(price("some_other_price")).price_lookup_key).toBe("invalid_items")
    expect(facts({ ...SUB, items: { data: [{ quantity: 2, price: { lookup_key: FOUNDER_PILOT_PRICE.lookupKey } }] } }).price_lookup_key).toBe("invalid_items")
    expect(facts({ ...SUB, items: { data: [...SUB.items.data, ...SUB.items.data] } }).price_lookup_key).toBe("invalid_items")
    expect(facts({ ...SUB, items: { data: [] } }).price_lookup_key).toBe("invalid_items")
    // Newer API shape: the period lives on the item.
    const { current_period_start: _s, current_period_end: _e, ...noTop } = SUB
    const moved = facts({ ...noTop, items: { data: [{ quantity: 1, current_period_start: 1_790_000_000, current_period_end: 1_792_592_000, price: { lookup_key: FOUNDER_PILOT_PRICE.lookupKey } }] } })
    expect(moved.period_start).toBe(new Date(1_790_000_000_000).toISOString())
    // Top-level and item disagree: unverified, never guessed.
    const disagree = facts({ ...SUB, items: { data: [{ quantity: 1, current_period_start: 1_790_000_999, current_period_end: 1_792_592_000, price: { lookup_key: FOUNDER_PILOT_PRICE.lookupKey } }] } })
    expect(disagree.period_start).toBeNull()
    expect(facts({ ...SUB, current_period_end: SUB.current_period_start }).period_start).toBeNull()
  })
  it("normalizes payment failure, refund, credit and Checkout observations as facts only", () => {
    const invoice = { id: "in_Unit0001", object: "invoice", livemode: false, customer: "cus_Unit0001", subscription: "sub_Unit0001", amount_due: 19900, amount_paid: 0, currency: "USD", attempt_count: 2 }
    const failed = parseVerifiedWebhook(event({ type: "invoice.payment_failed" }, invoice))
    expect(failed).toMatchObject({ ok: true, kind: "handled", event: { facts: { object: "invoice", outcome: "payment_failed", amount_cents: 19900, currency: "usd", attempt_count: 2 } } })
    const paid = parseVerifiedWebhook(event({ type: "invoice.paid" }, { ...invoice, amount_paid: 19900 }))
    expect(paid).toMatchObject({ event: { facts: { outcome: "payment_succeeded", amount_cents: 19900 } } })
    const refund = parseVerifiedWebhook(event({ type: "charge.refunded" }, { id: "ch_Unit0001", object: "charge", livemode: false, customer: "cus_Unit0001", invoice: "in_Unit0001", amount_refunded: 5000, currency: "usd" }))
    expect(refund).toMatchObject({ event: { facts: { object: "charge", amount_cents: 5000, object_id: "ch_Unit0001" } } })
    const credit = parseVerifiedWebhook(event({ type: "credit_note.created" }, { id: "cn_Unit0001", object: "credit_note", livemode: false, customer: "cus_Unit0001", invoice: "in_Unit0001", amount: 2500, currency: "usd" }))
    expect(credit).toMatchObject({ event: { facts: { object: "credit_note", amount_cents: 2500 } } })
    const done = parseVerifiedWebhook(event({ type: "checkout.session.completed" }, { id: "cs_test_Unit0001", object: "checkout.session", livemode: false, mode: "subscription", customer: "cus_Unit0001", subscription: "sub_Unit0001" }))
    expect(done).toMatchObject({ event: { facts: { object: "checkout_session", outcome: "completed" } } })
    expect(parseVerifiedWebhook(event({ type: "invoice.payment_failed" }, { ...invoice, amount_due: -1 }))).toEqual({ ok: false, code: "invalid_object" })
    // A live Checkout id can never be normalized.
    expect(parseVerifiedWebhook(event({ type: "checkout.session.completed" }, { id: "cs_live_Unit0001", object: "checkout.session", livemode: false, mode: "subscription" }))).toEqual({ ok: false, code: "live_object_refused" })
  })
})

describe("handleCommercialWebhook ordering and mapping", () => {
  const config = { ok: true as const, secret: SECRET }
  const service = (rpc: (name: string, args: Record<string, unknown>) => unknown) =>
    ({ rpc: vi.fn(async (name: string, args: Record<string, unknown>) => rpc(name, args)) }) as unknown as SupabaseClient & { rpc: ReturnType<typeof vi.fn> }
  const run = (rawBody: string, header: string | null, svc: SupabaseClient, cfg: Parameters<typeof handleCommercialWebhook>[0]["config"] = config) =>
    handleCommercialWebhook({ getService: () => svc, config: cfg, nowMs: NOW }, { rawBody, signatureHeader: header })

  it("is a 503 that touches nothing when unconfigured or misconfigured", async () => {
    const getService = vi.fn()
    const r = await handleCommercialWebhook({ getService, config: { ok: false, reason: "webhook_unconfigured" } }, { rawBody: event(), signatureHeader: sign(event()) })
    expect(r).toEqual({ status: 503, body: { received: false, error: "webhook_unconfigured" } })
    expect(getService).not.toHaveBeenCalled()
  })
  it("verifies the signature BEFORE parsing: a bad signature never reaches the parser or the database", async () => {
    const svc = service(() => ({ data: null, error: null }))
    // Invalid JSON with a bad signature is a signature failure (the body was never parsed).
    expect((await run("not json", sign("not json", "whsec_" + "c".repeat(32)), svc)).body).toEqual({ received: false, error: "invalid_signature" })
    expect((await run(event(), null, svc)).status).toBe(400)
    expect(svc.rpc).not.toHaveBeenCalled()
    // Invalid JSON with a GOOD signature is a parse failure.
    expect((await run("not json", sign("not json"), svc)).body).toEqual({ received: false, error: "invalid_json" })
  })
  it("refuses Connect and live events after the signature and never calls the database", async () => {
    const svc = service(() => ({ data: null, error: null }))
    for (const [raw, code] of [
      [event({ account: "acct_Connected1" }), "connect_event_refused"],
      [event({ livemode: true }), "live_event_refused"],
      [event({}, { ...SUB, livemode: true }), "live_object_refused"],
    ] as const) {
      expect(await run(raw, sign(raw), svc)).toEqual({ status: 400, body: { received: false, error: code } })
    }
    expect(svc.rpc).not.toHaveBeenCalled()
  })
  it("acknowledges ignored types without a database write, and refuses oversize bodies", async () => {
    const svc = service(() => ({ data: null, error: null }))
    const raw = event({ type: "customer.created" })
    expect(await run(raw, sign(raw), svc)).toEqual({ status: 200, body: { received: true, outcome: "ignored" } })
    expect(svc.rpc).not.toHaveBeenCalled()
    const big = "x".repeat(COMMERCIAL_WEBHOOK_MAX_BODY_BYTES + 1)
    expect((await run(big, sign(big), svc)).status).toBe(413)
  })
  it("sends only normalized facts and the raw-body digest to the database, test mode only", async () => {
    const svc = service(() => ({ data: { outcome: "applied", reason: null, shop_id: null, replayed: false }, error: null }))
    const raw = event()
    const r = await run(raw, sign(raw), svc)
    expect(r).toEqual({ status: 200, body: { received: true, outcome: "applied", replayed: false } })
    expect(svc.rpc).toHaveBeenCalledTimes(1)
    const [name, args] = svc.rpc.mock.calls[0] as [string, Record<string, unknown>]
    expect(name).toBe("commercial_webhook_ingest")
    expect(args).toMatchObject({ p_event_id: "evt_Unit000001", p_livemode: false, p_payload_digest: payloadDigest(raw) })
    // The application never names a tenant: the shop id is not an argument.
    expect(Object.keys(args)).not.toContain("p_shop")
    expect(JSON.stringify(args)).not.toContain(SECRET)
  })
  it("maps database failures: conflict 409, invalid 400, anything else 500 so Stripe retries", async () => {
    const raw = event()
    const fail = (code: string) => service(() => ({ data: null, error: { code, message: "x" } }))
    expect((await run(raw, sign(raw), fail("CB409"))).status).toBe(409)
    expect((await run(raw, sign(raw), fail("22023"))).status).toBe(400)
    expect((await run(raw, sign(raw), fail("XX000"))).status).toBe(500)
    expect((await run(raw, sign(raw), service(() => ({ data: { outcome: "weird" }, error: null })))).status).toBe(500)
    const throwing = await handleCommercialWebhook({ getService: () => { throw new Error("no env") }, config, nowMs: NOW }, { rawBody: raw, signatureHeader: sign(raw) })
    expect(throwing.status).toBe(500)
  })
})

describe("Customer Portal client (test mode, platform account only)", () => {
  const config = { secretKey: "sk_test_" + "k".repeat(24), apiBase: "http://127.0.0.1:1/v1", timeoutMs: 1000 }
  const portal = { id: "bps_Unit0001", object: "billing_portal.session", livemode: false, customer: "cus_Unit0001", url: "https://billing.stripe.com/p/session/test_abc" }
  const withFetch = async (reply: unknown, status = 200) => {
    const seen: { url: string; init: RequestInit }[] = []
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, init })
      return new Response(typeof reply === "string" ? reply : JSON.stringify(reply), { status })
    }))
    try {
      const out = await createPlatformPortalClient(config).createBillingPortalSession({ customerId: "cus_Unit0001", returnUrl: "https://app.gradia.example/billing?billing_return=portal" }).then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e }))
      return { out, seen }
    } finally {
      vi.unstubAllGlobals()
    }
  }
  it("posts the exact bound customer and return URL with no connected-account header", async () => {
    const { out, seen } = await withFetch(portal)
    expect(out).toEqual({ ok: true, v: { url: portal.url } })
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe("http://127.0.0.1:1/v1/billing_portal/sessions")
    const headers = new Headers(seen[0].init.headers)
    expect(headers.get("stripe-account")).toBeNull()
    expect(String(seen[0].init.body)).toContain("customer=cus_Unit0001")
    expect(String(seen[0].init.body)).toContain("return_url=")
  })
  it("refuses a live-mode, mismatched, off-host or unreadable reply and returns no URL", async () => {
    for (const reply of [
      { ...portal, livemode: true },
      { ...portal, customer: "cus_Other0001" },
      { ...portal, url: "https://evil.example/p" },
      { ...portal, url: "http://billing.stripe.com/p" },
      { ...portal, url: "https://user:pw@billing.stripe.com/p" },
      { ...portal, object: "checkout.session" },
      "not json",
    ]) {
      const { out } = await withFetch(reply)
      expect(out.ok, JSON.stringify(reply)).toBe(false)
    }
    const { out } = await withFetch({ error: { message: "no" } }, 500)
    expect(out.ok).toBe(false)
    expect((out as { e: unknown }).e).toBeInstanceOf(StripeError)
  })
  it("builds the return URL only from the server origin and an allowlisted target", () => {
    expect(buildPortalReturnUrl("https://app.gradia.example", "billing")).toEqual({ ok: true, returnUrl: "https://app.gradia.example/billing?billing_return=portal" })
    expect(buildPortalReturnUrl("https://app.gradia.example/ignored/path?x=1", "agents")).toEqual({ ok: true, returnUrl: "https://app.gradia.example/agents?billing_return=portal" })
    expect(buildPortalReturnUrl("http://localhost:3000", "billing")).toMatchObject({ ok: true })
    expect(buildPortalReturnUrl("http://app.gradia.example", "billing")).toEqual({ ok: false, reason: "return_origin_unconfigured" })
    expect(buildPortalReturnUrl(undefined, "billing")).toEqual({ ok: false, reason: "return_origin_unconfigured" })
    expect(buildPortalReturnUrl("https://u:p@app.gradia.example", "billing")).toEqual({ ok: false, reason: "return_origin_unconfigured" })
  })
})

describe("lapse gate interpretation", () => {
  it("allows only an unambiguous allow; unreadable or contradictory answers block", () => {
    expect(interpretExecutionGate({ allowed: true, mode: "commercial", state: "active", reason: null })).toEqual({ allowed: true, mode: "commercial" })
    expect(interpretExecutionGate({ allowed: true, mode: "legacy_no_commercial_account", state: null, reason: null })).toEqual({ allowed: true, mode: "legacy_no_commercial_account" })
    expect(interpretExecutionGate({ allowed: false, mode: "commercial", state: "past_due", reason: "subscription_past_due" })).toEqual({ allowed: false, reason: "subscription_past_due", state: "past_due" })
    expect(interpretExecutionGate({ allowed: false, mode: "commercial", state: "unknown", reason: null })).toMatchObject({ allowed: false, reason: "billing_state_unavailable" })
    expect(interpretExecutionGate({ allowed: true, mode: "commercial", state: "active", reason: "subscription_past_due" })).toMatchObject({ allowed: false })
    for (const bad of [null, undefined, "yes", 1, {}, { allowed: "true", mode: "commercial" }, { allowed: true, mode: "invented" }]) {
      expect(interpretExecutionGate(bad), JSON.stringify(bad)).toMatchObject({ allowed: false, reason: "billing_state_unavailable" })
    }
  })
})
