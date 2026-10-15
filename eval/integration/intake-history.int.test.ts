import { randomUUID } from 'node:crypto'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { INTEGRATION_WITH_SESSION, serviceClient, ownerSessionClient, anonClient, seedShop, cleanup, type Seeded } from './_db'
import { recordLeadIntake } from '@/lib/lead-intake'
describe.skipIf(!INTEGRATION_WITH_SESSION)('intake history session boundary',()=>{
 let db:SupabaseClient,owner:SupabaseClient,manager:SupabaseClient,shop:Seeded,other:Seeded,workflow:string,foreignWorkflow:string,member:string
 const thread=randomUUID()
 const intake=(shopId:string,time:string)=>recordLeadIntake(db,{shopId,provider:'synthetic',providerEventId:randomUUID(),channel:'synthetic',threadKey:thread,evidenceRef:'private-evidence-ref',receivedAt:time,payload:{message:'Fictional evidence',leadgen_id:'private-provider-id'}})
 const read=(client=owner,patch:Record<string,unknown>={})=>client.rpc('read_lead_intake_history',{p_shop:shop.shopId,p_workflow:workflow,p_offset:0,p_limit:20,p_revision:null,...patch})
 const role=(role:string,active:boolean,grants:string[])=>owner.rpc('team_set_member',{p_shop:shop.shopId,p_member:member,p_role:role,p_active:active,p_capabilities:grants})
 beforeAll(async()=>{
  db=serviceClient();shop=await seedShop(db,{password:'Synthetic-History-1002!'});other=await seedShop(db,{password:'Synthetic-History-1002!'})
  owner=await ownerSessionClient(shop.email,'Synthetic-History-1002!');manager=await ownerSessionClient(other.email,'Synthetic-History-1002!')
  workflow=(await intake(shop.shopId,'2026-10-02T18:00:00Z')).workflowId
  await intake(shop.shopId,'2026-10-01T18:00:00Z')
  foreignWorkflow=(await intake(other.shopId,'2026-10-02T18:00:00Z')).workflowId
  const invite=await owner.rpc('team_invite',{p_shop:shop.shopId,p_email:other.email,p_name:'Fictional history manager',p_role:'manager',p_capabilities:['crm.read']});expect(invite.error).toBeNull()
  expect((await manager.rpc('team_accept_invite',{p_token:invite.data.token})).error).toBeNull()
  member=(await owner.from('shop_memberships').select('id').eq('shop_id',shop.shopId).eq('user_id',other.ownerId).single()).data!.id
 })
 afterAll(async()=>{if(shop)await cleanup(db,shop);if(other)await cleanup(db,other)})
 it('returns late evidence in recording order, bounded stable pages and no internal references',async()=>{
  const first=await read(owner,{p_limit:1});expect(first.error).toBeNull();expect(first.data.total).toBe(2);expect(first.data.items[0].revision).toBe(1)
  const next=await read(owner,{p_limit:1,p_offset:1,p_revision:2});expect(next.error).toBeNull();expect(next.data.items[0].revision).toBe(2)
  expect(new Date(next.data.items[0].received_at).getTime()).toBeLessThan(new Date(first.data.items[0].received_at).getTime())
  expect(JSON.stringify(first.data)).not.toContain('private-evidence-ref');expect(JSON.stringify(next.data)).not.toContain('private-provider-id')
 })
 it('denies foreign workflow/shop, unknown workflows, anonymous and service clients',async()=>{
  for(const patch of [{p_workflow:foreignWorkflow},{p_shop:other.shopId,p_workflow:foreignWorkflow},{p_workflow:randomUUID()}])expect((await read(owner,patch)).error?.code).toBe('42501')
  for(const caller of [anonClient(),db])expect((await read(caller)).error).not.toBeNull()
 })
 it('enforces live manager grants, revocation and staff restrictions',async()=>{
  expect((await read(manager)).error).toBeNull()
  expect((await role('manager',true,[])).error).toBeNull();expect((await read(manager)).error?.code).toBe('42501')
  expect((await role('manager',false,['crm.read'])).error).toBeNull();expect((await read(manager)).error?.code).toBe('42501')
  expect((await role('staff',true,[])).error).toBeNull();expect((await read(manager)).error?.code).toBe('42501')
 })
 it('rejects invalid pages and stale revision without returning partial history',async()=>{
  for(const patch of [{p_limit:0},{p_limit:51},{p_offset:-1},{p_offset:1},{p_revision:0},{p_limit:null}])expect((await read(owner,patch)).error?.code).toBe('22023')
  const result=await read(owner,{p_revision:1});expect(result.error?.code).toBe('PT409');expect(result.data).toBeNull()
 })
 it('retains completed owner decisions and historical snapshots after customer edits',async()=>{
  const c=await db.from('customers').insert({shop_id:shop.shopId,name:'Fictional original'}).select('id,name,phone,email,updated_at').single();expect(c.error).toBeNull()
  const linked=await owner.rpc('link_intake_customer',{p_shop:shop.shopId,p_workflow:workflow,p_revision:2,p_customer:c.data!.id,p_snapshot:c.data,p_command:randomUUID()});expect(linked.error).toBeNull()
  expect((await db.from('customers').update({name:'Fictional changed'}).eq('id',c.data!.id)).error).toBeNull()
  const result=await read();expect(result.error).toBeNull();expect(result.data.state).toBe('identity_linked');expect(result.data.items).toHaveLength(3)
  expect(result.data.items[2]).toMatchObject({reason:'identity_confirmed',actor_id:shop.ownerId,payload:null,reviewed_customer:{id:c.data!.id,name:'Fictional original'}})
  expect((await read(owner,{p_revision:2})).error?.code).toBe('PT409')
 })
 it('reads have zero mutation effects on workflow, evidence, decisions or business data',async()=>{
  const tables=['lead_workflows','lead_intake_envelopes','lead_workflow_transitions','customers','leads','interactions','pending_actions','appointments']
  const snapshot=async()=>Promise.all(tables.map(async table=>{const r=await db.from(table).select('*').eq('shop_id',shop.shopId).order('id');expect(r.error).toBeNull();return r.data}))
  const before=await snapshot();expect((await read()).error).toBeNull();expect(await snapshot()).toEqual(before)
 })
})
