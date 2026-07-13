import { redirect } from "next/navigation"

import { RecoveryFlow } from "@/components/gradia/recovery-flow"
import { FEATURES } from "@/lib/features"
import { loadJobCandidates } from "@/lib/recovery/review"
import { requireShop } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"

export const dynamic = "force-dynamic"

/**
 * Customer Recovery — the dropzone + review queue (NEXT-3). Gated behind
 * FEATURES.customerRecovery (redirects home while off). With ?job=<id> it
 * resumes a finished import straight at the review step.
 */
export default async function RecoveryPage({
  searchParams,
}: {
  searchParams: Promise<{ job?: string }>
}) {
  if (!FEATURES.customerRecovery) redirect("/dashboard")
  const shop = await requireShop()
  const params = await searchParams
  const jobId = params.job?.trim() || null

  let initialCandidates = undefined
  if (jobId) {
    const supabase = await createClient()
    const loaded = await loadJobCandidates(supabase, shop.id, jobId)
    if (loaded && loaded.status === "ready") {
      initialCandidates = loaded.candidates
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      <RecoveryFlow
        initialJobId={jobId ?? undefined}
        initialCandidates={initialCandidates}
      />
    </div>
  )
}
