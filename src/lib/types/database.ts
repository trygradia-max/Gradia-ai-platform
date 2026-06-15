export type LeadStatus = "new" | "quoted" | "booked"

export type ShopPlan = "free" | "active" | "past_due"

export type ShopRow = {
  id: string
  name: string
  owner_id: string
  location: string | null
  phone: string | null
  vapi_assistant_id: string | null
  aurinko_account_id: number | null
  aurinko_token_expires_at: string | null
  aurinko_account_email: string | null
  aurinko_access_token_enc: string | null
  aurinko_subscription_id: string | null
  twilio_phone_number: string | null
  twilio_account_sid_enc: string | null
  twilio_auth_token_enc: string | null
  twilio_subaccount_sid: string | null
  twilio_subaccount_token_enc: string | null
  gradia_number_e164: string | null
  gradia_number_sid: string | null
  a2p_status: A2pStatus
  voice_addon: boolean
  voice_addon_ended_at: string | null
  voice_config: VoiceConfig
  voice_live: boolean
  voice_test_called_at: string | null
  vapi_phone_number_id: string | null
  vapi_stale: boolean
  vapi_server_secret_enc: string | null
  voice_minutes_budget: number | null
  stripe_account_id: string | null
  stripe_charges_enabled: boolean
  plan: ShopPlan
  stripe_subscription_id: string | null
  credit_limit: number
  credit_period_start: string
  jobber_account_id: string | null
  jobber_account_name: string | null
  jobber_access_token_enc: string | null
  jobber_refresh_token_enc: string | null
  jobber_token_expires_at: string | null
  housecallpro_account_id: string | null
  housecallpro_account_name: string | null
  housecallpro_access_token_enc: string | null
  housecallpro_refresh_token_enc: string | null
  housecallpro_token_expires_at: string | null
  settings: Record<string, unknown>
  created_at: string
  updated_at: string
}

export type A2pStatus = "unregistered" | "pending" | "approved" | "rejected"

/**
 * Voice receptionist builder form answers (guardrailed form — never a
 * prompt editor). The system prompt is composed server-side from
 * persona.ts + KB + services + this config.
 */
export type VoiceConfig = {
  greeting?: string | null
  tone?: "warm" | "professional" | "playful" | null
  voice?: string | null
  /** After-hours behavior: read a message, or take a message (lead capture). */
  after_hours?: "message_only" | "take_message" | null
  hours_text?: string | null
  /** Booking rule: stage propose_booking approvals, or read out a link. */
  booking_mode?: "propose_booking" | "calendar_link" | null
  calendar_link?: string | null
  /** Transfer-to-human number for escalations. */
  escalation_phone?: string | null
}

export type A2pRegistrationStatus =
  | "draft"
  | "brand_pending"
  | "campaign_pending"
  | "approved"
  | "rejected"

/** Owner-submitted compliance details, kept verbatim for resubmission.
 *  has_ein forks the carrier path: true → Low-Volume Standard;
 *  false → SOLE_PROPRIETOR (no tax ID; mobile_phone gets the OTP text). */
export type A2pBusinessDetails = {
  has_ein?: boolean
  legal_name: string
  ein: string | null
  mobile_phone?: string | null
  business_type: string
  website_url: string | null
  address: {
    street: string
    city: string
    region: string
    postal_code: string
  }
  contact: {
    first_name: string
    last_name: string
    email: string
    phone: string
    job_position: string
  }
}

export type A2pRegistrationRow = {
  id: string
  shop_id: string
  status: A2pRegistrationStatus
  business: A2pBusinessDetails
  customer_profile_sid: string | null
  trust_product_sid: string | null
  brand_sid: string | null
  messaging_service_sid: string | null
  campaign_sid: string | null
  failure_reason: string | null
  created_at: string
  updated_at: string
}

export type UsageEventKind =
  | "agent_run" // legacy rows only — new writers use the menu kinds below
  | "message" // legacy rows only
  | "voice_minute"
  | "sms_segment"
  | "number_monthly"
  | "email_send"
  | "outreach_draft"
  | "bi_answer"
  | "whisper_note"
  | "agentic_plan"

export type UsageEventRow = {
  id: string
  shop_id: string
  kind: UsageEventKind
  quantity: number
  credits: number
  /** Vendor cost in cents (what Gradia pays). Null on legacy/LLM-only rows. */
  wholesale_cost: number | null
  /** Shop-facing cost in cents (what the shop pays). Null on legacy rows. */
  retail_cost: number | null
  /** Twilio/Vapi record id for nightly reconciliation. */
  vendor_ref: string | null
  ref_id: string | null
  created_at: string
}

