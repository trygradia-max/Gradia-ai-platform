import { requireUser, getOptionalShop } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import { threadListSchema } from "@/lib/whisper-inbox"
import type { TeamWorkspace } from "@/lib/team-permissions"
import { BiChat } from "@/components/gradia/bi-chat"
import {
  WhisperConversationList,
  WhisperWorkspaceUnavailable,
} from "@/components/gradia/whisper-inbox-presentation"
import { FEATURES } from "@/lib/features"
import {
  getLatestConversationWithMessages,
  getConversationByIdWithMessages,
} from "@/lib/data/bi-conversations"

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
  const db = await createClient(),
    params = await searchParams
  const workspaces = await db.rpc("team_workspaces")
  if (workspaces.error) throw new Error("Workspace access could not be verified.")
  const shops = (workspaces.data ?? []) as TeamWorkspace[],
    shop = params.shop ? shops.find((s) => s.id === params.shop) : shops[0]
  if (!shop) return <WhisperWorkspaceUnavailable />
  const n = Number(params.page ?? 1),
    page = Number.isSafeInteger(n) && n > 0 && n < 100000 ? n : 1
  const r = await db.rpc("list_whisper_threads", {
      p_shop: shop.id,
      p_offset: (page - 1) * 20,
    }),
    parsed = r.error ? null : threadListSchema.safeParse(r.data)
  const data = parsed?.success ? parsed.data : null
  const active = await getOptionalShop()
  const loaded =
    FEATURES.askGradiaPage && active?.id === shop.id
      ? params.c
        ? await getConversationByIdWithMessages(params.c)
        : await getLatestConversationWithMessages()
      : null
  return (
    <WhisperConversationList shops={shops} shopId={shop.id} page={page} data={data}>
      {FEATURES.askGradiaPage && active?.id === shop.id ? (
        <section aria-labelledby="ask-gradia-heading" className="space-y-3 border-t border-border/60 pt-6">
          <h2 id="ask-gradia-heading" className="font-display text-xl text-foreground">
            Ask Gradia
          </h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            Shop questions stay separate from customer messages. This chat does not
            send SMS, email or call anyone.
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
    </WhisperConversationList>
  )
}
