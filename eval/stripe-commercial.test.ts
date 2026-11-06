import { afterEach, describe, expect, it, vi } from "vitest"

import { COMMERCIAL_CATALOG_VERSION } from "@/lib/commercial-billing"
import { StripeError } from "@/lib/stripe"
import {
  createPlatformStripeClient,
  isDefinitiveRejection,
  resolveCommercialStripeConfig,
  verifyFounderPilotPrice,
} from "@/lib/stripe-commercial"

const TEST_KEY = "sk_test_FAKEFAKEFAKEFAKE0123"
const GOOD_ENV = {
  GRADIA_COMMERCIAL_BILLING_STRIPE_MODE: "test",
  STRIPE_SECRET_KEY: TEST_KEY,
  GRADIA_DASHBOARD_URL: "https://app.gradia.example",
}

const goodPrice = (patch: Record<string, unknown> = {}) => ({
  id: "price_fake_founder_pilot",
  object: "price",
  active: true,
  currency: "usd",
  lookup_key: "gradia_founder_pilot_2026_11_monthly",
  type: "recurring",
  unit_amount: 19_900,
  billing_scheme: "per_unit",
  livemode: false,
  recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
  ...patch,
})
const list = (...prices: unknown[]) => ({ object: "list", data: prices })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("sandbox configuration gate", () => {
  it("is disabled by default when anything is absent", () => {
    expect(resolveCommercialStripeConfig({})).toEqual({ ok: false, reason: "billing_unconfigured" })
    expect(resolveCommercialStripeConfig({ STRIPE_SECRET_KEY: TEST_KEY })).toEqual({ ok: false, reason: "billing_unconfigured" })
    expect(resolveCommercialStripeConfig({ GRADIA_COMMERCIAL_BILLING_STRIPE_MODE: "test" })).toEqual({ ok: false, reason: "billing_unconfigured" })
  })

  it("accepts the complete test configuration", () => {
    const result = resolveCommercialStripeConfig(GOOD_ENV)
    expect(result).toMatchObject({ ok: true, returnOrigin: "https://app.gradia.example" })
    if (result.ok) expect(result.config.apiBase).toBe("https://api.stripe.com/v1")
  })

  it.each([
    ["a live secret key", { STRIPE_SECRET_KEY: "sk_live_FAKEFAKEFAKEFAKE0123" }],
    ["a live restricted key", { STRIPE_SECRET_KEY: "rk_live_FAKEFAKEFAKEFAKE0123" }],
    ["a live key even with the test flag", { STRIPE_SECRET_KEY: "sk_live_x1234567890abcdef" }],
    ["a key of unknown shape", { STRIPE_SECRET_KEY: "whsec_FAKEFAKEFAKEFAKE0123" }],
    ["a too-short test key", { STRIPE_SECRET_KEY: "sk_test_a" }],
    ["mode 'live'", { GRADIA_COMMERCIAL_BILLING_STRIPE_MODE: "live" }],
    ["mode 'TEST' (ambiguous casing)", { GRADIA_COMMERCIAL_BILLING_STRIPE_MODE: "TEST" }],
    ["mode 'true'", { GRADIA_COMMERCIAL_BILLING_STRIPE_MODE: "true" }],
    ["a non-Stripe API base", { STRIPE_API_BASE: "https://evil.example/v1" }],
    ["a lookalike API base", { STRIPE_API_BASE: "https://api.stripe.com.evil.example/v1" }],
    ["a plain-http Stripe base", { STRIPE_API_BASE: "http://api.stripe.com/v1" }],
    ["an API base with credentials", { STRIPE_API_BASE: "http://user:pw@127.0.0.1:9/v1" }],
    ["an unparseable API base", { STRIPE_API_BASE: "not a url" }],
  ])("refuses %s as misconfigured", (_name, patch) => {
    expect(resolveCommercialStripeConfig({ ...GOOD_ENV, ...patch })).toEqual({ ok: false, reason: "billing_misconfigured" })
  })

  it("allows a loopback fixture base and nothing else", () => {
    const result = resolveCommercialStripeConfig({ ...GOOD_ENV, STRIPE_API_BASE: "http://127.0.0.1:8123/v1/" })
    expect(result).toMatchObject({ ok: true })
    if (result.ok) expect(result.config.apiBase).toBe("http://127.0.0.1:8123/v1")
  })

  it("never echoes a secret in the refusal", () => {
    const result = resolveCommercialStripeConfig({ ...GOOD_ENV, STRIPE_SECRET_KEY: "sk_live_SECRETSECRETSECRET1" })
    expect(JSON.stringify(result)).not.toContain("SECRET")
  })
})

