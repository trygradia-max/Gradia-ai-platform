import { listLeadsForCurrentShop } from "@/lib/data/leads"
import { AiLeadSection } from "@/components/gradia/ai-lead-section"
import { AddLeadDialog } from "@/components/gradia/add-lead-dialog"
import { LiveLeadFeed } from "@/components/gradia/live-lead-feed"

export default async function DashboardPage() {
  const leads = await listLeadsForCurrentShop()

  return (
    <div className="mx-auto max-w-6xl space-y-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Where we stand today.
          </p>
        </div>
        <AddLeadDialog />
      </div>
      <AiLeadSection />
      <LiveLeadFeed leads={leads} />
    </div>
  )
}
