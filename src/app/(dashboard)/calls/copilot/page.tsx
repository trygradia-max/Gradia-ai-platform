import { CallReviewList } from "@/components/gradia/call-review/call-list"
import { EmptyState } from "@/components/gradia/empty-state"
import { ErrorState } from "@/components/gradia/error-state"
import { SectionHeader } from "@/components/gradia/section-header"
import { readCallReviewList } from "@/lib/call-copilot/review-read"
import { formatCallCursor, parseCallCursor } from "@/lib/call-review/cursor"
import { requireShop } from "@/lib/shop"
import { STRINGS } from "@/lib/strings"
import { createClient } from "@/lib/supabase/server"

export const dynamic = "force-dynamic"

/**
 * Calls Gradia listened to with both people's consent, newest first. Everything shown comes from the read-only review
 * function (authority derived in the database from this session); no table is read here and no action is taken.
 */
export default async function CallReviewListPage({ searchParams }: { searchParams: Promise<{ before?: string | string[] }> }) {
  const shop = await requireShop()
  const before = parseCallCursor((await searchParams).before)
  const s = STRINGS.pages.callReview
  const result = await readCallReviewList(await createClient(), { shopId: shop.id, limit: 20, before })
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <SectionHeader level={1} eyebrow={s.eyebrow} title={s.listTitle} subhead={s.listSubhead} />
      {result.status === "ok" ? (
        <CallReviewList
          list={result.value}
          isFirstPage={before === null}
          baseHref="/calls/copilot"
          hrefFor={(id) => `/calls/copilot/${id}`}
          nextHref={result.value.next_cursor ? `/calls/copilot?before=${encodeURIComponent(formatCallCursor({ createdAt: result.value.next_cursor.created_at, id: result.value.next_cursor.id }))}` : null}
        />
      ) : result.status === "forbidden" || result.status === "not_found" ? (
        <EmptyState title={s.forbiddenTitle} description={s.forbiddenBody} />
      ) : (
        <ErrorState compact title={s.listErrorTitle} />
      )}
    </div>
  )
}
