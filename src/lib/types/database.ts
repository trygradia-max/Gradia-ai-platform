export type LeadStatus = "new" | "quoted" | "booked"

export type ShopRow = {
  id: string
  name: string
  owner_id: string
  location: string | null
  phone: string | null
  vapi_assistant_id: string | null
  aurinko_account_id: number | null
  aurinko_account_email: string | null
  aurinko_access_token_enc: string | null
  aurinko_subscription_id: string | null
  twilio_phone_number: string | null
  stripe_account_id: string | null
  stripe_charges_enabled: boolean
  settings: Record<string, unknown>
  created_at: string
  updated_at: string
}

export type LeadRow = {
  id: string
  shop_id: string
  customer_id: string | null
  customer_name: string
  phone: string
  car_info: string | null
  pin_notes: string | null
  status: LeadStatus
  created_at: string
  updated_at: string
}

export type CustomerRow = {
  id: string
  shop_id: string
  name: string | null
  phone: string | null
  email: string | null
  instagram_handle: string | null
  facebook_id: string | null
  created_at: string
  updated_at: string
}

export type ServiceRow = {
  id: string
  shop_id: string
  name: string
  description: string | null
  price_cents: number
  duration_minutes: number
  created_at: string
  updated_at: string
}

export type AppointmentRow = {
  id: string
  shop_id: string
  lead_id: string | null
  customer_id: string | null
  scheduled_at: string
  duration_minutes: number | null
  service_name: string | null
  aurinko_calendar_id: string | null
  aurinko_event_id: string | null
  timezone: string | null
  reminder_pending_action_id: string | null
  created_at: string
  updated_at: string
}

export type PendingActionType =
  | "create_lead"
  | "add_note"
  | "book_appointment"
  | "send_sms"
  | "charge_customer"
  | "send_email"

export type PendingActionStatus =
  | "pending"
  | "approved"
  | "edit_requested"
  | "rejected"

export type PendingActionRow = {
  id: string
  shop_id: string
  action_type: PendingActionType
  payload: Record<string, unknown>
  status: PendingActionStatus
  requested_by: string
  decided_at: string | null
  decided_by_slack: string | null
  decided_by_user: string | null
  result_id: string | null
  slack_channel: string | null
  slack_message_ts: string | null
  created_at: string
  updated_at: string
}

export type InteractionChannel =
  | "voice"
  | "sms"
  | "email"
  | "instagram"
  | "facebook"
  | "web"
  | "note"

export type InteractionRole = "customer" | "gradia" | "system"

export type InteractionRow = {
  id: string
  shop_id: string
  customer_id: string | null
  channel: InteractionChannel
  role: InteractionRole
  content: string
  metadata: Record<string, unknown>
  embedding: number[] | null
  embedding_model: string | null
  occurred_at: string
  created_at: string
}

export type MatchedInteraction = {
  id: string
  customer_id: string | null
  channel: InteractionChannel
  role: InteractionRole
  content: string
  metadata: Record<string, unknown>
  occurred_at: string
  similarity: number
}

export type BiMessageRole = "user" | "assistant"

export type BiConversationRow = {
  id: string
  shop_id: string
  owner_id: string
  title: string | null
  created_at: string
  updated_at: string
}

export type BiMessageRow = {
  id: string
  conversation_id: string
  shop_id: string
  role: BiMessageRole
  content: string
  created_at: string
}

export type PaymentRow = {
  id: string
  shop_id: string
  customer_id: string | null
  amount_cents: number
  currency: string
  description: string | null
  stripe_account_id: string | null
  stripe_invoice_id: string
  stripe_invoice_number: string | null
  hosted_invoice_url: string | null
  paid_at: string
  created_at: string
}

/**
 * Shape of the planned agent config Claude produces for custom agents.
 *
 * The descriptive fields are human-readable. The optional `recipe` +
 * `schedule` fields are machine-executable — present when the planner
 * matched the problem to a known recipe. Without them the plan is
 * saved but flagged as not-runnable in the UI.
 */
export type AgentRecipeId =
  | "lead_followup_sms"
  | "appointment_reminder_email"
  | "stale_customer_sms"

export type LeadFollowupSmsParams = {
  status: LeadStatus
  min_lead_age_days: number
  no_inbound_within_days: number
}

export type AppointmentReminderEmailParams = {
  /** Target appointments whose start time is roughly this many hours away. */
  hours_before: number
  /** Half-width of the window around hours_before, in hours. */
  window_hours: number
}

export type StaleCustomerSmsParams = {
  /** Customer last had any interaction at least this many days ago. */
  inactive_days: number
  /** Don't re-message a customer if we already SMS'd them in the last N days. */
  cooldown_days: number
}

export type AgentRecipe =
  | { id: "lead_followup_sms"; params: LeadFollowupSmsParams }
  | {
      id: "appointment_reminder_email"
      params: AppointmentReminderEmailParams
    }
  | { id: "stale_customer_sms"; params: StaleCustomerSmsParams }

export type AgentSchedule = {
  cadence: "hourly" | "daily" | "weekly"
  /** 0-23, defaults to 10 when honored. Used for daily + weekly. */
  hour_of_day?: number
  /** 0-6, Sunday=0. Used for weekly. */
  day_of_week?: number
}

export type AgentConfig = {
  name: string
  short_description: string
  trigger: {
    kind: "schedule" | "event"
    schedule_summary?: string
    event_summary?: string
  }
  audience: {
    entity: "leads" | "customers" | "appointments" | "interactions"
    filters_summary: string[]
  }
  action: {
    kind: "draft_sms" | "draft_email" | "log_note" | "flag_for_review"
    intent_summary: string
  }
  prerequisites_needed: string[]
  human_in_the_loop_note: string
  recipe?: AgentRecipe
  schedule?: AgentSchedule
}

export type CustomAgentRow = {
  id: string
  shop_id: string
  owner_id: string
  name: string
  description: string | null
  problem_text: string
  config: AgentConfig
  enabled: boolean
  last_fired_at: string | null
  created_at: string
  updated_at: string
}
