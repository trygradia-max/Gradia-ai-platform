import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { resolveInteractiveOrigin } from "@/lib/request-origin"

/**
 * B-00 — Preview auth redirect. The Aurinko and Jobber "Connect" OAuth
 * flows previously read `GRADIA_DASHBOARD_URL` before the request's own
 * host, so starting a Connect flow on a Vercel Preview bounced the browser
 * to production once the round trip finished. Locks: a request carrying a
 * Preview host never resolves to the production host, even when
 * `GRADIA_DASHBOARD_URL` is set to production; the env var is a
 * last-resort fallback, not the default.
 */

const PROD_URL = "https://gradia-ai-platform.vercel.app"
const ENV_KEYS = ["GRADIA_DASHBOARD_URL", "VERCEL_URL"] as const
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

function requestWithHeaders(headers: Record<string, string>): Request {
  return new Request("https://example.test/api/aurinko/auth/start", {
    headers,
  })
}

describe("resolveInteractiveOrigin (B-00)", () => {
  it("prefers the request's own host over a configured production URL", () => {
    process.env.GRADIA_DASHBOARD_URL = PROD_URL
    const previewHost = "gradia-git-fix-preview-auth-teamgradia.vercel.app"
    const origin = resolveInteractiveOrigin(
      requestWithHeaders({ host: previewHost, "x-forwarded-proto": "https" })
    )
    expect(origin).toBe(`https://${previewHost}`)
    expect(origin).not.toContain("gradia-ai-platform")
  })

  it("prefers x-forwarded-host over the raw host header (proxy hop)", () => {
    process.env.GRADIA_DASHBOARD_URL = PROD_URL
    const origin = resolveInteractiveOrigin(
      requestWithHeaders({
        host: "internal-lb:3000",
        "x-forwarded-host": "gradia-preview-123.vercel.app",
        "x-forwarded-proto": "https",
      })
    )
    expect(origin).toBe("https://gradia-preview-123.vercel.app")
  })

  it("defaults to http for a bare localhost host with no forwarded proto", () => {
    const origin = resolveInteractiveOrigin(
      requestWithHeaders({ host: "localhost:3000" })
    )
    expect(origin).toBe("http://localhost:3000")
  })

  it("defaults to https for a non-localhost host with no forwarded proto", () => {
    const origin = resolveInteractiveOrigin(
      requestWithHeaders({ host: "gradia-preview-123.vercel.app" })
    )
    expect(origin).toBe("https://gradia-preview-123.vercel.app")
  })

  it("falls back to VERCEL_URL when the request carries no host header", () => {
    process.env.GRADIA_DASHBOARD_URL = PROD_URL
    process.env.VERCEL_URL = "gradia-preview-456.vercel.app"
    const origin = resolveInteractiveOrigin(requestWithHeaders({}))
    expect(origin).toBe("https://gradia-preview-456.vercel.app")
  })

  it("falls back to GRADIA_DASHBOARD_URL only when neither headers nor VERCEL_URL are available", () => {
    process.env.GRADIA_DASHBOARD_URL = PROD_URL
    const origin = resolveInteractiveOrigin(requestWithHeaders({}))
    expect(origin).toBe(PROD_URL)
  })

  it("falls back to localhost when nothing is available", () => {
    const origin = resolveInteractiveOrigin(requestWithHeaders({}))
    expect(origin).toBe("http://localhost:3000")
  })

  it("ignores a malformed GRADIA_DASHBOARD_URL and still returns a usable origin", () => {
    process.env.GRADIA_DASHBOARD_URL = "not a url"
    const origin = resolveInteractiveOrigin(requestWithHeaders({}))
    expect(origin).toBe("http://localhost:3000")
  })
})
