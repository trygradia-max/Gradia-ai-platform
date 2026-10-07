import {beforeEach, expect, it, vi} from 'vitest'
import {renderToStaticMarkup} from 'react-dom/server'
import type {SupabaseClient} from '@supabase/supabase-js'
const mocks = vi.hoisted(() => ({rpc: vi.fn(), user: vi.fn(), client: vi.fn(), revalidate: vi.fn()}))
vi.mock('@/lib/shop', () => ({requireUser: mocks.user}))
vi.mock('@/lib/supabase/server', () => ({createClient: mocks.client}))
vi.mock('next/cache', () => ({revalidatePath: mocks.revalidate}))
vi.mock('@/components/gradia/delivery-reconciliation-form', () => ({DeliveryReconciliationForm: () => 'owner-review-form'}))
import {recordDeliveryReconciliation} from '@/app/actions/delivery-reconciliation'
import {DeliveryReconciliationHistory} from '@/components/gradia/delivery-reconciliation-history'
const id='00000000-0000-4000-8000-000000000001'
const input={shopId:id,actionId:id,commandId:id,revision:0,completedAt:null,outcome:'unknown',note:'Checked fictional provider evidence.'}
beforeEach(() => {vi.clearAllMocks();mocks.client.mockResolvedValue({rpc:mocks.rpc})})
it('validates before session/database work and rejects caller actor, send and proof authority',async()=>{
 for(const patch of [{actionId:'bad'},{revision:-1},{outcome:'retry'},{note:'short'},{note:'x'.repeat(2001)},{note:'hidden\u0000control'},{actorId:id},{resend:true},{service_proof:'forged'},{completedAt:'bad'}])
  expect((await recordDeliveryReconciliation({...input,...patch})).ok).toBe(false)
 expect(mocks.user).not.toHaveBeenCalled();expect(mocks.client).not.toHaveBeenCalled()
})
it('records exactly one session RPC; success explicitly leaves sending authority consumed',async()=>{
 mocks.rpc.mockResolvedValue({data:id,error:null})
 const result=await recordDeliveryReconciliation(input)
 expect(result.ok).toBe(true);expect(result.message).toContain('Nothing was sent')
 expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('record_delivery_reconciliation',{p_shop:id,p_action:id,p_command:id,p_revision:0,p_completed_at:null,p_outcome:'unknown',p_note:input.note})
 expect(mocks.revalidate).toHaveBeenCalledWith(`/approvals/${id}`)
})
it.each([{data:null,error:{message:'private'}},{data:'wrong',error:null}])('fails closed on database error or unexpected acknowledgement %#',async result=>{
 mocks.rpc.mockResolvedValue(result)
 const r=await recordDeliveryReconciliation(input);expect(r.ok).toBe(false);expect(r.message).not.toContain('private');expect(mocks.revalidate).not.toHaveBeenCalled()
})
it('never retries after uncertain database response',async()=>{
 mocks.rpc.mockRejectedValue(Error('private'))
 expect((await recordDeliveryReconciliation(input)).message).toContain('Result uncertain');expect(mocks.rpc).toHaveBeenCalledTimes(1)
})
it('hides the form when history is malformed or unavailable and validates pagination before lookup',async()=>{
 const db={rpc:vi.fn(async()=>({data:null,error:null}))} as unknown as SupabaseClient
 expect(renderToStaticMarkup(await DeliveryReconciliationHistory({db,shopId:id,actionId:id,page:'-1'}))).toContain('Invalid')
 expect(db.rpc).not.toHaveBeenCalled()
 const html=renderToStaticMarkup(await DeliveryReconciliationHistory({db,shopId:id,actionId:id}))
 expect(html).toContain('unavailable');expect(html).not.toContain('owner-review-form')
})
it('renders bounded escaped human reports, distinct from delivery receipts, with history paging',async()=>{
 const items=Array.from({length:21},(_,i)=>({command_id:id,revision:21-i,actor_id:id,actor_label:'Fictional Owner',outcome:'unknown',note:'<script>private evidence</script>',created_at:'2026-10-06T00:00:00Z',reviewed_completed_at:null}))
 const db={rpc:vi.fn(async()=>({data:{revision:21,completed_at:null,items},error:null}))} as unknown as SupabaseClient
 const html=renderToStaticMarkup(await DeliveryReconciliationHistory({db,shopId:id,actionId:id}))
 expect(html).toContain('&lt;script&gt;');expect(html).not.toContain('<script>');expect(html).toContain('Still uncertain');expect(html).toContain('reviewOffset=20');expect(html.match(/<li /g)).toHaveLength(20);expect(html).toContain('owner-review-form')
})