export type PricingKey =
  | "number_monthly"
  | "voice_minute"
  | "sms_segment"
  | "email_send"
  | "outreach_draft"
  | "bi_answer"
  | "whisper_note"
  | "agentic_plan"

export type CreditGrantKind = "credit_pack" | "minute_pack" | "rollover"

export type CreditGrantRow = {
  id: string
  shop_id: string
  kind: CreditGrantKind
  credits: number
  minutes: number
  stripe_ref: string | null
  created_at: string
}

export type PricingConfigRow = {
  key: PricingKey
  wholesale_cents: number
  retail_cents: number
  note: string | null
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
  jobber_client_id: string | null
  housecallpro_customer_id: string | null
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
  jobber_request_id: string | null
  housecallpro_job_id: string | null
  created_at: string
  updated_at: string
}

export type PendingActionType =
  | "create_lead"
  | "add_note"
  | "book_appointment"
  | "reschedule_appointment"
  | "cancel_appointment"
  | "send_sms"
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

export type McpTokenRow = {
  id: string
  shop_id: string
  name: string
  token_hash: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
  requests_today: number
  usage_date: string
}

export type ShopKnowledgeRow = {
  id: string
  shop_id: string
  source_name: string
  content: string
  created_at: string
  updated_at: string
}

export type ShopKnowledgeMatch = {
  id: string
  source_name: string
  content: string
  similarity: number
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
  refunded_amount_cents: number
  refunded_at: string | null
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
  | "appointment_reminder_sms"
  | "stale_customer_sms"
  | "payment_received_thank_you_sms"
  | "booking_approved_prep_email"

/** Events that can fire event-driven custom agents. */
export type AgentEventKind = "payment_received" | "booking_approved"

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

/** Same window shape as the email variant — the channel differs. */
export type AppointmentReminderSmsParams = AppointmentReminderEmailParams

export type StaleCustomerSmsParams = {
  /** Customer last had any interaction at least this many days ago. */
  inactive_days: number
  /** Don't re-message a customer if we already SMS'd them in the last N days. */
  cooldown_days: number
}

/** No filter params today — params kept for future extension (delay,
 *  minimum amount threshold, etc.) */
export type PaymentReceivedParams = Record<string, never>

/** Same — empty params, future-proof shape. */
export type BookingApprovedParams = Record<string, never>

export type AgentRecipe =
  | { id: "lead_followup_sms"; params: LeadFollowupSmsParams }
  | {
      id: "appointment_reminder_email"
      params: AppointmentReminderEmailParams
    }
  | {
      id: "appointment_reminder_sms"
      params: AppointmentReminderSmsParams
    }
  | { id: "stale_customer_sms"; params: StaleCustomerSmsParams }
  | {
      id: "payment_received_thank_you_sms"
      params: PaymentReceivedParams
    }
  | { id: "booking_approved_prep_email"; params: BookingApprovedParams }

export type AgentSchedule = {
  cadence: "hourly" | "daily" | "weekly"
  /** 0-23, defaults to 10 when honored. Used for daily + weekly. */
  hour_of_day?: number
  /** 0-6, Sunday=0. Used for weekly. */
  day_of_week?: number
}

export type FreeformAudienceEntity = "leads" | "customers"

export type FreeformChannel = "sms" | "email"

/**
 * Safe, whitelisted audience filter for free-form outreach — never raw SQL.
 * The resolver maps each field to a constrained Supabase query, so the
 * free-form planner can target an audience without ever executing operator
 * (or model) supplied query text.
 */
export type FreeformFilters = {
  /** leads only: target lead status */
  lead_status?: LeadStatus
  /** record created at least this many days ago */
  min_age_days?: number
  /** record created at most this many days ago */
  max_age_days?: number
  /** skip targets the customer contacted us within the last N days */
  no_inbound_within_days?: number
  /** customers only: last interaction at least this many days ago */
  inactive_days?: number
  /** case-insensitive keyword matched against name / vehicle / notes */
  keyword?: string
}

export type FreeformPlan = {
  entity: FreeformAudienceEntity
  channel: FreeformChannel
  filters: FreeformFilters
  /** plain-English message intent; drafted per recipient in we/us voice */
  message_intent: string
  /** hard cap on recipients per run (owner-configurable; default 50) */
  max_recipients: number
  /** don't re-contact the same recipient within this many days */
  cooldown_days: number
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
  freeform?: FreeformPlan
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

export type CustomAgentRunRow = {
  id: string
  agent_id: string
  shop_id: string
  /** "manual" | "schedule" | "event:payment_received" | "event:booking_approved" */
  trigger_source: string
  fired: boolean
  reason: string | null
  stats: Record<string, number> | null
  pending_action_ids: string[]
  created_at: string
}
