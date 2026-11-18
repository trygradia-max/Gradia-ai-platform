import { afterEach, describe, expect, it, vi } from "vitest"

import { COMMERCIAL_CATALOG_VERSION } from "@/lib/commercial-billing"
import { StripeError } from "@/lib/stripe"
import {
  createPlatformStripeClient,
  isDefinitiveRejection,
  resolveCommercialStripeConfig,
} from "@/lib/stripe-commercial"
import { COMMERCIAL_METER_API_VERSION } from "@/lib/stripe-sandbox-contract"
import { FakeStripeSandbox } from "./_fake-stripe-sandbox"
import { exactFixtureItems } from "./_commercial-item-fixtures"

const TEST_KEY = "sk_test_FAKEFAKEFAKEFAKE0123"
const GOOD_ENV = {
  GRADIA_COMMERCIAL_BILLING_STRIPE_MODE: "test",
  STRIPE_SECRET_KEY: TEST_KEY,
  GRADIA_DASHBOARD_URL: "https://app.gradia.example",
}

const LINE_ITEMS = [
  { priceId: "price_Fake_base", quantity: 1 as const },
  { priceId: "price_Fake_standard_digital_outcome" },
  { priceId: "price_Fake_qualified_lead" },
  { priceId: "price_Fake_confirmed_appointment" },
  { priceId: "price_Fake_inbound_voice_agent_minute" },
  { priceId: "price_Fake_sms_segment" },
  { priceId: "price_Fake_extra_operator_seat_proration" },
]

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
    return new Response(JSON.stringify(result.body), { status: result.status ?? 200, headers: { "Stripe-Version": COMMERCIAL_METER_API_VERSION } })
  })
  vi.stubGlobal("fetch", impl)
  return calls
}

const config = { secretKey: TEST_KEY, apiBase: "https://api.stripe.com/v1", timeoutMs: 5_000 }
const SHOP = "00000000-0000-4000-8000-0000000000aa"
const ATTEMPT = "00000000-0000-4000-8000-0000000000bb"

