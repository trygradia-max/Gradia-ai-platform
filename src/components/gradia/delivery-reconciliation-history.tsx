import type { SupabaseClient } from '@supabase/supabase-js'
import { deliveryOutcomes, reconciliationHistorySchema, reviewerLabels } from '@/lib/delivery-reconciliation'
import { EmptyState } from '@/components/gradia/empty-state'
import { ErrorState } from '@/components/gradia/error-state'
import { Pagination } from '@/components/gradia/pagination'
import { StatusPill } from '@/components/ui/status-pill'
import { DeliveryReconciliationForm } from './delivery-reconciliation-form'

/** `pageHref` lets a delegated reviewer page keep its own address; the owner approval record is the default. */
export async function DeliveryReconciliationHistory({db, shopId, actionId, page, pageHref}: {
  db: SupabaseClient; shopId: string; actionId: string; page?: string | string[]
  pageHref?: (offset: number) => string
}) {
  const href = pageHref ?? ((next: number) => `/approvals/${actionId}?reviewOffset=${next}`)
  const offset = typeof page === 'string' && /^\d{1,7}$/.test(page) ? Number(page) : page === undefined ? 0 : -1
  if (offset < 0) return <ErrorState compact title="Invalid review history page. Return to the delivery review." />
  let result
  try {
    result = await db.rpc('read_delivery_reconciliation', {p_shop: shopId, p_action: actionId, p_offset: offset})
  } catch { return <ErrorState compact title="Delivery review history is unavailable. Refresh before recording a decision." /> }
    const parsed = reconciliationHistorySchema.safeParse(result.data)
    if (result.error || !parsed.success) return <ErrorState compact title="Delivery review history is unavailable. Refresh before recording a decision." />
    const history = parsed.data
    return <section className="space-y-5" aria-label="Delivery review history">
      <h2 className="font-display text-lg text-foreground">Delivery review history</h2>
      <p className="text-sm text-muted-foreground">Reviews are attributed to the signed-in owner or delegated manager who recorded them and retained as successive decisions. They do not change sending authority or confirm delivery automatically.</p>
      {history.items.length === 0 ? <EmptyState title="No reviews on this page." /> : <ol className="space-y-3">{history.items.slice(0,20).map(item => <li className="space-y-2 rounded-md bg-card p-3 ring-1 ring-border" key={item.command_id}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-foreground">Review {item.revision}: {deliveryOutcomes[item.outcome]}</p>
          <StatusPill tone="muted">{reviewerLabels[item.actor_role]}</StatusPill>
        </div>
        <p className="text-sm text-muted-foreground">{item.created_at} · {item.actor_label} ({reviewerLabels[item.actor_role]})</p>
        <p className="whitespace-pre-wrap break-words text-sm">{item.note}</p>
      </li>)}</ol>}
      <Pagination
        label="Delivery review history pages"
        previous={offset > 0 ? { href: href(Math.max(0,offset-20)), label: "Newer reviews" } : null}
        next={history.items.length > 20 ? { href: href(offset+20), label: "Older reviews" } : null}
      />
      <DeliveryReconciliationForm key={`${history.revision}:${history.completed_at}`} shopId={shopId} actionId={actionId} revision={history.revision} completedAt={history.completed_at}/>
    </section>
}
