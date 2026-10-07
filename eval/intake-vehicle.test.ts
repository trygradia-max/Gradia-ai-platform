import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { IntakeVehicleForm } from '@/components/gradia/intake-vehicle-form'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), user: vi.fn(), client: vi.fn(), revalidate: vi.fn() }))
vi.mock('@/lib/shop', () => ({ requireUser: mocks.user }))
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.client }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }))
import { linkIntakeVehicle } from '@/app/actions/intake-vehicle'
const id='00000000-0000-4000-8000-000000000001'
const input={shopId:id,workflowId:id,revision:2,commandId:id,customerId:id,customerUpdatedAt:'2026-10-04T00:00:00Z',confirmed:true,vehicle:{id,customer_id:id,year:2020,make:'Fictional',model:'Test',color:null,plate:null,updated_at:'2026-10-04T00:00:00Z'}}
beforeEach(()=>{vi.clearAllMocks();mocks.client.mockResolvedValue({rpc:mocks.rpc})})
describe('reviewed intake vehicle command',()=>{
 it('rejects unconfirmed, foreign-parent or incomplete input before database/session work',async()=>{
  for(const patch of [{confirmed:false},{commandId:'bad'},{revision:0},{vehicle:{id}},{customerId:'00000000-0000-4000-8000-000000000002'}])expect((await linkIntakeVehicle({...input,...patch})).ok).toBe(false)
  expect(mocks.client).not.toHaveBeenCalled();expect(mocks.user).not.toHaveBeenCalled()
 })
 it.each(['linked','already_recorded'])('accepts bound %s responses',async status=>{
  mocks.rpc.mockResolvedValue({data:{status,workflow_id:id},error:null});expect((await linkIntakeVehicle(input)).ok).toBe(true)
  expect(mocks.rpc).toHaveBeenCalledWith('link_intake_vehicle',{p_shop:id,p_workflow:id,p_revision:2,p_customer:id,p_customer_updated_at:input.customerUpdatedAt,p_vehicle:id,p_snapshot:input.vehicle,p_command:id})
  expect(mocks.revalidate).toHaveBeenCalledWith(`/intake/${id}`)
 })
 it.each([{data:null,error:{message:'private'}},{data:{status:'linked',workflow_id:'wrong'}},{data:{status:'unknown',workflow_id:id}}])('fails closed on invalid replies %#',async reply=>{
  mocks.rpc.mockResolvedValue(reply);const r=await linkIntakeVehicle(input);expect(r.ok).toBe(false);expect(r.message).not.toContain('private');expect(mocks.revalidate).not.toHaveBeenCalled()
 })
 it('does not automatically retry uncertain results',async()=>{
  mocks.rpc.mockRejectedValue(Error('private'));expect((await linkIntakeVehicle(input)).ok).toBe(false);expect(mocks.rpc).toHaveBeenCalledTimes(1)
 })
})

describe('vehicle confirmation presentation',()=>{
 it('leaves missing vehicles unresolved and confirmation disabled',()=>{
  const html=renderToStaticMarkup(createElement(IntakeVehicleForm,{shopId:id,workflowId:id,revision:2,commandId:id,customerId:id,customerUpdatedAt:input.customerUpdatedAt,vehicles:[]}))
  expect(html).toContain('No existing vehicles available');expect(html).toContain('Choose explicitly');expect(html).toContain('<button disabled=""');expect(mocks.rpc).not.toHaveBeenCalled()
 })
})
