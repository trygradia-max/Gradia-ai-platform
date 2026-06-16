/**
 * Gradia Agent — the owner's single conversational box that both ANSWERS
 * questions about the business and ACTS on the CRM (outreach), in one turn.
 * The merge of "Ask Gradia" (read) and the custom-agent engine (act).
 *
 * Architecture (GRADIA_AGENT_MERGE_BRIEF.md §7 — the loop lives in exactly one
 * layer):
 *   - CONVERSATION LAYER (this loop, bounded): owner msg → LLM with READ tools
 *     + a stage tool → reason / preview / PROPOSE. It can NEVER send. The only
 *     write it can trigger is staging into pending_actions, which still goes to
 *     the human gate in /approvals.
 *   - EXECUTION LAYER (deterministic, no loop): stageOutreachPlan resolves the
 *     guardrailed audience, drafts per recipient, and stages each for approval.
 *
 * Tools: the read-only BI tools (counts, segments, memory, setup) PLUS
 *   - preview_outreach  — dry-run: resolve audience + draft 2–3 samples + cost.
 *   - stage_outreach    — queue per-recipient drafts into /approvals. NEVER
 *                          sends; called only after the owner confirms in chat.
 * There is deliberately NO send tool (locked principles #1/#2). Booking/money
 * are out of scope for this box and stay in their own HITL flows.
 *
 * Reuses bi-agent's streamOneTurn (the proven SSE parser) with its own system
 * prompt + toolset.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import { resolveAgentMode } from "@/lib/autonomy"
import {
  streamOneTurn,
  type AgentEvent,
  type AnthropicToolUseBlock,
  type ChatMessage,
  type StreamTurnResult,
  type WireMessage,
  type WireToolResult,
} from "@/lib/bi-agent"
import { BI_TOOLS, findBiTool } from "@/lib/bi-tools"
import { precheckCredits, recordUsage } from "@/lib/credits"
import { GRADIA_IDENTITY, GRADIA_VOICE } from "@/lib/persona"
import { getPricing, priceUsage } from "@/lib/pricing"
import { stageOutreachPlan } from "@/lib/agent-runtime"
import type { FreeformPlan, ShopRow } from "@/lib/types/database"

const MAX_TURNS = 8

const OWNER_SYSTEM_PROMPT = `${GRADIA_IDENTITY}

You are the shop owner's assistant — you answer questions about their business AND take action on their CRM when they ask. You are talking to the OWNER, not a customer.

${GRADIA_VOICE}

What you can do:
- ANSWER questions about the shop using the read tools (lead counts, recent leads, customers, channel volume, upcoming appointments, memory search, revenue, heat scores, setup status). Always call a tool for data — never guess a number.
- ACT on outreach: text or email a segment of leads/customers (follow-ups, win-backs, reminders, announcements).

How to take an action — ALWAYS this sequence, no shortcuts:
1. Call preview_outreach first. It returns the exact recipient count, why people were skipped, a cost estimate, and 2–3 real sample messages. NOTHING is sent or staged by a preview.
2. Show the owner the count, the cost, and the samples, then ASK for explicit confirmation ("Want us to stage these 23 texts for your approval?").
3. Only after the owner clearly says yes, call stage_outreach. This queues a draft per recipient in the owner's Approvals inbox — it does NOT send. The owner sends from /approvals.

Hard rules:
- You can only preview and stage. You cannot send, book, reschedule, charge, or move money — never claim you did. If asked, explain those happen elsewhere (Approvals for sends; the calendar for bookings).
- Segments are built from a fixed set of filters: lead status, record age (min/max days), recent-inbound window, customer inactivity, and a keyword (matched against name / vehicle / notes). If the owner asks to segment by something outside this set (lifetime spend, exact vehicle year, location), say so honestly and offer the closest thing you CAN do — never pretend a filter exists.
- Respect the guardrails: outreach is capped (default 50 recipients), cooled down, and opt-outs are honored — these are applied automatically; surface them when the count comes back smaller than expected.
- Keep it short and concrete. The owner is between jobs.`

const OWNER_SYSTEM_BLOCKS = [
  {
    type: "text" as const,
    text: OWNER_SYSTEM_PROMPT,
    cache_control: { type: "ephemeral" as const },
  },
]

// ---------- the two action tools ----------

const outreachSchema = z
  .object({
    entity: z.enum(["leads", "customers"]),
    channel: z.enum(["sms", "email"]),
    message_intent: z
      .string()
      .min(3)
      .max(500)
      .describe("plain-English intent; drafted per recipient in we/us voice"),
    filters: z
      .object({
        lead_status: z.enum(["new", "quoted", "booked"]).optional(),
        min_age_days: z.number().int().min(0).max(3650).optional(),
        max_age_days: z.number().int().min(0).max(3650).optional(),
        no_inbound_within_days: z.number().int().min(0).max(3650).optional(),
        inactive_days: z.number().int().min(0).max(3650).optional(),
        keyword: z.string().max(60).optional(),
      })
      .default({}),
    max_recipients: z.number().int().min(1).max(200).optional(),
  })
  .describe(
    "An outreach plan over a whitelisted segment. Used for both preview and stage."
  )

type OutreachArgs = z.infer<typeof outreachSchema>

const DEFAULT_MAX_RECIPIENTS = 50
const DEFAULT_COOLDOWN_DAYS = 7
// Rough cost per recipient: 1 draft credit + the send (sms segment 4 / email 1).
const PER_RECIPIENT_CREDITS = { sms: 5, email: 2 } as const

function toPlan(args: OutreachArgs): FreeformPlan {
  return {
    entity: args.entity,
    channel: args.channel,
    filters: args.filters ?? {},
    message_intent: args.message_intent,
    max_recipients: Math.min(args.max_recipients ?? DEFAULT_MAX_RECIPIENTS, 200),
    cooldown_days: DEFAULT_COOLDOWN_DAYS,
  }
}

/** Channel must be wired before we can draft/stage for it. */
function channelBlock(shop: ShopRow, channel: "sms" | "email"): string | null {
  if (channel === "sms" && !shop.twilio_phone_number) {
    return "No business number is connected yet, so we can't text. Connect one in Settings first."
  }
  if (channel === "email" && !shop.aurinko_access_token_enc) {
    return "Email isn't connected yet (Gmail), so we can't send email. Connect it in Settings first."
  }
  return null
}

