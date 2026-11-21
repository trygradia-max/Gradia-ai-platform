import { describe, expect, it, vi } from "vitest"

import type { ReviewDetail, ReviewProposal } from "@/lib/call-copilot/review-dto"
import type { ReadOutcome } from "@/lib/call-copilot/review-read"
import { approveSelected, dismissProposal, type DecideDeps } from "@/lib/call-review/decide"
import { booking, customerChange, detail, message, quote, reviewOnly, vehicle } from "./_call-copilot-review-fixtures"

const item = (p: ReviewProposal) => ({ proposalId: p.id, reviewToken: p.review_token })

/** A fake store that behaves like the database: approving marks the action approved and changes its token. */
function world(initial: ReviewProposal[], over: Partial<Extract<ReviewDetail, { found: true }>> = {}) {
  const state = new Map(initial.map((p) => [p.id, { ...p }]))
  const calls: string[] = []
  const snapshot = (): ReadOutcome<Extract<ReviewDetail, { found: true }>> => ({ status: "ok", value: detail({ proposals: [...state.values()], ...over }) })
  const deps: DecideDeps = {
    readDetail: vi.fn(async () => snapshot()),
    approve: vi.fn(async (actionId: string) => {
      const p = [...state.values()].find((x) => x.action_id === actionId)!
      calls.push(`approve:${p.kind}`)
      if (p.status !== "pending") return { ok: true as const, status: "already_decided" as const }
      state.set(p.id, { ...p, status: "approved", executed: true, review_token: `${p.review_token.slice(0, 63)}f` })
      return { ok: true as const, status: "executed" as const, actionType: "resolve_customer" as never, resultId: "r", proposal: {} } as never
    }),
    dismiss: vi.fn(async (actionId: string) => {
      const p = [...state.values()].find((x) => x.action_id === actionId)!
      calls.push(`dismiss:${p.kind}`)
      if (p.status !== "pending") return { ok: true as const, status: "already_decided" as const }
      state.set(p.id, { ...p, status: "rejected", review_token: `${p.review_token.slice(0, 63)}e` })
      return { ok: true as const, status: "claimed" as const, actionType: "resolve_customer" as never, proposal: {} } as never
    }),
  }
  return { deps, state, calls }
}

