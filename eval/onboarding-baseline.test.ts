import { describe, expect, it } from "vitest"
import { BASELINE_QUESTIONS } from "@/lib/onboarding-baseline/catalog"
import type { BaselineReadResult, MeasurementRow } from "@/lib/onboarding-baseline/dto"
import { buildComparison, buildStartingPoint } from "@/lib/onboarding-baseline/report"
import { readComparison, readStartingPoint, submitBaseline } from "@/lib/onboarding-baseline/service"
import { validateBaselineAnswers } from "@/lib/onboarding-baseline/validate"
import { unk, v, validAnswers } from "./_baseline-fixtures"

const codes = (a: unknown, complete = true) => validateBaselineAnswers(a, { complete }).map((i) => `${i.key}:${i.code}`)
const withA = (patch: Record<string, unknown>) => ({ ...validAnswers(), ...patch })

describe("baseline answer schema", () => {
  it("accepts a complete answer set and a partial draft", () => {
    expect(codes(validAnswers())).toEqual([])
    expect(codes({ calls_per_week: v(3, "count_per_week") }, false)).toEqual([])
    expect(codes({}, true).length).toBe(BASELINE_QUESTIONS.filter((q) => !q.optional).length)
  })
  it("keeps unknown distinct from zero and refuses it where meaningless", () => {
    expect(codes(withA({ calls_per_week: v(0, "count_per_week"), missed_calls_per_week: v(0, "count_per_week"), missed_calls_returned_per_week: v(0, "count_per_week") }))).toEqual([])
    expect(codes(withA({ calls_per_week: unk }))).toEqual([])
    expect(codes(withA({ pilot_primary_outcome: unk }))).toEqual(["pilot_primary_outcome:unknown_not_allowed"])
    expect(codes(withA({ calls_per_week: { state: "unknown", value: 0 } }))).toEqual(["calls_per_week:unknown_not_allowed"])
  })
  it("rejects invalid units, ranges, types and shapes", () => {
    expect(codes(withA({ calls_per_week: v(5, "count_per_month") }))).toContain("calls_per_week:unit_not_allowed")
    expect(codes(withA({ calls_per_week: v(-1, "count_per_week") }))).toContain("calls_per_week:out_of_range")
    expect(codes(withA({ calls_per_week: v(1.5, "count_per_week") }))).toContain("calls_per_week:out_of_range")
    expect(codes(withA({ operating_days: v(0, "days_per_week") }))).toContain("operating_days:out_of_range")
    expect(codes(withA({ confirmed_bookings: v(101, "percent") }))).toContain("confirmed_bookings:out_of_range")
    expect(codes(withA({ calls_per_week: { state: "value", value: "5", unit: "count_per_week" } }))).toContain("calls_per_week:invalid_shape")
    expect(codes(withA({ calls_per_week: { state: "range", min: 1, max: 5, unit: "count_per_week" } }))).toContain("calls_per_week:range_not_allowed")
    expect(codes(withA({ first_response_minutes: { state: "range", min: 9, max: 9, unit: "minutes" } }))).toContain("first_response_minutes:out_of_range")
    expect(codes(withA({ nonsense: unk }))).toContain("nonsense:unknown_question")
    expect(codes(withA({ calls_per_week: { ...v(1, "count_per_week"), extra: 1 } }))).toContain("calls_per_week:invalid_shape")
  })
  it("enforces choices, mix totals, notes and cross-field consistency", () => {
    expect(codes(withA({ records_system: { state: "value", value: "excel" } }))).toContain("records_system:invalid_choice")
    expect(codes(withA({ active_channels: { state: "value", value: ["sms", "sms"] } }))).toContain("active_channels:invalid_selection")
    expect(codes(withA({ inquiry_source_mix: { state: "value", unit: "percent", value: { website: 60, phone: 30 } } }))).toContain("inquiry_source_mix:mix_total")
    expect(codes(withA({ pilot_goal_note: { state: "value", value: "x".repeat(281) } }))).toContain("pilot_goal_note:invalid_note")
    expect(codes(withA({ missed_calls_per_week: v(41, "count_per_week") }))).toContain("missed_calls_per_week:exceeds_calls")
    expect(codes(withA({ confirmed_bookings: v(81, "count_per_month") }))).toContain("confirmed_bookings:exceeds_inquiries")
    expect(codes(withA({ admin_hours_calls: v(168, "hours_per_week") }))).toContain("admin_hours_calls:exceeds_week")
    expect(codes(withA({ pilot_secondary_outcome: { state: "value", value: "answer_more_calls" } }))).toContain("pilot_secondary_outcome:same_as_primary")
  })
})

