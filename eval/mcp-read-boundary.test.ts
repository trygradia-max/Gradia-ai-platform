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
