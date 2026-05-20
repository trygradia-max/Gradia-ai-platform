/**
 * Instagram DM classifier. Same structured-output shape as the SMS +
 * email classifiers; prompt is tuned for Instagram messaging — short,
 * casual, often emoji-laden, often the customer's first contact.
 *
 * Phone comes from the body (Meta gives us a sender id, not a phone),
 * so we extract it when mentioned.
 */

import { ChatAnthropic } from "@langchain/anthropic"
import { ChatPromptTemplate } from "@langchain/core/prompts"
import { z } from "zod"

const CLAUDE_MODEL = "claude-haiku-4-5-20251001"
const TOOL_NAME = "classify_instagram_dm"

const schema = z
  .object({
    is_lead: z
      .boolean()
      .describe(
        "True only if this is a real prospective customer inquiry about our auto detailing services. False for short follow-ups in a thread ('thanks', 'k', '👍'), spam, unrelated DMs, or messages reacting to our story without asking anything."
      ),
    customer_name: z
      .string()
      .describe("Sender's name if mentioned in the body. Empty otherwise."),
    phone: z
      .string()
      .describe("Phone if explicitly mentioned in the body. Empty otherwise."),
    vehicle: z
      .string()
      .describe(
        "Year/make/model/color if mentioned; otherwise empty string."
      ),
    service: z
      .string()
      .describe(
        "Detailing scope they asked about (wash, ceramic, interior, paint correction, etc.); empty otherwise."
      ),
    summary: z
      .string()
      .describe(
        "One short sentence summarizing what they're asking for. Empty if not a lead."
      ),
  })
  .describe(
    "Instagram DM classification + lead extraction. Empty strings for unknown fields — never invent."
  )

export type InstagramClassification = z.infer<typeof schema>

const SYSTEM = `You are Gradia, the AI partner for an auto detailing shop. Classify inbound Instagram DMs: is this a real prospective customer asking about detailing, or noise?

Rules:
- is_lead = true only for clear new-customer inquiries (question, quote ask, booking ask, "do you do X?").
- is_lead = false for short follow-ups in an existing thread, reaction emojis, story replies that aren't asking anything, marketing DMs, and spam.
- is_lead = false when there's not enough signal — err on the side of NOT generating a noisy approval card.
- All string fields must be empty when not supported by the message body. Never invent details.
- summary: one short sentence the shop owner can scan, only when is_lead = true.`

const HUMAN = `Classify this Instagram DM via the ${TOOL_NAME} tool.

Sender id: {sender_id}

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

export async function classifyInstagramDm(input: {
  senderId: string
  body: string
}): Promise<InstagramClassification> {
  const trimmedBody = input.body.trim().slice(0, MAX_BODY_CHARS)

  const llm = new ChatAnthropic({
    model: CLAUDE_MODEL,
    temperature: 0,
    maxTokens: 512,
    apiKey: anthropicKey(),
  }).withStructuredOutput(schema, { name: TOOL_NAME })

  const chain = prompt.pipe(llm)
  const raw = await chain.invoke({
    sender_id: input.senderId.trim() || "(unknown)",
    body: trimmedBody || "(empty body)",
  })

  const parsed = schema.parse(raw)
  return {
    is_lead: parsed.is_lead,
    customer_name: parsed.customer_name.trim(),
    phone: parsed.phone.trim(),
    vehicle: parsed.vehicle.trim(),
    service: parsed.service.trim(),
    summary: parsed.summary.trim(),
  }
}
