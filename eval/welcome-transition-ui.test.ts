import { describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => undefined, push: () => undefined }),
}))

import { WelcomeTransition } from "@/components/gradia/welcome-transition"
import { welcomeHeading, WELCOME_DASHBOARD_HREF, isWelcomeRequest } from "@/lib/welcome"
import { STRINGS } from "@/lib/strings"

describe("post-setup welcome", () => {
  it("names the shop and keeps Continue available immediately", () => {
    const html = renderToStaticMarkup(
      createElement(WelcomeTransition, { shopName: "North Shore Auto" })
    )
    expect(html).toContain("Welcome to Gradia, North Shore Auto.")
    expect(html).toContain(STRINGS.pages.welcome.continue)
    expect(html).toContain("min-h-11")
    expect(html).toContain("You can continue whenever you&#x27;re ready.")
    expect(html).not.toMatch(/\sdisabled(=""|>|\s)/)
    expect(html).not.toContain("aria-disabled")
    expect(html).not.toContain("progress")
    expect(html).not.toContain("everything is connected")
    expect(html).not.toContain("agentic")
    expect(html).not.toContain("Connecting")
  })

  it("falls back when the shop name is blank", () => {
    expect(welcomeHeading("   ")).toBe("Welcome to Gradia, your shop.")
  })

  it("only treats welcome=1 as the post-setup overlay", () => {
    expect(isWelcomeRequest("1")).toBe(true)
    expect(isWelcomeRequest("0")).toBe(false)
    expect(isWelcomeRequest(undefined)).toBe(false)
    expect(WELCOME_DASHBOARD_HREF).toBe("/dashboard?welcome=1")
  })
})
