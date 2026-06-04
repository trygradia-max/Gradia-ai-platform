/**
 * Auto-drafts a short, on-brand SMS reply to an inbound lead. The
 * draft is staged as a `send_sms` pending_action — operators approve
 * (or edit) in Slack before it actually sends.
 *
 * Constraints baked into the prompt:
 *   - We/us voice (HUMAN.md), not "I" or "you and I"
 *   - Under 160 chars when possible (single SMS segment, cheaper +
 *     no Twilio segmentation surprises)
 *   - One concrete next step (book a time, send their best number,
 *     confirm vehicle, etc.) — never a hard commitment
 *   - Never quote a specific price (we don't have menu in scope here)
 *   - Always sign as "— Gradia at {shop_name}" per OPERATIONS.md
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
const TOOL_NAME = "draft_sms_reply"

const schema = z
  .object({
    reply: z
      .string()
      .min(1)
      .max(320)
      .describe(
        "The drafted SMS reply, signed as '— Gradia at {shop_name}'. Aim for under 160 characters when possible."
      ),
  })
  .describe(
    "One short, warm reply ready for human approval. No prices, no hard commitments, one clear next step."
  )

export type SmsDraft = z.infer<typeof schema>

const SYSTEM = `${GRADIA_IDENTITY} ${GRADIA_VOICE} You're drafting a single SMS reply to a new customer who just texted us. The shop owner will approve before it sends — your job is to make the approval as fast and friction-free as possible by writing something they'd actually send.

Tone rules:
- Speak as "we" and "us" — never "I", "me", "my", or "you and I".
- Warm, confident, specific. No corporate hedging.
- One clear next step the customer can take (e.g., "want us to send some times?", "what day works?", "got a year/make/model handy?"). Never two questions.
- Acknowledge what they asked about specifically when the summary tells you what they want.

Hard rules:
- Never quote a price unless the shop knowledge below explicitly states one. When in doubt, say "we'll send pricing in a sec".
- Never confirm a specific time or commitment. The owner approves first; promising anything now is a lie.
- If the shop knowledge mentions a policy that applies (deposit, weather, hours, etc.), weave it in naturally — don't invent policies that aren't there.
- ${GRADIA_SIGNATURE_RULE}
- Aim for under 160 characters total. If you need more, cap at 320.`

const HUMAN = `Draft an SMS reply via the ${TOOL_NAME} tool.

Shop name: {shop_name}
Their phone: {from}
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

const MAX_BODY_CHARS = 4_000

export async function draftSmsReply(input: {
  shopName: string
  from: string
  body: string
  summary: string
  service: string
  vehicle: string
  /** Optional shop knowledge snippet (FAQs, policies, brand voice). */
  knowledge?: string
}): Promise<string | null> {
  const llm = new ChatAnthropic({
    model: CLAUDE_MODEL,
    temperature: 0.4,
    maxTokens: 400,
    apiKey: anthropicKey(),
  }).withStructuredOutput(schema, { name: TOOL_NAME })

  const chain = prompt.pipe(llm)
  const raw = await chain.invoke({
    shop_name: input.shopName.trim() || "the shop",
    from: input.from.trim() || "(unknown)",
    summary: input.summary.trim() || "(no summary)",
    service: input.service.trim() || "(not specified)",
    vehicle: input.vehicle.trim() || "(not specified)",
    knowledge: input.knowledge?.trim() || "(no knowledge yet — keep it generic)",
    body: input.body.trim().slice(0, MAX_BODY_CHARS) || "(empty body)",
  })

  const parsed = schema.parse(raw)
  const reply = parsed.reply.trim()
  return reply || null
}

// ---------- booking-confirmation drafter ----------

const CONFIRMATION_TOOL = "draft_booking_confirmation"

const confirmationSchema = z
  .object({
    reply: z
      .string()
      .min(1)
      .max(320)
      .describe(
        "Booking confirmation SMS, signed as '— Gradia at {shop_name}'. Under 160 chars ideally."
      ),
  })
  .describe(
    "Short, warm booking confirmation. Restate the service + day + time + duration. No new commitments."
  )

const CONFIRMATION_SYSTEM = `${GRADIA_IDENTITY} ${GRADIA_VOICE} You're drafting a confirmation SMS that goes to a customer right after the owner approves their booking. The owner will see and approve your draft before it sends — write something they'd actually send.

Tone rules:
- Speak as "we" and "us" — never "I", "me", or "my".
- Warm, confident, specific. Acknowledge the service + day + time clearly.
- One optional next step at most (e.g., "any prep questions, just text us back"). Don't load the message with multiple asks.

Hard rules:
- Restate the booking exactly as given. Don't change the time or service.
- Don't quote a price.
- Don't promise anything beyond what's in the booking.
- ${GRADIA_SIGNATURE_RULE}
- Aim for under 160 characters total. Cap at 320.`

const CONFIRMATION_HUMAN = `Draft a booking confirmation via the ${CONFIRMATION_TOOL} tool.

Shop name: {shop_name}
Customer first name: {first_name}
Service: {service}
When (human-readable): {when_text}
Duration: {duration_min} minutes
Vehicle (if known): {vehicle}`

