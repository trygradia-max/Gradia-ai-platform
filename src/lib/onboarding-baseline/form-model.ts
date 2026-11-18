import { BASELINE_QUESTIONS, QUESTION_BY_KEY, type NumberQuestion, type Question, type UnitSpec } from "./catalog"
import { QUESTION_COPY, QUIZ_STEPS, type QuizStep } from "./copy"
import { formatRange, formatUnitValue } from "./format"
import { validateBaselineAnswers, type Issue } from "./validate"

/**
 * Pure form model for the Starting point quiz. A key that is absent from the form is *blank* (not
 * answered). Blank is never zero and never "unknown": `unknown` only exists when the owner explicitly
 * chooses "I'm not sure", and `0` only when they type 0. The catalog validator is the same one the
 * server and database use, so what passes here is what the backend will accept.
 */

export type FieldState =
  | { mode: "unknown" }
  | { mode: "number"; unit: string; text: string }
  | { mode: "range"; unit: string; minText: string; maxText: string }
  | { mode: "choice"; value: string }
  | { mode: "choices"; values: string[] }
  | { mode: "mix"; percents: Record<string, string> }
  | { mode: "note"; text: string }
export type FormState = Record<string, FieldState>

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const NUMERIC = /^\d+(\.\d+)?$/

/** Digits with an optional decimal part; thousands commas and spaces are tolerated. Anything else is not a number. */
export function parseNumberText(text: string): number | null {
  const t = text.replace(/[,\s]/g, "")
  return NUMERIC.test(t) ? Number(t) : null
}

export const firstUnit = (q: NumberQuestion): string => Object.keys(q.units)[0]

/** Rebuilds form state from stored answers (a server draft or a submitted revision). Malformed entries are dropped, not guessed. */
export function formFromAnswers(answers: Record<string, unknown> | null | undefined): FormState {
  const form: FormState = {}
  if (!answers) return form
  for (const q of BASELINE_QUESTIONS) {
    const a = answers[q.key]
    if (!isObj(a)) continue
    if (a.state === "unknown") {
      form[q.key] = { mode: "unknown" }
      continue
    }
    if (q.kind === "number") {
      if (a.state === "value" && typeof a.value === "number" && typeof a.unit === "string")
        form[q.key] = { mode: "number", unit: a.unit, text: String(a.value) }
      else if (a.state === "range" && typeof a.min === "number" && typeof a.max === "number" && typeof a.unit === "string")
        form[q.key] = { mode: "range", unit: a.unit, minText: String(a.min), maxText: String(a.max) }
    } else if (q.kind === "choice" && typeof a.value === "string") form[q.key] = { mode: "choice", value: a.value }
    else if (q.kind === "choices" && Array.isArray(a.value)) form[q.key] = { mode: "choices", values: a.value.filter((x): x is string => typeof x === "string") }
    else if (q.kind === "mix" && isObj(a.value))
      form[q.key] = { mode: "mix", percents: Object.fromEntries(Object.entries(a.value).filter(([, n]) => typeof n === "number").map(([k, n]) => [k, String(n)])) }
    else if (q.kind === "note" && typeof a.value === "string") form[q.key] = { mode: "note", text: a.value }
  }
  return form
}

type Converted = { answers: Record<string, unknown>; issues: Issue[] }

/** Form state to catalog answers. Blank fields are omitted; text that is not a number is an issue, never zero. */
export function answersFromForm(form: FormState): Converted {
  const answers: Record<string, unknown> = {}
  const issues: Issue[] = []
  for (const q of BASELINE_QUESTIONS) {
    const f = form[q.key]
    if (!f) continue
    switch (f.mode) {
      case "unknown":
        answers[q.key] = { state: "unknown" }
        break
      case "number": {
        const t = f.text.trim()
        if (!t) break
        const n = parseNumberText(t)
        if (n === null) issues.push({ key: q.key, code: "not_a_number" })
        else answers[q.key] = { state: "value", value: n, unit: f.unit }
        break
      }
      case "range": {
        const lo = f.minText.trim(), hi = f.maxText.trim()
        if (!lo && !hi) break
        if (!lo || !hi) { issues.push({ key: q.key, code: "range_incomplete" }); break }
        const a = parseNumberText(lo), b = parseNumberText(hi)
        if (a === null || b === null) issues.push({ key: q.key, code: "not_a_number" })
        else answers[q.key] = { state: "range", min: a, max: b, unit: f.unit }
        break
      }
      case "choice":
        if (f.value) answers[q.key] = { state: "value", value: f.value }
        break
      case "choices":
        if (f.values.length) answers[q.key] = { state: "value", value: f.values }
        break
      case "mix": {
        const entries = Object.entries(f.percents).filter(([, t]) => t.trim() !== "")
        if (!entries.length) break
        const value: Record<string, number> = {}
        let bad = false
        for (const [k, t] of entries) {
          const n = parseNumberText(t)
          if (n === null) bad = true
          else value[k] = n
        }
        if (bad) issues.push({ key: q.key, code: "not_a_number" })
        else answers[q.key] = { state: "value", value, unit: "percent" }
        break
      }
      case "note":
        if (f.text.trim()) answers[q.key] = { state: "value", value: f.text.trim() }
        break
    }
  }
  return { answers, issues }
}

