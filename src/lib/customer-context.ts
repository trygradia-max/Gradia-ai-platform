/**
 * Cross-channel context helper for HITL approval cards.
 *
 * When a new lead/booking lands via channel X, the approver wants a
 * one-line heads-up if the same customer was active on a different
 * channel recently: "Also emailed 2 hours ago and texted yesterday."
 *
 * Built on the existing `recentChannelActivity` primitive in
 * lib/memory.ts. Caps at the most recent two distinct channels to
 * keep the Slack card readable.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import { recentChannelActivity } from "@/lib/memory"
import type { InteractionChannel } from "@/lib/types/database"

const WINDOW_MINUTES = 60 * 24 * 3 // 3 days

const CHANNEL_VERB: Record<InteractionChannel, string> = {
  voice: "called",
  sms: "texted",
  email: "emailed",
  web: "reached out on our site",
  note: "left a note",
}

function relative(iso: string): string {
  const then = new Date(iso).getTime()
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (seconds < 60) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days === 1) return "yesterday"
  return `${days} days ago`
}

/**
 * Returns a single human-readable string ("Also emailed 2h ago and
 * called yesterday") or null when there's nothing worth surfacing.
 * Silent on errors — callers should never block a lead proposal on
 * the context fetch.
 */
export async function getCrossChannelHint(
  supabase: SupabaseClient,
  shopId: string,
  customerId: string | null,
  excludeChannel: InteractionChannel | null
): Promise<string | null> {
  if (!customerId) return null

  let recent
  try {
    recent = await recentChannelActivity(supabase, shopId, customerId, {
      excludeChannel: excludeChannel ?? undefined,
      withinMinutes: WINDOW_MINUTES,
    })
  } catch (err) {
    console.warn("[customer-context] recentChannelActivity failed:", err)
    return null
  }

  if (recent.length === 0) return null

  // First-seen wins per channel (rows arrive newest first).
  const seenChannels = new Map<InteractionChannel, string>()
  for (const item of recent) {
    if (!seenChannels.has(item.channel)) {
      seenChannels.set(item.channel, item.occurred_at)
    }
  }

  const phrases = Array.from(seenChannels.entries())
    .slice(0, 2)
    .map(
      ([channel, iso]) =>
        `${CHANNEL_VERB[channel] ?? channel} ${relative(iso)}`
    )
  if (phrases.length === 0) return null

  return `Also ${phrases.join(" and ")}.`
}
