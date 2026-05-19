"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { History, Loader2, Trash2 } from "lucide-react"
import { toast } from "sonner"

import {
  deleteConversation,
  listChatConversations,
} from "@/app/actions/bi-chat"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"

type Item = {
  id: string
  title: string | null
  updated_at: string
  created_at: string
}

function relative(iso: string): string {
  const then = new Date(iso).getTime()
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (seconds < 60) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days === 1) return "yesterday"
  if (days < 14) return `${days} days ago`
  const weeks = Math.round(days / 7)
  return `${weeks} wk${weeks === 1 ? "" : "s"} ago`
}

export function BiChatHistorySheet({
  currentConversationId,
}: {
  currentConversationId: string | null
}) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [items, setItems] = React.useState<Item[] | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [deletingId, setDeletingId] = React.useState<string | null>(null)

  // Fetch on open via the onOpenChange callback below — keeps the
  // "open triggered a load" lifecycle out of useEffect (which lints
  // complain about for set-state-in-effect).
  const loadIdRef = React.useRef(0)
  async function loadList() {
    const myId = ++loadIdRef.current
    setLoading(true)
    const result = await listChatConversations()
    if (myId !== loadIdRef.current) return
    if (!result.ok) {
      toast.error(result.error)
      setItems([])
    } else {
      setItems(result.items)
    }
    setLoading(false)
  }

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (next) void loadList()
  }

  function handleOpen(id: string) {
    if (id === currentConversationId) {
      setOpen(false)
      return
    }
    setOpen(false)
    router.push(`/chat?c=${encodeURIComponent(id)}`)
  }

  async function handleDelete(item: Item) {
    if (
      !confirm(
        `Delete "${item.title?.trim() || "this conversation"}"? Our questions and answers in this thread go with it.`
      )
    )
      return
    setDeletingId(item.id)
    const result = await deleteConversation(item.id)
    setDeletingId(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setItems((prev) => (prev ?? []).filter((i) => i.id !== item.id))
    toast.success("Deleted.")
    if (item.id === currentConversationId) {
      setOpen(false)
      router.replace("/chat")
    }
  }

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            type="button"
            className="gap-1.5 text-xs"
          />
        }
      >
        <History className="size-3.5" aria-hidden />
        History
      </SheetTrigger>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 sm:max-w-md"
      >
        <SheetHeader>
          <SheetTitle>Past conversations</SheetTitle>
          <SheetDescription>
            Pick up where we left off — or delete anything you don&apos;t need.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-1 py-3">
          {loading || items === null ? (
            <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
              Loading…
            </div>
          ) : items.length === 0 ? (
            <p className="px-3 py-10 text-center text-sm text-muted-foreground">
              Nothing here yet — once we&apos;ve chatted, every thread shows
              up.
            </p>
          ) : (
            <ul className="grid">
              {items.map((item) => {
                const isCurrent = item.id === currentConversationId
                const isDeleting = deletingId === item.id
                const title = item.title?.trim() || "Untitled conversation"
                return (
                  <li
                    key={item.id}
                    className={
                      isCurrent
                        ? "rounded-md border border-primary/30 bg-primary/5"
                        : "rounded-md"
                    }
                  >
                    <div className="flex items-start gap-2 px-3 py-2.5">
                      <button
                        type="button"
                        onClick={() => handleOpen(item.id)}
                        className="flex-1 text-left transition-colors"
                      >
                        <div className="line-clamp-2 text-sm font-medium">
                          {title}
                        </div>
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {relative(item.updated_at)}
                          {isCurrent ? " · open now" : ""}
                        </div>
                      </button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => handleDelete(item)}
                        disabled={isDeleting}
                        aria-label="Delete conversation"
                        className="text-muted-foreground hover:text-destructive"
                      >
                        {isDeleting ? (
                          <Loader2
                            className="size-3.5 animate-spin"
                            aria-hidden
                          />
                        ) : (
                          <Trash2 className="size-3.5" aria-hidden />
                        )}
                      </Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
