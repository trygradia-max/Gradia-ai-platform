import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
const mocks=vi.hoisted(()=>({ tools:new Map<string,(...args: unknown[])=>Promise<unknown>>(), resources:new Map<string,(...args: unknown[])=>Promise<unknown>>(), authorize:vi.fn(), memory:vi.fn(), knowledge:vi.fn(), lookup:vi.fn() }))
vi.mock('@modelcontextprotocol/sdk/server/mcp.js',()=>({McpServer:class {
 registerTool(name:string,_schema:unknown,handler:(...args:unknown[])=>Promise<unknown>){mocks.tools.set(name,handler)}
 registerResource(name:string,_uri:unknown,_schema:unknown,handler:(...args:unknown[])=>Promise<unknown>){mocks.resources.set(name,handler)}
 registerPrompt(){}
},ResourceTemplate:class {}}))
vi.mock('@/lib/mcp/read-authority',()=>({authorizeMcpRead:mocks.authorize,MCP_READ_DENIED:'Read denied'}))
vi.mock('@/lib/memory',()=>({searchCustomerMemory:mocks.memory,recentChannelActivity:mocks.memory}))
vi.mock('@/lib/knowledge',()=>({searchShopKnowledge:mocks.knowledge}))
vi.mock('@/lib/customers',()=>({findCustomerByChannel:mocks.lookup,normalizePhone:vi.fn()}))
import { buildMcpServer } from '@/lib/mcp/server'
const from=vi.fn(),rpc=vi.fn()
beforeEach(()=>{
 vi.clearAllMocks();mocks.authorize.mockResolvedValue(false)
 buildMcpServer({shopId:'shop',ownerId:'owner',shopName:'Fictional',tokenId:'token',supabase:{from,rpc} as unknown as SupabaseClient})
})
describe('MCP registered read boundaries',()=>{
 it.each(['find_customer_by_channel','search_customer_memory','search_shop_knowledge','recent_channel_activity','list_services'])('%s denies before data or embedding effects',async name=>{
  expect(await mocks.tools.get(name)!({})).toMatchObject({isError:true})
  expect(mocks.authorize).toHaveBeenCalledWith(expect.anything(),expect.anything(),name)
  for(const effect of [from,rpc,mocks.memory,mocks.knowledge,mocks.lookup])expect(effect).not.toHaveBeenCalled()
 })
 it.each(['shop_snapshot','recent_customers','active_leads','customer_detail','customer_timeline'])('%s denies before data reads',async name=>{
  await expect(mocks.resources.get(name)!(new URL('gradia://customers/recent'),{id:'foreign'})).rejects.toThrow('Read denied')
  expect(mocks.authorize).toHaveBeenCalledWith(expect.anything(),expect.anything(),name)
  expect(from).not.toHaveBeenCalled();expect(rpc).not.toHaveBeenCalled()
 })
 it('still dispatches an authorized tool and checks again on its next invocation',async()=>{
  mocks.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
  mocks.lookup.mockResolvedValue(null)
  const handler=mocks.tools.get('find_customer_by_channel')!
  expect(await handler({phone:null,email:null})).not.toMatchObject({isError:true})
  expect(await handler({phone:null,email:null})).toMatchObject({isError:true})
  expect(mocks.lookup).toHaveBeenCalledTimes(1)
 })
})

describe('MCP proposal dispatch',()=>{
 it.each(['propose_sms','propose_email','propose_booking'])('%s denies without any calendar, data or provider fallback',async name=>{
  const id='00000000-0000-4000-8000-000000000001'
  buildMcpServer({shopId:id,ownerId:id,shopName:'Fictional',tokenId:id,supabase:{from,rpc} as unknown as SupabaseClient})
  rpc.mockResolvedValue({data:null,error:{message:'private denial'}})
  const result=await mocks.tools.get(name)!({command_id:id,customer_id:id,customer_name:'Fictional',phone:'+15555550111',to_phone:'+15555550111',email:'fictional@example.test',to_email:'fictional@example.test',subject:'Synthetic',body:'Synthetic',reason:null,car_info:null,service:null,iso_start_time:'2027-01-01T18:00:00Z',duration_minutes:90,timezone:null,pin_notes:null,category:'transactional',source:'forged'})
  expect(result).toMatchObject({isError:true})
  expect(JSON.stringify(result)).not.toContain('private denial')
  expect(rpc).toHaveBeenCalledTimes(1)
  expect(rpc).toHaveBeenCalledWith('stage_agent_capture',expect.objectContaining({p_source:'mcp',p_token:id,p_command:id}))
  if(name!=='propose_booking')expect(rpc.mock.calls[0][1].p_payload.category).toBe('marketing')
  for(const effect of [from,mocks.memory,mocks.knowledge,mocks.lookup])expect(effect).not.toHaveBeenCalled()
 })
})
