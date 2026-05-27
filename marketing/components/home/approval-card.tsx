"use client"

import {
  Check,
  Pencil,
  X,
  Phone,
  Mail,
  MessageSquare,
  AtSign,
  CreditCard,
  type LucideIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"

export type ApprovalChannel = "voice" | "email" | "sms" | "instagram" | "billing"

const CHANNEL: Record<
  ApprovalChannel,
  { icon: LucideIcon; label: string; tile: string }
> = {
  voice: {
    icon: Phone,
    label: "Voice",
    tile: "bg-emerald-500/12 text-emerald-400 ring-emerald-500/25",
  },
  email: {
    icon: Mail,
    label: "Email",
    tile: "bg-sky-500/12 text-sky-400 ring-sky-500/25",
  },
  sms: {
    icon: MessageSquare,
    label: "SMS",
    tile: "bg-amber-500/12 text-amber-400 ring-amber-500/25",
  },
  instagram: {
    icon: AtSign,
    label: "Instagram",
    tile: "bg-pink-500/12 text-pink-400 ring-pink-500/25",
  },
  billing: {
    icon: CreditCard,
    label: "Billing",
    tile: "bg-primary/12 text-primary ring-primary/25",
  },
}

/**
 * The HITL approval card — a faithful CSS rendering of what lands in the
 * operator's Slack. Built in markup (not an image) so it stays crisp and
 * on-brand. Drives the pinned "how a lead flows" storytelling.
 */
export function ApprovalCard({
  channel,
  customer,
  vehicle,
  inbound,
  draft,
  meta,
  className,
}: {
  channel: ApprovalChannel
  customer: string
  vehicle?: string
  inbound: string
  draft: string
  meta?: string
  className?: string
}) {
  const c = CHANNEL[channel]
  const Icon = c.icon
  return (
    <div
      className={cn(
        "glass-card w-full max-w-sm overflow-hidden rounded-2xl shadow-2xl shadow-black/40",
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border/60 px-5 py-3.5">
        <div
          className={cn(
            "flex size-8 items-center justify-center rounded-lg ring-1",
            c.tile
          )}
        >
          <Icon className="size-4" aria-hidden />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">
            {customer}
            {vehicle && (
              <span className="text-muted-foreground"> · {vehicle}</span>
            )}
          </p>
          <p className="text-[11px] text-muted-foreground">
            New {c.label.toLowerCase()} · proposed by Gradia
          </p>
        </div>
        <span className="ml-auto flex items-center gap-1.5 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary ring-1 ring-primary/20">
          <span className="size-1.5 animate-pulse rounded-full bg-primary" />
          Pending
        </span>
      </div>

      {/* Inbound */}
      <div className="space-y-3 px-5 py-4">
        <div className="rounded-xl bg-background/60 px-3.5 py-2.5 text-sm text-muted-foreground ring-1 ring-border/50">
          {inbound}
        </div>

        {/* Drafted reply */}
        <div>
          <p className="label-eyebrow mb-1.5 text-muted-foreground/60">
            Gradia drafted
          </p>
          <div className="rounded-xl bg-primary/8 px-3.5 py-2.5 text-sm leading-relaxed text-foreground ring-1 ring-primary/20">
            {draft}
          </div>
        </div>

        {meta && (
          <p className="text-[11px] text-muted-foreground/80">{meta}</p>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 border-t border-border/60 bg-background/40 px-5 py-3">
        <button
          data-cursor="cta"
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-all hover:brightness-110"
        >
          <Check className="size-3.5" /> Approve
        </button>
        <button
          data-cursor="cta"
          className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground transition-colors hover:bg-muted"
        >
          <Pencil className="size-3.5" /> Edit
        </button>
        <button
          data-cursor="cta"
          aria-label="Reject"
          className="inline-flex items-center justify-center rounded-lg border border-border bg-card p-2 text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  )
}
