import {
  BASELINE_QUESTIONS,
  QUESTION_BY_KEY,
  type NumberQuestion,
  type Question,
} from "./catalog"

/** Answer shapes. Absent key = not answered; `unknown` is explicit and never zero. */
export type BaselineAnswer =
  | { state: "unknown" }
  | { state: "value"; value: number; unit: string }
  | { state: "range"; min: number; max: number; unit: string }
  | { state: "value"; value: string }
  | { state: "value"; value: string[] }
  | { state: "value"; value: Record<string, number>; unit: "percent" }
export type BaselineAnswers = Record<string, BaselineAnswer>

export type Issue = { key: string; code: string }

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
const keysOf = (v: Record<string, unknown>) => Object.keys(v).sort().join(",")
const twoDp = (n: number) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-9
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)

function checkNumber(q: NumberQuestion, a: Record<string, unknown>): string | null {
  if ((a.state !== "value" && a.state !== "range") || typeof a.unit !== "string") return "invalid_shape"
  const spec = q.units[a.unit]
  if (!spec) return "unit_not_allowed"
  const bad = (n: number) => n < spec.min || n > spec.max || (spec.integer && !Number.isInteger(n)) || !twoDp(n)
  if (a.state === "value") {
    if (keysOf(a) !== "state,unit,value" || !finite(a.value)) return "invalid_shape"
    return bad(a.value) ? "out_of_range" : null
  }
  if (!q.allowsRange || keysOf(a) !== "max,min,state,unit" || !finite(a.min) || !finite(a.max))
    return "range_not_allowed"
  return bad(a.min) || bad(a.max) || a.min >= a.max ? "out_of_range" : null
}

function checkOne(q: Question, a: unknown): string | null {
  if (!isObj(a) || typeof a.state !== "string") return "invalid_shape"
  if (a.state === "unknown") return q.allowsUnknown && keysOf(a) === "state" ? null : "unknown_not_allowed"
  switch (q.kind) {
    case "number":
      return checkNumber(q, a)
    case "choice":
      return a.state === "value" && keysOf(a) === "state,value" && typeof a.value === "string" && q.choices.includes(a.value)
        ? null : "invalid_choice"
    case "choices": {
      const v = a.value
      return a.state === "value" && keysOf(a) === "state,value" && Array.isArray(v) &&
        v.length >= 1 && v.length <= q.maxSelected &&
        v.every((x) => typeof x === "string" && q.choices.includes(x)) && new Set(v).size === v.length
        ? null : "invalid_selection"
    }
    case "mix": {
      const v = a.value
      if (a.state !== "value" || keysOf(a) !== "state,unit,value" || a.unit !== "percent" || !isObj(v)) return "invalid_mix"
      const entries = Object.entries(v)
      if (!entries.length) return "invalid_mix"
      let total = 0
      for (const [k, n] of entries) {
        if (!q.choices.includes(k) || !finite(n) || n < 0 || n > 100 || !twoDp(n)) return "invalid_mix"
        total += n
      }
      return Math.abs(total - 100) < 1e-9 ? null : "mix_total"
    }
    case "note": {
      const v = a.value
      return a.state === "value" && keysOf(a) === "state,value" && typeof v === "string" &&
        v.trim().length >= 1 && v.trim().length <= q.maxLength ? null : "invalid_note"
    }
  }
}

const plain = (answers: Record<string, unknown>, key: string, unit: string): number | null => {
  const a = answers[key]
  return isObj(a) && a.state === "value" && a.unit === unit && finite(a.value) ? a.value : null
}

/** Mirrors `baseline_validate_answers`. The database remains authoritative. */
export function validateBaselineAnswers(answers: unknown, opts: { complete: boolean }): Issue[] {
  if (!isObj(answers)) return [{ key: "*", code: "invalid_shape" }]
  const issues: Issue[] = []
  for (const key of Object.keys(answers))
    if (!QUESTION_BY_KEY.has(key)) issues.push({ key, code: "unknown_question" })
  for (const q of BASELINE_QUESTIONS) {
    if (!(q.key in answers)) {
      if (opts.complete && !q.optional) issues.push({ key: q.key, code: "required" })
      continue
    }
    const code = checkOne(q, answers[q.key])
    if (code) issues.push({ key: q.key, code })
  }
  const lte = (a: [string, string], b: [string, string], code: string) => {
    const x = plain(answers, a[0], a[1]), y = plain(answers, b[0], b[1])
    if (x !== null && y !== null && x > y) issues.push({ key: a[0], code })
  }
  lte(["missed_calls_per_week", "count_per_week"], ["calls_per_week", "count_per_week"], "exceeds_calls")
  lte(["missed_calls_returned_per_week", "count_per_week"], ["missed_calls_per_week", "count_per_week"], "exceeds_missed")
  lte(["confirmed_bookings", "count_per_month"], ["inquiries_per_month", "count_per_month"], "exceeds_inquiries")
  lte(["followed_up_within_two_days", "count_per_month"], ["inquiries_per_month", "count_per_month"], "exceeds_inquiries")
  const hours = ["admin_hours_calls", "admin_hours_follow_up", "admin_hours_crm", "admin_hours_scheduling"]
    .reduce((s, k) => s + (plain(answers, k, "hours_per_week") ?? 0), 0)
  if (hours > 168) issues.push({ key: "admin_hours_calls", code: "exceeds_week" })
  const p = answers.pilot_primary_outcome, s = answers.pilot_secondary_outcome
  if (isObj(p) && isObj(s) && s.state === "value" && p.value === s.value)
    issues.push({ key: "pilot_secondary_outcome", code: "same_as_primary" })
  return issues
}
