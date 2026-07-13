export type LeadStatus = "new" | "quoted" | "booked"

/** Lead-revival funnel — orthogonal to LeadStatus (the sales funnel). */
export type LeadLifecycle = "unresponsive_stale" | "revival_contacted" | "recovered"

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
  byo_sms_verified: boolean
  timezone: string
  quiet_hours_start: number
  quiet_hours_end: number
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
  /** Shadow Mode: when true the agent computes/logs but stages nothing for real send. */
  simulation_mode: boolean
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
  /** Structured vehicle (CRM C1) — only present once the C1 migration is
   *  applied, so writers link it best-effort AFTER insert, never inside one. */
  vehicle_id: string | null
  /** @deprecated Write-through only (CRM C1): keep writing so pre-migration
   *  DBs and the C1 backfill stay correct; read through lib/vehicles.ts. */
  vehicle_make: string | null
  /** @deprecated Write-through only — see vehicle_make. */
  vehicle_model: string | null
  /** @deprecated Write-through only — see vehicle_make. */
  vehicle_year: number | null
  /** @deprecated Write-through only — see vehicle_make. */
  vehicle_color: string | null
  pin_notes: string | null
  status: LeadStatus
  /** Revival pipeline state; null = not in the revival funnel. */
  lifecycle_status: LeadLifecycle | null
  created_at: string
  updated_at: string
}

export type CustomerRow = {
  id: string
  shop_id: string
  name: string | null
  phone: string | null
  email: string | null
  /** @deprecated Write-through only (CRM C1): vehicles live in the
   *  `vehicles` table; keep writing these until the drop migration lands so
   *  pre-migration DBs and the C1 backfill stay correct. Read through
   *  lib/vehicles.ts. */
  vehicle_make: string | null
  /** @deprecated Write-through only — see vehicle_make. */
  vehicle_model: string | null
  /** @deprecated Write-through only — see vehicle_make. */
  vehicle_year: number | null
  /** @deprecated Write-through only — see vehicle_make. */
  vehicle_color: string | null
  last_visit_at: string | null
  marketing_consent_at: string | null
  marketing_consent_source: string | null
  sms_opted_out_at: string | null
  /** How the record was first found: import, inbound_sms, voice, manual, … */
  source: string | null
  /** Best evidence of the last real transaction — drives the 18-mo EBR window. */
  last_transaction_at: string | null
  /** Owner's manual, immediate, all-channel block. */
  do_not_contact: boolean
  jobber_client_id: string | null
  housecallpro_customer_id: string | null
  created_at: string
  updated_at: string
}

export type ImportSourceType =
  | "mbox"
  | "contacts_csv"
  | "vcard"
  | "gradia_history"
  /** C7 structured-CSV wizard — enum value lands with migration
   *  20260708150000_structured_csv_source.sql (founder-applied). */
  | "structured_csv"

export type ImportJobStatus =
  | "pending"
  | "parsing"
  | "estimating"
  | "extracting"
  | "ready"
  | "failed"

export type ImportJobRow = {
  id: string
  shop_id: string
  source_type: ImportSourceType
  file_ref: string | null
  status: ImportJobStatus
  counts: Record<string, number>
  error: string | null
  estimated_credits: number | null
  created_at: string
  updated_at: string
}

export type ImportMessageRow = {
  id: string
  import_job_id: string
  shop_id: string
  message_id: string | null
  from_email: string | null
  subject: string | null
  body_ref: string | null
  has_list_unsubscribe: boolean
  owner_participated: boolean
  kept: boolean
  drop_reason: string | null
  extraction: Record<string, unknown> | null
  created_at: string
}

/** A condition multiplier entry in services.condition_multipliers (jsonb). */
export type ConditionMultiplier = {
  key: string
  label?: string
  multiplier: number
}

