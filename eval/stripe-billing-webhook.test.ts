import { afterEach, describe, expect, it, vi } from "vitest"

/**
 * P0-013 — Stripe subscription lifecycle for the three-tier model
 * (D-031/D-034/D-035). Tenancy properties (Connect isolation) are locked in
 * eval/stripe-webhook-tenancy.test.ts; this file locks the TIER lifecycle
 * the ticket's "Automated tests" section calls out: checkout-completed per
 * tier, upgrade/downgrade, deletion, pack grant, rollover with per-tier
 * credits, replay idempotency, and unknown price id.
 *
 * A tiny in-memory `shops` store lets scenarios chain (read current row →
 * apply the webhook's patch → assert the row afterward) without a real DB.
 */

type ShopRow = {
  id: string
  plan: string
  tier: string
  voice_addon: boolean
  voice_live: boolean
  stripe_subscription_id: string | null
  trial_ends_at: string | null
  credit_period_start: string
}

let shops: Record<string, ShopRow> = {}
let grants: Array<{ shop_id: string; kind: string; credits: number; minutes: number; stripe_ref: string | null }> = []
const grantRefs = new Set<string>()

function resetStore() {
  shops = {
    "shop-core": {
      id: "shop-core",
      plan: "free",
      tier: "core",
      voice_addon: false,
      voice_live: false,
      stripe_subscription_id: null,
      trial_ends_at: null,
      credit_period_start: "2026-06-01T00:00:00Z",
    },
    "shop-pro-sub": {
      id: "shop-pro-sub",
      plan: "active",
      tier: "pro",
      voice_addon: false,
      voice_live: true,
      stripe_subscription_id: "sub_pro_1",
      trial_ends_at: null,
      credit_period_start: "2026-06-01T00:00:00Z",
    },
  }
  grants = []
  grantRefs.clear()
}
resetStore()

function shopsSelectBuilder() {
  const filters: Record<string, unknown> = {}
  const self = {
    eq(col: string, val: unknown) {
      filters[col] = val
      return self
    },
    async maybeSingle() {
      const row =
        Object.values(shops).find((s) =>
          Object.entries(filters).every(([k, v]) => (s as Record<string, unknown>)[k] === v)
        ) ?? null
      return { data: row, error: null }
    },
  }
  return self
}

function shopsUpdateBuilder(values: Record<string, unknown>) {
  const filters: Record<string, unknown> = {}
  const self = {
    eq(col: string, val: unknown) {
      filters[col] = val
      return self
    },
    then(resolve: (v: { data: null; error: null }) => void) {
      const row = Object.values(shops).find((s) =>
        Object.entries(filters).every(([k, v]) => (s as Record<string, unknown>)[k] === v)
      )
      if (row) Object.assign(row, values)
      resolve({ data: null, error: null })
    },
  }
  return self
}

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

const tierFromPriceIdMock = vi.fn((priceId: string | null) => {
  if (priceId === "price_core") return "core"
  if (priceId === "price_pro") return "pro"
  if (priceId === "price_operator") return "operator"
  return null
})
const getSubscriptionMock = vi.fn(async (subscriptionId: string) => ({
  id: subscriptionId,
  status: "active",
  trialEnd: null,
  items: [{ itemId: "si_1", priceId: "price_pro" }],
}))

vi.mock("@/lib/stripe", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/stripe")>()
  return {
    ...original,
    verifyStripeSignature: vi.fn(() => true),
    getSubscription: (id: string) => getSubscriptionMock(id),
    tierFromPriceId: (priceId: string | null | undefined) => tierFromPriceIdMock(priceId ?? null),
  }
})
vi.mock("@/lib/alerts", () => ({
  sendOpsAlert: vi.fn(async () => ({
    delivered: false,
    reason: "unconfigured",
    channels: { webhook: "unconfigured", sms: "unconfigured" },
  })),
}))
vi.mock("@/lib/agent-events", () => ({
  dispatchAgentEvent: vi.fn(async () => undefined),
}))

const { creditsSpentThisPeriodMock } = vi.hoisted(() => ({
  creditsSpentThisPeriodMock: vi.fn<(...args: unknown[]) => Promise<number>>(async () => 0),
}))
vi.mock("@/lib/credits", () => ({
  creditsSpentThisPeriod: creditsSpentThisPeriodMock,
}))

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: vi.fn(() => ({
    from: (table: string) => {
      if (table === "shops") {
        return {
          select: () => shopsSelectBuilder(),
          update: (values: Record<string, unknown>) => shopsUpdateBuilder(values),
        }
      }
      if (table === "credit_grants") {
        return {
          insert: async (values: {
            shop_id: string
            kind: string
            credits: number
            minutes: number
            stripe_ref: string | null
          }) => {
            const ref = values.stripe_ref
            if (ref && grantRefs.has(ref)) {
              return { error: { code: "23505", message: "duplicate stripe_ref" } }
            }
            if (ref) grantRefs.add(ref)
            grants.push(values)
            return { error: null }
          },
        }
      }
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }
    },
  })),
}))

