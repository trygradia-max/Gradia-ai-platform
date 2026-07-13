import { FEATURES } from "@/lib/features"
import { getOptionalShop, requireShop } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import type { ShopRow } from "@/lib/types/database"

export type ChannelId =
  | "voice"
  | "email"
  | "sms"
  | "calendar"
  | "payments"

export type ChannelStatus = "connected" | "partial" | "off"

export type ChannelSummary = {
  id: ChannelId
  label: string
  description: string
  status: ChannelStatus
  /** Short next-step hint shown when status !== "connected". */
  hint: string | null
  /** Where the operator goes to do something about it. */
  href: string
}

export type ChannelProgress = {
  connected: number
  total: number
  /** First "off" channel, useful for "Next: connect X" CTAs. */
  nextLabel: string | null
  /** Deep-link to where the owner connects that next channel. */
  nextHref: string | null
}

/**
 * Lightweight progress count for the layout-level "Setup X/7" pill.
 * Returns null when there's no shop yet (pre-onboarding) so the pill
 * can hide cleanly. Same SELECT as getChannelStatusForCurrentShop —
 * Next.js dedups within a single render so the dashboard page calling
 * both isn't a double round-trip.
 */
export async function getChannelProgressForCurrentShop(): Promise<ChannelProgress | null> {
  const shop = await getOptionalShop()
  if (!shop) return null
  const channels = await getChannelStatusForCurrentShop()
  const connected = channels.filter((c) => c.status === "connected").length
  const firstOff = channels.find((c) => c.status !== "connected")
  return {
    connected,
    total: channels.length,
    nextLabel: firstOff?.label ?? null,
    nextHref: firstOff?.href ?? null,
  }
}

/**
 * Snapshot of every integration's wiring state for the current shop.
 * Drives the dashboard "Connect your channels" widget and is cheap
 * to compute — one SELECT, then derivations.
 */
export async function getChannelStatusForCurrentShop(): Promise<
  ChannelSummary[]
> {
  const shopCtx = await requireShop()
  const supabase = await createClient()
  const { data } = await supabase
    .from("shops")
    .select("*")
    .eq("id", shopCtx.id)
    .single()
  const shop = (data as ShopRow | null) ?? null

  const summaries = [
    voiceSummary(shop),
    emailSummary(shop),
    smsSummary(shop),
    calendarSummary(shop),
  ]
  // Payments (Stripe Connect customer billing) is hidden for the MVP; don't
  // count it toward setup progress or the setup pill would never reach "all live".
  if (FEATURES.integrations.payments) summaries.push(paymentsSummary(shop))
  return summaries
}

function voiceSummary(shop: ShopRow | null): ChannelSummary {
  const connected = Boolean(shop?.vapi_assistant_id)
  return {
    id: "voice",
    label: "Voice receptionist",
    description: "Vapi-powered phone agent that captures leads, quotes services, and books appointments.",
    status: connected ? "connected" : "off",
    hint: connected
      ? null
      : "Paste your Vapi assistant ID + provision a phone number.",
    href: "/settings#voice",
  }
}

function emailSummary(shop: ShopRow | null): ChannelSummary {
  const connected = Boolean(
    shop?.aurinko_access_token_enc && shop?.aurinko_account_id
  )
  return {
    id: "email",
    label: "Email receptionist",
    description: "Gmail inbox piped through Aurinko — every inquiry becomes a drafted reply waiting in your Approvals.",
    status: connected ? "connected" : "off",
    hint: connected ? null : "Connect Gmail via OAuth in Settings.",
    href: "/settings#email",
  }
}

function smsSummary(shop: ShopRow | null): ChannelSummary {
  const connected = Boolean(shop?.twilio_phone_number)
  return {
    id: "sms",
    label: "SMS receptionist",
    description: "Inbound + outbound SMS through Twilio, with delivery-status callbacks.",
    status: connected ? "connected" : "off",
    hint: connected
      ? null
      : "Add your Twilio number + point its webhook at Gradia.",
    href: "/settings#sms",
  }
}

function calendarSummary(shop: ShopRow | null): ChannelSummary {
  // Calendar piggybacks on the Aurinko OAuth — same scope grant, so
  // the deep-link points at the email card.
  const connected = Boolean(
    shop?.aurinko_access_token_enc && shop?.aurinko_account_id
  )
  return {
    id: "calendar",
    label: "Calendar",
    description: "Google Calendar via Aurinko — bookings land here automatically.",
    status: connected ? "connected" : "off",
    hint: connected
      ? null
      : "Connects automatically when you connect Gmail above.",
    href: "/settings#email",
  }
}

function paymentsSummary(shop: ShopRow | null): ChannelSummary {
  if (!shop?.stripe_account_id) {
    return {
      id: "payments",
      label: "Payments",
      description: "Stripe Connect — invoice customers from inside Gradia.",
      status: "off",
      hint: "Finish Stripe Connect onboarding.",
      href: "/settings#payments",
    }
  }
  if (!shop.stripe_charges_enabled) {
    return {
      id: "payments",
      label: "Payments",
      description: "Stripe Connect — invoice customers from inside Gradia.",
      status: "partial",
      hint: "Stripe needs more info before charges can run.",
      href: "/settings#payments",
    }
  }
  return {
    id: "payments",
    label: "Payments",
    description: "Stripe Connect — invoice customers from inside Gradia.",
    status: "connected",
    hint: null,
    href: "/settings#payments",
  }
}

