import { redirect } from "next/navigation"

import { BiChat, type InitialChatState } from "@/components/gradia/bi-chat"
import {
  getConversationByIdWithMessages,
  getLatestConversationWithMessages,
} from "@/lib/data/bi-conversations"
import { requireShop } from "@/lib/shop"

export const dynamic = "force-dynamic"

export default async function ChatPage({
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

  // If the requested conversation doesn't exist (deleted in another
  // tab, or stale link), drop the query param and fall back to the
  // latest. Keeps the URL honest.
  if (requestedId && !loaded) {
    redirect("/chat")
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
        <p className="label-eyebrow text-muted-foreground/70">Ask Gradia</p>
        <h1 className="font-display text-[clamp(2rem,5vw,3rem)] leading-[1.05] tracking-[-0.025em] text-foreground">
          What do you want to <span className="italic">know</span>?
        </h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          {isFresh
            ? "Anything about our shop — leads, customers, the schedule, what people are asking about. Plain English in, straight answers out."
            : `Picking up where we left off — ${messageCount} ${
                messageCount === 1 ? "message" : "messages"
              } in this thread.`}
        </p>
      </header>

      <BiChat
        key={initialState.conversationId ?? "fresh"}
        initial={initialState}
      />
    </div>
  )
}
