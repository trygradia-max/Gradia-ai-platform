import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const seed = readFileSync("scripts/seed-smoke.mjs", "utf8")
const runbook = readFileSync("docs/demo/INVESTOR_DEMO_RUNBOOK.md", "utf8")

describe("investor demo kit", () => {
  it("refuses accidental remote service-role writes", () => {
    expect(seed).toContain('const ALLOW_REMOTE = has("--allow-remote")')
    expect(seed).toContain("Refusing to write demo rows to a remote Supabase target")
    expect(seed).toContain("if (!isLoopback && !ALLOW_REMOTE)")
  })

  it("does not seed a legacy agent identity", () => {
    expect(seed).not.toContain('.from("custom_agents")\n    .insert')
    expect(seed).toContain("create live in /agents/build (no legacy row seeded)")
  })

  it("uses the governed seven-step builder in the demo story", () => {
    for (const step of ["Job", "Schedule", "Tools", "Knowledge", "Limits", "Test", "Activate"]) {
      expect(runbook).toContain(`${step}:`)
    }
    expect(runbook).toContain("immutable revision")
    expect(runbook).toContain("owner-reviewed shop knowledge")
  })
})
