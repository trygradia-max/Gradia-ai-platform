"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  ArrowUpRight,
  Calendar,
  Flame,
  Hourglass,
  Loader2,
  Send,
  Sparkles,
} from "lucide-react"
import { toast } from "sonner"

import { draftFollowupForLead } from "@/app/actions/co-owner"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import type { CoOwnerSuggestion } from "@/lib/data/co-owner"

export function CoOwnerCard({
  suggestions,
}: {
  suggestions: CoOwnerSuggestion[]
}) {
  const router = useRouter()
  const [busyId, setBusyId] = React.useState<string | null>(null)

  if (suggestions.length === 0) {
    return (
      <Card className="border-border/80">
        <CardHeader className="flex flex-row items-center gap-3 space-y-0 pb-2">
          <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
            <Sparkles className="size-5 text-primary" aria-hidden />
          </div>
          <div>
            <CardTitle className="text-base font-medium">
              What I&apos;d tackle next
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Quiet right now — we&apos;re caught up on follow-ups.
            </p>
          </div>
        </CardHeader>
      </Card>
    )
  }

  async function handleDraft(leadId: string) {
    setBusyId(leadId)
    const result = await draftFollowupForLead(leadId)
    setBusyId(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success("Drafted — review it in Approvals.")
    router.refresh()
  }

  return (
    <Card className="border-border/80">
      <CardHeader className="flex flex-row items-center gap-3 space-y-0 pb-2">
        <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
          <Sparkles className="size-5 text-primary" aria-hidden />
        </div>
        <div className="flex-1">
          <CardTitle className="text-base font-medium">
            What I&apos;d tackle next
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Proactive nudges from what I&apos;m seeing — one tap to draft a
            follow-up.
          </p>
        </div>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-2">
          {suggestions.map((s) => {
            const key =
              s.kind === "upcoming_appointment"
                ? `appt:${s.appointmentId}`
                : `${s.kind}:${s.leadId}`
            return (
              <li key={key}>
                <SuggestionRow
                  suggestion={s}
                  busy={
                    s.kind !== "upcoming_appointment" && busyId === s.leadId
                  }
                  disabled={busyId !== null}
                  onDraft={handleDraft}
                />
              </li>
            )
          })}
        </ul>
      </CardContent>
    </Card>
  )
}

function SuggestionRow({
  suggestion,
  busy,
  disabled,
  onDraft,
}: {
  suggestion: CoOwnerSuggestion
  busy: boolean
  disabled: boolean
  onDraft: (leadId: string) => void
}) {
  if (suggestion.kind === "upcoming_appointment") {
    const when = new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(suggestion.whenIso))
    return (
      <Link
        href="/schedule"
        className="group flex items-start gap-3 rounded-md border border-border/60 bg-muted/15 px-3 py-2.5 transition hover:bg-muted/30"
      >
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-background">
          <Calendar className="size-4 text-amber-600 dark:text-amber-400" aria-hidden />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">
            {suggestion.customerName}
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {when}
            </span>
          </p>
          <p className="text-xs text-muted-foreground">
            {suggestion.service
              ? `${suggestion.service} · on the books soon`
              : "On the books soon — make sure they confirmed."}
          </p>
        </div>
        <ArrowUpRight
          className="mt-1 size-3.5 shrink-0 text-muted-foreground opacity-0 transition group-hover:opacity-100"
          aria-hidden
        />
      </Link>
    )
  }

  const Icon =
    suggestion.kind === "hot_lead_followup" ? Flame : Hourglass
  const iconClass =
    suggestion.kind === "hot_lead_followup"
      ? "text-red-600 dark:text-red-400"
      : "text-muted-foreground"

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border/60 bg-muted/15 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-background">
        <Icon className={`size-4 ${iconClass}`} aria-hidden />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">
          {suggestion.customerName}
          {suggestion.phone ? (
            <span className="ml-2 text-xs font-normal tabular-nums text-muted-foreground">
              {suggestion.phone}
            </span>
          ) : null}
        </p>
        <p className="text-xs text-muted-foreground">{suggestion.reason}</p>
      </div>
      <div className="flex items-center gap-2 sm:flex-none">
        {suggestion.phone ? (
          <Button
            type="button"
            size="sm"
            onClick={() => onDraft(suggestion.leadId)}
            disabled={disabled}
            className="h-10 gap-1.5 sm:h-8"
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <Send className="size-3.5" aria-hidden />
            )}
            Draft follow-up
          </Button>
        ) : (
          <Link
            href={`/leads`}
            className="text-xs text-muted-foreground hover:underline"
          >
            No phone — open lead
          </Link>
        )}
      </div>
    </div>
  )
}
