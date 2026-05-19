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
