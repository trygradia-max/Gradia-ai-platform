import { listLeadsForCurrentShop } from "@/lib/data/leads"
import { AddLeadDialog } from "@/components/gradia/add-lead-dialog"
import { LiveLeadFeed } from "@/components/gradia/live-lead-feed"

export default async function LeadsPage() {
  const leads = await listLeadsForCurrentShop()

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Our leads</h1>
          <p className="text-sm text-muted-foreground">
            Everyone we&apos;re working — newest first.
          </p>
        </div>
        <AddLeadDialog />
      </div>
      <LiveLeadFeed leads={leads} />
    </div>
  )
}
