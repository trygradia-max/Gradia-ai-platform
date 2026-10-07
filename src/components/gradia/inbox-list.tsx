"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useMemo, useState } from "react"
import { Mail, MessageSquare, Phone } from "lucide-react"

import { threadStateLabels, type InboxThreadItem } from "@/lib/whisper-inbox"
import { StatusPill } from "@/components/ui/status-pill"
import { cn } from "@/lib/utils"

const FILTERS = [
  ["all", "All"],
  ["sms", "Texts"],
  ["email", "Email"],
  ["voice", "Calls"],
] as const

type Filter = (typeof FILTERS)[number][0]

const CHANNEL_ICON = {
  sms: MessageSquare,
  email: Mail,
  voice: Phone,
} as const

const STATE_TONE = {
  needs_reply: "warn",
  awaiting_approval: "accent",
  held: "bad",
  completed: "muted",
} as const

function initials(name: string | null) {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 2)
  if (!parts.length) return "?"
  return parts.map((p) => p[0]?.toUpperCase() ?? "").join("")
}

function when(iso: string) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

export function InboxShopSelect({
  shops,
  shopId,
}: {
  shops: { id: string; name: string }[]
  shopId: string
}) {
  const router = useRouter()
  if (shops.length < 2) return null
  return (
    <label className="mt-3 block text-xs text-muted-foreground">
      <span className="sr-only">Workspace</span>
      <select
        className="h-9 w-full rounded-md border border-border/70 bg-background px-2 text-sm text-foreground"
        value={shopId}
        onChange={(e) => router.push(`/conversations?shop=${e.target.value}`)}
      >
        {shops.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </label>
  )
}

export function InboxList({
  items,
  shopId,
  page,
  activeCustomerId,
  activeChannel,
}: {
  items: InboxThreadItem[]
  shopId: string
  page: number
  activeCustomerId?: string
  activeChannel?: string
}) {
  const [filter, setFilter] = useState<Filter>("all")
  const visible = useMemo(
    () => (filter === "all" ? items : items.filter((t) => t.channel === filter)),
    [filter, items]
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="flex gap-1 border-b border-border/70 px-3 py-2"
        role="group"
        aria-label="Filter"
      >
        {FILTERS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={filter === id}
            onClick={() => setFilter(id)}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground",
              filter === id && "bg-background text-foreground shadow-sm ring-1 ring-border/80"
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-28 sm:pb-0">
        {visible.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            {items.length === 0
              ? "No conversations on this page."
              : "Nothing in this filter on this page."}
          </p>
        ) : (
          <ul>
            {visible.map((t) => {
              const Icon = CHANNEL_ICON[t.channel]
              const active =
                t.customer_id === activeCustomerId && t.channel === activeChannel
              const href = `/conversations/${t.customer_id}?shop=${shopId}&channel=${t.channel}${page > 1 ? `&page=${page}` : ""}`
              return (
                <li key={`${t.customer_id}:${t.channel}`}>
                  <Link
                    href={href}
                    aria-current={active ? "true" : undefined}
                    className={cn(
                      "flex gap-3 border-b border-border/50 px-4 py-3 hover:bg-muted/40",
                      active && "bg-primary/10"
                    )}
                  >
                    <span
                      className={cn(
                        "mt-1.5 size-2 shrink-0 rounded-full",
                        t.unread ? "bg-primary" : "bg-transparent"
                      )}
                      aria-hidden
                    />
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-foreground">
                      {initials(t.customer_name)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span
                          className={cn(
                            "truncate text-sm",
                            t.unread ? "font-semibold" : "font-medium"
                          )}
                        >
                          {t.customer_name ?? "Unnamed customer"}
                        </span>
                        <time
                          className="shrink-0 font-mono text-[11px] text-muted-foreground"
                          dateTime={t.created_at}
                        >
                          {when(t.created_at)}
                        </time>
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-[13px] text-muted-foreground">
                        <Icon className="size-3.5 shrink-0" aria-hidden />
                        <span className="truncate">{t.preview || "No preview"}</span>
                      </span>
                      <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <StatusPill tone={STATE_TONE[t.state]} size="sm">
                          {threadStateLabels[t.state]}
                        </StatusPill>
                        {t.notified ? (
                          <StatusPill tone="accent" size="sm">
                            New handoff
                          </StatusPill>
                        ) : null}
                      </span>
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
