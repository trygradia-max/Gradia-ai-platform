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

import { StatusPill } from "@/components/ui/status-pill"
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
    <div className="flex items-center gap-3 rounded-md bg-card px-4 py-3 ring-1 ring-border">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-sm bg-muted text-muted-foreground">
        <Icon className="size-4" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-foreground">{item.summary}</p>
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <StatusPill tone="good">Done</StatusPill>
          <span>{ago(item.at)}</span>
        </p>
      </div>
      <Link
        href={href}
        className="inline-flex min-h-11 shrink-0 items-center text-sm font-medium text-accent-text underline-offset-4 hover:underline"
      >
        View
      </Link>
    </div>
  )
}
