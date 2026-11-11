import { runInNewContext } from "node:vm"

import { beforeEach, describe, expect, it, vi } from "vitest"

// Aurinko OAuth `next` cookie: stored XSS / open redirect regression suite
// (security audit run-1 finding #1). Covers the shared validator, the inline
// script embedding, and both route handlers with a Map-backed cookie jar.

const jar = vi.hoisted(() => ({
  values: new Map<string, string>(),
  set: vi.fn(),
  deleted: [] as string[],
}))
const mocks = vi.hoisted(() => ({
  exchange: vi.fn(),
  account: vi.fn(),
  subscribe: vi.fn(),
  update: vi.fn(),
}))

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (jar.values.has(name) ? { name, value: jar.values.get(name) } : undefined),
    set: (arg: { name: string; value: string }) => {
      jar.set(arg)
      jar.values.set(arg.name, arg.value)
    },
    delete: (name: string) => {
      jar.deleted.push(name)
      jar.values.delete(name)
    },
  })),
  headers: vi.fn(async () => new Headers({ host: "app.example" })),
}))
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { redirectUrl: url })
  },
}))
vi.mock("@/lib/shop", () => ({ requireShop: vi.fn(async () => ({ id: "shop-1" })) }))
vi.mock("@/lib/request-origin", () => ({ resolveInteractiveOrigin: () => "https://app.example" }))
vi.mock("@/lib/crypto", () => ({ encryptSecret: (v: string) => `enc:${v}` }))
vi.mock("@/lib/aurinko", () => ({
  buildAuthorizeUrl: ({ state }: { state: string }) => `https://aurinko.invalid/authorize?state=${state}`,
  exchangeAuthCode: mocks.exchange,
  getAccount: mocks.account,
  createMessagesSubscription: mocks.subscribe,
}))
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: () => ({ update: (row: unknown) => ({ eq: () => mocks.update(row) }) }),
  })),
}))

import { GET as callbackGET } from "@/app/api/aurinko/auth/callback/route"
import { GET as startGET } from "@/app/api/aurinko/auth/start/route"
import { finishOauth, jsonForInlineScript } from "@/lib/oauth-popup"
import { safeInternalPath } from "@/lib/safe-internal-path"

const ALLOWED = [
  "/settings",
  "/settings?email=ok",
  "/onboarding?step=5",
  "/onboarding?step=5&from=email",
  "/customers?search=Jane%20Doe#details",
  "/calendar?view=week&date=2026-09-15",
  "/dashboard#activity",
]

const REJECTED: Array<[string, unknown]> = [
  ["undefined", undefined],
  ["null", null],
  ["number", 5],
  ["empty", ""],
  ["relative", "settings"],
  ["absolute https", "https://evil.example/"],
  ["absolute http", "http://evil.example"],
  ["scheme javascript", "javascript:alert(1)"],
  ["scheme data", "data:text/html,<script>alert(1)</script>"],
  ["protocol-relative", "//evil.example"],
  ["protocol-relative path", "//evil.example/settings"],
  ["slash backslash", "/\\evil.example"],
  ["backslash slash", "\\/evil.example"],
  ["double backslash", "\\\\evil.example"],
  ["leading backslash", "\\evil.example"],
  ["inner backslash", "/settings\\..\\evil"],
  ["userinfo", "@evil.example/"],
  ["angle bracket", "/<img src=x onerror=alert(1)>"],
  ["closing script", "/</script><script>alert(1)</script>"],
  ["closing script spaced", "/x</script >"],
  ["html comment", "/x<!--"],
  ["double quote", '/x"onmouseover="alert(1)'],
  ["single quote", "/x'+alert(1)+'"],
  ["backtick", "/x`${alert(1)}`"],
  ["braces", "/x{{7*7}}"],
  ["space", "/a b"],
  ["leading space", " /settings"],
  ["newline", "/a\nb"],
  ["tab", "/a\tb"],
  ["nul", "/a\u0000b"],
  ["u2028", "/a\u2028b"],
  ["u2029", "/a\u2029b"],
  ["encoded backslash", "/%5Cevil.example"],
  ["encoded backslash lower", "/%5cevil.example"],
  ["encoded protocol-relative", "/%2F%2Fevil.example"],
  ["encoded slash after slash", "/%2fevil.example/x"],
  ["encoded lt", "/%3Cscript%3Ealert(1)%3C/script%3E"],
  ["encoded lt lower", "/%3cscript%3e"],
  ["encoded quote", "/x%22onerror%3Dalert(1)"],
  ["encoded nul", "/%00evil"],
  ["encoded crlf", "/%0d%0aSet-Cookie:x=1"],
  ["double encoded backslash", "/%255Cevil.example"],
  ["double encoded lt", "/%253Cscript%253E"],
  ["triple encoded lt", "/%25253Cscript"],
  ["quadruple encoded lt", "/%2525253Cscript"],
  ["malformed percent", "/%ZZ"],
  ["truncated percent", "/x%"],
  ["bad utf8", "/%E0%A4"],
  ["dot segments", "/a/../settings"],
  ["encoded dot segments", "/%2e%2e/settings"],
  ["current dir", "/./settings"],
  ["too long", "/" + "a".repeat(600)],
]

