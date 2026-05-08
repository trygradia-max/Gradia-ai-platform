import { CalendarRange } from "lucide-react"

import { Card, CardHeader, CardTitle } from "@/components/ui/card"

export default function SchedulePage() {
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Schedule</h1>
        <p className="text-sm text-muted-foreground">
          Our jobs, day by day.
        </p>
      </div>
      <Card className="border-border/80">
        <CardHeader className="flex flex-row items-center gap-3 space-y-0">
          <div className="flex size-10 items-center justify-center rounded-lg bg-muted/60">
            <CalendarRange className="size-5 text-primary" aria-hidden />
          </div>
          <div>
            <CardTitle className="text-base font-medium">
              Calendar coming soon
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Today&apos;s bookings will live here — tap to confirm or reschedule from the road.
            </p>
          </div>
        </CardHeader>
      </Card>
    </div>
  )
}
