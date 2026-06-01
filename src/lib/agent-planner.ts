/**
 * Custom-agent planner. Operator describes a workflow in natural
 * language; Claude returns a structured AgentConfig via a single
 * forced tool call. We persist the result as a custom_agents row.
 *
 * The runtime that actually executes these (cron + condition engine +
 * action dispatcher) is a follow-up chunk. For now the planner just
 * captures intent in a readable, reviewable shape.
 *
 * Same hand-rolled Anthropic Messages API pattern as bi-agent.ts —
 * no LangChain abstraction needed for a single forced tool call.
 */

import { z } from "zod"

import type { AgentConfig } from "@/lib/types/database"

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages"
const ANTHROPIC_VERSION = "2023-06-01"
const MODEL = "claude-sonnet-4-6"
const MAX_TOKENS = 1024
const TOOL_NAME = "propose_agent"

const planSchema = z.object({
  name: z
    .string()
    .min(3)
    .max(80)
    .describe(
      "Short, human-friendly name for the agent. Imperative phrase like 'Quote follow-up after 7 days' or 'Daily revenue summary'."
    ),
  short_description: z
    .string()
    .min(8)
    .max(240)
    .describe(
      "One sentence in HUMAN.md voice (we/us) explaining what this agent does for us."
    ),
  trigger: z
    .object({
      kind: z.enum(["schedule", "event"]),
      schedule_summary: z
        .string()
        .optional()
        .describe(
          "If kind=schedule: a human-readable cadence like 'every day at 9am', 'every hour', 'every Monday morning'. Empty otherwise."
        ),
      event_summary: z
        .string()
        .optional()
        .describe(
          "If kind=event: a human-readable event the agent reacts to like 'when a lead lands in status quoted', 'when an invoice is paid', 'when a customer hasn't replied'. Empty otherwise."
        ),
    })
    .describe("What sets the agent off."),
  audience: z
    .object({
      entity: z
        .enum(["leads", "customers", "appointments", "interactions"])
        .describe(
          "Which kind of record the agent reads to find its targets. Picks the closest one — leads for sales/quote flows, customers for outreach, appointments for booking-day actions, interactions for thread-aware logic."
        ),
      filters_summary: z
        .array(z.string().min(2).max(200))
        .min(1)
        .max(6)
        .describe(
          "Plain-English bullets describing how we narrow down the audience. e.g., 'still in quoted status', 'older than 7 days', 'no inbound text in last 3 days'."
        ),
    })
    .describe("How the agent picks who/what to act on."),
  action: z
    .object({
      kind: z
        .enum(["draft_sms", "draft_email", "log_note", "flag_for_review"])
        .describe(
          "What the agent produces. Outbound messages (draft_sms / draft_email) always go through HITL — we approve before send. log_note records a note in shared memory. flag_for_review surfaces something to the operator without sending anything."
        ),
      intent_summary: z
        .string()
        .min(8)
        .max(400)
        .describe(
          "Plain-English description of the message intent or note content. e.g., 'a warm nudge to come back and book if they're still interested'."
        ),
    })
    .describe("What the agent does for each target."),
  prerequisites_needed: z
    .array(z.string().min(2).max(120))
    .max(8)
    .describe(
      "Integrations/secrets this agent depends on. Pull from this menu: 'Twilio number connected', 'Gmail connected via Aurinko', 'Stripe Connect onboarded', 'Vapi assistant connected', 'Anthropic key on server', 'OpenAI key on server', 'Cron secret on server'. Empty array if no special prereqs."
    ),
  human_in_the_loop_note: z
    .string()
    .min(8)
    .max(300)
    .describe(
      "One sentence reminding the operator about the HITL gate for this specific agent. Default: 'Every outbound message still lands as a Slack approval card before it actually sends.'"
    ),
  recipe: z
    .discriminatedUnion("id", [
      z.object({
        id: z.literal("lead_followup_sms"),
        params: z.object({
          status: z
            .enum(["new", "quoted", "booked"])
            .describe(
              "Lead status to target. 'quoted' is most common for follow-ups; 'new' for re-engagement; 'booked' rare."
            ),
          min_lead_age_days: z
            .number()
            .int()
            .min(1)
            .max(180)
            .describe(
              "Only target leads created at least this many days ago."
            ),
          no_inbound_within_days: z
            .number()
            .int()
            .min(1)
            .max(180)
            .describe(
              "Skip leads where the customer reached out to us in the last N days."
            ),
        }),
      }),
      z.object({
        id: z.literal("appointment_reminder_email"),
        params: z.object({
          hours_before: z
            .number()
            .int()
            .min(1)
            .max(168)
            .describe(
              "How many hours before the appointment to send. 24 is the canonical day-before reminder."
            ),
          window_hours: z
            .number()
            .int()
            .min(1)
            .max(24)
            .describe(
              "Half-width of the matching window. With hours_before=24 + window_hours=1, appointments 23–25h out qualify each tick. Pair this with hourly cadence so nothing slips through."
            ),
        }),
      }),
      z.object({
        id: z.literal("stale_customer_sms"),
        params: z.object({
          inactive_days: z
            .number()
            .int()
            .min(7)
            .max(365)
            .describe(
              "Customer's last interaction must be at least this many days ago. 30–90 is typical for re-engagement."
            ),
          cooldown_days: z
            .number()
            .int()
            .min(7)
            .max(365)
            .describe(
              "Don't re-message the same customer about staleness more than once per this many days."
            ),
        }),
      }),
      z.object({
        id: z.literal("payment_received_thank_you_sms"),
        params: z
          .object({})
          .describe(
            "No params today. EVENT-DRIVEN — fires when a Stripe invoice is paid. OMIT the schedule field for this recipe."
          ),
      }),
      z.object({
        id: z.literal("booking_approved_prep_email"),
        params: z
          .object({})
          .describe(
            "No params today. EVENT-DRIVEN — fires when a booking approval lands. OMIT the schedule field for this recipe."
          ),
      }),
    ])
    .optional()
    .describe(
      "Machine-executable mapping. Pick ONE recipe id that fits the problem:\n\nSCHEDULED (require a schedule):\n• 'lead_followup_sms' — leads in a given status, older than N days, no inbound recently → drafts an SMS.\n• 'appointment_reminder_email' — drafts an email reminder ~N hours before a booked appointment. Pair with hourly cadence.\n• 'stale_customer_sms' — drafts an SMS to customers whose last interaction is N+ days ago.\n\nEVENT-DRIVEN (omit the schedule field):\n• 'payment_received_thank_you_sms' — fires when a Stripe invoice is paid; drafts a thank-you SMS.\n• 'booking_approved_prep_email' — fires when a booking approval lands an appointment; drafts a prep email.\n\nOMIT recipe entirely if no recipe fits — the plan still saves but won't run."
    ),
  freeform: z
    .object({
      entity: z
        .enum(["leads", "customers"])
        .describe(
          "Which records to target. 'leads' for sales/quote follow-ups (SMS only — leads carry a phone, not an email). 'customers' for re-engagement (SMS or email)."
        ),
      channel: z
        .enum(["sms", "email"])
        .describe("How we reach them. 'email' requires entity=customers."),
      filters: z
        .object({
          lead_status: z
            .enum(["new", "quoted", "booked"])
            .optional()
            .describe("leads only: target this lead status."),
          min_age_days: z
            .number()
            .int()
            .min(0)
            .max(365)
            .optional()
            .describe("Record created at least this many days ago."),
          max_age_days: z
            .number()
            .int()
            .min(0)
            .max(3650)
            .optional()
            .describe("Record created at most this many days ago."),
          no_inbound_within_days: z
            .number()
            .int()
            .min(1)
            .max(365)
            .optional()
            .describe(
              "Skip targets who contacted us within the last N days — don't pester mid-conversation."
            ),
          inactive_days: z
            .number()
            .int()
            .min(1)
            .max(365)
            .optional()
            .describe(
              "customers only: their last interaction is at least this many days ago."
            ),
          keyword: z
            .string()
            .min(2)
            .max(60)
            .optional()
            .describe(
              "Case-insensitive keyword matched against name / vehicle / notes — e.g. 'ceramic', 'Tesla'."
            ),
        })
        .describe("Whitelisted filters that narrow the audience. No raw SQL."),
      message_intent: z
        .string()
        .min(8)
        .max(400)
        .describe(
          "Plain-English intent for the per-recipient message, in we/us voice."
        ),
      max_recipients: z
        .number()
        .int()
        .min(1)
        .max(200)
        .describe("Hard cap on recipients per run. Default 50."),
      cooldown_days: z
        .number()
        .int()
        .min(1)
        .max(365)
        .describe(
          "Don't re-contact the same recipient within this many days. Default 30."
        ),
    })
    .optional()
    .describe(
      "Machine-executable FREE-FORM outreach. Use ONLY when no recipe fits but the ask is still SMS/email outreach to a queryable audience of leads or customers (e.g. 'text leads who got a ceramic quote and never booked'). Outbound is ALWAYS HITL — every drafted message becomes an approval card. NEVER emit both a recipe and a freeform block. Pair with a schedule."
    ),
  schedule: z
    .object({
      cadence: z.enum(["hourly", "daily", "weekly"]),
      hour_of_day: z
        .number()
        .int()
        .min(0)
        .max(23)
        .optional()
        .describe(
          "For daily/weekly: 0-23 UTC. Default to 14 (~9am ET / 6am PT) if unspecified."
        ),
      day_of_week: z
        .number()
        .int()
        .min(0)
        .max(6)
        .optional()
        .describe(
          "For weekly cadence: 0=Sunday … 6=Saturday. Pick Monday (1) if unspecified."
        ),
    })
    .optional()
    .describe("Machine-executable schedule. Required when recipe is present."),
})

