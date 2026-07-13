import { redirect } from "next/navigation"

import { BiChat, type InitialChatState } from "@/components/gradia/bi-chat"
import { ConversationThreads } from "@/components/gradia/conversation-threads"
import { FEATURES } from "@/lib/features"
import {
  getConversationByIdWithMessages,
  getLatestConversationWithMessages,
} from "@/lib/data/bi-conversations"
import { listConversationThreads } from "@/lib/data/conversations"
import { requireShop } from "@/lib/shop"
import { STRINGS } from "@/lib/strings"

export const dynamic = "force-dynamic"

/**
 * Conversations — the one destination for calls, texts, and questions
 * (redesign spec §8-A4: /chat folded in here; SMS/call threads unify
 * here too). Structure lands in L2; the real thread list arrives with
 * the L4 call-record work — until then the Threads module is an honest
 * state, never a fabricated feed.
 */
export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string }>
}) {
  await requireShop()
  const params = await searchParams
  const requestedId = params.c?.trim() ?? null

  const [loaded, threads] = await Promise.all([
    requestedId
      ? getConversationByIdWithMessages(requestedId)
      : getLatestConversationWithMessages(),
    listConversationThreads(),
  ])

  // Stale/deleted thread link → drop the param, keep the URL honest.
  if (requestedId && !loaded) {
    redirect("/conversations")
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

  const s = STRINGS.pages.conversations

  return (
    <div className="mx-auto max-w-3xl space-y-10">
      <header className="space-y-2">
        <p className="label-eyebrow text-muted-foreground/70">{s.eyebrow}</p>
        <h1 className="font-display text-2xl text-foreground">{s.title}</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          {s.subtitle}
        </p>
      </header>

      {/* Customer threads (calls + SMS, unified) — real rows from stored
          turns; AI summaries arrive with the L4 call-record work. */}
      <section className="space-y-3">
        <p className="label-eyebrow text-muted-foreground/70">
          {s.threadsHeading}
        </p>
        <ConversationThreads threads={threads} />
      </section>

      {/* Ask Gradia — the read box, now a module here instead of its
          own nav destination (flag still governs it). */}
      {FEATURES.askGradiaPage ? (
        <section className="space-y-3">
          <p className="label-eyebrow text-muted-foreground/70">
            {s.askHeading}
          </p>
          <BiChat
            key={initialState.conversationId ?? "fresh"}
            initial={initialState}
          />
        </section>
      ) : null}
    </div>
  )
}
