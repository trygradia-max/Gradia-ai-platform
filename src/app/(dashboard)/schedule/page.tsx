import { CalendarRange, Plug } from "lucide-react"

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
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

function formatDayHeader(iso: string): string {
  const d = new Date(iso)
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(d)
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(d)
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function groupByDay(events: AurinkoCalendarEvent[]): {
  day: string
  events: AurinkoCalendarEvent[]
}[] {
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
      events: list.sort((a, b) =>
        (a.start ?? "").localeCompare(b.start ?? "")
      ),
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

  const notConnected = !shop?.aurinko_access_token

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Our schedule</h1>
        <p className="text-sm text-muted-foreground">
          Today&apos;s jobs, day by day — from the truck or the office.
        </p>
      </div>

      {notConnected ? (
        <NotConnectedCard />
      ) : (
        <ConnectedSchedule
          accessToken={shop!.aurinko_access_token!}
          calendarId="primary"
        />
      )}
    </div>
  )
}

function NotConnectedCard() {
  return (
    <Card className="border-border/80">
      <CardHeader className="flex flex-row items-center gap-3 space-y-0">
        <div className="flex size-10 items-center justify-center rounded-lg bg-muted/60">
          <Plug className="size-5 text-primary" aria-hidden />
        </div>
        <div>
          <CardTitle className="text-base font-medium">
            Connect our calendar first
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Hook up Google Calendar in{" "}
            <a className="underline" href="/settings">
              Settings
            </a>{" "}
            and approved bookings will land here automatically.
          </p>
        </div>
      </CardHeader>
    </Card>
  )
}

async function ConnectedSchedule({
  accessToken,
  calendarId,
}: {
  accessToken: string
  calendarId: string
}) {
  const now = new Date()
  const timeMin = startOfDay(now).toISOString()
  const timeMax = new Date(
    startOfDay(now).getTime() + LOOK_AHEAD_DAYS * 24 * 60 * 60 * 1000
  ).toISOString()

  let events: AurinkoCalendarEvent[] = []
  let fetchError: string | null = null
  try {
    events = await listCalendarEvents(accessToken, calendarId, {
      timeMin,
      timeMax,
    })
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err)
  }

  if (fetchError) {
    return (
      <Card className="border-border/80">
        <CardHeader className="flex flex-row items-center gap-3 space-y-0">
          <div className="flex size-10 items-center justify-center rounded-lg bg-muted/60">
            <CalendarRange className="size-5 text-primary" aria-hidden />
          </div>
          <div>
            <CardTitle className="text-base font-medium">
              Couldn&apos;t reach our calendar
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Try disconnecting and reconnecting in Settings. The provider
              said: <span className="font-mono text-xs">{fetchError}</span>
            </p>
          </div>
        </CardHeader>
      </Card>
    )
  }

  if (events.length === 0) {
    return (
      <Card className="border-border/80">
        <CardContent className="py-14 text-center text-sm text-muted-foreground">
          Nothing on the books in the next two weeks. New bookings land here
          once we approve them.
        </CardContent>
      </Card>
    )
  }

  const today = new Date()
  const groups = groupByDay(events)

  return (
    <div className="grid gap-4">
      {groups.map(({ day, events: dayEvents }) => {
        const dayDate = new Date(day)
        const tagToday = isSameDay(dayDate, today)
        return (
          <Card key={day} className="border-border/80">
            <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 pb-3">
              <CardTitle className="text-base font-medium">
                {formatDayHeader(day)}
              </CardTitle>
              {tagToday ? (
                <span className="rounded-full bg-primary/15 px-2.5 py-1 text-xs font-medium text-primary">
                  Today
                </span>
              ) : null}
            </CardHeader>
            <CardContent className="space-y-3">
              <ul className="grid gap-2">
                {dayEvents.map((evt) => (
                  <li
                    key={evt.id}
                    className="flex flex-wrap items-start gap-3 rounded-md border border-border/60 bg-muted/20 px-3 py-2"
                  >
                    <div className="min-w-[6.5rem] text-sm tabular-nums">
                      {evt.start ? formatTime(evt.start) : "—"}
                      {evt.end ? (
                        <span className="text-muted-foreground">
                          {" "}
                          – {formatTime(evt.end)}
                        </span>
                      ) : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {evt.subject?.trim() || "Untitled event"}
                      </p>
                      {evt.location ? (
                        <p className="truncate text-xs text-muted-foreground">
                          {evt.location}
                        </p>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
