import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  inboundSmsIntakeInput,
  leadIntakeInputSchema,
  readWebsiteFormSubmission,
  websiteFormIntakeInput,
} from "@/lib/lead-intake"

const valid = {
  shopId: "00000000-0000-4000-8000-000000000001",
  channel: "synthetic" as const,
  provider: "synthetic",
  providerEventId: "evt-1",
  receivedAt: "2026-10-01T17:00:00.000Z",
  evidenceRef: "synthetic:fixture",
  threadKey: "thread-1",
  payload: { message: "Fictional inquiry" },
}

describe("lead intake input", () => {
  it("accepts an explicit shop and supplied text without a person or consent field", () => {
    expect(leadIntakeInputSchema.safeParse(valid).success).toBe(true)
  })

  it("rejects tenant, identity, and consent fields instead of reading them from the payload", () => {
    expect(leadIntakeInputSchema.safeParse({ ...valid, shopId: "not-a-shop" }).success).toBe(false)
    for (const payload of [
      { shop_id: valid.shopId },
      { customer_id: valid.shopId },
      { lead_id: valid.shopId },
      { marketing_consent: "yes" },
      { sms_consent: "true" },
      { consent: "opted_in" },
    ]) {
      expect(leadIntakeInputSchema.safeParse({ ...valid, payload }).success).toBe(false)
    }
  })

  it("keeps the database writer off person, consent, lead, and approval tables", () => {
    const sql = readFileSync(
      new URL("../supabase/migrations/20261001130000_lead_intake_record.sql", import.meta.url),
      "utf8",
    )
    for (const forbidden of [
      "public.customers",
      "public.leads",
      "public.customer_channel_permissions",
      "public.pending_actions",
      "public.interactions",
    ]) {
      expect(sql.includes(forbidden)).toBe(false)
    }
    expect(sql).toContain("UNIQUE (provider, provider_event_id)")
    expect(sql).toContain("identity_review")
  })
})

describe("inbound SMS intake input", () => {
  it("stores the sender address and message with an empty thread key", () => {
    const mapped = inboundSmsIntakeInput({
      shopId: valid.shopId,
      messageSid: " SM123 ",
      from: " +15555550111 ",
      body: "  Fictional text  ",
      receivedAt: valid.receivedAt,
    })
    expect(mapped).toEqual({
      shopId: valid.shopId,
      channel: "sms",
      provider: "twilio",
      providerEventId: "SM123",
      receivedAt: valid.receivedAt,
      evidenceRef: null,
      threadKey: null,
      payload: { phone: "+15555550111", message: "Fictional text" },
    })
    expect(leadIntakeInputSchema.safeParse(mapped).success).toBe(true)
  })

  it("keeps a blank body out of the payload", () => {
    const mapped = inboundSmsIntakeInput({
      shopId: valid.shopId,
      messageSid: "SM124",
      from: "+15555550111",
      body: "   ",
      receivedAt: valid.receivedAt,
    })
    expect(mapped.threadKey).toBeNull()
    expect(mapped.payload).toEqual({ phone: "+15555550111" })
  })
})

describe("website form intake input", () => {
  it("stores submitted fields and leaves the thread empty unless one is supplied", () => {
    const mapped = websiteFormIntakeInput({
      shopId: valid.shopId,
      submissionId: " form-1 ",
      receivedAt: valid.receivedAt,
      payload: {
        display_name: "Fictional Form",
        phone: "+15555550123",
        email: "form-intake@example.test",
        message: "Fictional form note",
      },
    })
    expect(mapped).toEqual({
      shopId: valid.shopId,
      channel: "website_form",
      provider: "website_form",
      providerEventId: "form-1",
      receivedAt: valid.receivedAt,
      evidenceRef: null,
      threadKey: null,
      payload: {
        display_name: "Fictional Form",
        phone: "+15555550123",
        email: "form-intake@example.test",
        message: "Fictional form note",
      },
    })
    expect(mapped.threadKey).not.toBe(mapped.payload.phone)
    expect(mapped.threadKey).not.toBe(mapped.payload.email)
    expect(leadIntakeInputSchema.safeParse(mapped).success).toBe(true)
  })

  it("keeps an explicit thread key and drops blank contact fields", () => {
    const read = readWebsiteFormSubmission({
      submission_id: " form-2 ",
      thread_key: " thread-2 ",
      phone: "   ",
      email: "form-intake@example.test",
      message: "  Fictional form note  ",
    })
    expect(read).toEqual({
      submissionId: "form-2",
      threadKey: "thread-2",
      claimedShopId: null,
      payload: {
        email: "form-intake@example.test",
        message: "Fictional form note",
      },
    })
    const mapped = websiteFormIntakeInput({
      shopId: valid.shopId,
      submissionId: read!.submissionId,
      receivedAt: valid.receivedAt,
      threadKey: read!.threadKey,
      payload: read!.payload,
    })
    expect(mapped.threadKey).toBe("thread-2")
    expect(mapped.payload).not.toHaveProperty("phone")
  })

  it("refuses a missing submission id, consent, and a client-supplied time", () => {
    expect(readWebsiteFormSubmission({ message: "Fictional form note" })).toBeNull()
    expect(readWebsiteFormSubmission({
      submission_id: "form-3",
      message: "Fictional form note",
      marketing_consent: "yes",
    })).toBeNull()
    expect(readWebsiteFormSubmission({
      submission_id: "form-3",
      message: "Fictional form note",
      received_at: valid.receivedAt,
    })).toBeNull()
    expect(readWebsiteFormSubmission({
      submission_id: "form-3",
      customer_id: valid.shopId,
    })).toBeNull()
  })

  it("calls record_lead_intake once from the session shop, not from the body", () => {
    const route = readFileSync(
      new URL("../src/app/api/intake/website-form/route.ts", import.meta.url),
      "utf8",
    )
    const flat = route.replace(/\s+/g, " ")
    expect(flat.match(/acceptWebsiteFormIntake\(/g)).toHaveLength(1)
    expect(flat).toContain("acceptWebsiteFormIntake(db, shop.id, body, receivedAt)")
    expect(flat).toContain("getOptionalShop")
    const intake = readFileSync(
      new URL("../src/lib/lead-intake.ts", import.meta.url),
      "utf8",
    )
    expect(intake.match(/await recordLeadIntake\(/g)).toHaveLength(1)
    for (const forbidden of [
      "findOrCreateCustomer",
      "recordInteraction",
      "customer_channel_permissions",
      "pending_actions",
      "create_lead",
      "from(\"customers\")",
      "from(\"leads\")",
    ]) {
      expect(route.includes(forbidden)).toBe(false)
      expect(intake.includes(forbidden)).toBe(false)
    }
  })
})
