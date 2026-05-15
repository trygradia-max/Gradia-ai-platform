/**
 * Gradia Whisper — voice-to-action.
 *
 * - transcribeAudio: posts captured audio to OpenAI's Whisper API.
 * - parseWhisperIntent: classifies the transcript via Claude into one of
 *   two intents (create_lead | add_note) with structured output.
 *
 * Both helpers throw on failure; the caller decides how to surface errors.
 */

import { ChatAnthropic } from "@langchain/anthropic"
import { ChatPromptTemplate } from "@langchain/core/prompts"
import { z } from "zod"

const CLAUDE_MODEL = "claude-haiku-4-5-20251001"
const TOOL_NAME = "submit_whisper_intent"

export type CreateLeadIntent = {
  type: "create_lead"
  customer_name: string
  phone: string
  vehicle: string
  service: string
  pin_notes: string
}

export type AddNoteIntent = {
  type: "add_note"
  content: string
  customer_name: string
  phone: string
}

export type ChargeCustomerIntent = {
  type: "charge_customer"
  customer_name: string
  amount_cents: number
  description: string
}

export type WhisperIntent =
  | CreateLeadIntent
  | AddNoteIntent
  | ChargeCustomerIntent

const intentSchema = z.object({
  type: z
    .enum(["create_lead", "add_note", "charge_customer"])
    .describe(
      "Classify exactly one type. 'create_lead' = the detailer is logging a new customer or quote/booking. 'add_note' = a comment about a job, a customer, or general operations. 'charge_customer' = the detailer wants to bill a customer for work just completed (e.g. 'charge Smith $450 for ceramic')."
    ),
  customer_name: z
    .string()
    .describe(
      "Customer name if explicitly mentioned, otherwise empty string. Never invent."
    ),
  phone: z
    .string()
    .describe(
      "Phone number if mentioned (whitespace-normalize only), otherwise empty string. For charge_customer set to empty."
    ),
  vehicle: z
    .string()
    .describe(
      "Year/make/model/color if mentioned, otherwise empty string. For add_note / charge_customer set to empty."
    ),
  service: z
    .string()
    .describe(
      "Detailing service if mentioned (wash, ceramic, full detail, etc), otherwise empty string. For add_note set to empty."
    ),
  pin_notes: z
    .string()
    .describe(
      "create_lead only: extra context to save with the lead (e.g. 'wants Saturday at 2pm'). For other types set to empty string."
    ),
  content: z
    .string()
    .describe(
      "add_note only: the verbatim or lightly-cleaned note. For other types set to empty string."
    ),
  amount_cents: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "charge_customer only: dollar amount converted to cents (e.g. $450 = 45000). Use 0 for any other type."
    ),
  charge_description: z
    .string()
    .describe(
      "charge_customer only: short description of what we're charging for (e.g. 'Ceramic coating'). Use empty string otherwise."
    ),
})

const SYSTEM_PROMPT = `You are Gradia's Whisper intent parser for an auto detailing business.
The detailer just spoke into their phone and we transcribed it.

Use the ${TOOL_NAME} tool to classify their command into exactly one type.

create_lead — examples:
  "log a lead for John Smith, 555-1234, white Tesla, ceramic coating quote"
  "Mike wants the Signature for his F-150 next Saturday at 2pm"
  "new customer Sarah, blue Civic, full interior detail"

add_note — examples:
  "Smith job went great, his kid loved the candy"
  "we should restock the foam soap"
  "Mike's truck had a deeper scratch than expected, took an extra hour"
  "remember to follow up with the Tesla guy in 6 months"

charge_customer — examples:
  "just finished the Smith job, charge her $450"
  "bill Mike $200 for the wash and wax"
  "send Tesla guy an invoice for $1,200 for ceramic"
  "charge Sarah three hundred fifty for the interior detail"

Rules:
- Pick exactly one type.
- For create_lead: extract customer_name, phone, vehicle, service when present. Booking time/date goes in pin_notes (e.g. "Saturday 2pm"). Set content, amount_cents, and charge_description to empty/zero.
- For add_note: put the cleaned-up message in content. If a customer's name or phone is mentioned, extract those too. Set vehicle/service/pin_notes/charge_description to empty strings and amount_cents to 0.
- For charge_customer: extract customer_name and convert the dollar amount to amount_cents (e.g. $450 = 45000, "three hundred fifty" = 35000). Put what they're being charged for (service / description) in charge_description. Set phone/vehicle/service/pin_notes/content to empty strings.
- Use empty string "" or 0 for any unmentioned field. Never hallucinate.`

