import { requireUser, getOptionalShop } from "@/lib/shop"
import { BiChat } from "@/components/gradia/bi-chat"
import { EmptyState } from "@/components/gradia/empty-state"
import { InboxFrame } from "@/components/gradia/inbox-frame"
import { WhisperWorkspaceUnavailable } from "@/components/gradia/whisper-inbox-presentation"
import { FEATURES } from "@/lib/features"
import {
  getLatestConversationWithMessages,
  getConversationByIdWithMessages,
} from "@/lib/data/bi-conversations"
import { STRINGS } from "@/lib/strings"
import { loadInboxIndex } from "./load-inbox"

export const dynamic = "force-dynamic"
export const metadata = { title: "Whisper conversations" }

export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<{
    shop?: string
    page?: string
    c?: string
  }>
}) {
  await requireUser()
  const params = await searchParams
  const index = await loadInboxIndex(params.shop, params.page)
  if (!index.shop) return <WhisperWorkspaceUnavailable />
  const shop = index.shop
  const emptyInbox =
    index.data !== null && index.page <= 1 && index.data.items.length === 0
  const active = await getOptionalShop()
  const loaded =
    FEATURES.askGradiaPage && active?.id === shop.id
      ? params.c
        ? await getConversationByIdWithMessages(params.c)
        : await getLatestConversationWithMessages()
      : null
  return (
    <InboxFrame shops={index.shops} shopId={shop.id} page={index.page} data={index.data}>
      <div className="flex min-h-0 flex-1 flex-col lg:overflow-y-auto">
        <div className="hidden flex-1 flex-col items-center justify-center px-6 py-16 text-center lg:flex">
          <EmptyState
            className="border-0 bg-transparent ring-0"
            title={
              emptyInbox
                ? STRINGS.empty.conversationsFirstUseTitle
                : STRINGS.empty.conversationsChoose
            }
            description={
              emptyInbox
                ? STRINGS.empty.conversationsFirstUse
                : STRINGS.empty.conversationsChooseBody
            }
          />
        </div>
        {FEATURES.askGradiaPage && active?.id === shop.id ? (
          <section aria-labelledby="ask-gradia-heading" className="space-y-3 border-t border-border px-4 py-6 sm:px-5">
            <h2 id="ask-gradia-heading" className="font-display text-xl text-foreground">
              Ask Gradia
            </h2>
            <p className="max-w-prose text-sm text-muted-foreground">
              Shop questions stay separate from customer messages. This chat does not send SMS, email or call anyone.
            </p>
            <BiChat
              key={loaded?.conversation.id ?? "fresh"}
              initial={
                loaded
                  ? {
                      conversationId: loaded.conversation.id,
                      messages: loaded.messages.map((message) => ({
                        role: message.role,
                        content: message.content,
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
