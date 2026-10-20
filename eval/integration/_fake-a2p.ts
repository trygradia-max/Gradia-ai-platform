// A fake of src/lib/twilio-a2p for integration tests: real Postgres, no
// Twilio. Use it with
//   vi.mock("@/lib/twilio-a2p", async () => (await import("./_fake-a2p")).fakeA2pModule())
// and drive it through `fake` (the same module instance the mock uses).
type Campaign = "PENDING" | "IN_PROGRESS" | "VERIFIED" | "FAILED" | "SUSPENDED"

export const fake = {
  /** Every provider call, by step name, in order. */
  calls: [] as string[],
  /** Fail BEFORE the provider acts. */
  fail: new Map<string, unknown>(),
  /** Fail AFTER the provider acted: a response lost in transit. */
  lost: new Map<string, unknown>(),
  /** Per-step delay in ms (slow provider), and a default for every step. */
  slow: new Map<string, number>(),
  delay: 0,
  brand: "PENDING" as "PENDING" | "APPROVED" | "FAILED",
  campaign: "PENDING" as Campaign,
  /** Campaigns that exist at the fake Twilio, per messaging service. */
  onService: new Map<string, { campaignSid: string; brandSid: string }[]>(),
  /** Brands and messaging services that exist at the fake Twilio, per subaccount. */
  brands: [] as { accountSid: string; brandSid: string; customerProfileSid: string; trustProductSid: string }[],
  services: [] as { accountSid: string; messagingServiceSid: string; inboundRequestUrl: string }[],
  /** Fail every call made with this subaccount, until cleared (one tenant's outage). */
  failAccount: new Map<string, unknown>(),
  /** Credentials each call was made with (tenant isolation checks). */
  accounts: [] as { step: string; accountSid: string }[],
  reset() {
    this.calls.length = 0; this.fail.clear(); this.lost.clear(); this.slow.clear(); this.onService.clear()
    this.accounts.length = 0; this.failAccount.clear(); this.brands.length = 0; this.services.length = 0; this.delay = 0; this.brand = "PENDING"; this.campaign = "PENDING"
  },
  count(step: string) { return this.calls.filter((c) => c === step).length },
}

let n = 0
const sid = (prefix: string) => `${prefix}${String(++n).padStart(32, "0")}`

async function run<T>(step: string, creds: unknown, make: () => T): Promise<T> {
  fake.calls.push(step)
  const accountSid = (creds as { accountSid?: string } | null)?.accountSid
  if (accountSid) fake.accounts.push({ step, accountSid })
  const wait = fake.slow.get(step) ?? fake.delay
  if (wait) await new Promise((r) => setTimeout(r, wait))
  const down = accountSid ? fake.failAccount.get(accountSid) : undefined
  if (down) throw down
  const failure = fake.fail.get(step)
  if (failure) { fake.fail.delete(step); throw failure }
  const result = make()
  const lost = fake.lost.get(step)
  if (lost) { fake.lost.delete(step); throw lost }
  return result
}

const account = (c: unknown) => (c as { accountSid?: string } | null)?.accountSid ?? ""
function makeBrand(c: unknown, input: { customerProfileSid: string; trustProductSid: string }) {
  const brandSid = sid("BN")
  fake.brands.push({ accountSid: account(c), brandSid, customerProfileSid: input.customerProfileSid, trustProductSid: input.trustProductSid })
  return { brandSid }
}

export function fakeA2pModule() {
  return {
    registerBusinessProfile: (c: unknown) => run("profile", c, () => ({ customerProfileSid: sid("BU") })),
    registerA2pTrustProduct: (c: unknown) => run("trust_product", c, () => ({ trustProductSid: sid("BU") })),
    registerSoleProprietorProfile: (c: unknown) => run("profile", c, () => ({ customerProfileSid: sid("BU"), trustProductSid: sid("BU") })),
    createBrand: (c: unknown, input: { customerProfileSid: string; trustProductSid: string }) => run("brand", c, () => makeBrand(c, input)),
    createSoleProprietorBrand: (c: unknown, input: { customerProfileSid: string; trustProductSid: string }) => run("brand", c, () => makeBrand(c, input)),
    listBrandRegistrations: (c: unknown) =>
      run("list_brands", c, () => fake.brands.filter((b) => b.accountSid === account(c)).map(({ accountSid: _a, ...b }) => ({ ...b, status: fake.brand }))),
    createMessagingService: (c: unknown, input: { inboundSmsUrl: string }) =>
      run("messaging_service", c, () => {
        const messagingServiceSid = sid("MG")
        fake.services.push({ accountSid: account(c), messagingServiceSid, inboundRequestUrl: input.inboundSmsUrl })
        return { messagingServiceSid }
      }),
    listMessagingServices: (c: unknown) =>
      run("list_services", c, () => fake.services.filter((x) => x.accountSid === account(c)).map(({ accountSid: _a, ...x }) => x)),
    createCampaign: (c: unknown, input: { messagingServiceSid: string; brandSid: string }) =>
      run("campaign", c, () => {
        const campaignSid = sid("QE")
        fake.onService.set(input.messagingServiceSid, [...(fake.onService.get(input.messagingServiceSid) ?? []), { campaignSid, brandSid: input.brandSid }])
        return { campaignSid }
      }),
    listCampaigns: (c: unknown, mg: string) =>
      run("list_campaigns", c, () => (fake.onService.get(mg) ?? []).map((x) => ({ ...x, status: fake.campaign }))),
    updateCampaign: (c: unknown) => run("update_campaign", c, () => undefined),
    attachNumberToMessagingService: (c: unknown) => run("attach_number", c, () => undefined),
    getBrandStatus: (c: unknown) => run("brand_status", c, () => ({ status: fake.brand, failureReason: null })),
    getCampaignStatus: (c: unknown) => run("campaign_status", c, () => ({ status: fake.campaign, errors: null })),
    resendSoleProprietorOtp: async () => undefined,
  }
}

export const business = (legal = "Fictional Detail LLC") => ({
  has_ein: true, legal_name: legal, ein: "12-3456789", business_type: "LLC", website_url: "https://example.test",
  address: { street: "1 Fictional Way", city: "Portland", region: "OR", postal_code: "97201" },
  contact: { first_name: "Fic", last_name: "Tional", email: "owner@example.test", phone: "+15555550100", job_position: "Owner" },
})
