/**
 * Deterministic grounding for an appointment proposal's START and DURATION (Call Copilot PR E fix).
 *
 * A model can emit a well-formed, future ISO timestamp and attach a citation that does not support it. This module is the
 * Gradia-owned check that decides whether the cited words literally say that moment, and it is deliberately narrow and
 * fail-closed: anything it cannot positively verify is NOT executable. Nothing here guesses.
 *
 *   * START needs an explicit calendar date (month NAME + day) and one explicit clock time in the cited words, and both
 *     must equal the proposed instant rendered in the SHOP's timezone. The model's own UTC offset is therefore never
 *     trusted. Relative dates ("tomorrow", "next Friday"), numeric dates ("4/5"), a bare hour with no am/pm, a range or a
 *     second candidate date or time are unsupported. A named weekday must match. Without a year, the date must be its next
 *     occurrence on or after the day of the call (so a far-future year cannot ride a month/day citation).
 *   * DURATION needs exactly one explicit length in the cited words equal to the proposed minutes.
 *   * Hedged, conditional or corrected speech anywhere in a cited utterance ("maybe", "around", "or", "if", "actually",
 *     "not sure", "between") makes the field ambiguous, whatever else the span says.
 *   * An unknown shop timezone means the start cannot be verified.
 *
 * The result is only ever used to keep a proposal REVIEW-ONLY; it can never make anything executable by itself.
 */

export type StartGrounding =
  | { ok: true }
  | { ok: false; reason: "timezone_unknown" | "start_ungrounded" | "start_ambiguous" }
export type DurationGrounding = { ok: true } | { ok: false; reason: "duration_ungrounded" | "duration_ambiguous" }

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
const MONTH_ABBR: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
}
const monthNumber = (w: string): number | null => {
  const l = w.toLowerCase().replace(/\.$/, "")
  const full = MONTHS.indexOf(l)
  if (full >= 0) return full + 1
  return MONTH_ABBR[l] ?? null
}
const MONTH_WORD = "(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)"
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]

/** Hedged, conditional, ranged or corrected speech. Any hit anywhere in a cited utterance makes the field ambiguous. */
const HEDGE =
  /\b(maybe|perhaps|possibly|probably|might|may\s+be|around|about|approximately|approx|roughly|ish|or|either|sometime|some\s+time|whenever|flexible|tentative|tentatively|depends|depending|not\s+sure|unsure|let\s+me\s+(?:check|see)|i'll\s+(?:check|let)|i\s+will\s+(?:check|let)|get\s+back\s+to|if|unless|except|actually|instead|rather|scratch\s+that|never\s*mind|no\s+wait|wait|hold\s+on|between|until|through|before|after|no\s+earlier|no\s+later|earliest|latest|cancel(?:l?ed)?|can't|cannot|won't|don't|doesn't|isn't|not)\b/i

export const isHedged = (text: string): boolean => HEDGE.test(text)

export type LocalWhen = { year: number; month: number; day: number; hour: number; minute: number; weekday: number }

/** The instant rendered as the shop's local wall time. Null for an invalid timestamp or timezone. */
export function localParts(iso: string, timezone: string): LocalWhen | null {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
      weekday: "long", hourCycle: "h23",
    }).formatToParts(new Date(ms))
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ""
    const weekday = WEEKDAYS.indexOf(get("weekday").toLowerCase())
    const out = {
      year: Number(get("year")), month: Number(get("month")), day: Number(get("day")),
      hour: Number(get("hour")) % 24, minute: Number(get("minute")), weekday,
    }
    return Object.values(out).every((n) => Number.isFinite(n)) && weekday >= 0 ? out : null
  } catch {
    return null
  }
}

type DateMention = { month: number; day: number; year: number | null }
const NUM_DAY = "(\\d{1,2})(?:st|nd|rd|th)?"

function dateMentions(text: string): DateMention[] {
  const found: DateMention[] = []
  const a = new RegExp(`\\b${MONTH_WORD}\\.?\\s+${NUM_DAY}\\b(?:,?\\s+(20\\d{2}))?`, "gi")
  const b = new RegExp(`\\b${NUM_DAY}\\s+(?:of\\s+)?${MONTH_WORD}\\b(?:\\.?,?\\s+(20\\d{2}))?`, "gi")
  for (const m of text.matchAll(a)) {
    const month = monthNumber(m[1]); const day = Number(m[2])
    if (month && day >= 1 && day <= 31) found.push({ month, day, year: m[3] ? Number(m[3]) : null })
  }
  for (const m of text.matchAll(b)) {
    const month = monthNumber(m[2]); const day = Number(m[1])
    if (month && day >= 1 && day <= 31) found.push({ month, day, year: m[3] ? Number(m[3]) : null })
  }
  return found
}

