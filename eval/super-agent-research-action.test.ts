import { afterEach, describe, expect, it, vi } from "vitest"
import { checkRateLimit } from "@/lib/rate-limit"
import { recordUsage } from "@/lib/credits"
import { executeSavedResearch } from "@/lib/super-agent/research-job"
import { planResearchSteps } from "@/lib/super-agent/research-model"
import { runEmployeeResearch, cancelEmployeeResearch } from "@/app/actions/super-agent"
import type { SavedResearchRun } from "@/lib/super-agent/research-store"

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/lib/shop", () => ({ requireUser: vi.fn(async () => ({ id: "owner-1" })), requireShop: vi.fn(async () => ({ id: "shop-1", name: "Shine" })) }))
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ from: vi.fn() })) }))
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 1, resetInSeconds: 60 })) }))
vi.mock("@/lib/credits", () => ({
  loadShopCreditFields: vi.fn(async () => ({ id: "shop-1", plan: "active", credit_period_start: "2026-01-01T00:00:00Z" })),
  precheckCredits: vi.fn(async () => ({ ok: true, remaining: 100 })),
  recordUsage: vi.fn(async () => "written"),
}))
vi.mock("@/lib/pricing", () => ({ getPricing: vi.fn(async () => ({})), priceUsage: vi.fn(() => ({ credits: 10, wholesale_cost: 3, retail_cost: 10 })) }))
vi.mock("@/lib/super-agent/research-job", () => ({ executeSavedResearch: vi.fn() }))
vi.mock("@/lib/super-agent/research-model", () => ({ planResearchSteps: vi.fn(async () => null) }))
vi.mock("@/lib/super-agent/research-store", () => ({
  readEmployeeDraft: vi.fn(), readResearchRun: vi.fn(async () => null), ownerStillHasShop: vi.fn(async () => true),
  researchWasCancelled: vi.fn(async () => false), requestResearchCancel: vi.fn(async () => "saved"), saveResearchRun: vi.fn(),
}))

const run = { id: "00000000-0000-4000-8000-000000000010", draft_id: "00000000-0000-4000-8000-000000000011", status: "completed", report: {}, credits: 0, created_at: "2026-10-16T00:00:00.000Z" } as SavedResearchRun
const input = { id: run.id, draftId: run.draft_id }

describe("research run action", () => {
  afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs() })

  it("does not run while the research flag is off or the burst limit is reached", async () => {
    expect(await runEmployeeResearch(input)).toMatchObject({ ok: false })
    vi.stubEnv("NEXT_PUBLIC_GRADIA_SUPER_AGENT", "true")
    vi.stubEnv("GRADIA_SUPER_AGENT_RESEARCH", "true")
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, remaining: 0, resetInSeconds: 30 })
    expect(await runEmployeeResearch(input)).toMatchObject({ ok: false, error: expect.stringMatching(/wait/) })
    expect(executeSavedResearch).not.toHaveBeenCalled()
    expect(recordUsage).not.toHaveBeenCalled()
  })

  it("charges a saved model choice once and redacts secrets before the model sees them", async () => {
    vi.stubEnv("NEXT_PUBLIC_GRADIA_SUPER_AGENT", "true")
    vi.stubEnv("GRADIA_SUPER_AGENT_RESEARCH", "true")
    vi.stubEnv("GRADIA_SUPER_AGENT_RESEARCH_MODEL", "true")
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-test-key")
    vi.mocked(executeSavedResearch).mockResolvedValueOnce({ ok: true, replayed: false, run: { ...run, credits: 10 } })
    expect(await runEmployeeResearch(input)).toMatchObject({ ok: true, replayed: false })
    const runtime = vi.mocked(executeSavedResearch).mock.calls[0][2]
    expect(runtime.planWithModel).toEqual(expect.any(Function))
    await runtime.planWithModel?.({ name: "Helper", goal: "Research this public page for me", deliverable: "A sourced note", business_context: "password: hunter2 api_key: abcd", steps: ["Read https://shop.example/"], connections_needed: [], questions: [] }, ["https://shop.example/"])
    expect(planResearchSteps).toHaveBeenCalledWith(expect.objectContaining({ context: expect.not.stringMatching(/hunter2|abcd/), urls: ["https://shop.example/"] }))
    expect(recordUsage).toHaveBeenCalledWith(expect.anything(), "shop-1", "agentic_plan", expect.objectContaining({ credits: 10, vendorRef: `research-plan:${run.id}` }))
  })

  it("does not charge a deterministic or replayed result", async () => {
    vi.stubEnv("NEXT_PUBLIC_GRADIA_SUPER_AGENT", "true")
    vi.stubEnv("GRADIA_SUPER_AGENT_RESEARCH", "true")
    vi.mocked(executeSavedResearch).mockResolvedValueOnce({ ok: true, replayed: true, run })
    expect(await runEmployeeResearch(input)).toMatchObject({ ok: true, replayed: true })
    expect(vi.mocked(executeSavedResearch).mock.calls[0][2].planWithModel).toBeUndefined()
    expect(recordUsage).not.toHaveBeenCalled()
  })

  it("records a stop for this workspace without starting a fetch", async () => {
    vi.stubEnv("NEXT_PUBLIC_GRADIA_SUPER_AGENT", "true")
    vi.stubEnv("GRADIA_SUPER_AGENT_RESEARCH", "true")
    expect(await cancelEmployeeResearch({ id: run.id })).toEqual({ ok: true, state: "requested" })
    expect(executeSavedResearch).not.toHaveBeenCalled()
  })
})
