import { afterEach, describe, expect, it, vi } from "vitest"

/**
 * P0-011 review — Stripe webhook tenant binding. Signature verification is
 * locked in eval/webhooks.test.ts; this file locks the tenancy properties
 * the HMAC cannot provide:
 *
 * 1. Connect events (`account` envelope) cannot drive platform billing
 *    writes even with attacker-set client_reference_id / metadata.shop_id.
 * 2. An unmapped Connect account cannot fall through to an unscoped
 *    interactions/payments read on the RLS-bypassing service client.
 * 3. A refund without a Connect account envelope is ignored.
 */

type Call = { table: string; op: string; filters: Record<string, unknown> }

const calls: Call[] = []
const shopsUpdates: Array<{ values: Record<string, unknown>; eq: Record<string, unknown> }> =
  []
const grantInserts: Array<Record<string, unknown>> = []

function builder(table: string, op: string, values?: Record<string, unknown>) {
  const filters: Record<string, unknown> = {}
  const self = {
    select: () => builder(table, "select"),
    update: (v: Record<string, unknown>) => builder(table, "update", v),
    insert: (v: Record<string, unknown>) => {
      if (table === "credit_grants") grantInserts.push(v)
      return builder(table, "insert", v)
    },
    upsert: (v: Record<string, unknown>) => builder(table, "upsert", v),
    eq(col: string, val: unknown) {
      filters[col] = val
      return self
    },
    in() {
      return self
    },
    async maybeSingle() {
      calls.push({ table, op, filters })
      // The shop-lookup-by-id path (checkout.session.completed) resolves a
      // real, not-yet-upgraded shop row so the tier transition can proceed.
      if (table === "shops" && op === "select" && typeof filters.id === "string") {
        return {
          data: {
            id: filters.id,
            plan: "free",
            tier: "core",
            voice_addon: false,
            voice_live: false,
            stripe_subscription_id: null,
          },
          error: null,
        }
      }
      return { data: null, error: null }
    },
    then(resolve: (v: { data: null; error: null }) => void) {
      calls.push({ table, op, filters })
      if (op === "update" && table === "shops") {
        shopsUpdates.push({ values: values ?? {}, eq: { ...filters } })
      }
      resolve({ data: null, error: null })
    },
  }
  return self
}

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/lib/stripe", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/stripe")>()
  return {
    ...original,
    verifyStripeSignature: vi.fn(() => true),
    getSubscription: vi.fn(async (subscriptionId: string) => ({
      id: subscriptionId,
      status: "active",
      trialEnd: null,
      items: [{ itemId: "si_test", priceId: "price_core_test" }],
    })),
    tierFromPriceId: vi.fn(() => "core"),
  }
})
// CLEANUP-001: payment notices ride the P0-012 ops alert seam (SEV-3).
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
vi.mock("@/lib/credits", () => ({
  creditsSpentThisPeriod: vi.fn(async () => 0),
}))
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: vi.fn(() => ({
    from: (table: string) => ({
      select: () => builder(table, "select"),
      update: (values: Record<string, unknown>) => {
        if (table === "shops") {
          const eq: Record<string, unknown> = {}
          const chain = {
            eq(col: string, val: unknown) {
              eq[col] = val
              shopsUpdates.push({ values, eq: { ...eq } })
              return chain
            },
          }
          return chain
        }
        return builder(table, "update", values)
      },
      insert: (values: Record<string, unknown>) => {
        if (table === "credit_grants") grantInserts.push(values)
        return builder(table, "insert", values)
      },
      upsert: (values: Record<string, unknown>) => builder(table, "upsert", values),
    }),
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
  calls.length = 0
  shopsUpdates.length = 0
  grantInserts.length = 0
})

describe("stripe webhook — Connect cannot drive platform billing", () => {
  it("ignores Connect checkout.session.completed with a forged shop_id", async () => {
    const res = await POST(
      stripeRequest({
        type: "checkout.session.completed",
        account: "acct_attacker",
        data: {
          object: {
            mode: "subscription",
            client_reference_id: "shop-victim",
            metadata: { shop_id: "shop-victim" },
            subscription: "sub_forged",
          },
        },
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ignored).toBe("connect event on platform billing path")
    expect(shopsUpdates).toEqual([])
    expect(grantInserts).toEqual([])
  })

  it("ignores Connect pack checkout that forges metadata.shop_id", async () => {
    const res = await POST(
      stripeRequest({
        type: "checkout.session.completed",
        account: "acct_attacker",
        data: {
          object: {
            mode: "payment",
            client_reference_id: "shop-victim",
            metadata: { shop_id: "shop-victim", pack: "credit" },
            id: "cs_forged",
          },
        },
      })
    )
    expect(res.status).toBe(200)
    expect((await res.json()).ignored).toBe("connect event on platform billing path")
    expect(grantInserts).toEqual([])
  })

  it("still activates the minted shop on a PLATFORM subscription checkout", async () => {
    const res = await POST(
      stripeRequest({
        type: "checkout.session.completed",
        data: {
          object: {
            mode: "subscription",
            client_reference_id: "shop-minted",
            metadata: { shop_id: "shop-minted" },
            subscription: "sub_real",
          },
        },
      })
    )
    expect(res.status).toBe(200)
    expect(shopsUpdates.length).toBe(1)
    expect(shopsUpdates[0].eq).toEqual({ id: "shop-minted" })
    expect(shopsUpdates[0].values.plan).toBe("active")
  })
})

describe("stripe webhook — Connect invoice/refund fail closed without a shop", () => {
  it("acks an unmapped Connect account without reading interactions", async () => {
    const res = await POST(
      stripeRequest({
        type: "invoice.paid",
        account: "acct_unknown",
        data: { object: { id: "in_1", amount_paid: 5000 } },
      })
    )
    expect(res.status).toBe(200)
    expect((await res.json()).ignored).toBe("unknown connected account")
    expect(calls.filter((c) => c.table === "interactions")).toEqual([])
    expect(calls.filter((c) => c.table === "payments")).toEqual([])
  })

  it("ignores a platform (no account) charge.refunded instead of an unscoped payments lookup", async () => {
    const res = await POST(
      stripeRequest({
        type: "charge.refunded",
        data: {
          object: {
            invoice: "in_1",
            amount_refunded: 1000,
          },
        },
      })
    )
    expect(res.status).toBe(200)
    expect((await res.json()).ignored).toBe("no connected account")
    expect(calls.filter((c) => c.table === "payments")).toEqual([])
  })
})
