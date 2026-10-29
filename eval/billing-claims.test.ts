import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

const customerPricingSurfaces = [
  "src/app/billing/page.tsx",
  "src/components/gradia/billing-subscribe.tsx",
  "src/components/gradia/usage-meters.tsx",
]

describe("customer-facing billing claims", () => {
  it("does not publish superseded numeric plan, add-on or pack prices", () => {
    for (const file of customerPricingSurfaces) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8")
      expect(source, file).not.toMatch(/\$(?:10|20|29|49)(?!\d)/)
    }
  })

  it("cannot call the retired checkout, pack, or add-on purchase adapters", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/app/actions/billing.ts"),
      "utf8"
    )
    expect(source).not.toContain("createSubscriptionCheckoutSession")
    expect(source).not.toContain("createPackCheckoutSession")
    expect(source).not.toContain("addVoiceAddonItem")
    expect(source).toContain("Pilot checkout is unavailable")
  })
})
