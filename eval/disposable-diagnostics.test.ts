import { describe, expect, it } from "vitest"
import { disposableFailureSummary } from "../scripts/disposable-diagnostics.mjs"
describe("disposable stack failure diagnostics", () => {
  it("reports useful categories without echoing credential-bearing CLI output", () => {
    const summary = disposableFailureSummary({ status: 1, stdout: "API key: synthetic-private-value", stderr: "failed to pull image: context deadline exceeded; postgres://private-user:private-password@localhost" })
    expect(summary).toEqual({ exitCode: 1, categories: ["timeout", "image_pull"] })
    expect(JSON.stringify(summary)).not.toMatch(/private|postgres|localhost|API key/)
  })
  it("reports an unknown failure without exposing its text", () => {
    expect(disposableFailureSummary({ status: null, stderr: "secret detail" })).toEqual({ exitCode: null, categories: [] })
  })
})
