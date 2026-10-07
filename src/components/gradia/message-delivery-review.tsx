import type {MessageDeliveryReview} from '@/lib/message-delivery-review'
export function MessageDeliveryReviewPanel({review}:{review:MessageDeliveryReview}){
 if(review.state==='unspent')return null
 return <section className="space-y-3 rounded border p-5" aria-label="Delivery reconciliation">
  <h1 className="text-xl font-semibold">{review.state==='unavailable'?'Execution history unavailable':review.state==='claimed'?'Delivery uncertain — review required':'Provider accepted request — delivery not confirmed'}</h1>
  <p role="alert">Do not retry this action or create a replacement just because delivery is uncertain. Sending authority is never automatically restored.</p>
  {review.state==='unavailable'?<p>Refresh after database access is restored. No delivery conclusion can be made from this failed lookup.</p>:<p>Execution claimed: {review.claimedAt}. {review.completedAt?`Provider response recorded: ${review.completedAt}.`:'No successful provider response was recorded.'}</p>}
  <ol className="list-decimal space-y-2 pl-5"><li>An authorized owner must check the provider’s message/activity records for this action, recipient and time.</li><li>Record and review that evidence before deciding whether delivery succeeded, failed or remains unknown. This page does not resolve delivery automatically.</li><li>If there is no definitive evidence, retain the hold. Any replacement message requires a separate, explicitly reviewed decision and all current consent and policy checks.</li></ol>
  <p>This read-only review does not contact a provider, release a consumed proof, edit the message or authorize another send.</p>
 </section>
}
