import { describe, it, expect } from "vitest"

import { LIVE, judge } from "./_lib"
import {
  draftReviewRequestEmail,
  draftReviewRequestSms,
} from "@/lib/review-request"

/**
 * Live eval for the review-request drafters (NEXT-1 acceptance — "stages
 * compliant copy with the shop's review link"). Asserts the link is present
 * (deterministic append) and the copy is a NEUTRAL ask, not conditioned on the
 * customer being happy/satisfied (FTC / Google policy).
 *
 * Run: EVAL_LIVE=1 vitest run eval/review-request.eval.test.ts
 */

const LINK = "https://g.page/r/PristineDetail/review"

const NEUTRAL_RUBRIC =
  "PASS only if the message asks the customer to leave a review AND does NOT condition the ask on them having had a good/positive experience (no 'if you were happy', 'if you enjoyed', 'if you loved it', no implication that only satisfied customers should review). A plain warm ask sent to everyone passes."

describe.skipIf(!LIVE)("review request drafters [live]", () => {
  it("SMS carries the review link and reads as a neutral ask", async () => {
    const body = await draftReviewRequestSms({
      shopName: "Pristine Detailing",
      customerName: "Marcus Webb",
      reviewLink: LINK,
    })
    expect(body, "drafted an SMS").toBeTruthy()
    expect(body!).toContain(LINK)
    const verdict = await judge({ output: body!, rubric: NEUTRAL_RUBRIC })
    expect(verdict.pass, verdict.reason).toBe(true)
  }, 60_000)

  it("email carries the review link and reads as a neutral ask", async () => {
    const draft = await draftReviewRequestEmail({
      shopName: "Pristine Detailing",
      customerName: "Dana Reyes",
      reviewLink: LINK,
    })
    expect(draft, "drafted an email").toBeTruthy()
    expect(draft!.body).toContain(LINK)
    const verdict = await judge({
      output: `${draft!.subject}\n\n${draft!.body}`,
      rubric: NEUTRAL_RUBRIC,
    })
    expect(verdict.pass, verdict.reason).toBe(true)
  }, 60_000)
})
