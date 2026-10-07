import { describe, it, expect, vi } from "vitest"
import { Socket } from "node:net"
import { allowedTestUrl } from "./_network-guard"
describe("isolated network allowlist", () => {
  it("denies provider, alternate localhost, and credential-bearing targets", () => {
    vi.stubEnv("INTEGRATION", "1")
    vi.stubEnv("GRADIA_DISPOSABLE_TEST", "gradia-isolated-tests")
    expect(allowedTestUrl("http://127.0.0.1:56531/rest/v1/customers")).toBe(true)
    for (const url of ["https://api.twilio.com", "http://localhost:56531", "http://127.0.0.1:54321", "http://x:y@127.0.0.1:56531", "https://127.0.0.1:56531"]) expect(allowedTestUrl(url)).toBe(false)
    vi.unstubAllEnvs()
  })
})

it("socket denial survives restoring ordinary mocks", () => {
  vi.restoreAllMocks()
  expect(() => new Socket().connect(443, "example.invalid")).toThrow("Unexpected socket connection blocked")
})

it("blocks ordinary TLS provider sockets before connection", async () => {
  const {connect}=await import("node:tls")
  expect(()=>connect({host:"api.twilio.com",port:443})).toThrow("Unexpected socket connection blocked")
})

it("fresh verification stack has an exact separate origin and project allowlist", () => {
  vi.stubEnv("INTEGRATION", "1")
  vi.stubEnv("GRADIA_DISPOSABLE_TEST", "gradia-record-fresh")
  expect(allowedTestUrl("http://127.0.0.1:56731/rest/v1/customers")).toBe(true)
  for (const target of ["http://127.0.0.1:56531", "https://127.0.0.1:56731", "http://localhost:56731", "http://x:y@127.0.0.1:56731", "https://api.twilio.com"]) expect(allowedTestUrl(target)).toBe(false)
  vi.stubEnv("GRADIA_DISPOSABLE_TEST", "unknown")
  expect(allowedTestUrl("http://127.0.0.1:56731")).toBe(false)
  vi.unstubAllEnvs()
})
