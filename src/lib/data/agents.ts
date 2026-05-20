import { createClient } from "@/lib/supabase/server"
import { requireShop } from "@/lib/shop"
import type { CustomAgentRow, ShopRow } from "@/lib/types/database"

export type AgentStatus = "active" | "needs_setup" | "off"

export type AgentPrerequisite = {
  label: string
  done: boolean
  ctaHref?: string
  ctaLabel?: string
}

export type Agent = {
  id: string
  name: string
  iconKey:
    | "phone"
    | "mail"
    | "sms"
    | "instagram"
    | "calendar"
    | "billing"
    | "memory"
  oneLiner: string
  description: string
  /** What this agent actively does, bulleted. Helps the operator see the value at a glance. */
  capabilities: string[]
  status: AgentStatus
  prerequisites: AgentPrerequisite[]
}

const SETTINGS = "/settings"

function envHas(name: string): boolean {
  return Boolean(process.env[name]?.trim())
}

function buildAgents(shop: ShopRow): Agent[] {
  const vapiConnected = Boolean(shop.vapi_assistant_id?.trim())
  const aurinkoConnected = Boolean(
    shop.aurinko_account_id && shop.aurinko_access_token_enc
  )
  const twilioConnected = Boolean(shop.twilio_phone_number?.trim())
  const stripeReady = Boolean(
    shop.stripe_account_id && shop.stripe_charges_enabled
  )

  // Server-side env checks for any agent that depends on an env var
  // beyond a shop connection. We only check non-secret presence here;
  // never expose values.
  const anthropicReady = envHas("ANTHROPIC_API_KEY")
  const cronReady = envHas("CRON_SECRET")
  const stripeWebhookReady = envHas("STRIPE_WEBHOOK_SECRET")

  function status(prereqs: AgentPrerequisite[]): AgentStatus {
    const done = prereqs.filter((p) => p.done).length
    if (done === prereqs.length) return "active"
    if (done === 0) return "off"
    return "needs_setup"
  }

  // ---- Voice receptionist ----
  const voicePrereqs: AgentPrerequisite[] = [
    {
      label: "Vapi assistant connected in /settings",
      done: vapiConnected,
      ctaHref: SETTINGS,
      ctaLabel: vapiConnected ? undefined : "Connect Vapi",
    },
    {
      label: "Anthropic key on server (drafter brain)",
      done: anthropicReady,
    },
  ]

  // ---- Email agent ----
  const emailPrereqs: AgentPrerequisite[] = [
    {
      label: "Gmail connected via Aurinko",
      done: aurinkoConnected,
      ctaHref: SETTINGS,
      ctaLabel: aurinkoConnected ? undefined : "Connect Gmail",
    },
    {
      label: "Anthropic key on server (classifier + drafter)",
      done: anthropicReady,
    },
  ]

  // ---- Instagram DM agent ----
  const instagramConnected = Boolean(
    shop.instagram_page_id && shop.instagram_page_access_token_enc
  )
  const metaConfigured =
    envHas("META_APP_SECRET") && envHas("META_WEBHOOK_VERIFY_TOKEN")
  const instagramPrereqs: AgentPrerequisite[] = [
    {
      label: "Instagram Page + access token connected in /settings",
      done: instagramConnected,
      ctaHref: SETTINGS,
      ctaLabel: instagramConnected ? undefined : "Connect Instagram",
    },
    {
      label: "Meta App secret + verify token on server",
      done: metaConfigured,
    },
    {
      label: "Anthropic key on server (classifier)",
      done: anthropicReady,
    },
  ]

  // ---- SMS agent ----
  const smsPrereqs: AgentPrerequisite[] = [
    {
      label: "Twilio number connected in /settings",
      done: twilioConnected,
      ctaHref: SETTINGS,
      ctaLabel: twilioConnected ? undefined : "Connect Twilio",
    },
    {
      label: "Anthropic key on server (classifier + drafter)",
      done: anthropicReady,
    },
  ]

  // ---- Booking agent ----
  const bookingPrereqs: AgentPrerequisite[] = [
    {
      label: "Google Calendar (via Aurinko)",
      done: aurinkoConnected,
      ctaHref: SETTINGS,
      ctaLabel: aurinkoConnected ? undefined : "Connect Gmail + Calendar",
    },
    {
      label: "Twilio number for confirmation + reminder SMS",
      done: twilioConnected,
      ctaHref: SETTINGS,
      ctaLabel: twilioConnected ? undefined : "Connect Twilio",
    },
    {
      label: "Reminder cron secret on server",
      done: cronReady,
    },
  ]

  // ---- Billing agent ----
  const billingPrereqs: AgentPrerequisite[] = [
    {
      label: "Stripe Connect onboarded + charges enabled",
      done: stripeReady,
      ctaHref: SETTINGS,
      ctaLabel: stripeReady ? undefined : "Finish Stripe setup",
    },
    {
      label: "Paid-status webhook secret on server",
      done: stripeWebhookReady,
    },
  ]

  // ---- Memory agent ----
  const memoryPrereqs: AgentPrerequisite[] = [
    {
      label: "Anthropic key on server",
      done: anthropicReady,
    },
    {
      label: "OpenAI key on server (for embeddings)",
      done: envHas("OPENAI_API_KEY"),
    },
  ]

  return [
    {
      id: "voice",
      name: "Voice receptionist",
      iconKey: "phone",
      oneLiner: "Answers calls, books, quotes, remembers every caller.",
      description:
        "When customers call, Gradia picks up as us — knows our service menu, recalls past touchpoints, captures leads, and proposes bookings that route into Slack for our approval.",
      capabilities: [
        "Greets callers as us, in our voice (HUMAN.md)",
        "Quotes services from our live menu — never invents prices",
        "Recalls cross-channel history on connected callers",
        "Proposes bookings + leads through HITL approval",
      ],
      status: status(voicePrereqs),
      prerequisites: voicePrereqs,
    },
    {
      id: "email",
      name: "Email assistant",
      iconKey: "mail",
      oneLiner: "Reads inbound mail, drafts replies, files leads for our approval.",
      description:
        "When someone emails our connected inbox, Gradia classifies the message, drafts a warm reply ready for approval, and stages any lead for the dashboard. We approve before anything sends.",
      capabilities: [
        "Classifies leads vs newsletters / receipts / spam",
        "Drafts a plain-text reply signed as us",
        "Files the lead with vehicle, service, summary",
        "Posts both lead + draft cards to Slack",
      ],
      status: status(emailPrereqs),
      prerequisites: emailPrereqs,
    },
    {
      id: "sms",
      name: "SMS assistant",
      iconKey: "sms",
      oneLiner: "Catches every text, drafts a reply within a minute, drops nothing.",
      description:
        "Inbound texts hit our Twilio number, get classified, and turn into approval cards in Slack — both the lead and our draft response. Status callbacks tell us whether the customer actually received our outbound texts.",
      capabilities: [
        "Distinguishes new inquiries from one-word follow-ups",
        "Drafts a short reply signed as us",
        "Confirms deliveries via Twilio callbacks",
        "Quick Reply UI on /approvals/[id] for direct sends",
      ],
      status: status(smsPrereqs),
      prerequisites: smsPrereqs,
    },
    {
      id: "instagram",
      name: "Instagram DM agent",
      iconKey: "instagram",
      oneLiner: "Catches inbound DMs as they land, files leads for our review.",
      description:
        "When customers slide into our IG DMs, Gradia classifies the message, flags real inquiries with the cross-channel context we have, and stages them as approval cards. Outbound DM replies are queued for a follow-up build.",
      capabilities: [
        "Verifies Meta's X-Hub-Signature-256 on every webhook delivery",
        "Skips echoes — outbound copies of our own DMs don't loop back as leads",
        "Records every DM in the shared memory layer (channel=instagram)",
        "Dedups customers by their page-scoped IG sender id",
      ],
      status: status(instagramPrereqs),
      prerequisites: instagramPrereqs,
    },
    {
      id: "booking",
      name: "Booking agent",
      iconKey: "calendar",
      oneLiner: "Books appointments to our calendar + texts confirmations and reminders.",
      description:
        "When voice/email/SMS captures a real time, this agent stages a booking proposal. On approve, the calendar event lands, the customer gets a confirmation text, and an hourly cron stages a 24h reminder draft for our approval.",
      capabilities: [
        "Creates real Google Calendar events on approval",
        "Drafts a booking confirmation SMS for our approval",
        "Hourly cron stages a 24h reminder before the slot",
        "Honors HITL — every customer-facing message gets reviewed",
      ],
      status: status(bookingPrereqs),
      prerequisites: bookingPrereqs,
    },
    {
      id: "billing",
      name: "Billing agent",
      iconKey: "billing",
      oneLiner: "Voice command to invoice — \"charge Smith $450 for ceramic.\"",
      description:
        "Tap Whisper, say \"charge Smith $450 for ceramic.\" Gradia parses it, drops a charge card in Slack with the customer's email pre-filled, and on approve Stripe emails them a hosted-payment link. Paid-status webhooks update our dashboard tiles automatically.",
      capabilities: [
        "Parses Whisper intent: customer, amount, service",
        "Sends Stripe invoice on our connected account on approve",
        "Mirrors paid invoices into our DB for instant revenue queries",
        "Posts \"Paid · Smith · $450\" notice when funds land",
      ],
      status: status(billingPrereqs),
      prerequisites: billingPrereqs,
    },
    {
      id: "memory",
      name: "Memory & insights",
      iconKey: "memory",
      oneLiner: "Every touchpoint, every channel, all searchable. Ask us anything.",
      description:
        "Voice, email, SMS, and Whisper notes all flow into one embedded memory layer. Ask Gradia in plain English at /chat — counts, schedules, who asked about ceramic, revenue this month. Streams answers back as we work.",
      capabilities: [
        "pgvector RAG over every customer touchpoint",
        "BI chat with six read-only tools (counts, revenue, etc.)",
        "Cross-channel sync hints on every Slack approval card",
        "Customer detail timeline merges every channel into one view",
      ],
      status: status(memoryPrereqs),
      prerequisites: memoryPrereqs,
    },
  ]
}

export async function getAgentsForCurrentShop(): Promise<Agent[]> {
  const shopCtx = await requireShop()
  const supabase = await createClient()
  const { data } = await supabase
    .from("shops")
    .select("*")
    .eq("id", shopCtx.id)
    .single()
  const shop = data as ShopRow | null
  if (!shop) return []
  return buildAgents(shop)
}

export async function listCustomAgentsForCurrentShop(): Promise<
  CustomAgentRow[]
> {
  const shop = await requireShop()
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("custom_agents")
    .select("*")
    .eq("shop_id", shop.id)
    .order("updated_at", { ascending: false })
  if (error) throw new Error(error.message)
  return (data as CustomAgentRow[] | null) ?? []
}
