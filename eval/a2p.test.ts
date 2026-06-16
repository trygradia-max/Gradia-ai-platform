import { describe, it, expect } from "vitest"

import { a2pBusinessSchema } from "@/lib/a2p-schema"
import { smsGateForShop } from "@/lib/telephony-provider"

/**
 * Tier 1 — pure, deterministic, no API. Locks the A2P wizard's input
 * validation (top rejection causes are fixable input problems — catch them
 * before Twilio does) and the gate transitions the pipeline drives.
 */

const VALID = {
  legal_name: "Pristine Detailing LLC",
  ein: "12-3456789",
  business_type: "Limited Liability Corporation" as const,
  website_url: "",
  address: { street: "42 Main St", city: "Boston", region: "ma", postal_code: "02118" },
  contact: {
    first_name: "Sam",
    last_name: "Rivera",
    email: "sam@pristinedetailing.com",
    phone: "+16175550142",
    job_position: "Owner",
  },
}

describe("A2P business details validation", () => {
  it("accepts a complete registration and normalizes as carriers expect", () => {
    const parsed = a2pBusinessSchema.parse(VALID)
    expect(parsed.ein).toBe("123456789") // digits only, dashes stripped
    expect(parsed.address.region).toBe("MA") // uppercased state code
    expect(parsed.website_url).toBeNull() // empty string → null
  })

  it("rejects a malformed EIN with an actionable message", () => {
    const result = a2pBusinessSchema.safeParse({ ...VALID, ein: "12-345" })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("9 digits")
    }
  })

  it("rejects non-E.164 contact phones (carriers require +1 format)", () => {
    const result = a2pBusinessSchema.safeParse({
      ...VALID,
      contact: { ...VALID.contact, phone: "617-555-0142" },
    })
    expect(result.success).toBe(false)
  })

  it("rejects an invalid state code and bad ZIP", () => {
    expect(
      a2pBusinessSchema.safeParse({
        ...VALID,
        address: { ...VALID.address, region: "Massachusetts" },
      }).success
    ).toBe(false)
    expect(
      a2pBusinessSchema.safeParse({
        ...VALID,
        address: { ...VALID.address, postal_code: "21" },
      }).success
    ).toBe(false)
  })

  it("keeps a real website URL", () => {
    const parsed = a2pBusinessSchema.parse({
      ...VALID,
      website_url: "https://pristinedetailing.com",
    })
    expect(parsed.website_url).toBe("https://pristinedetailing.com")
  })
})

describe("the EIN fork — sole proprietors register without a tax ID", () => {
  const SOLE_PROP = {
    ...VALID,
    has_ein: false,
    ein: "",
    business_type: "Sole Proprietorship" as const,
    mobile_phone: "+16175550177",
  }

  it("accepts a sole prop with a mobile and no EIN", () => {
    const parsed = a2pBusinessSchema.parse(SOLE_PROP)
    expect(parsed.has_ein).toBe(false)
    expect(parsed.ein).toBeNull()
    expect(parsed.mobile_phone).toBe("+16175550177")
  })

  it("sole prop without the OTP mobile is rejected with the why", () => {
    const result = a2pBusinessSchema.safeParse({ ...SOLE_PROP, mobile_phone: "" })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("texting")
    }
  })

  it("EIN path still requires the EIN (defaults preserved)", () => {
    const result = a2pBusinessSchema.safeParse({ ...VALID, ein: "" })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["ein"])
    }
  })

  it("omitting has_ein defaults to the EIN path (existing registrations)", () => {
    const parsed = a2pBusinessSchema.parse(VALID)
    expect(parsed.has_ein).toBe(true)
  })
})

describe("pipeline → gate transitions", () => {
  const number = "+16175550142"
  const shopWith = (a2p_status: "unregistered" | "pending" | "approved" | "rejected") => ({
    gradia_number_e164: number,
    a2p_status,
    byo_sms_verified: false,
  })

  it("texting stays blocked through the whole review pipeline", () => {
    // unregistered (just purchased) → pending (registration submitted)
    expect(smsGateForShop(shopWith("unregistered"), number).allowed).toBe(false)
    expect(smsGateForShop(shopWith("pending"), number).allowed).toBe(false)
  })

  it("only approval — syncA2pStatus's terminal success — opens the gate", () => {
    expect(smsGateForShop(shopWith("approved"), number).allowed).toBe(true)
    expect(smsGateForShop(shopWith("rejected"), number).allowed).toBe(false)
  })
})
