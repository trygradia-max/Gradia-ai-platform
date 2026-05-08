import { CalendarRange } from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export default function SchedulePage() {
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Schedule</h1>
        <p className="text-sm text-muted-foreground">
          Appointments reference your leads and respect{" "}
          <span className="font-medium text-foreground">shop_id</span> at the
          database layer.
        </p>
      </div>
      <Card className="border-border/80">
        <CardHeader className="flex flex-row items-center gap-3 space-y-0">
          <div className="flex size-10 items-center justify-center rounded-lg bg-muted/60">
            <CalendarRange className="size-5 text-primary" aria-hidden />
          </div>
          <div>
            <CardTitle className="text-base font-medium">
              Routing board
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Wire calendar and AI handoffs here — schema is ready in{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                appointments
              </code>
              .
            </p>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Booking UI lands next: fetch rows with{" "}
            <span className="font-medium text-foreground">
              eq(&quot;shop_id&quot;, currentShopId)
            </span>{" "}
            only.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
