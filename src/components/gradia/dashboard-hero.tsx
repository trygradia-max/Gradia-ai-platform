import type { ReactNode } from "react"
import Link from "next/link"

import { SectionHeader } from "@/components/gradia/section-header"
import { StatusPill, type StatusPillTone } from "@/components/ui/status-pill"
import type { ChannelSummary } from "@/lib/data/channels"

function channelTone(status: ChannelSummary["status"]): StatusPillTone {
  if (status === "connected") return "good"
  if (status === "partial") return "warn"
  return "muted"
}

function channelLabel(status: ChannelSummary["status"]): string {
  if (status === "connected") return "Connected"
  if (status === "partial") return "Needs setup"
  return "Not connected"
}

export function DashboardHero({
  shopName,
  channels,
  eyebrow,
  rightSlot,
}: {
  shopName: string
  channels: ChannelSummary[]
  /** Pre-computed on the server so SSR + first paint agree. */
  eyebrow: string
  /** Right-aligned action area (e.g. Add lead button). */
  rightSlot?: ReactNode
}) {
  const live = channels.filter((channel) => channel.status === "connected").length
  const allLive = live === channels.length && channels.length > 0
  const channelLine = allLive
    ? `All ${channels.length} channels connected`
    : `${live} of ${channels.length} channels connected`

  return (
    <section className="space-y-5 rounded-md bg-card px-6 py-6 ring-1 ring-border sm:px-8 sm:py-7">
      <SectionHeader
        level={1}
        eyebrow={eyebrow}
        title={
          <>
            Today at <span className="text-muted-foreground">{shopName}</span>
          </>
        }
        subhead={channelLine}
        action={rightSlot}
      />

      <ul className="grid gap-2 sm:grid-cols-2">
        {channels.map((channel) => (
          <li key={channel.id}>
            <Link
              href={channel.href}
              className="flex min-h-11 items-center justify-between gap-3 rounded-md px-3 py-2 ring-1 ring-border outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <span className="min-w-0">
                <span className="block text-sm text-foreground">{channel.label}</span>
                {channel.hint ? (
                  <span className="block text-xs text-muted-foreground">{channel.hint}</span>
                ) : null}
              </span>
              <StatusPill tone={channelTone(channel.status)}>
                {channelLabel(channel.status)}
              </StatusPill>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
