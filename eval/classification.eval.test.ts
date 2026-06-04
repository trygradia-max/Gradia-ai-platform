import { describe, it, expect } from "vitest"

import { classifySms } from "@/lib/sms-classifier"
import { classifyEmail } from "@/lib/email-classifier"
import { LIVE, assertField, type FieldSpec } from "./_lib"
import smsCases from "./cases/sms.json"
import emailCases from "./cases/email.json"

// `expect` mixes the is_lead label with per-field specs, so the index
// signature allows both; the loops skip is_lead before treating values as specs.
type SmsCase = {
  name: string
  from: string
  body: string
  expect: { is_lead: boolean; [field: string]: boolean | FieldSpec }
}
type EmailCase = {
  name: string
  from: string
  subject: string
  body: string
  expect: { is_lead: boolean; [field: string]: boolean | FieldSpec }
}

/**
 * Tier 2 — golden set for the inbound classifiers (sms + email).
 * Asserts the is_lead label and the empty-string contract on extract fields:
 * a noisy follow-up must classify as not-a-lead AND not invent fields. This is
 * where silent regressions hurt — nothing crashes, the funnel just gets noisier.
 */
describe.skipIf(!LIVE)("SMS classification golden [live]", () => {
  it.each(smsCases as SmsCase[])("$name", async (c) => {
    const out = await classifySms({ from: c.from, body: c.body })
    expect(out.is_lead, `${c.name} → is_lead`).toBe(c.expect.is_lead)
    for (const [field, spec] of Object.entries(c.expect)) {
      if (field === "is_lead") continue
      assertField(
        out[field as keyof typeof out] as string,
        spec as FieldSpec,
        `${c.name} → ${field}`
      )
    }
  })
})

describe.skipIf(!LIVE)("Email classification golden [live]", () => {
  it.each(emailCases as EmailCase[])("$name", async (c) => {
    const out = await classifyEmail({
      from: c.from,
      subject: c.subject,
      body: c.body,
    })
    expect(out.is_lead, `${c.name} → is_lead`).toBe(c.expect.is_lead)
    for (const [field, spec] of Object.entries(c.expect)) {
      if (field === "is_lead") continue
      assertField(
        out[field as keyof typeof out] as string,
        spec as FieldSpec,
        `${c.name} → ${field}`
      )
    }
  })
})
