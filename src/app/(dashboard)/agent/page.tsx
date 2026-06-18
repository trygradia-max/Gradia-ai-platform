import { redirect } from "next/navigation"

import { BiChat, type InitialChatState } from "@/components/gradia/bi-chat"
import {
  getConversationByIdWithMessages,
  getLatestConversationWithMessages,
} from "@/lib/data/bi-conversations"
import { requireShop } from "@/lib/shop"

export const dynamic = "force-dynamic"

/**
 * Gradia Agent — the owner's read+act box. Same chat surface as Ask Gradia,
 * pointed at /api/agent/chat: it answers questions AND can stage outreach for
 * approval (it never sends — staged drafts land in /approvals).
 */
export default async function AgentPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string }>
}) {
  await requireShop()
  const params = await searchParams
  const requestedId = params.c?.trim() ?? null

  const loaded = requestedId
    ? await getConversationByIdWithMessages(requestedId)
    : await getLatestConversationWithMessages()

  if (requestedId && !loaded) {
    redirect("/agent")
  }

  const initialState: InitialChatState = loaded
    ? {
        conversationId: loaded.conversation.id,
        messages: loaded.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      }
    : { conversationId: null, messages: [] }

  const messageCount = initialState.messages.length
  const isFresh = messageCount === 0

  return (
    <div className="mx-auto max-w-3xl space-y-10">
      <header className="space-y-2">
        <p className="label-eyebrow text-muted-foreground/70">Gradia Agent</p>
        <h1 className="font-display text-[clamp(2rem,5vw,3rem)] leading-[1.05] tracking-[-0.025em] text-foreground">
          What should we get <span className="italic">done</span>?
        </h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          {isFresh
            ? "Ask about the shop, or tell us who to reach — “text everyone who hasn’t booked in 60 days.” We’ll show you who it hits and draft it; you approve before anything sends."
            : `Picking up where we left off — ${messageCount} ${
                messageCount === 1 ? "message" : "messages"
              } in this thread.`}
        </p>
      </header>

      <BiChat
        key={initialState.conversationId ?? "fresh"}
        initial={initialState}
        endpoint="/api/agent/chat"
      />
    </div>
  )
}
