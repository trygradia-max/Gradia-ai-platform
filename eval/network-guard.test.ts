import { describe, it, expect, vi } from "vitest"
import { Socket } from "node:net"
import { allowedTestUrl } from "./_network-guard"
describe("isolated network allowlist", () => {
  it("denies provider, alternate localhost, and credential-bearing targets", () => {
    vi.stubEnv("INTEGRATION", "1")
    vi.stubEnv("GRADIA_DISPOSABLE_TEST", "gradia-p0-tenant-policy-safety")
    expect(allowedTestUrl("http://127.0.0.1:55431/rest/v1/customers")).toBe(true)
    for (const url of ["https://api.twilio.com", "http://localhost:55431", "http://127.0.0.1:54321", "http://x:y@127.0.0.1:55431", "https://127.0.0.1:55431"]) expect(allowedTestUrl(url)).toBe(false)
    vi.unstubAllEnvs()
  })
})

it("socket denial survives restoring ordinary mocks", () => {
  vi.restoreAllMocks()
  expect(() => new Socket().connect(443, "example.invalid")).toThrow("Unexpected socket connection blocked")
})
