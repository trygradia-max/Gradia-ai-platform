'use server'
import {revalidatePath} from 'next/cache'
import {requireShop} from '@/lib/shop'
import {createClient} from '@/lib/supabase/server'
import {managerNotificationSettingsSchema,managerNotificationReadSchema} from '@/lib/manager-notification-settings'
export async function getManagerNotifications(){
 const shop=await requireShop(),db=await createClient()
 try{
  const r=await db.rpc('read_manager_notifications',{p_shop:shop.id}),parsed=managerNotificationReadSchema.safeParse(r.data)
  return !r.error&&parsed.success?parsed.data:null
 }catch{return null}
}
export async function saveManagerNotifications(input:unknown):Promise<{ok:boolean;message:string}>{
 const p=managerNotificationSettingsSchema.safeParse(input)
 if(!p.success)return {ok:false,message:'Check the notification mode, timezone and hours.'}
 const shop=await requireShop(),db=await createClient(),v=p.data
 try{
  const r=await db.rpc('configure_manager_notifications',{p_shop:shop.id,p_revision:v.revision,p_mode:v.mode,p_timezone:v.timezone,p_quiet_start:v.quiet_start,p_quiet_end:v.quiet_end,p_digest_hour:v.digest_hour})
  if(r.error||r.data!==v.revision+1)return {ok:false,message:'Settings not confirmed. Refresh and check current access, revision and timezone.'}
  revalidatePath('/settings')
  return {ok:true,message:'Preferences saved. Provider delivery still requires separate activation; no email was sent.'}
 }catch{return {ok:false,message:'Result uncertain. Refresh and check saved preferences before trying again.'}}
}
