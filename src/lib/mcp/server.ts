/**
 * Gradia Internal MCP server.
 *
 * Per docs/mcp-architecture.md, this is the load-bearing piece for
 * making Gradia genuinely agentic: it wraps our *domain primitives*
 * (proposeLead via HITL, findCustomerByChannel via the normalizer,
 * recordInteraction via shared memory, etc.) so an agent calling
 * us can't accidentally bypass HITL, dedup, memory writes, or RLS.
 *
 * Transport: WebStandardStreamableHTTPServerTransport in stateless
 * mode — one request, one response, fits serverless cleanly.
 *
 * Auth: bearer token resolved against mcp_tokens (SHA-256 of the
 * plaintext). Caller in /api/mcp/route.ts validates the token, then
 * passes a per-shop service-role supabase client into buildMcpServer
 * so every tool runs against that shop.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"

import {
  findCustomerByChannel,
  findOrCreateCustomer,
  normalizePhone,
} from "@/lib/customers"
import { searchShopKnowledge } from "@/lib/knowledge"
import {
  recentChannelActivity,
  recordInteraction,
  searchCustomerMemory,
} from "@/lib/memory"
import {
  sendBookingApprovalRequest,
  sendChargeApprovalRequest,
  sendEmailApprovalRequest,
  sendFacebookDmApprovalRequest,
  sendInstagramDmApprovalRequest,
  sendLeadApprovalRequest,
  sendSmsApprovalRequest,
} from "@/lib/slack"
import type {
  AppointmentRow,
  CustomerRow,
  LeadRow,
  ServiceRow,
} from "@/lib/types/database"

export type GradiaMcpContext = {
  shopId: string
  shopName: string
  ownerId: string
  supabase: SupabaseClient
}

/**
 * Builds a fresh McpServer wired with our domain tools and bound
 * to the caller's shop. We construct per-request rather than
 * sharing one server across shops, both because the SDK is
 * happiest that way and because every closure captures the shop
 * context cleanly.
 */
