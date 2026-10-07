import { beforeEach,describe,expect,it,vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { ShopRow } from "@/lib/types/database"
const { stage }=vi.hoisted(()=>({stage:vi.fn()}))
vi.mock("@/lib/control-center/agent-capture",()=>({stageAgentCapture:stage,captureCommandId:()=>"00000000-0000-4000-8000-000000000903"}))
import { runOwnerTool } from "@/lib/owner-agent"
const db={from:vi.fn(),rpc:vi.fn()} as unknown as SupabaseClient
const context={supabase:db,shop:{id:"00000000-0000-4000-8000-000000000901",simulation_mode:false} as ShopRow,ownerId:"00000000-0000-4000-8000-000000000902"}
describe("real owner capture dispatch",()=>{
 beforeEach(()=>{vi.clearAllMocks();stage.mockResolvedValue({ok:true,pending_action_id:"capture",message:"Queued for review"})})
 it.each(["add_note","create_lead"])("%s uses staging with no direct domain access",async name=>{
  const r=await runOwnerTool(context,{type:"tool_use",id:"tool-id",name,input:{customer_name:"Fictional Person",phone:"+15555550123",note:"Fictional note"}})
  expect(r.isError).toBe(false);expect(JSON.parse(r.content).message).toBe("Queued for review");expect(stage).toHaveBeenCalledTimes(1)
  expect(db.from).not.toHaveBeenCalled();expect(db.rpc).not.toHaveBeenCalled()
 })
 it.each(["add_note","create_lead"])("Shadow Mode blocks %s before any queue or domain access",async name=>{
  const r=await runOwnerTool({...context,shop:{...context.shop,simulation_mode:true}},{type:"tool_use",id:"tool-id",name,input:{}})
  expect(JSON.parse(r.content)).toMatchObject({shadow_mode:true,staged:0});expect(stage).not.toHaveBeenCalled();expect(db.from).not.toHaveBeenCalled()
 })
 it("failed staging reports failure without a direct-write fallback",async()=>{
  stage.mockResolvedValue({ok:false,error:"Policy denied"})
  const r=await runOwnerTool(context,{type:"tool_use",id:"tool-id",name:"add_note",input:{customer_name:"Fictional",note:"Fictional note"}})
  expect(r.isError).toBe(true);expect(db.from).not.toHaveBeenCalled()
 })
})
