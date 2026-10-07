import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from "vitest"
import {randomUUID} from "node:crypto"
import type {SupabaseClient} from "@supabase/supabase-js"
import {executeApproval} from "@/lib/approvals"
import {servicePayload,verifyServiceProof} from "@/lib/service-purpose"
import {sendOutboundSms} from "@/lib/twilio"
import {sendEmailMessage,getAccessTokenForShop} from "@/lib/aurinko"
import {INTEGRATION_WITH_SESSION,serviceClient,ownerSessionClient,seedShop,anonClient,cleanup,type Seeded} from "./_db"
vi.mock("@/lib/telephony-provider",async original=>({...await original<typeof import("@/lib/telephony-provider")>(),smsGateForShop:()=>({allowed:true})}))
vi.mock("@/lib/twilio",async original=>({...await original<typeof import("@/lib/twilio")>(),sendOutboundSms:vi.fn(async()=>({messageSid:"synthetic-message",status:"queued"}))}))
vi.mock("@/lib/aurinko",async original=>({...await original<typeof import("@/lib/aurinko")>(),getAccessTokenForShop:vi.fn(async()=>"synthetic-token"),sendEmailMessage:vi.fn(async()=>({id:"synthetic-email"}))}))
vi.mock("@/lib/memory",async original=>({...await original<typeof import("@/lib/memory")>(),recordInteraction:vi.fn(async()=>({ok:true as const,id:randomUUID(),embedded:false}))}))
vi.mock("@/lib/credits",()=>({recordUsage:vi.fn()}))
vi.mock("@/lib/pricing",async original=>({...await original<typeof import("@/lib/pricing")>(),getPricing:vi.fn(),priceUsage:()=>({credits:0,wholesale_cost:0,retail_cost:0})}))
import {reviewCommunicationPurpose,updatePendingProposal} from '@/app/actions/approvals'
import {readMessageDeliveryReview} from '@/lib/message-delivery-review'
let owner:SupabaseClient,shop:Seeded
vi.mock('@/lib/shop',()=>({requireUser:async()=>({id:shop.ownerId}),requireShop:async()=>({id:shop.shopId})}))
vi.mock('@/lib/supabase/server',()=>({createClient:async()=>owner}))
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}))
describe.skipIf(!INTEGRATION_WITH_SESSION)('Whisper exact-context service replies',()=>{
 let db:SupabaseClient,other:Seeded
 beforeAll(async()=>{
  db=serviceClient();const password=randomUUID();shop=await seedShop(db,{password});other=await seedShop(db);owner=await ownerSessionClient(shop.email,password)
  expect((await db.from('shops').update({aurinko_account_id:987654,quiet_hours_start:0,quiet_hours_end:0,twilio_phone_number:'+15550001111'}).eq('id',shop.shopId)).error).toBeNull()
 })
 afterEach(()=>vi.clearAllMocks())
 afterAll(async()=>{await cleanup(db,shop);await cleanup(db,other)})
 async function fixture(channel:'sms'|'email',role='customer'){
  const destination=channel==='sms'?'+1555'+String(Math.floor(Math.random()*1e7)).padStart(7,'0'):`${randomUUID()}@example.test`
  const c=await db.from('customers').insert({shop_id:shop.shopId,name:'Fictional reply customer',do_not_contact:false,...(channel==='sms'?{phone:destination}:{email:destination})}).select('id').single();expect(c.error).toBeNull()
  const i=await db.from('interactions').insert({shop_id:shop.shopId,customer_id:c.data!.id,channel,role,content:'Fictional service question',metadata:{direction:'inbound',...(channel==='sms'?{from_phone:destination}:{from_email:destination,aurinko_message_id:'test-'+c.data!.id})}}).select('id').single();expect(i.error).toBeNull()
  if(channel==='email')expect((await db.from('email_reply_evidence').insert({shop_id:shop.shopId,interaction_id:i.data!.id,account_id:987654,message_id:'test-'+c.data!.id})).error).toBeNull()
  const action=randomUUID(),body='Fictional answer to your question',subject=channel==='email'?'Service answer':''
  expect((await owner.rpc('whisper_command',{p_shop:shop.shopId,p_customer:c.data!.id,p_channel:channel,p_command:action,p_latest:i.data!.id,p_revision:0,p_operation:'reply',p_payload:{destination,body,subject}})).error).toBeNull()
  const original=(await db.from('pending_actions').select('payload').eq('id',action).single()).data!.payload
  const message={shopId:shop.shopId,customerId:c.data!.id,channel,destination,body,...(channel==='email'?{subject}:{}),actionId:action}
  return {action,inbound:i.data!.id,customer:c.data!.id,original,message,channel,destination}
 }
 async function review(f:Awaited<ReturnType<typeof fixture>>){
  expect(await reviewCommunicationPurpose(f.action,'reply')).toMatchObject({ok:true})
  const {data,error}=await db.from('pending_actions').select('payload').eq('id',f.action).single();expect(error).toBeNull();return data!.payload.service_proof as string
 }
 const execute=(id:string,client=db)=>executeApproval(client,id,shop.shopId,{userId:shop.ownerId})
 for(const channel of ['sms','email'] as const){
  const transport=channel==='sms'?sendOutboundSms:sendEmailMessage
  it(`${channel}: explicit exact-context review permits one concurrent execution without marketing consent`,async()=>{
   const f=await fixture(channel),proof=await review(f),claims=JSON.parse(Buffer.from(proof,'base64url').toString())
   expect(claims.context).toMatchObject({kind:'reply',id:f.inbound,whisperAction:f.action,whisperFingerprint:expect.stringMatching(/^[a-f0-9]{64}$/)})
   expect(await verifyServiceProof(serviceClient(),f.message,proof)).toBe(true)
   for(const context of [{...claims.context,whisperAction:randomUUID()},{kind:'reply',id:f.inbound},{...claims.context,whisperFingerprint:'0'.repeat(64)}])expect(await verifyServiceProof(db,f.message,Buffer.from(JSON.stringify({...claims,context})).toString('base64url'))).toBe(false)
   const results=await Promise.all([execute(f.action,owner),execute(f.action,serviceClient())]);expect(results.filter(r=>r.ok&&r.status==='executed'),JSON.stringify(results)).toHaveLength(1)
   expect(await execute(f.action,serviceClient())).toMatchObject({ok:true,status:'already_decided'});expect(transport).toHaveBeenCalledTimes(1)
   if(channel==='email')expect(sendEmailMessage).toHaveBeenCalledWith('synthetic-token',expect.objectContaining({replyToMessageId:'test-'+f.customer}))
   expect((await db.from('customer_channel_permissions').select('id').eq('shop_id',shop.shopId).eq('customer_id',f.customer)).data).toEqual([])
   expect(await readMessageDeliveryReview(owner,shop.shopId,f.action)).toMatchObject({state:'provider_accepted'})
  })
  it(`${channel}: content, recipient, shop, channel, action and expired proof mismatches fail closed`,async()=>{
   const f=await fixture(channel),proof=await review(f)
   for(const patch of [{body:'An edited promotion'},{destination:'different@example.test'},{customerId:randomUUID()},{shopId:other.shopId},{channel:channel==='sms'?'email' as const:'sms' as const},{actionId:randomUUID()}])expect(await verifyServiceProof(db,{...f.message,...patch},proof)).toBe(false)
   expect(await verifyServiceProof(db,f.message,'forged')).toBe(false)
   const clock=vi.spyOn(Date,'now').mockReturnValue(Date.now()+25*60*60*1000);try{expect(await verifyServiceProof(db,f.message,proof)).toBe(false)}finally{clock.mockRestore()}
   const competing=await fixture(channel);expect((await db.from('pending_actions').update({payload:{...competing.original,category:'transactional',service_proof:proof}}).eq('id',competing.action)).error).toBeNull()
   expect(await execute(competing.action)).toMatchObject({ok:false});expect(transport).not.toHaveBeenCalled()
  })
  it(`${channel}: uncertain provider outcome stays held across retry and purpose/edit attempts`,async()=>{
   const f=await fixture(channel);await review(f)
   expect((await owner.rpc('whisper_command',{p_shop:shop.shopId,p_customer:f.customer,p_channel:channel,p_command:randomUUID(),p_latest:f.inbound,p_revision:0,p_operation:'handoff',p_payload:{state:'completed',reason:'Synthetic manual completion',assignee_id:null}})).error).toBeNull()
   vi.mocked(transport).mockRejectedValueOnce(new Error('Synthetic uncertain delivery'))
   expect(await execute(f.action)).toMatchObject({ok:false});expect(await readMessageDeliveryReview(owner,shop.shopId,f.action)).toMatchObject({state:'claimed'})
   expect((await owner.rpc('read_whisper_thread',{p_shop:shop.shopId,p_customer:f.customer,p_channel:channel})).data).toMatchObject({state:'held',reason:expect.stringContaining('Execution has been claimed')})
   expect(await reviewCommunicationPurpose(f.action,'marketing')).toMatchObject({ok:false,error:expect.stringContaining('Reconcile delivery')})
   expect(await updatePendingProposal(f.action,channel==='sms'?{type:'send_sms',to_phone:f.destination,body:'Edited',customer_name:null,reason:null}:{type:'send_email',to_email:f.destination,subject:'Edited',body:'Edited',customer_name:null,reason:null})).toMatchObject({ok:false})
   expect(await execute(f.action,serviceClient())).toMatchObject({ok:false});expect(transport).toHaveBeenCalledTimes(1)
  })
  it(`${channel}: lookup and claim failures have zero transport effects`,async()=>{
   const f=await fixture(channel)
   const failedLookup=new Proxy(db,{get(target,key){if(key==='rpc')return(name:string,args:Record<string,unknown>)=>name==='whisper_reply_context'?Promise.resolve({data:null,error:{message:'Synthetic lookup failure'}}):target.rpc(name,args);const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v}})
   expect((await servicePayload(failedLookup,shop.shopId,{...f.original,source:'verified_reply'},f.action)).service_proof).toBeNull()
   await review(f)
   const failedClaim=new Proxy(db,{get(target,key){if(key==='rpc')return(name:string,args:Record<string,unknown>)=>name==='claim_service_execution'?Promise.resolve({data:null,error:{message:'Synthetic claim failure'}}):target.rpc(name,args);const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v}})
   expect(await execute(f.action,failedClaim)).toMatchObject({ok:false});expect(transport).not.toHaveBeenCalled();expect(getAccessTokenForShop).not.toHaveBeenCalled()
  })
  it(`${channel}: DNC, suppression and SMS STOP still override reviewed service purpose`,async()=>{
   for(const kind of channel==='sms'?['dnc','suppressed','stop']:['dnc','suppressed']){
    const f=await fixture(channel);await review(f)
    if(kind==='suppressed')expect((await db.from('customer_channel_permissions').insert({shop_id:shop.shopId,customer_id:f.customer,channel,destination:f.destination,suppressed_at:new Date().toISOString(),suppression_source:'synthetic'})).error).toBeNull()
    else expect((await db.from('customers').update(kind==='dnc'?{do_not_contact:true}:{sms_opted_out_at:new Date().toISOString()}).eq('id',f.customer)).error).toBeNull()
    expect(await execute(f.action)).toMatchObject({ok:false});expect(transport).not.toHaveBeenCalled()
   }
  })
  it(`${channel}: ordinary marketing drafts still require explicit destination consent`,async()=>{
   const f=await fixture(channel);expect(await reviewCommunicationPurpose(f.action,'marketing')).toMatchObject({ok:true});expect(await execute(f.action)).toMatchObject({ok:false,error:expect.stringContaining('affirmative consent')});expect(transport).not.toHaveBeenCalled()
  })
 }
 it('newer messages do not substitute the staged context; edits to reviewed inbound evidence invalidate its proof',async()=>{
  const f=await fixture('email');expect((await db.from('interactions').insert({shop_id:shop.shopId,customer_id:f.customer,channel:'email',role:'customer',content:'Different later request',metadata:{direction:'inbound',from_email:f.destination}})).error).toBeNull()
  const proof=await review(f);expect(JSON.parse(Buffer.from(proof,'base64url').toString()).context.id).toBe(f.inbound)
  expect((await db.from('interactions').update({content:'Changed original context'}).eq('id',f.inbound)).error).toBeNull();expect(await verifyServiceProof(db,f.message,proof)).toBe(false);expect(await execute(f.action)).toMatchObject({ok:false});expect(sendEmailMessage).not.toHaveBeenCalled()
 })
 it('outbound or old staged messages cannot fall back to another recent inbound message',async()=>{
  for(const mode of ['outbound','expired']){
   const f=await fixture('sms',mode==='outbound'?'gradia':'customer')
   if(mode==='expired')expect((await db.from('interactions').update({created_at:'2020-01-01'}).eq('id',f.inbound)).error).toBeNull()
   expect((await db.from('interactions').insert({shop_id:shop.shopId,customer_id:f.customer,channel:'sms',role:'customer',content:'Another inbound',metadata:{direction:'inbound',from_phone:f.destination}})).error).toBeNull()
   expect(await reviewCommunicationPurpose(f.action,'reply')).toMatchObject({ok:false});expect(sendOutboundSms).not.toHaveBeenCalled()
  }
 })
 it('owner membership cannot be deactivated and a forged Whisper source cannot manufacture an audit anchor',async()=>{
  const f=await fixture('email');expect((await db.from('shop_memberships').update({active:false}).eq('shop_id',shop.shopId).eq('user_id',shop.ownerId)).error?.code).toBe('23514')
  expect((await owner.rpc('whisper_reply_context',{p_shop:shop.shopId,p_action:f.action})).data?.interaction_id).toBe(f.inbound)
  const id=randomUUID();expect((await db.from('pending_actions').insert({id,shop_id:shop.shopId,requested_by:shop.ownerId,action_type:'send_email',payload:f.original})).error).toBeNull();expect((await owner.rpc('whisper_reply_context',{p_shop:shop.shopId,p_action:id})).error?.code).toBe('42501')
 })
 it('foreign, anonymous, changed destination and substituted interaction evidence is denied',async()=>{
  const f=await fixture('sms')
  expect((await anonClient().rpc('whisper_reply_context',{p_shop:shop.shopId,p_action:f.action})).error).not.toBeNull()
  expect((await owner.rpc('whisper_reply_context',{p_shop:other.shopId,p_action:f.action})).error).not.toBeNull()
  expect((await db.from('pending_actions').update({payload:{...f.original,conversation_interaction_id:randomUUID()}}).eq('id',f.action)).error).toBeNull();expect(await reviewCommunicationPurpose(f.action,'reply')).toMatchObject({ok:false})
  expect((await db.from('pending_actions').update({payload:f.original}).eq('id',f.action)).error).toBeNull();expect((await db.from('customers').update({phone:'+15550000001'}).eq('id',f.customer)).error).toBeNull();expect(await reviewCommunicationPurpose(f.action,'reply')).toMatchObject({ok:false})
 })
 it('marketing-threaded replies consume durable authority without a consent exemption or duplicate transport',async()=>{
  const f=await fixture('email')
  expect((await db.from('customer_channel_permissions').insert({shop_id:shop.shopId,customer_id:f.customer,channel:'email',destination:f.destination,marketing_consent_at:new Date().toISOString(),consent_source:'synthetic-owner-record'})).error).toBeNull()
  vi.mocked(sendEmailMessage).mockRejectedValueOnce(new Error('Synthetic uncertain outcome'))
  expect(await execute(f.action)).toMatchObject({ok:false})
  expect(await execute(f.action,serviceClient())).toMatchObject({ok:false})
  expect(sendEmailMessage).toHaveBeenCalledTimes(1)
  expect(sendEmailMessage).toHaveBeenCalledWith('synthetic-token',expect.objectContaining({replyToMessageId:'test-'+f.customer}))
  const claim=(await db.from('service_proof_consumptions').select('claims').eq('action_id',f.action).single()).data!.claims
  expect(claim.executionOnly).toBe(true)
  expect((await db.from('pending_actions').select('payload').eq('id',f.action).single()).data!.payload.service_proof).toBeUndefined()
  expect(await readMessageDeliveryReview(owner,shop.shopId,f.action)).toMatchObject({state:'claimed'})
 })
 it('mailbox reconnection invalidates prior reply authority with zero token refresh or send',async()=>{
  const f=await fixture('email');await review(f)
  await db.from('shops').update({aurinko_account_id:987655}).eq('id',shop.shopId)
  try{expect(await execute(f.action)).toMatchObject({ok:false});expect(sendEmailMessage).not.toHaveBeenCalled();expect(getAccessTokenForShop).not.toHaveBeenCalled()}
  finally{await db.from('shops').update({aurinko_account_id:987654}).eq('id',shop.shopId)}
 })
 it('trusted provider evidence cannot be fabricated or changed through sessions',async()=>{
  const f=await fixture('email')
  const row={shop_id:shop.shopId,interaction_id:f.inbound,account_id:987654,message_id:'test-'+f.customer}
  expect((await owner.from('email_reply_evidence').insert(row)).error).not.toBeNull()
  expect((await db.from('email_reply_evidence').update({message_id:'forged'}).eq('interaction_id',f.inbound)).error).not.toBeNull()
  const inbound=await db.from('interactions').insert({shop_id:shop.shopId,customer_id:f.customer,channel:'email',role:'customer',content:'Synthetic email without provider verification',metadata:{direction:'inbound',from_email:f.destination,aurinko_message_id:'synthetic-unverified'}}).select('id').single();expect(inbound.error).toBeNull()
  for(const patch of [{account_id:987655},{message_id:'substituted'},{shop_id:other.shopId}])expect((await db.from('email_reply_evidence').insert({...row,interaction_id:inbound.data!.id,message_id:'synthetic-unverified',...patch})).error).not.toBeNull()
  const action=randomUUID();expect((await owner.rpc('whisper_command',{p_shop:shop.shopId,p_customer:f.customer,p_channel:'email',p_command:action,p_latest:inbound.data!.id,p_revision:0,p_operation:'reply',p_payload:{destination:f.destination,body:'Synthetic answer',subject:'Answer'}})).error).toBeNull()
  expect(await reviewCommunicationPurpose(action,'reply')).toMatchObject({ok:false});expect(sendEmailMessage).not.toHaveBeenCalled()
 })

})