function buildOwnerToolDefinitions(): unknown[] {
  const read = BI_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: z.toJSONSchema(t.schema),
  }))
  const action = [
    {
      name: "preview_outreach",
      description:
        "Dry-run an outreach plan: resolve the guardrailed audience and draft 2–3 real sample messages WITHOUT sending or staging anything. Always call this before stage_outreach.",
      input_schema: z.toJSONSchema(outreachSchema),
    },
    {
      name: "stage_outreach",
      description:
        "Queue a draft per recipient into the owner's Approvals inbox. Does NOT send — the owner approves and sends from /approvals. Call ONLY after the owner has confirmed a previewed plan.",
      input_schema: z.toJSONSchema(outreachSchema),
    },
  ]
  const all = [...read, ...action] as Array<{ cache_control?: unknown }>
  // Cache the static tool prefix (same every turn).
  const last = all[all.length - 1]
  if (last) last.cache_control = { type: "ephemeral" }
  return all
}

// ---------- tool execution ----------

type OwnerAgentContext = {
  supabase: SupabaseClient
  shop: ShopRow
  ownerId: string
}

function estimateCredits(plan: FreeformPlan, count: number): number {
  return count * PER_RECIPIENT_CREDITS[plan.channel]
}

async function runOwnerTool(
  ctx: OwnerAgentContext,
  block: AnthropicToolUseBlock
): Promise<{ content: string; isError: boolean }> {
  const json = (v: unknown) => JSON.stringify(v)

  if (block.name === "preview_outreach" || block.name === "stage_outreach") {
    const parsed = outreachSchema.safeParse(block.input)
    if (!parsed.success) {
      return {
        content: json({ error: parsed.error.issues[0]?.message ?? "Invalid plan." }),
        isError: true,
      }
    }
    const plan = toPlan(parsed.data)
    const blocked = channelBlock(ctx.shop, plan.channel)
    if (blocked) return { content: json({ blocked }), isError: false }

    if (block.name === "preview_outreach") {
      const { previewFreeformPlan } = await import("@/lib/agent-audience")
      const preview = await previewFreeformPlan(ctx.supabase, ctx.shop, plan)
      return {
        content: json({
          count: preview.count,
          estimated_credits: estimateCredits(plan, preview.count),
          skipped: preview.stats,
          samples: preview.samples,
          blocked: preview.blocked ?? null,
          note: "Preview only — nothing staged or sent.",
        }),
        isError: false,
      }
    }

    // stage_outreach — pre-check credits, then stage into /approvals.
    const { previewFreeformPlan } = await import("@/lib/agent-audience")
    const preview = await previewFreeformPlan(ctx.supabase, ctx.shop, plan, 0)
    if (preview.blocked) return { content: json({ blocked: preview.blocked }), isError: false }
    const cost = estimateCredits(plan, preview.count)
    const credit = await precheckCredits(ctx.supabase, ctx.shop, cost)
    if (!credit.ok) {
      return { content: json({ blocked: credit.reason }), isError: false }
    }
    const result = await stageOutreachPlan(ctx.supabase, ctx.shop, plan, {
      source: "gradia_agent",
      reason: `Gradia Agent · ${plan.message_intent.slice(0, 60)}`,
      requestedBy: ctx.ownerId,
    })
    if (result.blocked) return { content: json({ blocked: result.blocked }), isError: false }
    // Meter the drafts we actually staged (the sends meter on approval).
    if (result.staged > 0) {
      const priced = priceUsage(
        await getPricing(ctx.supabase),
        "outreach_draft",
        result.staged
      )
      await recordUsage(ctx.supabase, ctx.shop.id, "outreach_draft", {
        quantity: result.staged,
        credits: priced.credits,
        wholesaleCost: priced.wholesale_cost,
        retailCost: priced.retail_cost,
      })
    }
    return {
      content: json({
        staged: result.staged,
        skipped: result.stats,
        where: "Staged in the owner's Approvals inbox — review and send there. Nothing has been sent.",
      }),
      isError: false,
    }
  }

  // Read tools (BI) — shop-scoped, read-only.
  const tool = findBiTool(block.name)
  if (!tool) {
    return { content: json({ error: `Unknown tool: ${block.name}` }), isError: true }
  }
  try {
    const result = await tool.handler(ctx.supabase, ctx.shop.id, block.input)
    return { content: json(result), isError: false }
  } catch (err) {
    return {
      content: json({ error: err instanceof Error ? err.message : String(err) }),
      isError: true,
    }
  }
}

