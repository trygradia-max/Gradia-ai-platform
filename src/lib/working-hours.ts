/**
 * Structured working hours (C4 follow-up, run 2026-07-10) — per-day
 * open/close on `shops.settings.calendar.working_hours` (jsonb; no
 * migration needed). Feeds BOTH the calendar over-capacity warning
 * (replacing the flat 8h/day default) and the hours line the phone agent
 * speaks when the owner hasn't written custom hours text.
 *
 * Default matches the previous behavior exactly: 8 workable hours
 * (09:00–17:00) every day, so shops that never open the editor see the
 * same capacity math as before.
 */

import type { ShopRow } from "@/lib/types/database"

export const WEEKDAYS = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
] as const
export type Weekday = (typeof WEEKDAYS)[number]

export const WEEKDAY_LABELS: Record<Weekday, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
}

/** "HH:MM" open/close, or null = closed that day. */
export type DayHours = { open: string; close: string } | null
export type WorkingHours = Record<Weekday, DayHours>

export const DEFAULT_WORKING_HOURS: WorkingHours = {
  mon: { open: "09:00", close: "17:00" },
  tue: { open: "09:00", close: "17:00" },
  wed: { open: "09:00", close: "17:00" },
  thu: { open: "09:00", close: "17:00" },
  fri: { open: "09:00", close: "17:00" },
  sat: { open: "09:00", close: "17:00" },
  sun: { open: "09:00", close: "17:00" },
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

export function parseTimeMinutes(t: string): number | null {
  const m = t.match(TIME_RE)
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

function validDay(raw: unknown): DayHours | undefined {
  if (raw === null) return null
  if (!raw || typeof raw !== "object") return undefined
  const { open, close } = raw as { open?: unknown; close?: unknown }
  if (typeof open !== "string" || typeof close !== "string") return undefined
  const o = parseTimeMinutes(open)
  const c = parseTimeMinutes(close)
  if (o == null || c == null || c <= o) return undefined
  return { open, close }
}

/** Read + validate from shops.settings; falls back per-day to defaults.
 *  Also honors the interim numeric working_hours_per_day from the C4 run. */
export function readWorkingHours(
  settings: ShopRow["settings"] | null | undefined
): WorkingHours {
  const calendar = ((settings ?? {}) as Record<string, unknown>).calendar as
    | Record<string, unknown>
    | undefined

  // Interim numeric setting (C4 run) — honored as N hours from 09:00 daily.
  const legacyHours =
    typeof calendar?.working_hours_per_day === "number" &&
    calendar.working_hours_per_day > 0 &&
    calendar.working_hours_per_day <= 24
      ? calendar.working_hours_per_day
      : null

  const raw = calendar?.working_hours as Record<string, unknown> | undefined
  const out = {} as WorkingHours
  for (const day of WEEKDAYS) {
    const parsed = raw ? validDay(raw[day]) : undefined
    if (parsed !== undefined) {
      out[day] = parsed
    } else if (legacyHours != null) {
      const close = Math.min(9 * 60 + Math.round(legacyHours * 60), 24 * 60 - 1)
      out[day] = {
        open: "09:00",
        close: `${String(Math.floor(close / 60)).padStart(2, "0")}:${String(close % 60).padStart(2, "0")}`,
      }
    } else {
      out[day] = DEFAULT_WORKING_HOURS[day]
    }
  }
  return out
}

/** Has the owner explicitly saved working hours (onboarding gate, B-16)?
 *  Distinct from `readWorkingHours`, which always returns a value (falling
 *  back to the 9–5 default) — an untouched shop has no key here, so the
 *  wizard can tell "never reviewed" from "reviewed and kept the default". */
export function hasCustomWorkingHours(
  settings: ShopRow["settings"] | null | undefined
): boolean {
  const calendar = ((settings ?? {}) as Record<string, unknown>).calendar as
    | Record<string, unknown>
    | undefined
  if (!calendar) return false
  return (
    calendar.working_hours != null ||
    typeof calendar.working_hours_per_day === "number"
  )
}

/** JS Date.getDay() (0=Sun) → our weekday key. */
export function weekdayOf(date: Date): Weekday {
  return (["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const)[date.getDay()]
}

/** Workable minutes for one calendar day; 0 when closed. */
export function capacityMinutesFor(hours: WorkingHours, date: Date): number {
  const day = hours[weekdayOf(date)]
  if (!day) return 0
  const open = parseTimeMinutes(day.open)
  const close = parseTimeMinutes(day.close)
  if (open == null || close == null) return 0
  return Math.max(0, close - open)
}

/** "Mon–Fri 9:00 AM–5:00 PM, Sat 9:00 AM–1:00 PM, closed Sunday" — the
 *  hours line the phone agent speaks when no custom hours text is set. */
export function formatWorkingHours(hours: WorkingHours): string {
  const fmt = (t: string): string => {
    const mins = parseTimeMinutes(t) ?? 0
    const h = Math.floor(mins / 60)
    const m = mins % 60
    const ampm = h >= 12 ? "PM" : "AM"
    const h12 = h % 12 === 0 ? 12 : h % 12
    return m === 0 ? `${h12} ${ampm}` : `${h12}:${String(m).padStart(2, "0")} ${ampm}`
  }
  const label: Record<Weekday, string> = {
    mon: "Mon",
    tue: "Tue",
    wed: "Wed",
    thu: "Thu",
    fri: "Fri",
    sat: "Sat",
    sun: "Sun",
  }

  // Group consecutive days sharing the same hours.
  const groups: { days: Weekday[]; hours: DayHours }[] = []
  for (const day of WEEKDAYS) {
    const h = hours[day]
    const last = groups[groups.length - 1]
    const same =
      last &&
      ((last.hours === null && h === null) ||
        (last.hours !== null &&
          h !== null &&
          last.hours.open === h.open &&
          last.hours.close === h.close))
    if (same) last.days.push(day)
    else groups.push({ days: [day], hours: h })
  }

  const parts = groups.map((g) => {
    const span =
      g.days.length > 1
        ? `${label[g.days[0]]}–${label[g.days[g.days.length - 1]]}`
        : label[g.days[0]]
    return g.hours
      ? `${span} ${fmt(g.hours.open)}–${fmt(g.hours.close)}`
      : `closed ${span}`
  })
  return parts.join(", ")
}
