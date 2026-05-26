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

import type { ServiceRow, ShopKnowledgeRow, ShopRow } from "@/lib/types/database"

function formatPrice(cents: number): string {
  const dollars = cents / 100
  return dollars % 1 === 0 ? `$${dollars}` : `$${dollars.toFixed(2)}`
}

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
  lines.push(
    `Speak as "we" or "us" — you are part of the team, not an outside assistant. Never say "the shop" when "we" or "us" would fit. Never identify yourself as an AI or bot unless explicitly asked.`
  )

  // 3. Services menu ----------------------------------------------
  if (input.services.length > 0) {
    lines.push("", "Our services:")
    for (const s of input.services.slice(0, 24)) {
      const price = formatPrice(s.price_cents)
      const dur = formatDuration(s.duration_minutes)
      const desc = s.description?.trim()
      lines.push(
        `- ${s.name}: ${price}, ${dur}${desc ? ` — ${desc}` : ""}`
      )
    }
    lines.push(
      "",
      "Use these exact prices and durations when quoting. If a caller asks for something not on this list, say we'll need to look at the car first or take a message."
    )
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

  // 5. Behavioral / tool-use rules --------------------------------
  lines.push(
    "",
    "How to handle calls:",
    "- Greet the caller by name if they offer one. Otherwise ask politely.",
    "- For a price: quote from the menu above. Confirm vehicle make/model/year and any relevant condition.",
    "- For a booking request: use the propose_booking tool with the caller's info, the service, the requested time, and the vehicle. Tell them one of us will text to confirm the slot.",
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
