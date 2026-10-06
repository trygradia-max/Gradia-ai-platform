import Link from 'next/link'
import type { SupabaseClient } from '@supabase/supabase-js'
import { deliveryOutcomes, reconciliationHistorySchema } from '@/lib/delivery-reconciliation'
import { DeliveryReconciliationForm } from './delivery-reconciliation-form'

export async function DeliveryReconciliationHistory({db, shopId, actionId, page}: {
  db: SupabaseClient; shopId: string; actionId: string; page?: string | string[]
}) {
  const offset = typeof page === 'string' && /^\d{1,7}$/.test(page) ? Number(page) : page === undefined ? 0 : -1
  if (offset < 0) return <p role="alert">Invalid review history page. Return to the approval record.</p>
  let result
  try {
    result = await db.rpc('read_delivery_reconciliation', {p_shop: shopId, p_action: actionId, p_offset: offset})
  } catch { return <p role="alert">Delivery review history is unavailable. Refresh before recording a decision.</p> }
    const parsed = reconciliationHistorySchema.safeParse(result.data)
    if (result.error || !parsed.success) return <p role="alert">Delivery review history is unavailable. Refresh before recording a decision.</p>
    const history = parsed.data
    return <section className="space-y-5" aria-label="Owner delivery review history">
      <h2 className="font-semibold">Owner review history</h2>
      <p>Reviews are attributed to the signed-in owner and retained as successive decisions. They do not change sending authority or confirm delivery automatically.</p>
      {history.items.length === 0 ? <p>No owner reviews on this page.</p> : <ol className="space-y-3">{history.items.slice(0,20).map(item => <li className="rounded border p-3" key={item.command_id}>
        <p>Review {item.revision}: {deliveryOutcomes[item.outcome]}</p>
        <p>{item.created_at} · {item.actor_label} (shop owner)</p>
        <p className="whitespace-pre-wrap break-words">{item.note}</p>
      </li>)}</ol>}
      <nav aria-label="Delivery review history pages" className="flex gap-4">
        {offset > 0 && <Link href={`/approvals/${actionId}?reviewOffset=${Math.max(0,offset-20)}`}>Newer reviews</Link>}
        {history.items.length > 20 && <Link href={`/approvals/${actionId}?reviewOffset=${offset+20}`}>Older reviews</Link>}
      </nav>
      <DeliveryReconciliationForm key={`${history.revision}:${history.completed_at}`} shopId={shopId} actionId={actionId} revision={history.revision} completedAt={history.completed_at}/>
    </section>
}
