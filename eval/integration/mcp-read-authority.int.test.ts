import { MCP_CAPABILITIES } from "@/lib/mcp/capabilities"
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { INTEGRATION_WITH_SESSION, serviceClient, ownerSessionClient, seedShop, cleanup, type Seeded } from './_db'
import { initialPolicyDraft } from '@/lib/control-center/drafts'
import { authorizeMcpRead } from '@/lib/mcp/read-authority'

describe.skipIf(!INTEGRATION_WITH_SESSION)('MCP current read authority',()=>{
 let db:SupabaseClient,owner:SupabaseClient,shop:Seeded,foreign:Seeded,tokenId:string
 let active:number|null=null
 const context=()=>({shopId:shop.shopId,ownerId:shop.ownerId,tokenId})
 beforeAll(async()=>{
  db=serviceClient();shop=await seedShop(db,{password:'Synthetic-Mcp-Read-Only-1002!'})
  foreign=await seedShop(db)
  owner=await ownerSessionClient(shop.email,'Synthetic-Mcp-Read-Only-1002!')
  const token=await db.from('mcp_tokens').insert({shop_id:shop.shopId,name:'Fictional read test',capabilities:[...MCP_CAPABILITIES],token_hash:randomUUID()}).select('id').single()
  expect(token.error).toBeNull();tokenId=token.data!.id
 })
 afterAll(async()=>{if(shop)await cleanup(db,shop);if(foreign)await cleanup(db,foreign)})
 async function save(definition:ReturnType<typeof initialPolicyDraft>){
  const draft=await owner.from('control_policy_drafts').select('revision').eq('shop_id',shop.shopId).single();expect(draft.error).toBeNull()
  const result=await owner.rpc('save_control_policy_draft',{p_shop:shop.shopId,p_expected_revision:draft.data!.revision,p_definition:definition});expect(result.error).toBeNull();return result.data
 }
 async function activate(revision:number){
  const result=await owner.rpc('activate_control_policy',{p_shop:shop.shopId,p_revision:revision,p_expected_active:active});expect(result.error).toBeNull();active=result.data
 }
 it('permits the baseline and rejects a token used for a different shop or owner',async()=>{
  expect(await authorizeMcpRead(db,context(),'recent_customers')).toBe(true)
  expect(await authorizeMcpRead(db,{...context(),shopId:foreign.shopId,ownerId:foreign.ownerId},'recent_customers')).toBe(false)
  expect(await authorizeMcpRead(db,{...context(),ownerId:foreign.ownerId},'recent_customers')).toBe(false)
 })
 it('a saved Off draft does not take effect until activated',async()=>{
  const revision=await save({...initialPolicyDraft(),actionGrants:{'crm.read':'off'}})
  expect(await authorizeMcpRead(db,context(),'recent_customers')).toBe(true)
  await activate(revision)
  expect(await authorizeMcpRead(db,context(),'recent_customers')).toBe(false)
  expect(await authorizeMcpRead(db,context(),'list_services')).toBe(true)
 })
 it('rechecks policy and memory/calendar ceilings on each invocation',async()=>{
  await activate(await save({...initialPolicyDraft(),connectorCeilings:{memory:'off',calendar:'off'}}))
  expect(await authorizeMcpRead(db,context(),'recent_customers')).toBe(true)
  for(const name of ['search_customer_memory','search_shop_knowledge','shop_snapshot'])expect(await authorizeMcpRead(db,context(),name)).toBe(false)
  await activate(await save(initialPolicyDraft()))
  expect(await authorizeMcpRead(db,context(),'search_customer_memory')).toBe(true)
 })
 it('token revocation blocks the next read even with a previously constructed context',async()=>{
  const cached=context()
  expect(await authorizeMcpRead(db,cached,'customer_timeline')).toBe(true)
  expect((await db.from('mcp_tokens').update({revoked_at:new Date().toISOString()}).eq('id',tokenId).eq('shop_id',shop.shopId)).error).toBeNull()
  expect(await authorizeMcpRead(db,cached,'customer_timeline')).toBe(false)
 })
})