type TimeMention = { hour: number; minute: number }
function timeMentions(text: string): TimeMention[] {
  const found: TimeMention[] = []
  for (const m of text.matchAll(/\b(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?\s?m\b\.?/gi)) {
    const h = Number(m[1])
    if (h < 1 || h > 12) continue
    found.push({ hour: (h % 12) + (m[3].toLowerCase() === "p" ? 12 : 0), minute: m[2] ? Number(m[2]) : 0 })
  }
  if (/\bnoon\b/i.test(text)) found.push({ hour: 12, minute: 0 })
  // 24-hour clock only when no a.m./p.m. time is present (a bare "9" or "nine" is never a time).
  if (found.length === 0) {
    for (const m of text.matchAll(/(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/g)) found.push({ hour: Number(m[1]), minute: Number(m[2]) })
  }
  return found
}

const distinct = <T,>(xs: T[], key: (x: T) => string): T[] => [...new Map(xs.map((x) => [key(x), x])).values()]

/** `now` is the moment of the call (or later); the shop-local calendar day decides which year a year-less date means. */
export function groundStart(input: {
  iso: string
  spanText: string
  utteranceTexts: string[]
  timezone: string | null
  now: Date
}): StartGrounding {
  if (!input.timezone) return { ok: false, reason: "timezone_unknown" }
  const when = localParts(input.iso, input.timezone)
  const today = localParts(input.now.toISOString(), input.timezone)
  if (!when || !today) return { ok: false, reason: "timezone_unknown" }

  if ([input.spanText, ...input.utteranceTexts].some(isHedged)) return { ok: false, reason: "start_ambiguous" }
  const dates = distinct(dateMentions(input.spanText), (d) => `${d.month}-${d.day}-${d.year ?? ""}`)
  const times = distinct(timeMentions(input.spanText), (t) => `${t.hour}:${t.minute}`)
  const weekdays = distinct(WEEKDAYS.filter((w) => new RegExp(`\\b${w}\\b`, "i").test(input.spanText)), (w) => w)
  if (dates.length > 1 || times.length > 1 || weekdays.length > 1) return { ok: false, reason: "start_ambiguous" }
  // Exactly one explicit date and one explicit time, in words that name a month and a clock time.
  if (dates.length !== 1 || times.length !== 1) return { ok: false, reason: "start_ungrounded" }

  const [d] = dates
  const [t] = times
  if (d.month !== when.month || d.day !== when.day || t.hour !== when.hour || t.minute !== when.minute) {
    return { ok: false, reason: "start_ungrounded" }
  }
  if (weekdays.length === 1 && WEEKDAYS.indexOf(weekdays[0]) !== when.weekday) return { ok: false, reason: "start_ungrounded" }
  // The year: stated, or the next occurrence of that month/day on or after the day of the call.
  const nextYear = d.month < today.month || (d.month === today.month && d.day < today.day) ? today.year + 1 : today.year
  if (when.year !== (d.year ?? nextYear)) return { ok: false, reason: "start_ungrounded" }
  return { ok: true }
}

const WORD_NUM: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
}
const NUM = "(\\d+(?:\\.\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|an?)"
const toNum = (w: string): number => (/^an?$/i.test(w) ? 1 : /^\d/.test(w) ? Number(w) : WORD_NUM[w.toLowerCase()])

function durationMentions(text: string): number[] {
  const out: number[] = []
  let rest = text
  const take = (re: RegExp, f: (m: RegExpMatchArray) => number) => {
    rest = rest.replace(re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpMatchArray
      out.push(f(m))
      return " "
    })
  }
  take(new RegExp(`\\b${NUM}\\s*(?:hours?|hrs?)\\s*(?:and\\s*)?(\\d+)\\s*(?:minutes?|mins?)\\b`, "gi"), (m) => Math.round(toNum(m[1]) * 60 + Number(m[2])))
  take(new RegExp(`\\b${NUM}\\s+and\\s+a\\s+half\\s*(?:hours?|hrs?)\\b`, "gi"), (m) => Math.round(toNum(m[1]) * 60 + 30))
  take(/\b(?:an?\s+)?hour\s+and\s+a\s+half\b/gi, () => 90)
  take(/\bhalf\s+(?:an?\s+)?hour\b/gi, () => 30)
  take(new RegExp(`\\b${NUM}\\s*(?:hours?|hrs?)\\b`, "gi"), (m) => Math.round(toNum(m[1]) * 60))
  take(new RegExp(`\\b${NUM}\\s*(?:minutes?|mins?)\\b`, "gi"), (m) => Math.round(toNum(m[1])))
  return out.filter((n) => Number.isFinite(n) && n > 0)
}

export function groundDuration(input: { minutes: number; spanText: string; utteranceTexts: string[] }): DurationGrounding {
  if ([input.spanText, ...input.utteranceTexts].some(isHedged)) return { ok: false, reason: "duration_ambiguous" }
  const found = distinct(durationMentions(input.spanText), String)
  if (found.length > 1) return { ok: false, reason: "duration_ambiguous" }
  if (found.length !== 1 || found[0] !== input.minutes) return { ok: false, reason: "duration_ungrounded" }
  return { ok: true }
}
