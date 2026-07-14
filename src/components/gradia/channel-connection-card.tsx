"use client"

import * as React from "react"
import Link from "next/link"
import {
  ArrowUpRight,
  CalendarDays,
  CheckCircle2,
  Circle,
  CircleAlert,
  CreditCard,
  Mail,
  MessageSquare,
  Phone,
} from "lucide-react"

import { MotionCard } from "@/components/gradia/motion/motion-card"
import {
  PageStagger,
  StaggerItem,
} from "@/components/gradia/motion/page-stagger"
import { PulseDot } from "@/components/gradia/motion/pulse-dot"
import { SectionHeader } from "@/components/gradia/section-header"
import { StatusPill, type StatusPillTone } from "@/components/ui/status-pill"
import type { ChannelId, ChannelSummary } from "@/lib/data/channels"
import { cn } from "@/lib/utils"

const ICONS: Record<ChannelId, typeof Phone> = {
  voice: Phone,
  email: Mail,
  sms: MessageSquare,
  calendar: CalendarDays,
  payments: CreditCard,
}

const STATUS_TONE: Record<ChannelSummary["status"], StatusPillTone> = {
  connected: "good",
  partial: "warn",
  off: "muted",
}

const STATUS_ORDER: Record<ChannelSummary["status"], number> = {
  partial: 0,
  connected: 1,
  off: 2,
}

export function ChannelConnectionCard({
  channels,
}: {
  channels: ChannelSummary[]
}) {
  const connected = channels.filter((c) => c.status === "connected").length
  const total = channels.length
  const allLive = total > 0 && connected === total

  // Surface anything needing attention first, then live channels, then off.
  // Tradesperson-friendly order: "what should I fix?" → "what's running?" → "what's not on yet?"
  const sorted = React.useMemo(
    () =>
      [...channels].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]),
    [channels]
  )

  const firstActionable = sorted.find((c) => c.status !== "connected")

  return (
    <section id="channels" className="scroll-mt-20 space-y-5">
      <SectionHeader
        eyebrow="Channels"
        title={
          allLive ? (
            <>
              <span className="italic">Everywhere</span>{" "}they reach out, we&apos;re there.
            </>
          ) : (
            <>
              Where we&apos;re <span className="italic">listening</span>.
            </>
          )
        }
        subhead={
          allLive
            ? `All ${total} lines covered — voice, email, SMS, social, payments.`
            : firstActionable
              ? `${connected} of ${total} live — ${firstActionable.label} is the next one to wire up.`
              : `${connected} of ${total} live.`
        }
      />

      <PageStagger className="grid gap-2 sm:grid-cols-2">
        {sorted.map((channel) => (
          <StaggerItem key={channel.id}>
            <ChannelRow channel={channel} />
          </StaggerItem>
        ))}
      </PageStagger>
    </section>
  )
}

function ChannelRow({ channel }: { channel: ChannelSummary }) {
  const Icon = ICONS[channel.id]
  const isLive = channel.status === "connected"
  const needsAttention = channel.status === "partial"
  const StatusIcon = isLive
    ? CheckCircle2
    : needsAttention
      ? CircleAlert
      : Circle
  const statusLabel = isLive ? "Live" : needsAttention ? "Needs info" : "Off"

  return (
    <MotionCard
      interactive

      className={cn(
        "group relative h-full overflow-hidden p-0",
        // Subtle accent rail on rows that need attention — operator's eye
        // lands on what to fix before what's already humming.
        needsAttention &&
          "before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:bg-gradient-to-b before:from-status-warning-fg/60 before:via-status-warning-fg/20 before:to-transparent before:content-['']"
      )}
    >
      <Link
        href={channel.href}
        aria-label={`${channel.label} — ${statusLabel}`}
        className="flex h-full items-start gap-3 px-4 py-3.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <div
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-lg ring-1 transition-colors",
            isLive
              ? "bg-status-success-bg text-status-success-fg ring-status-success/25"
              : needsAttention
                ? "bg-status-warning-bg text-status-warning-fg ring-status-warning/25"
                : "bg-background/60 text-muted-foreground ring-border/60"
          )}
        >
          <Icon className="size-4" aria-hidden />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 truncate text-sm font-medium text-foreground">
              <span className="truncate">{channel.label}</span>
              {isLive ? (
                <PulseDot tone="good" size={5} className="shrink-0" />
              ) : null}
            </p>
            <StatusPill
              tone={STATUS_TONE[channel.status]}
              icon={<StatusIcon className="size-3" aria-hidden />}
            >
              {statusLabel}
            </StatusPill>
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            {channel.hint ?? channel.description}
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
