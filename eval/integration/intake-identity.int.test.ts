import {randomUUID} from 'node:crypto'
import {beforeAll,afterAll,describe,it,expect} from 'vitest'
import type {SupabaseClient} from '@supabase/supabase-js'
import {INTEGRATION_WITH_SESSION,serviceClient,ownerSessionClient,anonClient,seedShop,cleanup,type Seeded} from './_db'
import {recordLeadIntake,type LeadIntakeInput} from '@/lib/lead-intake'
describe.skipIf(!INTEGRATION_WITH_SESSION)('reviewed intake identity linking',()=>{
 let db:SupabaseClient,owner:SupabaseClient,manager:SupabaseClient,shop:Seeded,foreign:Seeded,customer:Record<string,unknown>,foreignId:string
 const input=(patch:Partial<LeadIntakeInput>={}):LeadIntakeInput=>({shopId:shop.shopId,provider:'synthetic',providerEventId:randomUUID(),channel:'synthetic',threadKey:null,evidenceRef:null,receivedAt:'2026-10-02T18:00:00Z',payload:{phone:'+15555550111',message:'Fictional inquiry'},...patch})
 async function create(patch:Partial<LeadIntakeInput>={}){const i=input(patch);return {i,w:await recordLeadIntake(db,i)}}
 const args=(workflow:string,revision=1,patch:Record<string,unknown>={})=>({p_shop:shop.shopId,p_workflow:workflow,p_revision:revision,p_customer:customer.id,p_snapshot:customer,p_command:randomUUID(),...patch})
 const link=(a:Record<string,unknown>)=>owner.rpc('link_intake_customer',a)
 beforeAll(async()=>{
  db=serviceClient();shop=await seedShop(db,{password:'Synthetic-Identity-1002!'});foreign=await seedShop(db,{password:'Synthetic-Identity-1002!'})
  owner=await ownerSessionClient(shop.email,'Synthetic-Identity-1002!');manager=await ownerSessionClient(foreign.email,'Synthetic-Identity-1002!')
  for(const s of [shop,foreign]){const r=await db.from('customers').insert({shop_id:s.shopId,name:'Fictional selected customer',phone:'+15555550111',email:'fictional@example.test'}).select('id').single();expect(r.error).toBeNull();if(s===foreign)foreignId=r.data!.id}
  const search=await owner.rpc('search_intake_customers',{p_shop:shop.shopId,p_query:'selected'});expect(search.error).toBeNull();customer=search.data[0]
  const invite=await owner.rpc('team_invite',{p_shop:shop.shopId,p_email:foreign.email,p_name:'Fictional manager',p_role:'manager',p_capabilities:['crm.read']});expect(invite.error).toBeNull()
  expect((await manager.rpc('team_accept_invite',{p_token:invite.data.token})).error).toBeNull()
 })
 afterAll(async()=>{if(shop)await cleanup(db,shop);if(foreign)await cleanup(db,foreign)})
 it('links and audits once across concurrent exact retries, without customer or consent mutation',async()=>{
  const {w}=await create(),a=args(w.workflowId),before=await db.from('customers').select('*').eq('id',customer.id).single()
  const results=await Promise.all([link(a),link(a)])
  expect(results.map(r=>r.data?.status).sort()).toEqual(['already_recorded','linked'])
  for(const r of results)expect(r.error).toBeNull()
  const workflow=await db.from('lead_workflows').select('state,customer_id,revision,handoff_pending').eq('id',w.workflowId).single();expect(workflow.data).toEqual({state:'identity_linked',customer_id:customer.id,revision:2,handoff_pending:false})
  const audit=await db.from('lead_workflow_transitions').select('actor_id,reason,decision').eq('command_id',a.p_command);expect(audit.data).toHaveLength(1);expect(audit.data![0]).toMatchObject({actor_id:shop.ownerId,reason:'identity_confirmed',decision:{customer_id:customer.id,reviewed_revision:1}})
  expect((await db.from('customers').select('*').eq('id',customer.id).single()).data).toEqual(before.data)
  for(const table of ['customer_channel_permissions','interactions','leads','appointments','pending_actions'])expect((await db.from(table).select('id').eq('shop_id',shop.shopId)).data).toEqual([])
 })
 it('competing distinct commands have exactly one winner',async()=>{
  const {w}=await create(),results=await Promise.all([link(args(w.workflowId)),link(args(w.workflowId))]);expect(results.filter(r=>!r.error)).toHaveLength(1);expect(results.find(r=>r.error)?.error?.code).toBe('PT409')
 })
 it('rejects forged snapshots, foreign customer/shop and unauthorized callers',async()=>{
  const {w}=await create()
  expect((await link(args(w.workflowId,1,{p_snapshot:{...customer,name:'Forged'}}))).error?.code).toBe('PT409')
  expect((await link(args(w.workflowId,1,{p_customer:foreignId}))).error?.code).toBe('42501')
  expect((await link(args(w.workflowId,1,{p_shop:foreign.shopId}))).error?.code).toBe('42501')
  for(const caller of [manager,anonClient(),db])expect((await caller.rpc('link_intake_customer',args(w.workflowId))).error).not.toBeNull()
 })
 it('new evidence invalidates old review; duplicate delivery does not reopen linked identity',async()=>{
  const thread=randomUUID(),{i,w}=await create({threadKey:thread})
  expect((await link(args(w.workflowId))).error).toBeNull()
  const replay=await recordLeadIntake(db,i);expect(replay.state).toBe('identity_linked');expect(replay.revision).toBe(2)
  const next=await recordLeadIntake(db,input({threadKey:thread,receivedAt:'2026-10-01T18:00:00Z'}));expect(next.state).toBe('identity_review');expect(next.revision).toBe(3)
  expect((await link(args(w.workflowId))).error?.code).toBe('PT409')
  expect((await link(args(w.workflowId,3))).error).toBeNull()
 })
 it('command replay with different content cannot change a previous decision',async()=>{
  const {w}=await create(),a=args(w.workflowId);expect((await link(a)).error).toBeNull()
  expect((await link({...a,p_snapshot:{...customer,name:'Different'}})).error?.code).toBe('PT409')
 })
 it('late injected failure rolls back link, revision and human audit',async()=>{
  const {w}=await create({threadKey:'INTAKE_INJECT_LINK_FAILURE'}),a=args(w.workflowId)
  const before=await db.from('lead_workflows').select('*').eq('id',w.workflowId).single()
  expect((await link(a)).error?.message).toContain('Injected intake link failure')
  expect((await db.from('lead_workflows').select('*').eq('id',w.workflowId).single()).data).toEqual(before.data)
  expect((await db.from('lead_workflow_transitions').select('id').eq('command_id',a.p_command)).data).toEqual([])
 })
 it('customer search is owner-only and cannot leak another shop',async()=>{
  expect((await manager.rpc('search_intake_customers',{p_shop:shop.shopId,p_query:''})).error?.code).toBe('42501')
  const result=await owner.rpc('search_intake_customers',{p_shop:shop.shopId,p_query:'selected'});expect(result.data.map((c:{id:string})=>c.id)).toEqual([customer.id])
  expect((await owner.rpc('search_intake_customers',{p_shop:shop.shopId,p_query:"%');select * from customers;--"})).data).toEqual([])
 })
 it.each([false,true])('customer merge preserves linked workflows atomically; injected failure=%s',async fail=>{
  const winner=await db.from('customers').insert({shop_id:shop.shopId,name:fail?'P0_INJECT_MERGE_FAILURE':'Fictional winner'}).select('id').single()
  const loser=await db.from('customers').insert({shop_id:shop.shopId,name:'Fictional losing customer'}).select('id,name,phone,email,updated_at').single()
  expect(winner.error).toBeNull();expect(loser.error).toBeNull()
  const {w}=await create(),a=args(w.workflowId,1,{p_customer:loser.data!.id,p_snapshot:loser.data})
  expect((await link(a)).error).toBeNull()
  const result=await owner.rpc('merge_customers_atomic',{p_shop:shop.shopId,p_winner:winner.data!.id,p_loser:loser.data!.id})
  if(fail)expect(result.error?.message).toContain('Injected mid-merge failure');else expect(result.error).toBeNull()
  expect((await db.from('lead_workflows').select('customer_id,state').eq('id',w.workflowId).single()).data).toEqual({customer_id:fail?loser.data!.id:winner.data!.id,state:'identity_linked'})
  const history=await db.from('lead_workflow_transitions').select('decision').eq('command_id',a.p_command).single()
  expect(history.data!.decision.customer_id).toBe(loser.data!.id) // immutable reviewed history
 })

})
