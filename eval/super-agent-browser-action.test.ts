import { afterEach, describe, expect, it, vi } from "vitest"
import { checkRateLimit } from "@/lib/rate-limit"
import { executeBrowserCheck } from "@/lib/super-agent/browser-job"
import { checkCloudBrowser } from "@/app/actions/super-agent-browser"
import { unavailableBrowserCheck } from "@/lib/super-agent/browser"

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/lib/shop", () => ({ requireUser: vi.fn(async () => ({ id: "owner-1" })), requireShop: vi.fn(async () => ({ id: "shop-1", name: "Shine" })) }))
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ from: vi.fn() })) }))
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 1, resetInSeconds: 60 })) }))
vi.mock("@/lib/super-agent/browser-job", () => ({ executeBrowserCheck: vi.fn() }))
vi.mock("@/lib/super-agent/browser-store", () => ({ readBrowserCheck: vi.fn(), saveBrowserCheck: vi.fn() }))
vi.mock("@/lib/super-agent/research-store", () => ({ readEmployeeDraft: vi.fn(), ownerStillHasShop: vi.fn() }))

const input = { id: "00000000-0000-4000-8000-000000000020", draftId: "00000000-0000-4000-8000-000000000021" }
const check = { id: input.id, draft_id: input.draftId, status: "unavailable" as const, detail: unavailableBrowserCheck(true), created_at: "2026-10-16T00:00:00.000Z" }

describe("cloud browser check action", () => {
  afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs() })

  it("does nothing while the flag is off or the burst limit is reached", async () => {
    expect(await checkCloudBrowser(input)).toMatchObject({ ok: false, error: expect.stringMatching(/not enabled/) })
    vi.stubEnv("NEXT_PUBLIC_GRADIA_SUPER_AGENT", "true")
    vi.stubEnv("GRADIA_SUPER_AGENT_BROWSER", "true")
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, remaining: 0, resetInSeconds: 30 })
    expect(await checkCloudBrowser(input)).toMatchObject({ ok: false, error: expect.stringMatching(/wait/) })
    expect(executeBrowserCheck).not.toHaveBeenCalled()
  })

  it("ignores a named provider without storing its name", async () => {
    vi.stubEnv("NEXT_PUBLIC_GRADIA_SUPER_AGENT", "true")
    vi.stubEnv("GRADIA_SUPER_AGENT_BROWSER", "true")
    vi.stubEnv("GRADIA_SUPER_AGENT_BROWSER_PROVIDER", "browserbase-secret")
    vi.mocked(executeBrowserCheck).mockResolvedValueOnce({ ok: true, replayed: false, check })
    expect(await checkCloudBrowser(input)).toMatchObject({ ok: true, replayed: false, check: { status: "unavailable" } })
    expect(executeBrowserCheck).toHaveBeenCalledWith(expect.objectContaining({ namedProviderIgnored: true, shopId: "shop-1", userId: "owner-1" }), expect.anything())
    expect(JSON.stringify(vi.mocked(executeBrowserCheck).mock.calls)).not.toContain("browserbase-secret")
  })
})
