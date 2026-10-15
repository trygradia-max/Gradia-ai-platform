import { randomUUID } from 'node:crypto'
import { afterAll,beforeAll,describe,expect,it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { INTEGRATION_WITH_SESSION,serviceClient,ownerSessionClient,anonClient,seedShop,cleanup,type Seeded } from './_db'
import { recordLeadIntake } from '@/lib/lead-intake'
describe.skipIf(!INTEGRATION_WITH_SESSION)('human intake review authority',()=>{
 let db:SupabaseClient,owner:SupabaseClient,manager:SupabaseClient,shop:Seeded,other:Seeded,member:string
 const read=(client:SupabaseClient,extra:Record<string,unknown>={})=>client.rpc('list_lead_intake_review',{p_shop:shop.shopId,p_offset:0,p_limit:20,...extra})
 beforeAll(async()=>{
  db=serviceClient();shop=await seedShop(db,{password:'Synthetic-Review-1002!'});other=await seedShop(db,{password:'Synthetic-Review-1002!'})
  owner=await ownerSessionClient(shop.email,'Synthetic-Review-1002!');manager=await ownerSessionClient(other.email,'Synthetic-Review-1002!')
  const invite=await owner.rpc('team_invite',{p_shop:shop.shopId,p_email:other.email,p_name:'Fictional manager',p_role:'manager',p_capabilities:[]});expect(invite.error).toBeNull()
  expect((await manager.rpc('team_accept_invite',{p_token:invite.data.token})).error).toBeNull()
  const m=await owner.from('shop_memberships').select('id').eq('shop_id',shop.shopId).eq('user_id',other.ownerId).single();expect(m.error).toBeNull();member=m.data!.id
  for(let i=0;i<3;i++)await recordLeadIntake(db,{shopId:shop.shopId,channel:'synthetic',provider:'synthetic',providerEventId:randomUUID(),receivedAt:'2026-10-02T18:00:00Z',evidenceRef:'private-reference',threadKey:null,payload:{display_name:'Fictional inquiry',message:'<script>untrusted text</script>'}})
  await recordLeadIntake(db,{shopId:other.shopId,channel:'synthetic',provider:'synthetic',providerEventId:randomUUID(),receivedAt:'2026-10-02T18:00:00Z',evidenceRef:null,threadKey:null,payload:{message:'Foreign shop'}})
 })
 afterAll(async()=>{if(shop)await cleanup(db,shop);if(other)await cleanup(db,other)})
 const setMember=(role:string,active:boolean,grants:string[])=>owner.rpc('team_set_member',{p_shop:shop.shopId,p_member:member,p_role:role,p_active:active,p_capabilities:grants})
 it('owner receives only their unresolved items, stable pages and no internal evidence IDs',async()=>{
  const r=await read(owner,{p_limit:2});expect(r.error).toBeNull();expect(r.data.total).toBe(3);expect(r.data.items).toHaveLength(2)
  expect(JSON.stringify(r.data)).not.toContain('private-reference');expect(JSON.stringify(r.data)).not.toContain('Foreign shop')
  const next=await read(owner,{p_offset:2,p_limit:2});expect(next.data.items).toHaveLength(1);expect(r.data.items.map((x:{id:string})=>x.id)).not.toContain(next.data.items[0].id)
 })
 it('anonymous, service-without-session and foreign owner reads are denied',async()=>{
  for(const c of [anonClient(),db])expect((await read(c)).error).not.toBeNull()
  expect((await read(owner,{p_shop:other.shopId})).error?.code).toBe('42501')
 })
 it('manager requires an explicit grant and revocation applies on the next read',async()=>{
  expect((await read(manager)).error?.code).toBe('42501')
  expect((await setMember('manager',true,['crm.read'])).error).toBeNull()
  expect((await read(manager)).data.total).toBe(3)
  expect((await setMember('manager',false,['crm.read'])).error).toBeNull()
  expect((await read(manager)).error?.code).toBe('42501')
 })
 it('staff cannot read unassigned intake and no client can directly mutate it',async()=>{
  expect((await setMember('staff',true,[])).error).toBeNull()
  expect((await read(manager)).error?.code).toBe('42501')
  for(const table of ['lead_workflows','lead_intake_envelopes','lead_workflow_transitions']){
   expect((await owner.from(table).select('id')).error?.code).toBe('42501')
   expect((await owner.from(table).delete().eq('shop_id',shop.shopId)).error?.code).toBe('42501')
  }
 })
 it('invalid limits fail rather than widening access',async()=>{
  for(const patch of [{p_limit:0},{p_limit:51},{p_offset:-1},{p_limit:null}])expect((await read(owner,patch)).error?.code).toBe('22023')
 })
 it('viewing does not resolve identity or create business/communication records',async()=>{
  await read(owner)
  for(const table of ['customers','leads','interactions','pending_actions','appointments'])expect((await db.from(table).select('id').eq('shop_id',shop.shopId)).data).toEqual([])
  expect((await db.from('lead_workflows').select('handoff_pending,state').eq('shop_id',shop.shopId)).data).toEqual(Array.from({length:3},()=>({handoff_pending:true,state:'identity_review'})))
 })
})
