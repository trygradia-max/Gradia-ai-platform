import type {SupabaseClient} from '@supabase/supabase-js'
import {z} from 'zod'
const claimSchema=z.object({claimed_at:z.string().datetime({offset:true}),completed_at:z.string().datetime({offset:true}).nullable()})
export type MessageDeliveryReview = {state:'unspent'} | {state:'unavailable'} | {state:'claimed'|'provider_accepted';claimedAt:string;completedAt:string|null}
/** Read-only. A failed read never exposes a send/retry affordance. */
export async function readMessageDeliveryReview(db:SupabaseClient,shopId:string,actionId:string):Promise<MessageDeliveryReview>{
 try {
  const {data,error}=await db.from('service_proof_consumptions').select('claimed_at,completed_at').eq('shop_id',shopId).eq('action_id',actionId).maybeSingle()
  if(error)return {state:'unavailable'}
  if(!data)return {state:'unspent'}
  const parsed=claimSchema.safeParse(data)
  if(!parsed.success)return {state:'unavailable'}
  return {state:parsed.data.completed_at?'provider_accepted':'claimed',claimedAt:parsed.data.claimed_at,completedAt:parsed.data.completed_at}
 }catch{return {state:'unavailable'}}
}