describe("platform Stripe client", () => {
  it("resolves the EXACT item set by lookup keys on the PLATFORM account, read-only, at the reviewed API version", async () => {
    const fake = FakeStripeSandbox.provisioned(1_790_000_000)
    const calls = fixtureFetch((url) =>
      url.pathname === "/v1/prices"
        ? { body: { object: "list", data: fake.prices[url.searchParams.get("lookup_keys[0]") ?? ""] ?? [], has_more: false } }
        : { body: { object: "list", data: fake.meters, has_more: false } }
    )
    const result = await createPlatformStripeClient(config).resolveFounderPilotItemSet()
    expect(result).toEqual({
      ok: true,
      lineItems: [
        { priceId: "price_FakeBase1", quantity: 1 },
        ...["standard_digital_outcome", "qualified_lead", "confirmed_appointment", "inbound_voice_agent_minute", "sms_segment", "extra_operator_seat_proration"].map((c) => ({ priceId: `price_Fake_${c}` })),
      ],
    })
    // 7 price lookups + 1 meter list, GET only.
    expect(calls).toHaveLength(8)
    for (const call of calls) {
      expect(call.init.method).toBe("GET")
      expect(call.headers["Stripe-Version"]).toBe(COMMERCIAL_METER_API_VERSION)
      expect(call.headers.Authorization).toBe(`Bearer ${TEST_KEY}`)
      expect(call.headers).not.toHaveProperty("Stripe-Account")
      expect(call.headers).not.toHaveProperty("Idempotency-Key")
    }
  })

  it("refuses (never repairs) a sandbox that does not hold the exact set", async () => {
    const fake = FakeStripeSandbox.provisioned(1_790_000_000)
    delete fake.prices["gradia_fp_2026_11_sms_segment_metered"]
    fixtureFetch((url) =>
      url.pathname === "/v1/prices"
        ? { body: { object: "list", data: fake.prices[url.searchParams.get("lookup_keys[0]") ?? ""] ?? [], has_more: false } }
        : { body: { object: "list", data: fake.meters, has_more: false } }
    )
    const result = await createPlatformStripeClient(config).resolveFounderPilotItemSet()
    expect(result).toEqual({ ok: false, code: "item_set_price_missing" })
  })

  it("treats an unreachable sandbox as an ambiguous read (throws), not as 'not ready'", async () => {
    fixtureFetch(() => ({ status: 500, body: { error: { message: "x" } } }))
    await expect(createPlatformStripeClient(config).resolveFounderPilotItemSet()).rejects.toMatchObject({ code: "provider_unreachable" })
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
      lineItems: LINE_ITEMS,
      customerId: "cus_FakeCustomer1",
      shopId: SHOP,
      attemptId: ATTEMPT,
      successUrl: "https://app.gradia.example/agents?billing_return=success",
      cancelUrl: "https://app.gradia.example/agents?billing_return=canceled",
      idempotencyKey: `gradia-cb-session-${ATTEMPT}`,
    })
    expect(session).toEqual({ id: "cs_test_FakeSession1", status: "open", url: "https://checkout.stripe.com/c/pay/cs_test_FakeSession1" })
    const body = calls[0].body
    expect(calls[0].url.pathname).toBe("/v1/checkout/sessions")
    expect(calls[0].headers["Idempotency-Key"]).toBe(`gradia-cb-session-${ATTEMPT}`)
    expect(body.get("mode")).toBe("subscription")
    expect(body.get("customer")).toBe("cus_FakeCustomer1")
    expect(calls[0].headers["Stripe-Version"]).toBe(COMMERCIAL_METER_API_VERSION)
    // Licensed base x1, then six metered items with NO quantity (Stripe: must not be defined for metered).
    expect(body.get("line_items[0][price]")).toBe("price_Fake_base")
    expect(body.get("line_items[0][quantity]")).toBe("1")
    for (let i = 1; i <= 6; i += 1) {
      expect(body.get(`line_items[${i}][price]`)).toMatch(/^price_Fake_/)
      expect(body.get(`line_items[${i}][quantity]`)).toBeNull()
    }
    expect(body.get("line_items[7][price]")).toBeNull()
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
    // No guessed seat/PAYG quantities: metered items have none.
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
      lineItems: LINE_ITEMS, customerId: "cus_FakeCustomer1", shopId: SHOP, attemptId: ATTEMPT,
      successUrl: "https://app.gradia.example/r", cancelUrl: "https://app.gradia.example/r", idempotencyKey: "k-xxxxxxxxxxxxxxxx",
    })
    expect(session.url).toBeNull()
  })

  it.each([null, undefined, "", "unknown", "paid", "OPEN", 1])(
    "fails closed on a null or unknown session status (%s): never returns a Checkout URL",
    async (status) => {
      const body = {
        id: "cs_test_FakeSession1", object: "checkout.session", livemode: false, mode: "subscription",
        url: "https://checkout.stripe.com/c/pay/cs_test_FakeSession1", customer: "cus_FakeCustomer1", client_reference_id: ATTEMPT,
        metadata: { shop_id: SHOP, checkout_attempt_id: ATTEMPT, catalog_version: COMMERCIAL_CATALOG_VERSION, plan_key: "founder-pilot" },
        line_items: { data: exactFixtureItems() },
        ...(status === undefined ? {} : { status }),
      }
      const client = createPlatformStripeClient(config)
      fixtureFetch(() => ({ body }))
      const created = await client
        .createCheckoutSession({
          lineItems: LINE_ITEMS, customerId: "cus_FakeCustomer1", shopId: SHOP, attemptId: ATTEMPT,
          successUrl: "https://app.gradia.example/agents?billing_return=success",
          cancelUrl: "https://app.gradia.example/agents?billing_return=canceled",
          idempotencyKey: `gradia-cb-session-${ATTEMPT}`,
        })
        .then(() => null, (e: unknown) => e)
      // Ambiguous (the provider may have created it): reconciliation, never "open".
      expect(created).toMatchObject({ status: 0, code: "unreadable_response" })
      fixtureFetch(() => ({ body }))
      const binding = { shopId: SHOP, attemptId: ATTEMPT, customerId: "cus_FakeCustomer1" }
      const retrieved = await client
        .retrieveCheckoutSession({ sessionId: "cs_test_FakeSession1", binding })
        .then((r) => r, (e: unknown) => e)
      expect(retrieved).not.toMatchObject({ ok: true })
      expect(JSON.stringify(retrieved)).not.toContain("checkout.stripe.com")
    }
  )

  it("verifies a retrieved session is bound to this shop, catalog, attempt and customer", async () => {
    const session = (patch: Record<string, unknown> = {}, metaPatch: Record<string, string> = {}) => ({
      id: "cs_test_FakeSession1", object: "checkout.session", livemode: false, mode: "subscription", status: "open",
      url: "https://checkout.stripe.com/c/pay/cs_test_FakeSession1", customer: "cus_FakeCustomer1", client_reference_id: ATTEMPT,
      metadata: { shop_id: SHOP, checkout_attempt_id: ATTEMPT, catalog_version: COMMERCIAL_CATALOG_VERSION, plan_key: "founder-pilot", ...metaPatch },
      line_items: { data: exactFixtureItems() },
      ...patch,
    })
    const binding = { shopId: SHOP, attemptId: ATTEMPT, customerId: "cus_FakeCustomer1" }
    const client = createPlatformStripeClient(config)

    const retrievals = fixtureFetch(() => ({ body: session() }))
    expect(await client.retrieveCheckoutSession({ sessionId: "cs_test_FakeSession1", binding })).toMatchObject({ ok: true, session: { status: "open" } })
    expect(retrievals[0].url.searchParams.get("expand[0]")).toBe("line_items")
    expect(retrievals[0].headers["Stripe-Version"]).toBe(COMMERCIAL_METER_API_VERSION)
    // The exact set is order-independent.
    fixtureFetch(() => ({ body: session({ line_items: { data: [...exactFixtureItems()].reverse() } }) }))
    expect(await client.retrieveCheckoutSession({ sessionId: "cs_test_FakeSession1", binding })).toMatchObject({ ok: true })

    for (const [name, payload] of [
      ["another shop", session({}, { shop_id: "00000000-0000-4000-8000-0000000000cc" })],
      ["another attempt", session({ client_reference_id: "00000000-0000-4000-8000-0000000000dd" })],
      ["another catalog", session({}, { catalog_version: "2025-01-01.v1" })],
      ["another customer", session({ customer: "cus_SomeoneElse9" })],
      ["a payment-mode session", session({ mode: "payment" })],
      ["no expanded line items", session({ line_items: undefined })],
      ["only the base line item", session({ line_items: { data: exactFixtureItems().slice(0, 1) } })],
      ["an extra line item", session({ line_items: { data: [...exactFixtureItems(), ...exactFixtureItems().slice(0, 1)] } })],
      ["a missing metered line item", session({ line_items: { data: exactFixtureItems().slice(0, 6) } })],
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
    const error = await createPlatformStripeClient(config).resolveFounderPilotItemSet().catch((e: unknown) => e)
    expect(String((error as Error).message)).not.toContain(TEST_KEY)
  })
})