const row = (o: Partial<MeasurementRow> & { metric_key: string }): MeasurementRow => ({
  id: crypto.randomUUID(), definition_version: "v1", evidence_class: "gradia_observed", value: 10, unit: "count",
  window_start: "2026-09-01T00:00:00Z", window_end: "2026-10-01T00:00:00Z", source_system: null, source_ref: "interactions",
  formula_version: null, inputs: [], ...o,
})
const read = (answers: Record<string, unknown>, measurements: MeasurementRow[] = []): BaselineReadResult => ({
  role: "owner", pointer: { revision: 1, advanced_at: "2026-10-02T00:00:00Z" }, draft: null, measurements,
  revision: { revision: 1, catalog_version: "baseline.v1", answers, reporting_period_start: "2026-09-01", reporting_period_end: "2026-10-01", supersedes_revision: null, submitted_at: "2026-10-02T00:00:00Z" },
})

describe("starting point DTO", () => {
  it("derives deterministic metrics citing inputs and formula, labelled by weakest basis", () => {
    const dto = buildStartingPoint(read(validAnswers()))
    if (dto.status !== "ready") throw new Error("expected ready")
    const [volume, missed, response] = dto.sections.response
    expect(volume).toMatchObject({ status: "measured", value: 80, unit: "count_per_month", evidenceClass: "owner_estimate" })
    expect(missed).toMatchObject({ value: 25, unit: "percent", evidenceClass: "derived", basisEvidenceClass: "owner_estimate", formulaVersion: "missed_call_rate.v1" })
    expect(missed.inputs).toEqual([
      { kind: "answer", revision: 1, questionKey: "missed_calls_per_week" },
      { kind: "answer", revision: 1, questionKey: "calls_per_week" },
    ])
    expect(response).toMatchObject({ status: "measured", value: null, range: { min: 30, max: 240 } })
    expect(dto.sections.booking[0]).toMatchObject({ value: 30, formulaVersion: "booking_rate.v1" })
    expect(dto.sections.followUp[0]).toMatchObject({ value: 40, evidenceClass: "owner_estimate", formulaVersion: null })
    expect(dto.sections.operatingLoad[0]).toMatchObject({ value: 11.5, unit: "hours_per_week" })
    expect(dto.readiness).toEqual({ recordsSystem: "spreadsheet", calendarSystem: "unknown", activeChannels: ["phone", "sms"] })
  })
  it("never turns unknown or missing into zero", () => {
    const dto = buildStartingPoint(read(withA({ inquiries_per_month: unk, calls_per_week: unk, admin_hours_crm: unk, cancellations_no_shows_per_month: v(0, "count_per_month") })))
    if (dto.status !== "ready") throw new Error("expected ready")
    expect(dto.sections.response[0]).toMatchObject({ status: "unknown", value: null, evidenceClass: "unknown" })
    expect(dto.sections.response[1]).toMatchObject({ status: "unknown", value: null, reason: "input_unknown" })
    expect(dto.sections.operatingLoad[0]).toMatchObject({ status: "unknown", value: null })
    expect(dto.sections.booking[1]).toMatchObject({ status: "measured", value: 0 }) // a real zero stays zero
    expect(dto.sections.followUp[1]).toMatchObject({ status: "not_measured", value: null })
  })
  it("refuses to derive from zero denominators or ranges", () => {
    const zero = buildStartingPoint(read(withA({ calls_per_week: v(0, "count_per_week"), missed_calls_per_week: v(0, "count_per_week"), missed_calls_returned_per_week: v(0, "count_per_week") })))
    if (zero.status !== "ready") throw new Error("expected ready")
    expect(zero.sections.response[1]).toMatchObject({ status: "not_measured", value: null, reason: "zero_denominator" })
    const range = buildStartingPoint(read(withA({ inquiries_per_month: { state: "range", min: 50, max: 90, unit: "count_per_month" } })))
    if (range.status !== "ready") throw new Error("expected ready")
    expect(range.sections.booking[0]).toMatchObject({ status: "not_measured", reason: "input_is_range" })
  })
  it("prefers attached connected evidence and reports no revision as not_started", () => {
    const m = row({ metric_key: "missed_call_rate", evidence_class: "connected_evidence", source_system: "twilio", unit: "percent", value: 12.5 })
    const dto = buildStartingPoint(read(validAnswers(), [m]))
    if (dto.status !== "ready") throw new Error("expected ready")
    expect(dto.sections.response[1]).toMatchObject({ value: 12.5, evidenceClass: "connected_evidence", basisEvidenceClass: "connected_evidence", sourceSystem: "twilio", period: { kind: "window" } })
    expect(buildStartingPoint({ ...read({}), revision: null, pointer: null })).toEqual({ status: "not_started", role: "owner", draft: null })
  })
})