describe("approved Price verification (by lookup key, never by name or amount alone)", () => {
  it("accepts exactly the approved recurring USD $199/month price", () => {
    expect(verifyFounderPilotPrice(list(goodPrice()))).toEqual({ ok: true, priceId: "price_fake_founder_pilot" })
  })

  it.each([
    ["no price", list(), "price_missing"],
    ["two prices", list(goodPrice(), goodPrice({ id: "price_fake_two" })), "price_ambiguous"],
    ["a lookup mismatch", list(goodPrice({ lookup_key: "gradia_other" })), "price_lookup_mismatch"],
    ["no lookup key", list(goodPrice({ lookup_key: null })), "price_lookup_mismatch"],
    ["an inactive price", list(goodPrice({ active: false })), "price_inactive"],
    ["the wrong currency", list(goodPrice({ currency: "eur" })), "price_currency_mismatch"],
    ["the wrong amount", list(goodPrice({ unit_amount: 2_000 })), "price_amount_mismatch"],
    ["a null amount", list(goodPrice({ unit_amount: null })), "price_amount_mismatch"],
    ["a one-time price", list(goodPrice({ type: "one_time", recurring: null })), "price_amount_mismatch"],
    ["a tiered price", list(goodPrice({ billing_scheme: "tiered" })), "price_amount_mismatch"],
    ["a yearly interval", list(goodPrice({ recurring: { interval: "year", interval_count: 1, usage_type: "licensed" } })), "price_interval_mismatch"],
    ["a 3-month interval", list(goodPrice({ recurring: { interval: "month", interval_count: 3, usage_type: "licensed" } })), "price_interval_mismatch"],
    ["metered usage", list(goodPrice({ recurring: { interval: "month", interval_count: 1, usage_type: "metered" } })), "price_usage_mismatch"],
    ["a live-mode price", list(goodPrice({ livemode: true })), "price_live_object"],
    ["a malformed payload", { data: "nope" }, "price_invalid_response"],
    ["a malformed price", list({ id: "price_x" }), "price_invalid_response"],
  ])("fails closed on %s", (_name, payload, code) => {
    expect(verifyFounderPilotPrice(payload)).toEqual({ ok: false, code })
  })
})

describe("error classification", () => {
  it("treats only 4xx rejections as definitive", () => {
    for (const status of [400, 401, 402, 403, 404]) expect(isDefinitiveRejection(new StripeError(status, "x"))).toBe(true)
    for (const status of [0, 409, 429, 500, 502, 503, 504]) expect(isDefinitiveRejection(new StripeError(status, "x"))).toBe(false)
    expect(isDefinitiveRejection(new Error("boom"))).toBe(false)
  })
})

// A recording fetch stand-in. Nothing here touches the network.
function fixtureFetch(responder: (url: URL, init: RequestInit) => { status?: number; body: unknown } | Promise<never>) {
  const calls: { url: URL; init: RequestInit; headers: Record<string, string>; body: URLSearchParams }[] = []
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const result = await responder(url, init ?? {})
    calls.push({
      url,
      init: init ?? {},
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: new URLSearchParams(typeof init?.body === "string" ? init.body : (url.search || "")),
    })
    return new Response(JSON.stringify(result.body), { status: result.status ?? 200 })
  })
  vi.stubGlobal("fetch", impl)
  return calls
}

const config = { secretKey: TEST_KEY, apiBase: "https://api.stripe.com/v1", timeoutMs: 5_000 }
const SHOP = "00000000-0000-4000-8000-0000000000aa"
const ATTEMPT = "00000000-0000-4000-8000-0000000000bb"

