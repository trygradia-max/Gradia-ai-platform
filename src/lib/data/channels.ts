import { cache } from "react"

import { connectionStatus, type ConnectionShopFields } from "@/lib/data/connections"
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
 * to compute — one SELECT, then derivations. Memoized per request
 * (PERF-001): Home, the setup pill and the welcome card all ask.
 */
export const getChannelStatusForCurrentShop = cache(
  async (): Promise<ChannelSummary[]> => {
    const shopCtx = await requireShop()
    const supabase = await createClient()
    const { data } = await supabase
      .from("shops")
      .select("*")
      .eq("id", shopCtx.id)
      .single()
    const shop = (data as ShopRow | null) ?? null
    return summarizeChannels(shop)
  }
)

/**
 * Pure derivation from a shop row — exported so the Home/Settings parity test
 * can prove both surfaces read the same truth (UX-001). Every "connected"
 * here comes from `connectionStatus()`; nothing in this module keeps its own
 * predicate. Copy is owner-facing (Home): product names owners know (Gmail,
 * Google Calendar), no vendor plumbing.
 */
export function summarizeChannels(
  shop: (ConnectionShopFields & Partial<Pick<ShopRow, "stripe_account_id" | "stripe_charges_enabled">>) | null
): ChannelSummary[] {
  const status = connectionStatus(shop)
  const summaries = [
    voiceSummary(status.voice.connected),
    emailSummary(status.email.connected),
    smsSummary(status.sms.connected),
    calendarSummary(status.calendar.connected),
  ]
  // Payments (Stripe Connect customer billing) is hidden for the MVP; don't
  // count it toward setup progress or the setup pill would never reach "all live".
  if (FEATURES.integrations.payments) summaries.push(paymentsSummary(shop))
  return summaries
}

function voiceSummary(connected: boolean): ChannelSummary {
  return {
    id: "voice",
    label: "Voice receptionist",
    description: "Answers calls, quotes from your menu, and proposes bookings.",
    status: connected ? "connected" : "off",
    hint: connected ? null : "Build your receptionist and connect a number in Settings.",
    href: "/settings#voice",
  }
}

function emailSummary(connected: boolean): ChannelSummary {
  return {
    id: "email",
    label: "Email receptionist",
    description: "Reads your inbox — every inquiry becomes a drafted reply waiting in Approvals.",
    status: connected ? "connected" : "off",
    hint: connected ? null : "Connect Gmail in Settings.",
    href: "/settings#email",
  }
}

function smsSummary(connected: boolean): ChannelSummary {
  return {
    id: "sms",
    label: "SMS receptionist",
    description: "Catches texts to your business number and drafts replies.",
    status: connected ? "connected" : "off",
    hint: connected ? null : "Pick a business number in Settings.",
    href: "/settings#sms",
  }
}

function calendarSummary(connected: boolean): ChannelSummary {
  // Calendar shares the Gmail grant — same scope, one connection — so the
  // deep-link points at the email card.
  return {
    id: "calendar",
    label: "Calendar",
    description: "Google Calendar — approved bookings land here automatically.",
    status: connected ? "connected" : "off",
    hint: connected ? null : "Connects automatically when you connect Gmail.",
    href: "/settings#email",
  }
}

function paymentsSummary(
  shop: Partial<Pick<ShopRow, "stripe_account_id" | "stripe_charges_enabled">> | null
): ChannelSummary {
  if (!shop?.stripe_account_id) {
    return {
      id: "payments",
      label: "Payments",
      description: "Invoice customers from inside Gradia.",
      status: "off",
      hint: "Finish payments onboarding.",
      href: "/settings#payments",
    }
  }
  if (!shop.stripe_charges_enabled) {
    return {
      id: "payments",
      label: "Payments",
      description: "Invoice customers from inside Gradia.",
      status: "partial",
      hint: "A few more details are needed before charges can run.",
      href: "/settings#payments",
    }
  }
  return {
    id: "payments",
    label: "Payments",
    description: "Invoice customers from inside Gradia.",
    status: "connected",
    hint: null,
    href: "/settings#payments",
  }
}
