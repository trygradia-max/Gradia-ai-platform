import { describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { captureCommandId, stageAgentCapture, type CaptureCommand } from "@/lib/control-center/agent-capture"
import { readFileSync } from "node:fs"
const shopId="00000000-0000-4000-8000-000000000001", actorId="00000000-0000-4000-8000-000000000002"
const commandId=captureCommandId(shopId,"owner_agent","tool-1")
const context={shopId,actorId,commandId,source:"owner_agent" as const}
const note: CaptureCommand={type:"add_note",payload:{content:"Fictional note",customer_name:null,phone:null}}
describe("Agent capture boundary",()=>{
 it("uses one stable identity per shop, source and tool invocation",()=>{
  expect(captureCommandId(shopId,"owner_agent","tool-1")).toBe(commandId)
  for(const id of [captureCommandId(actorId,"owner_agent","tool-1"),captureCommandId(shopId,"mcp","tool-1"),captureCommandId(shopId,"owner_agent","tool-2")]) expect(id).not.toBe(commandId)
 })
 it("queues through the RPC only and never claims capture was saved",async()=>{
  const rpc=vi.fn().mockResolvedValue({data:commandId,error:null}),from=vi.fn()
  const result=await stageAgentCapture({rpc,from} as unknown as SupabaseClient,context,note)
  expect(result).toMatchObject({ok:true,pending_action_id:commandId})
  expect(rpc).toHaveBeenCalledWith("stage_agent_capture",expect.objectContaining({p_actor:actorId,p_command:commandId,p_source:"owner_agent",p_token:null}))
  expect(from).not.toHaveBeenCalled()
 })
 it.each([{data:null,error:null},{data:"wrong",error:null},{data:null,error:{message:"private database detail"}}])("fails closed on failed or malformed staging",async reply=>{
  const from=vi.fn(),db={rpc:vi.fn().mockResolvedValue(reply),from} as unknown as SupabaseClient
  const result=await stageAgentCapture(db,context,note)
  expect(result.ok).toBe(false);expect(JSON.stringify(result)).not.toContain("private database detail");expect(from).not.toHaveBeenCalled()
 })
 it("does not retry an uncertain database outcome",async()=>{
  const rpc=vi.fn().mockRejectedValue(Error("private"))
  expect((await stageAgentCapture({rpc} as unknown as SupabaseClient,context,note)).ok).toBe(false)
  expect(rpc).toHaveBeenCalledTimes(1)
 })
 it("requires MCP token identity and valid payload before any DB call",async()=>{
  const rpc=vi.fn(),db={rpc} as unknown as SupabaseClient
  expect((await stageAgentCapture(db,{...context,source:"mcp"},note)).ok).toBe(false)
  expect((await stageAgentCapture(db,context,{...note,payload:{...note.payload,content:" "}})).ok).toBe(false)
  expect(rpc).not.toHaveBeenCalled()
 })
 it("owner capture handlers and MCP lead proposals have no direct domain write fallback",()=>{
  const owner=readFileSync("src/lib/owner-agent.ts","utf8")
  const handlers=owner.slice(owner.indexOf('  if (block.name === "add_note")'),owner.indexOf('  if (block.name === "update_customer")'))
  expect(handlers.match(/stageAgentCapture\(/g)).toHaveLength(2)
  expect(handlers).not.toMatch(/\.from\(|recordInteraction\(|findOrCreateCustomer\(|upsertCustomerVehicle\(/)
  expect(owner).toContain('"propose_booking", "add_note", "create_lead"')
  const mcp=readFileSync("src/lib/mcp/server.ts","utf8").split('// ---------- find_customer_by_channel')[0]
  expect(mcp).toContain('commandId: args.command_id');expect(mcp).not.toContain('.insert(')
 })
})
