import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {randomUUID} from 'node:crypto'
import type {SupabaseClient} from '@supabase/supabase-js'
import {INTEGRATION_WITH_SESSION,serviceClient,ownerSessionClient,seedShop,anonClient,cleanup,type Seeded} from './_db'

describe.skipIf(!INTEGRATION_WITH_SESSION)('Owner delivery reconciliation',()=>{
 let db:SupabaseClient,owner:SupabaseClient,ownerReload:SupabaseClient,manager:SupabaseClient,shop:Seeded,other:Seeded
 beforeAll(async()=>{
  db=serviceClient();const password=randomUUID();shop=await seedShop(db,{password});other=await seedShop(db,{password});owner=await ownerSessionClient(shop.email,password);ownerReload=await ownerSessionClient(shop.email,password);manager=await ownerSessionClient(other.email,password)
  const invite=await owner.rpc('team_invite',{p_shop:shop.shopId,p_email:other.email,p_name:'Fictional Manager',p_role:'manager',p_capabilities:['crm.read','assignments.manage']});expect(invite.error).toBeNull()
  expect((await manager.rpc('team_accept_invite',{p_token:invite.data.token})).error).toBeNull()
 })
 afterAll(async()=>{if(shop)await cleanup(db,shop);if(other)await cleanup(db,other)})
 async function fixture(){
  const action=randomUUID(),proof=randomUUID()
  expect((await db.from('pending_actions').insert({id:action,shop_id:shop.shopId,requested_by:shop.ownerId,action_type:'send_sms',payload:{body:'Fictional held message'}})).error).toBeNull()
  expect((await db.from('service_proof_consumptions').insert({shop_id:shop.shopId,action_id:action,proof_id:proof,claims:{synthetic:true}})).error).toBeNull()
  return {p_shop:shop.shopId,p_action:action,p_command:randomUUID(),p_revision:0,p_completed_at:null as string|null,p_outcome:'unknown',p_note:'Checked fictional evidence; outcome remains unknown.'}
 }
 const record=(c:Awaited<ReturnType<typeof fixture>>,client=owner)=>client.rpc('record_delivery_reconciliation',c)
 const read=(action:string,client=owner,offset=0)=>client.rpc('read_delivery_reconciliation',{p_shop:shop.shopId,p_action:action,p_offset:offset})
 it('records owner-attributed immutable decisions without changing pending state, proof or sending authority',async()=>{
  const c=await fixture()
  const before=await db.from('service_proof_consumptions').select('*').eq('action_id',c.p_action).single()
  for(const [i,outcome] of ['unknown','delivered','not_delivered'].entries())expect((await record({...c,p_command:randomUUID(),p_revision:i,p_outcome:outcome})).error).toBeNull()
  const r=await read(c.p_action);expect(r.error).toBeNull();expect(r.data.revision).toBe(3)
  expect(r.data.items.map((x:{outcome:string})=>x.outcome)).toEqual(['not_delivered','delivered','unknown'])
  expect(r.data.items.every((x:{actor_id:string;actor_label:string})=>x.actor_id===shop.ownerId&&x.actor_label==='Owner')).toBe(true)
  expect((await db.from('service_proof_consumptions').select('*').eq('action_id',c.p_action).single()).data).toEqual(before.data)
  expect((await db.from('pending_actions').select('status,result_id,payload').eq('id',c.p_action).single()).data).toEqual({status:'pending',result_id:null,payload:{body:'Fictional held message'}})
 })
 it('denies manager, revoked member, foreign owner, anonymous and sessionless service callers',async()=>{
  const c=await fixture()
  for(const client of [manager,anonClient(),db]){expect((await record(c,client)).error).not.toBeNull();expect((await read(c.p_action,client)).error).not.toBeNull()}
  expect((await record({...c,p_shop:other.shopId})).error).not.toBeNull()
  expect((await db.from('shop_memberships').update({active:false}).eq('shop_id',shop.shopId).eq('user_id',other.ownerId)).error).toBeNull()
  expect((await record(c,manager)).error).not.toBeNull()
  expect((await db.from('shop_memberships').update({active:true,role:'staff',capabilities:[]}).eq('shop_id',shop.shopId).eq('user_id',other.ownerId)).error).toBeNull()
  expect((await record(c,manager)).error).not.toBeNull();expect((await read(c.p_action,manager)).error).not.toBeNull();expect((await read(c.p_action)).data.revision).toBe(0)
 })
 it('denies direct table reads and writes, including service role',async()=>{
  const c=await fixture();expect((await record(c)).error).toBeNull()
  for(const client of [owner,manager,anonClient(),db]){
   expect((await client.from('delivery_reconciliations').select('*')).error).not.toBeNull()
   expect((await client.from('delivery_reconciliations').update({outcome:'delivered'}).eq('command_id',c.p_command)).error).not.toBeNull()
   expect((await client.from('delivery_reconciliations').delete().eq('command_id',c.p_command)).error).not.toBeNull()
   expect((await client.from('delivery_reconciliations').insert({command_id:randomUUID(),shop_id:shop.shopId,action_id:c.p_action,revision:2,actor_id:shop.ownerId,actor_label:'forged',outcome:'delivered',note:'Forged review evidence'})).error).not.toBeNull()
  }
  expect((await read(c.p_action)).data.revision).toBe(1)
 })
 it('concurrent same-command retries commit once across independent sessions and reloads',async()=>{
  const c=await fixture();const results=await Promise.all([record(c),record(c,ownerReload)])
  expect(results.every(r=>!r.error&&r.data===c.p_command)).toBe(true)
  expect((await record(c,ownerReload)).data).toBe(c.p_command);expect((await read(c.p_action)).data.revision).toBe(1)
 })
 it('competing decisions have one winner; stale and conflicting command reuse fail',async()=>{
  const c=await fixture(),d={...c,p_command:randomUUID(),p_outcome:'delivered'}
  const results=await Promise.all([record(c),record(d)]);expect(results.filter(r=>!r.error)).toHaveLength(1);expect(results.find(r=>r.error)?.error?.code).toBe('PT409')
  const winner=results[0].error?d:c
  expect((await record({...winner,p_note:'Changed evidence must not overwrite history.'})).error?.code).toBe('PT409')
  expect((await read(c.p_action)).data.revision).toBe(1)
 })
 it('provider completion arriving during review invalidates the stale snapshot',async()=>{
  const c=await fixture();const completed=new Date().toISOString()
  expect((await db.from('service_proof_consumptions').update({completed_at:completed}).eq('action_id',c.p_action)).error).toBeNull()
  expect((await record(c)).error?.code).toBe('PT409');expect((await read(c.p_action)).data.revision).toBe(0)
  expect((await record({...c,p_completed_at:completed})).error).toBeNull()
 })
 it('rejects missing or foreign execution evidence and invalid direct RPC input without a review',async()=>{
  const c=await fixture()
  expect((await record({...c,p_action:randomUUID()})).error?.code).toBe('42501')
  for(const patch of [{p_outcome:'resend'},{p_outcome:null},{p_note:'short'},{p_note:'x'.repeat(2001)},{p_note:' control evidence '},{p_note:'hidden\u0001control'},{p_revision:-1},{p_command:null}])
   expect((await record({...c,...patch} as typeof c)).error?.code).toBe('22023')
  expect((await read(c.p_action)).data.revision).toBe(0)
  expect((await read(c.p_action,owner,-1)).error?.code).toBe('22023')
 })
 it('history is bounded and stable by revision, with earlier evidence preserved',async()=>{
  const c=await fixture()
  for(let i=0;i<23;i++)expect((await record({...c,p_command:randomUUID(),p_revision:i,p_note:`Fictional evidence revision ${i+1}`})).error).toBeNull()
  const first=await read(c.p_action),second=await read(c.p_action,owner,20)
  expect(first.data.items).toHaveLength(21);expect(first.data.items[0].revision).toBe(23);expect(second.data.items.map((x:{revision:number})=>x.revision)).toEqual([3,2,1])
 })
 it('retains historical review and spent authority after the pending action is deleted',async()=>{
  const c=await fixture();expect((await record(c)).error).toBeNull()
  expect((await db.from('pending_actions').delete().eq('id',c.p_action)).error).toBeNull()
  expect((await read(c.p_action)).data.items[0].command_id).toBe(c.p_command)
  expect((await db.from('service_proof_consumptions').select('proof_id').eq('action_id',c.p_action)).data).toHaveLength(1)
 })
})
