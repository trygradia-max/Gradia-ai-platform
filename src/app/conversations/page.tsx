import { BiChat } from "@/components/gradia/bi-chat"
import { InboxFrame } from "@/components/gradia/inbox-frame"
import { loadInboxIndex } from "@/lib/data/inbox-index"
import {
  getConversationByIdWithMessages,
  getLatestConversationWithMessages,
} from "@/lib/data/bi-conversations"
import { FEATURES } from "@/lib/features"
import { getOptionalShop } from "@/lib/shop"

export const dynamic = "force-dynamic"

export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<{ shop?: string; page?: string; c?: string }>
}) {
  const params = await searchParams
  const index = await loadInboxIndex(params.shop, params.page)
  const active = await getOptionalShop()
  const loaded =
    FEATURES.askGradiaPage && active?.id === index.shop?.id
      ? params.c
        ? await getConversationByIdWithMessages(params.c)
        : await getLatestConversationWithMessages()
      : null

  return (
    <InboxFrame index={index}>
      <div className="flex h-full min-h-0 flex-col overflow-y-auto">
        <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
          <p className="font-display text-xl tracking-tight">Choose a conversation</p>
          <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">
            The list stays on the left. Opening a thread does not send a
            message or mark it read.
          </p>
        </div>
        {FEATURES.askGradiaPage && active?.id === index.shop?.id ? (
          <section className="border-t border-border/70 px-4 py-6 sm:px-8">
            <h2 className="mb-3 font-display text-lg tracking-tight">Ask Gradia</h2>
            <BiChat
              key={loaded?.conversation.id ?? "fresh"}
              initial={
                loaded
                  ? {
                      conversationId: loaded.conversation.id,
                      messages: loaded.messages.map((m) => ({
                        role: m.role,
                        content: m.content,
                      })),
                    }
                  : { conversationId: null, messages: [] }
              }
            />
          </section>
        ) : null}
      </div>
    </InboxFrame>
  )
}
