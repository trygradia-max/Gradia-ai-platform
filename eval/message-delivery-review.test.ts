import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {it,expect} from 'vitest'
import {readDb} from './_tenant-fixtures'
import {readMessageDeliveryReview} from '@/lib/message-delivery-review'
import {MessageDeliveryReviewPanel} from '@/components/gradia/message-delivery-review'
import {WhisperReplyEvidence} from '@/components/gradia/whisper-reply-evidence'
import type {SupabaseClient} from '@supabase/supabase-js'
const claimed_at='2026-10-05T00:00:00Z'
it('reads are scoped to the exact shop and action; another action cannot hide a hold',async()=>{
 const {db,reads}=readDb({service_proof_consumptions:[{shop_id:'shop',action_id:'a',claimed_at,completed_at:null}]})
 expect(await readMessageDeliveryReview(db,'shop','a')).toEqual({state:'claimed',claimedAt:claimed_at,completedAt:null})
 expect(reads[0].filters).toEqual([['shop_id','shop'],['action_id','a']]);expect(await readMessageDeliveryReview(db,'shop','b')).toEqual({state:'unspent'})
})
it('provider acceptance is not presented as delivery confirmation',async()=>{
 const {db}=readDb({service_proof_consumptions:[{shop_id:'shop',action_id:'a',claimed_at,completed_at:claimed_at}]})
 const review=await readMessageDeliveryReview(db,'shop','a');expect(review.state).toBe('provider_accepted')
 const html=renderToStaticMarkup(createElement(MessageDeliveryReviewPanel,{review}));expect(html).toContain('delivery not confirmed');expect(html).toContain('read-only');expect(html).not.toContain('<button');expect(html).not.toContain('<form')
})
it('failed or malformed execution reads expose no resend path',async()=>{
 for(const db of [readDb({},'service_proof_consumptions').db,readDb({service_proof_consumptions:[{shop_id:'shop',action_id:'a',claimed_at:'invalid',completed_at:null}]}).db]){
  const review=await readMessageDeliveryReview(db,'shop','a');expect(review).toEqual({state:'unavailable'});const html=renderToStaticMarkup(createElement(MessageDeliveryReviewPanel,{review}));expect(html).toContain('Do not retry');expect(html).not.toContain('<button')
 }
})
it('bound inbound evidence is escaped and never renders provider/internal metadata',async()=>{
 const db={rpc:async()=>({data:{interaction_id:'00000000-0000-4000-8000-000000000001',channel:'email',content:'<script>fictional</script>',recorded_at:claimed_at,destination:'private@example.test',metadata:{token:'private-test-token'}},error:null})} as unknown as SupabaseClient
 const html=renderToStaticMarkup(await WhisperReplyEvidence({db,shopId:'shop',actionId:'a'}));expect(html).toContain('&lt;script&gt;');expect(html).not.toContain('<script>');expect(html).not.toContain('private@example.test');expect(html).not.toContain('private-test-token');expect(html).toContain('Promotions still require marketing consent')
})
it('reply-context lookup errors do not render unverified evidence',async()=>{
 const db={rpc:async()=>({data:{content:'unverified'},error:{message:'private failure'}})} as unknown as SupabaseClient
 const html=renderToStaticMarkup(await WhisperReplyEvidence({db,shopId:'shop',actionId:'a'}));expect(html).toContain('could not be verified');expect(html).not.toContain('unverified');expect(html).not.toContain('private failure')
})
