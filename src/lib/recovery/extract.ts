/**
 * Customer Recovery extraction worker (P8 / NEXT-3, GRADIA_CUSTOMER_RECOVERY_SPEC
 * §2.1). A single-turn Haiku worker with forced structured output — the same
 * LangChain + Zod pattern as email-classifier.ts. Code drives the import
 * pipeline; this worker only turns ONE pre-filtered thread/contact into a
 * structured customer candidate. It never chooses the next step, never writes,
 * never meters (the batch orchestrator handles credit pre-check + metering).
 *
 * Per the spec's constraints: extract only what the text supports; vendor/spam
 * that slipped the pre-filter must come back low-confidence so code drops it.
 */

import { ChatAnthropic } from "@langchain/anthropic"
import { ChatPromptTemplate } from "@langchain/core/prompts"
import { z } from "zod"

const CLAUDE_MODEL = "claude-haiku-4-5-20251001"
const TOOL_NAME = "extract_customer"

export type ExtractionDirection = "inquiry" | "quote" | "booked" | "completed"

/**
 * Canonical extraction shape (nulls for absent single-value fields). The
 * LLM-facing schema below uses empty strings instead of null — the established
 * convention in this codebase — and the worker maps empties back to null.
 */
export type RecoveryExtraction = {
  name: string | null
  phones: string[]
  emails: string[]
  vehicle: string | null
  services_mentioned: string[]
  last_interaction_at: string | null
  direction: ExtractionDirection
  confidence: number
}

const schema = z
  .object({
    name: z
      .string()
      .describe(
        "The customer's full name as written; empty string if no human name is recoverable."
      ),
    phones: z
      .array(z.string())
      .describe(
        "Every phone number the customer gives, copied as written (e.g. '(415) 555-0142'). Empty array if none. Do NOT include the shop's own number or toll-free vendor lines."
      ),
    emails: z
      .array(z.string())
      .describe(
        "Every email address belonging to the customer, lowercased. Empty array if none. Exclude the shop's own address."
      ),
    vehicle: z
      .string()
      .describe(
        "The customer's vehicle as year/make/model/color when present (e.g. '2021 Tesla Model 3, white'). Join multiple vehicles with '; '. Empty string if none."
      ),
    services_mentioned: z
      .array(z.string())
      .describe(
        "Detailing services the thread mentions (e.g. 'ceramic coating', 'paint correction', 'interior detail'). Empty array if none."
      ),
    last_interaction_at: z
      .string()
      .describe(
        "Date of the most recent message in the thread, as YYYY-MM-DD (read it from the message headers). Empty string if no date is present."
      ),
    direction: z
      .enum(["inquiry", "quote", "booked", "completed"])
      .describe(
        "The customer's FURTHEST progress: 'inquiry' = asked, no price; 'quote' = a price was given; 'booked' = an appointment was agreed; 'completed' = the job was done/paid."
      ),
    confidence: z
      .number()
      .describe(
        "0–1 that this is a real past/prospective SERVICE customer of the shop. A genuine customer inquiry ≈ 0.8+. Vendor spam, cold sales outreach, newsletters, or automated mail ≈ 0.1 or lower."
      ),
  })
  .describe(
    "Past-customer extraction from one email thread or contact card. Use empty strings / empty arrays for anything the text does not support — never invent contact details."
  )

type LlmExtraction = z.infer<typeof schema>

const SYSTEM = `You are Gradia, the AI partner for an auto detailing shop. The owner is importing their old inbox and contacts to rebuild a customer list. For each thread or contact, extract the customer's details so the shop can reconnect.

Rules:
- Extract ONLY what the text supports. Never invent a phone, email, name, or vehicle.
- The shop is the recipient — never extract the shop's own address or number as the customer's.
- Normalize a vehicle to "year make model, color" when those parts are present; expand obvious make nicknames (Chevy → Chevrolet, VW → Volkswagen). Join multiple vehicles with "; ".
- direction reflects the customer's furthest progress in the thread.
- confidence is LOW (≤ 0.2) when the sender is a vendor, a cold sales pitch, a newsletter, or any automated/non-customer mail — even if it slipped through earlier filters. A real person asking about or having received detailing service is HIGH.
- Every field that the text does not support must be empty ("" or []).`

const HUMAN = `Extract the customer via the ${TOOL_NAME} tool.

--- THREAD ---
{thread}`

const prompt = ChatPromptTemplate.fromMessages([
  ["system", SYSTEM],
  ["human", HUMAN],
])

function anthropicKey(): string {
  const k = process.env.ANTHROPIC_API_KEY?.trim()
  if (!k) throw new Error("ANTHROPIC_API_KEY is not configured")
  return k
}

const MAX_THREAD_CHARS = 8_000

/** Empty string → null, trimmed otherwise. */
function nullify(s: string): string | null {
  const t = s.trim()
  return t.length > 0 ? t : null
}

export async function extractCustomerFromThread(
  thread: string
): Promise<RecoveryExtraction> {
  const trimmed = thread.trim().slice(0, MAX_THREAD_CHARS)

  const llm = new ChatAnthropic({
    model: CLAUDE_MODEL,
    temperature: 0,
    maxTokens: 1024,
    apiKey: anthropicKey(),
  }).withStructuredOutput(schema, { name: TOOL_NAME })

  const chain = prompt.pipe(llm)
  const raw = (await chain.invoke({
    thread: trimmed || "(empty)",
  })) as LlmExtraction
  const parsed = schema.parse(raw)

  return {
    name: nullify(parsed.name),
    phones: parsed.phones.map((p) => p.trim()).filter(Boolean),
    emails: parsed.emails.map((e) => e.trim().toLowerCase()).filter(Boolean),
    vehicle: nullify(parsed.vehicle),
    services_mentioned: parsed.services_mentioned
      .map((s) => s.trim())
      .filter(Boolean),
    last_interaction_at: nullify(parsed.last_interaction_at),
    direction: parsed.direction,
    // Clamp to [0,1] so a stray value can never widen a downstream gate.
    confidence: Math.min(1, Math.max(0, parsed.confidence)),
  }
}
