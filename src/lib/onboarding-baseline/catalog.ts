/**
 * Onboarding baseline catalog `baseline.v1`. Mirrors the immutable
 * `baseline_catalog_questions` rows; the database is authoritative and an
 * integration test asserts this file and the table agree.
 */
export const BASELINE_CATALOG_VERSION = "baseline.v1" as const

export type UnitSpec = { min: number; max: number; integer: boolean }
type Base = { key: string; section: string; optional: boolean; allowsUnknown: boolean }
export type NumberQuestion = Base & {
  kind: "number"
  allowsRange: boolean
  units: Record<string, UnitSpec>
}
export type ChoiceQuestion = Base & { kind: "choice"; choices: readonly string[] }
export type ChoicesQuestion = Base & {
  kind: "choices"
  choices: readonly string[]
  maxSelected: number
}
export type MixQuestion = Base & { kind: "mix"; choices: readonly string[] }
export type NoteQuestion = Base & { kind: "note"; maxLength: number }
export type Question =
  | NumberQuestion
  | ChoiceQuestion
  | ChoicesQuestion
  | MixQuestion
  | NoteQuestion

const int = (min: number, max: number): UnitSpec => ({ min, max, integer: true })
const dec = (min: number, max: number): UnitSpec => ({ min, max, integer: false })
const num = (
  key: string,
  section: string,
  units: Record<string, UnitSpec>,
  o: { optional?: boolean; range?: boolean } = {}
): NumberQuestion => ({
  key,
  section,
  kind: "number",
  optional: o.optional ?? false,
  allowsUnknown: true,
  allowsRange: o.range ?? false,
  units,
})

export const OUTCOMES = [
  "answer_more_calls",
  "respond_faster",
  "book_more",
  "follow_up_more",
  "fewer_no_shows",
  "less_admin",
] as const
export const SOURCES = ["website", "sms", "phone", "meta", "email", "referral", "other"] as const

export const BASELINE_QUESTIONS: readonly Question[] = [
  num("active_operators", "team_capacity", { count: int(0, 500) }),
  num("service_bays", "team_capacity", { count: int(0, 200) }),
  num("operating_days", "team_capacity", { days_per_week: int(1, 7) }),
  num("inquiries_per_month", "lead_flow", { count_per_month: int(0, 100000) }, { range: true }),
  { key: "inquiry_source_mix", section: "lead_flow", kind: "mix", optional: false, allowsUnknown: true, choices: SOURCES },
  num("calls_per_week", "phone", { count_per_week: int(0, 10000) }),
  num("missed_calls_per_week", "phone", { count_per_week: int(0, 10000) }),
  num("missed_calls_returned_per_week", "phone", { count_per_week: int(0, 10000) }),
  num("first_response_minutes", "response", { minutes: int(0, 43200) }, { range: true }),
  num("confirmed_bookings", "conversion", { count_per_month: int(0, 100000), percent: dec(0, 100) }),
  num("avg_booked_value_usd", "work_value", { usd: dec(0, 100000) }, { optional: true, range: true }),
  num("followed_up_within_two_days", "follow_up", { count_per_month: int(0, 100000), percent: dec(0, 100) }),
  num("cancellations_no_shows_per_month", "scheduling", { count_per_month: int(0, 10000) }),
  num("scheduling_conflicts_per_month", "scheduling", { count_per_month: int(0, 10000) }),
  num("admin_hours_calls", "admin_load", { hours_per_week: dec(0, 168) }),
  num("admin_hours_follow_up", "admin_load", { hours_per_week: dec(0, 168) }),
  num("admin_hours_crm", "admin_load", { hours_per_week: dec(0, 168) }),
  num("admin_hours_scheduling", "admin_load", { hours_per_week: dec(0, 168) }),
  { key: "records_system", section: "readiness", kind: "choice", optional: false, allowsUnknown: true, choices: ["crm", "spreadsheet", "paper", "none"] },
  { key: "calendar_system", section: "readiness", kind: "choice", optional: false, allowsUnknown: true, choices: ["google", "microsoft", "other", "none"] },
  { key: "active_channels", section: "readiness", kind: "choices", optional: false, allowsUnknown: true, choices: ["phone", "sms", "email", "website_form", "meta", "other"], maxSelected: 6 },
  { key: "pilot_primary_outcome", section: "pilot_goal", kind: "choice", optional: false, allowsUnknown: false, choices: OUTCOMES },
  { key: "pilot_secondary_outcome", section: "pilot_goal", kind: "choice", optional: true, allowsUnknown: false, choices: OUTCOMES },
  { key: "pilot_goal_note", section: "pilot_goal", kind: "note", optional: true, allowsUnknown: false, maxLength: 280 },
]

export const QUESTION_BY_KEY: ReadonlyMap<string, Question> = new Map(
  BASELINE_QUESTIONS.map((q) => [q.key, q])
)

/** Metric definitions (mirrors `baseline_metric_definitions`, definition v1). */
export const METRIC_DEFINITION_VERSION = "v1" as const
export const METRICS = {
  inquiry_volume: { section: "response", unit: "count", windowSensitive: true },
  missed_call_rate: { section: "response", unit: "percent", windowSensitive: false },
  first_response_minutes: { section: "response", unit: "minutes", windowSensitive: false },
  booking_rate: { section: "booking", unit: "percent", windowSensitive: false },
  cancellations_no_shows: { section: "booking", unit: "count", windowSensitive: true },
  followup_coverage: { section: "follow_up", unit: "percent", windowSensitive: false },
  unresolved_leads: { section: "follow_up", unit: "count", windowSensitive: false },
  admin_hours: { section: "operating_load", unit: "hours_per_week", windowSensitive: false },
} as const
export type MetricKey = keyof typeof METRICS
