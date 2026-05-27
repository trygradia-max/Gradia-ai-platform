/**
 * Single source of truth for marketing content. Everything here is
 * grounded in the real product (src/lib/data/agents.ts, PROJECT_BRIEF.md).
 * No invented capabilities, no invented pricing.
 */

export const SITE = {
  name: "Gradia",
  domain: "trygradia.com",
  tagline: "The AI office for auto detailers.",
  description:
    "Gradia answers the phone, works the inbox, and texts leads back — then drops every reply, quote, and invoice in front of you to approve. The front desk that runs while your hands are wet. $20/month.",
  // The product app lives elsewhere; marketing CTAs point at its login.
  appUrl: "https://app.trygradia.com/login",
  price: 20,
}

export type IconKey =
  | "phone"
  | "mail"
  | "sms"
  | "instagram"
  | "calendar"
  | "billing"
  | "memory"

/**
 * The seven core agents, mirrored from src/lib/data/agents.ts.
 * `accent` keys a per-agent tile color so the feature grid reads like
 * the app's channel grid.
 */
export type AgentDef = {
  slug: string
  name: string
  iconKey: IconKey
  stack: string
  oneLiner: string
  description: string
  capabilities: string[]
  /** Atmospheric asset shown on the agent's docs/feature surface. */
  image?: string
}

export const AGENTS: AgentDef[] = [
  {
    slug: "voice",
    name: "Voice receptionist",
    iconKey: "phone",
    stack: "Vapi",
    oneLiner: "Answers calls, books, quotes, remembers every caller.",
    description:
      "When customers call, Gradia picks up as us — knows the service menu, recalls past touchpoints, captures the lead, and proposes a booking that routes into Slack for approval. Even when you're under a car.",
    capabilities: [
      "Greets callers in your shop's voice",
      "Quotes services from your live menu — never invents prices",
      "Recalls cross-channel history on connected callers",
      "Proposes bookings and leads through HITL approval",
    ],
    image: "/assets/images/feature-voice.jpg",
  },
  {
    slug: "email",
    name: "Email assistant",
    iconKey: "mail",
    stack: "Gmail · Aurinko",
    oneLiner: "Reads inbound mail, drafts replies, files leads for approval.",
    description:
      "Every inbound email is classified, a warm on-brand reply is drafted, and any lead is staged with vehicle, service, and a summary. Nothing sends until you approve it.",
    capabilities: [
      "Classifies leads vs. newsletters, receipts, and spam",
      "Drafts a plain-text reply signed as your shop",
      "Files the lead with vehicle, service, and summary",
      "Posts both lead and draft cards to Slack",
    ],
    image: "/assets/images/feature-email.jpg",
  },
  {
    slug: "sms",
    name: "SMS assistant",
    iconKey: "sms",
    stack: "Twilio",
    oneLiner: "Catches every text, drafts a reply in a minute, drops nothing.",
    description:
      "Inbound texts hit your Twilio number, get classified, and become approval cards in Slack — both the lead and your draft. Delivery callbacks confirm the customer actually received your outbound texts.",
    capabilities: [
      "Distinguishes new inquiries from one-word follow-ups",
      "Drafts a short reply signed as your shop",
      "Confirms deliveries via Twilio status callbacks",
      "Quick-reply UI for direct sends from the approval queue",
    ],
    image: "/assets/images/feature-sms.jpg",
  },
  {
    slug: "instagram",
    name: "Instagram DM agent",
    iconKey: "instagram",
    stack: "Meta",
    oneLiner: "Catches inbound DMs as they land, files leads for review.",
    description:
      "When customers slide into your IG DMs, Gradia classifies the message, flags real inquiries with the cross-channel context it already has, and stages them as approval cards.",
    capabilities: [
      "Verifies Meta's X-Hub-Signature-256 on every webhook delivery",
      "Skips echoes so your own outbound DMs don't loop back as leads",
      "Records every DM in the shared memory layer",
      "Dedupes customers by their page-scoped sender id",
    ],
    image: "/assets/images/feature-instagram.jpg",
  },
  {
    slug: "booking",
    name: "Booking agent",
    iconKey: "calendar",
    stack: "Google Calendar · Twilio",
    oneLiner: "Books to your calendar, then texts confirmations and reminders.",
    description:
      "When any channel captures a real time, this agent stages a booking proposal. On approve, the calendar event lands, the customer gets a confirmation text, and an hourly cron stages a 24-hour reminder for your approval.",
    capabilities: [
      "Creates real Google Calendar events on approval",
      "Drafts a booking confirmation SMS for your approval",
      "Hourly cron stages a 24-hour reminder before the slot",
      "Every customer-facing message gets reviewed first",
    ],
    image: "/assets/images/feature-booking.jpg",
  },
  {
    slug: "billing",
    name: "Billing agent",
    iconKey: "billing",
    stack: "Stripe Connect · Whisper",
    oneLiner: 'Voice command to invoice — "charge Smith $450 for ceramic."',
    description:
      'Tap Whisper, say "charge Smith $450 for ceramic." Gradia parses it, drops a charge card in Slack with the customer\'s email pre-filled, and on approve Stripe emails a hosted payment link. Paid-status webhooks update your revenue tiles automatically.',
    capabilities: [
      "Parses Whisper intent: customer, amount, service",
      "Sends a Stripe invoice on your connected account",
      "Mirrors paid invoices for instant revenue queries",
      'Posts a "Paid · Smith · $450" notice when funds land',
    ],
    image: "/assets/images/feature-interior.jpg",
  },
  {
    slug: "memory",
    name: "Memory & insights",
    iconKey: "memory",
    stack: "pgvector · Ask Gradia",
    oneLiner: "Every touchpoint, every channel, all searchable. Ask anything.",
    description:
      "Voice, email, SMS, and Whisper notes all flow into one embedded memory layer. Ask Gradia in plain English — counts, schedules, who asked about ceramic, revenue this month — and answers stream back as you work.",
    capabilities: [
      "pgvector RAG over every customer touchpoint",
      "Plain-English BI chat with read-only tools",
      "Cross-channel sync hints on every approval card",
      "One timeline that merges every channel per customer",
    ],
    image: "/assets/images/feature-detail.jpg",
  },
]

export const NAV = [
  { label: "Product", href: "/#agents" },
  { label: "How it works", href: "/#how" },
  { label: "Pricing", href: "/pricing" },
  { label: "Docs", href: "/docs" },
  { label: "Blog", href: "/blog" },
]

/** Headline stats for the social-proof band — framed honestly. */
export const STATS: { value: number; suffix: string; label: string }[] = [
  { value: 6, suffix: "", label: "channels, one shared brain" },
  { value: 7, suffix: "", label: "agents working your front office" },
  { value: 20, suffix: "$", label: "per month, per user" },
  { value: 1, suffix: "-tap", label: "approval on everything outbound" },
]
