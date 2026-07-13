import { CalendarWeekView } from "@/components/gradia/calendar-week"
import { loadCalendarWeek } from "@/lib/data/calendar"

export const dynamic = "force-dynamic"

/**
 * Calendar (CRM C4b) — the 5th nav destination per the approved IA. Week
 * grid on desktop, drive-order day list on mobile: a solo mobile detailer's
 * whole day, phone-only.
 */
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>
}) {
  const params = await searchParams
  const week = await loadCalendarWeek(params.week)

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <header className="space-y-2">
        <p className="label-eyebrow text-muted-foreground/70">Calendar</p>
        <h1 className="font-display text-2xl text-foreground">
          The week, at a <span className="italic">glance</span>.
        </h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Every job as a block — tap for the card, drag to move it. Customers
          get a heads-up only after you approve it.
        </p>
      </header>

      <CalendarWeekView initial={week} />
    </div>
  )
}