export type ServiceRow = {
  id: string
  shop_id: string
  name: string
  description: string | null
  /** Flat price — the locked fallback when no size-class price applies. */
  price_cents: number
  duration_minutes: number
  /** Size-class pricing (CRM C1). jsonb → validated at read time by
   *  lib/service-pricing.ts — never read these maps directly. */
  category: string | null
  base_price_by_size: Record<string, unknown> | null
  duration_by_size: Record<string, unknown> | null
  condition_multipliers: ConditionMultiplier[] | null
  is_addon: boolean
  addon_eligible: boolean
  mobile_eligible: boolean
  active: boolean
  created_at: string
  updated_at: string
}

export type VehicleSizeClass =
  | "sedan"
  | "coupe"
  | "truck_suv"
  | "xl_van"
  | "exotic"
  | "rv"
  | "boat"
  | "motorcycle"

/** First-class vehicle profile (CRM C1) — one customer, many vehicles. */
export type VehicleRow = {
  id: string
  shop_id: string
  customer_id: string
  year: number | null
  make: string | null
  model: string | null
  trim: string | null
  color: string | null
  size_class: VehicleSizeClass | null
  plate: string | null
  vin: string | null
  photos: string[]
  paint_condition: number | null
  paint_condition_note: string | null
  interior_condition: number | null
  interior_condition_note: string | null
  coating: Record<string, unknown> | null
  ppf: Record<string, unknown> | null
  tint: Record<string, unknown> | null
  maintenance_schedule: unknown[]
  notes: string | null
  import_job_id: string | null
  created_at: string
  updated_at: string
}

export type QuoteStatus =
  | "draft"
  | "sent"
  | "viewed"
  | "accepted"
  | "declined"
  | "expired"

export type QuoteLineItem = {
  service_id: string | null
  name?: string
  qty?: number
  base_cents: number
  modifiers?: string[]
  price_cents: number
}

/** The money object (CRM C1). Agent-created quotes are ALWAYS draft. */
export type QuoteRow = {
  id: string
  shop_id: string
  customer_id: string
  vehicle_id: string | null
  lead_id: string | null
  status: QuoteStatus
  line_items: QuoteLineItem[]
  subtotal_cents: number
  discount_cents: number
  total_cents: number
  is_range: boolean
  range_low_cents: number | null
  range_high_cents: number | null
  customer_note: string | null
  internal_note: string | null
  photos: string[]
  valid_until: string | null
  sent_via: string | null
  sent_at: string | null
  viewed_at: string | null
  responded_at: string | null
  created_by: "owner" | "agent" | "whisper"
  public_token: string | null
  created_at: string
  updated_at: string
}

/** CRM C1 pipeline stage (crm_stage enum) — the pipeline card's source of
 *  truth once C2 ships; C7 imports map spreadsheet stage values onto it. */
export type CrmStage =
  | "new"
  | "needs_quote"
  | "quote_sent"
  | "follow_up"
  | "booked"
  | "lost"

/** CRM C1 customer lifecycle — derived nightly by code (lib/lifecycle.ts),
 *  never by a model. Column exists once the C1 migration is applied. */
export type CustomerLifecycle =
  | "lead"
  | "active"
  | "maintenance"
  | "at_risk"
  | "lapsed"
  | "won_back"

/** CRM C1/C5 — automation catalog mode. */
export type AutomationMode = "approval" | "autopilot"

export type AutomationRow = {
  id: string
  shop_id: string
  catalog_key: string
  enabled: boolean
  mode: AutomationMode
  template_overrides: Record<string, unknown>
  config: Record<string, unknown>
  created_at: string
  updated_at: string
}

export type AutomationRunStatus =
  | "staged"
  | "approved"
  | "sent"
  | "dismissed"
  | "failed"

