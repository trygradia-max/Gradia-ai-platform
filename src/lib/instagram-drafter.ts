/**
 * Drafts outbound IG DMs. Two flavors:
 *   - `draftInstagramReply` — reply to an inbound DM (uses the
 *     incoming message + classifier extraction).
 *   - `draftCustomInstagramDm` — generic intent-driven draft (future
 *     event-recipe or operator-propose path).
 *
 * Same hand-rolled Anthropic shape we use everywhere else.
 */

import { ChatAnthropic } from "@langchain/anthropic"
import { ChatPromptTemplate } from "@langchain/core/prompts"
import { z } from "zod"

const CLAUDE_MODEL = "claude-haiku-4-5-20251001"
const REPLY_TOOL = "draft_instagram_reply"
const CUSTOM_TOOL = "draft_custom_instagram_dm"

const replySchema = z
  .object({
    reply: z
      .string()
      .min(1)
      .max(900)
      .describe(
        "DM body, signed '— Gradia at {shop_name}'. Two short sentences max; IG DMs read better short than long."
      ),
  })
  .describe(
    "A reply to an inbound IG DM. Warm, short, no prices, no commitments."
  )

const REPLY_SYSTEM = `You are Gradia, the AI partner for an auto detailing shop. You're drafting an Instagram DM reply to someone who just messaged us. The shop owner will approve before it sends — make the approval fast by writing what they'd actually send.

Tone rules:
- Speak as "we" and "us" — never "I".
- Short. Two sentences max. IG DMs aren't email.
- Casual but specific. No corporate filler.

Hard rules:
- Never quote a price. If they asked about pricing, say something like "happy to send a quick quote once we know the year/make."
- Never confirm a specific time. Suggest one or ask one question.
- Always sign with: — Gradia at {shop_name}`

const REPLY_HUMAN = `Draft a reply via the ${REPLY_TOOL} tool.

Shop name: {shop_name}
Customer (if known): {customer_name}
Vehicle (if mentioned): {vehicle}
Service (if mentioned): {service}

--- THEIR DM ---
{body}`

const replyPrompt = ChatPromptTemplate.fromMessages([
  ["system", REPLY_SYSTEM],
  ["human", REPLY_HUMAN],
])

function anthropicKey(): string {
  const k = process.env.ANTHROPIC_API_KEY?.trim()
  if (!k) throw new Error("ANTHROPIC_API_KEY is not configured")
  return k
}

const MAX_BODY_CHARS = 2_000

export async function draftInstagramReply(input: {
  shopName: string
  customerName: string
  vehicle: string
  service: string
  body: string
}): Promise<string | null> {
  const llm = new ChatAnthropic({
    model: CLAUDE_MODEL,
    temperature: 0.4,
    maxTokens: 400,
    apiKey: anthropicKey(),
  }).withStructuredOutput(replySchema, { name: REPLY_TOOL })

  const chain = replyPrompt.pipe(llm)
  const raw = await chain.invoke({
    shop_name: input.shopName.trim() || "the shop",
    customer_name: input.customerName.trim() || "(unknown)",
    vehicle: input.vehicle.trim() || "(not specified)",
    service: input.service.trim() || "(not specified)",
    body: input.body.trim().slice(0, MAX_BODY_CHARS) || "(empty body)",
  })
  const parsed = replySchema.parse(raw)
  const reply = parsed.reply.trim()
  return reply || null
}

// ---------- custom-intent IG DM drafter ----------

const customSchema = z
  .object({
    reply: z
      .string()
      .min(1)
      .max(900)
      .describe(
        "DM body matching the operator's intent. Signed '— Gradia at {shop_name}'."
      ),
  })
  .describe("Generic IG DM matching the operator's intent.")

const CUSTOM_SYSTEM = `You are Gradia, the AI partner for an auto detailing shop. The shop owner set up an agent that fires on a schedule or event. Write one IG DM matching their stated intent; they'll approve before it sends.

Tone rules:
- "We" and "us", never "I".
- Two sentences max — IG, not email.

Hard rules:
- No prices, no commitments.
- Always sign: — Gradia at {shop_name}`

const CUSTOM_HUMAN = `Draft a custom IG DM via the ${CUSTOM_TOOL} tool.

Shop name: {shop_name}
Customer name: {customer_name}

--- INTENT (from our owner) ---
{intent}`

const customPrompt = ChatPromptTemplate.fromMessages([
  ["system", CUSTOM_SYSTEM],
  ["human", CUSTOM_HUMAN],
])

export async function draftCustomInstagramDm(input: {
  shopName: string
  customerName: string
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
    customer_name: input.customerName.trim() || "there",
    intent: input.intent.trim() || "send a brief friendly check-in",
  })
  const parsed = customSchema.parse(raw)
  const reply = parsed.reply.trim()
  return reply || null
}
