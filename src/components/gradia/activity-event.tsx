import Link from "next/link"
import {
  Calendar,
  Check,
  Mail,
  MessageSquare,
  StickyNote,
  UserPlus,
  type LucideIcon,
} from "lucide-react"

import type { AgentActivityItem } from "@/lib/data/pending-actions"

/**
 * Autonomous-mode render of an agent action (BUILD_REFERENCE §5): a completed,
 * logged "done event" — the counterpart to the suggest-mode ApprovalCard.
 * Undo/Flag are follow-ups; for now it links through to the customer.
 */
const ICONS: Record<string, LucideIcon> = {
  send_sms: MessageSquare,
  send_email: Mail,
  create_lead: UserPlus,
  add_note: StickyNote,
  book_appointment: Calendar,
}

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return "just now"
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return d === 1 ? "yesterday" : `${d}d ago`
}

export function ActivityEvent({ item }: { item: AgentActivityItem }) {
  const Icon = ICONS[item.actionType] ?? Check
  const href = item.customerId
    ? `/customers/${item.customerId}`
    : `/approvals/${item.id}`
  return (
    <div className="flex items-center gap-3 rounded-md border border-border/50 bg-card/30 px-4 py-3">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
        <Icon className="size-4" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-foreground">{item.summary}</p>
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <Check
            className="size-3 text-status-success-fg"
            aria-hidden
          />
          Done · {ago(item.at)}
        </p>
      </div>
      <Link
        href={href}
        className="shrink-0 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        View
      </Link>
    </div>
  )
}
