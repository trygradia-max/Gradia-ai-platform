// Shared synthetic answer fixtures for unit and integration baseline tests.
export const v = (value: number, unit: string) => ({ state: "value", value, unit })
export const unk = { state: "unknown" }
export const validAnswers = (): Record<string, unknown> => ({
  active_operators: v(2, "count"), service_bays: v(2, "count"), operating_days: v(6, "days_per_week"),
  inquiries_per_month: v(80, "count_per_month"),
  inquiry_source_mix: { state: "value", unit: "percent", value: { website: 50, phone: 30, referral: 20 } },
  calls_per_week: v(40, "count_per_week"), missed_calls_per_week: v(10, "count_per_week"),
  missed_calls_returned_per_week: v(4, "count_per_week"),
  first_response_minutes: { state: "range", min: 30, max: 240, unit: "minutes" },
  confirmed_bookings: v(24, "count_per_month"), followed_up_within_two_days: v(40, "percent"),
  cancellations_no_shows_per_month: v(0, "count_per_month"), scheduling_conflicts_per_month: unk,
  admin_hours_calls: v(5, "hours_per_week"), admin_hours_follow_up: v(3, "hours_per_week"),
  admin_hours_crm: v(2, "hours_per_week"), admin_hours_scheduling: v(1.5, "hours_per_week"),
  records_system: { state: "value", value: "spreadsheet" }, calendar_system: unk,
  active_channels: { state: "value", value: ["phone", "sms"] },
  pilot_primary_outcome: { state: "value", value: "answer_more_calls" },
})
