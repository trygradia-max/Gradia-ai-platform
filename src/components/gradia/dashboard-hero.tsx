"use client"

import * as React from "react"

import { MeshBackground } from "@/components/gradia/mesh-background"
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
  rightSlot,
}: {
  shopName: string
  liveChannelCount: number
  totalChannels: number
  /** Pre-computed on the server so SSR + first paint agree. */
  eyebrow: string
  /** Right-aligned action area (e.g. Add lead button). */
  rightSlot?: React.ReactNode
}) {
  const allLive = liveChannelCount === totalChannels
  const channelLine = allLive
    ? `All ${totalChannels} channels live`
    : `${liveChannelCount} of ${totalChannels} channels live`

  return (
    <section className="relative isolate overflow-hidden rounded-3xl border border-border/40 bg-card/40 px-6 py-10 sm:px-10 sm:py-14">
      <MeshBackground />
      <PageStagger className="relative flex flex-col gap-6 sm:gap-8">
        <StaggerItem>
          <p className="label-eyebrow text-muted-foreground/80">
            {eyebrow}
          </p>
        </StaggerItem>

        <StaggerItem>
          <h1 className="font-display text-[clamp(2.5rem,7vw,4.5rem)] leading-[1] tracking-[-0.03em] text-foreground">
            <span className="italic">Today,</span>{" "}
            <span className="text-muted-foreground/90">together at</span>{" "}
            <span className="block sm:inline">{shopName}.</span>
          </h1>
        </StaggerItem>

        <StaggerItem>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="flex items-center gap-2.5">
              <PulseDot
                tone={allLive ? "good" : "accent"}
                size={8}
              />
              <p className="text-sm text-muted-foreground">
                <span className="text-foreground">{channelLine}</span>
                <span className="hidden text-muted-foreground/60 sm:inline">
                  {" "}— agents watching every inbox.
                </span>
              </p>
            </div>
            {rightSlot ? (
              <div className="flex shrink-0 items-center gap-2">
                {rightSlot}
              </div>
            ) : null}
          </div>
        </StaggerItem>
      </PageStagger>
    </section>
  )
}
