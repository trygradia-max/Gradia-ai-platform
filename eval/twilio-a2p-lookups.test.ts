import { afterEach, describe, expect, it, vi } from "vitest"
import { A2P_PROVIDER_TIMEOUT_MS, listBrandRegistrations, listMessagingServices } from "@/lib/twilio-a2p"

// Wire contract for the lookups that precede a create, with fetch faked.
const creds = { accountSid: "AC" + "1".repeat(32), authToken: "synthetic" }
const BN = "BN" + "2".repeat(32), BU1 = "BU" + "3".repeat(32), BU2 = "BU" + "4".repeat(32), MG = "MG" + "5".repeat(32)

function fakeFetch(body: unknown) {
  const calls: { url: string; init: RequestInit }[] = []
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(body), { status: 200 })
  })
  return calls
}
afterEach(() => { vi.unstubAllGlobals() })

describe("lookups before a create", () => {
  it("lists the subaccount's brands with the two bundles each was made from", async () => {
    const calls = fakeFetch({ data: [{ sid: BN, customer_profile_bundle_sid: BU1, a2p_profile_bundle_sid: BU2, status: "PENDING" }], meta: { key: "data" } })
    expect(await listBrandRegistrations(creds)).toEqual([{ brandSid: BN, customerProfileSid: BU1, trustProductSid: BU2, status: "PENDING" }])
    expect(calls[0].url).toContain("/a2p/BrandRegistrations?PageSize=50")
  })

  it("lists the subaccount's messaging services with their inbound URL", async () => {
    const calls = fakeFetch({ services: [{ sid: MG, inbound_request_url: "https://gradia.test/api/twilio/sms" }], meta: { key: "services" } })
    expect(await listMessagingServices(creds)).toEqual([{ messagingServiceSid: MG, inboundRequestUrl: "https://gradia.test/api/twilio/sms" }])
    expect(calls[0].url).toContain("/Services?PageSize=50")
  })

  it("every call carries a timeout, and the longest claim ends well inside the 15-minute lease", async () => {
    const calls = fakeFetch({ data: [] })
    await listBrandRegistrations(creds)
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal)
    const longestClaimCalls = 20 // submit is about 15 provider calls
    expect(A2P_PROVIDER_TIMEOUT_MS * longestClaimCalls).toBeLessThan(15 * 60_000)
  })
})
