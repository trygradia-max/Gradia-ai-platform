import { Shield } from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Shop, integrations, and account.
        </p>
      </div>
      <Card className="border-border/80">
        <CardHeader className="flex flex-row items-center gap-3 space-y-0">
          <div className="flex size-10 items-center justify-center rounded-lg bg-muted/60">
            <Shield className="size-5 text-primary" aria-hidden />
          </div>
          <div>
            <CardTitle className="text-base font-medium">
              More coming soon
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Service menu, integrations, team, and billing live here next.
            </p>
          </div>
        </CardHeader>
        <CardContent>
          <ul className="list-inside list-disc space-y-2 text-sm text-muted-foreground">
            <li>Edit our service menu — prices, durations, descriptions.</li>
            <li>Connect Slack, voice, email, and payments in one place.</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}
