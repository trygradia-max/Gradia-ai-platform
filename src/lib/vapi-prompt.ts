/**
 * System-prompt synthesizer for the Vapi voice receptionist.
 *
 * Takes the shop's real config (name, location, hours, services,
 * pasted knowledge entries) and builds a first-person system prompt
 * the LLM uses on every call. The output is grounded in actual shop
 * data — operators don't write a single line of prompt engineering.
 *
 * Tone is locked to we/us (per HUMAN.md): "we charge $150", never
 * "they charge". The receptionist talks like a real teammate at the
 * shop.
 */

import { GRADIA_VOICE } from "@/lib/persona"
import {
  describePrice,
  priceSpread,
  durationSpread,
  resolveDurationMinutes,
} from "@/lib/service-pricing"
import type {
  ServiceRow,
  ShopKnowledgeRow,
  ShopRow,
  VoiceConfig,
} from "@/lib/types/database"

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`
  const hours = minutes / 60
  if (Number.isInteger(hours)) {
    return hours === 1 ? "about an hour" : `about ${hours} hours`
  }
  return `about ${hours.toFixed(1)} hours`
}

function clampParagraph(s: string, max = 700): string {
  const trimmed = s.trim()
  if (trimmed.length <= max) return trimmed
  return trimmed.slice(0, max).replace(/\s+\S*$/, "") + "…"
}

export type SynthesisInput = {
  shop: Pick<ShopRow, "name" | "location" | "phone"> & {
    /** Operator-provided greeting line. */
    greeting?: string | null
    /** Optional "tone" hint passed from the build form. */
    tone?: "warm" | "professional" | "playful" | null
  }
  services: ServiceRow[]
  knowledge: ShopKnowledgeRow[]
  /** Builder form answers beyond greeting/tone (spec §2.1). */
  config?: Pick<
    VoiceConfig,
    | "after_hours"
    | "hours_text"
    | "booking_mode"
    | "calendar_link"
    | "escalation_phone"
  > | null
}

/** Suggested greeting when the operator hasn't supplied one yet. */
export function defaultGreeting(shopName: string | null | undefined): string {
  const name = shopName?.trim() || "the shop"
  return `Thanks for calling ${name} — what can we do for you?`
}

export function synthesizeFirstMessage(input: SynthesisInput): string {
  const operator = input.shop.greeting?.trim()
  if (operator && operator.length > 0) return operator
  return defaultGreeting(input.shop.name)
}

/**
 * Builds the system prompt body. Keep this output stable — small
 * regressions in tone cascade into every call. Pieces:
 *   1. Identity ("you are the receptionist for X")
 *   2. The we/us tone rule
 *   3. Services menu (price + duration per row)
 *   4. Knowledge / policies (truncated to keep latency sane)
 *   5. Behavioral rules (HITL, no auto-booking, tool usage)
 */
export function synthesizeSystemPrompt(input: SynthesisInput): string {
  const shopName = input.shop.name?.trim() || "our shop"
  const location = input.shop.location?.trim()
  const phone = input.shop.phone?.trim()

  const lines: string[] = []

  // 1. Identity ----------------------------------------------------
  lines.push(
    `You are the AI receptionist for ${shopName}${
      location ? `, an auto detailing shop based in ${location}` : ""
    }. You answer the phone, quote services, and help customers book.`
  )

  if (phone) {
    lines.push(`Our number: ${phone}.`)
  }

  // 2. Tone rule ---------------------------------------------------
  const toneRule =
    input.shop.tone === "professional"
      ? "Crisp and confident — like a senior service advisor. No filler."
      : input.shop.tone === "playful"
        ? "Friendly and a little playful — but always helpful and clear."
        : "Warm, attentive, and direct — like a real teammate at the shop."
  lines.push("", `Tone: ${toneRule}`)
  lines.push(GRADIA_VOICE)

  // 3. Services menu ----------------------------------------------
  // Prices resolve through lib/service-pricing (the shared module), so the
  // menu the receptionist quotes from matches CRM quotes exactly.
  if (input.services.length > 0) {
    lines.push("", "Our services:")
    let anySized = false
    for (const s of input.services.slice(0, 24)) {
      const spread = priceSpread(s)
      if (spread && spread.low !== spread.high) anySized = true
      // Duration follows the same rule as price: a size-class range is a
      // range until the vehicle is known. Stating the flat number here made
      // the receptionist quote the sedan time to a truck owner.
      const durs = durationSpread(s)
      if (durs && durs.low !== durs.high) anySized = true
      const price = describePrice(s)
      const dur =
        durs && durs.low !== durs.high
          ? `${formatDuration(durs.low)} to ${formatDuration(durs.high)} depending on size`
          : formatDuration(resolveDurationMinutes(s))
      const desc = s.description?.trim()
      lines.push(
        `- ${s.name}: ${price}, ${dur}${desc ? ` — ${desc}` : ""}`
      )
    }
    lines.push(
      "",
      "Use these exact prices and durations when quoting. If a caller asks for something not on this list, say we'll need to look at the car first or take a message."
    )
    if (anySized) {
      lines.push(
        "For services priced or timed by vehicle size, ask what they drive first; if the size is still unclear, give the range and say we'll confirm the exact price and how long it takes."
      )
    }
  } else {
    lines.push(
      "",
      `We haven't loaded a service menu yet — if a caller asks for a price, take their info, the vehicle, and what they want, and let them know we'll text back with a quote.`
    )
  }

  // 4. Knowledge / policies ---------------------------------------
  if (input.knowledge.length > 0) {
    lines.push("", "Our policies and shop knowledge:")
    for (const k of input.knowledge.slice(0, 12)) {
      const heading = k.source_name?.trim()
      const body = clampParagraph(k.content, 700)
      lines.push(
        heading ? `[${heading}]\n${body}` : body
      )
    }
    lines.push(
      "",
      "Quote our actual policies above — don't make up rules. If a caller asks about something not covered here, take a message and tell them we'll get back to them today."
    )
  }

  // 4b. Hours / escalation from the builder form -------------------
  const config = input.config ?? null
  if (config?.hours_text?.trim()) {
    lines.push("", `Our hours: ${config.hours_text.trim()}`)
    lines.push(
      config.after_hours === "message_only"
        ? "Outside those hours: let the caller know we're closed and when we reopen — don't take booking details, just invite them to call back."
        : "Outside those hours: let the caller know we're closed, then take a message with their name, number, vehicle, and what they need (use capture_lead) so we can follow up first thing."
    )
  }
  if (config?.escalation_phone?.trim()) {
    lines.push(
      "",
      `If a caller insists on a human, has an urgent problem we can't solve, or is upset beyond a simple fix: offer to connect them to the owner at ${config.escalation_phone.trim()}. Mention that number at most once per call.`
    )
  }

  // 5. Behavioral / tool-use rules --------------------------------
  const bookingRule =
    config?.booking_mode === "calendar_link" && config.calendar_link?.trim()
      ? `- For a booking request: don't collect a time over the phone. Tell the caller we'll text them our booking link (${config.calendar_link.trim()}) and use capture_lead with their info and the service so we follow up with it.`
      : "- For a booking request: use the propose_booking tool with the caller's info, the service, the requested time, and the vehicle. Tell them one of us will text to confirm the slot."

  lines.push(
    "",
    "How to handle calls:",
    "- Greet the caller by name if they offer one. Otherwise ask politely.",
    "- For a price: quote from the menu above. Confirm vehicle make/model/year and any relevant condition.",
    bookingRule,
    "- For a general inquiry that doesn't fit a service yet: use capture_lead so the team sees it on the dashboard.",
    "- For a question outside our menu / policies: use lookup_shop_policy first. If still no answer, take a message and promise a callback today.",
    "- For an existing customer asking about their last service: use lookup_customer_history.",
    "",
    "Hard rules — never break:",
    "- Never confirm a booking unilaterally. Every booking goes through human approval after the call.",
    "- Never quote a price not on our menu unless explicitly told to.",
    "- Never give a discount or honor one the caller claims without checking with the team.",
    "- Keep responses tight — under three sentences when you can. Phone calls reward brevity.",
    "- If a caller is upset, stay calm, acknowledge it, take their info, and promise an owner callback today.",
    "- If the caller goes off-topic (sales pitch, survey, robocall), politely end the call within one exchange."
  )

  return lines.join("\n")
}
