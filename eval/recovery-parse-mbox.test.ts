import { describe, it, expect } from "vitest"

import {
  buildThreads,
  normalizeSubject,
  parseFromEmail,
  parseMboxMessages,
} from "@/lib/recovery/parse-mbox"

/**
 * mbox parsing (GRADIA_CUSTOMER_RECOVERY_SPEC §1.1). Locks message splitting
 * (envelope "From " vs "From:" header, timestamps full of colons), header
 * extraction, thread grouping, and owner-participation detection.
 */

const SHOP = ["hello@pristinedetail.com"]

const MBOX = `From 100@x Tue Mar 04 14:22:00 2026
From: Marcus Webb <marcus.webb88@gmail.com>
To: Pristine Detailing <hello@pristinedetail.com>
Subject: Ceramic quote
Date: Tue, 4 Mar 2026 14:22:00 -0800
Message-ID: <m1@mail>

Hey, interested in a ceramic coating on my Model 3.

From 101@x Tue Mar 04 16:05:00 2026
From: Pristine Detailing <hello@pristinedetail.com>
To: Marcus Webb <marcus.webb88@gmail.com>
Subject: Re: Ceramic quote
Date: Tue, 4 Mar 2026 16:05:00 -0800
Message-ID: <m2@mail>

Sure — $1,200 for the Model 3.

From 200@x Wed Dec 02 06:00:00 2025
From: Deals <promotions@autopartswholesale.com>
To: hello@pristinedetail.com
Subject: 30% off chemicals
Date: Tue, 2 Dec 2025 06:00:00 -0800
Message-ID: <n1@mail>
List-Unsubscribe: <mailto:unsub@autopartswholesale.com>

Stock up and save.
`

describe("parseFromEmail", () => {
  it("pulls the address out of a display-name header", () => {
    expect(parseFromEmail("Marcus Webb <marcus.webb88@gmail.com>")).toBe(
      "marcus.webb88@gmail.com"
    )
    expect(parseFromEmail("plain@x.com")).toBe("plain@x.com")
  })
})

describe("normalizeSubject", () => {
  it("strips stacked Re:/Fwd: and lowercases", () => {
    expect(normalizeSubject("Re: Fwd: Re: Ceramic Quote")).toBe("ceramic quote")
  })
})

describe("parseMboxMessages", () => {
  it("splits on the envelope line, not the From: header or its colons", () => {
    const msgs = parseMboxMessages(MBOX)
    expect(msgs).toHaveLength(3)
    expect(msgs[0].fromEmail).toBe("marcus.webb88@gmail.com")
    expect(msgs[0].subject).toBe("Ceramic quote")
    expect(msgs[0].messageId).toBe("<m1@mail>")
    expect(msgs[0].date).toBe("2026-03-04T22:22:00.000Z")
    expect(msgs[0].body).toContain("ceramic coating")
  })

  it("flags List-Unsubscribe on the newsletter", () => {
    const msgs = parseMboxMessages(MBOX)
    expect(msgs[2].hasListUnsubscribe).toBe(true)
    expect(msgs[0].hasListUnsubscribe).toBe(false)
  })

  it("unescapes >From at the start of body lines", () => {
    const m = parseMboxMessages(
      `From 1@x Tue Mar 04 14:22:00 2026\nFrom: a@b.com\nSubject: x\n\n>From the desk of A\nbody\n`
    )
    expect(m[0].body).toContain("From the desk of A")
    expect(m[0].body).not.toContain(">From")
  })
})

describe("buildThreads", () => {
  it("groups the customer thread and marks owner participation", () => {
    const threads = buildThreads(parseMboxMessages(MBOX), SHOP)
    // The two ceramic messages collapse into one thread; the newsletter is its own.
    expect(threads).toHaveLength(2)

    const ceramic = threads.find((t) => /ceramic/i.test(t.subject))!
    expect(ceramic.ownerParticipated).toBe(true)
    // The thread's sender is the customer side, never the shop.
    expect(ceramic.fromEmail).toBe("marcus.webb88@gmail.com")
    expect(ceramic.body).toContain("ceramic coating")
    expect(ceramic.body).toContain("$1,200")
    // Latest message wins for the thread id + date.
    expect(ceramic.messageId).toBe("<m2@mail>")

    const newsletter = threads.find((t) => /chemicals/i.test(t.subject))!
    expect(newsletter.ownerParticipated).toBe(false)
    expect(newsletter.hasListUnsubscribe).toBe(true)
  })

  it("keeps distinct subjects as separate threads", () => {
    const threads = buildThreads(parseMboxMessages(MBOX), SHOP)
    const subjects = threads.map((t) => normalizeSubject(t.subject)).sort()
    expect(subjects).toEqual(["30% off chemicals", "ceramic quote"])
  })
})
