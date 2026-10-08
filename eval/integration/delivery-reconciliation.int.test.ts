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
 describe('explicitly delegated manager review',()=>{
  const grant=(capabilities:string[],role='manager',active=true)=>db.from('shop_memberships').update({active,role,capabilities}).eq('shop_id',shop.shopId).eq('user_id',other.ownerId)
  const delegated=['crm.read','delivery.reconcile']
  const holds=(client=owner,offset=0)=>client.rpc('list_delivery_holds',{p_shop:shop.shopId,p_offset:offset})
  it('records a manager-attributed review that changes only the review history',async()=>{
   expect((await grant(delegated)).error).toBeNull();const c=await fixture()
   const before=await db.from('service_proof_consumptions').select('*').eq('action_id',c.p_action).single()
   expect((await record(c,manager)).data).toBe(c.p_command)
   expect((await record({...c,p_command:randomUUID(),p_revision:1,p_outcome:'delivered'})).error).toBeNull()
   for(const client of [owner,manager]){
    const r=await read(c.p_action,client);expect(r.error).toBeNull();expect(r.data.viewer_role).toBe(client===owner?'owner':'manager')
    expect(r.data.items.map((x:{actor_role:string;actor_label:string;actor_id:string})=>[x.actor_role,x.actor_label,x.actor_id])).toEqual([['owner','Owner',shop.ownerId],['manager','Fictional Manager',other.ownerId]])
   }
   expect((await db.from('service_proof_consumptions').select('*').eq('action_id',c.p_action).single()).data).toEqual(before.data)
   expect((await db.from('pending_actions').select('status,result_id,payload,decided_by_user').eq('id',c.p_action).single()).data).toEqual({status:'pending',result_id:null,payload:{body:'Fictional held message'},decided_by_user:null})
  })
  it('gives the manager no approval, proof, pending-action or direct review-table access',async()=>{
   expect((await grant(delegated)).error).toBeNull();const c=await fixture();expect((await record(c,manager)).error).toBeNull()
   const claim=await manager.rpc('claim_control_action',{p_shop:shop.shopId,p_action:c.p_action,p_actor:other.ownerId,p_context:'hitl'})
   expect(claim.data).toEqual({denied:'actor_not_authorized'})
   expect((await manager.from('pending_actions').select('id').eq('id',c.p_action)).data??[]).toEqual([])
   expect((await manager.from('service_proof_consumptions').select('proof_id').eq('action_id',c.p_action)).data??[]).toEqual([])
   expect((await manager.from('delivery_reconciliations').select('*')).error).not.toBeNull()
   expect((await db.from('pending_actions').select('status').eq('id',c.p_action).single()).data).toEqual({status:'pending'})
  })
  it('requires both grants, the manager role and live membership at the moment of each command',async()=>{
   const c=await fixture()
   for(const capabilities of [[],['crm.read'],['crm.read','assignments.manage','notes.write','jobs.progress']]){
    expect((await grant(capabilities)).error).toBeNull()
    expect((await record(c,manager)).error?.code).toBe('42501');expect((await read(c.p_action,manager)).error?.code).toBe('42501');expect((await holds(manager)).error?.code).toBe('42501')
   }
   // The grant cannot exist without customer read access, or on a staff membership.
   expect((await grant(['delivery.reconcile'])).error).not.toBeNull()
   expect((await grant(delegated,'staff')).error).not.toBeNull()
   const member=await db.from('shop_memberships').select('id').eq('shop_id',shop.shopId).eq('user_id',other.ownerId).single()
   expect((await owner.rpc('team_set_member',{p_shop:shop.shopId,p_member:member.data!.id,p_role:'manager',p_active:true,p_capabilities:['delivery.reconcile']})).error).not.toBeNull()
   expect((await owner.rpc('team_set_member',{p_shop:shop.shopId,p_member:member.data!.id,p_role:'manager',p_active:true,p_capabilities:delegated})).error).toBeNull()
   expect((await record(c,manager)).data).toBe(c.p_command)
   // Removal and revocation take effect on the next command, including an exact retry.
   expect((await owner.rpc('team_set_member',{p_shop:shop.shopId,p_member:member.data!.id,p_role:'manager',p_active:true,p_capabilities:['crm.read']})).error).toBeNull()
   expect((await record(c,manager)).error?.code).toBe('42501')
   expect((await grant(delegated,'manager',false)).error).toBeNull()
   for(const attempt of [record(c,manager),record({...c,p_command:randomUUID(),p_revision:1},manager),read(c.p_action,manager),holds(manager)])expect((await attempt).error?.code).toBe('42501')
   expect((await read(c.p_action)).data.revision).toBe(1)
  })
  it('binds commands to their reviewer and to this shop',async()=>{
   expect((await grant(delegated)).error).toBeNull();const c=await fixture()
   expect((await record(c,manager)).data).toBe(c.p_command);expect((await record(c,manager)).data).toBe(c.p_command)
   // The owner cannot replay or overwrite the manager's command identity.
   expect((await record(c)).error?.code).toBe('PT409')
   const foreign=randomUUID()
   expect((await db.from('pending_actions').insert({id:foreign,shop_id:other.shopId,requested_by:other.ownerId,action_type:'send_sms',payload:{body:'Fictional foreign message'}})).error).toBeNull()
   expect((await db.from('service_proof_consumptions').insert({shop_id:other.shopId,action_id:foreign,proof_id:randomUUID(),claims:{synthetic:true}})).error).toBeNull()
   // A grant in one shop is not authority over another shop's evidence, in either direction.
   expect((await record({...c,p_command:randomUUID(),p_action:foreign,p_revision:0},manager)).error?.code).toBe('42501')
   expect((await owner.rpc('read_delivery_reconciliation',{p_shop:other.shopId,p_action:foreign,p_offset:0})).error?.code).toBe('42501')
   expect((await owner.rpc('list_delivery_holds',{p_shop:other.shopId,p_offset:0})).error?.code).toBe('42501')
   expect((await read(c.p_action)).data.revision).toBe(1)
  })
  it('competing owner and manager decisions have exactly one winner',async()=>{
   expect((await grant(delegated)).error).toBeNull();const c=await fixture()
   const results=await Promise.all([record(c),record({...c,p_command:randomUUID(),p_outcome:'delivered'},manager)])
   expect(results.filter(r=>!r.error)).toHaveLength(1);expect(results.find(r=>r.error)?.error?.code).toBe('PT409');expect((await read(c.p_action)).data.revision).toBe(1)
  })
  it('lists only held sends with presentation fields, the same for owner and delegated manager',async()=>{
   expect((await grant(delegated)).error).toBeNull()
   const customer=await db.from('customers').insert({shop_id:shop.shopId,name:'Fictional Held Customer'}).select('id').single();expect(customer.error).toBeNull()
   const held=randomUUID(),settled=randomUUID(),now=new Date().toISOString()
   expect((await db.from('pending_actions').insert([{id:held,shop_id:shop.shopId,requested_by:shop.ownerId,action_type:'send_sms',status:'pending',result_id:null,payload:{body:'Fictional uncertain text',customer_id:customer.data!.id}},{id:settled,shop_id:shop.shopId,requested_by:shop.ownerId,action_type:'send_email',status:'approved',result_id:randomUUID(),payload:{body:'Fictional settled email',customer_id:customer.data!.id}}])).error).toBeNull()
   expect((await db.from('service_proof_consumptions').insert([{shop_id:shop.shopId,action_id:held,proof_id:randomUUID(),claims:{synthetic:true,destination:'+15555550100'},completed_at:null},{shop_id:shop.shopId,action_id:settled,proof_id:randomUUID(),claims:{synthetic:true},completed_at:now}])).error).toBeNull()
   expect((await record({p_shop:shop.shopId,p_action:held,p_command:randomUUID(),p_revision:0,p_completed_at:null,p_outcome:'not_delivered',p_note:'Fictional provider log shows no attempt.'},manager)).error).toBeNull()
   const snapshot=async()=>JSON.stringify([(await db.from('pending_actions').select('*').eq('shop_id',shop.shopId).order('id')).data,(await db.from('service_proof_consumptions').select('*').eq('shop_id',shop.shopId).order('action_id')).data])
   const before=await snapshot()
   for(const client of [owner,manager]){
    const page=await holds(client);expect(page.error).toBeNull();expect(page.data.viewer_role).toBe(client===owner?'owner':'manager')
    const ids=page.data.items.map((x:{action_id:string})=>x.action_id);expect(ids).toContain(held);expect(ids).not.toContain(settled);expect(page.data.items.length).toBeLessThanOrEqual(21)
    const row=page.data.items.find((x:{action_id:string})=>x.action_id===held)
    expect(row).toMatchObject({action_type:'send_sms',customer_id:customer.data!.id,customer_name:'Fictional Held Customer',body:'Fictional uncertain text',completed_at:null,review_revision:1,latest_outcome:'not_delivered'})
    expect(Object.keys(row).sort()).toEqual(['action_id','action_type','body','claimed_at','completed_at','customer_id','customer_name','latest_outcome','review_revision'])
    expect(JSON.stringify(page.data)).not.toContain('+15555550100')
   }
   expect(await snapshot()).toBe(before)
   for(const client of [anonClient(),db])expect((await holds(client)).error).not.toBeNull()
   for(const offset of [-1,100001])expect((await holds(owner,offset)).error?.code).toBe('22023')
   expect((await holds(owner,100000)).data.items).toEqual([])
  })
  it('invitations carry the delegated grant only together with customer read access',async()=>{
   const invite=(capabilities:string[])=>owner.rpc('team_invite',{p_shop:shop.shopId,p_email:`delegate-${randomUUID()}@example.test`,p_name:'Fictional Delegate',p_role:'manager',p_capabilities:capabilities})
   expect((await invite(['delivery.reconcile'])).error).not.toBeNull();expect((await invite(['delivery.reconcile','approvals.execute'])).error).not.toBeNull()
   expect((await invite(delegated)).error).toBeNull()
  })
 })
})
