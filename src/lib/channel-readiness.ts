import type { ShopRow } from "@/lib/types/database"
import { voiceLaunchGate } from "@/lib/voice-launch-gate"

/**
 * Per-channel readiness for calls, texting, email and Meta, each from the
 * evidence that actually gates that channel — not "a credential exists".
 * The published contract is docs/architecture/CHANNEL_READINESS.md.
 *
 * States, in the order an owner moves through them:
 *   unavailable    this deployment isn't wired for the channel (server config)
 *   not_set_up     the owner hasn't connected it
 *   in_progress    submitted and waiting on a third party (carrier review)
 *   action_needed  something specific blocks it; `reasons` says what
 *   limited        works, with a named gap (e.g. sends but can't receive)
 *   ready_to_test  the gate passes only on the owner's word (an own number's
 *                  attestation); Gradia can't verify it, so never `ready`
 *   ready          every check this code can make passes
 *
 * "ready" is never a delivery or activation claim: providers stay held by the
 * release lane, and checks that need a live provider call (a revoked mailbox
 * grant, a Meta page's webhook subscription) are named as limits instead.
 * A checked setting alone is never `ready` (ONBOARDING_AND_BUSINESS_UX_HANDOFF.md).
 * `readinessStatusLabel` maps each result to the handoff's status vocabulary.
 */
export type ChannelKey = "calls" | "texting" | "email" | "meta"
export type ReadinessState = "unavailable" | "not_set_up" | "in_progress" | "action_needed" | "limited" | "ready_to_test" | "ready"

export type ReadinessReason =
  | "server_not_configured"
  // calls
  | "no_voice_number" | "no_assistant" | "no_test_call" | "voice_addon_inactive"
  // texting
  | "no_number" | "registration_required" | "registration_pending" | "registration_rejected" | "registration_suspended"
  | "not_own_account" | "byo_registration_unconfirmed" | "byo_owner_attested"
  // email
  | "no_mailbox" | "inbound_not_subscribed"
  // meta
  | "no_page_connected" | "page_subscription_unverified"

export type ChannelReadiness = {
  channel: ChannelKey
  state: ReadinessState
  reasons: ReadinessReason[]
  message: string
}

export type ReadinessShop = Pick<
  ShopRow,
  | "twilio_phone_number" | "gradia_number_e164" | "a2p_status" | "byo_sms_verified"
  | "twilio_account_sid_enc" | "twilio_auth_token_enc"
  | "vapi_assistant_id" | "vapi_phone_number_id" | "voice_test_called_at" | "voice_addon"
  | "aurinko_access_token_enc" | "aurinko_account_id" | "aurinko_subscription_id"
>

export type ReadinessFacts = {
  /** Meta pages bound to this shop (meta_lead_page_bindings). */
  metaPageBindings: number
  /** Server configuration present per channel (env presence only, never values). */
  configured: Record<ChannelKey, boolean>
}

const present = (v: unknown) => (typeof v === "string" ? v.trim().length > 0 : v !== null && v !== undefined)

export function callsReadiness(shop: ReadinessShop, configured: boolean): ChannelReadiness {
  if (!configured) return result("calls", "unavailable", ["server_not_configured"], "Calls aren't available on this deployment yet.")
  const gate = voiceLaunchGate(shop)
  const reasons: ReadinessReason[] = gate.missing.map((m) => (m === "number" ? "no_voice_number" : m === "assistant" ? "no_assistant" : "no_test_call"))
  if (gate.missing.length === 3) return result("calls", "not_set_up", reasons, "Set up your phone receptionist to answer calls.")
  if (!shop.voice_addon) reasons.push("voice_addon_inactive")
  if (reasons.length > 0) {
    const first = reasons[0]
    const message = {
      no_voice_number: "Connect a phone number for calls.",
      no_assistant: "Finish setting up your phone receptionist.",
      no_test_call: "Place a test call before going live.",
      voice_addon_inactive: "Turn on the Voice add-on to answer calls.",
    } as Record<string, string>
    return result("calls", "action_needed", reasons, message[first])
  }
  return result("calls", "ready", [], "Calls are set up.")
}

