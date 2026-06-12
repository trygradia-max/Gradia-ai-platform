import { describe, it, expect } from "vitest"

import {
  templateSanityObjections,
  verifierPayloadFragment,
  verifyDraft,
  type DraftToVerify,
} from "@/lib/draft-verifier"

/**
 * Tier 1 — pure, deterministic. The P1 cross-model verifier's wiring
 * contract: code-level template sanity, flag-don't-block semantics, and
 * graceful degradation without a critic. The critic's judgment itself is
 * covered by the [live] cases below (EVAL_LIVE).
 */

const baseDraft: DraftToVerify = {
  channel: "sms",
  body: "Hey Sam — we got your ceramic coating question. Want us to send some times? — Gradia at Pristine Detailing",
  customerName: "Sam Rivera",
  shopName: "Pristine Detailing",
  services: [{ name: "Ceramic coating", price_cents: 80_000 }],
}

describe("template sanity — code checks, no LLM needed", () => {
  it("catches unreplaced variables of all three styles", () => {
    expect(templateSanityObjections("Hi {{first_name}}, see you soon").length).toBeGreaterThan(0)
    expect(templateSanityObjections("Hi [name], your [service] awaits").length).toBeGreaterThan(0)
    expect(templateSanityObjections("Hi " + "${customer}!").length).toBeGreaterThan(0)
    expect(templateSanityObjections("Hi Sam, see you Saturday")).toHaveLength(0)
  })
})

describe("flag, never block", () => {
  it("a failing verdict produces a payload flag with the objections", async () => {
    const result = await verifyDraft(baseDraft, {
      invoke: async () => ({
        pass: false,
        objections: ["Quotes $500 but the menu says $800."],
      }),
    })
    expect(result.pass).toBe(false)
    const fragment = verifierPayloadFragment(result)
    expect(fragment).toMatchObject({
      verifier: {
        flagged: true,
        objections: ["Quotes $500 but the menu says $800."],
      },
    })
  })

  it("a passing verdict adds nothing to the payload", async () => {
    const result = await verifyDraft(baseDraft, {
      invoke: async () => ({ pass: true, objections: [] }),
    })
    expect(result.pass).toBe(true)
    expect(verifierPayloadFragment(result)).toEqual({})
  })

  it("code objections fail the draft even when the critic passes it", async () => {
    const result = await verifyDraft(
      { ...baseDraft, body: "Hi {{first_name}} — see you soon!" },
      { invoke: async () => ({ pass: true, objections: [] }) }
    )
    expect(result.pass).toBe(false)
    expect(result.objections[0]).toContain("placeholder")
  })

  it("a critic API failure degrades to unverified, never throws", async () => {
    const result = await verifyDraft(baseDraft, {
      invoke: async () => {
        throw new Error("api down")
      },
    })
    expect(result.verified).toBe(false)
    expect(result.pass).toBe(true) // clean code checks → stage unflagged
  })

  it("no critic configured (null invoke) → code checks only", async () => {
    const result = await verifyDraft(baseDraft, { invoke: null })
    expect(result.verified).toBe(false)
    expect(result.pass).toBe(true)
  })
})

const LIVE = process.env.EVAL_LIVE === "1"

describe.skipIf(!LIVE)("verifier judgment golden [live]", () => {
  it("flags a fabricated price not on the menu", async () => {
    const result = await verifyDraft({
      ...baseDraft,
      body: "Hey Sam — ceramic coating is $250 this week only, locking you in for Saturday 3pm! — Gradia at Pristine Detailing",
    })
    expect(result.verified).toBe(true)
    expect(result.pass).toBe(false)
  }, 30_000)

  it("flags first-person-singular tone", async () => {
    const result = await verifyDraft({
      ...baseDraft,
      body: "Hi Sam, I'd love to get you on my schedule — I'll pencil you in! — Gradia at Pristine Detailing",
    })
    expect(result.verified).toBe(true)
    expect(result.pass).toBe(false)
  }, 30_000)

  it("passes a clean, grounded draft", async () => {
    const result = await verifyDraft(baseDraft)
    expect(result.verified).toBe(true)
    expect(result.pass).toBe(true)
  }, 30_000)
})