describe("safeInternalPath", () => {
  it.each(ALLOWED)("allows same-origin path %s unchanged", path => {
    expect(safeInternalPath(path)).toBe(path)
  })
  it.each(REJECTED)("rejects %s", (_label, value) => {
    expect(safeInternalPath(value)).toBeNull()
  })
  it("allows a path at exactly the length cap", () => {
    const path = "/" + "a".repeat(511)
    expect(safeInternalPath(path)).toBe(path)
  })
})

describe("jsonForInlineScript", () => {
  it("never emits characters that can break out of a script element", () => {
    const nasty = "/</script><!--&\u2028\u2029"
    const out = jsonForInlineScript(nasty)
    expect(out).not.toMatch(/[<>&\u2028\u2029]/)
    expect(JSON.parse(out)).toBe(nasty)
  })
})

/** Runs the page's inline script in a stub browser and reports what it did. */
function runPage(response: Response, html: string, opts: { opener: boolean }) {
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
  expect(scripts).toHaveLength(1)
  const posted: unknown[] = []
  const replaced: string[] = []
  let closed = false
  const win: Record<string, unknown> = {
    location: { origin: "https://app.example", replace: (u: string) => replaced.push(u) },
    close: () => {
      closed = true
    },
  }
  win.opener = opts.opener ? { postMessage: (m: unknown, o: string) => posted.push([m, o]) } : null
  runInNewContext(scripts[0][1], { window: win })
  void response
  return { posted, replaced, closed }
}

describe("finishOauth", () => {
  it.each(ALLOWED)("popup flow posts %s to the opener and closes", async path => {
    const res = finishOauth(path)
    const html = await res.text()
    const { posted, replaced, closed } = runPage(res, html, { opener: true })
    expect(posted).toEqual([[{ source: "gradia-oauth", path }, "https://app.example"]])
    expect(closed).toBe(true)
    expect(replaced).toEqual([])
  })
  it.each(ALLOWED)("full-page flow navigates to %s", async path => {
    const res = finishOauth(path)
    const html = await res.text()
    const { posted, replaced } = runPage(res, html, { opener: false })
    expect(replaced).toEqual([path])
    expect(posted).toEqual([])
  })
  it.each(REJECTED.filter(([, v]) => typeof v === "string"))("falls back to /settings for %s", async (_l, value) => {
    const res = finishOauth(value as string)
    const html = await res.text()
    expect(html).not.toContain("evil")
    expect(html.match(/<script/g)).toHaveLength(1)
    expect(html.match(/<\/script>/g)).toHaveLength(1)
    const { replaced } = runPage(res, html, { opener: false })
    expect(replaced).toEqual(["/settings"])
  })
  it("never lets a closing-script payload reach the document", async () => {
    const html = await finishOauth("/</script><img src=x onerror=alert(1)>").text()
    expect(html).not.toContain("<img")
    expect(html).not.toContain("onerror")
  })
  it("sends nonce-only script CSP, nosniff and no-store", () => {
    const res = finishOauth("/settings")
    const csp = res.headers.get("content-security-policy") ?? ""
    expect(csp).toMatch(/script-src 'nonce-[A-Za-z0-9+/=]+'/)
    expect(csp).not.toContain("script-src 'unsafe-inline'")
    expect(csp).toContain("default-src 'none'")
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
    expect(res.headers.get("cache-control")).toBe("no-store")
  })
  it("uses a fresh nonce per response, matching the script tag", async () => {
    const a = finishOauth("/settings")
    const b = finishOauth("/settings")
    const nonce = (r: Response) => /nonce-([A-Za-z0-9+/=]+)/.exec(r.headers.get("content-security-policy") ?? "")?.[1]
    expect(nonce(a)).not.toBe(nonce(b))
    expect(await a.text()).toContain(`<script nonce="${nonce(a)}">`)
  })
})

