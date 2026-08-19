import { afterEach, beforeAll, describe, it, expect, vi } from "vitest"

import type { SupabaseClient } from "@supabase/supabase-js"

import { encryptSecret } from "@/lib/crypto"
import { purchaseNumber, smsGateForShop } from "@/lib/telephony-provider"
import { resolveTwilioCredentials } from "@/lib/twilio"

/**
 * Tier 1 — pure, deterministic, no API. Locks the telephony seam's two
 * code-enforced invariants (twilio-isv-telephony skill): the A2P SMS gate
 * and the credit pre-check running BEFORE any vendor call.
 */

/** Routes table reads: pricing_config + usage_events spend + grants. */
function mockSupabase(spentRows: { credits: number }[]): SupabaseClient {
  return {
    from: (table: string) => {
      if (table === "pricing_config") {
        return { select: () => Promise.resolve({ data: [], error: null }) }
      }
      return {
        select: () => ({
          eq: () => ({
            gte: () =>
              Promise.resolve({
                data: table === "credit_grants" ? [] : spentRows,
                error: null,
              }),
          }),
        }),
        update: () => ({ eq: () => Promise.resolve({ error: null }) }),
        insert: () => Promise.resolve({ error: null }),
      }
    },
  } as unknown as SupabaseClient
}

const shop = {
  id: "shop-1",
  name: "Pristine Detailing",
  twilio_subaccount_sid: null,
  twilio_subaccount_token_enc: null,
  gradia_number_e164: null,
  gradia_number_sid: null,
  a2p_status: "unregistered" as const,
  plan: "active" as const, // 1,200-credit allowance
  credit_period_start: "2026-06-01T00:00:00Z",
}

afterEach(() => vi.unstubAllGlobals())

describe("A2P SMS gate — blocked in code until carriers approve", () => {
  const withNumber = { gradia_number_e164: "+16175550142", byo_sms_verified: false }

  it("blocks outbound SMS on a Gradia number before approval", () => {
    for (const a2p_status of ["unregistered", "pending"] as const) {
      const gate = smsGateForShop({ ...withNumber, a2p_status }, "+16175550142")
      expect(gate.allowed, `status=${a2p_status}`).toBe(false)
      if (!gate.allowed) expect(gate.reason).toContain("verified by carriers")
    }
  })

  it("rejection gets an actionable owner-facing reason, not a generic block", () => {
    const gate = smsGateForShop(
      { ...withNumber, a2p_status: "rejected" },
      "+16175550142"
    )
    expect(gate.allowed).toBe(false)
    if (!gate.allowed) expect(gate.reason).toContain("Business Number")
  })

  it("unlocks on approval", () => {
    expect(
      smsGateForShop({ ...withNumber, a2p_status: "approved" }, "+16175550142")
        .allowed
    ).toBe(true)
  })

  it("gates BYO numbers until the owner attests A2P registration (B2 — bypass closed)", () => {
    // Gradia can't see a shop's own number's carrier standing, so it can't
    // text unconditionally — the owner must confirm registration first.
    const byo = { gradia_number_e164: null, a2p_status: "unregistered" as const }
    expect(
      smsGateForShop({ ...byo, byo_sms_verified: false }, "+19998887777").allowed
    ).toBe(false)
    expect(
      smsGateForShop({ ...byo, byo_sms_verified: true }, "+19998887777").allowed
    ).toBe(true)
    // Sending from a number other than the Gradia one is also BYO → gated.
    expect(
      smsGateForShop(
        { ...withNumber, a2p_status: "unregistered" },
        "+19998887777"
      ).allowed
    ).toBe(false)
  })
})

describe("purchase — credit pre-check runs before any vendor call", () => {
  it("over-cap purchase fails closed with the credit reason and never touches the network", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("vendor call attempted before credit pre-check")
    })
    vi.stubGlobal("fetch", fetchSpy)

    const supabase = mockSupabase([{ credits: 1200 }]) // allowance fully spent
    const result = await purchaseNumber({
      supabase,
      shop,
      e164: "+16175550142",
      origin: "https://app.gradia.test",
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("credit pack")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("one number per shop — a second purchase is refused before any spend", async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)

    const result = await purchaseNumber({
      supabase: mockSupabase([]),
      shop: { ...shop, gradia_number_e164: "+16175550100" },
      e164: "+16175550142",
      origin: "https://app.gradia.test",
    })

    expect(result.ok).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe("credential resolution — subaccount wins for the Gradia number", () => {
  // Lazy key load means tests can provide one; doesn't leak past the suite
  // because each encryptSecret call re-reads env.
  beforeAll(() => {
    process.env.ENCRYPTION_KEY ??= "ab".repeat(32)
  })

  const gradiaShop = () => ({
    twilio_subaccount_sid: "ACsub",
    twilio_subaccount_token_enc: encryptSecret("sub-token"),
    twilio_account_sid_enc: encryptSecret("ACbyo"),
    twilio_auth_token_enc: encryptSecret("byo-token"),
    gradia_number_e164: "+16175550142",
    twilio_phone_number: "+16175550142",
  })

  it("uses the subaccount when the active number is the Gradia one — it only exists there", () => {
    expect(resolveTwilioCredentials(gradiaShop())).toEqual({
      accountSid: "ACsub",
      authToken: "sub-token",
      source: "subaccount",
    })
  })

  it("falls back to BYO creds when the active number is not the Gradia number", () => {
    expect(
      resolveTwilioCredentials({ ...gradiaShop(), twilio_phone_number: "+19998887777" })
    ).toEqual({ accountSid: "ACbyo", authToken: "byo-token", source: "byo" })
  })

  it("ignores a stored subaccount when no Gradia number was ever purchased", () => {
    expect(
      resolveTwilioCredentials({
        ...gradiaShop(),
        gradia_number_e164: null,
        twilio_phone_number: "+19998887777",
      })
    ).toEqual({ accountSid: "ACbyo", authToken: "byo-token", source: "byo" })
  })
})
