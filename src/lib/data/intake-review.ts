import { z } from "zod"
import type { SupabaseClient } from "@supabase/supabase-js"
const item = z.object({
  id: z.string().uuid(), channel: z.enum(["sms", "website_form", "meta", "synthetic"]),
  provider: z.string(), state: z.literal("identity_review"), revision: z.number().int().positive(),
  event_count: z.number().int().positive(),
  last_received_at: z.string(), payload: z.record(z.string(), z.string()),
})
const queue = z.object({total:z.number().int().nonnegative(),items:z.array(item)})
export type IntakeReview = z.infer<typeof queue>
export type IntakeReviewResult = {ok:true;queue:IntakeReview} | {ok:false}
/** Session client only; PostgreSQL independently verifies current authority. */
export async function loadIntakeReview(db:SupabaseClient,shopId:string,offset=0,limit=20):Promise<IntakeReviewResult>{
  if(!z.string().uuid().safeParse(shopId).success || !Number.isSafeInteger(offset) || offset<0 || !Number.isInteger(limit) || limit<1 || limit>50)return {ok:false}
  try{
    const result=await db.rpc("list_lead_intake_review",{p_shop:shopId,p_offset:offset,p_limit:limit})
    if(result.error)return {ok:false}
    const parsed=queue.safeParse(result.data)
    return parsed.success?{ok:true,queue:parsed.data}:{ok:false}
  }catch{return {ok:false}}
}