describe("approve one", () => {
  it("runs the existing approval path once and reports the answer plus a fresh read, not a guess", async () => {
    const v = vehicle(2)
    const w = world([v])
    const r = await approveSelected(w.deps, [item(v)])
    expect(w.deps.approve).toHaveBeenCalledTimes(1)
    expect(w.deps.approve).toHaveBeenCalledWith(v.action_id)
    expect(r.ok).toBe(true)
    expect(r.steps).toEqual([{ proposalId: v.id, result: "approved", message: "Vehicle saved." }])
    expect(r.after).toEqual([{ proposalId: v.id, status: "approved", executed: true, freshness: null }])
  })

  it("does not claim the effect the executor did not confirm: a denial is reported as a denial", async () => {
    const v = vehicle(2)
    const w = world([v])
    ;(w.deps.approve as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, error: "Consent for this call no longer permits using it. Nothing was changed." })
    const r = await approveSelected(w.deps, [item(v)])
    expect(r.ok).toBe(false)
    expect(r.steps[0]).toMatchObject({ result: "denied", message: expect.stringContaining("Consent for this call") })
    expect(r.after?.[0]?.status).toBe("pending")
  })

  it("treats an unverifiable executor answer as unconfirmed, never as success", async () => {
    const v = vehicle(2)
    const w = world([v])
    ;(w.deps.approve as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, error: "Execution status could not be verified. Review action history before retrying." })
    expect((await approveSelected(w.deps, [item(v)])).steps[0]).toMatchObject({ result: "unconfirmed" })
    ;(w.deps.approve as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"))
    const r = await approveSelected(w.deps, [item(v)])
    expect(r.steps[0]).toMatchObject({ result: "unconfirmed" })
    expect(r.ok).toBe(false)
  })

  it("replays are idempotent: the second approve runs nothing new", async () => {
    const v = vehicle(2)
    const w = world([v])
    const first = await approveSelected(w.deps, [item(v)])
    expect(first.ok).toBe(true)
    // a stale tab replays with the OLD token: refused on the token before the executor is asked
    const replay = await approveSelected(w.deps, [item(v)])
    expect(replay.ok).toBe(false)
    expect(replay.steps[0]).toMatchObject({ result: "refused", code: "changed" })
    expect(w.calls).toEqual(["approve:vehicle"])
  })

  it("an executor that reports already_decided (two tabs, double click) is a calm no-op", async () => {
    const v = vehicle(2)
    const w = world([v])
    ;(w.deps.approve as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, status: "already_decided" })
    const r = await approveSelected(w.deps, [item(v)])
    expect(r.ok).toBe(true)
    expect(r.steps[0]).toMatchObject({ result: "already_decided", message: expect.stringContaining("Nothing new ran") })
  })

  it("refuses before the executor is asked when what the reviewer saw has changed", async () => {
    const v = vehicle(2)
    const w = world([v])
    const r = await approveSelected(w.deps, [{ proposalId: v.id, reviewToken: "9".repeat(64) }])
    expect(r.steps[0]).toMatchObject({ result: "refused", code: "changed" })
    expect(w.deps.approve).not.toHaveBeenCalled()
  })

  it.each([
    ["stale consent/evidence", vehicle(2, { freshness: "call_consent_unavailable" })],
    ["a review-only proposal", reviewOnly()],
    ["an already approved proposal", vehicle(2, { status: "approved" })],
    ["a proposal that needs a change", vehicle(2, { status: "edit_requested" })],
  ])("never approves %s", async (_n, p) => {
    const w = world([p])
    const r = await approveSelected(w.deps, [item(p)])
    expect(r.ok).toBe(false)
    expect(w.deps.approve).not.toHaveBeenCalled()
  })

  it("a manager can never approve, even with a valid token", async () => {
    const v = vehicle(2)
    const w = world([v], { viewer_role: "manager", can_approve: false })
    const r = await approveSelected(w.deps, [item(v)])
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/Only the shop owner/)
    expect(w.deps.approve).not.toHaveBeenCalled()
  })

  it("fails closed when the call cannot be read: nothing is approved", async () => {
    const v = vehicle(2)
    const w = world([v])
    ;(w.deps.readDetail as ReturnType<typeof vi.fn>).mockResolvedValue({ status: "unavailable" })
    const r = await approveSelected(w.deps, [item(v)])
    expect(r).toMatchObject({ ok: false, after: null })
    expect(w.deps.approve).not.toHaveBeenCalled()
  })
})

