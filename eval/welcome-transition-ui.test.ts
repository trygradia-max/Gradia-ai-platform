import { readFileSync } from "node:fs"
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

/**
 * Fixture / source locks — not signed-in browser acceptance.
 * They prove the overlay stays skippable, keyboard-reachable, and
 * honest. They do not open Chrome, log in, or run the wizard.
 */
describe("welcome source locks (not browser)", () => {
  const overlay = readFileSync("src/components/gradia/welcome-transition.tsx", "utf8")
  const particles = readFileSync("src/components/gradia/welcome-particles.tsx", "utf8")
  const wizard = readFileSync("src/components/gradia/onboarding-wizard.tsx", "utf8")
  const steps = readFileSync("src/components/gradia/onboarding-launch-steps.tsx", "utf8")

  it("skips immediately via Continue or Escape, with no timer", () => {
    expect(overlay).toContain("autoFocus")
    expect(overlay).toContain('event.key === "Escape"')
    expect(overlay).toContain('router.replace("/dashboard"')
    expect(overlay).not.toContain("setTimeout")
    expect(overlay).not.toContain("setInterval")
    expect(particles).not.toContain("setTimeout")
  })

  it("pauses particles and motion when reduced motion is preferred", () => {
    expect(overlay).toContain("useReducedMotion")
    expect(particles).toContain("useReducedMotion")
    expect(particles).toContain("if (reduce) return")
    expect(particles).toContain("if (reduce) return null")
    expect(overlay).toContain("duration: reduce ? 0.2 : 0.4")
    expect(overlay).toContain("initial={reduce ? false : { opacity: 0, y: 10 }}")
  })

  it("keeps keyboard and mobile-sized chrome on the overlay", () => {
    expect(overlay).toContain('role="dialog"')
    expect(overlay).toContain("aria-modal")
    expect(overlay).toContain("min-h-11")
    expect(overlay).toContain("px-6")
    expect(overlay).toContain("text-[clamp(1.75rem,5vw,2.75rem)]")
    expect(overlay).toContain("fixed inset-0")
  })

  it("surfaces onboarding save and finish errors instead of advancing", () => {
    expect(wizard).toContain("progressError")
    expect(wizard).toContain('role="alert"')
    expect(wizard).toContain("Could not confirm your saved place. Refresh before continuing.")
    expect(steps).toContain('role="alert"')
    expect(steps).toContain("completeOnboarding")
    expect(steps).toContain("setError(result.error)")
    expect(steps).toMatch(
      /if \(!result\.ok\) \{[\s\S]*return[\s\S]*router\.push\(WELCOME_DASHBOARD_HREF\)/
    )
  })
})
