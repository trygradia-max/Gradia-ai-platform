/**
 * Gradia Agent endpoint — the owner's unified read+act box. Same SSE wire
 * protocol as /api/bi/chat (conversation_id, text_delta, tool_start, tool_end,
 * done, error), so the chat UI renders it unchanged; the difference is the
 * agent can also stage outreach (tool_start "stage_outreach") which lands in
 * /approvals. Shop-scoped (RLS) client throughout — never service role.
 */

import { z } from "zod"

import { checkFeatureAccess, loadShopCreditFields, recordUsage } from "@/lib/credits"
import { appendMessage, ensureConversation } from "@/lib/data/bi-conversations"
import { streamOwnerAgent } from "@/lib/owner-agent"
import type { ChatMessage } from "@/lib/bi-agent"
import type { AgentEvent } from "@/lib/bi-agent"
import { getPricing, priceUsage } from "@/lib/pricing"
import { checkRateLimit } from "@/lib/rate-limit"
import { requireShop, requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import type { ShopRow } from "@/lib/types/database"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(8_000),
})

const bodySchema = z.object({
  conversation_id: z.string().uuid().nullable().optional(),
  messages: z.array(messageSchema).min(1).max(40),
})

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
}

type WireEvent = AgentEvent | { type: "conversation_id"; id: string }

function sseLine(event: WireEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

export async function POST(request: Request) {
  let user
  try {
    user = await requireUser()
  } catch {
    return new Response("Sign in first.", { status: 401 })
  }
  const shopCtx = await requireShop()

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ ok: false, error: "Bad JSON." }, { status: 400 })
  }
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid chat input." },
      { status: 400 }
    )
  }
  const history: ChatMessage[] = parsed.data.messages
  const lastMessage = history[history.length - 1]
  if (lastMessage?.role !== "user") {
    return Response.json(
      { ok: false, error: "Last message must be from the user." },
      { status: 400 }
    )
  }

  const supabase = await createClient()

  // Fail-closed: inactive plan or exhausted credits shut the box off.
  const creditFields = await loadShopCreditFields(supabase, shopCtx.id)
  if (!creditFields) {
    return Response.json({ ok: false, error: "We need to set up our shop first." }, { status: 403 })
  }
  const access = await checkFeatureAccess(supabase, creditFields)
  if (!access.ok) {
    return Response.json({ ok: false, error: access.reason }, { status: access.status })
  }
  const burst = await checkRateLimit(shopCtx.id, "agent_chat")
  if (!burst.allowed) {
    return Response.json(
      { ok: false, error: "One thing at a time — give us a few seconds and ask again." },
      { status: 429, headers: { "Retry-After": String(burst.resetInSeconds) } }
    )
  }

  // The action tools need the full shop row (RLS-scoped to the owner).
  const { data: shopRow, error: shopErr } = await supabase
    .from("shops")
    .select("*")
    .eq("id", shopCtx.id)
    .single()
  if (shopErr || !shopRow) {
    return Response.json({ ok: false, error: "Couldn't load the shop." }, { status: 500 })
  }
  const shop = shopRow as ShopRow

  let conversationId: string
  try {
    const conversation = await ensureConversation({
      supabase,
      shopId: shop.id,
      ownerId: user.id,
      conversationId: parsed.data.conversation_id ?? null,
      firstUserMessage: lastMessage.content,
    })
    conversationId = conversation.id
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : "Couldn't start the conversation." },
      { status: 500 }
    )
  }

  await appendMessage({
    supabase,
    conversationId,
    shopId: shop.id,
    role: "user",
    content: lastMessage.content,
  })

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(
        encoder.encode(sseLine({ type: "conversation_id", id: conversationId }))
      )
      let assistantText = ""
      try {
        for await (const event of streamOwnerAgent({
          supabase,
          shop,
          ownerId: user.id,
          history,
        })) {
          if (event.type === "text_delta") assistantText += event.text
          controller.enqueue(encoder.encode(sseLine(event)))
        }
        if (assistantText.trim()) {
          await appendMessage({
            supabase,
            conversationId,
            shopId: shop.id,
            role: "assistant",
            content: assistantText.trim(),
          })
          // Meter the answer (the conversation/thinking cost). Staged outreach
          // drafts are metered separately inside the stage tool; the sends
          // themselves meter on approval. Errored/empty turns aren't metered.
          const priced = priceUsage(await getPricing(supabase), "bi_answer", 1)
          await recordUsage(supabase, shop.id, "bi_answer", {
            credits: priced.credits,
            wholesaleCost: priced.wholesale_cost,
            retailCost: priced.retail_cost,
            refId: conversationId,
          })
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "We hit a snag thinking that through."
        controller.enqueue(encoder.encode(sseLine({ type: "error", message })))
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, { headers: SSE_HEADERS })
}
