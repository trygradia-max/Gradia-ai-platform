import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { leadIntakeInputSchema } from "@/lib/lead-intake"

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