describe("comparison DTO", () => {
  const baseWindow = { start: "2026-09-01T00:00:00Z", end: "2026-10-01T00:00:00Z" }
  const cur = { start: "2026-10-02T00:00:00Z", end: "2026-11-01T00:00:00Z" }
  const baseRows = [
    row({ metric_key: "inquiry_volume", value: 100 }),
    row({ metric_key: "first_response_minutes", unit: "minutes", value: 60 }),
  ]
  const item = (dto: ReturnType<typeof buildComparison>, key: string) => {
    if (dto.status !== "ready") throw new Error("expected ready")
    return dto.items.find((i) => i.key === key)!
  }
  it("compares like-for-like evidence windows with a plain delta only", () => {
    const dto = buildComparison(read(validAnswers(), baseRows), [
      row({ metric_key: "inquiry_volume", value: 130, window_start: cur.start, window_end: cur.end }),
      row({ metric_key: "first_response_minutes", unit: "minutes", value: 20, window_start: cur.start, window_end: cur.end }),
    ], { start: cur.start, end: cur.end })
    expect(item(dto, "inquiry_volume")).toMatchObject({ status: "comparable", delta: 30 })
    expect(item(dto, "first_response_minutes")).toMatchObject({ status: "comparable", delta: -40 })
    expect(JSON.stringify(dto)).not.toMatch(/roi|saving|improv|score/i)
  })
  it("treats an owner-estimate baseline as reference only (no delta)", () => {
    const dto = buildComparison(read(validAnswers()), [row({ metric_key: "inquiry_volume", value: 99, window_start: cur.start, window_end: cur.end })], cur)
    expect(item(dto, "inquiry_volume")).toMatchObject({ status: "reference_only" })
    expect(item(dto, "inquiry_volume")).not.toHaveProperty("delta")
  })
  it("refuses unlike windows, definitions, units and overlaps", () => {
    const run = (over: Partial<MeasurementRow>) =>
      item(buildComparison(read(validAnswers(), baseRows), [row({ metric_key: "inquiry_volume", value: 130, window_start: cur.start, window_end: cur.end, ...over })], cur), "inquiry_volume")
    expect(run({ window_end: "2026-10-16T00:00:00Z" })).toMatchObject({ status: "not_comparable", reason: "window_length_differs" })
    expect(run({ definition_version: "v2" })).toMatchObject({ status: "not_comparable", reason: "definition_changed" })
    expect(run({ unit: "percent" })).toMatchObject({ status: "not_comparable", reason: "unit_changed" })
    expect(run({ window_start: "2026-09-15T00:00:00Z", window_end: "2026-10-15T00:00:00Z" })).toMatchObject({ status: "not_comparable", reason: "windows_overlap" })
    expect(run({ value: null, evidence_class: "unknown" })).toMatchObject({ status: "not_comparable", reason: "current_unknown" })
  })
  it("reports missing current evidence and ambiguity, never zero", () => {
    expect(item(buildComparison(read(validAnswers(), baseRows), [], cur), "inquiry_volume")).toMatchObject({ status: "not_comparable", reason: "current_not_measured", current: null })
    const two = [
      row({ metric_key: "inquiry_volume", value: 1, evidence_class: "connected_evidence", source_system: "a", source_ref: null, window_start: cur.start, window_end: cur.end }),
      row({ metric_key: "inquiry_volume", value: 2, evidence_class: "connected_evidence", source_system: "b", source_ref: null, window_start: cur.start, window_end: cur.end }),
    ]
    expect(item(buildComparison(read(validAnswers(), baseRows), two, cur), "inquiry_volume")).toMatchObject({ reason: "ambiguous_current_evidence" })
    expect(buildComparison({ ...read({}), revision: null }, [], baseWindow)).toEqual({ status: "not_started" })
  })
})

describe("service failure handling", () => {
  const failing = (code?: string) => ({ rpc: async () => ({ data: null, error: { code, message: "x" } }) }) as never
  const throwing = { rpc: async () => { throw new Error("network") } } as never
  it("returns unavailable/forbidden, never an empty report", async () => {
    expect(await readStartingPoint(failing("XX000"), "s")).toEqual({ status: "unavailable" })
    expect(await readStartingPoint(failing("42501"), "s")).toEqual({ status: "forbidden" })
    expect(await readStartingPoint(throwing, "s")).toEqual({ status: "unavailable" })
    expect(await readStartingPoint({ rpc: async () => ({ data: {}, error: null }) } as never, "s")).toEqual({ status: "unavailable" })
    expect(await readComparison(failing(), "s", { start: "a", end: "b" })).toEqual({ status: "unavailable" })
  })
  it("fails window read as unavailable and maps command conflicts", async () => {
    let n = 0
    const db = { rpc: async () => (n++ === 0 ? { data: read(validAnswers()), error: null } : { data: null, error: { code: "XX000" } }) } as never
    expect(await readComparison(db, "s", { start: "2026-10-02T00:00:00Z", end: "2026-11-01T00:00:00Z" })).toEqual({ status: "unavailable" })
    const bad = await submitBaseline(failing("PT409"), { shopId: "s", answers: validAnswers(), periodStart: "2026-09-01", periodEnd: "2026-10-01", expectedBaseline: null, expectedDraftVersion: null })
    expect(bad).toEqual({ ok: false, code: "conflict" })
    const invalid = await submitBaseline(failing(), { shopId: "s", answers: {}, periodStart: "2026-09-01", periodEnd: "2026-10-01", expectedBaseline: null, expectedDraftVersion: null })
    expect(invalid).toMatchObject({ ok: false, code: "invalid" })
  })
})
