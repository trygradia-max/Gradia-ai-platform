import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft } from "lucide-react"
import { z } from "zod"

import { CallReviewDetailView } from "@/components/gradia/call-review/detail-view"
import { RefreshButton } from "@/components/gradia/call-review/refresh-button"
import { EmptyState } from "@/components/gradia/empty-state"
import { ErrorState } from "@/components/gradia/error-state"
import { readCallReviewDetail } from "@/lib/call-copilot/review-read"
import { requireShop } from "@/lib/shop"
import { STRINGS } from "@/lib/strings"
import { createClient } from "@/lib/supabase/server"

export const dynamic = "force-dynamic"

const back = "inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground"

/**
 * The post-call review for one call. Read-only here: the page reads through the review function and renders the
 * result. Approval goes through server actions that re-read, re-check and call the existing approval path.
 */
export default async function CallReviewPage({ params }: { params: Promise<{ callId: string }> }) {
  const { callId } = await params
  if (!z.string().uuid().safeParse(callId).success) notFound()
  const shop = await requireShop()
  const s = STRINGS.pages.callReview
  const result = await readCallReviewDetail(await createClient(), { shopId: shop.id, callId })
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Link href="/calls/copilot" className={back}>
        <ArrowLeft className="size-3.5" aria-hidden />
        {s.backToList}
      </Link>
      {result.status === "ok" ? (
        <CallReviewDetailView detail={result.value} checkedAt={new Date().toISOString()} />
      ) : result.status === "not_found" || result.status === "forbidden" ? (
        <EmptyState title={s.notFoundTitle} description={s.notFoundBody} />
      ) : (
        <ErrorState compact title={s.detailErrorTitle} description={s.detailErrorBody} action={<RefreshButton />} />
      )}
    </div>
  )
}
