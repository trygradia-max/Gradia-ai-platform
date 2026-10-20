import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createHmac } from "node:crypto"
import { encryptSecret } from "@/lib/crypto"
import { resolveTwilioCredentials, sendOutboundSms, verifyTwilioSignature } from "@/lib/twilio"

beforeEach(() => {
  vi.stubEnv("ENCRYPTION_KEY", "ab".repeat(32))
  vi.stubEnv("TWILIO_ACCOUNT_SID", "ACshared")
  vi.stubEnv("TWILIO_AUTH_TOKEN", "shared-token")
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe("business credentials fail closed", () => {
  it.each([{}, { twilio_subaccount_sid: "ACsub", twilio_subaccount_token_enc: "broken" }])("never sends a Gradia number from another account when subaccount credentials are unusable", fields => {
    expect(resolveTwilioCredentials({ ...fields, gradia_number_e164: "+15555550100", twilio_phone_number: "+15555550100", twilio_account_sid_enc: encryptSecret("ACown"), twilio_auth_token_enc: encryptSecret("own-token") })).toBeNull()
  })
  it.each([{ twilio_account_sid_enc: "broken", twilio_auth_token_enc: "broken" }, { twilio_account_sid_enc: "broken" }])("does not replace configured but unreadable own-account credentials with the shared account", fields => {
    expect(resolveTwilioCredentials(fields)).toBeNull()
  })
  it("an unconfigured business uses the shared account only as an allowlisted pilot shop and number (I1)", () => {
    expect(resolveTwilioCredentials({})).toBeNull()
    expect(resolveTwilioCredentials({ id: "shop-pilot", twilio_phone_number: "+15555550100" })).toBeNull()
    vi.stubEnv("TWILIO_PILOT_SHOP_NUMBERS", "shop-pilot=+15555550100")
    expect(resolveTwilioCredentials({ id: "shop-pilot", twilio_phone_number: "+15555550100" })).toMatchObject({ accountSid: "ACshared", source: "env" })
    expect(resolveTwilioCredentials({ id: "shop-pilot", twilio_phone_number: "+15555550199" })).toBeNull()
    expect(resolveTwilioCredentials({ id: "shop-other", twilio_phone_number: "+15555550100" })).toBeNull()
    // Gradia's own master-only callers pass no shop at all.
    expect(resolveTwilioCredentials(null)).toMatchObject({ accountSid: "ACshared", source: "env" })
  })
  it("an explicit failed resolution cannot fall back inside the transport", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch)
    await expect(sendOutboundSms({ from: "+15555550100", to: "+15555550101", body: "Test", creds: null })).rejects.toThrow(/missing/)
    expect(fetch).not.toHaveBeenCalled()
  })
  it("an explicit failed resolution rejects even a valid shared-account signature", () => {
    const url = "https://example.test/webhook"
    const signature = createHmac("sha1", "shared-token").update(url).digest("base64")
    expect(verifyTwilioSignature({ url, signature, form: new URLSearchParams(), creds: null })).toBe(false)
    expect(verifyTwilioSignature({ url, signature, form: new URLSearchParams() })).toBe(true)
  })
})