function startRequest(next?: string) {
  const url = new URL("https://app.example/api/aurinko/auth/start")
  if (next !== undefined) url.searchParams.set("next", next)
  return new Request(url)
}

async function runStart(next?: string) {
  await expect(startGET(startRequest(next))).rejects.toMatchObject({
    redirectUrl: expect.stringContaining("https://aurinko.invalid/authorize"),
  })
}

beforeEach(() => {
  jar.values.clear()
  jar.set.mockClear()
  jar.deleted.length = 0
  vi.stubEnv("AURINKO_CLIENT_ID", "synthetic-client")
  vi.stubEnv("GRADIA_DASHBOARD_URL", "https://app.example")
  mocks.exchange.mockReset().mockResolvedValue({ accessToken: "tok", expiresAt: "2030-01-01T00:00:00Z" })
  mocks.account.mockReset().mockResolvedValue({ id: "acct", email: "owner@example.test" })
  mocks.subscribe.mockReset().mockResolvedValue({ id: "sub-1" })
  mocks.update.mockReset().mockResolvedValue({ error: null })
})

describe("Aurinko start route", () => {
  it.each(ALLOWED)("stores allowed next %s in the cookie", async path => {
    await runStart(path)
    expect(jar.values.get("aurinko_oauth_next")).toBe(path)
    expect(jar.values.get("aurinko_oauth_state")).toMatch(/^[0-9a-f]{48}$/)
  })
  it.each(REJECTED.filter(([, v]) => typeof v === "string" && v !== ""))(
    "does not store rejected next (%s) and still starts the flow",
    async (_label, value) => {
      await runStart(value as string)
      expect(jar.values.has("aurinko_oauth_next")).toBe(false)
      expect(jar.values.get("aurinko_oauth_state")).toBeTruthy()
    },
  )
  it("starts normally with no next and stores no next cookie", async () => {
    await runStart()
    expect(jar.values.has("aurinko_oauth_next")).toBe(false)
  })
  it("clears a stale next cookie when the new request has none or a bad one", async () => {
    jar.values.set("aurinko_oauth_next", "/onboarding?step=5")
    await runStart()
    expect(jar.values.has("aurinko_oauth_next")).toBe(false)
    jar.values.set("aurinko_oauth_next", "/onboarding?step=5")
    await runStart("//evil.example")
    expect(jar.values.has("aurinko_oauth_next")).toBe(false)
  })
  it("keeps state cookie flags", async () => {
    await runStart("/settings")
    const flags = jar.set.mock.calls.map(c => c[0])
    for (const c of flags) expect(c).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" })
  })
})

function callbackRequest(params: Record<string, string>) {
  const url = new URL("https://app.example/api/aurinko/auth/callback")
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return new Request(url)
}

async function landing(res: Response) {
  const html = await res.text()
  const { replaced } = runPage(res, html, { opener: false })
  return { html, to: replaced[0] }
}

const OK_PARAMS = { code: "synthetic-code", state: "nonce-1" }

