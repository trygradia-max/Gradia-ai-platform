'use server'
import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/shop'
import { createClient } from '@/lib/supabase/server'
import { intakeLinkSchema } from '@/lib/intake-identity'
export async function linkIntakeIdentity(input:unknown):Promise<{ok:true;message:string}|{ok:false;message:string}>{
 const parsed=intakeLinkSchema.safeParse(input)
 if(!parsed.success)return {ok:false,message:'Choose a customer and confirm the reviewed identity first.'}
 await requireUser()
 const db=await createClient(),c=parsed.data
 try{
  const result=await db.rpc('link_intake_customer',{p_shop:c.shopId,p_workflow:c.workflowId,p_revision:c.revision,p_customer:c.customer.id,p_snapshot:c.customer,p_command:c.commandId})
  if(result.error || result.data?.workflow_id!==c.workflowId || !['linked','already_recorded'].includes(result.data?.status))return {ok:false,message:'The link could not be confirmed. Refresh and check current access, intake and customer details before trying again.'}
  revalidatePath('/intake');revalidatePath('/dashboard')
  return {ok:true,message:'Identity link recorded. No message was sent and qualification has not started.'}
 }catch{return {ok:false,message:'The result is uncertain. Refresh the queue before trying again.'}}
}
