"use client"

import * as React from "react"
import { motion, useReducedMotion, type Variants } from "framer-motion"
import { Clock, MapPin } from "lucide-react"

import { MotionCard } from "@/components/gradia/motion/motion-card"
import {
  PageStagger,
  StaggerItem,
} from "@/components/gradia/motion/page-stagger"
import { PulseDot } from "@/components/gradia/motion/pulse-dot"
import { cn } from "@/lib/utils"

export type ScheduleEvent = {
  id: string
  subject: string | null
  start: string | null
  end: string | null
  location: string | null
}

export type ScheduleGroup = {
  /** ISO of midnight on that day. */
  day: string
  events: ScheduleEvent[]
}

const TIME = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
})

const WEEKDAY_LONG = new Intl.DateTimeFormat(undefined, { weekday: "long" })
const MONTH_DAY = new Intl.DateTimeFormat(undefined, {
  month: "long",
  day: "numeric",
})

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function startOfDay(d: Date): Date {
  const out = new Date(d)
  out.setHours(0, 0, 0, 0)
  return out
}

function describeDay(day: Date, now: Date): string {
  const today = startOfDay(now)
  const target = startOfDay(day)
  const oneDay = 24 * 60 * 60 * 1000
  const diffDays = Math.round((target.getTime() - today.getTime()) / oneDay)

  if (diffDays === 0) return "Today"
  if (diffDays === 1) return "Tomorrow"
  if (diffDays > 1 && diffDays < 7) return WEEKDAY_LONG.format(day)
  return WEEKDAY_LONG.format(day)
}

const rowContainer: Variants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.04, delayChildren: 0.05 },
  },
}

const rowItem: Variants = {
  hidden: { opacity: 0, y: 10 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.15, ease: "easeOut" },
  },
}

export function ScheduleGroups({ groups }: { groups: ScheduleGroup[] }) {
  const reduce = useReducedMotion()
  const now = React.useMemo(() => new Date(), [])

  return (
    <PageStagger className="space-y-6">
      {groups.map((group) => {
        const dayDate = new Date(group.day)
        const isToday = isSameDay(dayDate, now)
        const isTomorrow = isSameDay(
          dayDate,
          new Date(now.getTime() + 24 * 60 * 60 * 1000)
        )
        const eyebrow = describeDay(dayDate, now)

        return (
          <StaggerItem key={group.day}>
            <section className="space-y-3">
              <header className="flex items-end justify-between gap-3">
                <div className="space-y-1">
                  <p
                    className={cn(
                      "label-eyebrow flex items-center gap-2",
                      isToday
                        ? "text-primary"
                        : "text-muted-foreground/70"
                    )}
                  >
                    {isToday ? <PulseDot tone="accent" size={6} /> : null}
                    {eyebrow}
                  </p>
                  <h2 className="font-display text-xl tracking-tight text-foreground sm:text-2xl">
                    {MONTH_DAY.format(dayDate)}
                  </h2>
                </div>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {group.events.length}{" "}
                  {group.events.length === 1 ? "job" : "jobs"}
                </p>
              </header>

              <MotionCard
                interactive={false}

                className={cn(
                  "overflow-hidden p-0",
                  isToday && "border-primary/30"
                )}
              >
                <motion.ul
                  variants={reduce ? undefined : rowContainer}
                  initial={reduce ? undefined : "hidden"}
                  whileInView={reduce ? undefined : "show"}
                  viewport={{ once: true, amount: 0.2 }}
                  className="divide-y divide-border/40"
                >
                  {group.events.map((evt) => (
                    <motion.li
                      key={evt.id}
                      variants={reduce ? undefined : rowItem}
                      className="group/event flex flex-col gap-1.5 px-4 py-3.5 transition-colors duration-200 hover:bg-muted/20 sm:flex-row sm:items-start sm:gap-4 sm:px-5"
                    >
                      <div className="flex shrink-0 items-center gap-2 text-sm tabular-nums">
                        <Clock
                          className="size-3.5 text-muted-foreground/70"
                          aria-hidden
                        />
                        <span className="font-medium text-foreground">
                          {evt.start ? TIME.format(new Date(evt.start)) : "—"}
                        </span>
                        {evt.end ? (
                          <span className="text-muted-foreground">
                            – {TIME.format(new Date(evt.end))}
                          </span>
                        ) : null}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">
                          {evt.subject?.trim() || "Untitled job"}
                        </p>
                        {evt.location ? (
                          <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
                            <MapPin
                              className="size-3 shrink-0"
                              aria-hidden
                            />
                            <span className="truncate">{evt.location}</span>
                          </p>
                        ) : null}
                      </div>
                    </motion.li>
                  ))}
                </motion.ul>
              </MotionCard>
              {isTomorrow ? null : null}
            </section>
          </StaggerItem>
        )
      })}
    </PageStagger>
  )
}
