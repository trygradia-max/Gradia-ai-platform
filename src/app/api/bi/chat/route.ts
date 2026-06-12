/**
 * BI chat endpoint — streams the agent's events as Server-Sent Events
 * AND persists each turn to bi_conversations / bi_messages.
 *
 * Wire protocol (each line: `data: <json>\n\n`):
 *   - conversation_id  — fired once at the start so the client can
 *                        store the lazily-created conversation id
 *   - text_delta       — append `text` to the in-progress assistant message
 *   - tool_start       — model decided to call a tool (`name`)
 *   - tool_end         — tool finished (`name`, `ok`)
 *   - done             — turn complete; assistant message persisted
 *   - error            — fatal; show as toast
 *
 * Persistence rules:
 *   - Conversation created lazily on the first user message.
 *   - User message inserted BEFORE the agent runs so it's always
 *     captured even if the stream errors mid-turn.
 *   - Assistant message inserted on `done`. On `error` after partial
 *     text, the partial is persisted with a sentinel suffix; on
 *     `error` with no text, nothing assistant-side is persisted.
 */

import { z } from "zod"

import {
  streamBiAgent,
  type AgentEvent,
  type ChatMessage,
} from "@/lib/bi-agent"
import { recordUsage } from "@/lib/credits"
import {
  appendMessage,
  ensureConversation,
} from "@/lib/data/bi-conversations"
import { getPricing, priceUsage } from "@/lib/pricing"
import { requireShop, requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"

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
  const shop = await requireShop()

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ ok: false, error: "Bad JSON." }, { status: 400 })
  }

  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return Response.json(
      {
        ok: false,
        error: parsed.error.issues[0]?.message ?? "Invalid chat input.",
      },
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

  // Resolve / create the conversation BEFORE streaming so we know the
  // ID to emit on the wire and so the user's turn lands even if the
  // agent errors out.
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
      {
        ok: false,
        error:
          err instanceof Error ? err.message : "Couldn't start the conversation.",
      },
      { status: 500 }
    )
  }

  // Persist the user message up front.
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
      // Surface the conversation id immediately so the client can
      // persist it for follow-up turns.
      controller.enqueue(
        encoder.encode(
          sseLine({ type: "conversation_id", id: conversationId })
        )
      )

      let assistantText = ""

      try {
        for await (const event of streamBiAgent({
          supabase,
          shopId: shop.id,
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
          // Locked menu: 7 credits per completed Ask Gradia answer.
          // Errored/empty turns are never metered (trust rule).
          const priced = priceUsage(await getPricing(supabase), "bi_answer", 1)
          await recordUsage(supabase, shop.id, "bi_answer", {
            credits: priced.credits,
            wholesaleCost: priced.wholesale_cost,
            retailCost: priced.retail_cost,
            refId: conversationId,
          })
        }
      } catch (err) {
        console.error("[bi/chat] stream failed:", err)
        const message =
          err instanceof Error
            ? err.message
            : "We hit a snag thinking that through."
        controller.enqueue(
          encoder.encode(sseLine({ type: "error", message }))
        )
        // If we had partial text before the error, persist it so the
        // operator can see what we did get on reload.
        if (assistantText.trim()) {
          await appendMessage({
            supabase,
            conversationId,
            shopId: shop.id,
            role: "assistant",
            content: `${assistantText.trim()}\n\n(We hit a snag before finishing — ${message})`,
          })
        }
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, { headers: SSE_HEADERS })
}
