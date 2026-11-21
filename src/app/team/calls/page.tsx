import Link from "next/link"

import { CallReviewList } from "@/components/gradia/call-review/call-list"
import { EmptyState } from "@/components/gradia/empty-state"
import { ErrorState } from "@/components/gradia/error-state"
import { SectionHeader } from "@/components/gradia/section-header"
import { TeamChrome } from "@/components/gradia/team-chrome"
import { readCallReviewList } from "@/lib/call-copilot/review-read"
import { formatCallCursor, parseCallCursor } from "@/lib/call-review/cursor"
import { pickReviewWorkspace } from "@/lib/call-review/workspace"
import { requireUser } from "@/lib/shop"
import { STRINGS } from "@/lib/strings"
import { createClient } from "@/lib/supabase/server"
import type { TeamWorkspace } from "@/lib/team-permissions"

export const dynamic = "force-dynamic"
const link = "inline-flex min-h-11 items-center text-sm text-accent-text underline-offset-4 hover:underline"

/** Read-only call review for a manager with customer access. Approving stays with the shop owner. */
export default async function TeamCallReviewListPage({ searchParams }: { searchParams: Promise<{ shop?: string; before?: string | string[] }> }) {
  await requireUser()
  const db = await createClient()
  const params = await searchParams
  const workspaces = await db.rpc("team_workspaces")
  if (workspaces.error) throw new Error("Workspace access could not be verified.")
  const workspace = pickReviewWorkspace((workspaces.data ?? []) as TeamWorkspace[], params.shop)
  const s = STRINGS.pages.callReview
  if (!workspace) {
    return (
      <TeamChrome className="space-y-4">
        <SectionHeader level={1} eyebrow={s.eyebrow} title={s.listTitle} subhead={s.forbiddenBody} />
        <Link href="/team" className={link}>Back to your workspaces</Link>
      </TeamChrome>
    )
  }
  const before = parseCallCursor(params.before)
  const result = await readCallReviewList(db, { shopId: workspace.id, limit: 20, before })
  const base = `/team/calls?shop=${workspace.id}`
  return (
    <TeamChrome className="space-y-6">
      <Link href={`/team?shop=${workspace.id}`} className={link}>Your workspaces</Link>
      <SectionHeader level={1} eyebrow={s.eyebrow} title={`${workspace.name} · ${s.listTitle}`} subhead={`${s.listSubhead} ${s.readOnlyNotice}`} />
      {result.status === "ok" ? (
        <CallReviewList
          list={result.value}
          isFirstPage={before === null}
          baseHref={base}
          hrefFor={(id) => `/team/calls/${id}?shop=${workspace.id}`}
          nextHref={result.value.next_cursor ? `${base}&before=${encodeURIComponent(formatCallCursor({ createdAt: result.value.next_cursor.created_at, id: result.value.next_cursor.id }))}` : null}
        />
      ) : result.status === "forbidden" || result.status === "not_found" ? (
        <EmptyState title={s.forbiddenTitle} description={s.forbiddenBody} />
      ) : (
        <ErrorState compact title={s.listErrorTitle} />
      )}
    </TeamChrome>
  )
}
