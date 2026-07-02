import { listScoredLeadsForCurrentShop } from "@/lib/data/leads"
import { AddLeadDialog } from "@/components/gradia/add-lead-dialog"
import { LiveLeadFeed } from "@/components/gradia/live-lead-feed"

export default async function LeadsPage() {
  const leads = await listScoredLeadsForCurrentShop()
  const newCount = leads.filter((l) => l.status === "new").length
  const bookedCount = leads.filter((l) => l.status === "booked").length

  return (
    <div className="mx-auto max-w-6xl space-y-10">
      <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <p className="label-eyebrow text-muted-foreground/70">Leads</p>
          <h1 className="font-display text-2xl text-foreground">
            Everyone we&apos;re <span className="italic">working</span>.
          </h1>
          <p className="max-w-prose text-sm text-muted-foreground">
            {leads.length === 0
              ? "Nothing in the pipeline yet — when a lead lands, we'll line it up here."
              : `${leads.length} in play${
                  newCount > 0 ? ` · ${newCount} fresh` : ""
                }${bookedCount > 0 ? ` · ${bookedCount} on the books` : ""}.`}
          </p>
        </div>
        <div className="shrink-0">
          <AddLeadDialog />
        </div>
      </header>

      <LiveLeadFeed leads={leads} />
    </div>
  )
}
