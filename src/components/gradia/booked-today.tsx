import Link from "next/link"
import { ArrowRight, CalendarCheck2, CalendarClock } from "lucide-react"

import { StatusPill } from "@/components/ui/status-pill"
import { listTodaysAppointments } from "@/lib/data/appointments"
import { STRINGS } from "@/lib/strings"

function timeLabel(iso: string, timezone: string | null): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone ?? undefined,
    })
  } catch {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    })
  }
}

/**
 * The Booked module — schedule's home on Home (founder-approved
 * placement): today's appointments at a glance; /schedule stays the
 * full-list page, reachable from here and ⌘K, never the sidebar.
 */
export async function BookedToday() {
  const appts = await listTodaysAppointments()
  const s = STRINGS.pages.home

  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div className="space-y-1">
          <p className="label-eyebrow text-muted-foreground/70">
            {s.bookedEyebrow}
          </p>
          <h2 className="font-display text-xl text-foreground">
            {s.bookedTitle}
          </h2>
        </div>
        <Link
          href="/schedule"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-accent-text hover:underline"
        >
          {s.bookedViewAll}
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </div>

      {appts.length === 0 ? (
        <div className="rounded-md border border-border/60 bg-card/40 px-5 py-5">
          <p className="text-sm text-muted-foreground">{s.bookedEmpty}</p>
        </div>
      ) : (
        <ul className="divide-y divide-border/60 rounded-md border border-border/60 bg-card">
          {appts.map((a) => (
            <li key={a.id} className="flex items-center gap-3.5 px-4 py-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-sm bg-muted/60 text-muted-foreground">
                {a.confirmed ? (
                  <CalendarCheck2 className="size-4" aria-hidden />
                ) : (
                  <CalendarClock className="size-4" aria-hidden />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">
                  {a.customerName ?? "Customer"}
                  <span className="ml-2 font-normal text-muted-foreground">
                    {a.serviceName ?? ""}
                  </span>
                </p>
                <p className="font-data text-xs text-muted-foreground">
                  {timeLabel(a.scheduledAt, a.timezone)}
                  {a.durationMinutes ? ` · ${a.durationMinutes} min` : ""}
                </p>
              </div>
              <StatusPill tone={a.confirmed ? "good" : "muted"}>
                {a.confirmed ? "Confirmed" : "Booked"}
              </StatusPill>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