export type PlanResult =
  | { ok: true; config: AgentConfig }
  | { ok: false; error: string }

const SYSTEM = `You are Gradia, an AI partner planning a custom workflow for an auto detailing shop. The shop owner has described a problem in their own words. Use the ${TOOL_NAME} tool to translate that into a clean, reviewable plan.

Tone:
- Speak as "we" and "us" everywhere — this is a partner thinking through the work with them.
- Warm, specific, concrete.

Constraints — DO NOT propose anything outside Gradia's actual surfaces:
- Triggers are either a schedule (cron-style cadence) or an event we observe (lead lands, invoice paid, no reply within N days, appointment booked, etc.).
- Audience entities: leads, customers, appointments, interactions.
- Actions: draft_sms, draft_email, log_note, flag_for_review. Outbound is ALWAYS HITL-gated — never describe it as auto-sending.
- Be honest about prerequisites. Outbound SMS needs Twilio. Outbound email needs Gmail. Don't promise capabilities the shop hasn't wired up.

If the operator's problem is vague, pick the most reasonable interpretation and reflect it back via the name + short_description. If it's outside Gradia's scope (general AI chat, web scraping, calling APIs we don't have), still return a plan but flag the constraint in prerequisites_needed.

Recipe vs. free-form: prefer a known recipe when one fits. When the ask is outreach to a queryable audience of leads or customers (SMS or email) but no recipe matches — e.g. "text leads who got a ceramic quote and never booked" — emit a structured \`freeform\` block instead (entity, channel, whitelisted filters, message_intent, max_recipients, cooldown_days) and pair it with a schedule. Free-form outbound is ALWAYS HITL. Never emit both a recipe and a freeform block.`

