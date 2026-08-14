import { createHmac } from "node:crypto"
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest"

import { verifyTwilioSignature } from "@/lib/twilio"
import { verifyStripeSignature } from "@/lib/stripe"
import { verifyAurinkoSignature } from "@/lib/aurinko"
import { verifySlackSignature } from "@/lib/slack"

/**
 * Tier 1 (pure) — webhook signature verification. Every inbound webhook is a
 * security boundary: a verifier that silently starts accepting bad signatures
 * is a remote-write hole, and nothing crashes to tell you. Pure HMAC, so these
 * run free on every change. We forge valid signatures with the same scheme,
 * then assert tamper / wrong-secret / replay / missing-header all reject.
 *
 * P0-006 extends this suite (ADR-001 C3 — extend, never parallel-track) with
 * route-level tests for the Twilio inbound SMS handler: signature verification
 * strictly BEFORE the provider_events claim, claim strictly BEFORE side
 * effects, duplicates suppressed with the same success TwiML, and failures
 * marked so a provider retry can reprocess. DB and vendor layers are mocked
 * here; the real-Postgres proofs live in
 * eval/integration/twilio-inbound-replay.int.test.ts.
 *
 * P0-007 extends it again (same C3 condition, plus C5) for the Vapi webhook's
 * end-of-call branch: claim after per-shop secret verification, replay
 * suppression across transcript/metering/budget/call-record writes, strict
 * metering semantics (a lost usage write fails the event), and the
 * maxDuration < staleAfterSeconds lock. Real-Postgres proofs:
 * eval/integration/vapi-replay.int.test.ts.
 */

// ── Route-dependency mocks (Twilio inbound route tests only — the pure
// signature suites above/below never touch these). Verifiers stay REAL.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("next/headers", () => ({ headers: async () => new Headers() }))
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => fakeDb.client(),
}))
vi.mock("@/lib/provider-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/provider-events")>()),
  claimProviderEvent: vi.fn(),
  completeProviderEvent: vi.fn(async () => true),
  failProviderEvent: vi.fn(async () => true),
}))
vi.mock("@/lib/customers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/customers")>()),
  findOrCreateCustomer: vi.fn(async () => ({ ok: false as const, error: "no customer" })),
}))
vi.mock("@/lib/memory", () => ({
  recordInteraction: vi.fn(async () => ({ ok: true as const, id: "int-1", embedded: false })),
}))
vi.mock("@/lib/customer-context", () => ({
  getCrossChannelHint: vi.fn(async () => null),
}))
vi.mock("@/lib/knowledge", () => ({
  searchShopKnowledge: vi.fn(async () => []),
  formatKnowledgeForPrompt: vi.fn(() => ""),
}))
vi.mock("@/lib/credits", () => ({
  recordUsage: vi.fn(async () => "written"),
}))
vi.mock("@/lib/pricing", () => ({
  getPricing: vi.fn(async () => ({})),
  priceUsage: vi.fn(() => ({ wholesale_cost: 1, retail_cost: 0 })),
}))
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 99, resetInSeconds: 60 })),
}))
vi.mock("@/lib/sms-classifier", () => ({
  classifySms: vi.fn(async () => ({ is_lead: false })),
}))
vi.mock("@/lib/sms-drafter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sms-drafter")>()),
  draftSmsReply: vi.fn(async () => null),
}))
vi.mock("@/lib/slack", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/slack")>()),
  sendLeadApprovalRequest: vi.fn(async () => {}),
  sendSmsApprovalRequest: vi.fn(async () => {}),
}))
// ── Vapi route dependencies (P0-007 suite below) ──
vi.mock("@/lib/call-records", () => ({
  persistCallRecord: vi.fn(async () => {}),
}))
vi.mock("@/lib/voice-provider", () => ({
  voiceBudgetState: vi.fn(async () => ({
    usedMinutes: 0,
    budget: 100,
    warn: false,
    over: false,
  })),
}))
vi.mock("@/lib/vapi-tools", () => ({
  captureLead: vi.fn(async () => "ok"),
  proposeBooking: vi.fn(async () => "ok"),
  quoteService: vi.fn(async () => "ok"),
  proposeQuote: vi.fn(async () => "ok"),
  lookupCustomerHistory: vi.fn(async () => "ok"),
  lookupShopPolicy: vi.fn(async () => "ok"),
  rescheduleAppointment: vi.fn(async () => "ok"),
  cancelAppointment: vi.fn(async () => "ok"),
}))

/**
 * Minimal chainable Supabase stub. Every chained method returns the same
 * thenable; terminals resolve the per-table result configured for the test.
 * Calls are logged so tests can assert which tables were (not) written.
 */
