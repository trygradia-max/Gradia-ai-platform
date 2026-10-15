'use client'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { recordDeliveryReconciliation } from '@/app/actions/delivery-reconciliation'
import { deliveryOutcomes } from '@/lib/delivery-reconciliation'

export function DeliveryReconciliationForm({shopId, actionId, revision, completedAt}: {
  shopId: string; actionId: string; revision: number; completedAt: string | null
}) {
  const router = useRouter()
  const [outcome, setOutcome] = useState<keyof typeof deliveryOutcomes>('unknown')
  const [note, setNote] = useState('')
  const [message, setMessage] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [pending, startTransition] = useTransition()
  return <form className="space-y-3 rounded-md bg-card p-4 ring-1 ring-border" onSubmit={event => {
    event.preventDefault()
    if (submitted || pending) return
    setSubmitted(true)
    const commandId = crypto.randomUUID()
    startTransition(async () => {
      try {
        const result = await recordDeliveryReconciliation({shopId, actionId, commandId, revision, completedAt, outcome, note})
        setMessage(result.message)
        if (result.ok) router.refresh()
      } catch { setMessage('Result uncertain. Refresh and check history before recording another review.') }
    })
  }}>
    <h2 className="font-display text-lg text-foreground">Record your delivery review</h2>
    <p className="text-sm text-muted-foreground">This records your assessment, not a verified delivery receipt. It never resends, releases a proof or removes the execution hold.</p>
    <label className="block text-sm" htmlFor="delivery-outcome">Review outcome</label>
    <select id="delivery-outcome" className="min-h-11 w-full rounded-sm border border-border-control bg-background px-3 py-2 text-sm" value={outcome} disabled={submitted || pending} onChange={e => setOutcome(e.target.value as keyof typeof deliveryOutcomes)}>
      {Object.entries(deliveryOutcomes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select>
    <label className="block text-sm" htmlFor="delivery-evidence">Evidence checked and reason</label>
    <textarea id="delivery-evidence" className="min-h-28 w-full rounded-sm border border-border-control bg-background p-3 text-sm" required minLength={10} maxLength={2000} value={note} disabled={submitted || pending} onChange={e => setNote(e.target.value)} aria-describedby="delivery-note-help"/>
    <p id="delivery-note-help" className="text-sm text-muted-foreground">Describe what you checked and any provider record reference. Do not include passwords, tokens or unnecessary customer details.</p>
    <button type="submit" className="inline-flex min-h-11 items-center rounded-sm border border-border-control px-4 text-sm" disabled={submitted || pending || note.trim().length < 10}>Record review only</button>
    {message && <p role="status">{message}</p>}
    {submitted && <p>Refresh this page to check the recorded history before another decision.</p>}
  </form>
}