const HUMAN = `The shop owner says:

--- PROBLEM ---
{problem}

Propose an agent for them via the ${TOOL_NAME} tool.`

function apiKey(): string {
  const k = process.env.ANTHROPIC_API_KEY?.trim()
  if (!k) throw new Error("ANTHROPIC_API_KEY is not configured")
  return k
}

type AnthropicToolUseBlock = {
  type: "tool_use"
  id: string
  name: string
  input: Record<string, unknown>
}
type AnthropicTextBlock = { type: "text"; text: string }
type AnthropicContentBlock = AnthropicToolUseBlock | AnthropicTextBlock

type AnthropicResponse = { content: AnthropicContentBlock[] }

export async function planAgentFromProblem(problem: string): Promise<PlanResult> {
  const trimmed = problem.trim()
  if (!trimmed) return { ok: false, error: "Tell us what you want this agent to do." }
  if (trimmed.length > 2_000) {
    return { ok: false, error: "Keep the problem description under 2,000 characters." }
  }

  let response: AnthropicResponse
  try {
    const res = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers: {
        "x-api-key": apiKey(),
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM,
        tools: [
          {
            name: TOOL_NAME,
            description: "Stage the planned agent for the operator to review.",
            input_schema: z.toJSONSchema(planSchema),
          },
        ],
        tool_choice: { type: "tool", name: TOOL_NAME },
        messages: [
          {
            role: "user",
            content: HUMAN.replace("{problem}", trimmed),
          },
        ],
      }),
    })
    const raw = await res.text()
    if (!res.ok) {
      return {
        ok: false,
        error: `Anthropic (${res.status}): ${raw.slice(0, 280)}`,
      }
    }
    response = JSON.parse(raw) as AnthropicResponse
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Planner request failed.",
    }
  }

  const toolUse = response.content.find(
    (b): b is AnthropicToolUseBlock => b.type === "tool_use" && b.name === TOOL_NAME
  )
  if (!toolUse) {
    return { ok: false, error: "We couldn't shape a plan from that — try rephrasing." }
  }

  const parsed = planSchema.safeParse(toolUse.input)
  if (!parsed.success) {
    return {
      ok: false,
      error:
        parsed.error.issues[0]?.message ??
        "The plan came back malformed — try again.",
    }
  }

  return { ok: true, config: parsed.data as AgentConfig }
}
