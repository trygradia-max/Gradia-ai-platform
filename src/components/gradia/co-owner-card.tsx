"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  ArrowUpRight,
  Calendar,
  CalendarClock,
  Flame,
  Hourglass,
  Loader2,
  Plug,
  Send,
} from "lucide-react"
import { toast } from "sonner"

import { draftFollowupForLead } from "@/app/actions/co-owner"
import { Button } from "@/components/ui/button"
import { MotionCard } from "@/components/gradia/motion/motion-card"
import {
  PageStagger,
  StaggerItem,
} from "@/components/gradia/motion/page-stagger"
import { SectionHeader } from "@/components/gradia/section-header"
import type { CoOwnerSuggestion } from "@/lib/data/co-owner"
import { cn } from "@/lib/utils"

/**
 * Proactive nudge surface. Lives high on the dashboard so the
 * owner sees "what to tackle next" before they even scroll. Each
 * row is a one-tap follow-up — drafts an SMS, lands it in
 * Approvals, the operator approves once.
 */
export function CoOwnerCard({
  suggestions,
}: {
  suggestions: CoOwnerSuggestion[]
}) {
  const router = useRouter()
  const [busyId, setBusyId] = React.useState<string | null>(null)

  async function handleDraft(leadId: string) {
    setBusyId(leadId)
    const result = await draftFollowupForLead(leadId)
    setBusyId(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success("Drafted — it's waiting in Approvals.")
    router.refresh()
  }

  return (
    <section className="space-y-5">
      <SectionHeader
        eyebrow="Co-owner"
        title={
          <>
            What <span className="italic">I&apos;d</span>{" "}tackle next.
          </>
        }
        subhead={
          suggestions.length === 0
            ? "Quiet right now — we're caught up on follow-ups."
            : "Real nudges from what I'm seeing. One tap and a draft is waiting for you."
        }
      />

      {suggestions.length === 0 ? (
        <MotionCard
          interactive={false}
          className="p-8 text-center text-sm text-muted-foreground"
        >
          Nothing to chase right now. Go finish that car.
        </MotionCard>
      ) : (
        <PageStagger className="grid gap-2">
          {suggestions.map((s) => {
            const key =
              s.kind === "setup"
                ? s.id
                : s.kind === "upcoming_appointment" ||
                    s.kind === "unconfirmed_appointment"
                  ? `appt:${s.appointmentId}`
                  : `${s.kind}:${s.leadId}`
            return (
              <StaggerItem key={key}>
                <SuggestionRow
                  suggestion={s}
                  busy={
                    s.kind !== "upcoming_appointment" &&
                    s.kind !== "unconfirmed_appointment" &&
                    s.kind !== "setup" &&
                    busyId === s.leadId
                  }
                  disabled={busyId !== null}
                  onDraft={handleDraft}
                />
              </StaggerItem>
            )
          })}
        </PageStagger>
      )}
    </section>
  )
}

const TONE_BY_KIND: Record<
  CoOwnerSuggestion["kind"],
  { icon: typeof Flame; ringClass: string; iconClass: string }
> = {
  setup: {
    icon: Plug,
    ringClass: "",
    iconClass: "text-primary",
  },
  hot_lead_followup: {
    icon: Flame,
    ringClass:
      "before:bg-gradient-to-b before:from-primary/30 before:via-primary/10 before:to-transparent",
    iconClass: "text-primary",
  },
  stale_new_lead: {
    icon: Hourglass,
    ringClass: "",
    iconClass: "text-muted-foreground",
  },
  upcoming_appointment: {
    icon: Calendar,
    ringClass: "",
    iconClass: "text-foreground",
  },
  unconfirmed_appointment: {
    icon: CalendarClock,
    ringClass:
      "before:bg-gradient-to-b before:from-status-warning-fg/40 before:via-status-warning-fg/15 before:to-transparent",
    iconClass: "text-status-warning-fg",
  },
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
  const tone = TONE_BY_KIND[suggestion.kind]
  const Icon = tone.icon

  // Setup the owner deferred in the wizard — one quiet row, one button.
  if (suggestion.kind === "setup") {
    return (
      <MotionCard interactive className="group relative overflow-hidden p-0">
        <Link
          href={suggestion.href}
          className="flex items-start gap-3 px-4 py-3.5"
        >
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background/60 ring-1 ring-border/60">
            <Icon className={cn("size-4", tone.iconClass)} aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">
              {suggestion.title}
            </p>
            <p className="text-xs text-muted-foreground">{suggestion.body}</p>
          </div>
          <span className="mt-0.5 shrink-0 text-xs font-medium text-primary">
            {suggestion.cta}
          </span>
        </Link>
      </MotionCard>
    )
  }

  if (suggestion.kind === "upcoming_appointment") {
    const when = new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(suggestion.whenIso))
    return (
      <MotionCard
        interactive
        className="group relative overflow-hidden p-0"
      >
        <Link
          href="/schedule"
          className="flex items-start gap-3 px-4 py-3.5"
        >
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background/60 ring-1 ring-border/60">
            <Icon className={cn("size-4", tone.iconClass)} aria-hidden />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground">
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
      </MotionCard>
    )
  }

  if (suggestion.kind === "unconfirmed_appointment") {
    const when = new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(suggestion.whenIso))
    return (
      <MotionCard
        interactive
        className={cn("group relative overflow-hidden p-0", tone.ringClass &&
          "before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:content-['']",
          tone.ringClass)}
      >
        <Link href="/schedule" className="flex items-start gap-3 px-4 py-3.5">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background/60 ring-1 ring-border/60">
            <Icon className={cn("size-4", tone.iconClass)} aria-hidden />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground">
              {suggestion.customerName}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {when}
              </span>
            </p>
            <p className="text-xs text-muted-foreground">
              {suggestion.service
                ? `${suggestion.service} — hasn't confirmed yet. Nudge them or backfill the slot.`
                : "Hasn't confirmed yet. Nudge them or backfill the slot."}
            </p>
          </div>
          <ArrowUpRight
            className="mt-1 size-3.5 shrink-0 text-muted-foreground opacity-0 transition group-hover:opacity-100"
            aria-hidden
          />
        </Link>
      </MotionCard>
    )
  }

  const reason =
    suggestion.kind === "hot_lead_followup"
      ? suggestion.reason
      : `Cold for ${suggestion.daysOld} days — worth a check-in.`

  return (
    <MotionCard
      interactive

      className={cn(
        "relative overflow-hidden",
        // Accent rail on hot leads — 2px gradient strip down the left
        suggestion.kind === "hot_lead_followup" &&
          "before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:content-['']",
        tone.ringClass
      )}
    >
      <div className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background/60 ring-1 ring-border/60">
          <Icon className={cn("size-4", tone.iconClass)} aria-hidden />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground">
            {suggestion.customerName}
            {suggestion.phone ? (
              <span className="ml-2 text-xs font-normal tabular-nums text-muted-foreground">
                {suggestion.phone}
              </span>
            ) : null}
          </p>
          <p className="text-xs text-muted-foreground">{reason}</p>
        </div>
        <div className="flex items-center gap-2 sm:flex-none">
          {suggestion.phone ? (
            <Button
              type="button"
              size="sm"
              onClick={() => onDraft(suggestion.leadId)}
              disabled={disabled}
              className="h-9 gap-1.5"
            >
              {busy ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <Send className="size-3.5" aria-hidden />
              )}
              Draft the text
            </Button>
          ) : (
            <Link
              href="/customers"
              className="text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              Open the lead →
            </Link>
          )}
        </div>
      </div>
    </MotionCard>
  )
}
