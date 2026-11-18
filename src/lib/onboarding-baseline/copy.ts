import type { MetricKey } from "./catalog"
import type { EvidenceClass, MetricReason } from "./dto"

/**
 * Plain operator language for the Starting point quiz and report. Written for a shop owner, not an
 * engineer: no model/AI jargon, no vendor names. Nothing here suggests an expected number: help text
 * explains what is being asked, never what a "good" answer looks like, and there are no placeholders
 * or defaults that could anchor an answer.
 */

export type QuestionCopy = {
  label: string
  help?: string
  /** Label for each allowed unit, where a question allows more than one. */
  units?: Record<string, string>
  /** Short suffix shown after a single-unit number input. */
  suffix?: string
  /** Label for each allowed choice. */
  choices?: Record<string, string>
}

const OUTCOME_CHOICES: Record<string, string> = {
  answer_more_calls: "Answer more of our calls",
  respond_faster: "Reply to new inquiries faster",
  book_more: "Turn more inquiries into bookings",
  follow_up_more: "Follow up with more unbooked inquiries",
  fewer_no_shows: "Fewer cancellations and no-shows",
  less_admin: "Spend less time on admin",
}

export const QUESTION_COPY: Record<string, QuestionCopy> = {
  active_operators: {
    label: "How many people actively work on jobs?",
    help: "Count yourself if you work on jobs. Include anyone who regularly does the work.",
    suffix: "people",
  },
  service_bays: {
    label: "How many service bays or mobile crews do you run?",
    help: "A bay is a place a vehicle is worked on at the same time. A mobile crew counts as one.",
    suffix: "bays or crews",
  },
  operating_days: {
    label: "How many days a week are you open for work?",
    suffix: "days a week",
  },
  inquiries_per_month: {
    label: "About how many new inquiries do you get in a normal month?",
    help: "Count each new person who asks about work, from any channel. If it swings a lot, give a range.",
    suffix: "inquiries a month",
  },
  inquiry_source_mix: {
    label: "Where do those inquiries come from?",
    help: "Give each source a share of your inquiries. Leave a source blank if it brings none. The shares need to add up to 100%.",
    choices: {
      website: "Website form",
      sms: "Text message",
      phone: "Phone call",
      meta: "Facebook or Instagram",
      email: "Email",
      referral: "Referral",
      other: "Somewhere else",
    },
  },
  calls_per_week: {
    label: "About how many calls come in during a normal week?",
    help: "Include calls you answer and calls you miss.",
    suffix: "calls a week",
  },
  missed_calls_per_week: {
    label: "Of those, about how many go unanswered?",
    help: "Calls that ring out, go to voicemail, or get dropped before someone talks to the caller.",
    suffix: "calls a week",
  },
  missed_calls_returned_per_week: {
    label: "Of the unanswered calls, about how many do you call back?",
    suffix: "calls a week",
  },
  first_response_minutes: {
    label: "How long does a new inquiry usually wait for a first reply?",
    help: "From the moment it arrives to your first answer. If it varies a lot, give a range.",
    suffix: "minutes",
  },
  confirmed_bookings: {
    label: "How many inquiries turn into confirmed appointments?",
    help: "Use whichever is easier to estimate. A confirmed appointment is on your calendar.",
    units: { count_per_month: "A number each month", percent: "A percent of inquiries" },
  },
  avg_booked_value_usd: {
    label: "What is a typical booked service worth?",
    help: "Optional. Skip it if you would rather not say. Gradia does not need your revenue to set a starting point.",
    suffix: "US dollars",
  },
  followed_up_within_two_days: {
    label: "How many unbooked inquiries do you follow up within two business days?",
    help: "Use whichever is easier to estimate.",
    units: { count_per_month: "A number each month", percent: "A percent of unbooked inquiries" },
  },
  cancellations_no_shows_per_month: {
    label: "How many cancellations or no-shows do you have in a normal month?",
    suffix: "a month",
  },
  scheduling_conflicts_per_month: {
    label: "How often do you double-book or hit a scheduling conflict in a normal month?",
    suffix: "times a month",
  },
  admin_hours_calls: {
    label: "Hours a week you or your team spend on the phone with customers",
    suffix: "hours a week",
  },
  admin_hours_follow_up: {
    label: "Hours a week spent following up with inquiries and past customers",
    suffix: "hours a week",
  },
  admin_hours_crm: {
    label: "Hours a week spent keeping records, notes and customer details up to date",
    suffix: "hours a week",
  },
  admin_hours_scheduling: {
    label: "Hours a week spent scheduling, rescheduling and confirming",
    suffix: "hours a week",
  },
  records_system: {
    label: "Where do you keep customer records today?",
    choices: { crm: "A customer system (CRM)", spreadsheet: "A spreadsheet", paper: "Paper or notebooks", none: "Nowhere in particular" },
  },
  calendar_system: {
    label: "What calendar do you book work on?",
    choices: { google: "Google Calendar", microsoft: "Outlook or Microsoft", other: "Another calendar", none: "No shared calendar" },
  },
  active_channels: {
    label: "Which of these do customers use to reach you today?",
    help: "Choose all that apply.",
    choices: { phone: "Phone calls", sms: "Text messages", email: "Email", website_form: "A website form", meta: "Facebook or Instagram", other: "Something else" },
  },
  pilot_primary_outcome: {
    label: "What matters most to improve first?",
    help: "This sets what Gradia looks at first. It is not a promise of any result.",
    choices: OUTCOME_CHOICES,
  },
  pilot_secondary_outcome: {
    label: "Is there a second thing you would like to improve?",
    help: "Optional. Choose a different one.",
    choices: OUTCOME_CHOICES,
  },
  pilot_goal_note: {
    label: "Anything else about what you want to learn?",
    help: "Optional. Please leave out customer names, phone numbers and passwords.",
  },
}

