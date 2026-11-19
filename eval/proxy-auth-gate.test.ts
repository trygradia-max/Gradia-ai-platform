import { readdirSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mocks = vi.hoisted(() => ({ getUser: vi.fn() }))
vi.mock("@supabase/ssr", () => ({ createServerClient: vi.fn(() => ({ auth: { getUser: mocks.getUser } })) }))
import { PUBLIC_PAGE_PATHS, SIGNED_IN_PREFIXES, pathRequiresSession, updateSession } from "@/lib/supabase/middleware"

/** Route of every `page.tsx` under src/app, route groups removed, dynamic segments kept as `[x]`. */
function pageRoutes(): string[] {
  const root = join(process.cwd(), "src", "app")
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name === "page.tsx") {
        const segments = relative(root, dir).split(sep).filter((s) => s && !/^\(.*\)$/.test(s))
        out.push("/" + segments.join("/"))
      }
    }
  }
  walk(root)
  return out.sort()
}

describe("signed-out gate at the proxy", () => {
  it("every page route is either explicitly public or gated, so a new route cannot silently skip the gate", () => {
    const routes = pageRoutes()
    expect(routes.length).toBeGreaterThan(20)
    const ungated = routes.filter(
      (route) => !(PUBLIC_PAGE_PATHS as readonly string[]).includes(route) && !pathRequiresSession(route.replace(/\[[^\]]+\]/g, "x"))
    )
    expect(ungated).toEqual([])
  })

  it("only the four intended pages are public", () => {
    expect([...PUBLIC_PAGE_PATHS]).toEqual(["/", "/login", "/how-it-works", "/q/[token]"])
    for (const route of PUBLIC_PAGE_PATHS) expect(pathRequiresSession(route.replace(/\[[^\]]+\]/g, "x"))).toBe(false)
  })

  it("matches whole path segments, not string prefixes", () => {
    expect(pathRequiresSession("/agents")).toBe(true)
    expect(pathRequiresSession("/agents/abc/revisions/2")).toBe(true)
    expect(pathRequiresSession("/agent")).toBe(true)
    expect(pathRequiresSession("/agentless")).toBe(false)
    expect(pathRequiresSession("/teamwork")).toBe(false)
    expect(pathRequiresSession("/q/token")).toBe(false)
    expect(pathRequiresSession("/api/health")).toBe(false)
    expect(pathRequiresSession("/")).toBe(false)
    for (const p of SIGNED_IN_PREFIXES) expect(pathRequiresSession(p), p).toBe(true)
  })
})

describe("updateSession redirect and return path", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:58531")
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "synthetic-public-key")
    mocks.getUser.mockReset()
  })
  afterEach(() => vi.unstubAllEnvs())
  const request = (path: string) => new NextRequest(new URL(path, "http://127.0.0.1:3100"))

  it.each([
    "/agents",
    "/agents/build?agent=11111111-1111-4111-8111-111111111111&step=tools",
    "/approvals",
    "/team/approvals?shop=22222222-2222-4222-8222-222222222222",
    "/customers?search=Jane%20Doe",
    "/billing",
    "/control-center",
    "/starting-point?revise=1",
    "/conversations/33333333-3333-4333-8333-333333333333",
  ])("sends a signed-out visitor to %s to /login with that exact destination", async (path) => {
    mocks.getUser.mockResolvedValue({ data: { user: null } })
    const response = await updateSession(request(path))
    expect(response.status).toBe(307)
    const location = new URL(response.headers.get("location")!)
    expect(location.pathname).toBe("/login")
    expect(location.searchParams.get("next")).toBe(path)
    expect([...location.searchParams.keys()]).toEqual(["next"])
  })

  it("never sends a signed-out visitor to /onboarding or loses the destination", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } })
    for (const path of ["/approvals", "/customers", "/billing", "/control-center", "/agents", "/starting-point", "/team"]) {
      const location = new URL((await updateSession(request(path))).headers.get("location")!)
      expect(location.searchParams.get("next"), path).toBe(path)
    }
  })

  it("lets signed-out visitors reach public pages and callbacks without redirect", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } })
    for (const path of ["/", "/login", "/how-it-works", "/q/some-token", "/auth/callback", "/api/health"]) {
      const response = await updateSession(request(path))
      expect(response.headers.get("location"), path).toBeNull()
    }
  })

  it("does not redirect a signed-in user away from gated routes, and still moves /login to /dashboard", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: "synthetic-user" } } })
    expect((await updateSession(request("/agents"))).headers.get("location")).toBeNull()
    expect((await updateSession(request("/approvals?x=1"))).headers.get("location")).toBeNull()
    expect(new URL((await updateSession(request("/login"))).headers.get("location")!).pathname).toBe("/dashboard")
  })

  it("fails closed when Supabase env is absent only by not touching the session (existing behavior)", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "")
    const response = await updateSession(request("/agents"))
    expect(response.headers.get("location")).toBeNull()
  })
})
