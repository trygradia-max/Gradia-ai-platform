import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'

import {managerNotificationConfig,sendManagerNotification} from '@/lib/notification-email-provider'

// No route/cron invokes this worker before separately approved activation.
const jobSchema=z.object({id:z.string().uuid(),shop_id:z.string().uuid(),recipient_email:z.email(),sender_email:z.email(),subject:z.string().min(1),body:z.string().min(1),attempts:z.number().int().min(1).max(3)})
export async function deliverManagerNotification(db:SupabaseClient,shopId:string):Promise<'disabled'|'idle'|'accepted'|'retry'|'unknown'|'failed'|'unavailable'> {
  const config=managerNotificationConfig()
  if(!config)return 'disabled'
  if(!z.string().uuid().safeParse(shopId).success)return 'unavailable'
  let raw
  try{raw=await db.rpc('claim_manager_notification',{p_shop:shopId,p_sender:config.from})}catch{return 'unavailable'}
  if(raw.error)return 'unavailable'
  if(raw.data===null)return 'idle'
  const parsed=jobSchema.safeParse(raw.data)
  if(!parsed.success || parsed.data.shop_id!==shopId || parsed.data.sender_email!==config.from)return 'unavailable'
  const job=parsed.data
  const {state:outcome,providerId}=await sendManagerNotification(job)
  try{
    const finished=await db.rpc('finish_manager_notification',{p_shop:shopId,p_id:job.id,p_attempt:job.attempts,p_outcome:outcome,p_provider_id:providerId})
    if(finished.error||finished.data!==true)return 'unknown'
  }catch{return 'unknown'}
  return outcome
}
