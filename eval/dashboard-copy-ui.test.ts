import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { DashboardHero } from "@/components/gradia/dashboard-hero"
import { STRINGS } from "@/lib/strings"

describe("dashboard review copy", () => {
  it("names the real reply count without extra flourish", () => {
    expect(STRINGS.pages.home.repliesNeedReview(3)).toBe(
      "3 replies need your review."
    )
    expect(STRINGS.pages.home.repliesNeedReview(1)).toBe(
      "1 reply needs your review."
    )
    expect(STRINGS.pages.home.nothingNeedsReview).toBe(
      "Nothing needs your review."
    )
  })

  it("reports connected channels as a count, never as everything live", () => {
    const html = renderToStaticMarkup(
      createElement(DashboardHero, {
        shopName: "North Shore Auto",
        eyebrow: "Tuesday",
        channels: [
          {
            id: "sms",
            label: "Texting",
            description: "Business texts",
            status: "connected",
            hint: null,
            href: "/settings#sms",
          },
          {
            id: "email",
            label: "Email",
            description: "Inbox",
            status: "off",
            hint: "Connect Gmail",
            href: "/settings#email",
          },
        ],
      })
    )
    expect(html).toContain("1 of 2 channels connected")
    expect(html).not.toContain("All 2 channels connected")
    expect(html).not.toContain("everything is connected")
    expect(html).not.toContain("agentic")
  })
})
