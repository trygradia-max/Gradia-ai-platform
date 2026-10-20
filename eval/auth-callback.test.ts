import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ exchange: vi.fn(), set: vi.fn() }))
vi.mock("@supabase/ssr", () => ({ createServerClient: vi.fn(() => ({ auth: { exchangeCodeForSession: mocks.exchange } })) }))
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ getAll: () => [], set: mocks.set })) }))
import { GET } from "@/app/auth/callback/route"
const productionOrigin = "https://gradia-ai-platform.vercel.app"
const reviewHost = "gradia-ai-platform-review123-gradia1.vercel.app"
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
  vi.stubEnv("GRADIA_PRIVATE_REVIEW_AUTH", "")
  vi.stubEnv("VERCEL", "1")
  vi.stubEnv("VERCEL_URL", reviewHost)
  mocks.exchange.mockReset().mockResolvedValue({ error: null })
})
afterEach(() => vi.unstubAllEnvs())
describe.each(["production", "private review"])("%s authentication callback", mode => {
  const origin = mode === "production" ? productionOrigin : `https://${reviewHost}`
  beforeEach(() => vi.stubEnv("GRADIA_PRIVATE_REVIEW_AUTH", mode === "production" ? "" : "1"))
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


describe("local dashboard origin", () => {
  beforeEach(() => {
    vi.stubEnv("VERCEL", "")
    vi.stubEnv("GRADIA_PRIVATE_REVIEW_AUTH", "")
  })
  it("stays on a configured loopback origin and ignores request headers", async () => {
    vi.stubEnv("GRADIA_DASHBOARD_URL", "http://127.0.0.1:3000/dashboard")
    const url = new URL("http://127.0.0.1:3000/auth/callback?code=synthetic-exchange-code&next=%2Fonboarding")
    const response = await GET(new Request(url, {
      headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "x-forwarded-host": "evil.example" },
    }))
    expect(response.headers.get("location")).toBe("http://127.0.0.1:3000/onboarding")
    expect(mocks.exchange).toHaveBeenCalledExactlyOnceWith("synthetic-exchange-code")
  })
  it("accepts localhost and drops a path on the configured URL", async () => {
    vi.stubEnv("GRADIA_DASHBOARD_URL", "http://localhost:3000/dashboard")
    expect(await redirect("/customers")).toBe("http://localhost:3000/customers")
  })
  it("keeps an external next path on the loopback origin", async () => {
    vi.stubEnv("GRADIA_DASHBOARD_URL", "http://127.0.0.1:3000")
    expect(await redirect("https://evil.example/phish")).toBe("http://127.0.0.1:3000/dashboard")
  })
  it("keeps a non-loopback dashboard URL on the production origin", async () => {
    vi.stubEnv("GRADIA_DASHBOARD_URL", "https://evil.example/dashboard")
    expect(await redirect("/onboarding")).toBe(productionOrigin + "/onboarding")
  })
  it("does not let a loopback dashboard URL override a Vercel deployment", async () => {
    vi.stubEnv("VERCEL", "1")
    vi.stubEnv("GRADIA_DASHBOARD_URL", "http://127.0.0.1:3000")
    expect(await redirect("/onboarding")).toBe(productionOrigin + "/onboarding")
  })
})

describe("private review configuration", () => {
  it.each([
    "", "external.example", "gradia-ai-platform.vercel.app",
    "gradia-ai-platform-review123-otherteam.vercel.app",
    "gradia-ai-platform-review123-gradia1.vercel.app.evil.example",
    "https://gradia-ai-platform-review123-gradia1.vercel.app",
    "gradia-ai-platform-review123-gradia1.vercel.app:443",
    "gradia-ai-platform-review123-gradia1.vercel.app/path",
    "gradia-ai-platform-review123-gradia1.vercel.app?x=y",
    "gradia-ai-platform-review123-gradia1.vercel.app#fragment",
    "user@gradia-ai-platform-review123-gradia1.vercel.app",
  ])("refuses invalid configured host %s before exchanging a code", async host => {
    vi.stubEnv("GRADIA_PRIVATE_REVIEW_AUTH", "1")
    vi.stubEnv("VERCEL_URL", host)
    const response = await GET(new Request("https://untrusted.invalid/auth/callback?code=synthetic"))
    expect(response.status).toBe(503)
    expect(response.headers.get("location")).toBeNull()
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(mocks.exchange).not.toHaveBeenCalled()
  })
  it.each([["1", ""], ["true", "1"], ["2", "1"]])("fails closed for mode=%s platform=%s", async (mode, platform) => {
    vi.stubEnv("GRADIA_PRIVATE_REVIEW_AUTH", mode)
    vi.stubEnv("VERCEL", platform)
    expect((await GET(new Request("https://untrusted.invalid/auth/callback?code=synthetic"))).status).toBe(503)
    expect(mocks.exchange).not.toHaveBeenCalled()
  })
  it("ignores deployment hosts unless explicitly opted in", async () => {
    vi.stubEnv("GRADIA_PRIVATE_REVIEW_AUTH", "0")
    vi.stubEnv("VERCEL_URL", "external.example")
    expect(await redirect("/customers")).toBe(productionOrigin + "/customers")
  })
})
