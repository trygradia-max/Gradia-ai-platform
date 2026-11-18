import { describe, expect, it } from "vitest"
import { BASELINE_QUESTIONS, METRICS } from "@/lib/onboarding-baseline/catalog"
import { METRIC_LABELS, QUESTION_COPY, QUIZ_STEPS, issueMessage } from "@/lib/onboarding-baseline/copy"
import type { BaselineReadResult, MeasurementRow } from "@/lib/onboarding-baseline/dto"
import { formatDate, formatMinutes, formatRange, formatUnitValue } from "@/lib/onboarding-baseline/format"
import {
  answersFingerprint,
  answersFromForm,
  describeAnswer,
  formFromAnswers,
  limitsText,
  missingRequired,
  parseNumberText,
  progressOf,
  questionsInStep,
  stepOfQuestion,
  validateForm,
  type FormState,
} from "@/lib/onboarding-baseline/form-model"
import { defaultReportingPeriod } from "@/lib/onboarding-baseline/period"
import { buildReportView, describeMetric } from "@/lib/onboarding-baseline/report-model"
import { buildStartingPoint } from "@/lib/onboarding-baseline/report"
import { unk, v, validAnswers } from "./_baseline-fixtures"

const num = (text: string, unit: string): FormState[string] => ({ mode: "number", unit, text })

describe("catalog coverage by plain-language copy", () => {
  it("has copy for every question, every choice and every extra unit", () => {
    for (const q of BASELINE_QUESTIONS) {
      const c = QUESTION_COPY[q.key]
      expect(c, q.key).toBeTruthy()
      expect(c.label.length).toBeGreaterThan(8)
      if ("choices" in q) for (const choice of q.choices) expect(c.choices?.[choice], `${q.key}.${choice}`).toBeTruthy()
      if (q.kind === "number" && Object.keys(q.units).length > 1)
        for (const unit of Object.keys(q.units)) expect(c.units?.[unit], `${q.key}.${unit}`).toBeTruthy()
      if (q.kind === "number" && Object.keys(q.units).length === 1) expect(c.suffix, q.key).toBeTruthy()
    }
    expect(Object.keys(QUESTION_COPY).sort()).toEqual(BASELINE_QUESTIONS.map((q) => q.key).sort())
  })
  it("places every question on exactly one page, in catalog order", () => {
    const placed = QUIZ_STEPS.flatMap((s) => questionsInStep(s).map((q) => q.key))
    expect(placed).toEqual(BASELINE_QUESTIONS.map((q) => q.key))
    expect(new Set(placed).size).toBe(BASELINE_QUESTIONS.length)
    expect(stepOfQuestion("calls_per_week")?.id).toBe("inquiries")
    expect(stepOfQuestion("pilot_primary_outcome")?.id).toBe("systems")
  })
  it("labels every metric and uses plain operator language with no anchoring or hype", () => {
    expect(Object.keys(METRIC_LABELS).sort()).toEqual(Object.keys(METRICS).sort())
    const text = JSON.stringify([QUESTION_COPY, METRIC_LABELS]).toLowerCase()
    for (const banned of ["agent", " ai ", "model", "algorithm", "llm", "roi", "score", "!", "e.g.", "typically", "most shops", "average shop"]) {
      expect(text, banned).not.toContain(banned)
    }
  })
  it("gives a plain message for every code the validators can emit", () => {
    const codes = ["required", "not_a_number", "range_incomplete", "unit_not_allowed", "out_of_range", "range_not_allowed", "invalid_choice", "invalid_selection", "invalid_mix", "mix_total", "invalid_note", "unknown_not_allowed", "exceeds_calls", "exceeds_missed", "exceeds_inquiries", "exceeds_week", "same_as_primary"]
    for (const c of codes) expect(issueMessage(c)).not.toMatch(/invalid_|_not_|undefined/)
    expect(issueMessage("something_new")).toBe("Check this answer and try again.")
  })
})

