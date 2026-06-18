import { describe, it, expect } from "vitest"

import {
  classifyThreadForFilter,
  prefilterThreads,
  type PrefilterInput,
} from "@/lib/recovery/prefilter"

/**
 * The pre-filter is a cost + accuracy gate (GRADIA_CUSTOMER_RECOVERY_SPEC §1.2):
 * only plausibly-human service threads should ever reach the LLM. These lock
 * the drop rules and the Message-ID dedupe.
 */

const human: PrefilterInput = {
  messageId: "<a@mail>",
  fromEmail: "marcus.webb88@gmail.com",
  subject: "Ceramic quote",
  hasListUnsubscribe: false,
  ownerParticipated: true,
}

describe("recovery pre-filter — per-thread drop rules", () => {
  it("keeps a real human thread the shop replied to", () => {
    expect(classifyThreadForFilter(human)).toEqual({ keep: true })
  })

  it("drops anything carrying a List-Unsubscribe header", () => {
    const v = classifyThreadForFilter({ ...human, hasListUnsubscribe: true })
    expect(v.keep).toBe(false)
  })

  it("drops threads the shop never participated in", () => {
    const v = classifyThreadForFilter({ ...human, ownerParticipated: false })
    expect(v.keep).toBe(false)
  })

  it("drops automated / no-reply senders", () => {
    for (const from of [
      "no-reply@tesla.com",
      "noreply@chase.com",
      "donotreply@dmv.ca.gov",
      "mailer-daemon@gmail.com",
      "notifications@yelp.com",
      "newsletter@autoweek.com",
    ]) {
      expect(
        classifyThreadForFilter({ ...human, fromEmail: from }).keep,
        from
      ).toBe(false)
    }
  })

  it("drops bulk email-infrastructure domains", () => {
    const v = classifyThreadForFilter({
      ...human,
      fromEmail: "promo@email.mailchimp.com",
    })
    expect(v.keep).toBe(false)
  })

  it("drops senders with no usable address", () => {
    expect(classifyThreadForFilter({ ...human, fromEmail: "" }).keep).toBe(false)
    expect(
      classifyThreadForFilter({ ...human, fromEmail: "not-an-email" }).keep
    ).toBe(false)
  })
})

describe("recovery pre-filter — batch + Message-ID dedupe", () => {
  it("keeps the first of duplicate Message-IDs, drops the rest", () => {
    const dupe = { ...human, fromEmail: "dana@outlook.com" }
    const { kept, dropped } = prefilterThreads([
      human,
      { ...dupe, messageId: human.messageId }, // same id → dropped
    ])
    expect(kept).toHaveLength(1)
    expect(dropped).toHaveLength(1)
    expect(dropped[0].reason).toBe("duplicate Message-ID")
  })

  it("never collapses null/blank Message-IDs together", () => {
    const { kept } = prefilterThreads([
      { ...human, messageId: null },
      { ...human, fromEmail: "dana@outlook.com", messageId: "  " },
    ])
    expect(kept).toHaveLength(2)
  })

  it("partitions a mixed batch correctly", () => {
    const { kept, dropped } = prefilterThreads([
      human, // keep
      { ...human, messageId: "<b>", hasListUnsubscribe: true }, // drop
      { ...human, messageId: "<c>", fromEmail: "no-reply@x.com" }, // drop
      { ...human, messageId: "<d>", fromEmail: "linh@gmail.com" }, // keep
    ])
    expect(kept).toHaveLength(2)
    expect(dropped).toHaveLength(2)
  })
})
