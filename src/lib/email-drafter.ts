/**
 * Drafts a short, on-brand email reply to an inbound lead. The
 * draft is staged as a `send_email` pending_action — operator
 * approves (or edits) in Slack before it actually sends.
 *
 * Email constraints differ from SMS:
 *   - Has a subject (we draft "Re: ..." matching the inbound)
 *   - Body can run 4–8 sentences, but shorter is still better
 *   - Plain text only (no HTML) — keeps rendering predictable across
 *     clients and avoids accidental link tracking / formatting drift
 *   - Always signed "— Gradia at {shop_name}" per OPERATIONS.md
 */

import { ChatAnthropic } from "@langchain/anthropic"
import { ChatPromptTemplate } from "@langchain/core/prompts"
import { z } from "zod"

import {
  GRADIA_IDENTITY,
  GRADIA_SIGNATURE_RULE,
  GRADIA_VOICE,
} from "@/lib/persona"

const CLAUDE_MODEL = "claude-haiku-4-5-20251001"
const TOOL_NAME = "draft_email_reply"

const schema = z
  .object({
    subject: z
      .string()
      .min(1)
      .max(180)
      .describe(
        "Reply subject. Default to 'Re: {original subject}' when the inbound has one; otherwise something concise about the inquiry."
      ),
    body: z
      .string()
      .min(1)
      .max(1500)
      .describe(
        "Plain-text email body, signed 'Gradia at {shop_name}'. Warm, 3–6 sentences. One clear next step."
      ),
  })
  .describe(
    "A drafted email reply ready for human approval. No prices, no commitments, one next step."
  )

export type EmailDraft = z.infer<typeof schema>

const SYSTEM = `${GRADIA_IDENTITY} ${GRADIA_VOICE} You're drafting a single email reply to a new customer who just emailed us. The shop owner will approve before it sends — make the approval fast by writing something they'd actually send.

Tone rules:
- Speak as "we" and "us" — never "I", "me", "my", or "you and I".
- Warm, confident, specific. Acknowledge what they asked about by name when the summary tells you.
- One clear next step (e.g., "want us to send a few times?", "what year is the Tesla?", "happy to get you on the calendar — just need a day that works"). Never multiple asks.

Body structure (plain text):
- Greeting line
- 2–4 short sentences acknowledging their inquiry + offering the next step
- Sign-off: "— Gradia at {shop_name}" on the last line

Hard rules:
- Never quote a specific price unless the shop knowledge below explicitly states one. If they asked about price and knowledge is silent, say "we'll send a quote once we know the {make/model}".
- Never confirm a specific time. Bookings need owner approval — say "we'll lock it in shortly" if a time is mentioned, never "you're booked."
- If the shop knowledge mentions a policy that applies (deposit, weather, hours, etc.), weave it in naturally — don't invent policies that aren't there.
- ${GRADIA_SIGNATURE_RULE}
- Plain text only. No HTML tags, no markdown.`

const HUMAN = `Draft an email reply via the ${TOOL_NAME} tool.

Shop name: {shop_name}
Their email: {from}
Original subject: {subject}
What they asked about (summary): {summary}
Service mentioned (if any): {service}
Vehicle mentioned (if any): {vehicle}

--- SHOP KNOWLEDGE (cite only if relevant) ---
{knowledge}

--- THEIR MESSAGE ---
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

// ---------- custom-agent email drafter ----------

const CUSTOM_EMAIL_TOOL = "draft_custom_email"

const customEmailSchema = z
  .object({
    subject: z
      .string()
      .min(3)
      .max(180)
      .describe("Subject line. Make it scannable in an inbox preview."),
    body: z
      .string()
      .min(8)
      .max(1500)
      .describe(
        "Plain-text body signed '— Gradia at {shop_name}'. 3–6 sentences."
      ),
  })
  .describe(
    "Email matching the operator's intent. No prices, no commitments."
  )

const CUSTOM_EMAIL_SYSTEM = `${GRADIA_IDENTITY} ${GRADIA_VOICE} The shop owner set up a custom agent that fires on an event (a payment, a booking, etc.). For each event the agent matches, write one short email the owner will approve before it sends.

Tone rules:
- Speak as "we" and "us" — never "I", "me", or "my".
- Warm, specific, brief. Match the operator's intent exactly.

Hard rules:
- Plain text only. No HTML, no markdown.
- Never quote a price or confirm a new commitment.
- ${GRADIA_SIGNATURE_RULE}`

const CUSTOM_EMAIL_HUMAN = `Draft a custom-agent email via the ${CUSTOM_EMAIL_TOOL} tool.

Shop name: {shop_name}
Customer name: {customer_name}
Service / context (if known): {service}
When (if relevant): {when}

--- OUR SHOP (services + policies; lean on this, never invent or contradict it) ---
{knowledge}

