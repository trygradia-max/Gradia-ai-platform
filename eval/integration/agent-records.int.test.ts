import { randomUUID } from "node:crypto"
import { afterAll,beforeAll,describe,expect,it } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { INTEGRATION_WITH_SESSION,serviceClient,ownerSessionClient,seedShop,cleanup,type Seeded } from "./_db"
import { initialPolicyDraft } from "@/lib/control-center/drafts"
import { executeApproval } from "@/lib/approvals"
import { issueServiceProof } from "@/lib/service-purpose"

describe.skipIf(!INTEGRATION_WITH_SESSION)("atomic Agent record commands",()=>{
 let db:SupabaseClient,owner:SupabaseClient,shop:Seeded,foreign:Seeded,customer:string,other:string
 let active:number|null=null
 async function stage(type:string,payload:Record<string,unknown>){
  const id=randomUUID();const r=await owner.rpc('stage_agent_capture',{p_shop:shop.shopId,p_actor:shop.ownerId,p_command:id,p_type:type,p_payload:payload,p_source:'owner_agent',p_token:null});expect(r.error).toBeNull();return id
 }
 const approve=(id:string)=>executeApproval(db,id,shop.shopId,{userId:shop.ownerId})
 async function snapshot(id=customer){const r=await db.from('customers').select('*').eq('shop_id',shop.shopId).eq('id',id).single();expect(r.error).toBeNull();return r.data!}
 async function edit(changes:Record<string,unknown>,vehicle:unknown=null){const c=await snapshot();return {customer_id:customer,before:{name:c.name,phone:c.phone,email:c.email},expected_updated_at:c.updated_at,changes,vehicle}}
 async function unchangedFailure(id:string,before:Record<string,unknown>){
  expect((await approve(id)).ok).toBe(false)
  expect(await snapshot()).toEqual(before)
  expect((await db.from('pending_actions').select('status,result_id').eq('id',id).single()).data).toEqual({status:'pending',result_id:null})
  expect((await db.from('control_execution_decisions').select('id').eq('action_id',id)).data).toEqual([])
 }
 beforeAll(async()=>{
  db=serviceClient();shop=await seedShop(db,{password:'Synthetic-Records-Only-1001!'});foreign=await seedShop(db,{password:'Synthetic-Records-Only-1001!'})
  owner=await ownerSessionClient(shop.email,'Synthetic-Records-Only-1001!')
  const c=await db.from('customers').insert({shop_id:shop.shopId,name:'Fictional Customer',phone:'+15555550201',email:'record@example.test'}).select('id').single();expect(c.error).toBeNull();customer=c.data!.id
  const f=await db.from('customers').insert({shop_id:foreign.shopId,name:'Fictional Other',phone:'+15555550202'}).select('id').single();expect(f.error).toBeNull();other=f.data!.id
 })
 afterAll(async()=>{if(shop)await cleanup(db,shop);if(foreign)await cleanup(db,foreign)})
 it('customer resolution stages without side effects, then creates one customer across concurrent approvals',async()=>{
  const payload={name:'Fictional New',phone:'+15555550203',email:'new-record@example.test'}
  const id=await stage('resolve_customer',payload)
  expect((await db.from('customers').select('id').eq('shop_id',shop.shopId).eq('phone',payload.phone)).data).toEqual([])
  const results=await Promise.all([approve(id),approve(id)])
  expect(results.filter(r=>r.ok&&r.status==='executed')).toHaveLength(1)
  expect(results.filter(r=>r.ok&&r.status==='already_decided')).toHaveLength(1)
  expect((await db.from('customers').select('id').eq('shop_id',shop.shopId).eq('phone',payload.phone)).data).toHaveLength(1)
 })
 it('resolution refuses conflicting phone/email identities without merging or partial changes',async()=>{
  const before=await snapshot(),id=await stage('resolve_customer',{name:'Do not replace',phone:before.phone,email:'new-record@example.test'})
  await unchangedFailure(id,before)
 })
 it('resolution of an existing identity preserves established fields and consent',async()=>{
  const before=await snapshot(),id=await stage('resolve_customer',{name:'Do not overwrite',phone:before.phone,email:before.email})
  const r=await approve(id);expect(r).toMatchObject({ok:true,status:'executed',resultId:customer})
  expect(await snapshot()).toMatchObject({name:before.name,phone:before.phone,email:before.email})
 })
 it('contact edits and the decision audit commit together; completed retries never reopen',async()=>{
  const id=await stage('update_customer',await edit({email:'changed-record@example.test'}))
  expect((await snapshot()).email).toBe('record@example.test')
  expect(await approve(id)).toMatchObject({ok:true,status:'executed',resultId:customer})
  expect((await snapshot()).email).toBe('changed-record@example.test')
  expect(await approve(id)).toMatchObject({ok:true,status:'already_decided'})
  expect((await db.from('control_execution_decisions').select('actor_id,action_type,allowed').eq('action_id',id)).data).toEqual([{actor_id:shop.ownerId,action_type:'update_customer',allowed:true}])
 })
 it('a stale customer snapshot leaves the current record and pending proposal intact',async()=>{
  const payload=await edit({email:'stale@example.test'}),id=await stage('update_customer',payload)
  expect((await db.from('customers').update({name:'Fictional changed elsewhere'}).eq('id',customer).eq('shop_id',shop.shopId)).error).toBeNull()
  await unchangedFailure(id,await snapshot())
 })
 it('vehicle failure after contact update rolls back contact, audit and claim',async()=>{
  const before=await snapshot(),payload=await edit({email:'must-rollback@example.test'},{id:null,before:null,expected_updated_at:null,changes:{color:'Silver'}})
  await unchangedFailure(await stage('update_customer',payload),before)
 })
 it('vehicle updates require an owned exact snapshot and commit with contact changes',async()=>{
  const v=await db.from('vehicles').insert({shop_id:shop.shopId,customer_id:customer,make:'Fictional',model:'Sedan'}).select('*').single();expect(v.error).toBeNull()
  const id=await stage('update_customer',await edit({email:'vehicle-owner@example.test'},{id:v.data!.id,before:{make:v.data!.make,model:v.data!.model,year:v.data!.year,color:v.data!.color},expected_updated_at:v.data!.updated_at,changes:{color:'Blue'}}))
  expect(await approve(id)).toMatchObject({ok:true,status:'executed'})
  expect((await db.from('vehicles').select('color').eq('id',v.data!.id).single()).data?.color).toBe('Blue')
  const stale=await stage('update_customer',await edit({email:'stale-vehicle@example.test'},{id:v.data!.id,before:{make:v.data!.make,model:v.data!.model,year:v.data!.year,color:v.data!.color},expected_updated_at:v.data!.updated_at,changes:{color:'Red'}}))
  await unchangedFailure(stale,await snapshot())
 })
 it('vehicle field changes are refused even when an older writer did not advance its timestamp',async()=>{
  const found=await db.from('vehicles').select('*').eq('shop_id',shop.shopId).eq('customer_id',customer).limit(1).single();expect(found.error).toBeNull();const v=found.data!
  const payload=await edit({email:'do-not-overwrite@example.test'},{id:v.id,before:{make:v.make,model:v.model,year:v.year,color:v.color},expected_updated_at:v.updated_at,changes:{color:'Green'}})
  const id=await stage('update_customer',payload)
  expect((await db.from('vehicles').update({color:'Changed outside Agent',updated_at:v.updated_at}).eq('id',v.id).eq('shop_id',shop.shopId)).error).toBeNull()
  await unchangedFailure(id,await snapshot())
  expect((await db.from('vehicles').select('color').eq('id',v.id).single()).data?.color).toBe('Changed outside Agent')
 })
 it('a foreign vehicle cannot be queued against an owned customer',async()=>{
  const v=await db.from('vehicles').insert({shop_id:foreign.shopId,customer_id:other,make:'Fictional'}).select('*').single();expect(v.error).toBeNull()
  const p=await edit({email:'must-not-change@example.test'},{id:v.data!.id,before:{make:v.data!.make,model:v.data!.model,year:v.data!.year,color:v.data!.color},expected_updated_at:v.data!.updated_at,changes:{color:'Green'}})
  const id=randomUUID(),r=await owner.rpc('stage_agent_capture',{p_shop:shop.shopId,p_actor:shop.ownerId,p_command:id,p_type:'update_customer',p_payload:p,p_source:'owner_agent',p_token:null})
  expect(r.error?.code).toBe('42501');expect((await db.from('pending_actions').select('id').eq('id',id)).data).toEqual([])
 })
 it('foreign customer staging is denied before a proposal exists',async()=>{
  const id=randomUUID(),r=await owner.rpc('stage_agent_capture',{p_shop:shop.shopId,p_actor:shop.ownerId,p_command:id,p_type:'record_interaction',p_payload:{customer_id:other,channel:'sms',role:'customer',content:'Fictional',metadata:{}},p_source:'owner_agent',p_token:null})
  expect(r.error?.code).toBe('42501');expect((await db.from('pending_actions').select('id').eq('id',id)).data).toEqual([])
 })
 it('consent fields cannot be smuggled into a customer patch',async()=>{
  const before=await snapshot();await unchangedFailure(await stage('update_customer',await edit({sms_consent:true})),before)
 })
 it('a new destination receives no old destination marketing permission',async()=>{
  const before=await snapshot()
  const permission=await db.from('customer_channel_permissions').insert({shop_id:shop.shopId,customer_id:customer,channel:'sms',destination:before.phone,marketing_consent_at:new Date().toISOString(),consent_source:'recorded_for_test'})
  expect(permission.error).toBeNull()
  const id=await stage('update_customer',await edit({phone:'+15555550209'}));expect((await approve(id)).ok).toBe(true)
  expect((await db.from('customer_channel_permissions').select('destination').eq('shop_id',shop.shopId).eq('customer_id',customer).eq('channel','sms')).data).toEqual([{destination:before.phone}])
 })
 it('approved reported history cannot forge service proof, inbound evidence or consent',async()=>{
  const c=await snapshot(),id=await stage('record_interaction',{customer_id:customer,channel:'sms',role:'customer',content:'Synthetic reported request',metadata:{direction:'inbound',from_phone:c.phone,verified:true}})
  const r=await approve(id);expect(r).toMatchObject({ok:true,status:'executed',actionType:'record_interaction'})
  if(!r.ok||r.status!=='executed')throw Error('Missing result')
  const record=await db.from('interactions').select('*').eq('id',r.resultId).single()
  expect(record.data).toMatchObject({metadata:{source:'agent_reported',direction:'reported',verified:false,pending_action_id:id},embedding:null})
  expect(await issueServiceProof(db,{shopId:shop.shopId,customerId:customer,channel:'sms',destination:c.phone,body:'Fictional reply'},{kind:'reply',id:r.resultId})).toBeNull()
 })
 it('foreign history metadata references fail atomically',async()=>{
  const id=await stage('record_interaction',{customer_id:customer,channel:'note',role:'system',content:'No foreign references',metadata:{customer_id:other}})
  expect((await approve(id)).ok).toBe(false)
  expect((await db.from('interactions').select('id').eq('shop_id',shop.shopId).eq('content','No foreign references')).data).toEqual([])
 })
 it('history cannot attach another customer in the same shop through metadata',async()=>{
  const second=await db.from('customers').select('id').eq('shop_id',shop.shopId).neq('id',customer).limit(1).single();expect(second.error).toBeNull()
  const id=await stage('record_interaction',{customer_id:customer,channel:'note',role:'system',content:'No mismatched customer',metadata:{customer_id:second.data!.id}})
  expect((await approve(id)).ok).toBe(false)
  expect((await db.from('interactions').select('id').eq('shop_id',shop.shopId).eq('content','No mismatched customer')).data).toEqual([])
 })
 it.each(['update_customer','resolve_customer','record_interaction'])('%s cannot run automatically or call the internal writer directly',async type=>{
  const payload=type==='update_customer'?await edit({email:'automatic-denied@example.test'}):type==='resolve_customer'?{name:'Fictional',phone:'+15555550208',email:null}:{customer_id:customer,channel:'note',role:'system',content:'No automatic write',metadata:{}}
  const id=await stage(type,payload)
  expect((await executeApproval(db,id,shop.shopId,{userId:shop.ownerId},{context:'automatic'})).ok).toBe(false)
  expect((await db.rpc('control_apply_record',{p_shop:shop.shopId,p_action:id,p_actor:shop.ownerId,p_type:type,p:payload})).error).not.toBeNull()
 })
 it('an activated Off policy stops queued record changes',async()=>{
  const id=await stage('update_customer',await edit({email:'off@example.test'}))
  const d=await owner.from('control_policy_drafts').select('revision').eq('shop_id',shop.shopId).single()
  const saved=await owner.rpc('save_control_policy_draft',{p_shop:shop.shopId,p_expected_revision:d.data!.revision,p_definition:{...initialPolicyDraft(),enabled:false}});expect(saved.error).toBeNull()
  const activated=await owner.rpc('activate_control_policy',{p_shop:shop.shopId,p_revision:saved.data,p_expected_active:active});expect(activated.error).toBeNull();active=activated.data
  expect((await approve(id)).ok).toBe(false);expect((await snapshot()).email).not.toBe('off@example.test')
 })
})
