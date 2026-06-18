import { describe, it, expect } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

import type { AgentEvent } from "@/lib/agent-events"
import { EVENT_RECIPE_HANDLERS } from "@/lib/agent-runtime"
import type { CustomAgentRow, ShopRow } from "@/lib/types/database"

type PaymentEvent = Extract<AgentEvent, { kind: "payment_received" }>

/**
 * Tier 1 — pure, deterministic, no API. Gates the review_request recipe
 * (principle #6). Draft quality + the review link in copy are covered by the
 * live drafter eval (review-request.eval.test.ts); these lock the wiring and
 * the prerequisites — crucially that the recipe REFUSES to fire without a
 * review link, so it can never stage a linkless ask.
 */

// A paid-invoice event with full contact details.
const paidEvent: PaymentEvent = {
  kind: "payment_received",
  shopId: "shop-1",
  customerName: "Marcus Webb",
  customerEmail: "marcus@gmail.com",
  customerPhone: "+14155550142",
  customerId: "cust-1",
  amountCents: 25000,
  stripeInvoiceId: "in_1",
  paidAtIso: "2026-06-16T18:00:00Z",
}

const smsAgent = {
  id: "agent-1",
  name: "Ask for reviews",
  owner_id: "owner-1",
  shop_id: "shop-1",
  config: { recipe: { id: "review_request_sms", params: {} } },
} as unknown as CustomAgentRow

const emailAgent = {
  ...smsAgent,
  config: { recipe: { id: "review_request_email", params: {} } },
} as unknown as CustomAgentRow

// Querying before prerequisites pass is a bug — make it explode.
const deadSupabase = {
  from: () => {
    throw new Error("must not query before prerequisites pass")
  },
} as unknown as SupabaseClient

const withLink = (over: Partial<ShopRow>): ShopRow =>
  ({
    id: "shop-1",
    name: "Pristine",
    twilio_phone_number: "+16175550100",
    aurinko_access_token_enc: "tok",
    settings: { review_link: "https://g.page/r/x/review" },
    ...over,
  }) as ShopRow

describe("review_request recipe registry", () => {
  it("both variants are wired as event recipes", () => {
    expect(Object.keys(EVENT_RECIPE_HANDLERS)).toContain("review_request_sms")
    expect(Object.keys(EVENT_RECIPE_HANDLERS)).toContain("review_request_email")
  })
})

describe("SMS variant — prerequisites fail soft (no queries, no drafts)", () => {
  it("refuses without an SMS number", async () => {
    const out = await EVENT_RECIPE_HANDLERS.review_request_sms(
      deadSupabase,
      withLink({ twilio_phone_number: null }),
      smsAgent,
      paidEvent
    )
    expect(out.fired).toBe(false)
    expect(out.reason).toContain("Twilio")
  })

  it("refuses without a phone on the paying customer", async () => {
    const out = await EVENT_RECIPE_HANDLERS.review_request_sms(
      deadSupabase,
      withLink({}),
      smsAgent,
      { ...paidEvent, customerPhone: null }
    )
    expect(out.fired).toBe(false)
    expect(out.reason).toContain("phone")
  })

  it("refuses without a review link set (never stages a linkless ask)", async () => {
    const out = await EVENT_RECIPE_HANDLERS.review_request_sms(
      deadSupabase,
      withLink({ settings: {} }),
      smsAgent,
      paidEvent
    )
    expect(out.fired).toBe(false)
    expect(out.reason).toContain("review link")
  })

  it("refuses a mismatched event kind", async () => {
    const out = await EVENT_RECIPE_HANDLERS.review_request_sms(
      deadSupabase,
      withLink({}),
      smsAgent,
      { ...paidEvent, kind: "booking_approved" } as unknown as AgentEvent
    )
    expect(out.fired).toBe(false)
  })
})

describe("email variant — prerequisites fail soft", () => {
  it("refuses without Gmail connected", async () => {
    const out = await EVENT_RECIPE_HANDLERS.review_request_email(
      deadSupabase,
      withLink({ aurinko_access_token_enc: null }),
      emailAgent,
      paidEvent
    )
    expect(out.fired).toBe(false)
    expect(out.reason).toContain("Aurinko")
  })

  it("refuses without an email on the paying customer", async () => {
    const out = await EVENT_RECIPE_HANDLERS.review_request_email(
      deadSupabase,
      withLink({}),
      emailAgent,
      { ...paidEvent, customerEmail: null }
    )
    expect(out.fired).toBe(false)
    expect(out.reason).toContain("email")
  })

  it("refuses without a review link set", async () => {
    const out = await EVENT_RECIPE_HANDLERS.review_request_email(
      deadSupabase,
      withLink({ settings: {} }),
      emailAgent,
      paidEvent
    )
    expect(out.fired).toBe(false)
    expect(out.reason).toContain("review link")
  })
})