export const OUTCOME_LABELS = OUTCOME_CHOICES

/** The 24 catalog questions grouped into five short pages, followed by a review page; the order here is the order owners see. */
export type QuizStep = { id: string; title: string; blurb: string; sections: readonly string[] }
export const QUIZ_STEPS: readonly QuizStep[] = [
  { id: "team", title: "Your team", blurb: "How big the operation is today.", sections: ["team_capacity"] },
  { id: "inquiries", title: "Inquiries and calls", blurb: "How work reaches you and how fast you answer.", sections: ["lead_flow", "phone", "response"] },
  { id: "bookings", title: "Bookings and follow-up", blurb: "What happens after someone asks.", sections: ["conversion", "work_value", "follow_up", "scheduling"] },
  { id: "admin", title: "Time on admin", blurb: "Roughly where your week goes.", sections: ["admin_load"] },
  { id: "systems", title: "Tools and goals", blurb: "What you use today and what you want to learn.", sections: ["readiness", "pilot_goal"] },
]

export const SECTION_TITLES: Record<string, string> = {
  team_capacity: "Team and capacity",
  lead_flow: "New inquiries",
  phone: "Phone calls",
  response: "First reply",
  conversion: "Bookings",
  work_value: "Typical job value",
  follow_up: "Follow-up",
  scheduling: "Scheduling",
  admin_load: "Admin time",
  readiness: "Tools you use",
  pilot_goal: "What to learn first",
}

