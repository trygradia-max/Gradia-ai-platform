import { describe, expect, it } from "vitest"

import { groundDuration, groundStart, isHedged, localParts } from "@/lib/call-copilot/timing-grounding"

const NOW = new Date("2026-11-20T12:00:00Z")
const TZ = "America/Los_Angeles"
const start = (spanText: string, iso = "2026-12-04T09:00:00-08:00", over: Partial<Parameters<typeof groundStart>[0]> = {}) =>
  groundStart({ iso, spanText, utteranceTexts: [spanText], timezone: TZ, now: NOW, ...over })

describe("localParts renders an instant in the shop's timezone", () => {
  it("handles offsets, daylight saving and invalid input", () => {
    expect(localParts("2026-12-04T17:00:00Z", TZ)).toMatchObject({ year: 2026, month: 12, day: 4, hour: 9, minute: 0, weekday: 5 })
    expect(localParts("2026-07-04T16:00:00Z", TZ)).toMatchObject({ month: 7, day: 4, hour: 9 })
    expect(localParts("2026-12-04T00:30:00+00:00", "Asia/Tokyo")).toMatchObject({ day: 4, hour: 9, minute: 30 })
    expect(localParts("not a date", TZ)).toBeNull()
    expect(localParts("2026-12-04T17:00:00Z", "Not/AZone")).toBeNull()
  })
})

describe("groundStart", () => {
  it("accepts one explicit date and one explicit time that equal the shop-local instant", () => {
    expect(start("Friday December 4th at 9 am")).toEqual({ ok: true })
    expect(start("December 4 at 9:00 a.m.")).toEqual({ ok: true })
    expect(start("4th of December at 9am")).toEqual({ ok: true })
    expect(start("Dec 4 at 9 AM")).toEqual({ ok: true })
    expect(start("Friday December 4th at 17:00", "2026-12-04T17:00:00-08:00")).toEqual({ ok: true })
    expect(start("December 4th at noon", "2026-12-04T12:00:00-08:00")).toEqual({ ok: true })
    expect(start("December 4th at 12 am", "2026-12-04T00:00:00-08:00")).toEqual({ ok: true })
  })
  it("never trusts the model's UTC offset: the same words in another timezone are another instant", () => {
    expect(start("Friday December 4th at 9 am", "2026-12-04T09:00:00-05:00")).toEqual({ ok: false, reason: "start_ungrounded" })
    expect(start("Friday December 4th at 9 am", "2026-12-04T17:00:00Z")).toEqual({ ok: true })
    expect(start("Friday December 4th at 9 am", "2026-12-04T17:00:00Z", { timezone: "America/New_York" })).toEqual({ ok: false, reason: "start_ungrounded" })
  })
  it("fails closed without a verifiable timezone", () => {
    expect(start("Friday December 4th at 9 am", undefined, { timezone: null })).toEqual({ ok: false, reason: "timezone_unknown" })
    expect(start("Friday December 4th at 9 am", undefined, { timezone: "Mars/Olympus" })).toEqual({ ok: false, reason: "timezone_unknown" })
    expect(start("Friday December 4th at 9 am", "garbage")).toEqual({ ok: false, reason: "timezone_unknown" })
  })
  it("does not accept relative, numeric or partial expressions", () => {
    for (const words of ["tomorrow at 9 am", "next Friday at 9 am", "12/4 at 9 am", "December 4th", "at 9 am", "Friday morning", "December 4th at nine", "December 4th at 9", "the 4th at 9 am"]) {
      expect(start(words), words).toEqual({ ok: false, reason: "start_ungrounded" })
    }
  })
  it("a month name that is also a word needs a day number next to it", () => {
    expect(start("I may come at 9 am on Friday")).toEqual({ ok: false, reason: "start_ungrounded" })
    expect(start("May 4th at 9 am", "2027-05-04T09:00:00-07:00")).toEqual({ ok: true })
  })
  it("rejects a different date, hour, minute, weekday or year", () => {
    expect(start("December 5th at 9 am")).toEqual({ ok: false, reason: "start_ungrounded" })
    expect(start("December 4th at 10 am")).toEqual({ ok: false, reason: "start_ungrounded" })
    expect(start("December 4th at 9:30 am")).toEqual({ ok: false, reason: "start_ungrounded" })
    expect(start("Thursday December 4th at 9 am")).toEqual({ ok: false, reason: "start_ungrounded" })
    expect(start("December 4th 2027 at 9 am")).toEqual({ ok: false, reason: "start_ungrounded" })
    expect(start("December 4th at 9 am", "2099-12-04T09:00:00-08:00")).toEqual({ ok: false, reason: "start_ungrounded" })
    expect(start("December 4th 2026 at 9 am")).toEqual({ ok: true })
  })
  it("two dates, two times or two weekdays are ambiguous", () => {
    expect(start("December 4th or December 5th at 9 am")).toEqual({ ok: false, reason: "start_ambiguous" })
    expect(start("Friday December 4th at 9 am and 10 am")).toEqual({ ok: false, reason: "start_ambiguous" })
    expect(start("Friday or Saturday, December 4th at 9 am")).toEqual({ ok: false, reason: "start_ambiguous" })
  })
  it("hedging anywhere in a cited utterance is ambiguous even if the cited words are clean", () => {
    expect(start("Friday December 4th at 9 am", undefined, { utteranceTexts: ["Friday December 4th at 9 am, but let me check first"] })).toEqual({ ok: false, reason: "start_ambiguous" })
    expect(start("Friday December 4th at 9 am", undefined, { utteranceTexts: ["Sorry, actually Friday December 4th at 9 am"] })).toEqual({ ok: false, reason: "start_ambiguous" })
  })
  it("a year-less date rolls to next year once it has passed in the shop's calendar", () => {
    const late = new Date("2026-12-30T12:00:00Z")
    expect(start("Saturday January 2nd at 9 am", "2027-01-02T09:00:00-08:00", { now: late })).toEqual({ ok: true })
    expect(start("Saturday January 2nd at 9 am", "2026-01-02T09:00:00-08:00", { now: late })).toEqual({ ok: false, reason: "start_ungrounded" })
  })
})

