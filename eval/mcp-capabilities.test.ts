import { describe,it,expect,vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { MCP_CAPABILITIES,hasMcpCapability,mcpCapabilitiesSchema } from '@/lib/mcp/capabilities'
import { stageAgentCapture } from '@/lib/control-center/agent-capture'
import { readFileSync } from 'node:fs'
describe('explicit MCP capabilities',()=>{
 it('unknown, missing and empty grants never authorize',()=>{
  for(const value of [null,undefined,[],['*'],['recent_customers','unknown']])expect(hasMcpCapability(value,'recent_customers')).toBe(false)
  expect(hasMcpCapability(['recent_customers'],'recent_customers')).toBe(true)
  expect(hasMcpCapability(['recent_customers'],'propose_sms')).toBe(false)
  expect(mcpCapabilitiesSchema.safeParse(['recent_customers','recent_customers']).success).toBe(false)
 })
 it('application and SQL use the same grant vocabulary',()=>{
  const sql=readFileSync('supabase/migrations/20261002120000_mcp_capabilities.sql','utf8')
  const names=[...sql.split(']::text[]);')[0].matchAll(/'([a-z_]+)'/g)].map(m=>m[1])
  expect(names).toEqual([...MCP_CAPABILITIES])
 })
 it('all MCP proposals use durable staging without calendar preflight or direct inserts',()=>{
  const s=readFileSync('src/lib/mcp/server.ts','utf8')
  expect(s).not.toContain('.insert(');expect(s).not.toContain('stagingAvailability')
  expect(s.match(/await stageAgentCapture\(/g)).toHaveLength(6)
 })
 it('invalid message payload is rejected without RPC or provider access',async()=>{
  const rpc=vi.fn(),db={rpc} as unknown as SupabaseClient
  const id='00000000-0000-4000-8000-000000000001'
  const context={shopId:id,actorId:id,commandId:id,tokenId:id,source:'mcp' as const}
  const payload={customer_id:id,customer_name:null,to_phone:'+15555550111',body:'Fictional',reason:null,category:'marketing' as const}
  for(const patch of [{category:'transactional'},{customer_id:null},{to_phone:'5555550111'},{service_proof:'forged'}]){
   expect((await stageAgentCapture(db,context,{type:'send_sms',payload:{...payload,...patch}} as never)).ok).toBe(false)
  }
  expect(rpc).not.toHaveBeenCalled()
 })
})