import { POST } from "@/app/api/stripe/webhook/route"

function stripeRequest(event: Record<string, unknown>): Request {
  return new Request("http://localhost/api/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": "t=1,v1=test" },
    body: JSON.stringify(event),
  })
}

afterEach(() => {
  vi.clearAllMocks()
  tierFromPriceIdMock.mockImplementation((priceId: string | null) => {
    if (priceId === "price_core") return "core"
    if (priceId === "price_pro") return "pro"
    if (priceId === "price_operator") return "operator"
    return null
  })
  creditsSpentThisPeriodMock.mockImplementation(async () => 0)
  resetStore()
})

describe("checkout.session.completed — tier resolved from the subscription's Price id", () => {
  it("Core checkout activates the shop on Core", async () => {
    getSubscriptionMock.mockResolvedValueOnce({
      id: "sub_new",
      status: "active",
      trialEnd: null,
      items: [{ itemId: "si_1", priceId: "price_core" }],
    })
    const res = await POST(
      stripeRequest({
        type: "checkout.session.completed",
        data: {
          object: {
            mode: "subscription",
            client_reference_id: "shop-core",
            subscription: "sub_new",
          },
        },
      })
    )
    expect(res.status).toBe(200)
    expect(shops["shop-core"].plan).toBe("active")
    expect(shops["shop-core"].tier).toBe("core")
    expect(shops["shop-core"].stripe_subscription_id).toBe("sub_new")
  })

  it("Pro checkout activates voice (vapi_stale set so the next sync provisions it)", async () => {
    getSubscriptionMock.mockResolvedValueOnce({
      id: "sub_new",
      status: "active",
      trialEnd: null,
      items: [{ itemId: "si_1", priceId: "price_pro" }],
    })
    const res = await POST(
      stripeRequest({
        type: "checkout.session.completed",
        data: {
          object: {
            mode: "subscription",
            client_reference_id: "shop-core",
            subscription: "sub_new",
          },
        },
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.tier).toBe("pro")
    expect(shops["shop-core"].tier).toBe("pro")
    expect((shops["shop-core"] as unknown as { vapi_stale?: boolean }).vapi_stale).toBe(true)
  })

  it("unknown price id → log + no-op, never guess a tier", async () => {
    getSubscriptionMock.mockResolvedValueOnce({
      id: "sub_mystery",
      status: "active",
      trialEnd: null,
      items: [{ itemId: "si_1", priceId: "price_unknown" }],
    })
    const before = { ...shops["shop-core"] }
    const res = await POST(
      stripeRequest({
        type: "checkout.session.completed",
        data: {
          object: {
            mode: "subscription",
            client_reference_id: "shop-core",
            subscription: "sub_mystery",
          },
        },
      })
    )
    expect(res.status).toBe(200)
    expect((await res.json()).ignored).toBe("unknown price id")
    expect(shops["shop-core"]).toEqual(before)
  })
})

describe("customer.subscription.updated — upgrade and downgrade", () => {
  it("upgrades Pro → Operator and turns on team seats via the tier field", async () => {
    const res = await POST(
      stripeRequest({
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_pro_1",
            status: "active",
            items: { data: [{ price: { id: "price_operator" } }] },
          },
        },
      })
    )
    expect(res.status).toBe(200)
    expect((await res.json()).tier).toBe("operator")
    expect(shops["shop-pro-sub"].tier).toBe("operator")
    expect(shops["shop-pro-sub"].plan).toBe("active")
  })

  it("downgrades Operator → Core and takes voice offline (voice_live false, vapi_stale set)", async () => {
    shops["shop-pro-sub"].tier = "operator"
    const res = await POST(
      stripeRequest({
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_pro_1",
            status: "active",
            items: { data: [{ price: { id: "price_core" } }] },
          },
        },
      })
    )
    expect(res.status).toBe(200)
    expect(shops["shop-pro-sub"].tier).toBe("core")
    expect(shops["shop-pro-sub"].voice_live).toBe(false)
    expect((shops["shop-pro-sub"] as unknown as { vapi_stale?: boolean }).vapi_stale).toBe(true)
  })

  it("past_due status maps the plan without guessing a tier change", async () => {
    const res = await POST(
      stripeRequest({
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_pro_1",
            status: "past_due",
            items: { data: [{ price: { id: "price_pro" } }] },
          },
        },
      })
    )
    expect(res.status).toBe(200)
    expect(shops["shop-pro-sub"].plan).toBe("past_due")
    expect(shops["shop-pro-sub"].tier).toBe("pro")
  })

  it("unmapped subscription id is ignored, never falls through to a guessed shop", async () => {
    const res = await POST(
      stripeRequest({
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_does_not_exist",
            status: "active",
            items: { data: [{ price: { id: "price_pro" } }] },
          },
        },
      })
    )
    expect(res.status).toBe(200)
    expect((await res.json()).ignored).toBe("no shop for sub")
  })
})

