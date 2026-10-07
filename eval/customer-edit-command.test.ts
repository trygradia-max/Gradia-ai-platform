import {describe,expect,it,vi} from 'vitest'
import type {SupabaseClient} from '@supabase/supabase-js'
import {prepareCustomerEdit} from '@/lib/control-center/customer-edit'
import {runOwnerTool} from '@/lib/owner-agent'
import type {ShopRow} from '@/lib/types/database'
const shop='00000000-0000-4000-8000-000000000501',id='00000000-0000-4000-8000-000000000502',owner='00000000-0000-4000-8000-000000000503'
const row={id,shop_id:shop,name:'Fictional',phone:'+15555550123',email:null,updated_at:'2026-10-01T12:00:00.000001+00:00'}
function fake(results:Record<string,unknown[]>) {
 const writes=vi.fn(()=>{throw Error('Unexpected write')}),queries:unknown[][]=[]
 const rpc=vi.fn().mockImplementation((_name:string,args:Record<string,unknown>)=>Promise.resolve({data:args.p_command,error:null}))
 const from=vi.fn((table:string)=>{
  const response=results[table]?.shift()??{data:[],error:null}
  const chain:unknown=new Proxy({}, {get:(_,key)=>key==='then'?(resolve:(r:unknown)=>unknown)=>Promise.resolve(response).then(resolve):['update','insert','delete','upsert'].includes(String(key))?writes:(...args:unknown[])=>{queries.push([table,key,...args]);return chain}})
  return chain
 })
 return {db:{from,rpc} as unknown as SupabaseClient,writes,queries,rpc}
}
describe('reviewed customer edit preparation',()=>{
 it('normalizes exact destinations and binds the reviewed customer snapshot without writing',async()=>{
  const m=fake({customers:[{data:row,error:null}]})
  const r=await prepareCustomerEdit(m.db,shop,id,{email:' NEW@EXAMPLE.TEST ',phone:'+1 (555) 555-0100'})
  expect(r).toMatchObject({ok:true,command:{type:'update_customer',payload:{customer_id:id,before:{name:row.name,phone:row.phone,email:null},expected_updated_at:row.updated_at,changes:{email:'new@example.test',phone:'+15555550100'},vehicle:null}}})
  expect(m.queries).toContainEqual(['customers','eq','shop_id',shop]);expect(m.writes).not.toHaveBeenCalled()
 })
 it.each([{data:null,error:{message:'private'}},{data:{...row,shop_id:owner},error:null},{data:{...row,id:owner},error:null}])('refuses lookup failure or foreign identity',async response=>{
  const m=fake({customers:[response]});expect((await prepareCustomerEdit(m.db,shop,id,{email:'new@example.test'})).ok).toBe(false);expect(m.writes).not.toHaveBeenCalled()
 })
 it('does not guess a country code',async()=>{
  const m=fake({customers:[{data:row,error:null}]});expect((await prepareCustomerEdit(m.db,shop,id,{phone:'5555550100'})).ok).toBe(false)
 })
 it('binds every vehicle field and refuses ambiguous or foreign vehicles',async()=>{
  const vehicle={id:owner,shop_id:shop,customer_id:id,updated_at:row.updated_at,make:'Fictional',model:'Sedan',year:2022,color:'Blue'}
  const m=fake({customers:[{data:row,error:null}],vehicles:[{data:[vehicle],error:null}]})
  expect(await prepareCustomerEdit(m.db,shop,id,{vehicle_color:'Silver'})).toMatchObject({ok:true,command:{payload:{vehicle:{id:owner,before:{make:'Fictional',model:'Sedan',year:2022,color:'Blue'},changes:{color:'Silver'}}}}})
  for(const rows of [[vehicle,vehicle],[{...vehicle,customer_id:owner}]]) {
   const bad=fake({customers:[{data:row,error:null}],vehicles:[{data:rows,error:null}]});expect((await prepareCustomerEdit(bad.db,shop,id,{vehicle_color:'Silver'})).ok).toBe(false)
  }
 })
 it('refuses empty edits and a new vehicle without its make',async()=>{
  for(const fields of [{},{vehicle_color:'Silver'}]){
   const m=fake({customers:[{data:row,error:null}],vehicles:[{data:[],error:null}]});expect((await prepareCustomerEdit(m.db,shop,id,fields)).ok).toBe(false)
  }
 })
})
describe('lead-only identity handling',()=>{
 const context=(db:SupabaseClient)=>({supabase:db,shop:{id:shop,simulation_mode:false} as ShopRow,ownerId:owner})
 it('does not collapse different international numbers sharing the same last ten digits',async()=>{
  const m=fake({customers:[{data:[],error:null}],leads:[{data:[{id:'a',customer_name:'Fictional One',phone:'+15555550123',car_info:null},{id:'b',customer_name:'Fictional Two',phone:'+4455555550123',car_info:null}],error:null}]})
  const r=await runOwnerTool(context(m.db),{type:'tool_use',id:'tool1',name:'update_customer',input:{customer_query:'Fictional',email:'new@example.test'}})
  expect(JSON.parse(r.content).candidates).toHaveLength(2);expect(m.rpc).not.toHaveBeenCalled();expect(m.writes).not.toHaveBeenCalled()
 })
 it('queues identity resolution instead of materializing a customer during lookup',async()=>{
  const m=fake({customers:[{data:[],error:null}],leads:[{data:[{id:'lead',customer_name:'Fictional',phone:'+15555550123',car_info:null}],error:null}]})
  const r=await runOwnerTool(context(m.db),{type:'tool_use',id:'tool1',name:'update_customer',input:{customer_query:'Fictional',email:'new@example.test'}})
  expect(r.isError).toBe(false);expect(m.rpc).toHaveBeenCalledWith('stage_agent_capture',expect.objectContaining({p_type:'resolve_customer'}));expect(m.writes).not.toHaveBeenCalled();expect(JSON.parse(r.content).message).toContain('requested action was not performed')
 })
 it('lookup errors never become permission to create or resolve an identity',async()=>{
  const m=fake({customers:[{data:null,error:{message:'private failure'}}]})
  await expect(runOwnerTool(context(m.db),{type:'tool_use',id:'tool1',name:'update_customer',input:{customer_query:'Fictional',email:'new@example.test'}})).rejects.toThrow('could not be verified')
  expect(m.rpc).not.toHaveBeenCalled();expect(m.writes).not.toHaveBeenCalled()
 })
})
