import { describe, it, expect } from "vitest"

import {
  capacityMinutesFor,
  DEFAULT_WORKING_HOURS,
  formatWorkingHours,
  readWorkingHours,
  weekdayOf,
} from "@/lib/working-hours"

/**
 * C4 follow-up — structured working hours. Locks: the default equals the
 * old flat 8h/day behavior, the calendar capacity respects configured
 * hours (incl. closed days), and the agent-facing formatter groups days.
 */

const MON = new Date("2026-07-13T12:00:00") // a Monday
const SUN = new Date("2026-07-12T12:00:00") // a Sunday

describe("readWorkingHours", () => {
  it("defaults to 8 workable hours every day (matches the old constant)", () => {
    const hours = readWorkingHours(null)
    expect(hours).toEqual(DEFAULT_WORKING_HOURS)
    expect(capacityMinutesFor(hours, MON)).toBe(480)
    expect(capacityMinutesFor(hours, SUN)).toBe(480)
  })

  it("reads configured per-day hours and closed days", () => {
    const hours = readWorkingHours({
      calendar: {
        working_hours: {
          mon: { open: "08:00", close: "18:00" },
          sun: null,
        },
      },
    })
    expect(capacityMinutesFor(hours, MON)).toBe(600)
    expect(capacityMinutesFor(hours, SUN)).toBe(0) // closed → any booking is over
  })

  it("still honors the interim numeric setting from the C4 run", () => {
    const hours = readWorkingHours({ calendar: { working_hours_per_day: 10 } })
    expect(capacityMinutesFor(hours, MON)).toBe(600)
  })

  it("rejects malformed day entries (falls back per-day)", () => {
    const hours = readWorkingHours({
      calendar: {
        working_hours: {
          mon: { open: "18:00", close: "08:00" }, // inverted → invalid
          tue: { open: "8am", close: "5pm" }, // bad format → invalid
        },
      },
    })
    expect(capacityMinutesFor(hours, MON)).toBe(480)
  })
})

describe("weekday mapping", () => {
  it("maps JS getDay to our keys", () => {
    expect(weekdayOf(MON)).toBe("mon")
    expect(weekdayOf(SUN)).toBe("sun")
  })
})

describe("formatWorkingHours — the line the receptionist speaks", () => {
  it("groups consecutive same-hours days and names closed spans", () => {
    const text = formatWorkingHours({
      mon: { open: "09:00", close: "17:00" },
      tue: { open: "09:00", close: "17:00" },
      wed: { open: "09:00", close: "17:00" },
      thu: { open: "09:00", close: "17:00" },
      fri: { open: "09:00", close: "17:00" },
      sat: { open: "09:00", close: "13:00" },
      sun: null,
    })
    expect(text).toBe("Mon–Fri 9 AM–5 PM, Sat 9 AM–1 PM, closed Sun")
  })

  it("handles half-hour times", () => {
    const text = formatWorkingHours({
      ...DEFAULT_WORKING_HOURS,
      mon: { open: "07:30", close: "17:00" },
    })
    expect(text).toContain("Mon 7:30 AM–5 PM")
  })
})
