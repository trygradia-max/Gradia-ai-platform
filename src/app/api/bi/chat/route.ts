/**
 * BI chat endpoint. Takes the full conversation history + the new
 * user message, runs the agent (which can call any of the read-only
 * BI tools), returns the assistant's reply.
 *
 * Non-streaming for the first chunk — JSON in, JSON out. Streaming
 * is a follow-up once we want incremental rendering of long answers.
 */

import { z } from "zod"

import { runBiAgent, type ChatMessage } from "@/lib/bi-agent"
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

export async function POST(request: Request) {
  // Auth gate — only logged-in operators with a shop can ask Gradia.
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
        error:
          parsed.error.issues[0]?.message ?? "Invalid chat input.",
      },
      { status: 400 }
    )
  }

  // Last message must be a fresh user turn (the model speaks next).
  const history: ChatMessage[] = parsed.data.messages
  if (history[history.length - 1]?.role !== "user") {
    return Response.json(
      { ok: false, error: "Last message must be from the user." },
      { status: 400 }
    )
  }

  const supabase = await createClient()

  try {
    const result = await runBiAgent({
      supabase,
      shopId: shop.id,
      history,
    })
    return Response.json({
      ok: true,
      reply: result.text,
      toolsUsed: result.toolsUsed,
    })
  } catch (err) {
    console.error("[bi/chat] agent failed:", err)
    return Response.json(
      {
        ok: false,
        error:
          err instanceof Error
            ? err.message
            : "We hit a snag thinking that one through. Try again?",
      },
      { status: 500 }
    )
  }
}
