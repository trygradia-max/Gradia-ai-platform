import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const example = readFileSync(".env.example", "utf8")

describe("commercial sandbox environment template", () => {
  it("documents every fail-closed commercial billing setting", () => {
    for (const name of [
      "STRIPE_SECRET_KEY",
      "GRADIA_COMMERCIAL_BILLING_STRIPE_MODE",
      "GRADIA_COMMERCIAL_STRIPE_WEBHOOK_SECRET",
      "GRADIA_COMMERCIAL_BILLING_WORKER",
      "GRADIA_STRIPE_TEST_CLOCK_ACCEPTANCE",
      "CRON_SECRET",
      "GRADIA_DASHBOARD_URL",
    ]) {
      expect(example).toMatch(new RegExp(`^${name}=`, "m"))
    }
  })

  it("keeps test-clock mutation local and commercial production promotion gated", () => {
    expect(example).toContain("Never configure this in Vercel")
    expect(example).toContain("reviewed production-release decision")
    expect(example).toContain("never reuse STRIPE_WEBHOOK_SECRET")
  })
})
