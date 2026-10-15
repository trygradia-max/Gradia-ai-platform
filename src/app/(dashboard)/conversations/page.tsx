import { ConversationThreads } from "@/components/gradia/conversation-threads"
import { SectionHeader } from "@/components/gradia/section-header"
import { listConversationThreads } from "@/lib/data/conversations"
import { requireShop } from "@/lib/shop"
import { STRINGS } from "@/lib/strings"

export const dynamic = "force-dynamic"

/**
 * Inbox — customer calls and texts only. Asking the shop a question
 * is the ⌘K command bar, not a second panel on this page (U-04).
 */
export default async function ConversationsPage() {
  await requireShop()
  const threads = await listConversationThreads()
  const s = STRINGS.pages.conversations

  return (
    <div className="mx-auto w-full max-w-3xl space-y-8">
      <SectionHeader
        level={1}
        eyebrow={s.eyebrow}
        title={s.title}
        subhead={s.subtitle}
      />
      <ConversationThreads threads={threads} />
    </div>
  )
}