/** Parse problems plus the shared catalog validator. A key with a parse problem reports that instead of "required". */
export function validateForm(form: FormState, opts: { complete: boolean }): { answers: Record<string, unknown>; issues: Issue[] } {
  const { answers, issues } = answersFromForm(form)
  const parseBad = new Set(issues.map((i) => i.key))
  const catalog = validateBaselineAnswers(answers, opts).filter((i) => !parseBad.has(i.key))
  return { answers, issues: [...issues, ...catalog] }
}

export const questionsInStep = (step: QuizStep): Question[] =>
  BASELINE_QUESTIONS.filter((q) => step.sections.includes(q.section))
export const stepOfQuestion = (key: string): QuizStep | undefined => {
  const q = QUESTION_BY_KEY.get(key)
  return q ? QUIZ_STEPS.find((s) => s.sections.includes(q.section)) : undefined
}

/** One message per question key (the first issue wins), for inline display. */
export function issuesByKey(issues: Issue[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const i of issues) out[i.key] ??= i.code
  return out
}

export type Progress = { required: number; answeredRequired: number; optionalAnswered: number; unknownCount: number }
/** Answered means a real answer or an explicit "not sure". Blank questions are not counted. */
export function progressOf(answers: Record<string, unknown>): Progress {
  let required = 0, answeredRequired = 0, optionalAnswered = 0, unknownCount = 0
  for (const q of BASELINE_QUESTIONS) {
    const a = answers[q.key]
    const has = isObj(a)
    if (has && a.state === "unknown") unknownCount++
    if (q.optional) { if (has) optionalAnswered++ }
    else { required++; if (has) answeredRequired++ }
  }
  return { required, answeredRequired, optionalAnswered, unknownCount }
}

export function missingRequired(answers: Record<string, unknown>): string[] {
  return BASELINE_QUESTIONS.filter((q) => !q.optional && !isObj(answers[q.key])).map((q) => q.key)
}

/** Stable text form of answers, for "has anything changed since the last save?". */
export function answersFingerprint(answers: Record<string, unknown>): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort) : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v
  return JSON.stringify(sort(answers))
}

function specText(spec: UnitSpec): string {
  const kind = spec.integer ? "a whole number" : "a number"
  return `${kind} from ${spec.min} to ${spec.max}${spec.integer ? "" : ", up to two decimal places"}`
}
/** What a number question accepts, so the owner never has to guess the limits. */
export function limitsText(q: NumberQuestion, unit: string): string | null {
  const spec = q.units[unit]
  return spec ? `Enter ${specText(spec)}.` : null
}

/** The answer as an owner would read it back on the review page. */
export function describeAnswer(key: string, answer: unknown): string {
  const q = QUESTION_BY_KEY.get(key)
  if (!q || !isObj(answer)) return "No answer yet"
  if (answer.state === "unknown") return "I’m not sure"
  const copy = QUESTION_COPY[key]
  switch (q.kind) {
    case "number":
      if (answer.state === "range" && typeof answer.min === "number" && typeof answer.max === "number")
        return formatRange(answer.min, answer.max, String(answer.unit))
      return typeof answer.value === "number" ? formatUnitValue(answer.value, String(answer.unit)) : "No answer yet"
    case "choice":
      return copy.choices?.[String(answer.value)] ?? "No answer yet"
    case "choices":
      return Array.isArray(answer.value) ? answer.value.map((v) => copy.choices?.[String(v)] ?? String(v)).join(", ") : "No answer yet"
    case "mix":
      return isObj(answer.value)
        ? Object.entries(answer.value).map(([k, n]) => `${copy.choices?.[k] ?? k} ${n}%`).join(", ")
        : "No answer yet"
    case "note":
      return typeof answer.value === "string" ? answer.value : "No answer yet"
  }
}
