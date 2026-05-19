import { BiChat, type InitialChatState } from "@/components/gradia/bi-chat"
import { getLatestConversationWithMessages } from "@/lib/data/bi-conversations"
import { requireShop } from "@/lib/shop"

export const dynamic = "force-dynamic"

export default async function ChatPage() {
  await requireShop()
  const loaded = await getLatestConversationWithMessages()

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
      <BiChat initial={initialState} />
    </div>
  )
}