describe("unknown, blank and zero stay distinct", () => {
  it("never turns a blank into zero or unknown", () => {
    const { answers, issues } = answersFromForm({ calls_per_week: num("", "count_per_week"), service_bays: num("   ", "count") })
    expect(answers).toEqual({})
    expect(issues).toEqual([])
  })
  it("keeps an explicit zero as zero and 'not sure' as unknown", () => {
    const { answers } = answersFromForm({ calls_per_week: num("0", "count_per_week"), missed_calls_per_week: { mode: "unknown" } })
    expect(answers.calls_per_week).toEqual({ state: "value", value: 0, unit: "count_per_week" })
    expect(answers.missed_calls_per_week).toEqual({ state: "unknown" })
  })
  it("rejects text that is not a number instead of reading it as zero", () => {
    for (const bad of ["abc", "1e3", "-4", "12abc", ".", "1.2.3"]) {
      const { answers, issues } = answersFromForm({ calls_per_week: num(bad, "count_per_week") })
      expect(answers, bad).toEqual({})
      expect(issues, bad).toEqual([{ key: "calls_per_week", code: "not_a_number" }])
    }
    expect(parseNumberText("1,200")).toBe(1200)
    expect(parseNumberText(" 12.5 ")).toBe(12.5)
    expect(parseNumberText("")).toBeNull()
  })
  it("reports a parse problem instead of 'required' for the same question", () => {
    const { issues } = validateForm({ calls_per_week: num("abc", "count_per_week") }, { complete: true })
    expect(issues.filter((i) => i.key === "calls_per_week")).toEqual([{ key: "calls_per_week", code: "not_a_number" }])
  })
  it("treats an unanswered required question as required, and an optional one as fine", () => {
    const { issues } = validateForm({}, { complete: true })
    const keys = issues.map((i) => i.key)
    expect(keys).toContain("calls_per_week")
    expect(keys).not.toContain("avg_booked_value_usd")
    expect(keys).not.toContain("pilot_secondary_outcome")
    expect(validateForm({}, { complete: false }).issues).toEqual([])
    expect(missingRequired({ calls_per_week: unk })).not.toContain("calls_per_week")
  })
  it("requires both ends of a range and keeps a range a range", () => {
    expect(answersFromForm({ first_response_minutes: { mode: "range", unit: "minutes", minText: "30", maxText: "" } }).issues).toEqual([{ key: "first_response_minutes", code: "range_incomplete" }])
    const { answers } = answersFromForm({ first_response_minutes: { mode: "range", unit: "minutes", minText: "30", maxText: "240" } })
    expect(answers.first_response_minutes).toEqual({ state: "range", min: 30, max: 240, unit: "minutes" })
  })
})

describe("form model round trip and validation", () => {
  it("rebuilds a stored answer set exactly", () => {
    const form = formFromAnswers(validAnswers())
    const { answers, issues } = answersFromForm(form)
    expect(issues).toEqual([])
    expect(answers).toEqual(validAnswers())
    expect(validateForm(form, { complete: true }).issues).toEqual([])
  })
  it("drops malformed stored entries instead of guessing", () => {
    const form = formFromAnswers({ calls_per_week: { state: "value", value: "5" }, service_bays: "many", records_system: { state: "value", value: 4 } })
    expect(form).toEqual({})
    expect(formFromAnswers(null)).toEqual({})
  })
  it("reuses the shared catalog rules (units, ranges, cross-field, mix total)", () => {
    const codes = (f: FormState) => validateForm(f, { complete: false }).issues.map((i) => `${i.key}:${i.code}`)
    expect(codes({ operating_days: num("9", "days_per_week") })).toEqual(["operating_days:out_of_range"])
    expect(codes({ calls_per_week: num("2.5", "count_per_week") })).toEqual(["calls_per_week:out_of_range"])
    expect(codes({ calls_per_week: num("10", "count_per_week"), missed_calls_per_week: num("11", "count_per_week") })).toEqual(["missed_calls_per_week:exceeds_calls"])
    expect(codes({ inquiry_source_mix: { mode: "mix", percents: { website: "60", phone: "30", sms: "" } } })).toEqual(["inquiry_source_mix:mix_total"])
    expect(codes({ inquiry_source_mix: { mode: "mix", percents: { website: "60", phone: "40" } } })).toEqual([])
    expect(codes({ pilot_primary_outcome: { mode: "choice", value: "book_more" }, pilot_secondary_outcome: { mode: "choice", value: "book_more" } })).toEqual(["pilot_secondary_outcome:same_as_primary"])
    expect(codes({ pilot_goal_note: { mode: "note", text: "x".repeat(281) } })).toEqual(["pilot_goal_note:invalid_note"])
  })
  it("states a question's limits without suggesting an answer", () => {
    const q = BASELINE_QUESTIONS.find((x) => x.key === "operating_days")!
    if (q.kind !== "number") throw new Error("catalog drift")
    expect(limitsText(q, "days_per_week")).toBe("Enter a whole number from 1 to 7.")
    expect(limitsText(q, "nope")).toBeNull()
  })
  it("counts progress by real answers and explicit 'not sure', never blanks", () => {
    expect(progressOf({})).toEqual({ required: 21, answeredRequired: 0, optionalAnswered: 0, unknownCount: 0 })
    const p = progressOf(validAnswers())
    expect(p.required).toBe(21)
    expect(p.answeredRequired).toBe(21)
    expect(p.unknownCount).toBe(2) // scheduling conflicts + calendar
    expect(progressOf({ calls_per_week: unk, avg_booked_value_usd: v(250, "usd") })).toMatchObject({ answeredRequired: 1, optionalAnswered: 1, unknownCount: 1 })
  })
  it("fingerprints answers independent of key order", () => {
    expect(answersFingerprint({ b: { y: 1, x: 2 }, a: [1] })).toBe(answersFingerprint({ a: [1], b: { x: 2, y: 1 } }))
    expect(answersFingerprint({ a: 1 })).not.toBe(answersFingerprint({ a: 2 }))
  })
  it("reads answers back in an owner's words", () => {
    expect(describeAnswer("calls_per_week", v(40, "count_per_week"))).toBe("40 a week")
    expect(describeAnswer("calls_per_week", unk)).toBe("I’m not sure")
    expect(describeAnswer("calls_per_week", undefined)).toBe("No answer yet")
    expect(describeAnswer("first_response_minutes", { state: "range", min: 30, max: 240, unit: "minutes" })).toBe("30 min to 4 hr")
    expect(describeAnswer("followed_up_within_two_days", v(40, "percent"))).toBe("40%")
    expect(describeAnswer("records_system", { state: "value", value: "spreadsheet" })).toBe("A spreadsheet")
    expect(describeAnswer("active_channels", { state: "value", value: ["phone", "sms"] })).toBe("Phone calls, Text messages")
    expect(describeAnswer("inquiry_source_mix", { state: "value", unit: "percent", value: { website: 60, phone: 40 } })).toBe("Website form 60%, Phone call 40%")
  })
})

