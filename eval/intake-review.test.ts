import { describe,it,expect,vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadIntakeReview } from '@/lib/data/intake-review'
const id='00000000-0000-4000-8000-000000000001'
describe('intake review data boundary',()=>{
 it('passes only the shop and bounded page to the session RPC',async()=>{
  const rpc=vi.fn().mockResolvedValue({data:{total:0,items:[]},error:null}),from=vi.fn()
  expect(await loadIntakeReview({rpc,from} as unknown as SupabaseClient,id,20)).toEqual({ok:true,queue:{total:0,items:[]}})
  expect(rpc).toHaveBeenCalledWith('list_lead_intake_review',{p_shop:id,p_offset:20,p_limit:20});expect(from).not.toHaveBeenCalled()
 })
 it.each([{data:null,error:{message:'private'}},{data:null,error:null},{data:{total:0,items:[{}]},error:null},{data:{total:-1,items:[]},error:null}])('never presents failed or malformed reads as an empty queue %#',async reply=>{
  expect(await loadIntakeReview({rpc:vi.fn().mockResolvedValue(reply)} as unknown as SupabaseClient,id)).toEqual({ok:false})
 })
 it('fails closed on transport failure',async()=>{
  expect(await loadIntakeReview({rpc:vi.fn().mockRejectedValue(Error('private'))} as unknown as SupabaseClient,id)).toEqual({ok:false})
 })
 it('rejects invalid selectors and unbounded pages before accessing the database',async()=>{
  const rpc=vi.fn(),db={rpc} as unknown as SupabaseClient
  for(const [shop,offset,limit] of [['bad',0,20],[id,-1,20],[id,0,51],[id,0,0],[id,1.2,20]] as const)expect(await loadIntakeReview(db,shop,offset,limit)).toEqual({ok:false})
  expect(rpc).not.toHaveBeenCalled()
 })
})
