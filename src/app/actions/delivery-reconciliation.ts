'use server'
import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/shop'
import { createClient } from '@/lib/supabase/server'
import { reconciliationCommandSchema } from '@/lib/delivery-reconciliation'

export async function recordDeliveryReconciliation(input: unknown): Promise<{ok: boolean; message: string}> {
  const parsed = reconciliationCommandSchema.safeParse(input)
  if (!parsed.success) return {ok: false, message: 'Choose a review outcome and add 10–2,000 characters of evidence notes.'}
  await requireUser()
  const db = await createClient(), c = parsed.data
  try {
    const {data, error} = await db.rpc('record_delivery_reconciliation', {
      p_shop: c.shopId, p_action: c.actionId, p_command: c.commandId,
      p_revision: c.revision, p_completed_at: c.completedAt, p_outcome: c.outcome, p_note: c.note,
    })
    if (error || data !== c.commandId) return {ok: false, message: 'Review not confirmed. Refresh and check history, current access and execution state before trying again.'}
    revalidatePath(`/approvals/${c.actionId}`)
    revalidatePath('/team/delivery-reviews')
    return {ok: true, message: 'Review recorded. Nothing was sent and sending authority remains consumed.'}
  } catch {
    return {ok: false, message: 'Result uncertain. Refresh and check history before recording another review.'}
  }
}
