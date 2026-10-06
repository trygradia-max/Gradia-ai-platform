import { z } from 'zod'
export type NotificationEmail = {id:string;sender_email:string;recipient_email:string;subject:string;body:string}
export type NotificationOutcome = {state:'accepted'|'retry'|'unknown'|'failed';providerId:string|null}
/** Optional Resend implementation; no default provider or automatic activation. */
export function managerNotificationConfig() {
  const from=z.email().safeParse(process.env.GRADIA_NOTIFICATION_FROM)
  if(process.env.GRADIA_MANAGER_EMAIL_DELIVERY!=='enabled' || process.env.GRADIA_NOTIFICATION_PROVIDER!=='resend' || !from.success || !process.env.GRADIA_NOTIFICATION_API_KEY) return null
  return {from:from.data,apiKey:process.env.GRADIA_NOTIFICATION_API_KEY}
}
export async function sendManagerNotification(job:NotificationEmail):Promise<NotificationOutcome> {
 const config=managerNotificationConfig()
 if(!config || job.sender_email!==config.from)return {state:'failed',providerId:null}
 try{
  const response=await fetch('https://api.resend.com/emails',{
   method:'POST',signal:AbortSignal.timeout(15000),
   headers:{Authorization:`Bearer ${config.apiKey}`,'Content-Type':'application/json','Idempotency-Key':`gradia-manager/${job.id}`},
   body:JSON.stringify({from:job.sender_email,to:[job.recipient_email],subject:job.subject,text:job.body}),
  })
  if(response.status===429)return {state:'retry',providerId:null}
  if(response.status>=400&&response.status<500&&response.status!==408&&response.status!==409)return {state:'failed',providerId:null}
  if(response.ok){const body=await response.json();if(typeof body?.id==='string'&&body.id.length>0&&body.id.length<=200)return {state:'accepted',providerId:body.id}}
 }catch{/* Uncertain outcome must never automatically resend. */}
 return {state:'unknown',providerId:null}
}
