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

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Ask Gradia</h1>
        <p className="text-sm text-muted-foreground">
          Anything about our shop — leads, customers, our schedule, what
          people are asking about. Plain English in, straight answers out.
        </p>
      </div>
      <BiChat
        key={initialState.conversationId ?? "fresh"}
        initial={initialState}
      />
    </div>
  )
}
