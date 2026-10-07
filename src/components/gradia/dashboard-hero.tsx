"use client"

import * as React from "react"

import {
  PageStagger,
  StaggerItem,
} from "@/components/gradia/motion/page-stagger"
import { PulseDot } from "@/components/gradia/motion/pulse-dot"

export function DashboardHero({
  shopName,
  liveChannelCount,
  totalChannels,
  eyebrow,
  status,
  rightSlot,
}: {
  shopName: string
  liveChannelCount: number
  totalChannels: number
  /** Pre-computed on the server so SSR + first paint agree. */
  eyebrow: string
  status?: string
  /** Right-aligned action area (e.g. Add lead button). */
  rightSlot?: React.ReactNode
}) {
  const allLive = liveChannelCount === totalChannels
  const channelLine = allLive
    ? `All ${totalChannels} channels live`
    : `${liveChannelCount} of ${totalChannels} channels live`

  return (
    <section className="flex flex-wrap items-end justify-between gap-4">
      <PageStagger className="min-w-0">
        <StaggerItem>
          <h1 className="font-display text-2xl tracking-tight text-foreground">
            {eyebrow}
          </h1>
        </StaggerItem>
        <StaggerItem>
          <p className="mt-1 text-sm text-muted-foreground">{shopName}</p>
        </StaggerItem>
        <StaggerItem>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-2">
              <PulseDot tone={allLive ? "good" : "accent"} size={8} />
              <span className="text-foreground">{channelLine}</span>
            </span>
            {status ? <span>{status}</span> : null}
          </div>
        </StaggerItem>
      </PageStagger>
      {rightSlot ? (
        <div className="flex shrink-0 items-center gap-2">{rightSlot}</div>
      ) : null}
    </section>
  )
}
