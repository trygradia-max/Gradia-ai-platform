/**
 * BI chat endpoint — streams the agent's events as Server-Sent Events.
 *
 * Event types (each line: `data: <json>\n\n`):
 *   - text_delta  — append `text` to the in-progress assistant message
 *   - tool_start  — model decided to call a tool (`name`)
 *   - tool_end    — tool finished (`name`, `ok`)
 *   - done        — turn complete
 *   - error       — fatal; show as toast
 *
 * The client uses fetch + ReadableStream to consume.
 */

import { z } from "zod"

import {
  streamBiAgent,
  type AgentEvent,
  type ChatMessage,
} from "@/lib/bi-agent"
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
  messages: z.array(messageSchema).min(1).max(40),
})

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  // Disable proxy buffering so deltas reach the browser as they arrive.
  "X-Accel-Buffering": "no",
}

function sseLine(event: AgentEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

export async function POST(request: Request) {
  try {
    await requireUser()
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
  if (history[history.length - 1]?.role !== "user") {
    return Response.json(
      { ok: false, error: "Last message must be from the user." },
      { status: 400 }
    )
  }

  const supabase = await createClient()

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of streamBiAgent({
          supabase,
          shopId: shop.id,
          history,
        })) {
          controller.enqueue(encoder.encode(sseLine(event)))
        }
      } catch (err) {
        console.error("[bi/chat] stream failed:", err)
        controller.enqueue(
          encoder.encode(
            sseLine({
              type: "error",
              message:
                err instanceof Error
                  ? err.message
                  : "We hit a snag thinking that through.",
            })
          )
        )
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, { headers: SSE_HEADERS })
}
