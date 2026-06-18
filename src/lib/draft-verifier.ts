/**
 * Cross-model draft verification — sharpening brief P1 ("de-noising").
 *
 * Before an outreach draft is staged to pending_actions, a SEPARATE critic
 * call runs on a DIFFERENT model than the drafter (Haiku drafts → Sonnet
 * verifies) so it's genuine cross-model review, not a model grading itself —
 * self-review has blind spots. It checks:
 *   1. persona/tone vs persona.ts (we/us, no first-person singular)
 *   2. factual grounding — a quoted price/service must exist in the menu
 *   3. compliance — no fabricated availability or hard commitments
 *   4. template-variable sanity (code-checked, no LLM needed)
 *
 * A failed check NEVER blocks staging — it flags the approval card with
 * the verifier's objections so the human sees why it smells off. Flagging
 * beats blocking: a false positive costs a glance; a silent block costs a
 * customer. The verifier is best-effort: an API error stages the draft
 * unverified (logged), because verification must not break the pipeline.
 *
 * Verifier calls are plumbing — never metered (trust rule).
 */

import { ChatAnthropic } from "@langchain/anthropic"
import { ChatPromptTemplate } from "@langchain/core/prompts"
import { z } from "zod"

import { GRADIA_SIGNATURE_RULE, GRADIA_VOICE } from "@/lib/persona"
import type { ServiceRow } from "@/lib/types/database"

// Sonnet 4.6 — a stronger, independent model than the Haiku drafters, so the
// verifier is a real second opinion. Unmetered plumbing (runs once per draft).
const CLAUDE_MODEL = "claude-sonnet-4-6"
const TOOL_NAME = "verify_draft"

export type VerifierResult = {
  /** False = the card gets flagged with the objections. */
  pass: boolean
  objections: string[]
  /** False when the LLM check couldn't run (no key / API error). */
  verified: boolean
}

export type DraftToVerify = {
  channel: "sms" | "email"
  body: string
  subject?: string | null
  customerName?: string | null
  shopName: string
  services: Pick<ServiceRow, "name" | "price_cents">[]
}

const verdictSchema = z.object({
  pass: z.boolean().describe("true when the draft is safe to stage as-is"),
  objections: z
    .array(z.string().max(200))
    .max(4)
    .describe("Specific, short problems — empty when pass is true"),
})

const critic = ChatPromptTemplate.fromMessages([
  [
    "system",
    `You are a skeptical reviewer for a detailing shop's outbound messages — a different reviewer than whoever wrote the draft. Your ONLY job is to catch real problems; do not rewrite, and do not nitpick.

Canonical voice (must match): ${GRADIA_VOICE}
Required sign-off — this is CORRECT, never flag it: ${GRADIA_SIGNATURE_RULE}

REQUIRED and correct — do NOT flag any of these (they are the house style, not violations):
- The sign-off "— Gradia at <shop name>". Signing as Gradia is the shop team's signature; it is NOT "identifying as an individual" and NOT a first-person-singular problem.
- Inviting the customer to book, reply, or get on the schedule ("ready to book?", "want us to get you in?"). That is an invitation, not a confirmation.
- Omitting prices, or keeping the message short.

Fail the draft ONLY if ANY of these hold:
- Tone: the MESSAGE BODY (not the signature) uses the singular "I", "me", or "my", or "you and I"; or it reads corporate or robotic.
- Grounding: quotes a price, or names a service, that is NOT on the menu provided. A price must match the menu exactly.
- Compliance: states a SPECIFIC time as booked or available ("see you Tuesday at 3", "we have Friday open") — we never confirm a slot, a human approves first; OR promises a discount that wasn't provided; OR keeps pressuring someone who asked to stop.
- Wrong recipient: greets a different name than the customer's.

Report at most 4 objections, each one concrete sentence. If none of the failure conditions hold, pass.`,
  ],
  [
    "human",
    `Channel: {channel}
Customer name: {customer_name}
Shop: {shop_name}
Service menu (the ONLY valid prices):
{menu}

Draft to review:
---
{draft}
---
Call ${TOOL_NAME} with your verdict.`,
  ],
])

/** Unreplaced template variables — pure code check, runs even without a key. */
export function templateSanityObjections(body: string): string[] {
  const objections: string[] = []
  const patterns: Array<[RegExp, string]> = [
    [/\{\{?\s*\w+\s*\}?\}/, "contains an unreplaced {placeholder}"],
    [/\[(?:name|customer|service|date|time|price)\]/i, "contains an unreplaced [bracket] variable"],
    [/\$\{\w+\}/, "contains an unreplaced ${template} variable"],
  ]
  for (const [re, message] of patterns) {
    if (re.test(body)) objections.push(`Draft ${message}.`)
  }
  return objections
}

type CriticInvoke = (input: {
  channel: string
  customer_name: string
  shop_name: string
  menu: string
  draft: string
}) => Promise<z.infer<typeof verdictSchema>>

function defaultInvoke(): CriticInvoke | null {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim()
  if (!apiKey) return null
  const llm = new ChatAnthropic({
    model: CLAUDE_MODEL,
    temperature: 0,
    maxTokens: 400,
    apiKey,
  }).withStructuredOutput(verdictSchema, { name: TOOL_NAME })
  const chain = critic.pipe(llm)
  return async (input) => verdictSchema.parse(await chain.invoke(input))
}

/**
 * Verifies one draft. `invoke` is injectable for tests; production uses
 * the Haiku critic. Code checks (template sanity) run regardless.
 */
export async function verifyDraft(
  draft: DraftToVerify,
  opts?: { invoke?: CriticInvoke | null }
): Promise<VerifierResult> {
  const codeObjections = templateSanityObjections(
    [draft.subject ?? "", draft.body].join("\n")
  )

  const invoke = opts?.invoke === undefined ? defaultInvoke() : opts.invoke
  if (!invoke) {
    return {
      pass: codeObjections.length === 0,
      objections: codeObjections,
      verified: false,
    }
  }

  try {
    const menu =
      draft.services
        .map((s) => `- ${s.name}: $${(s.price_cents / 100).toFixed(2)}`)
        .join("\n") || "(no menu on file — any quoted price is a fabrication)"
    const verdict = await invoke({
      channel: draft.channel,
      customer_name: draft.customerName?.trim() || "(unknown)",
      shop_name: draft.shopName,
      menu,
      draft: draft.subject ? `Subject: ${draft.subject}\n\n${draft.body}` : draft.body,
    })
    const objections = [...codeObjections, ...verdict.objections]
    return {
      pass: verdict.pass && codeObjections.length === 0,
      objections,
      verified: true,
    }
  } catch (err) {
    console.error("[draft-verifier] critic call failed:", err)
    return {
      pass: codeObjections.length === 0,
      objections: codeObjections,
      verified: false,
    }
  }
}

/** Payload fragment merged into pending_actions.payload when flagged. */
export function verifierPayloadFragment(
  result: VerifierResult
): Record<string, unknown> {
  if (result.pass) return {}
  return {
    verifier: {
      flagged: true,
      objections: result.objections,
      verified: result.verified,
    },
  }
}