export function textingReadiness(shop: ReadinessShop, configured: boolean): ChannelReadiness {
  if (!configured) return result("texting", "unavailable", ["server_not_configured"], "Texting isn't available on this deployment yet.")
  if (!present(shop.twilio_phone_number)) return result("texting", "not_set_up", ["no_number"], "Get a business number to text customers.")
  const gradiaNumber = present(shop.gradia_number_e164) && shop.twilio_phone_number === shop.gradia_number_e164
  if (!gradiaNumber) {
    // Without the shop's own Twilio credentials, a send from this number falls
    // back to Gradia's pilot account (resolveTwilioCredentials → "env"), where the
    // owner holds no registration. Checked before the flag, so no attestation,
    // however it was written, counts here (BYO_SMS_ATTESTATION.md).
    if (!present(shop.twilio_account_sid_enc) || !present(shop.twilio_auth_token_enc)) {
      return result("texting", "action_needed", ["not_own_account"], "This number isn't on your own Twilio account, so texts from it are held. Get a Gradia number, or connect your own Twilio account.")
    }
    // The attestation is the owner's word, not a check Gradia made: at most "Ready to test".
    return shop.byo_sms_verified
      ? result("texting", "ready_to_test", ["byo_owner_attested"], "You confirmed your own number's texting registration. Send a test before relying on it.")
      : result("texting", "action_needed", ["byo_registration_unconfirmed"], "Confirm your own number's texting registration in Settings → Business Number. Until then, texts are held.")
  }
  switch (shop.a2p_status) {
    case "approved":
      return result("texting", "ready", [], "Texting is approved by carriers.")
    case "pending":
      return result("texting", "in_progress", ["registration_pending"], "Carriers are reviewing your texting registration. Texts are held until it's approved.")
    case "rejected":
      return result("texting", "action_needed", ["registration_rejected"], "Carriers rejected your texting registration. Review the reason and resubmit.")
    case "suspended":
      return result("texting", "action_needed", ["registration_suspended"], "Carriers suspended texting on this number. Texts are held; contact support.")
    default:
      return result("texting", "action_needed", ["registration_required"], "Register your business with carriers before texting customers.")
  }
}

export function emailReadiness(shop: ReadinessShop, configured: boolean): ChannelReadiness {
  if (!configured) return result("email", "unavailable", ["server_not_configured"], "Email isn't available on this deployment yet.")
  if (!present(shop.aurinko_access_token_enc) || !present(shop.aurinko_account_id)) {
    return result("email", "not_set_up", ["no_mailbox"], "Connect your mailbox to send and receive email.")
  }
  if (!present(shop.aurinko_subscription_id)) {
    return result("email", "limited", ["inbound_not_subscribed"], "Your mailbox can send, but customer replies aren't coming into Gradia yet. Reconnect it.")
  }
  return result("email", "ready", [], "Your mailbox is connected.")
}

export function metaReadiness(bindings: number, configured: boolean): ChannelReadiness {
  if (!configured) return result("meta", "unavailable", ["server_not_configured"], "Meta lead ads aren't available on this deployment yet.")
  if (bindings < 1) return result("meta", "not_set_up", ["no_page_connected"], "No Facebook page is connected for lead ads.")
  // Gradia routes signed lead events for bound pages, but cannot yet confirm the
  // page's webhook subscription with Meta.
  return result("meta", "limited", ["page_subscription_unverified"], "Lead ads from your connected page are routed to Gradia. Gradia can't yet confirm the page's subscription with Meta.")
}

export function channelReadiness(shop: ReadinessShop, facts: ReadinessFacts): Record<ChannelKey, ChannelReadiness> {
  return {
    calls: callsReadiness(shop, facts.configured.calls),
    texting: textingReadiness(shop, facts.configured.texting),
    email: emailReadiness(shop, facts.configured.email),
    meta: metaReadiness(facts.metaPageBindings, facts.configured.meta),
  }
}

/**
 * The onboarding handoff's status label for a readiness result. `null` when the
 * deployment isn't wired for the channel: that's Gradia's to fix, not a status
 * the owner can act on. "Paused" is never derived here.
 */
export type HandoffStatus = "Not set up" | "Needs your details" | "Submitted for review" | "Needs a correction" | "Ready to test" | "Ready"
export function readinessStatusLabel(r: Pick<ChannelReadiness, "state" | "reasons">): HandoffStatus | null {
  switch (r.state) {
    case "unavailable": return null
    case "not_set_up": return "Not set up"
    case "in_progress": return "Submitted for review"
    case "action_needed": return r.reasons.includes("registration_rejected") || r.reasons.includes("registration_suspended") ? "Needs a correction" : "Needs your details"
    case "limited": return "Ready to test"
    case "ready_to_test": return "Ready to test"
    case "ready": return "Ready"
  }
}

/** Which channels this deployment is wired for. Presence only, never values. */
export function configuredChannels(env: Record<string, string | undefined> = process.env): Record<ChannelKey, boolean> {
  const has = (name: string) => Boolean(env[name]?.trim())
  return {
    calls: has("VAPI_API_KEY") && has("TWILIO_ACCOUNT_SID") && has("TWILIO_AUTH_TOKEN"),
    texting: has("TWILIO_ACCOUNT_SID") && has("TWILIO_AUTH_TOKEN"),
    email: has("AURINKO_CLIENT_ID") && has("AURINKO_CLIENT_SECRET"),
    meta: has("META_APP_SECRET") && has("META_WEBHOOK_VERIFY_TOKEN"),
  }
}

function result(channel: ChannelKey, state: ReadinessState, reasons: ReadinessReason[], message: string): ChannelReadiness {
  return { channel, state, reasons, message }
}
