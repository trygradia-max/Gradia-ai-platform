import { CalendarWeekView } from "@/components/gradia/calendar-week"
import { SectionHeader } from "@/components/gradia/section-header"
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
      <SectionHeader
        level={1}
        eyebrow="Calendar"
        title="This week"
        subhead="Every appointment as a block. Moving one still waits for your approval before the customer is told."
      />

      <CalendarWeekView initial={week} />
    </div>
  )
}
