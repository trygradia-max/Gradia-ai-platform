import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const how = () => readFileSync("src/app/how-it-works/page.tsx", "utf8")
const login = () => readFileSync("src/app/login/page.tsx", "utf8")

describe("public page copy", () => {
  it("keeps how-it-works warm without selling an operating system or live payments", () => {
    const page = how()
    expect(page).toContain("You approve what goes out")
    expect(page).toContain("Phone answering is optional")
    expect(page).not.toMatch(/agentic/i)
    expect(page).not.toContain("operating system")
    expect(page).not.toContain("everything is connected")
    expect(page).not.toContain("$20/month")
    expect(page).not.toContain("No catch")
    expect(page).not.toContain("Stripe Connect")
    expect(page).not.toContain("invoice ships")
  })

  it("does not tell sign-in that every channel is already catching work", () => {
    const page = login()
    expect(page).toContain("Sign in to review drafts")
    expect(page).not.toContain("DMs")
    expect(page).not.toContain("front desk")
    expect(page).not.toMatch(/agentic/i)
  })
})