// ---------- public entry point ----------

export async function* streamOwnerAgent(input: {
  supabase: SupabaseClient
  shop: ShopRow
  ownerId: string
  history: ChatMessage[]
}): AsyncGenerator<AgentEvent, void, void> {
  // The box always stages with an explicit in-chat confirmation, regardless of
  // the shop's global autonomy — it never auto-sends. (We read the mode only to
  // stay honest in copy; the loop has no send tool either way.)
  void resolveAgentMode(input.shop, "gradia_agent")

  const ctx: OwnerAgentContext = {
    supabase: input.supabase,
    shop: input.shop,
    ownerId: input.ownerId,
  }
  const tools = buildOwnerToolDefinitions()
  const messages: WireMessage[] = input.history.map((m) =>
    m.role === "assistant"
      ? { role: "assistant", content: [{ type: "text", text: m.content }] }
      : { role: "user", content: m.content }
  )

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const stream = streamOneTurn(messages, OWNER_SYSTEM_BLOCKS, tools)
      let turnResult: StreamTurnResult | null = null
      while (true) {
        const next = await stream.next()
        if (next.done) {
          turnResult = next.value
          break
        }
        yield next.value
      }

      const result = turnResult ?? { blocks: [], stopReason: null }
      messages.push({ role: "assistant", content: result.blocks })

      const toolUses = result.blocks.filter(
        (b): b is AnthropicToolUseBlock => b.type === "tool_use"
      )
      if (toolUses.length === 0 || result.stopReason === "end_turn") {
        yield { type: "done" }
        return
      }

      const toolResults: WireToolResult[] = []
      for (const use of toolUses) {
        yield { type: "tool_start", name: use.name }
        const r = await runOwnerTool(ctx, use)
        toolResults.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: r.content,
          is_error: r.isError || undefined,
        })
        yield { type: "tool_end", name: use.name, ok: !r.isError }
      }
      messages.push({ role: "user", content: toolResults })
    }

    yield {
      type: "error",
      message: "That turned into a lot of steps — try a more specific ask.",
    }
  } catch (err) {
    yield {
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    }
  }
}
