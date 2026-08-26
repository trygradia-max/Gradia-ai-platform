import { afterEach, describe, expect, it, vi } from "vitest"

import * as aiService from "@/lib/ai-service"
import * as credits from "@/lib/credits"
import * as rateLimit from "@/lib/rate-limit"
import * as shopLib from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import { processRawLeadNote } from "@/app/actions/ai-lead"

/**
 * P0-010 (audit M-1) — the AI Lead extraction action was POST-invocable by
 * anyone with zero auth, metering, or rate limiting: an anonymous Anthropic
 * token burner. These tests lock the gate order: session auth → shop →
 * fail-closed feature access → burst limit → zod → model. The shop is
 * derived SERVER-SIDE from the session (getOptionalShop) — no caller input
 * names a tenant, so there is nothing to forge.
 */

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}))
vi.mock("@/lib/shop", () => ({
  getOptionalShop: vi.fn(),
}))
vi.mock("@/lib/credits", () => ({
  loadShopCreditFields: vi.fn(),
  checkFeatureAccess: vi.fn(),
  recordUsage: vi.fn(async () => "written"),
}))
vi.mock("@/lib/pricing", () => ({
  getPricing: vi.fn(async () => ({})),
  // Trap: inbound_classify retail is 0, but priceUsage still returns
  // credits=1 (Math.max(1, ceil(0))). The action must not pass that through.
  priceUsage: vi.fn(() => ({
    credits: 1,
    wholesale_cost: 0.2,
    retail_cost: 0,
  })),
}))
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const original = await importOriginal<typeof rateLimit>()
  return {
    ...original,
    checkRateLimit: vi.fn(async () => ({
      allowed: true,
      remaining: 19,
      resetInSeconds: 60,
    })),
  }
})
vi.mock("@/lib/ai-service", () => ({
  extractLeadFromRawText: vi.fn(async () => ({ name: "Ada" })),
}))

const mockedCreateClient = vi.mocked(createClient)
const mockedGetOptionalShop = vi.mocked(shopLib.getOptionalShop)
const mockedLoadCreditFields = vi.mocked(credits.loadShopCreditFields)
const mockedFeatureAccess = vi.mocked(credits.checkFeatureAccess)
const mockedRecordUsage = vi.mocked(credits.recordUsage)
const mockedRateLimit = vi.mocked(rateLimit.checkRateLimit)
const mockedExtract = vi.mocked(aiService.extractLeadFromRawText)

function authedClient(userId: string | null) {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: userId ? { id: userId } : null },
      })),
    },
  } as unknown as Awaited<ReturnType<typeof createClient>>
}

function arrangeHappyPath() {
  mockedCreateClient.mockResolvedValue(authedClient("owner-1"))
  mockedGetOptionalShop.mockResolvedValue({ id: "shop-1", name: "Shine Co" })
  mockedLoadCreditFields.mockResolvedValue({
    id: "shop-1",
    plan: "active",
    credit_period_start: "2026-08-01T00:00:00Z",
  } as Awaited<ReturnType<typeof credits.loadShopCreditFields>>)
  mockedFeatureAccess.mockResolvedValue({ ok: true })
  mockedRateLimit.mockResolvedValue({
    allowed: true,
    remaining: 19,
    resetInSeconds: 60,
  })
}

afterEach(() => {
  vi.clearAllMocks()
})

describe("processRawLeadNote — auth gate (M-1)", () => {
  it("refuses an unauthenticated caller before any model call", async () => {
    mockedCreateClient.mockResolvedValue(authedClient(null))

    const result = await processRawLeadNote("walk-in wants ceramic on a Model 3")

    expect(result.ok).toBe(false)
    expect(mockedExtract).not.toHaveBeenCalled()
    expect(mockedRecordUsage).not.toHaveBeenCalled()
  })

  it("refuses an authenticated user with no shop", async () => {
    mockedCreateClient.mockResolvedValue(authedClient("owner-1"))
    mockedGetOptionalShop.mockResolvedValue(null)

    const result = await processRawLeadNote("note")

    expect(result.ok).toBe(false)
    expect(mockedExtract).not.toHaveBeenCalled()
  })

  it("fails closed when feature access is denied (inactive plan / exhausted credits)", async () => {
    arrangeHappyPath()
    mockedFeatureAccess.mockResolvedValue({
      ok: false,
      status: 402,
      reason: "Reactivate your plan to keep using Gradia.",
    })

    const result = await processRawLeadNote("note")

    expect(result).toEqual({
      ok: false,
      error: "Reactivate your plan to keep using Gradia.",
    })
    expect(mockedExtract).not.toHaveBeenCalled()
  })

  it("binds the ai_lead rate limit before the model call", async () => {
    arrangeHappyPath()
    mockedRateLimit.mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetInSeconds: 42,
    })

    const result = await processRawLeadNote("note")

    expect(result.ok).toBe(false)
    expect(mockedRateLimit).toHaveBeenCalledWith("shop-1", "ai_lead")
    expect(mockedExtract).not.toHaveBeenCalled()
  })

  it("rejects oversize input via zod without calling the model", async () => {
    arrangeHappyPath()

    const result = await processRawLeadNote("x".repeat(12_001))

    expect(result.ok).toBe(false)
    expect(mockedExtract).not.toHaveBeenCalled()
  })

  it("processes for an authenticated owner and meters against the session-derived shop", async () => {
    arrangeHappyPath()

    const result = await processRawLeadNote("walk-in wants ceramic on a Model 3")

    expect(result).toEqual({ ok: true, data: { name: "Ada" } })
    expect(mockedExtract).toHaveBeenCalledTimes(1)
    // Tenant comes from getOptionalShop (session), never from caller input.
    expect(mockedRecordUsage).toHaveBeenCalledWith(
      expect.anything(),
      "shop-1",
      "inbound_classify",
      expect.objectContaining({ credits: 0, retailCost: 0, wholesaleCost: 0.2 })
    )
  })

  it("records no usage when extraction fails", async () => {
    arrangeHappyPath()
    mockedExtract.mockRejectedValue(new Error("model unavailable"))

    const result = await processRawLeadNote("note")

    expect(result).toEqual({ ok: false, error: "model unavailable" })
    expect(mockedRecordUsage).not.toHaveBeenCalled()
  })
})
