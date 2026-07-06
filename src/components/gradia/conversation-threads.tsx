import Link from "next/link"
import { MessageSquare, PhoneCall, Sparkles, User } from "lucide-react"

import { EmptyState } from "@/components/gradia/empty-state"
import { StatusPill } from "@/components/ui/status-pill"
import type { ConversationThread } from "@/lib/data/conversations"
import { STRINGS } from "@/lib/strings"

function relative(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (seconds < 60) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? "" : "s"} ago`
}

/**
 * The Conversations thread list: one row per customer+channel, previewed
 * by its latest STORED turn (verbatim — generated summaries are L4).
 * Indicators are all real data: channel icon, who spoke last (the
 * receptionist = AI flag), and "Needs you" only when an open
 * pending_action references the customer.
 */
export function ConversationThreads({
  threads,
}: {
  threads: ConversationThread[]
}) {
  if (threads.length === 0) {
    return (
      <EmptyState
        title="No calls yet."
        description={STRINGS.empty.conversationsFirstUse}
      />
    )
  }

  return (
    <ul className="divide-y divide-border/60 rounded-md border border-border/60 bg-card">
      {threads.map((t) => {
        const row = (
          <div className="flex items-start gap-3.5 px-4 py-3.5">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-sm bg-muted/60 text-muted-foreground">
              {t.channel === "voice" ? (
                <PhoneCall className="size-4" aria-hidden />
              ) : (
                <MessageSquare className="size-4" aria-hidden />
              )}
            </div>
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="flex items-baseline justify-between gap-3">
                <p className="truncate text-sm font-medium text-foreground">
                  {t.customerName ?? "Unknown caller"}
                </p>
                <p className="shrink-0 font-data text-xs text-muted-foreground">
                  {relative(t.lastAt)}
                </p>
              </div>
              <p className="truncate text-sm text-muted-foreground">
                {t.preview}
              </p>
              <div className="flex items-center gap-2 pt-1">
                {/* Who spoke last — icon + text, never color alone. */}
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  {t.lastRole === "gradia" ? (
                    <>
                      <Sparkles className="size-3" aria-hidden />
                      Receptionist replied
                    </>
                  ) : (
                    <>
                      <User className="size-3" aria-hidden />
                      Caller spoke last
                    </>
                  )}
                </span>
                <span className="font-data text-xs text-muted-foreground/70">
                  {t.turnCount} {t.turnCount === 1 ? "turn" : "turns"}
                </span>
                {t.needsYou ? (
                  <StatusPill tone="warn">Needs you</StatusPill>
                ) : null}
              </div>
            </div>
          </div>
        )
        return (
          <li key={t.key}>
            {t.customerId ? (
              <Link
                href={`/customers/${t.customerId}`}
                className="block transition-colors duration-150 hover:bg-accent"
              >
                {row}
              </Link>
            ) : (
              row
            )}
          </li>
        )
      })}
    </ul>
  )
}