const fakeDb = {
  tables: {} as Record<string, { data: unknown; error: unknown }>,
  calls: [] as Array<{ table: string; method: string }>,
  reset() {
    this.tables = {}
    this.calls = []
  },
  client() {
    return {
      from: (table: string) => {
        const result = fakeDb.tables[table] ?? { data: null, error: null }
        const q: Record<string, unknown> = {
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve(result).then(resolve),
        }
        for (const m of [
          "select", "eq", "is", "gt", "order", "limit", "insert", "update",
        ]) {
          q[m] = () => {
            fakeDb.calls.push({ table, method: m })
            return q
          }
        }
        q.maybeSingle = () => Promise.resolve(result)
        q.single = () => Promise.resolve(result)
        return q
      },
    }
  },
}

const SECRETS: Record<string, string> = {
  TWILIO_AUTH_TOKEN: "twilio_test_token",
  STRIPE_WEBHOOK_SECRET: "whsec_test_secret",
  AURINKO_SIGNING_SECRET: "aurinko_test_secret",
  SLACK_SIGNING_SECRET: "slack_test_secret",
  VAPI_WEBHOOK_SECRET: "vapi_test_secret",
}

const saved: Record<string, string | undefined> = {}
beforeAll(() => {
  for (const [k, v] of Object.entries(SECRETS)) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
})
afterAll(() => {
  for (const k of Object.keys(SECRETS)) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

const nowSec = () => Math.floor(Date.now() / 1000)
const STALE = () => nowSec() - 100_000 // well outside any replay window

describe("Twilio (HMAC-SHA1 over url + sorted form pairs)", () => {
  const url = "https://app.test/api/twilio/sms"
  const form = new URLSearchParams({
    From: "+15035550133",
    To: "+15035550111",
    Body: "do you do ceramic?",
  })
  const sign = (u: string, f: URLSearchParams) => {
    let s = u
    for (const k of [...f.keys()].sort()) s += k + (f.get(k) ?? "")
    return createHmac("sha1", SECRETS.TWILIO_AUTH_TOKEN).update(s).digest("base64")
  }

  it("accepts a valid signature", () => {
    expect(verifyTwilioSignature({ url, form, signature: sign(url, form) })).toBe(true)
  })
  it("rejects a tampered body", () => {
    const sig = sign(url, form)
    const tampered = new URLSearchParams(form)
    tampered.set("Body", "free money")
    expect(verifyTwilioSignature({ url, form: tampered, signature: sig })).toBe(false)
  })
  it("rejects a signature made with the wrong token", () => {
    const bad = createHmac("sha1", "wrong").update(url).digest("base64")
    expect(verifyTwilioSignature({ url, form, signature: bad })).toBe(false)
  })
  it("rejects a missing signature", () => {
    expect(verifyTwilioSignature({ url, form, signature: null })).toBe(false)
  })
})

describe("Stripe (HMAC-SHA256 over `t.body`, with replay window)", () => {
  const body = JSON.stringify({ id: "evt_1", type: "invoice.paid" })
  const header = (ts: number, secret = SECRETS.STRIPE_WEBHOOK_SECRET, b = body) => {
    const v1 = createHmac("sha256", secret).update(`${ts}.${b}`).digest("hex")
    return `t=${ts},v1=${v1}`
  }

  it("accepts a valid, fresh signature", () => {
    expect(verifyStripeSignature({ rawBody: body, signature: header(nowSec()) })).toBe(true)
  })
  it("rejects a tampered body", () => {
    const sig = header(nowSec())
    expect(verifyStripeSignature({ rawBody: body + " ", signature: sig })).toBe(false)
  })
  it("rejects a replayed (stale-timestamp) signature", () => {
    expect(verifyStripeSignature({ rawBody: body, signature: header(STALE()) })).toBe(false)
  })
  it("rejects the wrong secret and a missing header", () => {
    expect(verifyStripeSignature({ rawBody: body, signature: header(nowSec(), "whsec_wrong") })).toBe(false)
    expect(verifyStripeSignature({ rawBody: body, signature: null })).toBe(false)
  })
})

describe("Aurinko (HMAC-SHA256 over `v0:ts:body`, 5-min window)", () => {
  const body = JSON.stringify({ subscription: 1, notifications: [] })
  const sign = (ts: number, b = body, secret = SECRETS.AURINKO_SIGNING_SECRET) =>
    createHmac("sha256", secret).update(`v0:${ts}:${b}`).digest("hex")

  it("accepts a valid, fresh signature", () => {
    const ts = nowSec()
    expect(verifyAurinkoSignature({ rawBody: body, timestamp: String(ts), signature: sign(ts) })).toBe(true)
  })
  it("rejects a tampered body", () => {
    const ts = nowSec()
    expect(verifyAurinkoSignature({ rawBody: body + "x", timestamp: String(ts), signature: sign(ts) })).toBe(false)
  })
  it("rejects a replayed (stale-timestamp) signature", () => {
    const ts = STALE()
    expect(verifyAurinkoSignature({ rawBody: body, timestamp: String(ts), signature: sign(ts) })).toBe(false)
  })
  it("rejects a missing timestamp or signature", () => {
    expect(verifyAurinkoSignature({ rawBody: body, timestamp: null, signature: sign(nowSec()) })).toBe(false)
    expect(verifyAurinkoSignature({ rawBody: body, timestamp: String(nowSec()), signature: null })).toBe(false)
  })
})

describe("Twilio inbound SMS route — claim after verify + replay suppression (P0-006, ADR-001 C3)", () => {
  const ROUTE_URL = "https://app.test/api/twilio/sms"
  const SID = "SM_p0006_test"
  const SHOP = {
    id: "shop-1",
    owner_id: "owner-1",
    name: "Test Shop",
    twilio_phone_number: "+15035550111",
  }

  const signRoute = (u: string, f: URLSearchParams) => {
    let s = u
    for (const k of [...f.keys()].sort()) s += k + (f.get(k) ?? "")
    return createHmac("sha1", SECRETS.TWILIO_AUTH_TOKEN).update(s).digest("base64")
  }

  const makeForm = (over: Record<string, string> = {}) =>
    new URLSearchParams({
      MessageSid: SID,
      AccountSid: "ACtest",
      From: "+15035550133",
      To: "+15035550111",
      Body: "do you do ceramic?",
      ...over,
    })

  /** sig: undefined → sign correctly; null → omit header; string → use as-is. */
  const post = (form: URLSearchParams, sig?: string | null) => {
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
    }
    if (sig !== null) headers["x-twilio-signature"] = sig ?? signRoute(ROUTE_URL, form)
    return POST(new Request(ROUTE_URL, { method: "POST", headers, body: form.toString() }))
  }

  const claimed = (outcome = "claimed", attempts = 1) => ({
    outcome,
    id: "pe-1",
    attempts,
    shouldProcess: ["claimed", "reclaimed_failed", "reclaimed_stale"].includes(outcome),
  })

  let POST: (req: Request) => Promise<Response>
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let claimMock: any
  let completeMock: any
  let failMock: any
  let recordInteractionMock: any
  let classifyMock: any
  let recordUsageMock: any
  let findOrCreateMock: any
  let sendLeadMock: any
  let rateLimitMock: any
  let draftMock: any
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const savedEnv: Record<string, string | undefined> = {}
  beforeAll(async () => {
    // The route derives its public URL from GRADIA_DASHBOARD_URL /
    // forwarded headers; pin the test to the raw request URL.
    for (const k of ["GRADIA_DASHBOARD_URL", "TWILIO_ACCOUNT_SID"]) {
      savedEnv[k] = process.env[k]
    }
    delete process.env.GRADIA_DASHBOARD_URL
    process.env.TWILIO_ACCOUNT_SID = "ACtest"
    ;({ POST } = await import("@/app/api/twilio/sms/route"))
    claimMock = vi.mocked((await import("@/lib/provider-events")).claimProviderEvent)
    completeMock = vi.mocked((await import("@/lib/provider-events")).completeProviderEvent)
    failMock = vi.mocked((await import("@/lib/provider-events")).failProviderEvent)
    recordInteractionMock = vi.mocked((await import("@/lib/memory")).recordInteraction)
    classifyMock = vi.mocked((await import("@/lib/sms-classifier")).classifySms)
    recordUsageMock = vi.mocked((await import("@/lib/credits")).recordUsage)
    findOrCreateMock = vi.mocked((await import("@/lib/customers")).findOrCreateCustomer)
    sendLeadMock = vi.mocked((await import("@/lib/slack")).sendLeadApprovalRequest)
    rateLimitMock = vi.mocked((await import("@/lib/rate-limit")).checkRateLimit)
    draftMock = vi.mocked((await import("@/lib/sms-drafter")).draftSmsReply)
  })
  afterAll(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  beforeEach(() => {
    vi.clearAllMocks()
    fakeDb.reset()
    fakeDb.tables.shops = { data: SHOP, error: null }
    fakeDb.tables.pending_actions = { data: { id: "pa-1" }, error: null }
    fakeDb.tables.interactions = { data: [], error: null }
    claimMock.mockResolvedValue(claimed())
    completeMock.mockResolvedValue(true)
    failMock.mockResolvedValue(true)
    recordInteractionMock.mockResolvedValue({ ok: true, id: "int-1", embedded: false })
    classifyMock.mockResolvedValue({ is_lead: false })
    recordUsageMock.mockResolvedValue("written")
    findOrCreateMock.mockResolvedValue({ ok: false, error: "no customer" })
    sendLeadMock.mockResolvedValue(undefined)
    rateLimitMock.mockResolvedValue({ allowed: true, remaining: 99, resetInSeconds: 60 })
    draftMock.mockResolvedValue(null)
  })

  it("rejects a forged signature BEFORE any claim — no provider_events reach, no side effects", async () => {
    const res = await post(makeForm(), "not-a-real-signature")
    expect(res.status).toBe(401)
    expect(claimMock).not.toHaveBeenCalled()
    expect(recordInteractionMock).not.toHaveBeenCalled()
    expect(classifyMock).not.toHaveBeenCalled()
    expect(recordUsageMock).not.toHaveBeenCalled()
  })

  it("rejects a missing signature without claiming", async () => {
    const res = await post(makeForm(), null)
    expect(res.status).toBe(401)
    expect(claimMock).not.toHaveBeenCalled()
  })

  it("a forged request cannot poison a MessageSid — the legitimate delivery still processes", async () => {
    const forged = await post(makeForm(), "forged-signature")
    expect(forged.status).toBe(401)
    expect(claimMock).not.toHaveBeenCalled()

    const real = await post(makeForm())
    expect(real.status).toBe(200)
    expect(claimMock).toHaveBeenCalledTimes(1)
    expect(claimMock.mock.calls[0][1]).toMatchObject({
      provider: "twilio",
      eventId: SID,
      shopId: SHOP.id,
    })
  })

  it("valid first delivery: claims before any side effect, processes once, completes, stages one card", async () => {
    classifyMock.mockResolvedValue({
      is_lead: true,
      customer_name: "Dana",
      service: "ceramic coating",
      vehicle: null,
      summary: "wants ceramic",
    })
    const res = await post(makeForm())
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("<Response></Response>")

    // Ordering: claim strictly before the first write and the LLM call.
    expect(claimMock).toHaveBeenCalledTimes(1)
    expect(claimMock.mock.invocationCallOrder[0]).toBeLessThan(
      recordInteractionMock.mock.invocationCallOrder[0]
    )
    expect(claimMock.mock.invocationCallOrder[0]).toBeLessThan(
      classifyMock.mock.invocationCallOrder[0]
    )
    expect(recordInteractionMock).toHaveBeenCalledTimes(1)
    expect(classifyMock).toHaveBeenCalledTimes(1)
    expect(recordUsageMock).toHaveBeenCalledTimes(1)
    expect(sendLeadMock).toHaveBeenCalledTimes(1)
    expect(completeMock).toHaveBeenCalledWith(expect.anything(), "twilio", SID)
    expect(failMock).not.toHaveBeenCalled()
  })

  it("duplicate after completion: same success TwiML, ZERO side effects", async () => {
    claimMock.mockResolvedValue(claimed("duplicate_completed"))
    const res = await post(makeForm())
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("<Response></Response>")
    expect(recordInteractionMock).not.toHaveBeenCalled()
    expect(classifyMock).not.toHaveBeenCalled()
    expect(recordUsageMock).not.toHaveBeenCalled()
    expect(sendLeadMock).not.toHaveBeenCalled()
    expect(completeMock).not.toHaveBeenCalled()
    expect(fakeDb.calls.filter((c) => c.table !== "shops")).toHaveLength(0)
  })

  it("duplicate while the winner is still processing: loser exits cleanly with success", async () => {
    claimMock.mockResolvedValue(claimed("duplicate_processing"))
    const res = await post(makeForm())
    expect(res.status).toBe(200)
    expect(recordInteractionMock).not.toHaveBeenCalled()
    expect(completeMock).not.toHaveBeenCalled()
    expect(failMock).not.toHaveBeenCalled()
  })

  it("claim storage failure fails closed — 5xx, nothing processed unguarded", async () => {
    claimMock.mockRejectedValue(new Error("db unreachable"))
    const res = await post(makeForm())
    expect(res.status).toBe(500)
    expect(recordInteractionMock).not.toHaveBeenCalled()
    expect(classifyMock).not.toHaveBeenCalled()
  })

  it("processing failure marks the claim failed and returns 5xx so a retry can reprocess", async () => {
    recordInteractionMock.mockResolvedValue({ ok: false, error: "insert exploded" })
    const res = await post(makeForm())
    expect(res.status).toBe(500)
    expect(failMock).toHaveBeenCalledWith(
      expect.anything(),
      "twilio",
      SID,
      expect.any(Error)
    )
    expect(completeMock).not.toHaveBeenCalled()
  })

  it("classifier outage: still meters once, fails the claim, 5xx (manual-acceptance step 4 semantics)", async () => {
    classifyMock.mockRejectedValue(new Error("anthropic down"))
    const res = await post(makeForm())
    expect(res.status).toBe(500)
    expect(recordUsageMock).toHaveBeenCalledTimes(1)
    expect(failMock).toHaveBeenCalledTimes(1)
    expect(completeMock).not.toHaveBeenCalled()
  })

  it("a real metering write failure fails the claim BEFORE any staging — retryable 5xx, no card", async () => {
    classifyMock.mockResolvedValue({ is_lead: true, summary: "would stage" })
    recordUsageMock.mockResolvedValue("failed")
    const res = await post(makeForm())
    expect(res.status).toBe(500)
    expect(failMock).toHaveBeenCalledTimes(1)
    expect(completeMock).not.toHaveBeenCalled()
    // Nothing non-idempotent staged downstream of the lost ledger write.
    expect(sendLeadMock).not.toHaveBeenCalled()
    expect(
      fakeDb.calls.filter((c) => c.table === "pending_actions")
    ).toHaveLength(0)
  })

  it("a duplicate metering write is idempotent success — processing continues and completes", async () => {
    classifyMock.mockResolvedValue({ is_lead: true, summary: "stages fine" })
    recordUsageMock.mockResolvedValue("duplicate")
    const res = await post(makeForm())
    expect(res.status).toBe(200)
    expect(sendLeadMock).toHaveBeenCalledTimes(1)
    expect(completeMock).toHaveBeenCalledTimes(1)
    expect(failMock).not.toHaveBeenCalled()
  })

  it("retry after failure (reclaimed_failed) reprocesses but never re-inserts the interaction", async () => {
    claimMock.mockResolvedValue(claimed("reclaimed_failed", 2))
    fakeDb.tables.interactions = { data: [{ id: "int-existing" }], error: null }
    const res = await post(makeForm())
    expect(res.status).toBe(200)
    expect(recordInteractionMock).not.toHaveBeenCalled() // deduped on reprocess
    expect(classifyMock).toHaveBeenCalledTimes(1) // pipeline still completes
    expect(completeMock).toHaveBeenCalledTimes(1)
  })

  it("retry after an early failure (nothing written yet) records the interaction exactly once", async () => {
    claimMock.mockResolvedValue(claimed("reclaimed_failed", 2))
    fakeDb.tables.interactions = { data: [], error: null }
    const res = await post(makeForm())
    expect(res.status).toBe(200)
    expect(recordInteractionMock).toHaveBeenCalledTimes(1)
  })

  it("a signed request without a MessageSid is acknowledged but never claimed or processed", async () => {
    const form = makeForm()
    form.delete("MessageSid")
    const res = await post(form)
    expect(res.status).toBe(200)
    expect(claimMock).not.toHaveBeenCalled()
    expect(recordInteractionMock).not.toHaveBeenCalled()
  })

  it("unknown To number (no tenant): acknowledged safely, no claim, no side effects", async () => {
    fakeDb.tables.shops = { data: null, error: null }
    const res = await post(makeForm())
    expect(res.status).toBe(200)
    expect(claimMock).not.toHaveBeenCalled()
    expect(recordInteractionMock).not.toHaveBeenCalled()
  })

  it("shop lookup outage fails closed with 5xx before any claim", async () => {
    fakeDb.tables.shops = { data: null, error: { message: "pg down" } }
    const res = await post(makeForm())
    expect(res.status).toBe(500)
    expect(claimMock).not.toHaveBeenCalled()
  })

  it("malformed payload (missing From/To) is acknowledged with zero side effects", async () => {
    const res = await post(new URLSearchParams({ MessageSid: SID }))
    expect(res.status).toBe(200)
    expect(claimMock).not.toHaveBeenCalled()
    expect(recordInteractionMock).not.toHaveBeenCalled()
  })

  it("non-lead message completes the claim without staging any card", async () => {
    classifyMock.mockResolvedValue({ is_lead: false })
    const res = await post(makeForm())
    expect(res.status).toBe(200)
    expect(sendLeadMock).not.toHaveBeenCalled()
    expect(completeMock).toHaveBeenCalledTimes(1)
  })

  it("STOP applies consent exactly once; a replayed STOP applies nothing", async () => {
    findOrCreateMock.mockResolvedValue({
      ok: true,
      customer: { id: "cust-1" },
      created: false,
    })
    const stopForm = makeForm({ Body: "STOP" })
    const first = await post(stopForm)
    expect(first.status).toBe(200)
    const consentWrites = fakeDb.calls.filter(
      (c) => c.table === "customers" && c.method === "update"
    )
    expect(consentWrites).toHaveLength(1)

    // Replay of the SAME MessageSid: suppressed — no second consent write.
    fakeDb.calls = []
    claimMock.mockResolvedValue(claimed("duplicate_completed"))
    const replay = await post(stopForm)
    expect(replay.status).toBe(200)
    expect(
      fakeDb.calls.filter((c) => c.table === "customers" && c.method === "update")
    ).toHaveLength(0)
  })

  it("a consent write failure fails the claim (compliance never fails silently)", async () => {
    findOrCreateMock.mockResolvedValue({
      ok: true,
      customer: { id: "cust-1" },
      created: false,
    })
    fakeDb.tables.customers = { data: null, error: { message: "rls denied" } }
    const res = await post(makeForm({ Body: "STOP" }))
    expect(res.status).toBe(500)
    expect(failMock).toHaveBeenCalledTimes(1)
  })

  it("complete-mark failure after successful processing still returns success (no duplicate-inducing retry)", async () => {
    completeMock.mockRejectedValue(new Error("pg blip"))
    const res = await post(makeForm())
    expect(res.status).toBe(200)
    expect(failMock).not.toHaveBeenCalled()
  })
})

describe("Slack (v0= HMAC-SHA256 over `v0:ts:body`, 5-min window)", () => {
  const body = "payload=%7B%22type%22%3A%22block_actions%22%7D"
  const sign = (ts: number, b = body, secret = SECRETS.SLACK_SIGNING_SECRET) =>
    "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${b}`).digest("hex")

  it("accepts a valid, fresh signature", () => {
    const ts = nowSec()
    expect(verifySlackSignature({ rawBody: body, timestamp: String(ts), signature: sign(ts) })).toBe(true)
  })
  it("rejects a tampered body", () => {
    const ts = nowSec()
    expect(verifySlackSignature({ rawBody: "payload=evil", timestamp: String(ts), signature: sign(ts) })).toBe(false)
  })
  it("rejects a replayed (stale-timestamp) signature", () => {
    const ts = STALE()
    expect(verifySlackSignature({ rawBody: body, timestamp: String(ts), signature: sign(ts) })).toBe(false)
  })
  it("rejects a missing signature", () => {
    expect(verifySlackSignature({ rawBody: body, timestamp: String(nowSec()), signature: null })).toBe(false)
  })
})

describe("Vapi webhook route — claim after verify + end-of-call replay suppression (P0-007, ADR-001 C3/C5)", () => {
  const ROUTE_URL = "https://app.test/api/vapi/webhook"
  const CALL_ID = "call_p0007_test"
  const SHOP = {
    id: "shop-v1",
    name: "Test Shop",
    vapi_server_secret_enc: null,
    voice_addon: true,
    voice_minutes_budget: null,
  }

  type VapiOver = Record<string, unknown>
  const endOfCall = (over: VapiOver = {}, callOver: VapiOver = {}) => ({
    message: {
      type: "end-of-call-report",
      call: {
        id: CALL_ID,
        assistantId: "asst_1",
        customer: { number: "+15035550142", name: "Dana" },
        ...callOver,
      },
      messages: [
        { role: "user", message: "hi, do you do ceramic?" },
        { role: "assistant", message: "We do — want a quote?" },
      ],
      durationSeconds: 95,
      endedReason: "customer-ended-call",
      ...over,
    },
  })

  /** secret: undefined → correct secret; null → omit header; string → as-is. */
  const post = (body: unknown, secret?: string | null) => {
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (secret !== null) headers["x-vapi-secret"] = secret ?? SECRETS.VAPI_WEBHOOK_SECRET
    return VAPI_POST(
      new Request(ROUTE_URL, { method: "POST", headers, body: JSON.stringify(body) })
    )
  }

  const claimed = (outcome = "claimed", attempts = 1) => ({
    outcome,
    id: "pe-v1",
    attempts,
    shouldProcess: ["claimed", "reclaimed_failed", "reclaimed_stale"].includes(outcome),
  })

  let VAPI_POST: (req: Request) => Promise<Response>
  let routeMaxDuration: number
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let claimMock: any
  let completeMock: any
  let failMock: any
  let recordInteractionMock: any
  let recordUsageMock: any
  let findOrCreateMock: any
  let persistCallRecordMock: any
  let voiceBudgetMock: any
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const savedEnv: Record<string, string | undefined> = {}
  beforeAll(async () => {
    for (const k of ["VAPI_DEFAULT_SHOP_ID", "VERCEL_ENV"]) {
      savedEnv[k] = process.env[k]
      delete process.env[k]
    }
    const route = await import("@/app/api/vapi/webhook/route")
    VAPI_POST = route.POST
    routeMaxDuration = route.maxDuration
    claimMock = vi.mocked((await import("@/lib/provider-events")).claimProviderEvent)
    completeMock = vi.mocked((await import("@/lib/provider-events")).completeProviderEvent)
    failMock = vi.mocked((await import("@/lib/provider-events")).failProviderEvent)
    recordInteractionMock = vi.mocked((await import("@/lib/memory")).recordInteraction)
    recordUsageMock = vi.mocked((await import("@/lib/credits")).recordUsage)
    findOrCreateMock = vi.mocked((await import("@/lib/customers")).findOrCreateCustomer)
    persistCallRecordMock = vi.mocked((await import("@/lib/call-records")).persistCallRecord)
    voiceBudgetMock = vi.mocked((await import("@/lib/voice-provider")).voiceBudgetState)
  })
  afterAll(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  beforeEach(() => {
    vi.clearAllMocks()
    fakeDb.reset()
    fakeDb.tables.shops = { data: SHOP, error: null }
    fakeDb.tables.interactions = { data: null, error: null }
    claimMock.mockResolvedValue(claimed())
    completeMock.mockResolvedValue(true)
    failMock.mockResolvedValue(true)
    recordInteractionMock.mockResolvedValue({ ok: true, id: "int-1", embedded: false })
    recordUsageMock.mockResolvedValue("written")
    findOrCreateMock.mockResolvedValue({
      ok: true,
      customer: { id: "cust-v1" },
      created: false,
    })
    persistCallRecordMock.mockResolvedValue(undefined)
    voiceBudgetMock.mockResolvedValue({
      usedMinutes: 2,
      budget: 100,
      warn: false,
      over: false,
    })
  })

  it("rejects a missing x-vapi-secret BEFORE any claim — no provider_events reach, no side effects", async () => {
    const res = await post(endOfCall(), null)
    expect(res.status).toBe(401)
    expect(claimMock).not.toHaveBeenCalled()
    expect(recordInteractionMock).not.toHaveBeenCalled()
    expect(recordUsageMock).not.toHaveBeenCalled()
    expect(persistCallRecordMock).not.toHaveBeenCalled()
  })

  it("a forged secret cannot poison a call id — 401 with no claim; the legitimate delivery still processes", async () => {
    const forged = await post(endOfCall(), "not-the-secret")
    expect(forged.status).toBe(401)
    expect(claimMock).not.toHaveBeenCalled()

    const real = await post(endOfCall())
    expect(real.status).toBe(200)
    expect(claimMock).toHaveBeenCalledTimes(1)
    expect(claimMock.mock.calls[0][1]).toMatchObject({
      provider: "vapi",
      eventId: CALL_ID,
      shopId: SHOP.id,
    })
  })

  it("valid first delivery: claims before any write, ingests each turn once, meters once with vendor_ref = call id, completes", async () => {
    const res = await post(endOfCall())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, turnsIngested: 2 })

    // Ordering: claim strictly before the first transcript write + metering.
    expect(claimMock).toHaveBeenCalledTimes(1)
    expect(claimMock.mock.invocationCallOrder[0]).toBeLessThan(
      recordInteractionMock.mock.invocationCallOrder[0]
    )
    expect(claimMock.mock.invocationCallOrder[0]).toBeLessThan(
      recordUsageMock.mock.invocationCallOrder[0]
    )
    expect(recordInteractionMock).toHaveBeenCalledTimes(2)
    expect(recordUsageMock).toHaveBeenCalledTimes(1)
    const [, usageShopId, usageKind, usageOpts] = recordUsageMock.mock.calls[0]
    expect(usageShopId).toBe(SHOP.id)
    expect(usageKind).toBe("voice_minute")
    expect(usageOpts).toMatchObject({ vendorRef: CALL_ID, quantity: 2, credits: 0 })
    expect(persistCallRecordMock).toHaveBeenCalledTimes(1)
    expect(completeMock).toHaveBeenCalledWith(expect.anything(), "vapi", CALL_ID)
    expect(failMock).not.toHaveBeenCalled()
  })

  it("C5 lock: the claim's staleAfterSeconds is strictly above the route maxDuration", async () => {
    await post(endOfCall())
    expect(claimMock).toHaveBeenCalledTimes(1)
    const staleAfterSeconds = claimMock.mock.calls[0][1].staleAfterSeconds
    expect(typeof routeMaxDuration).toBe("number")
    expect(typeof staleAfterSeconds).toBe("number")
    expect(routeMaxDuration).toBeLessThan(staleAfterSeconds)
  })

  it("duplicate after completion: 2xx with ZERO side effects — no transcript, metering, budget, or call-record writes", async () => {
    claimMock.mockResolvedValue(claimed("duplicate_completed"))
    const res = await post(endOfCall())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, duplicate: true })
    expect(recordInteractionMock).not.toHaveBeenCalled()
    expect(recordUsageMock).not.toHaveBeenCalled()
    expect(voiceBudgetMock).not.toHaveBeenCalled()
    expect(persistCallRecordMock).not.toHaveBeenCalled()
    expect(completeMock).not.toHaveBeenCalled()
    expect(fakeDb.calls.filter((c) => c.table !== "shops")).toHaveLength(0)
  })

  it("duplicate while the winner is still processing: loser exits cleanly with 2xx and no writes", async () => {
    claimMock.mockResolvedValue(claimed("duplicate_processing"))
    const res = await post(endOfCall())
    expect(res.status).toBe(200)
    expect(recordInteractionMock).not.toHaveBeenCalled()
    expect(recordUsageMock).not.toHaveBeenCalled()
    expect(completeMock).not.toHaveBeenCalled()
    expect(failMock).not.toHaveBeenCalled()
  })

  it("end-of-call with no call id: 400 structured rejection — never claim or meter without a provider identifier", async () => {
    const res = await post(endOfCall({}, { id: undefined }))
    expect(res.status).toBe(400)
    expect(claimMock).not.toHaveBeenCalled()
    expect(recordInteractionMock).not.toHaveBeenCalled()
    expect(recordUsageMock).not.toHaveBeenCalled()
    expect(persistCallRecordMock).not.toHaveBeenCalled()
  })

  it("claim-storage outage fails closed: 5xx, nothing processed unguarded", async () => {
    claimMock.mockRejectedValue(new Error("pg down"))
    const res = await post(endOfCall())
    expect(res.status).toBe(500)
    expect(recordInteractionMock).not.toHaveBeenCalled()
    expect(recordUsageMock).not.toHaveBeenCalled()
  })

  it("a transcript insert failure fails the event (5xx) so the provider retry can resume — never a silent partial transcript", async () => {
    recordInteractionMock.mockResolvedValue({ ok: false, error: "rls denied" })
    const res = await post(endOfCall())
    expect(res.status).toBe(500)
    expect(failMock).toHaveBeenCalledTimes(1)
    expect(completeMock).not.toHaveBeenCalled()
    expect(recordUsageMock).not.toHaveBeenCalled()
  })

  it("a real metering write failure fails the event (5xx) — a known-lost usage row never completes as billed", async () => {
    recordUsageMock.mockResolvedValue("failed")
    const res = await post(endOfCall())
    expect(res.status).toBe(500)
    expect(failMock).toHaveBeenCalledTimes(1)
    expect(completeMock).not.toHaveBeenCalled()
    // Metering failed before the budget/capture stage ran.
    expect(persistCallRecordMock).not.toHaveBeenCalled()
  })

  it("a duplicate usage row (unique violation) is idempotent success — processing continues and completes", async () => {
    recordUsageMock.mockResolvedValue("duplicate")
    const res = await post(endOfCall())
    expect(res.status).toBe(200)
    expect(completeMock).toHaveBeenCalledTimes(1)
    expect(failMock).not.toHaveBeenCalled()
    expect(persistCallRecordMock).toHaveBeenCalledTimes(1)
  })

  it("complete-mark failure after successful processing still returns success (no duplicate-inducing retry)", async () => {
    completeMock.mockRejectedValue(new Error("pg blip"))
    const res = await post(endOfCall())
    expect(res.status).toBe(200)
    expect(failMock).not.toHaveBeenCalled()
  })

  it("retry after failure resumes the transcript at the already-written turn count (no duplicate turns)", async () => {
    claimMock.mockResolvedValue(claimed("reclaimed_failed", 2))
    fakeDb.tables.interactions = { data: null, error: null, count: 1 } as never
    const res = await post(endOfCall())
    expect(res.status).toBe(200)
    // 2 turns in the payload, 1 already durable → exactly 1 new write.
    expect(recordInteractionMock).toHaveBeenCalledTimes(1)
    expect(recordUsageMock).toHaveBeenCalledTimes(1)
    expect(completeMock).toHaveBeenCalledTimes(1)
  })

  it("prod guard: VAPI_DEFAULT_SHOP_ID fallback is refused in production mode — fail closed, zero writes", async () => {
    process.env.VAPI_DEFAULT_SHOP_ID = SHOP.id
    process.env.VERCEL_ENV = "production"
    try {
      // No assistant match: the shops lookup finds nothing.
      fakeDb.tables.shops = { data: null, error: null }
      const res = await post(endOfCall({}, { assistantId: "asst_unknown" }))
      expect(res.status).toBe(404)
      expect(claimMock).not.toHaveBeenCalled()
      expect(recordInteractionMock).not.toHaveBeenCalled()
      expect(recordUsageMock).not.toHaveBeenCalled()
      expect(persistCallRecordMock).not.toHaveBeenCalled()
    } finally {
      delete process.env.VAPI_DEFAULT_SHOP_ID
      delete process.env.VERCEL_ENV
    }
  })

  it("prod guard: the dev fallback still works outside production mode", async () => {
    process.env.VAPI_DEFAULT_SHOP_ID = SHOP.id
    try {
      // No assistantId at all → straight to the dev fallback lookup.
      const res = await post(endOfCall({}, { assistantId: undefined }))
      expect(res.status).toBe(200)
      expect(claimMock).toHaveBeenCalledTimes(1)
    } finally {
      delete process.env.VAPI_DEFAULT_SHOP_ID
    }
  })

  it("non-end-of-call events are acknowledged without any provider_events claim (out of P0-007 scope)", async () => {
    const toolCalls = await post({
      message: {
        type: "tool-calls",
        call: { id: CALL_ID, assistantId: "asst_1" },
        toolCallList: [
          { id: "tc-1", function: { name: "quote_service", arguments: { service: "ceramic" } } },
        ],
      },
    })
    expect(toolCalls.status).toBe(200)
    const statusUpdate = await post({
      message: { type: "status-update", call: { id: CALL_ID, assistantId: "asst_1" } },
    })
    expect(statusUpdate.status).toBe(200)
    expect(claimMock).not.toHaveBeenCalled()
    expect(recordUsageMock).not.toHaveBeenCalled()
  })
})
