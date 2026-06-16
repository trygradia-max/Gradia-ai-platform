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
import { verifierPayloadFragment, verifyDraft } from "@/lib/draft-verifier"
import { draftCustomEmailForCustomer } from "@/lib/email-drafter"
import { GRADIA_IDENTITY, GRADIA_VOICE } from "@/lib/persona"
import { getPricing, priceUsage } from "@/lib/pricing"
import { draftCustomSmsForCustomer } from "@/lib/sms-drafter"
import { stageOutreachPlan } from "@/lib/agent-runtime"
import type { FreeformPlan, ServiceRow, ShopRow } from "@/lib/types/database"

const MAX_TURNS = 8

const OWNER_SYSTEM_PROMPT = `${GRADIA_IDENTITY}

You are the shop owner's assistant — you answer questions about their business AND take action on their CRM when they ask. You are talking to the OWNER, not a customer.

${GRADIA_VOICE}

What you can do:
- ANSWER questions about the shop using the read tools (lead counts, recent leads, customers, channel volume, upcoming appointments, memory search, knowledge search, revenue, heat scores, COLD leads, setup status). Always call a tool for data — never guess a number.
- DIAGNOSE and propose. When the owner asks an open question like "what's falling through the cracks?" or "come up with a cold lead revival", investigate with the read tools first (e.g. cold_leads to find revival candidates, search_knowledge for the offer/policy to lean on), THEN propose the concrete fix as a staged action.
- ACT on a segment: text or email a group of leads/customers (follow-ups, win-backs, reminders, announcements) via preview_outreach → stage_outreach.
- ACT on ONE person: draft_reply (reply to a specific customer), add_note (log something on their file), create_lead (capture a new lead), propose_booking (put a specific appointment on the books — always staged, never auto-confirmed).

How to run a campaign (e.g. a cold-lead revival) — ALWAYS this sequence:
1. DIAGNOSE: call cold_leads (and search_knowledge if you need the right offer/policy) so you know who and what you're working with.
2. PREVIEW: call preview_outreach. It returns the exact recipient count, why people were skipped, a cost estimate, and 2–3 real sample messages drafted from each customer's data + the shop's knowledge. NOTHING is sent or staged by a preview.
3. CONFIRM: show the owner the count, the cost, and the samples, then ASK for explicit confirmation ("Want us to stage these 23 revival texts for your approval?").
4. STAGE: only after the owner clearly says yes, call stage_outreach. This queues a draft per recipient in the owner's Approvals inbox — it does NOT send. The owner sends from /approvals.

For a single person, draft_reply / add_note / create_lead stage one action the same way — show what you'll do, then stage it for approval.

Hard rules:
- You can preview, stage, and propose — you never directly send, confirm a booking, reschedule, cancel, or charge. A proposed booking is staged and ALWAYS needs the owner's approval before it touches the calendar. Never say something is sent or booked; say it's staged for approval.
- Segments are built from a fixed set of filters: lead status, record age (min/max days), recent-inbound window, customer inactivity, a keyword (name / vehicle / notes), structured VEHICLE (make, model, year range), and time since LAST VISIT (customers). So "Tesla owners" → vehicle_make "Tesla"; "haven't been in for 6 months" → not_visited_in_days 180; "2020-or-newer trucks" → vehicle_year_min 2020 + keyword. Vehicle make is reliable; model is sparse on older records — fall back to keyword if a model match looks empty. If the owner asks to segment by something genuinely outside this set (lifetime spend, location), say so honestly and offer the closest thing you CAN do — never pretend a filter exists.
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
        vehicle_make: z
          .string()
          .max(40)
          .optional()
          .describe('structured make, e.g. "Tesla"'),
        vehicle_model: z.string().max(40).optional(),
        vehicle_year_min: z.number().int().min(1950).max(2100).optional(),
        vehicle_year_max: z.number().int().min(1950).max(2100).optional(),
        not_visited_in_days: z
          .number()
          .int()
          .min(0)
          .max(3650)
          .optional()
          .describe("customers with no booked visit in this many days (or never)"),
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

// ---------- per-customer action tools (L1) ----------

const draftReplySchema = z.object({
  customer_query: z
    .string()
    .min(1)
    .max(120)
    .describe("name, phone, or email of the person to reply to"),
  channel: z.enum(["sms", "email"]),
  reply_intent: z
    .string()
    .min(3)
    .max(500)
    .describe("what to say back, in plain English"),
})

const addNoteSchema = z.object({
  customer_name: z.string().min(1).max(120),
  phone: z.string().max(40).optional(),
  note: z.string().min(1).max(1000),
})

const createLeadSchema = z.object({
  customer_name: z.string().min(1).max(120),
  phone: z.string().min(3).max(40),
  vehicle: z.string().max(120).optional(),
  note: z.string().max(500).optional(),
})

const proposeBookingSchema = z.object({
  customer_query: z
    .string()
    .min(1)
    .max(120)
    .describe("name, phone, or email of the customer to book"),
  service: z.string().min(1).max(120).describe("the service to book"),
  iso_start_time: z
    .string()
    .min(10)
    .describe("absolute ISO 8601 start datetime computed from today's date"),
  duration_minutes: z.number().int().min(15).max(600).optional(),
})

/** Shop service menu — grounds the verifier (no fabricated prices/services). */
async function loadServices(
  supabase: SupabaseClient,
  shopId: string
): Promise<Pick<ServiceRow, "name" | "price_cents">[]> {
  const { data } = await supabase
    .from("services")
    .select("name, price_cents")
    .eq("shop_id", shopId)
  return (data as Pick<ServiceRow, "name" | "price_cents">[] | null) ?? []
}

/** Cross-model verify an outbound draft; returns the payload flag fragment. */
async function verifyOutbound(
  ctx: OwnerAgentContext,
  draft: {
    channel: "sms" | "email"
    body: string
    subject?: string | null
    customerName?: string | null
  }
): Promise<Record<string, unknown>> {
  const result = await verifyDraft({
    ...draft,
    shopName: ctx.shop.name,
    services: await loadServices(ctx.supabase, ctx.shop.id),
  })
  return verifierPayloadFragment(result)
}

type CustomerMatch = {
  id: string
  name: string | null
  phone: string | null
  email: string | null
}

/** Find a customer by name / phone / email (best-effort, shop-scoped). */
async function resolveCustomer(
  supabase: SupabaseClient,
  shopId: string,
  query: string
): Promise<CustomerMatch[]> {
  const q = query.replace(/[%,()]/g, "").trim()
  if (!q) return []
  const ors = [`name.ilike.%${q}%`]
  if (q.includes("@")) ors.push(`email.eq.${q}`)
  const digits = q.replace(/\D/g, "")
  if (digits.length >= 4) ors.push(`phone.ilike.%${digits}%`)
  const { data } = await supabase
    .from("customers")
    .select("id, name, phone, email")
    .eq("shop_id", shopId)
    .or(ors.join(","))
    .limit(5)
  return (data as CustomerMatch[] | null) ?? []
}

/** Stage a single pending_action (the human gate is /approvals). */
async function stageSingle(
  ctx: OwnerAgentContext,
  actionType: string,
  payload: Record<string, unknown>
): Promise<boolean> {
  const { error } = await ctx.supabase.from("pending_actions").insert({
    shop_id: ctx.shop.id,
    action_type: actionType,
    payload,
    requested_by: ctx.ownerId,
  })
  if (error) {
    console.error("[owner-agent] stage failed:", actionType, error)
    return false
  }
  return true
}

async function meterOneDraft(ctx: OwnerAgentContext): Promise<void> {
  const priced = priceUsage(await getPricing(ctx.supabase), "outreach_draft", 1)
  await recordUsage(ctx.supabase, ctx.shop.id, "outreach_draft", {
    quantity: 1,
    credits: priced.credits,
    wholesaleCost: priced.wholesale_cost,
    retailCost: priced.retail_cost,
  })
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
    {
      name: "draft_reply",
      description:
        "Draft a reply to ONE specific person (by name, phone, or email) and stage it for approval. Use for 'reply to Mike', 'text Sarah back about her ceramic quote'. Grounded in the shop's voice + knowledge. Does NOT send — staged in Approvals. If more than one person matches, it returns candidates — ask the owner which one.",
      input_schema: z.toJSONSchema(draftReplySchema),
    },
    {
      name: "add_note",
      description:
        "Add a note to a customer's file (staged for approval). Use for 'note that Mike prefers mornings', 'log that the Audi needs a clay bar'.",
      input_schema: z.toJSONSchema(addNoteSchema),
    },
    {
      name: "create_lead",
      description:
        "Create a new lead (staged for approval) for someone who reached out. Use for 'add a lead for the guy who called about a full detail on his truck'.",
      input_schema: z.toJSONSchema(createLeadSchema),
    },
    {
      name: "propose_booking",
      description:
        "Propose a booking for a customer (staged for approval). Use for 'book Mike for a full detail Saturday at 3pm'. Compute iso_start_time as an absolute ISO 8601 datetime from today's date. A booking ALWAYS needs the owner's approval — it never auto-confirms and never writes the calendar until approved.",
      input_schema: z.toJSONSchema(proposeBookingSchema),
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

  if (block.name === "draft_reply") {
    const parsed = draftReplySchema.safeParse(block.input)
    if (!parsed.success) {
      return { content: json({ error: parsed.error.issues[0]?.message ?? "Invalid input." }), isError: true }
    }
    const { customer_query, channel, reply_intent } = parsed.data
    const blocked = channelBlock(ctx.shop, channel)
    if (blocked) return { content: json({ blocked }), isError: false }

    const matches = await resolveCustomer(ctx.supabase, ctx.shop.id, customer_query)
    if (matches.length === 0) {
      return { content: json({ blocked: `Couldn't find anyone matching "${customer_query}".` }), isError: false }
    }
    if (matches.length > 1) {
      return {
        content: json({
          candidates: matches.map((m) => ({ name: m.name, phone: m.phone, email: m.email })),
          note: "More than one match — ask the owner which one before drafting.",
        }),
        isError: false,
      }
    }
    const c = matches[0]
    const to = channel === "sms" ? c.phone : c.email
    if (!to) {
      return {
        content: json({ blocked: `${c.name ?? "That customer"} has no ${channel === "sms" ? "phone" : "email"} on file.` }),
        isError: false,
      }
    }

    if (channel === "sms") {
      const body = await draftCustomSmsForCustomer({
        shopName: ctx.shop.name,
        customerName: c.name ?? "there",
        vehicle: null,
        service: null,
        intent: reply_intent,
      }).catch(() => null)
      if (!body) return { content: json({ error: "Couldn't draft that — try again." }), isError: true }
      const ok = await stageSingle(ctx, "send_sms", {
        to_phone: to,
        body,
        customer_name: c.name,
        customer_id: c.id,
        reason: `Gradia Agent · reply to ${c.name ?? "customer"}`,
        source: "gradia_agent",
        ...(await verifyOutbound(ctx, {
          channel: "sms",
          body,
          customerName: c.name,
        })),
      })
      if (!ok) return { content: json({ error: "Couldn't stage that." }), isError: true }
      await meterOneDraft(ctx)
      return { content: json({ staged: 1, channel, to, preview: body, where: "Staged in Approvals — review and send there." }), isError: false }
    }

    const draft = await draftCustomEmailForCustomer({
      shopName: ctx.shop.name,
      customerName: c.name ?? "there",
      service: null,
      when: null,
      intent: reply_intent,
    }).catch(() => null)
    if (!draft) return { content: json({ error: "Couldn't draft that — try again." }), isError: true }
    const ok = await stageSingle(ctx, "send_email", {
      to_email: to,
      subject: draft.subject,
      body: draft.body,
      customer_name: c.name,
      customer_id: c.id,
      reason: `Gradia Agent · reply to ${c.name ?? "customer"}`,
      source: "gradia_agent",
      ...(await verifyOutbound(ctx, {
        channel: "email",
        body: draft.body,
        subject: draft.subject,
        customerName: c.name,
      })),
    })
    if (!ok) return { content: json({ error: "Couldn't stage that." }), isError: true }
    await meterOneDraft(ctx)
    return {
      content: json({ staged: 1, channel, to, preview: { subject: draft.subject, body: draft.body }, where: "Staged in Approvals — review and send there." }),
      isError: false,
    }
  }

  if (block.name === "add_note") {
    const parsed = addNoteSchema.safeParse(block.input)
    if (!parsed.success) {
      return { content: json({ error: parsed.error.issues[0]?.message ?? "Invalid input." }), isError: true }
    }
    const { customer_name, phone, note } = parsed.data
    const ok = await stageSingle(ctx, "add_note", {
      content: note,
      customer_name,
      phone: phone ?? null,
      source: "gradia_agent",
    })
    if (!ok) return { content: json({ error: "Couldn't stage that note." }), isError: true }
    return { content: json({ staged: 1, where: "Staged in Approvals." }), isError: false }
  }

  if (block.name === "create_lead") {
    const parsed = createLeadSchema.safeParse(block.input)
    if (!parsed.success) {
      return { content: json({ error: parsed.error.issues[0]?.message ?? "Invalid input." }), isError: true }
    }
    const { customer_name, phone, vehicle, note } = parsed.data
    const ok = await stageSingle(ctx, "create_lead", {
      customer_name,
      phone,
      car_info: vehicle ?? null,
      pin_notes: note ?? null,
      status: "new",
      source: "gradia_agent",
    })
    if (!ok) return { content: json({ error: "Couldn't stage that lead." }), isError: true }
    return { content: json({ staged: 1, where: "Staged in Approvals." }), isError: false }
  }

  if (block.name === "propose_booking") {
    const parsed = proposeBookingSchema.safeParse(block.input)
    if (!parsed.success) {
      return { content: json({ error: parsed.error.issues[0]?.message ?? "Invalid input." }), isError: true }
    }
    const { customer_query, service, iso_start_time, duration_minutes } = parsed.data
    const start = new Date(iso_start_time)
    if (Number.isNaN(start.getTime())) {
      return { content: json({ blocked: "That start time isn't a valid date — give a specific day and time." }), isError: false }
    }
    const matches = await resolveCustomer(ctx.supabase, ctx.shop.id, customer_query)
    if (matches.length === 0) {
      return { content: json({ blocked: `Couldn't find anyone matching "${customer_query}".` }), isError: false }
    }
    if (matches.length > 1) {
      return {
        content: json({
          candidates: matches.map((m) => ({ name: m.name, phone: m.phone, email: m.email })),
          note: "More than one match — ask the owner which one before booking.",
        }),
        isError: false,
      }
    }
    const c = matches[0]
    if (!c.phone) {
      return { content: json({ blocked: `${c.name ?? "That customer"} has no phone on file — needed to book.` }), isError: false }
    }
    let duration = duration_minutes ?? null
    if (duration == null) {
      const { data } = await ctx.supabase
        .from("services")
        .select("duration_minutes")
        .eq("shop_id", ctx.shop.id)
        .ilike("name", service)
        .limit(1)
        .maybeSingle()
      duration = (data as { duration_minutes: number } | null)?.duration_minutes ?? 90
    }
    const ok = await stageSingle(ctx, "book_appointment", {
      customer_name: c.name ?? customer_query,
      phone: c.phone,
      email: c.email,
      car_info: null,
      service,
      iso_start_time: start.toISOString(),
      duration_minutes: duration,
      timezone: null,
      pin_notes: null,
    })
    if (!ok) return { content: json({ error: "Couldn't stage that booking." }), isError: true }
    const calendarHint = ctx.shop.aurinko_access_token_enc
      ? ""
      : " Note: Google Calendar isn't connected yet — connect it in Settings before approving."
    return {
      content: json({
        staged: 1,
        who: c.name,
        service,
        when: start.toISOString(),
        where: `Staged in Approvals — a booking ALWAYS needs the owner's approval; review the time and confirm there.${calendarHint}`,
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
  // Cached persona prefix + a tiny uncached "today" block so the model can
  // resolve relative times ("Saturday 3pm") into absolute ISO for bookings.
  const system = [
    ...OWNER_SYSTEM_BLOCKS,
    {
      type: "text" as const,
      text: `Today is ${new Date().toISOString()} (UTC). When the owner gives a relative time like "Saturday 3pm", compute the absolute ISO 8601 datetime from this. If the timezone is ambiguous, note it so the owner can confirm in Approvals.`,
    },
  ]
  const messages: WireMessage[] = input.history.map((m) =>
    m.role === "assistant"
      ? { role: "assistant", content: [{ type: "text", text: m.content }] }
      : { role: "user", content: m.content }
  )

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const stream = streamOneTurn(messages, system, tools)
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
