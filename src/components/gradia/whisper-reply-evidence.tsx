import type {SupabaseClient} from '@supabase/supabase-js'
import {z} from 'zod'
const evidenceSchema=z.object({interaction_id:z.string().uuid(),channel:z.enum(['sms','email']),content:z.string(),recorded_at:z.string()})
export async function WhisperReplyEvidence({db,shopId,actionId}:{db:SupabaseClient;shopId:string;actionId:string}){
 let result
 try{result=await db.rpc('whisper_reply_context',{p_shop:shopId,p_action:actionId})}catch{return <p role="alert">Reply context could not be verified. Service-purpose review must stay held.</p>}
 if(result.error)return <p role="alert">The exact recent inbound message could not be verified. Do not classify this draft as a service reply.</p>
 if(result.data===null)return null
 const parsed=evidenceSchema.safeParse(result.data)
 if(!parsed.success)return <p role="alert">Reply evidence is unavailable. Refresh before reviewing purpose.</p>
 return <section className="space-y-2 rounded border p-4" aria-label="Bound inbound reply context"><h2 className="font-semibold">Message this draft responds to</h2><p>{parsed.data.channel} · {parsed.data.recorded_at}</p><blockquote className="whitespace-pre-wrap break-words">{parsed.data.content}</blockquote><p>Use service-reply review only for an answer to this request. Promotions still require marketing consent. Review records purpose; it does not send.</p></section>
}
