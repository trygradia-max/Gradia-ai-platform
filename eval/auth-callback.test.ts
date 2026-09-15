import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ exchange: vi.fn(), set: vi.fn() }))
vi.mock("@supabase/ssr", () => ({ createServerClient: vi.fn(() => ({ auth: { exchangeCodeForSession: mocks.exchange } })) }))
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ getAll: () => [], set: mocks.set })) }))
import { GET } from "@/app/auth/callback/route"
const origin = "https://gradia-ai-platform.vercel.app"
async function redirect(next?: string, code: string | null = "synthetic-exchange-code") {
  const url = new URL("https://untrusted.invalid/auth/callback")
  if (code) url.searchParams.set("code", code)
  if (next !== undefined) url.searchParams.set("next", next)
  const response = await GET(new Request(url, { headers: { host: "untrusted.invalid", "x-forwarded-host": "external.example", origin: "https://external.example" } }))
  return response.headers.get("location")
}
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:56531")
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "synthetic-public-key")
  mocks.exchange.mockReset().mockResolvedValue({ error: null })
})
afterEach(() => vi.unstubAllEnvs())
describe("production authentication callback", () => {
  it.each(["/customers", "/calendar?view=week&date=2026-09-15", "/customers?search=Jane%20Doe#details", "/dashboard#activity"])("preserves internal destination %s", async next => {
    expect(await redirect(next)).toBe(origin + next)
    expect(mocks.exchange).toHaveBeenCalledExactlyOnceWith("synthetic-exchange-code")
  })
  it.each([undefined, "", "https://external.example", "http://external.example", "//external.example", "@external.example/", "https://user@external.example", "javascript:alert(1)", "data:text/html,test", "\\external.example", "/\\external.example", "\\/external.example", "%2f%2fexternal.example", "/%2fexternal.example", "/%252fexternal.example", "/%255cexternal.example", "/%2e%2e//external.example", "/a/../customers", "/./customers", "/%00evil", "/%0d%0aevil", "/bad\npath", "/bad\tpath", "/bad\u007fpath", " /customers", "/%ZZ", "/%E0%A4", "/customers?code=private", "/customers?access_token=private", "/customers#refresh_token=private", "/customers?%2563ode=private", "/synthetic-exchange-code", "/customers?search=synthetic-exchange-code"])("defaults safely for %s", async next => {
    expect(await redirect(next)).toBe(origin + "/dashboard")
  })
  it("does not propagate outer callback secrets", async () => {
    expect(await redirect("/customers")).toBe(origin + "/customers")
  })
  it("keeps exchange failures on the trusted origin", async () => {
    mocks.exchange.mockResolvedValue({ error: { message: "private failure" } })
    expect(await redirect("@external.example/")).toBe(origin + "/login?error=auth")
  })
  it("keeps missing-code failures on the trusted origin", async () => {
    expect(await redirect("/customers", null)).toBe(origin + "/login?error=auth")
    expect(mocks.exchange).not.toHaveBeenCalled()
  })
  it("keeps missing-config failures on the trusted origin", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "")
    expect(await redirect("//external.example")).toBe(origin + "/login?error=config")
    expect(mocks.exchange).not.toHaveBeenCalled()
  })
})