describe("formatting", () => {
  it("formats units and durations deterministically", () => {
    expect(formatMinutes(0)).toBe("0 min")
    expect(formatMinutes(90)).toBe("1 hr 30 min")
    expect(formatMinutes(120)).toBe("2 hr")
    expect(formatMinutes(2880)).toBe("2 days")
    expect(formatUnitValue(1, "hours_per_week")).toBe("1 hour a week")
    expect(formatUnitValue(11.5, "hours_per_week")).toBe("11.5 hours a week")
    expect(formatUnitValue(1250, "usd")).toBe("$1,250")
    expect(formatUnitValue(0, "count_per_month")).toBe("0 a month")
    expect(formatRange(10, 20, "count_per_month")).toBe("10 to 20 a month")
    expect(formatDate("2026-08-20")).toBe("Aug 20, 2026")
    expect(formatDate("2026-09-01T00:00:00Z")).toBe("Sep 1, 2026")
  })
  it("computes the owner reporting period as 90 days ending yesterday (UTC)", () => {
    expect(defaultReportingPeriod(new Date("2026-11-18T03:00:00Z"))).toEqual({ start: "2026-08-20", end: "2026-11-17" })
    expect(defaultReportingPeriod(new Date("2026-03-01T00:00:00Z"))).toEqual({ start: "2025-12-01", end: "2026-02-28" })
  })
})

const read = (answers: Record<string, unknown>, measurements: MeasurementRow[] = []): BaselineReadResult => ({
  role: "owner", pointer: { revision: 1, advanced_at: "2026-11-18T00:00:00Z" }, draft: null, measurements,
  revision: { revision: 1, catalog_version: "baseline.v1", answers, reporting_period_start: "2026-08-20", reporting_period_end: "2026-11-17", supersedes_revision: null, submitted_at: "2026-11-18T15:00:00Z" },
})
const ready = (answers: Record<string, unknown>, measurements: MeasurementRow[] = []) => {
  const dto = buildStartingPoint(read(answers, measurements))
  if (dto.status !== "ready") throw new Error("expected ready")
  return dto
}

