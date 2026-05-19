import { listLeadsForCurrentShop } from "@/lib/data/leads"
import { AiLeadSection } from "@/components/gradia/ai-lead-section"
import { AddLeadDialog } from "@/components/gradia/add-lead-dialog"
import { LiveLeadFeed } from "@/components/gradia/live-lead-feed"
import { RevenueTiles } from "@/components/gradia/revenue-tiles"
import { WhisperButton } from "@/components/gradia/whisper-button"

export default async function DashboardPage() {
  const leads = await listLeadsForCurrentShop()

  return (
    <div className="mx-auto max-w-6xl space-y-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            Today, together
          </h1>
          <p className="text-sm text-muted-foreground">
            What we&apos;ve caught, what&apos;s waiting on us, and what to tackle next.
          </p>
        </div>
        <AddLeadDialog />
      </div>
      <RevenueTiles />
      <WhisperButton />
      <AiLeadSection />
      <LiveLeadFeed leads={leads} />
    </div>
  )
}
