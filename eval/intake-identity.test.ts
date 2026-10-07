import {beforeEach,describe,it,expect,vi} from 'vitest'
const mocks=vi.hoisted(()=>({rpc:vi.fn(),user:vi.fn(),client:vi.fn(),revalidate:vi.fn()}))
vi.mock('@/lib/shop',()=>({requireUser:mocks.user}))
vi.mock('@/lib/supabase/server',()=>({createClient:mocks.client}))
vi.mock('next/cache',()=>({revalidatePath:mocks.revalidate}))
import { linkIntakeIdentity } from '@/app/actions/intake-identity'
const id='00000000-0000-4000-8000-000000000001'
const input={shopId:id,workflowId:id,revision:1,commandId:id,confirmed:true,customer:{id,name:'Fictional',phone:null,email:null,updated_at:'2026-10-02T18:00:00+00:00'}}
beforeEach(()=>{vi.clearAllMocks();mocks.client.mockResolvedValue({rpc:mocks.rpc})})
describe('owner intake identity command',()=>{
 it('requires explicit confirmation and complete snapshot before session/database work',async()=>{
  for(const patch of [{confirmed:false},{commandId:'bad'},{revision:0},{customer:{id}}])expect((await linkIntakeIdentity({...input,...patch})).ok).toBe(false)
  expect(mocks.client).not.toHaveBeenCalled();expect(mocks.user).not.toHaveBeenCalled()
 })
 it.each(['linked','already_recorded'])('accepts only verified %s replies and uses the session RPC',async status=>{
  mocks.rpc.mockResolvedValue({data:{status,workflow_id:id},error:null})
  expect((await linkIntakeIdentity(input)).ok).toBe(true)
  expect(mocks.rpc).toHaveBeenCalledWith('link_intake_customer',{p_shop:id,p_workflow:id,p_revision:1,p_customer:id,p_snapshot:input.customer,p_command:id})
  expect(mocks.revalidate).toHaveBeenCalledWith('/intake')
 })
 it.each([{data:null,error:{message:'private SQL detail'}},{data:{status:'linked',workflow_id:'wrong'},error:null}])('fails closed on invalid replies %#',async reply=>{
  mocks.rpc.mockResolvedValue(reply);const result=await linkIntakeIdentity(input);expect(result.ok).toBe(false);expect(JSON.stringify(result)).not.toContain('private SQL detail');expect(mocks.revalidate).not.toHaveBeenCalled()
 })
 it('does not retry an uncertain result',async()=>{
  mocks.rpc.mockRejectedValue(Error('private'));expect((await linkIntakeIdentity(input)).ok).toBe(false);expect(mocks.rpc).toHaveBeenCalledTimes(1)
 })
})