describe("report view model: evidence labels", () => {
  it("labels owner answers and derived figures by their weakest basis, with period and version", () => {
    const view = buildReportView(ready(validAnswers()))
    const all = view.sections.flatMap((s) => s.items)
    const by = (k: string) => all.find((m) => m.key === k)!
    expect(view.sections.map((s) => s.title)).toEqual(["Response", "Booking", "Follow-up", "Operating load"])
    expect(by("inquiry_volume")).toMatchObject({ state: "value", valueText: "80 a month", evidence: { kind: "owner", label: "Owner estimate" } })
    expect(by("inquiry_volume").periodText).toBe("Your normal period, estimated for Aug 20, 2026 to Nov 17, 2026")
    expect(by("missed_call_rate")).toMatchObject({ valueText: "25%", evidence: { kind: "owner", label: "Owner estimate" }, methodText: "Calculated by Gradia from your answers." })
    expect(by("missed_call_rate").details).toEqual(["Definition v1", "Formula missed_call_rate.v1", "2 inputs"])
    expect(by("admin_hours")).toMatchObject({ valueText: "11.5 hours a week", evidence: { kind: "owner" } })
    expect(view.revision).toBe(1)
    expect(view.versionText).toBe("baseline.v1")
    expect(view.submittedText).toBe("Nov 18, 2026")
    expect(view.periodText).toBe("Aug 20, 2026 to Nov 17, 2026")
    expect(view.ownerEstimatesOnly).toBe(true)
  })
  it("keeps a range as a range and an explicit zero as zero", () => {
    const by = (k: string) => buildReportView(ready(validAnswers())).sections.flatMap((s) => s.items).find((m) => m.key === k)!
    expect(by("first_response_minutes")).toMatchObject({ state: "range", valueText: "30 min to 4 hr" })
    expect(by("cancellations_no_shows")).toMatchObject({ state: "value", valueText: "0 a month" })
  })
  it("shows 'Not sure' for unknown and 'Not measured yet' for missing, never a number", () => {
    const view = buildReportView(ready({ ...validAnswers(), cancellations_no_shows_per_month: unk, calls_per_week: unk }))
    const by = (k: string) => view.sections.flatMap((s) => s.items).find((m) => m.key === k)!
    expect(by("cancellations_no_shows")).toMatchObject({ state: "unknown", stateLabel: "Not sure", valueText: null, evidence: { kind: "unsure", label: "Not sure" } })
    expect(by("missed_call_rate")).toMatchObject({ state: "unknown", stateLabel: "Not sure", valueText: null })
    expect(by("unresolved_leads")).toMatchObject({ state: "not_measured", stateLabel: "Not measured yet", valueText: null, evidence: null })
    expect(by("unresolved_leads").reasonText).toMatch(/nothing has been recorded/i)
  })
  it("explains why a rate is missing instead of computing around it", () => {
    const zero = buildReportView(ready({ ...validAnswers(), calls_per_week: v(0, "count_per_week"), missed_calls_per_week: v(0, "count_per_week"), missed_calls_returned_per_week: v(0, "count_per_week") }))
    const m = zero.sections.flatMap((s) => s.items).find((x) => x.key === "missed_call_rate")!
    expect(m).toMatchObject({ state: "not_measured", valueText: null })
    expect(m.reasonText).toMatch(/none to measure against/)
    const range = buildReportView(ready({ ...validAnswers(), inquiries_per_month: { state: "range", min: 60, max: 90, unit: "count_per_month" } }))
    const b = range.sections.flatMap((s) => s.items).find((x) => x.key === "booking_rate")!
    expect(b).toMatchObject({ state: "not_measured", valueText: null })
    expect(b.reasonText).toMatch(/range/)
  })
  it("labels attached measurements Connected or Observed with their exact window and source", () => {
    const row = (o: Partial<MeasurementRow>): MeasurementRow => ({
      id: crypto.randomUUID(), metric_key: "inquiry_volume", definition_version: "v1", evidence_class: "gradia_observed", value: 100, unit: "count",
      window_start: "2026-09-01T00:00:00Z", window_end: "2026-10-01T00:00:00Z", source_system: null, source_ref: "interactions", formula_version: null, inputs: [], ...o,
    })
    const observed = buildReportView(ready(validAnswers(), [row({})])).sections[0].items.find((m) => m.key === "inquiry_volume")!
    expect(observed).toMatchObject({ valueText: "100", evidence: { kind: "observed", label: "Observed by Gradia" }, periodText: "Measured Sep 1, 2026 to Oct 1, 2026" })
    expect(observed.details).toContain("Reference: interactions")
    const connected = buildReportView(ready(validAnswers(), [row({ evidence_class: "connected_evidence", source_system: "calendar", source_ref: null })]))
    expect(connected.sections[0].items.find((m) => m.key === "inquiry_volume")!.evidence).toMatchObject({ kind: "connected", label: "Connected" })
    expect(connected.ownerEstimatesOnly).toBe(false)
  })
  it("never produces ROI, savings, causal or improvement wording", () => {
    const text = JSON.stringify(buildReportView(ready(validAnswers()))).toLowerCase()
    for (const banned of ["roi", "saved", "savings", "improv", "increase", "decrease", "because gradia", "revenue gained", "score"]) expect(text, banned).not.toContain(banned)
    expect(describeMetric(ready(validAnswers()).sections.response[0]).key).toBe("inquiry_volume")
  })
})
