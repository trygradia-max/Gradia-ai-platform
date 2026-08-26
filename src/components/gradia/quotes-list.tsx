"use client"

import * as React from "react"
import Link from "next/link"
import { ExternalLink, FileText, Loader2, MessageSquare } from "lucide-react"
import { toast } from "sonner"

import { sendQuote, type QuoteListEntry } from "@/app/actions/quotes"
import { Button } from "@/components/ui/button"
import { formatPriceUsd } from "@/lib/service-pricing"
import { quotePath } from "@/lib/quotes"
import type { QuoteStatus } from "@/lib/types/database"

/**
 * Quotes tab (C3b) — status-grouped list. Every row has an owner-clickable
 * action: send a draft, open the public page, copy the link.
 */

const GROUPS: { status: QuoteStatus; title: string; blurb: string }[] = [
  { status: "draft", title: "Drafts", blurb: "Priced but not sent — one tap to send." },
  { status: "sent", title: "Sent", blurb: "Waiting on the customer." },
  { status: "viewed", title: "Opened", blurb: "They've looked — a nudge works here." },
  { status: "accepted", title: "Accepted", blurb: "Won — get them scheduled." },
  { status: "booked", title: "Booked", blurb: "Accepted and on the calendar." },
  { status: "declined", title: "Declined", blurb: "Passed this time." },
  { status: "expired", title: "Expired", blurb: "Past their validity date." },
]

function relTime(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000))
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export function QuotesList({ quotes }: { quotes: QuoteListEntry[] }) {
  const [sending, setSending] = React.useState<string | null>(null)
  const [rows, setRows] = React.useState(quotes)

  async function sendDraft(id: string) {
    setSending(id)
    const result = await sendQuote(id, "sms")
    setSending(null)
    if (!result.ok) {
      toast[result.held ? "info" : "error"](
        result.held ? `Waiting in Approvals: ${result.error}` : result.error
      )
      return
    }
    toast.success("Quote sent by text.")
    setRows((prev) =>
      prev.map((q) => (q.id === id ? { ...q, status: "sent" as QuoteStatus } : q))
    )
  }

  function copyLink(token: string | null) {
    if (!token) return
    void navigator.clipboard.writeText(`${window.location.origin}${quotePath(token)}`)
    toast.success("Quote link copied.")
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-border/60 bg-card px-6 py-16 text-center">
        <FileText className="mx-auto size-6 text-muted-foreground" aria-hidden />
        <p className="mt-3 font-display text-xl text-foreground">
          No quotes <span className="italic">yet</span>.
        </p>
        <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted-foreground">
          Price a job once and send it as a link — the customer can accept and
          book from their phone.
        </p>
        <Link
          href="/customers/quotes/new"
          className="mt-4 inline-flex h-10 items-center rounded-sm bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          New quote
        </Link>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {GROUPS.map((g) => {
        const items = rows.filter((q) => q.status === g.status)
        if (items.length === 0) return null
        return (
          <section key={g.status} className="space-y-3">
            <div>
              <p className="label-eyebrow text-muted-foreground/70">
                {g.title} · {items.length}
              </p>
              <p className="text-sm text-muted-foreground">{g.blurb}</p>
            </div>
            <ul className="divide-y divide-border/60 rounded-md border border-border/60">
              {items.map((q) => (
                <li
                  key={q.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {q.customer_name ?? "Customer"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      <span className="font-data">{formatPriceUsd(q.total_cents)}</span>
                      {" · "}
                      {(q.line_items ?? []).length} item
                      {(q.line_items ?? []).length === 1 ? "" : "s"}
                      {" · "}
                      {relTime(q.created_at)}
                      {q.created_by === "agent" ? " · drafted from a call" : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {q.status === "draft" ? (
                      <Button
                        type="button"
                        size="sm"
                        className="h-8 gap-1.5"
                        disabled={sending === q.id}
                        onClick={() => sendDraft(q.id)}
                      >
                        {sending === q.id ? (
                          <Loader2 className="size-3.5 animate-spin" aria-hidden />
                        ) : (
                          <MessageSquare className="size-3.5" aria-hidden />
                        )}
                        Send by text
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8"
                      onClick={() => copyLink(q.public_token)}
                    >
                      Copy link
                    </Button>
                    {q.public_token ? (
                      <Link
                        href={quotePath(q.public_token)}
                        target="_blank"
                        className="text-muted-foreground transition-colors hover:text-foreground"
                        aria-label="Open the public quote page"
                      >
                        <ExternalLink className="size-4" aria-hidden />
                      </Link>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