export function buildMcpServer(ctx: GradiaMcpContext): McpServer {
  const server = new McpServer({
    name: "gradia-internal",
    version: "0.1.0",
  })

  // ---------- propose_lead ----------
  // Stages a create_lead pending_action — operator must Approve in
  // Slack or /approvals before the lead actually lands.
  server.registerTool(
    "propose_lead",
    {
      title: "Propose a new lead",
      description:
        "Stages a create_lead pending_action for human approval. Use this when an agent has identified a new prospective customer; the lead does NOT exist in the leads table until the operator approves it in Slack or /approvals.",
      inputSchema: {
        customer_name: z
          .string()
          .min(1)
          .max(200)
          .describe("Customer's name as best we know it."),
        phone: z
          .string()
          .max(60)
          .default("")
          .describe("Customer phone in any common format; we normalize."),
        car_info: z
          .string()
          .max(200)
          .nullable()
          .default(null)
          .describe("Year/make/model when mentioned, else null."),
        pin_notes: z
          .string()
          .max(2000)
          .nullable()
          .default(null)
          .describe("Free-text context the operator will see on the card."),
        status: z
          .enum(["new", "quoted", "booked"])
          .default("new")
          .describe(
            "Pipeline stage. Default 'new' unless the lead has been actively quoted/booked."
          ),
        source: z
          .string()
          .max(40)
          .default("mcp")
          .describe(
            "Where the lead came from (e.g. 'instagram', 'email', 'voice'). Used for audit."
          ),
      },
    },
    async (args) => {
      const { data, error } = await ctx.supabase
        .from("pending_actions")
        .insert({
          shop_id: ctx.shopId,
          action_type: "create_lead",
          payload: {
            customer_name: args.customer_name,
            phone: args.phone,
            car_info: args.car_info,
            pin_notes: args.pin_notes,
            status: args.status,
            source: args.source,
          },
          requested_by: ctx.ownerId,
        })
        .select("id")
        .single()
      if (error || !data) {
        return errorResult(error?.message ?? "Insert failed.")
      }
      const pendingId = (data as { id: string }).id

      try {
        await sendLeadApprovalRequest({
          pendingActionId: pendingId,
          customerName: args.customer_name,
          phone: args.phone ?? "",
          carInfo: args.car_info,
          pinNotes: args.pin_notes,
          status: args.status,
          crossChannelHint: null,
        })
      } catch (err) {
        console.warn("[mcp propose_lead] Slack send failed:", err)
      }

      return jsonResult({
        ok: true,
        pending_action_id: pendingId,
        message: `Lead "${args.customer_name}" staged for approval.`,
      })
    }
  )

  // ---------- find_customer_by_channel ----------
  server.registerTool(
    "find_customer_by_channel",
    {
      title: "Find an existing customer by any channel identifier",
      description:
        "Looks up the master customer record across all channels. Returns the unified row or null. Use BEFORE proposing a new lead so we don't duplicate someone we already know.",
      inputSchema: {
        phone: z
          .string()
          .max(60)
          .nullable()
          .default(null)
          .describe("Any phone format; we normalize to E.164."),
        email: z.string().max(200).nullable().default(null),
        instagram_handle: z
          .string()
          .max(60)
          .nullable()
          .default(null)
          .describe("With or without leading @."),
        facebook_id: z.string().max(60).nullable().default(null),
      },
    },
    async (args) => {
      const customer = await findCustomerByChannel(
        ctx.supabase,
        ctx.shopId,
        {
          phone: args.phone ?? undefined,
          email: args.email ?? undefined,
          instagramHandle: args.instagram_handle ?? undefined,
          facebookId: args.facebook_id ?? undefined,
        }
      )
      return jsonResult({ customer })
    }
  )

  // ---------- find_or_create_customer ----------
  server.registerTool(
    "find_or_create_customer",
    {
      title: "Find-or-create unified customer record",
      description:
        "Like find_customer_by_channel but inserts a new row if nothing matched, with at-least-one-identifier required. Returns the resolved row.",
      inputSchema: {
        name: z.string().max(200).nullable().default(null),
        phone: z.string().max(60).nullable().default(null),
        email: z.string().max(200).nullable().default(null),
        instagram_handle: z.string().max(60).nullable().default(null),
        facebook_id: z.string().max(60).nullable().default(null),
      },
    },
    async (args) => {
      const result = await findOrCreateCustomer(ctx.supabase, ctx.shopId, {
        name: args.name ?? undefined,
        phone: args.phone ?? undefined,
        email: args.email ?? undefined,
        instagramHandle: args.instagram_handle ?? undefined,
        facebookId: args.facebook_id ?? undefined,
      })
      if (!result.ok) return errorResult(result.error)
      return jsonResult({ customer: result.customer, created: result.created })
    }
  )

  // ---------- record_interaction ----------
  server.registerTool(
    "record_interaction",
    {
      title: "Record a customer touchpoint to shared memory",
      description:
        "Persists one turn of a conversation (any channel) and embeds it for pgvector recall. Use after every meaningful agent ↔ customer exchange so future agents have context.",
      inputSchema: {
        customer_id: z
          .string()
          .uuid()
          .nullable()
          .default(null)
          .describe("Pass null when the customer isn't linked yet."),
        channel: z.enum([
          "voice",
          "sms",
          "email",
          "instagram",
          "facebook",
          "web",
          "note",
        ]),
        role: z.enum(["customer", "gradia", "system"]),
        content: z.string().min(1).max(8000),
        metadata: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Free-form metadata stored on the row."),
      },
    },
    async (args) => {
      const result = await recordInteraction(ctx.supabase, {
        shopId: ctx.shopId,
        customerId: args.customer_id,
        channel: args.channel,
        role: args.role,
        content: args.content,
        metadata: args.metadata ?? undefined,
      })
      if (!result.ok) return errorResult(result.error)
      return jsonResult({ interaction_id: result.id })
    }
  )

  // ---------- search_customer_memory ----------
  server.registerTool(
    "search_customer_memory",
    {
      title: "Semantic search across customer touchpoints",
      description:
        "pgvector-backed search across interactions for the shop. Pass customer_id to scope to one customer, or null for shop-wide. Returns matches with similarity scores.",
      inputSchema: {
        query: z.string().min(2).max(400),
        customer_id: z.string().uuid().nullable().default(null),
        limit: z.number().int().min(1).max(20).default(6),
      },
    },
    async (args) => {
      const matches = await searchCustomerMemory(
        ctx.supabase,
        ctx.shopId,
        args.customer_id,
        args.query,
        { limit: args.limit }
      )
      return jsonResult({ query: args.query, matches })
    }
  )

  // ---------- search_shop_knowledge ----------
  server.registerTool(
    "search_shop_knowledge",
    {
      title: "RAG over the shop's pasted knowledge base",
      description:
        "Looks up FAQs, policies, deposit rules, brand voice — whatever the owner pasted into /settings → Shop knowledge. Use for any 'how does the shop operate' question.",
      inputSchema: {
        query: z.string().min(2).max(400),
        limit: z.number().int().min(1).max(10).default(4),
      },
    },
    async (args) => {
      const matches = await searchShopKnowledge(
        ctx.supabase,
        ctx.shopId,
        args.query,
        { limit: args.limit }
      )
      return jsonResult({ query: args.query, matches })
    }
  )

  // ---------- recent_channel_activity ----------
  server.registerTool(
    "recent_channel_activity",
    {
      title: "Cross-channel activity hint",
      description:
        "Returns the most recent touchpoints for a customer across channels other than the one currently in scope. Used for the 'they also emailed 2h ago' nudge.",
      inputSchema: {
        customer_id: z.string().uuid(),
        exclude_channel: z
          .enum([
            "voice",
            "sms",
            "email",
            "instagram",
            "facebook",
            "web",
            "note",
          ])
          .nullable()
          .default(null),
        within_minutes: z.number().int().min(1).max(60 * 24 * 30).default(60 * 24),
      },
    },
    async (args) => {
      const activity = await recentChannelActivity(
        ctx.supabase,
        ctx.shopId,
        args.customer_id,
        {
          excludeChannel: args.exclude_channel ?? undefined,
          withinMinutes: args.within_minutes,
        }
      )
      return jsonResult({ activity })
    }
  )

  // ---------- list_services ----------
  server.registerTool(
    "list_services",
    {
      title: "Read the shop's service menu",
      description:
        "Lists the shop's services with prices + durations. Use before quoting anything — never invent a price.",
      inputSchema: {},
    },
    async () => {
      const { data, error } = await ctx.supabase
        .from("services")
        .select("*")
        .eq("shop_id", ctx.shopId)
        .order("price_cents", { ascending: true })
      if (error) return errorResult(error.message)
      const services = (data as ServiceRow[] | null) ?? []
      return jsonResult({ services })
    }
  )

  // ---------- normalize_phone ----------
  server.registerTool(
    "normalize_phone",
    {
      title: "Normalize a phone number to E.164",
      description:
        "Pure helper. Use before passing a phone to propose_lead so dedup hits the existing customer.",
      inputSchema: {
        phone: z.string().min(1).max(60),
      },
    },
    async (args) => {
      const normalized = normalizePhone(args.phone)
      return jsonResult({ normalized })
    }
  )

  // ---------- propose_booking ----------
  server.registerTool(
    "propose_booking",
    {
      title: "Propose a calendar booking",
      description:
        "Stages a book_appointment pending_action. On approval, Gradia creates the Google Calendar event (via Aurinko) + booked lead + appointment row + Jobber sync (if connected). iso_start_time MUST be a real ISO datetime — the action falls back to a quoted lead otherwise.",
      inputSchema: {
        customer_name: z.string().min(1).max(200),
        phone: z.string().max(60).default(""),
        car_info: z.string().max(200).nullable().default(null),
        service: z.string().max(200).nullable().default(null),
        iso_start_time: z
          .string()
          .describe(
            "Full ISO 8601 datetime in UTC or with explicit offset (e.g. 2026-06-15T15:00:00Z)."
          ),
        duration_minutes: z.number().int().min(15).max(24 * 60).default(90),
        timezone: z
          .string()
          .max(80)
          .nullable()
          .default(null)
          .describe("IANA tz like 'America/Los_Angeles' (informational)."),
        pin_notes: z.string().max(2000).nullable().default(null),
        email: z
          .string()
          .max(200)
          .nullable()
          .default(null)
          .describe("If provided, calendar invite goes to this address."),
        source: z.string().max(40).default("mcp"),
      },
    },
    async (args) => {
      const { data, error } = await ctx.supabase
        .from("pending_actions")
        .insert({
          shop_id: ctx.shopId,
          action_type: "book_appointment",
          payload: {
            customer_name: args.customer_name,
            phone: args.phone,
            car_info: args.car_info,
            service: args.service,
            iso_start_time: args.iso_start_time,
            duration_minutes: args.duration_minutes,
            timezone: args.timezone,
            pin_notes: args.pin_notes,
            email: args.email,
            source: args.source,
          },
          requested_by: ctx.ownerId,
        })
        .select("id")
        .single()
      if (error || !data) return errorResult(error?.message ?? "Insert failed.")
      const pendingId = (data as { id: string }).id

      try {
        await sendBookingApprovalRequest({
          pendingActionId: pendingId,
          customerName: args.customer_name,
          phone: args.phone ?? "",
          service: args.service,
          carInfo: args.car_info,
          startIso: args.iso_start_time,
          durationMinutes: args.duration_minutes,
          timezone: args.timezone,
        })
      } catch (err) {
        console.warn("[mcp propose_booking] Slack send failed:", err)
      }
      return jsonResult({ ok: true, pending_action_id: pendingId })
    }
  )

  // ---------- propose_sms ----------
  server.registerTool(
    "propose_sms",
    {
      title: "Propose an outbound SMS",
      description:
        "Stages a send_sms pending_action. Operator approves in Slack or /approvals before Twilio actually sends. Recipient must be in E.164 format — call normalize_phone first.",
      inputSchema: {
        to_phone: z
          .string()
          .regex(/^\+\d{8,15}$/, "Must be E.164, e.g. +14155551234"),
        body: z.string().min(1).max(1600),
        customer_name: z.string().max(200).nullable().default(null),
        customer_id: z.string().uuid().nullable().default(null),
        reason: z
          .string()
          .max(200)
          .nullable()
          .default(null)
          .describe("One-line why — shown on the approval card."),
        source: z.string().max(40).default("mcp"),
      },
    },
    async (args) => {
      const { data, error } = await ctx.supabase
        .from("pending_actions")
        .insert({
          shop_id: ctx.shopId,
          action_type: "send_sms",
          payload: {
            to_phone: args.to_phone,
            body: args.body,
            customer_name: args.customer_name,
            customer_id: args.customer_id,
            reason: args.reason,
            source: args.source,
          },
          requested_by: ctx.ownerId,
        })
        .select("id")
        .single()
      if (error || !data) return errorResult(error?.message ?? "Insert failed.")
      const pendingId = (data as { id: string }).id

      try {
        await sendSmsApprovalRequest({
          pendingActionId: pendingId,
          toPhone: args.to_phone,
          customerName: args.customer_name,
          body: args.body,
          reason: args.reason,
        })
      } catch (err) {
        console.warn("[mcp propose_sms] Slack send failed:", err)
      }
      return jsonResult({ ok: true, pending_action_id: pendingId })
    }
  )

  // ---------- propose_email ----------
  server.registerTool(
    "propose_email",
    {
      title: "Propose an outbound email",
      description:
        "Stages a send_email pending_action. On approval, Aurinko sends via the shop's connected Gmail. Plain text body, never HTML.",
      inputSchema: {
        to_email: z.string().email(),
        subject: z.string().min(1).max(200),
        body: z.string().min(1).max(8_000),
        customer_name: z.string().max(200).nullable().default(null),
        customer_id: z.string().uuid().nullable().default(null),
        reason: z.string().max(200).nullable().default(null),
        source: z.string().max(40).default("mcp"),
      },
    },
    async (args) => {
      const { data, error } = await ctx.supabase
        .from("pending_actions")
        .insert({
          shop_id: ctx.shopId,
          action_type: "send_email",
          payload: {
            to_email: args.to_email,
            subject: args.subject,
            body: args.body,
            customer_name: args.customer_name,
            customer_id: args.customer_id,
            reason: args.reason,
            source: args.source,
          },
          requested_by: ctx.ownerId,
        })
        .select("id")
        .single()
      if (error || !data) return errorResult(error?.message ?? "Insert failed.")
      const pendingId = (data as { id: string }).id

      try {
        await sendEmailApprovalRequest({
          pendingActionId: pendingId,
          toEmail: args.to_email,
          customerName: args.customer_name,
          subject: args.subject,
          body: args.body,
          reason: args.reason,
        })
      } catch (err) {
        console.warn("[mcp propose_email] Slack send failed:", err)
      }
      return jsonResult({ ok: true, pending_action_id: pendingId })
    }
  )

  // ---------- propose_ig_dm ----------
  server.registerTool(
    "propose_ig_dm",
    {
      title: "Propose an outbound Instagram DM",
      description:
        "Stages a send_instagram_dm pending_action. recipient_id is the page-scoped sender id we stored on inbound (also surfaced as customer.instagram_handle).",
      inputSchema: {
        recipient_id: z.string().min(1).max(120),
        body: z.string().min(1).max(900),
        customer_name: z.string().max(200).nullable().default(null),
        customer_id: z.string().uuid().nullable().default(null),
        reason: z.string().max(200).nullable().default(null),
        source: z.string().max(40).default("mcp"),
      },
    },
    async (args) => {
      const { data, error } = await ctx.supabase
        .from("pending_actions")
        .insert({
          shop_id: ctx.shopId,
          action_type: "send_instagram_dm",
          payload: {
            recipient_id: args.recipient_id,
            body: args.body,
            customer_name: args.customer_name,
            customer_id: args.customer_id,
            reason: args.reason,
            source: args.source,
          },
          requested_by: ctx.ownerId,
        })
        .select("id")
        .single()
      if (error || !data) return errorResult(error?.message ?? "Insert failed.")
      const pendingId = (data as { id: string }).id

      try {
        await sendInstagramDmApprovalRequest({
          pendingActionId: pendingId,
          recipientId: args.recipient_id,
          customerName: args.customer_name,
          body: args.body,
          reason: args.reason,
        })
      } catch (err) {
        console.warn("[mcp propose_ig_dm] Slack send failed:", err)
      }
      return jsonResult({ ok: true, pending_action_id: pendingId })
    }
  )

  // ---------- propose_fb_dm ----------
  server.registerTool(
    "propose_fb_dm",
    {
      title: "Propose an outbound Facebook page DM",
      description:
        "Stages a send_facebook_dm pending_action. recipient_id is the PSID we stored on inbound (also surfaced as customer.facebook_id).",
      inputSchema: {
        recipient_id: z.string().min(1).max(120),
        body: z.string().min(1).max(900),
        customer_name: z.string().max(200).nullable().default(null),
        customer_id: z.string().uuid().nullable().default(null),
        reason: z.string().max(200).nullable().default(null),
        source: z.string().max(40).default("mcp"),
      },
    },
    async (args) => {
      const { data, error } = await ctx.supabase
        .from("pending_actions")
        .insert({
          shop_id: ctx.shopId,
          action_type: "send_facebook_dm",
          payload: {
            recipient_id: args.recipient_id,
            body: args.body,
            customer_name: args.customer_name,
            customer_id: args.customer_id,
            reason: args.reason,
            source: args.source,
          },
          requested_by: ctx.ownerId,
        })
        .select("id")
        .single()
      if (error || !data) return errorResult(error?.message ?? "Insert failed.")
      const pendingId = (data as { id: string }).id

      try {
        await sendFacebookDmApprovalRequest({
          pendingActionId: pendingId,
          recipientId: args.recipient_id,
          customerName: args.customer_name,
          body: args.body,
          reason: args.reason,
        })
      } catch (err) {
        console.warn("[mcp propose_fb_dm] Slack send failed:", err)
      }
      return jsonResult({ ok: true, pending_action_id: pendingId })
    }
  )

  // ---------- propose_charge ----------
  server.registerTool(
    "propose_charge",
    {
      title: "Propose a Stripe invoice",
      description:
        "Stages a charge_customer pending_action. On approval, Stripe Connect creates an invoice on the shop's connected account and emails the customer a hosted payment link. amount_cents is dollars × 100.",
      inputSchema: {
        customer_name: z.string().min(1).max(200),
        customer_email: z
          .string()
          .email()
          .describe("Required — Stripe needs an email to send the invoice."),
        amount_cents: z
          .number()
          .int()
          .positive()
          .max(10_000_000)
          .describe("Dollars × 100. Max $100,000 per charge."),
        description: z.string().min(1).max(500),
        source: z.string().max(40).default("mcp"),
      },
    },
    async (args) => {
      const { data, error } = await ctx.supabase
        .from("pending_actions")
        .insert({
          shop_id: ctx.shopId,
          action_type: "charge_customer",
          payload: {
            customer_name: args.customer_name,
            customer_email: args.customer_email,
            amount_cents: args.amount_cents,
            description: args.description,
            source: args.source,
          },
          requested_by: ctx.ownerId,
        })
        .select("id")
        .single()
      if (error || !data) return errorResult(error?.message ?? "Insert failed.")
      const pendingId = (data as { id: string }).id

      try {
        await sendChargeApprovalRequest({
          pendingActionId: pendingId,
          customerName: args.customer_name,
          customerEmail: args.customer_email,
          amountCents: args.amount_cents,
          description: args.description,
        })
      } catch (err) {
        console.warn("[mcp propose_charge] Slack send failed:", err)
      }
      return jsonResult({ ok: true, pending_action_id: pendingId })
    }
  )

  // ---------- resources ----------

  server.registerResource(
    "shop_snapshot",
    "gradia://shop/snapshot",
    {
      title: "Shop snapshot",
      description:
        "Current state of the shop in one read: name, totals across leads / customers / appointments, today's bookings. Use as a cheap context-loading first call.",
      mimeType: "application/json",
    },
    async (uri) => {
      const [leadsRes, customersRes, todayAppts] = await Promise.all([
        ctx.supabase
          .from("leads")
          .select("status", { count: "exact", head: false })
          .eq("shop_id", ctx.shopId),
        ctx.supabase
          .from("customers")
          .select("id", { count: "exact", head: true })
          .eq("shop_id", ctx.shopId),
        ctx.supabase
          .from("appointments")
          .select("*")
          .eq("shop_id", ctx.shopId)
          .gte("scheduled_at", new Date().toISOString())
          .lte(
            "scheduled_at",
            new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
          )
          .order("scheduled_at", { ascending: true })
          .limit(10),
      ])

      const leads = (leadsRes.data as { status: string }[] | null) ?? []
      const byStatus = leads.reduce<Record<string, number>>((acc, l) => {
        acc[l.status] = (acc[l.status] ?? 0) + 1
        return acc
      }, {})
      const snapshot = {
        shop: { id: ctx.shopId, name: ctx.shopName },
        leads: {
          total: leads.length,
          by_status: byStatus,
        },
        customers_total: customersRes.count ?? 0,
        next_24h_appointments:
          (todayAppts.data as AppointmentRow[] | null) ?? [],
        generated_at: new Date().toISOString(),
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(snapshot, null, 2),
          },
        ],
      }
    }
  )

  server.registerResource(
    "recent_customers",
    "gradia://customers/recent",
    {
      title: "Recent customers",
      description:
        "Last 25 customers in the shop. Useful when an agent needs a fast directory lookup.",
      mimeType: "application/json",
    },
    async (uri) => {
      const { data, error } = await ctx.supabase
        .from("customers")
        .select(
          "id, name, phone, email, instagram_handle, facebook_id, updated_at"
        )
        .eq("shop_id", ctx.shopId)
        .order("updated_at", { ascending: false })
        .limit(25)
      if (error) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({ error: error.message }),
            },
          ],
        }
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(
              { customers: (data as CustomerRow[] | null) ?? [] },
              null,
              2
            ),
          },
        ],
      }
    }
  )

  server.registerResource(
    "active_leads",
    "gradia://leads/active",
    {
      title: "Active (new + quoted) leads",
      description:
        "All non-booked leads, newest first. Read when an agent needs to triage who to follow up with.",
      mimeType: "application/json",
    },
    async (uri) => {
      const { data, error } = await ctx.supabase
        .from("leads")
        .select("*")
        .eq("shop_id", ctx.shopId)
        .neq("status", "booked")
        .order("created_at", { ascending: false })
        .limit(50)
      if (error) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({ error: error.message }),
            },
          ],
        }
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(
              { leads: (data as LeadRow[] | null) ?? [] },
              null,
              2
            ),
          },
        ],
      }
    }
  )

  // ---------- resource templates ----------

  server.registerResource(
    "customer_detail",
    new ResourceTemplate("gradia://customers/{id}", {
      list: undefined,
    }),
    {
      title: "Customer detail",
      description:
        "Read a single customer row by id. Pair with /timeline below when you also need their touchpoints.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const id = String(variables.id)
      const { data, error } = await ctx.supabase
        .from("customers")
        .select("*")
        .eq("shop_id", ctx.shopId)
        .eq("id", id)
        .maybeSingle()
      const body = error
        ? { error: error.message }
        : { customer: (data as CustomerRow | null) ?? null }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(body, null, 2),
          },
        ],
      }
    }
  )

  server.registerResource(
    "customer_timeline",
    new ResourceTemplate("gradia://customers/{id}/timeline", {
      list: undefined,
    }),
    {
      title: "Customer timeline",
      description:
        "Last 50 interactions for a customer across every channel (voice, SMS, email, IG, FB, notes), newest first.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const id = String(variables.id)
      const { data, error } = await ctx.supabase
        .from("interactions")
        .select("id, channel, role, content, metadata, occurred_at")
        .eq("shop_id", ctx.shopId)
        .eq("customer_id", id)
        .order("occurred_at", { ascending: false })
        .limit(50)
      const body = error
        ? { error: error.message }
        : { interactions: data ?? [] }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(body, null, 2),
          },
        ],
      }
    }
  )

  // ---------- prompts (personas) ----------

  server.registerPrompt(
    "builder",
    {
      title: "Builder",
      description:
        "Claude-Code-style operator. Reads broadly, drafts campaigns, batch-proposes outbound — every change lands in HITL.",
    },
    () => ({
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `You are Gradia in Builder mode for shop "${ctx.shopName}". You read broadly across our data and propose structured outbound work in batches.

Tone: collaborative we/us — you're part of the team, not a vendor.

Workflow:
  1. Read first. Start with the gradia://shop/snapshot resource for context. Use list_services, search_customer_memory, search_shop_knowledge, gradia://leads/active, and gradia://customers/recent to scope the audience.
  2. Plan out loud. Tell the operator what you're about to propose ("I see 14 leads that match; here's the draft").
  3. Then batch-propose. Use propose_sms / propose_email / propose_ig_dm / propose_fb_dm — never send directly. Every draft lands in /approvals for the operator to Approve or Edit.
  4. Cite policies. Pull any relevant entry from search_shop_knowledge into your drafts. Never quote a price unless list_services or knowledge explicitly states one.

Hard rules:
  - Never create > 25 pending proposals in one batch unless explicitly told.
  - Always note "approve in Slack to send" so the operator knows nothing went out.
  - Sign drafts with "— Gradia at ${ctx.shopName}".`,
          },
        },
      ],
    })
  )

  server.registerPrompt(
    "co_owner",
    {
      title: "Co-owner",
      description:
        "Proactive partner. Asks 'how are we doing today?' and 'who should we follow up with?', then drives one-tap follow-ups via propose_*.",
    },
    () => ({
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `You are Gradia in Co-owner mode for shop "${ctx.shopName}". You're the proactive partner who flags what to tackle next.

Tone: we/us, warm and direct. No corporate hedging.

Workflow:
  1. Pull gradia://shop/snapshot to know what's on the books in the next 24h.
  2. Pull gradia://leads/active and rank: anyone with recent inbound activity (search_customer_memory + recent_channel_activity) is hottest.
  3. Suggest 1–3 next actions, never more. Each suggestion: who, why (one signal), what we'd do.
  4. On the operator's go-ahead, propose_sms or propose_email — singular, focused, one tap to approve.

Hard rules:
  - Never propose more than one outbound at a time without explicit confirmation.
  - Always cite the signal that made you pick this person ("they texted us yesterday and we never replied").
  - If list_services or search_shop_knowledge has a relevant fact, weave it in.`,
          },
        },
      ],
    })
  )

  server.registerPrompt(
    "accountant",
    {
      title: "Accountant",
      description:
        "Read-only BI persona. Answers money + pipeline questions using snapshot + memory tools. Never proposes outbound.",
    },
    () => ({
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `You are Gradia in Accountant mode for shop "${ctx.shopName}". You answer questions about money, pipeline, and customer history — read-only.

Tone: precise, we/us. Give numbers. No fluff.

Workflow:
  1. Use gradia://shop/snapshot for high-level counts.
  2. Use search_customer_memory and gradia://customers/{id}/timeline for specifics.
  3. Use list_services to ground any "what do we charge for X" answer.

Hard rules:
  - NEVER call any propose_* tool. You're a read-only persona.
  - When asked for a number, give the number, not "a lot." Cite the source resource if helpful.
  - If a question requires data we don't have a tool for, say so plainly — don't guess.`,
          },
        },
      ],
    })
  )

  return server
}

// ---------- result helpers ----------

function jsonResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  }
}

function errorResult(message: string) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ ok: false, error: message }),
      },
    ],
  }
}
