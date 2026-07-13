/**
 * Whisper customer summary (C6b) — "3 jobs, $1,840 LTV, coating Aug 2025,
 * prefers text." The FACT PACK is pure code over DB rows (fixture-tested);
 * the single-turn worker may only rephrase the listed facts — and when the
 * model is unavailable the deterministic fact line ships as-is, so the
 * surface never fabricates and never blocks.
 */

import { ChatAnthropic } from "@langchain/anthropic"
import { ChatPromptTemplate } from "@langchain/core/prompts"

import { formatPriceUsd } from "@/lib/service-pricing"

const CLAUDE_MODEL = "claude-haiku-4-5-20251001"

export type CustomerFactInput = {
  name: string | null
  completedJobsCount: number
  lifetimeValueCents: number
  lastServiceAt: string | null
  vehicles: string[]
  upcomingAppointmentAt: string | null
  outstandingQuotesCount: number
  outstandingQuotesCents: number
  /** Inbound message counts per channel — preference evidence. */
  inboundByChannel: Record<string, number>
  lastInboundAt: string | null
  doNotContact: boolean
}

function monthYear(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    year: "numeric",
  })
}

/** Pure: DB rows → the exact fact lines the worker may use. */
export function buildCustomerFacts(input: CustomerFactInput): string[] {
  const facts: string[] = []
  if (input.completedJobsCount > 0) {
    facts.push(
      `${input.completedJobsCount} completed job${input.completedJobsCount === 1 ? "" : "s"}`
    )
  } else {
    facts.push("no completed jobs yet")
  }
  if (input.lifetimeValueCents > 0) {
    facts.push(`${formatPriceUsd(input.lifetimeValueCents)} lifetime value`)
  }
  if (input.lastServiceAt) {
    facts.push(`last serviced ${monthYear(input.lastServiceAt)}`)
  }
  for (const v of input.vehicles.slice(0, 3)) {
    facts.push(`drives a ${v}`)
  }
  if (input.upcomingAppointmentAt) {
    facts.push(
      `upcoming appointment ${new Date(input.upcomingAppointmentAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
    )
  }
  if (input.outstandingQuotesCount > 0) {
    facts.push(
      `${input.outstandingQuotesCount} open quote${input.outstandingQuotesCount === 1 ? "" : "s"} worth ${formatPriceUsd(input.outstandingQuotesCents)}`
    )
  }
  const channels = Object.entries(input.inboundByChannel).filter(([, n]) => n > 0)
  if (channels.length > 0) {
    const top = channels.sort((a, b) => b[1] - a[1])[0][0]
    facts.push(`prefers ${top === "sms" ? "text" : top}`)
  }
  if (input.lastInboundAt) {
    facts.push(`last heard from them ${monthYear(input.lastInboundAt)}`)
  }
  if (input.doNotContact) {
    facts.push("marked do-not-contact")
  }
  return facts
}

/** The always-available deterministic summary (also the LLM fallback). */
export function deterministicSummary(facts: string[]): string {
  if (facts.length === 0) return "Nothing on file yet."
  const line = facts.join(" · ")
  return line.charAt(0).toUpperCase() + line.slice(1) + "."
}

const prompt = ChatPromptTemplate.fromMessages([
  [
    "system",
    "You compress customer facts for a busy detail-shop owner. Rules: use ONLY the facts listed — never add, infer, estimate, or embellish anything (no numbers, dates, names, or preferences that are not in the list). One or two short sentences, plain English, no greeting.",
  ],
  ["human", "FACTS:\n{facts}\n\nWrite the summary."],
])

/** Single-turn rephrase of the fact pack; falls back to the deterministic
 *  line on any failure. Caller meters the run (whisper_note). */
export async function summarizeFacts(facts: string[]): Promise<string> {
  const fallback = deterministicSummary(facts)
  const key = process.env.ANTHROPIC_API_KEY?.trim()
  if (!key || facts.length === 0) return fallback
  try {
    const llm = new ChatAnthropic({
      model: CLAUDE_MODEL,
      temperature: 0,
      maxTokens: 200,
      apiKey: key,
    })
    const result = await prompt.pipe(llm).invoke({
      facts: facts.map((f) => `- ${f}`).join("\n"),
    })
    const text = typeof result.content === "string" ? result.content.trim() : ""
    return text || fallback
  } catch (err) {
    console.warn("[whisper-summary] worker failed — deterministic fallback:", err)
    return fallback
  }
}
