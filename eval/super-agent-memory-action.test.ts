import { afterEach, describe, expect, it, vi } from "vitest"
import { checkRateLimit } from "@/lib/rate-limit"
import { executeMemoryRead } from "@/lib/super-agent/memory-job"
import { readEmployeeMemory } from "@/app/actions/super-agent-memory"
import { memorySnapshot } from "@/lib/super-agent/memory"

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/lib/shop", () => ({ requireUser: vi.fn(async () => ({ id: "owner-1" })), requireShop: vi.fn(async () => ({ id: "shop-1", name: "Shine" })) }))
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ from: vi.fn() })) }))
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 1, resetInSeconds: 60 })) }))
vi.mock("@/lib/super-agent/memory-job", () => ({ executeMemoryRead: vi.fn() }))
vi.mock("@/lib/super-agent/memory-store", () => ({ readMemoryRead: vi.fn(), saveMemoryRead: vi.fn() }))
vi.mock("@/lib/super-agent/research-store", () => ({ readEmployeeDraft: vi.fn(), ownerStillHasShop: vi.fn() }))

const input = { id: "00000000-0000-4000-8000-000000000030", draftId: "00000000-0000-4000-8000-000000000031" }
const read = { id: input.id, draft_id: input.draftId, detail: memorySnapshot([]), created_at: "2026-10-16T00:00:00.000Z" }

describe("business-note read action", () => {
  afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs() })

  it("does nothing while the flag is off or the burst limit is reached", async () => {
    expect(await readEmployeeMemory(input)).toMatchObject({ ok: false, error: expect.stringMatching(/not enabled/) })
    vi.stubEnv("NEXT_PUBLIC_GRADIA_SUPER_AGENT", "true")
    vi.stubEnv("GRADIA_SUPER_AGENT_MEMORY", "true")
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, remaining: 0, resetInSeconds: 30 })
    expect(await readEmployeeMemory(input)).toMatchObject({ ok: false, error: expect.stringMatching(/wait/) })
    expect(executeMemoryRead).not.toHaveBeenCalled()
  })

  it("asks the job to read this workspace and does not pass research text", async () => {
    vi.stubEnv("NEXT_PUBLIC_GRADIA_SUPER_AGENT", "true")
    vi.stubEnv("GRADIA_SUPER_AGENT_MEMORY", "true")
    vi.mocked(executeMemoryRead).mockResolvedValueOnce({ ok: true, replayed: false, read })
    expect(await readEmployeeMemory(input)).toMatchObject({ ok: true, read: { detail: { published: false } } })
    expect(executeMemoryRead).toHaveBeenCalledWith(expect.objectContaining({ shopId: "shop-1", userId: "owner-1", readId: input.id }), expect.anything())
    expect(JSON.stringify(vi.mocked(executeMemoryRead).mock.calls)).not.toMatch(/research|shop_knowledge/)
  })
})
