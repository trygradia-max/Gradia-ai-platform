import {
  WhisperConversationList,
  type WhisperThreadList,
} from "@/components/gradia/whisper-inbox-presentation"
import { cn } from "@/lib/utils"

export function InboxFrame({
  shops,
  shopId,
  page,
  data,
  activeCustomerId,
  activeChannel,
  children,
}: {
  shops: { id: string; name: string }[]
  shopId: string
  page: number
  data: WhisperThreadList | null
  activeCustomerId?: string
  activeChannel?: string
  children: React.ReactNode
}) {
  const open = Boolean(activeCustomerId)
  return (
    <div
      data-whisper-layout="two-pane"
      className="flex min-h-0 flex-1 flex-col lg:flex-row lg:overflow-hidden"
    >
      <aside
        aria-label="Conversation list"
        className={cn(
          "min-h-0 w-full min-w-0 flex-col border-border/70 lg:flex lg:w-[24rem] lg:shrink-0 lg:overflow-hidden lg:border-r",
          open ? "hidden lg:flex" : "flex"
        )}
      >
        <WhisperConversationList
          shops={shops}
          shopId={shopId}
          page={page}
          data={data}
          activeCustomerId={activeCustomerId}
          activeChannel={activeChannel}
        />
      </aside>
      <section
        aria-label={open ? "Open conversation" : "Conversation"}
        className="flex min-h-0 min-w-0 flex-1 flex-col lg:overflow-hidden"
      >
        {children}
      </section>
    </div>
  )
}