export type JobStatus =
  | "booked"
  | "confirmed"
  | "checked_in"
  | "in_progress"
  | "on_hold"
  | "completed"
  | "paid"
  | "closed"

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
  /** Set when the customer confirmed (replied YES) — no-show ladder (NEXT-2). */
  confirmed_at: string | null
  /** Idempotency stamp for the confirm-by-text cron. */
  confirm_pending_action_id: string | null
  /** No-show ladder rung: 0 none → 1 confirm sent → 2 reminder → 3 owner alert. */
  escalation_level: number
  jobber_request_id: string | null
  housecallpro_job_id: string | null
  /** CRM C1 job columns — present only once the C1 migration is applied;
   *  writers use best-effort updates (tolerance pattern). */
  vehicle_id?: string | null
  quote_id?: string | null
  status?: JobStatus | null
  hold_reason?: JobHoldReason | null
  ends_at?: string | null
  location_type?: JobLocationType
  address?: Record<string, unknown> | null
  travel_fee_cents?: number | null
  /** {water, power, gate, parking, bay?} — bay is the shop-lane label. */
  access_notes?: Record<string, unknown> | null
  weather_flag?: boolean
  service_ids?: string[]
  quoted_amount_cents?: number | null
  payment_status?: JobPaymentStatus
  photos_before?: string[]
  photos_after?: string[]
  key_tag?: string | null
  internal_note?: string | null
  created_at: string
  updated_at: string
}

export type JobHoldReason = "customer" | "weather" | "parts" | "payment"
export type JobLocationType = "shop" | "mobile"
export type JobPaymentStatus = "unpaid" | "deposit" | "paid"

/**
 * Found Money Ledger — one durable snapshot per ROI-receipt period.
 * Money in cents (house convention). Upserted on (shop_id, period_start, period_end).
 */
export type ShopMetricsRow = {
  id: string
  shop_id: string
  period_start: string
  period_end: string
  attributed_revenue_cents: number
  recovered_leads_count: number
  leads_count: number
  messages_count: number
  bookings_count: number
  created_at: string
}

export type PendingActionType =
  | "create_lead"
  | "add_note"
  | "book_appointment"
  | "reschedule_appointment"
  | "cancel_appointment"
  | "send_sms"
  | "send_email"
  /** C3: agent-proposed quote — approve creates a DRAFT quote, never sends. */
  | "create_quote"

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
  | "review_request_sms"
  | "review_request_email"

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

/** Post-job review ask. No filter params — the ask is identical for everyone
 *  (FTC: no sentiment-gating), so there is nothing to tune per recipient. */
export type ReviewRequestParams = Record<string, never>

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
  | { id: "review_request_sms"; params: ReviewRequestParams }
  | { id: "review_request_email"; params: ReviewRequestParams }

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
  /** structured vehicle make, e.g. "Tesla" (case-insensitive exact) */
  vehicle_make?: string
  /** structured vehicle model substring, e.g. "Model 3" */
  vehicle_model?: string
  /** vehicle model year at least this */
  vehicle_year_min?: number
  /** vehicle model year at most this */
  vehicle_year_max?: number
  /** customers only: no booked visit in at least this many days (or never) */
  not_visited_in_days?: number
  /** customers only: the recovered_customers segment — only customers brought
   *  in by an import (source='import'). Activates the TCPA win-back gate. */
  recovered_only?: boolean
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

/** Glass Box (spec §8-A6a): the per-call artifact from Vapi's end-of-call
 *  report, one row per call. vendor_cost is display data, never billing. */
export type CallRecordRow = {
  id: string
  shop_id: string
  customer_id: string | null
  vapi_call_id: string
  summary: string | null
  ended_reason: string | null
  recording_url: string | null
  duration_seconds: number | null
  vendor_cost: number | null
  started_at: string | null
  ended_at: string | null
  created_at: string
}

/** Glass Box (spec §8-A6b): WHY a pending_action was staged — the "because"
 *  line. Written best-effort at staging time; rendered only where it exists. */
export type ActionDecisionRow = {
  id: string
  shop_id: string
  pending_action_id: string
  source: string
  because: string
  inputs: Record<string, unknown>
  created_at: string
}
