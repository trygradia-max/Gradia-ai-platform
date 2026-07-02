import Link from "next/link"
import { ArrowRight, CalendarRange, Plug } from "lucide-react"

import {
  ScheduleGroups,
  type ScheduleGroup,
} from "@/components/gradia/schedule-groups"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  getAccessTokenForShop as getAurinkoAccessTokenForShop,
  listCalendarEvents,
  type AurinkoCalendarEvent,
} from "@/lib/aurinko"
import { requireShop } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import type { ShopRow } from "@/lib/types/database"

export const dynamic = "force-dynamic"

const LOOK_AHEAD_DAYS = 14

function startOfDay(d: Date): Date {
  const out = new Date(d)
  out.setHours(0, 0, 0, 0)
  return out
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function groupByDay(events: AurinkoCalendarEvent[]): ScheduleGroup[] {
  const buckets = new Map<string, AurinkoCalendarEvent[]>()
  for (const evt of events) {
    if (!evt.start) continue
    const dayKey = startOfDay(new Date(evt.start)).toISOString()
    const list = buckets.get(dayKey) ?? []
    list.push(evt)
    buckets.set(dayKey, list)
  }
  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, list]) => ({
      day,
      events: list
        .sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""))
        .map((evt) => ({
          id: evt.id,
          subject: evt.subject ?? null,
          start: evt.start ?? null,
          end: evt.end ?? null,
          location: evt.location ?? null,
        })),
    }))
}

export default async function SchedulePage() {
  const shopCtx = await requireShop()
  const supabase = await createClient()

  const { data } = await supabase
    .from("shops")
    .select("*")
    .eq("id", shopCtx.id)
    .single()
  const shop = (data as ShopRow | null) ?? null

  let accessToken: string | null = null
  if (shop) {
    try {
      accessToken = await getAurinkoAccessTokenForShop(supabase, shop)
    } catch (err) {
      console.warn("[schedule] Aurinko token refresh failed:", err)
    }
  }

  if (!accessToken) {
    return (
      <ScheduleShell todayCount={0} upcomingCount={0} variant="not-connected">
        <NotConnectedCard />
      </ScheduleShell>
    )
  }

  const now = new Date()
  const timeMin = startOfDay(now).toISOString()
  const timeMax = new Date(
    startOfDay(now).getTime() + LOOK_AHEAD_DAYS * 24 * 60 * 60 * 1000
  ).toISOString()

  let events: AurinkoCalendarEvent[] = []
  let fetchError: string | null = null
  try {
    events = await listCalendarEvents(accessToken, "primary", {
      timeMin,
      timeMax,
    })
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err)
  }

  if (fetchError) {
    return (
      <ScheduleShell todayCount={0} upcomingCount={0} variant="error">
        <ErrorCard error={fetchError} />
      </ScheduleShell>
    )
  }

  if (events.length === 0) {
    return (
      <ScheduleShell todayCount={0} upcomingCount={0} variant="empty">
        <EmptyCard />
      </ScheduleShell>
    )
  }

  const groups = groupByDay(events)
  const todayCount = groups
    .filter((g) => isSameDay(new Date(g.day), now))
    .reduce((acc, g) => acc + g.events.length, 0)
  const upcomingCount = groups.reduce((acc, g) => acc + g.events.length, 0)

  return (
    <ScheduleShell
      todayCount={todayCount}
      upcomingCount={upcomingCount}
      variant="connected"
    >
      <ScheduleGroups groups={groups} />
    </ScheduleShell>
  )
}

function ScheduleShell({
  children,
  todayCount,
  upcomingCount,
  variant,
}: {
  children: React.ReactNode
  todayCount: number
  upcomingCount: number
  variant: "connected" | "not-connected" | "error" | "empty"
}) {
  const subtitle =
    variant === "not-connected"
      ? "Hook up Google Calendar once and approved bookings land here automatically — by day, by time, by truck."
      : variant === "error"
        ? "We couldn't pull the calendar just now — try reconnecting in Settings."
        : variant === "empty"
          ? "Nothing on the books in the next two weeks. New bookings land here once we approve them."
          : todayCount > 0
            ? `${todayCount} ${todayCount === 1 ? "job" : "jobs"} today · ${upcomingCount} across the next two weeks.`
            : `${upcomingCount} on the books across the next two weeks — nothing today yet.`

  return (
    <div className="mx-auto max-w-4xl space-y-10">
      <header className="space-y-2">
        <p className="label-eyebrow text-muted-foreground/70">Schedule</p>
        <h1 className="font-display text-2xl text-foreground">
          What&apos;s <span className="italic">on the books</span>.
        </h1>
        <p className="max-w-prose text-sm text-muted-foreground">{subtitle}</p>
      </header>

      {children}
    </div>
  )
}

function NotConnectedCard() {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-card p-6 sm:p-8">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
        <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary ring-1 ring-primary/25">
          <Plug className="size-5" aria-hidden />
        </div>
        <div className="flex-1 space-y-3">
          <div className="space-y-1">
            <p className="label-eyebrow text-muted-foreground/70">
              One quick wire-up
            </p>
            <h2 className="font-display text-xl text-foreground sm:text-2xl">
              Plug in our <span className="italic">calendar</span>{" "}first.
            </h2>
            <p className="max-w-prose text-sm text-muted-foreground">
              Connect Google Calendar through Settings and the AI starts
              landing approved bookings here, by day and by time.
            </p>
          </div>
          <Link
            href="/settings#email"
            className={cn(
              buttonVariants({ size: "lg" }),
              "h-11 gap-2 sm:w-fit"
            )}
          >
            Connect the calendar
            <ArrowRight className="size-4" aria-hidden />
          </Link>
        </div>
      </div>
    </div>
  )
}

function ErrorCard({ error }: { error: string }) {
  return (
    <div className="rounded-2xl border border-border/60 bg-card p-6 sm:p-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-amber-500/12 text-amber-500 ring-1 ring-amber-500/25 dark:text-amber-400">
          <CalendarRange className="size-5" aria-hidden />
        </div>
        <div className="flex-1 space-y-3">
          <div className="space-y-1">
            <p className="label-eyebrow text-muted-foreground/70">
              Calendar hiccup
            </p>
            <h2 className="font-display text-xl text-foreground sm:text-2xl">
              Couldn&apos;t reach the calendar.
            </h2>
            <p className="max-w-prose text-sm text-muted-foreground">
              Try disconnecting and reconnecting in Settings. The provider
              said:{" "}
              <span className="font-mono text-xs text-foreground/80">
                {error}
              </span>
            </p>
          </div>
          <Link
            href="/settings#email"
            className={cn(
              buttonVariants({ variant: "outline", size: "lg" }),
              "h-11 sm:w-fit"
            )}
          >
            Open Settings
          </Link>
        </div>
      </div>
    </div>
  )
}

function EmptyCard() {
  return (
    <div className="rounded-2xl border border-border/60 bg-card px-6 py-16 text-center sm:py-20">
      <p className="font-display text-2xl text-foreground">
        <span className="italic">Quiet</span>{" "}for the next two weeks.
      </p>
      <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
        New bookings land here the moment we approve them — voice, email,
        SMS, or DMs.
      </p>
    </div>
  )
}