describe("platform Stripe client", () => {
  it("looks up the price by lookup key on the PLATFORM account, read-only", async () => {
    const calls = fixtureFetch(() => ({ body: list(goodPrice()) }))
    const result = await createPlatformStripeClient(config).verifyFounderPilotPrice()
    expect(result).toEqual({ ok: true, priceId: "price_fake_founder_pilot" })
    expect(calls).toHaveLength(1)
    expect(calls[0].init.method).toBe("GET")
    expect(calls[0].url.pathname).toBe("/v1/prices")
    expect(calls[0].url.searchParams.get("lookup_keys[0]")).toBe("gradia_founder_pilot_2026_11_monthly")
    expect(calls[0].headers["Stripe-Version"]).toBe("2024-06-20")
    expect(calls[0].headers.Authorization).toBe(`Bearer ${TEST_KEY}`)
    expect(calls[0].headers).not.toHaveProperty("Stripe-Account")
    expect(calls[0].headers).not.toHaveProperty("Idempotency-Key")
  })

  it("creates the platform customer with a stable idempotency key and tenant metadata, never Connect", async () => {
    const calls = fixtureFetch(() => ({ body: { id: "cus_FakeCustomer1", object: "customer", livemode: false } }))
    const out = await createPlatformStripeClient(config).createCustomer({ shopId: SHOP, idempotencyKey: `gradia-cb-customer-${SHOP}` })
    expect(out).toEqual({ customerId: "cus_FakeCustomer1" })
    expect(calls[0].headers["Idempotency-Key"]).toBe(`gradia-cb-customer-${SHOP}`)
    expect(calls[0].headers).not.toHaveProperty("Stripe-Account")
    expect(calls[0].body.get("metadata[shop_id]")).toBe(SHOP)
    expect(calls[0].body.get("metadata[catalog_version]")).toBe(COMMERCIAL_CATALOG_VERSION)
    // No connected-account material anywhere in the request.
    expect(calls[0].init.body as string).not.toMatch(/acct_/)
  })

  it("binds the Checkout Session to shop, catalog and local attempt, with no trial", async () => {
    const calls = fixtureFetch(() => ({
      body: {
        id: "cs_test_FakeSession1",
        object: "checkout.session",
        livemode: false,
        mode: "subscription",
        status: "open",
        url: "https://checkout.stripe.com/c/pay/cs_test_FakeSession1",
        customer: "cus_FakeCustomer1",
        client_reference_id: ATTEMPT,
        metadata: {},
      },
    }))
    const session = await createPlatformStripeClient(config).createCheckoutSession({
      priceId: "price_fake_founder_pilot",
      customerId: "cus_FakeCustomer1",
      shopId: SHOP,
      attemptId: ATTEMPT,
      successUrl: "https://app.gradia.example/receptionist?billing_return=success",
      cancelUrl: "https://app.gradia.example/receptionist?billing_return=canceled",
      idempotencyKey: `gradia-cb-session-${ATTEMPT}`,
    })
    expect(session).toEqual({ id: "cs_test_FakeSession1", status: "open", url: "https://checkout.stripe.com/c/pay/cs_test_FakeSession1" })
    const body = calls[0].body
    expect(calls[0].url.pathname).toBe("/v1/checkout/sessions")
    expect(calls[0].headers["Idempotency-Key"]).toBe(`gradia-cb-session-${ATTEMPT}`)
    expect(body.get("mode")).toBe("subscription")
    expect(body.get("customer")).toBe("cus_FakeCustomer1")
    expect(body.get("line_items[0][price]")).toBe("price_fake_founder_pilot")
    expect(body.get("line_items[0][quantity]")).toBe("1")
    expect(body.get("client_reference_id")).toBe(ATTEMPT)
    for (const prefix of ["metadata", "subscription_data[metadata]"]) {
      const key = (name: string) => (prefix === "metadata" ? `metadata[${name}]` : `subscription_data[metadata][${name}]`)
      expect(body.get(key("shop_id"))).toBe(SHOP)
      expect(body.get(key("catalog_version"))).toBe(COMMERCIAL_CATALOG_VERSION)
      expect(body.get(key("plan_key"))).toBe("founder-pilot")
      expect(body.get(key("checkout_attempt_id"))).toBe(ATTEMPT)
    }
    // There is no Stripe trial; the 14 days are pre-activation build/test access.
    expect([...body.keys()].some((k) => /trial/i.test(k))).toBe(false)
    // Only one line item: no guessed seat/PAYG quantities.
    expect(body.get("line_items[1][price]")).toBeNull()
    expect(body.get("success_url")).toContain("billing_return=success")
    expect(body.get("payment_method_collection")).toBe("always")
    expect(calls[0].headers).not.toHaveProperty("Stripe-Account")
  })

  it("refuses a live-mode object from the provider", async () => {
    fixtureFetch(() => ({ body: { id: "cus_FakeCustomer1", object: "customer", livemode: true } }))
    await expect(createPlatformStripeClient(config).createCustomer({ shopId: SHOP, idempotencyKey: "k-xxxxxxxxxxxxxxxx" })).rejects.toMatchObject({
      code: "live_object_refused",
    })
  })

  it("never returns a URL that is not the Stripe-hosted Checkout origin", async () => {
    fixtureFetch(() => ({
      body: {
        id: "cs_test_FakeSession1", object: "checkout.session", livemode: false, mode: "subscription",
        status: "open", url: "https://evil.example/pay", customer: "cus_FakeCustomer1", client_reference_id: ATTEMPT, metadata: {},
      },
    }))
    const session = await createPlatformStripeClient(config).createCheckoutSession({
      priceId: "price_fake_founder_pilot", customerId: "cus_FakeCustomer1", shopId: SHOP, attemptId: ATTEMPT,
      successUrl: "https://app.gradia.example/r", cancelUrl: "https://app.gradia.example/r", idempotencyKey: "k-xxxxxxxxxxxxxxxx",
    })
    expect(session.url).toBeNull()
  })

  it("verifies a retrieved session is bound to this shop, catalog, attempt and customer", async () => {
    const session = (patch: Record<string, unknown> = {}, metaPatch: Record<string, string> = {}) => ({
      id: "cs_test_FakeSession1", object: "checkout.session", livemode: false, mode: "subscription", status: "open",
      url: "https://checkout.stripe.com/c/pay/cs_test_FakeSession1", customer: "cus_FakeCustomer1", client_reference_id: ATTEMPT,
      metadata: { shop_id: SHOP, checkout_attempt_id: ATTEMPT, catalog_version: COMMERCIAL_CATALOG_VERSION, plan_key: "founder-pilot", ...metaPatch },
      ...patch,
    })
    const binding = { shopId: SHOP, attemptId: ATTEMPT, customerId: "cus_FakeCustomer1" }
    const client = createPlatformStripeClient(config)

    fixtureFetch(() => ({ body: session() }))
    expect(await client.retrieveCheckoutSession({ sessionId: "cs_test_FakeSession1", binding })).toMatchObject({ ok: true, session: { status: "open" } })

    for (const [name, payload] of [
      ["another shop", session({}, { shop_id: "00000000-0000-4000-8000-0000000000cc" })],
      ["another attempt", session({ client_reference_id: "00000000-0000-4000-8000-0000000000dd" })],
      ["another catalog", session({}, { catalog_version: "2025-01-01.v1" })],
      ["another customer", session({ customer: "cus_SomeoneElse9" })],
      ["a payment-mode session", session({ mode: "payment" })],
    ] as const) {
      fixtureFetch(() => ({ body: payload }))
      expect(await client.retrieveCheckoutSession({ sessionId: "cs_test_FakeSession1", binding }), name).toEqual({
        ok: false,
        code: "session_binding_mismatch",
      })
    }
  })

  it("surfaces a hung provider as an AMBIGUOUS timeout, not a rejection", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      const err = new Error("The operation timed out")
      err.name = "TimeoutError"
      throw err
    }))
    const error = await createPlatformStripeClient(config).createCustomer({ shopId: SHOP, idempotencyKey: "k-xxxxxxxxxxxxxxxx" }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(StripeError)
    expect(error).toMatchObject({ status: 0, code: "timeout" })
    expect(isDefinitiveRejection(error)).toBe(false)
  })

  it("surfaces transport failures and unreadable 2xx bodies as ambiguous", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed") }))
    const transport = await createPlatformStripeClient(config).createCustomer({ shopId: SHOP, idempotencyKey: "k-xxxxxxxxxxxxxxxx" }).catch((e: unknown) => e)
    expect(isDefinitiveRejection(transport)).toBe(false)

    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>not json</html>", { status: 200 })))
    const unreadable = await createPlatformStripeClient(config).createCustomer({ shopId: SHOP, idempotencyKey: "k-xxxxxxxxxxxxxxxx" }).catch((e: unknown) => e)
    expect(unreadable).toMatchObject({ status: 0, code: "unreadable_response" })

    fixtureFetch(() => ({ body: { id: "cus_x" } }))
    const shape = await createPlatformStripeClient(config).createCustomer({ shopId: SHOP, idempotencyKey: "k-xxxxxxxxxxxxxxxx" }).catch((e: unknown) => e)
    expect(isDefinitiveRejection(shape)).toBe(false)
  })

  it("a 5xx or 409 from the provider is ambiguous; a 400 is a definitive rejection", async () => {
    for (const [status, definitive] of [[500, false], [409, false], [429, false], [400, true], [404, true]] as const) {
      fixtureFetch(() => ({ status, body: { error: { message: "nope", code: "x" } } }))
      const error = await createPlatformStripeClient(config).createCustomer({ shopId: SHOP, idempotencyKey: "k-xxxxxxxxxxxxxxxx" }).catch((e: unknown) => e)
      expect(isDefinitiveRejection(error), String(status)).toBe(definitive)
    }
  })

  it("does not leak the key, URLs or payloads in thrown errors", async () => {
    fixtureFetch(() => ({ status: 400, body: { error: { message: "No such price", code: "resource_missing" } } }))
    const error = await createPlatformStripeClient(config).verifyFounderPilotPrice().catch((e: unknown) => e)
    expect(String((error as Error).message)).not.toContain(TEST_KEY)
  })
})
