import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import {
  FRESHNESS_COPY, KIND_LABEL, MAX_BULK, REVIEW_REASON_COPY, SNIPPET_COPY, canApprove, coverageReasonCopy, describeChange, displayValue,
  freshnessCopy, gapReasonCopy, groupBySet, planSelection, proposalState, reviewHeadline, reviewReasonCopy, selectionRefusalCopy, undecidedPrerequisites,
} from "@/lib/call-copilot/review-model"
import { PROPOSAL_KINDS, SNIPPET_STATES } from "@/lib/call-copilot/review-dto"
import { booking, customerChange, detail, message, note, proposal, quote, reviewOnly, vehicle } from "./_call-copilot-review-fixtures"

const root = join(__dirname, "..")
const src = (p: string) => readFileSync(join(root, p), "utf8")
const sel = (...ps: { id: string; review_token: string }[]) => ps.map((p) => ({ proposalId: p.id, reviewToken: p.review_token }))

describe("plain-language copy covers every code the database or planner can show", () => {
  it("every review reason the planner and timing grounding can produce has owner-readable copy", () => {
    const code = src("src/lib/call-copilot/planner.ts") + src("src/lib/call-copilot/timing-grounding.ts")
    const reasons = new Set<string>()
    for (const m of code.matchAll(/review\(b,\s*"([a-z_]+)"/g)) reasons.add(m[1]!)
    for (const m of code.matchAll(/reason:\s*"([a-z_]+)"/g)) reasons.add(m[1]!)
    for (const m of src("supabase/migrations/20261120140000_call_copilot_proposals.sql").matchAll(/v_reason := '([a-z_]+)'/g)) reasons.add(m[1]!)
    // refusals are dropped and never shown; these are the codes a reviewer can see
    for (const never of ["invalid_citation", "suspected_instruction", "sensitive_content"]) reasons.delete(never)
    expect(reasons.size).toBeGreaterThan(15)
    for (const r of reasons) expect(REVIEW_REASON_COPY[r], `missing copy for ${r}`).toBeTruthy()
  })

  it("every denial the executor can name has copy, and none is shown raw", () => {
    const approvals = src("src/lib/approvals.ts")
    const denials = [...approvals.matchAll(/^\s+(call_[a-z_]+):\s*"/gm)].map((m) => m[1]!)
    for (const d of denials.filter((d) => d !== "call_human_approval_required")) expect(FRESHNESS_COPY[d], d).toBeTruthy()
    expect(freshnessCopy("totally_unknown_code")).not.toContain("totally_unknown_code")
    expect(reviewReasonCopy("totally_unknown_code")).not.toContain("totally_unknown_code")
    expect(coverageReasonCopy("zzz")).not.toContain("zzz")
    expect(gapReasonCopy("zzz")).not.toContain("zzz")
    expect(freshnessCopy(null)).toBeNull()
  })

  it("has a label for every proposal kind and copy for every withheld-snippet state", () => {
    for (const k of PROPOSAL_KINDS) expect(KIND_LABEL[k]).toBeTruthy()
    for (const s of SNIPPET_STATES.filter((s) => s !== "shown")) expect(SNIPPET_COPY[s as Exclude<typeof s, "shown">]).toBeTruthy()
  })

  it("displays call-derived values as bounded plain text", () => {
    expect(displayValue(null)).toBe("not said")
    expect(displayValue(["a", "b"])).toBe("a, b")
    expect(displayValue({ x: 1 })).toBe("a structured value")
    expect(displayValue("x".repeat(500)).length).toBe(240)
  })
})

describe("what a proposal will do is read from the staged payload", () => {
  it("describes each executable kind and never claims a price, send or booking it will not make", () => {
    expect(describeChange(vehicle()).headline).toMatch(/Add a vehicle/)
    expect(describeChange(vehicle()).lines).toEqual(expect.arrayContaining([{ label: "Make", value: "Tesla" }, { label: "Year", value: "2021" }]))
    expect(describeChange(vehicle()).binding).toMatch(/before any change to the customer/i)
    expect(describeChange(quote()).binding).toMatch(/never from the call/i)
    expect(describeChange(quote()).binding).toMatch(/does not send it/i)
    expect(describeChange(booking()).binding).toMatch(/checked again/i)
    expect(describeChange(message()).binding).toMatch(/not a delivery receipt/i)
    expect(describeChange(note()).binding).toMatch(/Nothing is sent/)
    expect(describeChange(customerChange()).headline).toMatch(/existing customer/)
    expect(describeChange(proposal({ customer: null })).binding).toMatch(/new one would be created/)
  })

  it("describes a review-only proposal as what was heard, with no action", () => {
    const c = describeChange(reviewOnly())
    expect(c.headline).toMatch(/^Heard:/)
    expect(c.lines[0]).toEqual({ label: "Memory", value: "Prefers morning drop-off" })
  })
})

describe("proposal state", () => {
  const all = [vehicle(2), customerChange(1), quote(3)]
  it("is ready only when executable, undecided, fresh and unblocked", () => {
    expect(proposalState(all[0]!, all).kind).toBe("ready")
    expect(proposalState(reviewOnly(), [reviewOnly()]).kind).toBe("review_only")
    expect(proposalState(proposal({ freshness: "call_evidence_changed" }), []).kind).toBe("stale")
    expect(proposalState(proposal({ status: "approved", executed: true }), [])).toEqual({ kind: "approved", executed: true })
    expect(proposalState(proposal({ status: "rejected" }), []).kind).toBe("dismissed")
    expect(proposalState(proposal({ status: "edit_requested" }), []).kind).toBe("edit_requested")
  })

  it("a customer change waits for an undecided vehicle; a quote, booking and note wait for both", () => {
    expect(proposalState(all[1]!, all)).toEqual({ kind: "blocked_by", prerequisites: ["vehicle"] })
    const q = proposalState(all[2]!, all)
    expect(q.kind).toBe("blocked_by")
    expect((q as { prerequisites: string[] }).prerequisites.sort()).toEqual(["customer", "vehicle"])
  })

  it("a message waits for the quote and the booking too", () => {
    const set = [vehicle(2, { status: "approved" }), customerChange(1, { status: "approved" }), quote(3), booking(4), message(5)]
    const m = proposalState(set[4]!, set)
    expect(m).toEqual({ kind: "blocked_by", prerequisites: ["quote_draft", "appointment_draft"] })
  })

  it("is unblocked once prerequisites are decided (approved or dismissed)", () => {
    const set = [vehicle(2, { status: "rejected" }), customerChange(1, { status: "approved" }), quote(3)]
    expect(proposalState(set[2]!, set).kind).toBe("ready")
  })

  it("dependencies never cross requesters or evidence revisions", () => {
    const other = vehicle(9, { set_id: "b".repeat(64) })
    expect(undecidedPrerequisites(customerChange(1), [other])).toEqual([])
  })

  it("a viewer who is not the owner can never approve", () => {
    expect(canApprove(vehicle(), [vehicle()], false)).toBe(false)
    expect(canApprove(vehicle(), [vehicle()], true)).toBe(true)
  })

  it("groups by requester and orders for approval", () => {
    const sets = groupBySet([quote(3), customerChange(1), vehicle(2), vehicle(9, { set_id: "b".repeat(64), requested_by_me: false })])
    expect(sets).toHaveLength(2)
    expect(sets[0]!.proposals.map((p) => p.kind)).toEqual(["vehicle", "customer", "quote_draft"])
    expect(sets[1]!.mine).toBe(false)
  })
})

describe("selection planning (the same rules the server enforces)", () => {
  const v = vehicle(2), c = customerChange(1), q = quote(3), b = booking(4), m = message(5)
  const d = { proposals: [m, b, q, c, v] }

  it("orders vehicle, then customer, then quote and booking, then message, whatever the click order", () => {
    const plan = planSelection(d, sel(m, b, q, c, v))
    expect(plan.ok && plan.ordered.map((p) => p.kind)).toEqual(["vehicle", "customer", "quote_draft", "appointment_draft", "message_draft"])
  })

  it("refuses the whole selection when an undecided prerequisite is not selected", () => {
    const r = planSelection(d, sel(c))
    expect(r).toMatchObject({ ok: false, reason: "missing_prerequisite", needs: ["vehicle"] })
    expect(selectionRefusalCopy(r as never)).toMatch(/Approve vehicle first/i)
    const r2 = planSelection(d, sel(m, v, c))
    expect(r2).toMatchObject({ ok: false, reason: "missing_prerequisite" })
  })

  it("refuses an empty, oversized, duplicated, unknown, changed or non-approvable selection", () => {
    expect(planSelection(d, [])).toEqual({ ok: false, reason: "empty" })
    const many = Array.from({ length: MAX_BULK + 1 }, (_, i) => ({ proposalId: `x${i}`, reviewToken: "t" }))
    expect(planSelection(d, many)).toEqual({ ok: false, reason: "too_many" })
    expect(planSelection(d, [...sel(v), ...sel(v)])).toEqual({ ok: false, reason: "duplicate" })
    expect(planSelection(d, [{ proposalId: "00000000-0000-4000-8000-0000000000ff", reviewToken: "t" }])).toMatchObject({ ok: false, reason: "unknown_proposal" })
    expect(planSelection(d, [{ proposalId: v.id, reviewToken: "f".repeat(64) }])).toMatchObject({ ok: false, reason: "changed" })
    const stale = vehicle(2, { freshness: "call_crm_state_changed", review_token: "e".repeat(64) })
    expect(planSelection({ proposals: [stale] }, sel(stale))).toMatchObject({ ok: false, reason: "not_approvable" })
    const ro = reviewOnly()
    expect(planSelection({ proposals: [ro] }, sel(ro))).toMatchObject({ ok: false, reason: "not_approvable" })
    const done = vehicle(2, { status: "approved", review_token: "d".repeat(64) })
    expect(planSelection({ proposals: [done] }, sel(done))).toMatchObject({ ok: false, reason: "not_approvable" })
  })

  it("accepts a dependent when its prerequisite is already decided", () => {
    const decided = vehicle(2, { status: "approved", review_token: "d".repeat(64) })
    const plan = planSelection({ proposals: [decided, c] }, sel(c))
    expect(plan.ok).toBe(true)
  })
})

describe("headline", () => {
  it("is honest about consent, partial and stale evidence", () => {
    expect(reviewHeadline(detail()).tone).toBe("good")
    const denied = detail({ capture: { ...detail().capture, status: "declined", review_permitted: false, review_denied_reason: "consent_declined" } })
    expect(reviewHeadline(denied)).toMatchObject({ tone: "bad", title: "This call can't be used" })
    const partial = detail(); partial.evidence.selected = { ...partial.evidence.selected!, coverage_status: "partial", coverage_reasons: ["call_not_ended"] }
    expect(reviewHeadline(partial).title).toBe("Partial evidence")
    const stale = detail(); stale.evidence.selected = { ...stale.evidence.selected!, current: false, not_current_reason: "evidence_changed" }
    expect(reviewHeadline(stale)).toMatchObject({ tone: "warn", title: "The evidence changed" })
    const none = detail(); none.evidence.selected = null
    expect(reviewHeadline(none).title).toMatch(/No evidence/)
  })
})
