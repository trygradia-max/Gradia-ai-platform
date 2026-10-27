import { describe, expect, it } from "vitest"

import { STRINGS } from "@/lib/strings"

describe("signed-in empty copy", () => {
  it("tells the owner what will appear, without a performance", () => {
    expect(STRINGS.empty.customersFirstUseTitle).toBe(
      "Your customers will appear here."
    )
    expect(STRINGS.empty.customersFirstUse).toContain("import")
    expect(STRINGS.empty.activityFirstUse).toContain("show up here")
    expect(STRINGS.empty.approvalsEmpty).toContain("Drafts that need a yes")
    expect(STRINGS.empty.customersFirstUseTitle).not.toMatch(/agentic/i)
  })
})
