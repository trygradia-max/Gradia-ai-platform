import { beforeEach, describe, expect, it, vi } from "vitest"

import { booking, customerChange, detail, vehicle, CALL_ID, SHOP_ID } from "./_call-copilot-review-fixtures"

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(), getOptionalShop: vi.fn(), createClient: vi.fn(), revalidatePath: vi.fn(),
  executeApproval: vi.fn(), executeRejection: vi.fn(), rpc: vi.fn(),
}))
vi.mock("@/lib/shop", () => ({ requireUser: mocks.requireUser, getOptionalShop: mocks.getOptionalShop }))
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }))
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }))
vi.mock("@/lib/approvals", () => ({ executeApproval: mocks.executeApproval, executeRejection: mocks.executeRejection }))

import { approveCallProposal, approveSelectedCallProposals, dismissCallProposal } from "@/app/actions/call-copilot-review"

const USER = "99999999-9999-4999-8999-999999999999"
let state: ReturnType<typeof detail>

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset()
  state = detail({ proposals: [vehicle(2), customerChange(1), booking(4)] })
  mocks.requireUser.mockResolvedValue({ id: USER })
  mocks.getOptionalShop.mockResolvedValue({ id: SHOP_ID, name: "Test shop" })
  mocks.rpc.mockImplementation(async () => ({ data: state, error: null }))
  mocks.createClient.mockResolvedValue({ rpc: mocks.rpc })
  mocks.executeApproval.mockResolvedValue({ ok: true, status: "executed", actionType: "update_customer", resultId: "r", proposal: {} })
  mocks.executeRejection.mockResolvedValue({ ok: true, status: "claimed", actionType: "update_customer", proposal: {} })
})

const one = (over: Record<string, unknown> = {}) => ({ callId: CALL_ID, proposalId: state.proposals[0]!.id, reviewToken: state.proposals[0]!.review_token, ...over })

describe("server actions treat every call as an untrusted POST", () => {
  it("takes only references: a client-supplied shop, action id, payload or role is rejected, not ignored", async () => {
    for (const extra of [{ shopId: SHOP_ID }, { actionId: "x" }, { payload: {} }, { role: "owner" }, { userId: USER }]) {
      const r = await approveCallProposal(one(extra))
      expect(r.ok).toBe(false)
    }
    expect(mocks.executeApproval).not.toHaveBeenCalled()
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it("rejects malformed ids and tokens, empty, oversized and non-array bulk input", async () => {
    expect((await approveCallProposal({ callId: "nope", proposalId: "x", reviewToken: "y" })).ok).toBe(false)
    expect((await approveCallProposal(null)).ok).toBe(false)
    expect((await approveSelectedCallProposals({ callId: CALL_ID, items: [] })).ok).toBe(false)
    expect((await approveSelectedCallProposals({ callId: CALL_ID, items: "x" })).ok).toBe(false)
    const items = Array.from({ length: 11 }, (_, i) => ({ proposalId: `00000000-0000-4000-8000-0000000000${(10 + i).toString()}`, reviewToken: "a".repeat(64) }))
    expect((await approveSelectedCallProposals({ callId: CALL_ID, items })).ok).toBe(false)
    expect(mocks.executeApproval).not.toHaveBeenCalled()
  })

  it("derives the shop and the actor from the session and hands the stored action id (not a client value) to the existing executor", async () => {
    const r = await approveCallProposal(one())
    expect(r.ok).toBe(true)
    expect(mocks.rpc).toHaveBeenCalledWith("call_copilot_review_detail", { p_shop: SHOP_ID, p_call: CALL_ID, p_revision: null })
    expect(mocks.executeApproval).toHaveBeenCalledTimes(1)
    const [, actionId, shopId, decider] = mocks.executeApproval.mock.calls[0]!
    expect(actionId).toBe(state.proposals[0]!.action_id)
    expect(shopId).toBe(SHOP_ID)
    expect(decider).toEqual({ userId: USER })
  })

  it("a signed-in user without a shop of their own (for example a manager) can approve nothing", async () => {
    mocks.getOptionalShop.mockResolvedValue(null)
    const r = await approveCallProposal(one())
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/Only the shop owner/)
    expect(mocks.executeApproval).not.toHaveBeenCalled()
    expect(mocks.executeRejection).not.toHaveBeenCalled()
  })

  it("refuses for a non-owner role even with a valid token", async () => {
    state = detail({ viewer_role: "manager", can_approve: false, proposals: state.proposals })
    const r = await approveCallProposal(one())
    expect(r.ok).toBe(false)
    expect(mocks.executeApproval).not.toHaveBeenCalled()
  })

  it("a call that is not in the session's shop reads as not found and approves nothing", async () => {
    mocks.rpc.mockResolvedValue({ data: { found: false }, error: null })
    const r = await approveCallProposal(one())
    expect(r.ok).toBe(false)
    expect(mocks.executeApproval).not.toHaveBeenCalled()
  })

  it("approve-selected runs sequentially in dependency order and revalidates the affected pages", async () => {
    const items = state.proposals.map((p) => ({ proposalId: p.id, reviewToken: p.review_token }))
    // the fake database moves each approved proposal to 'approved' with a new token, like the real one
    mocks.executeApproval.mockImplementation(async (_c: unknown, actionId: string) => {
      state = { ...state, proposals: state.proposals.map((p) => (p.action_id === actionId ? { ...p, status: "approved" as const, executed: true, review_token: "c".repeat(64) } : p)) }
      return { ok: true, status: "executed", actionType: "update_customer", resultId: "r", proposal: {} }
    })
    // the booking depends on vehicle + customer, so it must run after them
    const r = await approveSelectedCallProposals({ callId: CALL_ID, items: [items[2]!, items[1]!, items[0]!] })
    expect(r.ok).toBe(true)
    const order = mocks.executeApproval.mock.calls.map((c) => state.proposals.find((p) => p.action_id === c[1])!.kind)
    expect(order).toEqual(["vehicle", "customer", "appointment_draft"])
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/calls/copilot/${CALL_ID}`)
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/approvals")
  })

  it("approve-selected stops at the first denial and does not attempt the rest", async () => {
    const items = state.proposals.map((p) => ({ proposalId: p.id, reviewToken: p.review_token }))
    mocks.executeApproval.mockResolvedValueOnce({ ok: false, error: "The call evidence changed since this proposal was made. Review the call again." })
    const r = await approveSelectedCallProposals({ callId: CALL_ID, items })
    expect(r.ok).toBe(false)
    expect(mocks.executeApproval).toHaveBeenCalledTimes(1)
    expect(r.notAttempted.length).toBe(2)
  })

  it("dismiss goes through the existing rejection path with session identity", async () => {
    const r = await dismissCallProposal(one())
    expect(r.ok).toBe(true)
    expect(mocks.executeRejection).toHaveBeenCalledWith(expect.anything(), state.proposals[0]!.action_id, SHOP_ID, { userId: USER })
    expect(mocks.executeApproval).not.toHaveBeenCalled()
  })

  it("returns a closed shape: no rows, ids of other tables or secrets", async () => {
    const r = await approveCallProposal(one())
    expect(Object.keys(r).sort()).toEqual(["after", "message", "notAttempted", "ok", "steps"])
    expect(JSON.stringify(r)).not.toMatch(/staged|payload|phone|snippet/)
  })
})
