import { Shield } from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Shop profile and integrations, always filtered by ownership in RLS.
        </p>
      </div>
      <Card className="border-border/80">
        <CardHeader className="flex flex-row items-center gap-3 space-y-0">
          <div className="flex size-10 items-center justify-center rounded-lg bg-muted/60">
            <Shield className="size-5 text-primary" aria-hidden />
          </div>
          <div>
            <CardTitle className="text-base font-medium">
              Security posture
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Never pass <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">shop_id</code> from the client without re-validating on
              the server.
            </p>
          </div>
        </CardHeader>
        <CardContent>
          <ul className="list-inside list-disc space-y-2 text-sm text-muted-foreground">
            <li>
              Row-level policies scope reads and writes to shops you own.
            </li>
            <li>
              Server actions call <span className="font-medium text-foreground">requireShop()</span> so inserts cannot target another tenant.
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}