--- INTENT (from our owner) ---
{intent}`

const customEmailPrompt = ChatPromptTemplate.fromMessages([
  ["system", CUSTOM_EMAIL_SYSTEM],
  ["human", CUSTOM_EMAIL_HUMAN],
])

export async function draftCustomEmailForCustomer(input: {
  shopName: string
  customerName: string
  service: string | null
  when: string | null
  intent: string
  /** Shop services + knowledge block — grounds the draft in real facts. */
  knowledge?: string | null
}): Promise<EmailDraft | null> {
  const llm = new ChatAnthropic({
    model: CLAUDE_MODEL,
    temperature: 0.4,
    maxTokens: 1024,
    apiKey: anthropicKey(),
  }).withStructuredOutput(customEmailSchema, { name: CUSTOM_EMAIL_TOOL })

  const chain = customEmailPrompt.pipe(llm)
  const raw = await chain.invoke({
    shop_name: input.shopName.trim() || "the shop",
    customer_name: input.customerName.trim() || "there",
    service: input.service?.trim() || "(not specified)",
    when: input.when?.trim() || "(not specified)",
    knowledge: input.knowledge?.trim() || "(no shop notes on file yet)",
    intent: input.intent.trim() || "send a warm note",
  })

  const parsed = customEmailSchema.parse(raw)
  const subject = parsed.subject.trim()
  const body = parsed.body.trim()
  if (!subject || !body) return null
  return { subject, body }
}

// ---------- appointment reminder email drafter ----------

const REMINDER_TOOL = "draft_appointment_reminder_email"

const reminderSchema = z
  .object({
    subject: z
      .string()
      .min(3)
      .max(180)
      .describe(
        "Reminder subject line. Reference the day or the service to make it scannable."
      ),
    body: z
      .string()
      .min(8)
      .max(1500)
      .describe(
        "Plain-text reminder body signed '— Gradia at {shop_name}'. 3-5 sentences."
      ),
  })
  .describe(
    "Appointment reminder email for the day before. Warm, scannable, never confirms a new commitment."
  )

const REMINDER_SYSTEM = `${GRADIA_IDENTITY} ${GRADIA_VOICE} You're drafting a reminder email about an upcoming appointment. The shop owner will approve before it sends.

Rules:
- Speak as "we" and "us" — never "I", "me", or "my".
- Restate the service + day + time so the customer can verify on a glance.
- One optional next step ("anything we should know in advance, just hit reply").
- Don't change the booking. Don't quote a price.
- Plain text, no HTML or markdown.
- Sign with: — Gradia at {shop_name}`

const REMINDER_HUMAN = `Draft the reminder via the ${REMINDER_TOOL} tool.

Shop name: {shop_name}
Customer first name: {first_name}
Service: {service}
When (customer's local time): {when_text}
Vehicle (if known): {vehicle}`

const reminderPrompt = ChatPromptTemplate.fromMessages([
  ["system", REMINDER_SYSTEM],
  ["human", REMINDER_HUMAN],
])

function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] || full
}

function formatWhen(iso: string, timezone: string | null): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const opts: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone ?? undefined,
    timeZoneName: timezone ? "short" : undefined,
  }
  return new Intl.DateTimeFormat("en-US", opts).format(d)
}

export async function draftAppointmentReminderEmail(input: {
  shopName: string
  customerName: string
  service: string | null
  isoStartTime: string
  timezone: string | null
  vehicle: string | null
}): Promise<EmailDraft | null> {
  const llm = new ChatAnthropic({
    model: CLAUDE_MODEL,
    temperature: 0.4,
    maxTokens: 1024,
    apiKey: anthropicKey(),
  }).withStructuredOutput(reminderSchema, { name: REMINDER_TOOL })

  const chain = reminderPrompt.pipe(llm)
  const raw = await chain.invoke({
    shop_name: input.shopName.trim() || "the shop",
    first_name: firstName(input.customerName) || "there",
    service: input.service?.trim() || "your detail",
    when_text: formatWhen(input.isoStartTime, input.timezone),
    vehicle: input.vehicle?.trim() || "(not specified)",
  })

  const parsed = reminderSchema.parse(raw)
  const subject = parsed.subject.trim()
  const body = parsed.body.trim()
  if (!subject || !body) return null
  return { subject, body }
}

export async function draftEmailReply(input: {
  shopName: string
  from: string
  subject: string
  body: string
  summary: string
  service: string
  vehicle: string
  /** Optional shop knowledge (FAQs, policies, brand voice). */
  knowledge?: string
}): Promise<EmailDraft | null> {
  const llm = new ChatAnthropic({
    model: CLAUDE_MODEL,
    temperature: 0.4,
    maxTokens: 1024,
    apiKey: anthropicKey(),
  }).withStructuredOutput(schema, { name: TOOL_NAME })

  const chain = prompt.pipe(llm)
  const raw = await chain.invoke({
    shop_name: input.shopName.trim() || "the shop",
    from: input.from.trim() || "(unknown)",
    subject: input.subject.trim() || "(no subject)",
    summary: input.summary.trim() || "(no summary)",
    service: input.service.trim() || "(not specified)",
    vehicle: input.vehicle.trim() || "(not specified)",
    knowledge: input.knowledge?.trim() || "(no knowledge yet — keep it generic)",
    body: input.body.trim().slice(0, MAX_BODY_CHARS) || "(empty body)",
  })

  const parsed = schema.parse(raw)
  const subject = parsed.subject.trim()
  const body = parsed.body.trim()
  if (!subject || !body) return null
  return { subject, body }
}
