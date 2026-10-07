import {randomUUID} from 'node:crypto'
import {beforeAll,afterAll,describe,it,expect} from 'vitest'
import type {SupabaseClient} from '@supabase/supabase-js'
import {INTEGRATION_WITH_SESSION,serviceClient,ownerSessionClient,anonClient,seedShop,cleanup,type Seeded} from './_db'
import {recordLeadIntake} from '@/lib/lead-intake'
describe.skipIf(!INTEGRATION_WITH_SESSION)('reviewed intake vehicle linking',()=>{
 let db:SupabaseClient,owner:SupabaseClient,manager:SupabaseClient,shop:Seeded,other:Seeded,member:string
 beforeAll(async()=>{
  db=serviceClient();shop=await seedShop(db,{password:'Synthetic-Vehicle-1004!'});other=await seedShop(db,{password:'Synthetic-Vehicle-1004!'})
  owner=await ownerSessionClient(shop.email,'Synthetic-Vehicle-1004!');manager=await ownerSessionClient(other.email,'Synthetic-Vehicle-1004!')
  const invite=await owner.rpc('team_invite',{p_shop:shop.shopId,p_email:other.email,p_name:'Fictional vehicle manager',p_role:'manager',p_capabilities:['crm.read']});expect(invite.error).toBeNull()
  expect((await manager.rpc('team_accept_invite',{p_token:invite.data.token})).error).toBeNull()
  member=(await owner.from('shop_memberships').select('id').eq('shop_id',shop.shopId).eq('user_id',other.ownerId).single()).data!.id
 })
 afterAll(async()=>{if(shop)await cleanup(db,shop);if(other)await cleanup(db,other)})
 async function customer(shopId=shop.shopId,name='Fictional vehicle owner'){
  const r=await db.from('customers').insert({shop_id:shopId,name}).select('id,name,phone,email,updated_at').single();expect(r.error).toBeNull();return r.data!
 }
 async function vehicle(customerId:string,shopId=shop.shopId){
  const r=await db.from('vehicles').insert({shop_id:shopId,customer_id:customerId,year:2020,make:'Fictional',model:'Test',plate:'SYNTHETIC'}).select('id').single();expect(r.error).toBeNull();return r.data!.id
 }
 async function setup(thread:string=randomUUID()){
  const c=await customer(),vid=await vehicle(c.id)
  const i={shopId:shop.shopId,channel:'synthetic' as const,provider:'synthetic',providerEventId:randomUUID(),threadKey:thread,receivedAt:'2026-10-04T00:00:00Z',payload:{vehicle_text:'Fictional submitted vehicle'}}
  const w=await recordLeadIntake(db,i)
  expect((await owner.rpc('link_intake_customer',{p_shop:shop.shopId,p_workflow:w.workflowId,p_revision:1,p_customer:c.id,p_snapshot:c,p_command:randomUUID()})).error).toBeNull()
  const choices=await owner.rpc('intake_vehicle_choices',{p_shop:shop.shopId,p_workflow:w.workflowId,p_revision:2});expect(choices.error).toBeNull();expect(choices.data.vehicles.map((v:{id:string})=>v.id)).toEqual([vid])
  return {c,vid,i,w,a:{p_shop:shop.shopId,p_workflow:w.workflowId,p_revision:2,p_customer:c.id,p_customer_updated_at:choices.data.customer_updated_at,p_vehicle:vid,p_snapshot:choices.data.vehicles[0],p_command:randomUUID()}}
 }
 const link=(a:Record<string,unknown>)=>owner.rpc('link_intake_vehicle',a)
 const history=(workflow:string)=>owner.rpc('read_lead_intake_history',{p_shop:shop.shopId,p_workflow:workflow})
 it('links atomically and audits once across sequential and concurrent exact retries',async()=>{
  const {a,w,vid}=await setup(),results=await Promise.all([link(a),link(a)])
  expect(results.map(r=>r.data?.status).sort()).toEqual(['already_recorded','linked']);expect((await link(a)).data.status).toBe('already_recorded')
  const h=await history(w.workflowId);expect(h.error).toBeNull();expect(h.data).toMatchObject({vehicle_id:vid,vehicle_status:'confirmed',revision:3})
  expect(h.data.items[2]).toMatchObject({reason:'vehicle_confirmed',actor_id:shop.ownerId,reviewed_vehicle:{id:vid}})
  expect((await db.from('lead_workflow_transitions').select('id').eq('command_id',a.p_command)).data).toHaveLength(1)
 })
 it('competing decisions have one winner, and changed command bindings are denied',async()=>{
  const {a}=await setup(),b={...a,p_command:randomUUID()},r=await Promise.all([link(a),link(b)]);expect(r.filter(x=>!x.error)).toHaveLength(1)
  const winner=r[0].error?b:a
  expect((await link({...winner,p_snapshot:{...a.p_snapshot,model:'Forged'}})).error?.code).toBe('PT409')
 })
 it('rejects foreign shop, same-shop wrong customer vehicle, wrong customer and forged snapshot',async()=>{
  const {a}=await setup(),c=await customer(),otherVehicle=await vehicle(c.id),foreign=await customer(other.shopId),foreignVehicle=await vehicle(foreign.id,other.shopId)
  for(const vid of [otherVehicle,foreignVehicle])expect((await link({...a,p_vehicle:vid})).error?.code).toBe('42501')
  expect((await link({...a,p_shop:other.shopId})).error?.code).toBe('42501')
  expect((await link({...a,p_customer:c.id})).error?.code).toBe('PT409')
  expect((await link({...a,p_snapshot:{...a.p_snapshot,model:'Forged'}})).error?.code).toBe('PT409')
 })
 it('read-only manager, staff, revoked and sessionless callers cannot link or list vehicle choices',async()=>{
  const {a,w}=await setup()
  for(const caller of [manager,anonClient(),db]){
   expect((await caller.rpc('link_intake_vehicle',a)).error).not.toBeNull()
   expect((await caller.rpc('intake_vehicle_choices',{p_shop:shop.shopId,p_workflow:w.workflowId,p_revision:2})).error).not.toBeNull()
  }
  for(const [role,active] of [['staff',true],['manager',false]] as const){
   expect((await owner.rpc('team_set_member',{p_shop:shop.shopId,p_member:member,p_role:role,p_active:active,p_capabilities:[]})).error).toBeNull()
   expect((await manager.rpc('link_intake_vehicle',a)).error?.code).toBe('42501')
  }
 })
 it('rejects changed customer and vehicle snapshots and stale workflow review',async()=>{
  const {a,c,vid}=await setup()
  expect((await db.from('vehicles').update({model:'Changed'}).eq('id',vid)).error).toBeNull();expect((await link(a)).error?.code).toBe('PT409')
  expect((await db.from('customers').update({name:'Changed',updated_at:'2026-10-05T00:00:00Z'}).eq('id',c.id)).error).toBeNull();expect((await link(a)).error?.code).toBe('PT409')
  expect((await link({...a,p_revision:1})).error?.code).toBe('PT409')
 })
 it('new evidence invalidates current link while duplicate intake preserves it',async()=>{
  const {a,i,w}=await setup();expect((await link(a)).error).toBeNull()
  await recordLeadIntake(db,i);expect((await history(w.workflowId)).data.vehicle_status).toBe('confirmed')
  await recordLeadIntake(db,{...i,providerEventId:randomUUID(),receivedAt:'2026-10-03T00:00:00Z'})
  const h=await history(w.workflowId);expect(h.data).toMatchObject({vehicle_id:null,vehicle_status:'unresolved',state:'identity_review',revision:4});expect(h.data.items[2].reviewed_vehicle.id).toBe(a.p_vehicle)
 })
 it('vehicle edits become needs-review; deletion clears current reference and preserves audit',async()=>{
  const {a,vid,w}=await setup();expect((await link(a)).error).toBeNull()
  expect((await db.from('vehicles').update({color:'Changed'}).eq('id',vid)).error).toBeNull();expect((await history(w.workflowId)).data.vehicle_status).toBe('needs_review')
  expect((await db.from('vehicles').delete().eq('id',vid)).error).toBeNull();const h=await history(w.workflowId)
  expect(h.data.vehicle_id).toBeNull();expect(h.data.items[2].reviewed_vehicle.id).toBe(vid)
 })
 it('database constraint rejects reassignment; direct workflow writes are denied',async()=>{
  const {a,c,vid,w}=await setup(),different=await customer();expect((await link(a)).error).toBeNull()
  expect((await db.from('vehicles').update({customer_id:different.id}).eq('id',vid)).error?.code).toBe('23503')
  expect((await db.from('vehicles').select('customer_id').eq('id',vid).single()).data!.customer_id).toBe(c.id)
  const wrongVehicle=await vehicle(different.id)
  expect((await db.from('lead_workflows').update({vehicle_id:wrongVehicle}).eq('id',w.workflowId)).error?.code).toBe('42501')
 })
 it.each([false,true])('customer merge invalidates vehicle confirmation safely; rollback=%s',async fail=>{
  const {a,c,vid,w}=await setup(),winner=await customer(shop.shopId,fail?'P0_INJECT_MERGE_FAILURE':'Fictional winner');expect((await link(a)).error).toBeNull()
  const r=await owner.rpc('merge_customers_atomic',{p_shop:shop.shopId,p_winner:winner.id,p_loser:c.id})
  if(fail)expect(r.error?.message).toContain('Injected mid-merge failure');else expect(r.error).toBeNull()
  const h=await history(w.workflowId);expect(h.data.customer_id).toBe(fail?c.id:winner.id);expect(h.data.vehicle_id).toBe(fail?vid:null);expect(h.data.items[2].reviewed_vehicle.customer_id).toBe(c.id)
 })
 it('customer deletion preserves workflow/history with nullable customer and vehicle links',async()=>{
  const {a,c,w}=await setup();expect((await link(a)).error).toBeNull();expect((await db.from('customers').delete().eq('id',c.id)).error).toBeNull()
  const h=await history(w.workflowId);expect(h.data).toMatchObject({customer_id:null,vehicle_id:null,vehicle_status:'unresolved'});expect(h.data.items[2].reviewed_vehicle.id).toBe(a.p_vehicle)
 })
 it('injected failure rolls back vehicle link, revision and audit, with no business effects',async()=>{
  const {a,w}=await setup('INTAKE_INJECT_VEHICLE_FAILURE'),before=await db.from('lead_workflows').select('*').eq('id',w.workflowId).single()
  expect((await link(a)).error?.message).toContain('Injected intake vehicle failure')
  expect((await db.from('lead_workflows').select('*').eq('id',w.workflowId).single()).data).toEqual(before.data)
  expect((await db.from('lead_workflow_transitions').select('id').eq('command_id',a.p_command)).data).toEqual([])
  for(const table of ['leads','interactions','appointments','pending_actions','customer_channel_permissions'])expect((await db.from(table).select('id').eq('shop_id',shop.shopId)).data).toEqual([])
 })
})