describe("customer.subscription.deleted — cancellation", () => {
  it("returns the shop to free and takes voice offline", async () => {
    const res = await POST(
      stripeRequest({
        type: "customer.subscription.deleted",
        data: { object: { id: "sub_pro_1" } },
      })
    )
    expect(res.status).toBe(200)
    expect(shops["shop-pro-sub"].plan).toBe("free")
    expect(shops["shop-pro-sub"].voice_live).toBe(false)
    expect(shops["shop-pro-sub"].trial_ends_at).toBeNull()
  })
})

describe("pack purchase (mode=payment) — idempotent grant", () => {
  it("grants a credit pack", async () => {
    const res = await POST(
      stripeRequest({
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_pack_1",
            mode: "payment",
            client_reference_id: "shop-pro-sub",
            metadata: { shop_id: "shop-pro-sub", pack: "credit" },
          },
        },
      })
    )
    expect(res.status).toBe(200)
    expect(grants).toEqual([
      { shop_id: "shop-pro-sub", kind: "credit_pack", credits: 950, minutes: 0, stripe_ref: "cs_pack_1" },
    ])
  })

  it("grants a minute pack", async () => {
    const res = await POST(
      stripeRequest({
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_pack_2",
            mode: "payment",
            client_reference_id: "shop-pro-sub",
            metadata: { shop_id: "shop-pro-sub", pack: "minute" },
          },
        },
      })
    )
    expect(res.status).toBe(200)
    expect(grants).toEqual([
      { shop_id: "shop-pro-sub", kind: "minute_pack", credits: 0, minutes: 40, stripe_ref: "cs_pack_2" },
    ])
  })

  it("a replayed webhook (same session id) is a no-op, not a double grant", async () => {
    const event = {
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_pack_replay",
          mode: "payment",
          client_reference_id: "shop-pro-sub",
          metadata: { shop_id: "shop-pro-sub", pack: "credit" },
        },
      },
    }
    const first = await POST(stripeRequest(event))
    const second = await POST(stripeRequest(event))
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect((await second.json()).ignored).toBe("duplicate grant")
    expect(grants.filter((g) => g.stripe_ref === "cs_pack_replay").length).toBe(1)
  })
})

describe("invoice.paid renewal — rollover per tier (D-034, up to 25% of unused INCLUDED credits)", () => {
  it("Pro (6,000 included), barely used → rollover caps at 25%", async () => {
    creditsSpentThisPeriodMock.mockResolvedValueOnce(100)
    const res = await POST(
      stripeRequest({
        type: "invoice.paid",
        data: { object: { id: "in_renew_1", subscription: "sub_pro_1" } },
      })
    )
    expect(res.status).toBe(200)
    expect((await res.json()).rollover).toBe(1500) // 25% of 6,000
    expect(grants).toEqual([
      { shop_id: "shop-pro-sub", kind: "rollover", credits: 1500, minutes: 0, stripe_ref: "in_renew_1" },
    ])
  })

  it("mostly used → rollover is whatever's left, not the 25% cap", async () => {
    creditsSpentThisPeriodMock.mockResolvedValueOnce(5800)
    const res = await POST(
      stripeRequest({
        type: "invoice.paid",
        data: { object: { id: "in_renew_2", subscription: "sub_pro_1" } },
      })
    )
    expect(res.status).toBe(200)
    expect((await res.json()).rollover).toBe(200) // 6,000 - 5,800
  })

  it("fully used → nothing rolls, no grant row written", async () => {
    creditsSpentThisPeriodMock.mockResolvedValueOnce(6000)
    const res = await POST(
      stripeRequest({
        type: "invoice.paid",
        data: { object: { id: "in_renew_3", subscription: "sub_pro_1" } },
      })
    )
    expect(res.status).toBe(200)
    expect((await res.json()).rollover).toBe(0)
    expect(grants).toEqual([])
  })

  it("a replayed renewal (same invoice id) doesn't double the rollover grant", async () => {
    creditsSpentThisPeriodMock.mockResolvedValue(100)
    const event = {
      type: "invoice.paid",
      data: { object: { id: "in_renew_replay", subscription: "sub_pro_1" } },
    }
    await POST(stripeRequest(event))
    await POST(stripeRequest(event))
    expect(grants.filter((g) => g.stripe_ref === "in_renew_replay").length).toBe(1)
  })
})
