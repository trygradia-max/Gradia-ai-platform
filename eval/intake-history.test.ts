import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadIntakeHistory, type IntakeHistory } from '@/lib/data/intake-history'
import { IntakeHistoryView } from '@/components/gradia/intake-history'
const id = '00000000-0000-4000-8000-000000000001'
const history: IntakeHistory = { workflow_id: id, state: 'identity_review', revision: 1, channel: 'meta', customer_id: null, total: 1, items: [{ revision: 1, reason: 'identity_unresolved', received_at: '2026-10-01T00:00:00Z', recorded_at: '2026-10-02T00:00:00Z', actor_id: null, reviewed_customer: null, payload: { message: '<script>untrusted</script>', leadgen_id: 'private-provider-id' } }] }
describe('intake history boundary and presentation', () => {
 it('uses a bounded session RPC anchored to a revision', async () => {
  const rpc = vi.fn().mockResolvedValue({data: history}), from = vi.fn()
  expect(await loadIntakeHistory({rpc,from} as unknown as SupabaseClient,id,id,20,1)).toEqual({ok:true,history})
  expect(rpc).toHaveBeenCalledWith('read_lead_intake_history',{p_shop:id,p_workflow:id,p_offset:20,p_limit:20,p_revision:1});expect(from).not.toHaveBeenCalled()
 })
 it('rejects invalid selectors and unanchored continuation before RPC', async () => {
  const rpc=vi.fn(),db={rpc} as unknown as SupabaseClient
  for(const [shop,workflow,offset,revision] of [['bad',id,0,null],[id,'bad',0,null],[id,id,-1,null],[id,id,20,null],[id,id,0,0],[id,id,0,NaN]] as const)expect((await loadIntakeHistory(db,shop,workflow,offset,revision)).ok).toBe(false)
  expect(rpc).not.toHaveBeenCalled()
 })
 it.each([{data:null,error:{code:'42501'}},{data:null},{data:{...history,workflow_id:'00000000-0000-4000-8000-000000000002'}},{data:{...history,revision:2}}])('fails closed on failed, malformed or mismatched replies %#',async reply=>{
  expect(await loadIntakeHistory({rpc:vi.fn().mockResolvedValue(reply)} as unknown as SupabaseClient,id,id,0,1)).toEqual({ok:false,changed:false})
 })
 it('distinguishes stale history and hides private errors',async()=>{
  const result=await loadIntakeHistory({rpc:vi.fn().mockResolvedValue({error:{code:'PT409',message:'private'}})} as unknown as SupabaseClient,id,id)
  expect(result).toEqual({ok:false,changed:true})
  const html=renderToStaticMarkup(createElement(IntakeHistoryView,{result}));expect(html).toContain('changed');expect(html).not.toContain('private');expect(html).not.toContain('No history entries')
 })
 it('fails closed on transport errors',async()=>{
  expect(await loadIntakeHistory({rpc:vi.fn().mockRejectedValue(Error('private'))} as unknown as SupabaseClient,id,id)).toEqual({ok:false,changed:false})
 })
 it('escapes evidence and hides provider identifiers while showing both times',()=>{
  const html=renderToStaticMarkup(createElement(IntakeHistoryView,{result:{ok:true,history}}))
  expect(html).toContain('&lt;script&gt;');expect(html).not.toContain('<script>');expect(html).not.toContain('private-provider-id');expect(html).toContain('Recorded');expect(html).toContain('Received');expect(html).toContain('contact details have not been retrieved')
 })
 it('keeps reviewed identity distinct from live records and warns on deleted customer',()=>{
  const html=renderToStaticMarkup(createElement(IntakeHistoryView,{result:{ok:true,history:{...history,state:'identity_linked',items:[{...history.items[0],reason:'identity_confirmed',payload:null,reviewed_customer:{id,name:'Fictional',phone:null,email:null}}]}}}))
  expect(html).toContain('no longer available');expect(html).toContain('Historical snapshot');expect(html).toContain('Account no longer available');expect(html).not.toContain('<form')
 })
})
