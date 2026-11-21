import Link from "next/link"
import { notFound } from "next/navigation"
import { z } from "zod"

import { CallReviewDetailView } from "@/components/gradia/call-review/detail-view"
import { RefreshButton } from "@/components/gradia/call-review/refresh-button"
import { EmptyState } from "@/components/gradia/empty-state"
import { ErrorState } from "@/components/gradia/error-state"
import { TeamChrome } from "@/components/gradia/team-chrome"
import { readCallReviewDetail } from "@/lib/call-copilot/review-read"
import { pickReviewWorkspace } from "@/lib/call-review/workspace"
import { requireUser } from "@/lib/shop"
import { STRINGS } from "@/lib/strings"
import { createClient } from "@/lib/supabase/server"
import type { TeamWorkspace } from "@/lib/team-permissions"

export const dynamic = "force-dynamic"
const link = "inline-flex min-h-11 items-center text-sm text-accent-text underline-offset-4 hover:underline"

/** Read-only review of one call for a manager. The viewer's role comes back from the database, so no approve control renders. */
export default async function TeamCallReviewPage({ params, searchParams }: { params: Promise<{ callId: string }>; searchParams: Promise<{ shop?: string }> }) {
  const { callId } = await params
  if (!z.string().uuid().safeParse(callId).success) notFound()
  await requireUser()
  const db = await createClient()
  const workspaces = await db.rpc("team_workspaces")
  if (workspaces.error) throw new Error("Workspace access could not be verified.")
  const workspace = pickReviewWorkspace((workspaces.data ?? []) as TeamWorkspace[], (await searchParams).shop)
  const s = STRINGS.pages.callReview
  if (!workspace) {
    return (
      <TeamChrome className="space-y-4">
        <EmptyState title={s.forbiddenTitle} description={s.forbiddenBody} />
        <Link href="/team" className={link}>Back to your workspaces</Link>
      </TeamChrome>
    )
  }
  const result = await readCallReviewDetail(db, { shopId: workspace.id, callId })
  return (
    <TeamChrome className="space-y-6 max-w-4xl">
      <Link href={`/team/calls?shop=${workspace.id}`} className={link}>{s.backToList}</Link>
      {result.status === "ok" ? (
        <CallReviewDetailView detail={result.value} checkedAt={new Date().toISOString()} />
      ) : result.status === "not_found" || result.status === "forbidden" ? (
        <EmptyState title={s.notFoundTitle} description={s.notFoundBody} />
      ) : (
        <ErrorState compact title={s.detailErrorTitle} description={s.detailErrorBody} action={<RefreshButton />} />
      )}
    </TeamChrome>
  )
}