const HUMAN_PROMPT = `Classify this voice command:

--- TRANSCRIPT ---
{transcript}`

const promptTemplate = ChatPromptTemplate.fromMessages([
  ["system", SYSTEM_PROMPT],
  ["human", HUMAN_PROMPT],
])

function anthropicKey(): string {
  const key = process.env.ANTHROPIC_API_KEY?.trim()
  if (!key) throw new Error("ANTHROPIC_API_KEY is not configured")
  return key
}

function openaiKey(): string {
  const key = process.env.OPENAI_API_KEY?.trim()
  if (!key) throw new Error("OPENAI_API_KEY is not configured")
  return key
}

/**
 * Sends audio to OpenAI's Whisper API and returns the transcript.
 * Caller is responsible for size limits (Whisper accepts up to 25 MB).
 */
export async function transcribeAudio(
  buffer: Buffer,
  filename: string,
  mimeType: string
): Promise<string> {
  const apiKey = openaiKey()

  const blob = new Blob([new Uint8Array(buffer)], {
    type: mimeType || "audio/webm",
  })
  const form = new FormData()
  form.append("file", blob, filename || "recording.webm")
  form.append("model", "whisper-1")
  form.append("language", "en")
  form.append("response_format", "json")

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(
      `OpenAI Whisper error (${res.status}): ${body.slice(0, 200)}`
    )
  }

  const data = (await res.json()) as { text?: string }
  return (data.text ?? "").trim()
}

/**
 * Classifies a transcript into a structured intent via Claude. Empty/missing
 * fields come back as empty strings — never guessed values.
 */
export async function parseWhisperIntent(
  transcript: string
): Promise<WhisperIntent> {
  const trimmed = transcript.trim()
  if (!trimmed) {
    throw new Error("Empty transcript")
  }

  const baseModel = new ChatAnthropic({
    model: CLAUDE_MODEL,
    temperature: 0,
    maxTokens: 1024,
    apiKey: anthropicKey(),
  })

  const structured = baseModel.withStructuredOutput(intentSchema, {
    name: TOOL_NAME,
  })
  const chain = promptTemplate.pipe(structured)

  const raw = await chain.invoke({ transcript: trimmed })
  const parsed = intentSchema.parse(raw)

  if (parsed.type === "create_lead") {
    return {
      type: "create_lead",
      customer_name: parsed.customer_name.trim(),
      phone: parsed.phone.trim(),
      vehicle: parsed.vehicle.trim(),
      service: parsed.service.trim(),
      pin_notes: parsed.pin_notes.trim(),
    }
  }

  if (parsed.type === "charge_customer") {
    return {
      type: "charge_customer",
      customer_name: parsed.customer_name.trim(),
      amount_cents: Math.max(0, Math.round(parsed.amount_cents)),
      description:
        parsed.charge_description.trim() ||
        parsed.service.trim() ||
        "Detailing service",
    }
  }

  return {
    type: "add_note",
    // If Claude returned empty content (rare), fall back to the raw transcript
    // so the detailer's words aren't lost.
    content: parsed.content.trim() || trimmed,
    customer_name: parsed.customer_name.trim(),
    phone: parsed.phone.trim(),
  }
}