const confirmationPrompt = ChatPromptTemplate.fromMessages([
  ["system", CONFIRMATION_SYSTEM],
  ["human", CONFIRMATION_HUMAN],
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

export async function draftBookingConfirmationSms(input: {
  shopName: string
  customerName: string
  service: string | null
  isoStartTime: string
  durationMinutes: number
  timezone: string | null
  vehicle: string | null
}): Promise<string | null> {
  const llm = new ChatAnthropic({
    model: CLAUDE_MODEL,
    temperature: 0.4,
    maxTokens: 400,
    apiKey: anthropicKey(),
  }).withStructuredOutput(confirmationSchema, { name: CONFIRMATION_TOOL })

  const chain = confirmationPrompt.pipe(llm)
  const raw = await chain.invoke({
    shop_name: input.shopName.trim() || "the shop",
    first_name: firstName(input.customerName) || "there",
    service: input.service?.trim() || "your detail",
    when_text: formatWhen(input.isoStartTime, input.timezone),
    duration_min: String(input.durationMinutes),
    vehicle: input.vehicle?.trim() || "(not specified)",
  })

  const parsed = confirmationSchema.parse(raw)
  const reply = parsed.reply.trim()
  return reply || null
}

// ---------- 24h appointment reminder drafter ----------

const REMINDER_TOOL = "draft_appointment_reminder"

const reminderSchema = z
  .object({
    reply: z
      .string()
      .min(1)
      .max(320)
      .describe(
        "Reminder SMS for an appointment ~24 hours out, signed as '— Gradia at {shop_name}'. Under 160 chars ideally."
      ),
  })
  .describe(
    "Short, warm reminder. Restate when + service, optional 'any prep, just text us' nudge. No new commitments, no pricing."
  )

const REMINDER_SYSTEM = `${GRADIA_IDENTITY} ${GRADIA_VOICE} You're drafting a 24-hour reminder SMS that goes to a customer the day before their appointment. The owner will approve before it sends.

Tone rules:
- Speak as "we" and "us" — never "I", "me", or "my".
- Warm and casual, like a friend reminding. Not corporate.
- Restate the service + day + time so the customer can verify.
- Optional: one soft "anything to know before we get started, just text us" nudge.

Hard rules:
- Don't change the time or service from what's given.
- Don't quote a price or make new commitments.
- ${GRADIA_SIGNATURE_RULE}
- Aim for under 160 characters. Cap at 320.`

const REMINDER_HUMAN = `Draft a 24h reminder via the ${REMINDER_TOOL} tool.

Shop name: {shop_name}
Customer first name: {first_name}
Service: {service}
When (human-readable, customer's local time): {when_text}
Vehicle (if known): {vehicle}`

const reminderPrompt = ChatPromptTemplate.fromMessages([
  ["system", REMINDER_SYSTEM],
  ["human", REMINDER_HUMAN],
])

// ---------- custom-agent SMS drafter ----------

const CUSTOM_TOOL = "draft_custom_sms"

const customSchema = z
  .object({
    reply: z
      .string()
      .min(1)
      .max(320)
      .describe(
        "SMS body signed as '— Gradia at {shop_name}'. Under 160 chars ideally. Honors the operator's intent."
      ),
  })
  .describe(
    "Short, warm message matching the operator's stated intent. No prices, no commitments, signed as us."
  )

const CUSTOM_SYSTEM = `${GRADIA_IDENTITY} ${GRADIA_VOICE} The shop owner set up a custom agent that fires on a schedule. For each customer/lead the agent matches, write one short SMS the owner will approve before it sends.

Tone rules:
- Speak as "we" and "us" — never "I", "me", or "my".
- Warm, specific, brief. The owner is approving on their phone between jobs.
- Match the stated intent exactly. If the intent says "follow up gently," don't push hard. If it says "thank them for paying," lead with that.

Hard rules:
- Never quote a price.
- Never confirm a specific time. Suggest one if the intent calls for it; never lock it in.
- ${GRADIA_SIGNATURE_RULE}
- Aim for under 160 characters total. Cap at 320.`

const CUSTOM_HUMAN = `Draft a custom-agent SMS via the ${CUSTOM_TOOL} tool.

Shop name: {shop_name}
Customer name: {customer_name}
Vehicle (if known): {vehicle}
Service / context (if known): {service}

--- INTENT (from our owner) ---
{intent}`

const customPrompt = ChatPromptTemplate.fromMessages([
  ["system", CUSTOM_SYSTEM],
  ["human", CUSTOM_HUMAN],
])

export async function draftCustomSmsForCustomer(input: {
  shopName: string
  customerName: string
  vehicle: string | null
  service: string | null
  intent: string
}): Promise<string | null> {
  const llm = new ChatAnthropic({
    model: CLAUDE_MODEL,
    temperature: 0.4,
    maxTokens: 400,
    apiKey: anthropicKey(),
  }).withStructuredOutput(customSchema, { name: CUSTOM_TOOL })

  const chain = customPrompt.pipe(llm)
  const raw = await chain.invoke({
    shop_name: input.shopName.trim() || "the shop",
    customer_name: firstName(input.customerName) || "there",
    vehicle: input.vehicle?.trim() || "(not specified)",
    service: input.service?.trim() || "(not specified)",
    intent: input.intent.trim() || "send a brief friendly check-in",
  })

  const parsed = customSchema.parse(raw)
  const reply = parsed.reply.trim()
  return reply || null
}

export async function draftAppointmentReminderSms(input: {
  shopName: string
  customerName: string
  service: string | null
  isoStartTime: string
  timezone: string | null
  vehicle: string | null
}): Promise<string | null> {
  const llm = new ChatAnthropic({
    model: CLAUDE_MODEL,
    temperature: 0.4,
    maxTokens: 400,
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
  const reply = parsed.reply.trim()
  return reply || null
}