/** Plain message for a validation issue code, optionally naming the other question involved. */
export function issueMessage(code: string): string {
  switch (code) {
    case "required":
      return "Answer this, or choose “I’m not sure”."
    case "not_a_number":
      return "Enter a number using digits, like 12 or 12.5."
    case "range_incomplete":
      return "Enter both ends of the range."
    case "unit_not_allowed":
      return "Choose how you want to answer this."
    case "out_of_range":
      return "That number is outside what this question accepts. Check the value and try again."
    case "range_not_allowed":
      return "This question takes a single number."
    case "invalid_choice":
    case "invalid_selection":
      return "Choose one of the options."
    case "invalid_mix":
      return "Use numbers between 0 and 100 for each source."
    case "mix_total":
      return "The shares need to add up to exactly 100%."
    case "invalid_note":
      return "Keep this to 280 characters, or leave it blank."
    case "unknown_not_allowed":
      return "This one needs an answer."
    case "exceeds_calls":
      return "This can’t be more than the calls you said come in."
    case "exceeds_missed":
      return "This can’t be more than the unanswered calls."
    case "exceeds_inquiries":
      return "This can’t be more than the inquiries you said you get in a month."
    case "exceeds_week":
      return "These hours add up to more than a week has."
    case "same_as_primary":
      return "Choose something different from the first goal."
    case "invalid_shape":
    case "unknown_question":
    default:
      return "Check this answer and try again."
  }
}

export const METRIC_LABELS: Record<MetricKey, { title: string; help: string }> = {
  inquiry_volume: { title: "New inquiries in a normal month", help: "How many new people ask about work." },
  missed_call_rate: { title: "Calls that go unanswered", help: "The share of incoming calls nobody talks to." },
  first_response_minutes: { title: "Wait for a first reply", help: "How long a new inquiry waits before someone answers." },
  booking_rate: { title: "Inquiries that become bookings", help: "The share of inquiries with a confirmed appointment." },
  cancellations_no_shows: { title: "Cancellations and no-shows", help: "Appointments that do not happen as booked." },
  followup_coverage: { title: "Unbooked inquiries followed up within two days", help: "The share that get a follow-up soon enough to matter." },
  unresolved_leads: { title: "Inquiries still waiting on an outcome", help: "Open inquiries with no booking and no decision." },
  admin_hours: { title: "Hours a week on calls, follow-up, records and scheduling", help: "Time spent on the work around the work." },
}

export const SECTION_REPORT_COPY = {
  response: { title: "Response", blurb: "How much reaches you and how quickly it gets answered." },
  booking: { title: "Booking", blurb: "How many inquiries become appointments that happen." },
  followUp: { title: "Follow-up", blurb: "Whether inquiries that did not book hear back." },
  operatingLoad: { title: "Operating load", blurb: "Time the team spends on admin today." },
} as const

export const EVIDENCE_LABELS: Record<Exclude<EvidenceClass, "derived">, { label: string; detail: string }> = {
  owner_estimate: { label: "Owner estimate", detail: "Your best estimate. Gradia has not measured this." },
  connected_evidence: { label: "Connected", detail: "Counted from a system you connected, over the window shown." },
  gradia_observed: { label: "Observed by Gradia", detail: "Counted from activity Gradia handled, over the window shown." },
  unknown: { label: "Not sure", detail: "You chose “I’m not sure”. Gradia does not guess." },
}

export const NOT_MEASURED_REASONS: Record<MetricReason, string> = {
  input_unknown: "You weren’t sure, so there is nothing to show. Gradia does not fill the gap.",
  input_missing: "Nothing has been recorded for this yet.",
  input_is_range: "You gave a range, so a single rate can’t be worked out. The range is kept as you gave it.",
  zero_denominator: "You reported none to measure against, so a rate can’t be worked out.",
  inconsistent_inputs: "The answers behind this don’t fit together, so Gradia shows nothing rather than a wrong number.",
}

export const READINESS_LABELS = {
  records_system: QUESTION_COPY.records_system.choices!,
  calendar_system: QUESTION_COPY.calendar_system.choices!,
  active_channels: QUESTION_COPY.active_channels.choices!,
}

/** The word shown where a figure would be, so a missing figure never reads as a blank or a zero. */
export const STATE_LABELS = { unknown: "Not sure", not_measured: "Not measured yet" } as const