describe("Aurinko callback route", () => {
  beforeEach(() => {
    jar.values.set("aurinko_oauth_state", "nonce-1")
  })

  it("lands on an allowed next path after success", async () => {
    jar.values.set("aurinko_oauth_next", "/onboarding?step=5")
    const { to } = await landing(await callbackGET(callbackRequest(OK_PARAMS)))
    expect(to).toBe("/onboarding?step=5")
    expect(mocks.update).toHaveBeenCalledOnce()
  })
  it("lands on /settings?email=ok with no next cookie (legitimate default flow)", async () => {
    const { to } = await landing(await callbackGET(callbackRequest(OK_PARAMS)))
    expect(to).toBe("/settings?email=ok")
  })
  it("popup flow still reports the destination to the opener", async () => {
    jar.values.set("aurinko_oauth_next", "/onboarding?step=5")
    const res = await callbackGET(callbackRequest(OK_PARAMS))
    const html = await res.text()
    const { posted, closed } = runPage(res, html, { opener: true })
    expect(posted).toEqual([[{ source: "gradia-oauth", path: "/onboarding?step=5" }, "https://app.example"]])
    expect(closed).toBe(true)
  })
  it.each(REJECTED.filter(([, v]) => typeof v === "string" && v !== ""))(
    "ignores a tampered next cookie (%s) and lands on the safe default",
    async (_label, value) => {
      jar.values.set("aurinko_oauth_next", value as string)
      const { html, to } = await landing(await callbackGET(callbackRequest(OK_PARAMS)))
      expect(to).toBe("/settings?email=ok")
      expect(html).not.toContain("evil")
      expect(html).not.toContain("<img")
      expect(html.match(/<\/script>/g)).toHaveLength(1)
    },
  )
  it("does not turn a closing-script cookie into markup", async () => {
    jar.values.set("aurinko_oauth_next", "/</script><script>alert(document.domain)</script>")
    const res = await callbackGET(callbackRequest(OK_PARAMS))
    const html = await res.text()
    expect(html).not.toContain("alert(document.domain)")
    expect(html.match(/<script/g)).toHaveLength(1)
  })

  const FAILURES: Array<[string, Record<string, string>, (() => void) | undefined, string]> = [
    ["provider error", { error: "access_denied" }, undefined, "denied"],
    ["missing params", {}, undefined, "missing_params"],
    ["missing state", { code: "c" }, undefined, "missing_params"],
    ["state mismatch", { code: "c", state: "wrong" }, undefined, "state_mismatch"],
    ["token exchange failure", OK_PARAMS, () => mocks.exchange.mockRejectedValue(new Error("x")), "token_exchange_failed"],
    ["account fetch failure", OK_PARAMS, () => mocks.account.mockRejectedValue(new Error("x")), "account_fetch_failed"],
    ["subscription failure", OK_PARAMS, () => mocks.subscribe.mockRejectedValue(new Error("x")), "subscription_failed"],
    ["save failure", OK_PARAMS, () => mocks.update.mockResolvedValue({ error: { message: "x" } }), "save_failed"],
  ]
  it.each(FAILURES)("clears both cookies and never honors next on %s", async (_label, params, arrange, status) => {
    arrange?.()
    jar.values.set("aurinko_oauth_next", "/onboarding?step=5")
    const { to } = await landing(await callbackGET(callbackRequest(params)))
    expect(to).toBe(`/settings?email=${status}`)
    expect(jar.deleted).toEqual(expect.arrayContaining(["aurinko_oauth_state", "aurinko_oauth_next"]))
    expect(jar.values.has("aurinko_oauth_next")).toBe(false)
    expect(jar.values.has("aurinko_oauth_state")).toBe(false)
  })
  it("clears both cookies on success", async () => {
    jar.values.set("aurinko_oauth_next", "/onboarding?step=5")
    await callbackGET(callbackRequest(OK_PARAMS))
    expect(jar.values.size).toBe(0)
    expect(jar.deleted).toEqual(expect.arrayContaining(["aurinko_oauth_state", "aurinko_oauth_next"]))
  })
})
