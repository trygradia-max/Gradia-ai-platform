import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
const mocks = vi.hoisted(() => ({ execute: vi.fn(), user: vi.fn(), session: vi.fn(), service: vi.fn(), revalidate: vi.fn() }))
vi.mock("@/lib/shop", () => ({ requireUser: mocks.user }))
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.session }))
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: mocks.service }))
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }))
vi.mock("@/lib/twilio", () => ({ sendOutboundSms: vi.fn() }))
vi.mock("@/lib/aurinko", () => ({ sendEmailMessage: vi.fn(), getAccessTokenForShop: vi.fn(), createCalendarEvent: vi.fn() }))
import { approveDelegatedMessage, rejectDelegatedMessage } from "@/app/actions/delegated-approvals"
import * as approvals from "@/lib/approvals"
import { sendOutboundSms } from "@/lib/twilio"
import { sendEmailMessage } from "@/lib/aurinko"
import { teamCommandSchema } from "@/lib/team-permissions"

const id = "00000000-0000-4000-8000-000000000001", reviewHash = "a".repeat(64)
const input = { shopId: id, actionId: id, reviewHash }
const untouched = () => new Proxy({}, { get() { throw new Error("execution client used without a claim") } }) as SupabaseClient

describe("delegated message approval action", () => {
 const session = { marker: "session" }, service = { marker: "service" }
 beforeEach(() => {
  vi.clearAllMocks(); vi.restoreAllMocks()
  mocks.user.mockResolvedValue({ id: "manager" }); mocks.session.mockResolvedValue(session); mocks.service.mockReturnValue(service)
 })
 it("validates before any session, service client or executor work and rejects caller-supplied authority", async () => {
  const execute = vi.spyOn(approvals, "executeApproval")
  for (const patch of [{ actionId: "bad" }, { shopId: "bad" }, { reviewHash: "A".repeat(64) }, { reviewHash: "a".repeat(63) }, { reviewHash: null }, { actorId: id }, { context: "automatic" }, { category: "transactional" }, { service_proof: "forged" }])
   expect((await approveDelegatedMessage({ ...input, ...patch })).ok).toBe(false)
  expect(mocks.user).not.toHaveBeenCalled(); expect(mocks.session).not.toHaveBeenCalled(); expect(mocks.service).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled()
 })
 it("claims on the caller's session with the reviewed binding; the service client is only handed over for execution", async () => {
  const execute = vi.spyOn(approvals, "executeApproval").mockResolvedValue({ ok: true, status: "executed", actionType: "send_sms", resultId: id, proposal: {} as never, messageSid: "synthetic" })
  const result = await approveDelegatedMessage(input)
  expect(result.ok).toBe(true); expect(result.message).toContain("not a delivery receipt")
  expect(execute).toHaveBeenCalledExactlyOnceWith(session, id, id, { userId: "manager" }, { delegated: { expectedReview: reviewHash, executionClient: service } })
  expect(mocks.revalidate).toHaveBeenCalledWith("/team/approvals")
 })
 it("reports refusals and repeats honestly, and never retries an uncertain result", async () => {
  const execute = vi.spyOn(approvals, "executeApproval")
  execute.mockResolvedValueOnce({ ok: false, error: "Held: customer opted out." })
  expect(await approveDelegatedMessage(input)).toEqual({ ok: false, message: "Held: customer opted out." })
  execute.mockResolvedValueOnce({ ok: true, status: "already_decided" })
  expect((await approveDelegatedMessage(input)).message).toContain("Nothing new was sent")
  execute.mockRejectedValueOnce(new Error("private detail"))
  const uncertain = await approveDelegatedMessage(input)
  expect(uncertain.ok).toBe(false); expect(uncertain.message).toContain("Do not approve again"); expect(uncertain.message).not.toContain("private")
  expect(execute).toHaveBeenCalledTimes(3)
 })
 it("does nothing when execution access is not configured", async () => {
  const execute = vi.spyOn(approvals, "executeApproval"); mocks.service.mockImplementation(() => { throw new Error("missing key") })
  const result = await approveDelegatedMessage(input)
  expect(result).toEqual({ ok: false, message: "Delegated approval is not available right now. Nothing was approved or sent." })
  expect(execute).not.toHaveBeenCalled(); expect(mocks.session).not.toHaveBeenCalled()
 })
})

