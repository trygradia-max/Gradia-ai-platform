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
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
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
import { sendLeadApprovalRequest } from "@/lib/slack"
import type { ServiceRow } from "@/lib/types/database"

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
