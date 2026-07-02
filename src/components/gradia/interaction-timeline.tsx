"use client"

import * as React from "react"
import {
  Mail,
  MessageSquare,
  Phone,
  Pin,
  Sparkles,
  type LucideIcon,
} from "lucide-react"

import { MotionCard } from "@/components/gradia/motion/motion-card"
import {
  PageStagger,
  StaggerItem,
} from "@/components/gradia/motion/page-stagger"
import { SectionHeader } from "@/components/gradia/motion/section-header"
import { StatusPill, type StatusPillTone } from "@/components/ui/status-pill"
import type {
  InteractionChannel,
  InteractionRow,
} from "@/lib/types/database"
import { cn } from "@/lib/utils"

const CHANNEL_META: Record<
  InteractionChannel,
  { icon: LucideIcon; label: string; tile: string }
> = {
  voice: {
    icon: Phone,
    label: "Call",
    tile: "bg-emerald-500/12 text-emerald-500 ring-emerald-500/25 dark:text-emerald-400",
  },
  sms: {
    icon: MessageSquare,
    label: "SMS",
    tile: "bg-amber-500/12 text-amber-500 ring-amber-500/25 dark:text-amber-400",
  },
  email: {
    icon: Mail,
    label: "Email",
    tile: "bg-sky-500/12 text-sky-500 ring-sky-500/25 dark:text-sky-400",
  },
  web: {
    icon: Sparkles,
    label: "Web",
    tile: "bg-primary/12 text-primary ring-primary/25",
  },
  note: {
    icon: Pin,
    label: "Note",
    tile: "bg-muted text-muted-foreground ring-border/60",
  },
}

type StatusBadge = {
  label: string
  tone: StatusPillTone
  hint?: string | null
}

function pickStatusBadge(it: InteractionRow): StatusBadge | null {
  const meta = (it.metadata as Record<string, unknown> | null) ?? {}
  // Outbound SMS — Twilio status callback writes here.
  if (it.channel === "sms" && meta.direction === "outbound") {
    const status =
      typeof meta.twilio_status === "string"
        ? meta.twilio_status.toLowerCase()
        : ""
    const errorCode =
      meta.twilio_error_code != null ? String(meta.twilio_error_code) : null
    if (status === "delivered") return { label: "Delivered", tone: "good" }
    if (status === "failed" || status === "undelivered") {
      return {
        label: "Failed",
        tone: "bad",
        hint: errorCode ? `Twilio error ${errorCode}` : null,
      }
    }
    if (status === "sent") return { label: "Sent", tone: "muted" }
    if (status === "queued") return { label: "Queued", tone: "muted" }
  }
  // Charges land as channel=note with Stripe metadata.
  if (it.channel === "note" && typeof meta.stripe_invoice_id === "string") {
    const refundStatus =
      typeof meta.stripe_refund_status === "string"
        ? meta.stripe_refund_status.toLowerCase()
        : ""
    if (refundStatus === "refunded") {
      return { label: "Refunded", tone: "bad" }
    }
    if (refundStatus === "partially_refunded") {
      return { label: "Partial refund", tone: "warn" }
    }
    const status =
      typeof meta.stripe_payment_status === "string"
        ? meta.stripe_payment_status.toLowerCase()
        : ""
    if (status === "paid") return { label: "Paid", tone: "good" }
    if (status === "payment_failed") {
      return { label: "Payment failed", tone: "bad" }
    }
    return { label: "Invoice sent", tone: "muted" }
  }
  return null
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime()
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (seconds < 60) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"} ago`
  const days = Math.round(hours / 24)
  if (days < 14) return `${days} day${days === 1 ? "" : "s"} ago`
  const weeks = Math.round(days / 7)
  return `${weeks} wk${weeks === 1 ? "" : "s"} ago`
}

function roleLabel(role: InteractionRow["role"]): string {
  if (role === "customer") return "from them"
  if (role === "gradia") return "from us"
  return "system"
}

export function InteractionTimeline({
  interactions,
}: {
  interactions: InteractionRow[]
}) {
  return (
    <section className="space-y-4">
      <SectionHeader
        eyebrow="Activity"
        title={
          <>
            Every <span className="italic">touchpoint</span>.
          </>
        }
        subtitle="The last 50 across every channel — newest first."
      />

      {interactions.length === 0 ? (
        <MotionCard
          interactive={false}
          className="px-6 py-12 text-center"
        >
          <p className="font-display text-xl text-foreground sm:text-2xl">
            <span className="italic">Quiet</span>{" "}so far.
          </p>
          <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
            We&apos;ll fill this in the moment they call, text, email, or
            DM us.
          </p>
        </MotionCard>
      ) : (
        <PageStagger className="grid gap-2">
          {interactions.map((it) => (
            <StaggerItem key={it.id}>
              <InteractionRowCard interaction={it} />
            </StaggerItem>
          ))}
        </PageStagger>
      )}
    </section>
  )
}

function InteractionRowCard({ interaction }: { interaction: InteractionRow }) {
  const meta = CHANNEL_META[interaction.channel] ?? CHANNEL_META.note
  const Icon = meta.icon
  const status = pickStatusBadge(interaction)
  const preview =
    interaction.content.length > 360
      ? `${interaction.content.slice(0, 360)}…`
      : interaction.content

  return (
    <MotionCard
      interactive={false}
      className="overflow-hidden p-4 sm:p-4"
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-lg ring-1",
            meta.tile
          )}
        >
          <Icon className="size-4" aria-hidden />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-sm font-medium text-foreground">
                {meta.label}
              </span>
              <span className="label-eyebrow !text-muted-foreground/70">
                {roleLabel(interaction.role)}
              </span>
              {status ? (
                <StatusPill
                  tone={status.tone}
                  className={
                    status.hint ? "" : undefined
                  }
                >
                  <span title={status.hint ?? undefined}>{status.label}</span>
                </StatusPill>
              ) : null}
            </div>
            <span
              className="shrink-0 text-xs tabular-nums text-muted-foreground"
              title={new Date(interaction.occurred_at).toISOString()}
            >
              {formatRelative(interaction.occurred_at)}
            </span>
          </div>
          <p className="whitespace-pre-line text-sm text-foreground/90">
            {preview}
          </p>
        </div>
      </div>
    </MotionCard>
  )
}