describe("executor delegated path", () => {
 beforeEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })
 const run = (rpc: ReturnType<typeof vi.fn>, executionClient = untouched()) =>
  approvals.executeApproval({ rpc, from: vi.fn(() => { throw new Error("session table access") }) } as unknown as SupabaseClient, "action", "shop", { userId: "manager" }, { delegated: { expectedReview: reviewHash, executionClient } })
 it.each([
  [{ data: null, error: { message: "private database detail" } }, "could not be verified"],
  [{ data: { denied: "actor_not_authorized" }, error: null }, "Only the current shop owner"],
  [{ data: { denied: "owner_approval_required" }, error: null }, "Only the shop owner can approve this kind"],
  [{ data: { denied: "review_changed" }, error: null }, "Refresh and review"],
  [{ data: { denied: "execution_not_permitted" }, error: null }, "policy does not permit"],
  [{ data: { id: "other", shop_id: "shop", action_type: "send_sms", payload: {} }, error: null }, "could not be verified"],
 ])("a refused or unverifiable claim never touches the execution client or a provider %#", async (result, text) => {
  const rpc = vi.fn().mockResolvedValue(result)
  const outcome = await run(rpc)
  expect(outcome).toMatchObject({ ok: false, error: expect.stringContaining(text) }); expect(JSON.stringify(outcome)).not.toContain("private database")
  expect(rpc).toHaveBeenCalledExactlyOnceWith("claim_delegated_message", { p_shop: "shop", p_action: "action", p_expected: reviewHash })
  expect(sendOutboundSms).not.toHaveBeenCalled(); expect(sendEmailMessage).not.toHaveBeenCalled()
 })
 it("releases, and never executes, a non-message action even if a claim returned one", async () => {
  const update = vi.fn(() => ({ eq: () => ({ eq: async () => ({ error: null }) }) }))
  const execution = { from: vi.fn(() => ({ update })), rpc: vi.fn() } as unknown as SupabaseClient
  const rpc = vi.fn().mockResolvedValue({ data: { id: "action", shop_id: "shop", action_type: "book_appointment", payload: {} }, error: null })
  expect(await run(rpc, execution)).toEqual({ ok: false, error: "Only the shop owner can approve this kind of action." })
  expect(update).toHaveBeenCalledExactlyOnceWith({ status: "pending", decided_at: null, decided_by_slack: null, decided_by_user: null })
  expect((execution.rpc as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
 })
 it("the owner path still uses the owner claim and ignores no delegated option", async () => {
  const rpc = vi.fn().mockResolvedValue({ data: { denied: "execution_not_permitted" }, error: null })
  await approvals.executeApproval({ rpc } as unknown as SupabaseClient, "action", "shop", { userId: "owner" })
  expect(rpc).toHaveBeenCalledExactlyOnceWith("claim_control_action", { p_shop: "shop", p_action: "action", p_actor: "owner", p_context: "hitl" })
 })
})

it("message approval is a manager-only grant that requires the customer view grant", () => {
 const member = { operation: "member", shopId: id, memberId: id, active: true }
 expect(teamCommandSchema.safeParse({ ...member, role: "manager", capabilities: ["crm.read", "approvals.messages"] }).success).toBe(true)
 expect(teamCommandSchema.safeParse({ ...member, role: "manager", capabilities: ["approvals.messages"] }).success).toBe(false)
 expect(teamCommandSchema.safeParse({ ...member, role: "staff", capabilities: ["crm.read", "approvals.messages"] }).success).toBe(false)
 expect(teamCommandSchema.safeParse({ ...member, role: "manager", capabilities: ["crm.read", "approvals.bookings"] }).success).toBe(false)
})

describe("delegated message rejection action", () => {
 const rpc = vi.fn()
 beforeEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); rpc.mockReset(); mocks.user.mockResolvedValue({ id: "manager" }); mocks.session.mockResolvedValue({ rpc }) })
 it("validates before any session work and never touches the service client, executor or a provider", async () => {
  const execute = vi.spyOn(approvals, "executeApproval")
  for (const patch of [{ actionId: "bad" }, { reviewHash: "z".repeat(64) }, { reviewHash: null }, { actorId: id }, { reason: "extra" }])
   expect((await rejectDelegatedMessage({ ...input, ...patch })).ok).toBe(false)
  expect(mocks.user).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled()
  rpc.mockResolvedValue({ data: { id, shop_id: id, action_type: "send_sms" }, error: null })
  const result = await rejectDelegatedMessage(input)
  expect(result.ok).toBe(true); expect(result.message).toContain("Nothing was sent")
  expect(rpc).toHaveBeenCalledExactlyOnceWith("reject_delegated_message", { p_shop: id, p_action: id, p_expected: reviewHash })
  expect(mocks.service).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); expect(sendOutboundSms).not.toHaveBeenCalled(); expect(sendEmailMessage).not.toHaveBeenCalled()
 })
 it.each([
  [{ data: { denied: "actor_not_authorized" }, error: null }, false, "not delegated"],
  [{ data: { denied: "owner_approval_required" }, error: null }, false, "Only the shop owner"],
  [{ data: { denied: "review_changed" }, error: null }, false, "Refresh and review"],
  [{ data: { denied: "delivery_review_required" }, error: null }, false, "delivery review"],
  [{ data: { already_decided: true }, error: null }, true, "already decided"],
  [{ data: { id: "other", shop_id: id }, error: null }, false, "not confirmed"],
  [{ data: null, error: { message: "private database detail" } }, false, "not confirmed"],
 ])("reports each outcome honestly without leaking internals %#", async (result, ok, text) => {
  rpc.mockResolvedValue(result)
  const outcome = await rejectDelegatedMessage(input)
  expect(outcome.ok).toBe(ok); expect(outcome.message).toContain(text); expect(outcome.message).not.toContain("private")
 })
 it("never retries an uncertain result", async () => {
  rpc.mockRejectedValue(new Error("private detail"))
  const outcome = await rejectDelegatedMessage(input)
  expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining("Result uncertain") }); expect(rpc).toHaveBeenCalledTimes(1)
 })
})
