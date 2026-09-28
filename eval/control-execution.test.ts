import { afterEach, describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { executeApproval } from "@/lib/approvals"
import { sendOutboundSms } from "@/lib/twilio"
import { sendEmailMessage, getAccessTokenForShop, createCalendarEvent } from "@/lib/aurinko"
vi.mock("@/lib/twilio", () => ({ sendOutboundSms: vi.fn() }))
vi.mock("@/lib/aurinko", () => ({ sendEmailMessage: vi.fn(), getAccessTokenForShop: vi.fn(), createCalendarEvent: vi.fn() }))
afterEach(() => vi.clearAllMocks())
describe("executor requires durable current policy authority before any effect", () => {
 it.each([
  { data: null, error: { message: "private database detail" } },
  { data: null, error: null },
  { data: { denied: "execution_not_permitted" }, error: null },
  { data: { denied: "human_approval_required" }, error: null },
  { data: { id: "other", shop_id: "shop", action_type: "send_sms", payload: {} }, error: null },
 ])("fails closed for invalid/unclaimable authority %#", async result => {
  const rpc = vi.fn().mockResolvedValue(result), from = vi.fn()
  const outcome = await executeApproval({ rpc, from } as unknown as SupabaseClient, "action", "shop", { userId: "actor" })
  expect(outcome.ok).toBe(false); expect(JSON.stringify(outcome)).not.toContain("private database")
  expect(rpc).toHaveBeenCalledExactlyOnceWith("claim_control_action", { p_shop: "shop", p_action: "action", p_actor: "actor", p_context: "hitl" })
  expect(from).not.toHaveBeenCalled()
  for (const mock of [sendOutboundSms, sendEmailMessage, getAccessTokenForShop, createCalendarEvent]) expect(mock).not.toHaveBeenCalled()
 })
 it("passes automatic intent explicitly without synthesizing human approval", async () => {
  const rpc = vi.fn().mockResolvedValue({ data: { denied: "explicit_activation_required" }, error: null })
  expect((await executeApproval({ rpc } as unknown as SupabaseClient, "action", "shop", { userId: "actor" }, { context: "automatic" })).ok).toBe(false)
  expect(rpc).toHaveBeenCalledWith("claim_control_action", expect.objectContaining({ p_context: "automatic" }))
 })
 it("a failed claim does not fall back to a legacy update", async () => {
  const rpc = vi.fn().mockRejectedValue(new Error("claim unavailable")), from = vi.fn()
  expect((await executeApproval({ rpc, from } as unknown as SupabaseClient, "action", "shop", {})).ok).toBe(false)
  expect(from).not.toHaveBeenCalled()
 })
})
