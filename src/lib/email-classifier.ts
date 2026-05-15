/**
 * Classifies an inbound email as a lead inquiry vs noise (newsletters,
 * receipts, replies to our own outbound, etc.). When it's a lead, pulls
 * out the customer name, vehicle, requested service, and a phone number
 * if mentioned in the body.
 *
 * Same Haiku 4.5 + LangChain structured-output pattern as ai-service.ts.
 */

import { ChatAnthropic } from "@langchain/anthropic"
import { ChatPromptTemplate } from "@langchain/core/prompts"
import { z } from "zod"

const CLAUDE_MODEL = "claude-haiku-4-5-20251001"
const TOOL_NAME = "classify_email"

const schema = z
  .object({
    is_lead: z
      .boolean()
      .describe(
        "True only if this email is a real prospective customer inquiry about our auto detailing services (booking, quote, question about services). False for newsletters, receipts, automated replies, marketing, internal team mail, and replies on our own outbound."
      ),
    customer_name: z
      .string()
      .describe(
        "Sender's name copied from the email; empty string if unclear."
      ),
    phone: z
      .string()
      .describe(
        "Phone number from the body if mentioned, lightly normalized; otherwise empty string."
      ),
    vehicle: z
      .string()
      .describe(
        "Year/make/model/trim/color of the vehicle if mentioned; otherwise empty string."
      ),
    service: z
      .string()
      .describe(
        "Detailing scope they asked about (wash, ceramic, interior, paint correction, etc.); otherwise empty string."
      ),
    summary: z
      .string()
      .describe(
        "One short sentence summarizing what they're asking for. Empty string if not a lead."
      ),
  })
  .describe(
    "Email classification + lead extraction. Use empty strings for unknown fields — never invent details."
  )

export type EmailClassification = z.infer<typeof schema>

const SYSTEM = `You are Gradia, the AI partner for an auto detailing shop. Classify inbound emails: is this a real prospective customer asking about detailing, or noise? Extract fields only when the text supports them — never invent.

Rules:
- is_lead = true only when the sender is clearly a person interested in our detailing services (a question, quote request, booking ask, or service inquiry).
- is_lead = false for newsletters, transactional/auto receipts, replies to our own outbound that don't carry a new ask, internal team mail, and clear spam.
- All string fields must be empty when not explicitly supported by the email body or subject.
- summary: one short sentence the shop owner can scan, only when is_lead = true.`

const HUMAN = `Classify this inbound email via the ${TOOL_NAME} tool.

From: {from}
Subject: {subject}

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

const MAX_BODY_CHARS = 8_000

export async function classifyEmail(input: {
  from: string
  subject: string
  body: string
}): Promise<EmailClassification> {
  const trimmedBody = input.body.trim().slice(0, MAX_BODY_CHARS)

  const llm = new ChatAnthropic({
    model: CLAUDE_MODEL,
    temperature: 0,
    maxTokens: 1024,
    apiKey: anthropicKey(),
  }).withStructuredOutput(schema, { name: TOOL_NAME })

  const chain = prompt.pipe(llm)
  const raw = await chain.invoke({
    from: input.from.trim() || "(unknown)",
    subject: input.subject.trim() || "(no subject)",
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