describe("groundDuration", () => {
  const dur = (minutes: number, spanText: string, utteranceTexts = [spanText]) => groundDuration({ minutes, spanText, utteranceTexts })
  it("accepts exactly one explicit length equal to the proposed minutes", () => {
    for (const [m, words] of [[180, "180 minutes"], [120, "2 hours"], [60, "an hour"], [60, "one hour"], [30, "half an hour"], [90, "an hour and a half"], [150, "two and a half hours"], [90, "1 hour 30 minutes"], [45, "45 mins"], [180, "three hours"]] as const) {
      expect(dur(m, words), words).toEqual({ ok: true })
    }
  })
  it("rejects a missing, different or plural length", () => {
    expect(dur(180, "it takes a while")).toEqual({ ok: false, reason: "duration_ungrounded" })
    expect(dur(120, "180 minutes")).toEqual({ ok: false, reason: "duration_ungrounded" })
    expect(dur(180, "2 hours and 3 hours")).toEqual({ ok: false, reason: "duration_ambiguous" })
    expect(dur(180, "180 minutes", ["about 180 minutes"])).toEqual({ ok: false, reason: "duration_ambiguous" })
  })
})

describe("isHedged", () => {
  it("flags hedged, conditional, ranged and corrected speech and leaves a plain commitment alone", () => {
    for (const t of ["maybe 9", "around nine", "9 or 10", "if possible", "between 9 and 11", "not sure", "actually 10", "I can't do that"]) expect(isHedged(t), t).toBe(true)
    expect(isHedged("I will book Friday December 4th at 9 am for 180 minutes and send you a quote.")).toBe(false)
  })
})
