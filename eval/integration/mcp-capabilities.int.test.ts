import { randomUUID } from 'node:crypto'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { INTEGRATION_WITH_SESSION, serviceClient, ownerSessionClient, seedShop, cleanup, type Seeded } from './_db'
import { MCP_CAPABILITIES } from '@/lib/mcp/capabilities'
import { authorizeMcpRead } from '@/lib/mcp/read-authority'
import { initialPolicyDraft } from '@/lib/control-center/drafts'

describe.skipIf(!INTEGRATION_WITH_SESSION)('MCP capability and proposal database boundary',()=>{
 let db:SupabaseClient,owner:SupabaseClient,foreignOwner:SupabaseClient,shop:Seeded,foreign:Seeded,customer:string,foreignCustomer:string,token:string
 const context=()=>({shopId:shop.shopId,ownerId:shop.ownerId,tokenId:token})
 const payload=(type:string)=>type==='send_sms'?{customer_id:customer,customer_name:'Fictional',to_phone:'+15555550111',body:'Synthetic marketing draft',category:'marketing',reason:null}:type==='send_email'?{customer_id:customer,customer_name:'Fictional',to_email:'fictional@example.test',subject:'Synthetic',body:'Synthetic marketing draft',category:'marketing',reason:null}:{customer_id:customer,customer_name:'Fictional',phone:'+15555550111',email:'fictional@example.test',car_info:null,service:null,iso_start_time:'2027-01-01T18:00:00Z',duration_minutes:90,timezone:null,pin_notes:null}
 const args=(type:string,patch:Record<string,unknown>={})=>({p_shop:shop.shopId,p_actor:shop.ownerId,p_command:randomUUID(),p_type:type,p_payload:payload(type),p_source:'mcp',p_token:token,...patch})
 beforeAll(async()=>{
  db=serviceClient();shop=await seedShop(db,{password:'Synthetic-Capability-Test-1002!'});foreign=await seedShop(db,{password:'Synthetic-Capability-Test-1002!'})
  owner=await ownerSessionClient(shop.email,'Synthetic-Capability-Test-1002!');foreignOwner=await ownerSessionClient(foreign.email,'Synthetic-Capability-Test-1002!')
  for(const s of [shop,foreign]){const r=await db.from('customers').insert({shop_id:s.shopId,name:'Fictional',phone:'+15555550111',email:'fictional@example.test'}).select('id').single();expect(r.error).toBeNull();if(s===shop)customer=r.data!.id;else foreignCustomer=r.data!.id}
  const r=await owner.from('mcp_tokens').insert({shop_id:shop.shopId,name:'Fictional',token_hash:randomUUID()}).select('id,capabilities').single();expect(r.error).toBeNull();expect(r.data!.capabilities).toEqual([]);token=r.data!.id
 })
 afterAll(async()=>{if(shop)await cleanup(db,shop);if(foreign)await cleanup(db,foreign)})
 it('default token grants nothing; no proposal or business write occurs',async()=>{
  expect(await authorizeMcpRead(db,context(),'recent_customers')).toBe(false)
  const a=args('send_sms');expect((await db.rpc('stage_agent_capture',a)).error?.code).toBe('42501')
  expect((await db.from('pending_actions').select('id').eq('id',a.p_command)).data).toEqual([])
 })
 it('only owner can grant known capabilities; foreign grants and unknown names fail',async()=>{
  expect((await foreignOwner.from('mcp_tokens').update({capabilities:['propose_sms']}).eq('id',token).select('id')).data).toEqual([])
  expect((await owner.from('mcp_tokens').update({capabilities:['unlimited']}).eq('id',token)).error?.code).toBe('23514')
  expect((await owner.from('mcp_tokens').update({capabilities:[...MCP_CAPABILITIES]}).eq('id',token)).error).toBeNull()
  expect(await authorizeMcpRead(db,context(),'recent_customers')).toBe(true)
 })
 it.each(['send_sms','send_email','book_appointment'])('%s retries stage exactly one attributed proposal, never domain data',async type=>{
  const a=args(type),results=await Promise.all([db.rpc('stage_agent_capture',a),db.rpc('stage_agent_capture',a)])
  for(const r of results){expect(r.error).toBeNull();expect(r.data).toBe(a.p_command)}
  const r=await db.from('pending_actions').select('status,payload').eq('id',a.p_command);expect(r.data).toHaveLength(1);expect(r.data![0]).toMatchObject({status:'pending',payload:{source:'mcp',mcp_token_id:token}})
  const changed={...a,p_payload:{...a.p_payload,customer_name:'Changed'}};expect((await db.rpc('stage_agent_capture',changed)).error?.code).toBe('PT409')
  for(const table of ['appointments','leads','interactions'])expect((await db.from(table).select('id').eq('shop_id',shop.shopId)).data).toEqual([])
 })
 it.each(['send_sms','send_email','book_appointment'])('%s rejects foreign customers and mismatched destinations',async type=>{
  for(const patch of [{customer_id:foreignCustomer},type==='send_sms'?{to_phone:'+15555550222'}:type==='send_email'?{to_email:'other@example.test'}:{email:'other@example.test'}]){
   const a=args(type,{p_payload:{...payload(type),...patch}});expect((await db.rpc('stage_agent_capture',a)).error).not.toBeNull();expect((await db.from('pending_actions').select('id').eq('id',a.p_command)).data).toEqual([])
  }
 })
 it('rejects caller-selected service classification and hidden proof fields',async()=>{
  for(const type of ['send_sms','send_email'])for(const patch of [{category:'transactional'},{service_proof:'forged'},{appointment_id:randomUUID()}])expect((await db.rpc('stage_agent_capture',args(type,{p_payload:{...payload(type),...patch}}))).error?.code).toBe('22023')
 })
 it('grant removal denies both subsequent reads and approval of a queued proposal',async()=>{
  const a=args('send_sms');expect((await db.rpc('stage_agent_capture',a)).error).toBeNull()
  expect((await owner.from('mcp_tokens').update({capabilities:[]}).eq('id',token)).error).toBeNull()
  expect(await authorizeMcpRead(db,context(),'recent_customers')).toBe(false)
  expect((await db.rpc('claim_control_action',{p_shop:shop.shopId,p_action:a.p_command,p_actor:shop.ownerId,p_context:'hitl'})).data).toEqual({denied:'mcp_capability_unavailable'})
  expect((await db.from('pending_actions').select('status').eq('id',a.p_command).single()).data?.status).toBe('pending')
  expect((await owner.from('mcp_tokens').update({capabilities:[...MCP_CAPABILITIES]}).eq('id',token)).error).toBeNull()
 })
 it('active Off policy and Shadow Mode both refuse proposals',async()=>{
  expect((await db.from('shops').update({simulation_mode:true}).eq('id',shop.shopId)).error).toBeNull()
  expect((await db.rpc('stage_agent_capture',args('send_email'))).error?.code).toBe('42501')
  await db.from('shops').update({simulation_mode:false}).eq('id',shop.shopId)
  const draft=await owner.from('control_policy_drafts').select('revision').eq('shop_id',shop.shopId).single()
  const save=await owner.rpc('save_control_policy_draft',{p_shop:shop.shopId,p_expected_revision:draft.data!.revision,p_definition:{...initialPolicyDraft(),enabled:false}});expect(save.error).toBeNull()
  expect((await owner.rpc('activate_control_policy',{p_shop:shop.shopId,p_revision:save.data,p_expected_active:null})).error).toBeNull()
  for(const type of ['send_sms','send_email','book_appointment'])expect((await db.rpc('stage_agent_capture',args(type))).error?.code).toBe('42501')
 })
})
