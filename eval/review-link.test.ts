import { readFileSync } from "node:fs"
import { describe, it, expect } from "vitest"

import {
  appendReviewLinkToEmail,
  appendReviewLinkToSms,
  getReviewLink,
  normalizeReviewLink,
} from "@/lib/review-link"

/**
 * Review link plumbing + the FTC compliance lock (NEXT-1). The link is appended
 * deterministically (never model-generated), and the review-request path has no
 * sentiment/rating gate — send to the whole eligible segment or not at all.
 */

const LINK = "https://g.page/r/abc/review"

describe("normalizeReviewLink", () => {
  it("accepts http(s) URLs, rejects everything else", () => {
    expect(normalizeReviewLink("  https://g.page/r/x  ")).toBe("https://g.page/r/x")
    expect(normalizeReviewLink("http://yelp.com/biz/x")).toBe("http://yelp.com/biz/x")
    expect(normalizeReviewLink("g.page/r/x")).toBeNull() // no scheme
    expect(normalizeReviewLink("not a link")).toBeNull()
    expect(normalizeReviewLink("")).toBeNull()
    expect(normalizeReviewLink(null)).toBeNull()
  })
})

describe("getReviewLink", () => {
  it("reads + validates the link from settings", () => {
    expect(getReviewLink({ settings: { review_link: LINK } })).toBe(LINK)
    expect(getReviewLink({ settings: { review_link: "junk" } })).toBeNull()
    expect(getReviewLink({ settings: {} })).toBeNull()
    expect(getReviewLink({ settings: { review_link: 42 } })).toBeNull()
    expect(getReviewLink(null)).toBeNull()
  })
})

describe("append helpers are deterministic + idempotent", () => {
  it("appends the link to an SMS, never duplicating it", () => {
    const body = "Thanks for coming in! We'd love your feedback."
    const once = appendReviewLinkToSms(body, LINK)
    expect(once).toContain(LINK)
    expect(appendReviewLinkToSms(once, LINK)).toBe(once) // idempotent
  })

  it("appends the link as an email footer, never duplicating it", () => {
    const body = "Thanks again — we'd appreciate a review.\n\n— Gradia at Pristine"
    const once = appendReviewLinkToEmail(body, LINK)
    expect(once).toContain(LINK)
    expect(appendReviewLinkToEmail(once, LINK)).toBe(once)
  })
})

describe("FTC compliance lock — no sentiment-gating path", () => {
  // The acceptance: "eval asserts no selective-by-sentiment path exists." We
  // scan the review-request module for any rating/sentiment vocabulary that
  // could become a gate. The ask must go to the whole eligible segment.
  it("review-request.ts has no rating/sentiment gating vocabulary in code", () => {
    const src = readFileSync(
      new URL("../src/lib/review-request.ts", import.meta.url),
      "utf8"
    )
      // Strip comments — the doc comment explains the lock using these very
      // words; we scan the executable code, not its explanation.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
      .toLowerCase()
    for (const term of ["sentiment", "rating", "stars", "nps", "satisfaction", "satisfied"]) {
      expect(src, `review-request must not gate by ${term}`).not.toContain(term)
    }
  })
})
