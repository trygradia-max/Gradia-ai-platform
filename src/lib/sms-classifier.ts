/**
 * SMS classifier. Mirrors email-classifier.ts in shape, but the prompt
 * is tuned for short-form messages: most inbound SMS is one or two
 * sentences, and a lot of it is conversational follow-ups ("yes",
 * "thanks", "see you sat") that should NOT become new leads.
 *
 * Phone comes from Twilio's From header, not the body, so we don't
 * ask the model to extract it.
 */

import { ChatAnthropic } from "@langchain/anthropic"
import { ChatPromptTemplate } from "@langchain/core/prompts"
import { z } from "zod"

const CLAUDE_MODEL = "claude-haiku-4-5-20251001"
const TOOL_NAME = "classify_sms"

const schema = z
  .object({
    is_lead: z
      .boolean()
      .describe(
        "True only if this SMS is a real prospective customer inquiry about our auto detailing services (booking, quote, question). False for short follow-ups in an existing thread ('yes', 'thanks', 'see you then'), receipts, spam, marketing, and clearly off-topic messages."
      ),
    customer_name: z
      .string()
      .describe("Sender's name if mentioned in the body; otherwise empty string."),
    vehicle: z
      .string()
      .describe("Year/make/model/trim/color if mentioned; otherwise empty string."),
    service: z
      .string()
      .describe(
        "Detailing scope they're asking about (wash, ceramic, interior, paint correction, etc.); otherwise empty string."
      ),
    summary: z
      .string()
      .describe(
        "One short sentence summarizing what they're asking for. Empty string if not a lead."
      ),
  })
  .describe(
    "SMS classification + lead extraction. Phone is supplied separately (Twilio From header). Use empty strings for unknown fields — never invent."
  )

export type SmsClassification = z.infer<typeof schema>

const SYSTEM = `You are Gradia, the AI partner for an auto detailing shop. Classify inbound SMS: is this a real prospective customer asking about detailing, or a short follow-up / noise? Extract fields only when the text supports them — never invent.

Rules:
- is_lead = true only when the sender is clearly making a new inquiry (a question, quote request, booking ask, or service interest).
- is_lead = false for short follow-ups inside an existing thread ('yes', 'thanks', 'ok', 'see you sat'), confirmations, single-word replies, marketing, and obvious spam.
- is_lead = false when there's not enough signal to know — err on the side of NOT generating a noisy approval card.
- All string fields must be empty when not explicitly supported by the SMS body.
- summary: one short sentence the shop owner can scan, only when is_lead = true.`

const HUMAN = `Classify this inbound SMS via the ${TOOL_NAME} tool.

From: {from}

--- BODY ---
{body}`

const prompt = ChatPromptTemplate.fromMessages([
  ["system", SYSTEM],
  ["human", HUMAN],
])

function anthropicKey(): string {
  const k = process.env.ANTHROPIC_API_KEY?.trim()
  if (!k) throw new Error("ANTHROPIC_API_KEY is not configured")
  return k
}

const MAX_BODY_CHARS = 4_000

export async function classifySms(input: {
  from: string
  body: string
}): Promise<SmsClassification> {
  const trimmedBody = input.body.trim().slice(0, MAX_BODY_CHARS)

  const llm = new ChatAnthropic({
    model: CLAUDE_MODEL,
    temperature: 0,
    maxTokens: 512,
    apiKey: anthropicKey(),
  }).withStructuredOutput(schema, { name: TOOL_NAME })

  const chain = prompt.pipe(llm)
  const raw = await chain.invoke({
    from: input.from.trim() || "(unknown)",
    body: trimmedBody || "(empty body)",
  })

  const parsed = schema.parse(raw)
  return {
    is_lead: parsed.is_lead,
    customer_name: parsed.customer_name.trim(),
    vehicle: parsed.vehicle.trim(),
    service: parsed.service.trim(),
    summary: parsed.summary.trim(),
  }
}