describe("approve selected: deterministic, dependency-ordered, stops safely", () => {
  it("runs vehicle, customer, quote, booking, message in order whatever the click order", async () => {
    const set = [message(5), booking(4), quote(3), customerChange(1), vehicle(2)]
    const w = world(set)
    const r = await approveSelected(w.deps, set.map(item))
    expect(r.ok).toBe(true)
    expect(w.calls).toEqual(["approve:vehicle", "approve:customer", "approve:quote_draft", "approve:appointment_draft", "approve:message_draft"])
    expect(r.message).toBe("Approved 5 in order.")
  })

  it("is repeatable: the same selection always yields the same order", async () => {
    const orders: string[] = []
    for (const shuffle of [[0, 1, 2], [2, 1, 0], [1, 2, 0]]) {
      const set = [vehicle(2), customerChange(1), quote(3)]
      const w = world(set)
      await approveSelected(w.deps, shuffle.map((i) => item(set[i]!)))
      orders.push(w.calls.join(","))
    }
    expect(new Set(orders).size).toBe(1)
  })

  it("refuses the whole selection, running nothing, when an undecided prerequisite is not selected", async () => {
    const set = [vehicle(2), customerChange(1), quote(3)]
    const w = world(set)
    const r = await approveSelected(w.deps, [item(set[1]!), item(set[2]!)])
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/Approve vehicle first/i)
    expect(w.deps.approve).not.toHaveBeenCalled()
    expect(r.notAttempted).toHaveLength(2)
  })

  it("stops at the FIRST item that is not a confirmed success and attempts nothing after it", async () => {
    const set = [vehicle(2), customerChange(1), quote(3), booking(4)]
    const w = world(set)
    ;(w.deps.approve as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async (id: string) => { const p = [...w.state.values()].find((x) => x.action_id === id)!; w.state.set(p.id, { ...p, status: "approved", executed: true, review_token: "1".repeat(64) }); return { ok: true, status: "executed", actionType: "update_customer", resultId: "r", proposal: {} } })
      .mockResolvedValueOnce({ ok: false, error: "The customer record changed since this proposal was made. Review it again." })
    const r = await approveSelected(w.deps, set.map(item))
    expect(r.ok).toBe(false)
    expect(r.steps.map((s) => s.result)).toEqual(["approved", "denied"])
    expect(r.notAttempted).toHaveLength(2)
    expect(w.deps.approve).toHaveBeenCalledTimes(2)
    expect(r.message).toMatch(/2 more not attempted/)
  })

  it("re-reads fresh state before every item and stops if consent or evidence changed in between", async () => {
    const set = [vehicle(2), customerChange(1)]
    const w = world(set)
    let reads = 0
    ;(w.deps.readDetail as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      reads++
      const current = [...w.state.values()]
      // after the first approval, the evidence is out of date for the next proposal
      return { status: "ok", value: detail({ proposals: reads > 1 ? current.map((p) => (p.status === "pending" ? { ...p, freshness: "call_evidence_changed" } : p)) : current }) }
    })
    const r = await approveSelected(w.deps, set.map(item))
    expect(r.steps[0]).toMatchObject({ result: "approved" })
    expect(r.steps[1]).toMatchObject({ result: "refused" })
    expect(w.calls).toEqual(["approve:vehicle"])
    expect(reads).toBeGreaterThanOrEqual(3)
  })

  it("stops when the state can no longer be verified mid-run", async () => {
    const set = [vehicle(2), customerChange(1)]
    const w = world(set)
    let n = 0
    ;(w.deps.readDetail as ReturnType<typeof vi.fn>).mockImplementation(async () => (++n === 2 ? { status: "unavailable" } : { status: "ok", value: detail({ proposals: [...w.state.values()] }) }))
    const r = await approveSelected(w.deps, set.map(item))
    expect(r.steps.map((s) => s.result)).toEqual(["approved", "refused"])
    expect(w.calls).toEqual(["approve:vehicle"])
  })

  it("a second identical request (replay) runs no effect twice", async () => {
    const set = [vehicle(2), customerChange(1)]
    const w = world(set)
    const sent = set.map(item)
    await approveSelected(w.deps, sent)
    const again = await approveSelected(w.deps, sent)
    expect(again.ok).toBe(false)
    expect(w.calls).toEqual(["approve:vehicle", "approve:customer"])
  })
})

describe("dismiss", () => {
  it("dismisses an executable proposal waiting on the owner through the existing rejection path", async () => {
    const v = vehicle(2)
    const w = world([v])
    const r = await dismissProposal(w.deps, item(v))
    expect(r.ok).toBe(true)
    expect(w.calls).toEqual(["dismiss:vehicle"])
    expect(r.after?.[0]?.status).toBe("rejected")
  })

  it("refuses a review-only proposal, a changed one, a non-owner and a missing one", async () => {
    const ro = reviewOnly()
    expect((await dismissProposal(world([ro]).deps, item(ro))).ok).toBe(false)
    const v = vehicle(2)
    expect((await dismissProposal(world([v]).deps, { proposalId: v.id, reviewToken: "9".repeat(64) })).steps[0]).toMatchObject({ code: "changed" })
    expect((await dismissProposal(world([v], { can_approve: false, viewer_role: "manager" }).deps, item(v))).message).toMatch(/Only the shop owner/)
    expect((await dismissProposal(world([v]).deps, { proposalId: "00000000-0000-4000-8000-0000000000ff", reviewToken: "a".repeat(64) })).steps[0]).toMatchObject({ code: "unknown_proposal" })
  })

  it("an unconfirmed rejection is reported as unconfirmed", async () => {
    const v = vehicle(2)
    const w = world([v])
    ;(w.deps.dismiss as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("x"))
    expect((await dismissProposal(w.deps, item(v))).steps[0]).toMatchObject({ result: "unconfirmed" })
  })
})
