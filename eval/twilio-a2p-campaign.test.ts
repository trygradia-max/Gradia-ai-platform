import { afterEach, describe, expect, it, vi } from "vitest"
import { getCampaignStatus, listCampaigns, updateCampaign } from "@/lib/twilio-a2p"

// The campaign wrappers' wire contract (Twilio Usa2p resource), with fetch
// faked: nothing reaches Twilio.
const creds = { accountSid: "AC" + "1".repeat(32), authToken: "synthetic" }
const MG = "MG" + "2".repeat(32)
const QE = "QE" + "3".repeat(32)

function fakeFetch(body: unknown) {
  const calls: { url: string; method: string; form: URLSearchParams | null }[] = []
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? "GET", form: init.body ? new URLSearchParams(String(init.body)) : null })
    return new Response(JSON.stringify(body), { status: 200 })
  })
  return calls
}
afterEach(() => { vi.unstubAllGlobals() })

describe("Twilio campaign wrappers", () => {
  it("maps every campaign_status explicitly; anything unrecognised is UNKNOWN, never verified", async () => {
    for (const [raw, mapped] of [["VERIFIED", "VERIFIED"], ["FAILED", "FAILED"], ["SUSPENDED", "SUSPENDED"], ["IN_PROGRESS", "IN_PROGRESS"], ["PENDING", "PENDING"], ["EXPIRED", "UNKNOWN"], [null, "UNKNOWN"]]) {
      fakeFetch({ sid: QE, campaign_status: raw })
      expect((await getCampaignStatus(creds, MG, QE)).status).toBe(mapped)
    }
  })

  it("lists the campaigns already on a messaging service from the compliance page", async () => {
    const calls = fakeFetch({
      compliance: [{ sid: QE, brand_registration_sid: "BN" + "4".repeat(32), campaign_status: "in_progress" }],
      meta: { key: "compliance" },
    })
    expect(await listCampaigns(creds, MG)).toEqual([{ campaignSid: QE, brandSid: "BN" + "4".repeat(32), status: "IN_PROGRESS" }])
    expect(calls[0]).toMatchObject({ method: "GET", url: expect.stringContaining(`/Services/${MG}/Compliance/Usa2p?PageSize=50`) })
  })

  it("edits a failed campaign in place with all seven required update fields", async () => {
    const calls = fakeFetch({ sid: QE })
    await updateCampaign(creds, { messagingServiceSid: MG, campaignSid: QE, shopName: "Fictional Detail" })
    expect(calls[0]).toMatchObject({ method: "POST", url: expect.stringContaining(`/Services/${MG}/Compliance/Usa2p/${QE}`) })
    const form = calls[0].form!
    for (const field of ["Description", "MessageFlow", "MessageSamples", "HasEmbeddedLinks", "HasEmbeddedPhone", "AgeGated", "DirectLending"]) {
      expect(form.get(field), field).toBeTruthy()
    }
    expect(form.get("HasEmbeddedLinks")).toBe("false")
    expect(form.get("BrandRegistrationSid")).toBeNull() // an edit, not a create
  })
})
