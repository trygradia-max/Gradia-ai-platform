// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DecideResult } from "@/lib/call-review/decide"
import { booking, cite, customerChange, detail, message, quote, reviewOnly, vehicle, CALL_ID } from "./_call-copilot-review-fixtures"

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }))
const actions = vi.hoisted(() => ({ approveCallProposal: vi.fn(), approveSelectedCallProposals: vi.fn(), dismissCallProposal: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => nav, usePathname: () => "/calls/copilot" }))
vi.mock("@/app/actions/call-copilot-review", () => actions)

import { CallReviewDetailView } from "@/components/gradia/call-review/detail-view"
import { CallReviewList } from "@/components/gradia/call-review/call-list"
import { ProposalList } from "@/components/gradia/call-review/proposal-list"

const ok = (over: Partial<DecideResult> = {}): DecideResult => ({ ok: true, message: "Vehicle saved.", steps: [], notAttempted: [], after: [], ...over })
const view = (d = detail()) => render(<CallReviewDetailView detail={d} checkedAt="2026-11-20T15:30:00Z" />)

beforeEach(() => { for (const fn of [...Object.values(nav), ...Object.values(actions)]) fn.mockReset() })
afterEach(cleanup)

describe("what the owner sees", () => {
  it("shows consent and capture, evidence coverage and the cited words", () => {
    view()
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/Call on Nov 20/)
    const capture = screen.getByRole("region", { name: /consent and capture/i })
    expect(within(capture).getByText("Call ended")).toBeTruthy()
    expect(within(capture).getByText(/Before both people agreed/)).toBeTruthy()
    const evidence = screen.getByRole("region", { name: /evidence and gaps/i })
    expect(within(evidence).getByText("Complete transcript")).toBeTruthy()
    expect(within(evidence).getByText("Current")).toBeTruthy()
    expect(within(evidence).getByText(/12 transcript segments of 12 expected/)).toBeTruthy()
    expect(screen.getByText("a white 2021 Tesla Model 3")).toBeTruthy()
    expect(screen.getAllByText(/Caller ·/).length).toBeGreaterThan(0)
  })

  it("shows what each proposal does, its confidence and its customer/vehicle binding in plain words", () => {
    view()
    expect(screen.getByRole("heading", { level: 3, name: /Add a vehicle to the customer/ })).toBeTruthy()
    expect(screen.getAllByText("High confidence").length).toBeGreaterThan(0)
    expect(screen.getByText(/Adds a new vehicle for existing customer Jordan Lee/)).toBeTruthy()
    expect(screen.getAllByText("Tesla").length).toBeGreaterThan(0)
  })

  it("never renders a raw machine code", () => {
    const d = detail({
      proposals: [
        customerChange(1, { freshness: "call_crm_state_changed" }),
        reviewOnly(7, { review_reason: "some_future_reason" }),
        vehicle(2),
      ],
    })
    d.capture = { ...d.capture, reason: "future_capture_reason", gaps: [{ started_at: "2026-11-20T15:00:00Z", ended_at: null, reason: "future_gap" }] }
    const { container } = view(d)
    expect(container.textContent).not.toMatch(/call_crm_state_changed|some_future_reason|future_capture_reason|future_gap|customer_memory_review_only/)
    expect(container.textContent).toMatch(/customer record changed after this was prepared/i)
  })

  it("review-only proposals say why, show no action, and customer memory says it cannot publish", () => {
    view(detail({ proposals: [reviewOnly(7)] }))
    expect(screen.getByText("Review only")).toBeTruthy()
    expect(screen.getByText(/Customer-specific memory stays review-only/)).toBeTruthy()
    expect(screen.getByText(/can't be saved or published from a call/)).toBeTruthy()
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull()
    expect(screen.queryByRole("checkbox")).toBeNull()
  })

  it("explains ambiguity without ever showing candidate identifiers", () => {
    const p = reviewOnly(8, {
      kind: "customer", review_reason: "ambiguous_identity", customer: null,
      ambiguity: { candidate_customers: 2, conflicts: [{ field: "phone", crm: "+15555550100", heard: "+15555550199" }] },
    })
    view(detail({ proposals: [p] }))
    expect(screen.getByText("2 customers on file could match.")).toBeTruthy()
    expect(screen.getByText(/Phone: on file "\+15555550100", heard "\+15555550199"/)).toBeTruthy()
    expect(screen.getByText(/More than one customer matches/)).toBeTruthy()
  })

  it("shows a stale proposal as unapprovable, with the fresh reason, and no buttons", () => {
    view(detail({ proposals: [vehicle(2, { freshness: "call_consent_unavailable" })] }))
    expect(screen.getByText("Can't be approved")).toBeTruthy()
    expect(screen.getByRole("alert").textContent).toMatch(/Consent for this call no longer permits using it/)
    expect(screen.queryByRole("button", { name: /^approve/i })).toBeNull()
    expect(screen.queryByRole("checkbox")).toBeNull()
  })

  it("a stale or blocked proposal can still be dismissed, so a dead one never blocks its dependents for good", async () => {
    actions.dismissCallProposal.mockResolvedValue(ok())
    const stale = booking(4, { freshness: "call_crm_state_changed" })
    render(<ProposalList callId={CALL_ID} proposals={[vehicle(2, { status: "approved", executed: true }), customerChange(1, { status: "approved", executed: true }), stale, message(5)]} viewerCanApprove snippetsWithheld={false} />)
    const cards = screen.getAllByRole("article")
    const bookingCard = cards.find((a) => /Book an appointment/.test(a.textContent ?? ""))!
    const messageCard = cards.find((a) => /Send a text message/.test(a.textContent ?? ""))!
    expect(within(bookingCard).queryByRole("button", { name: "Approve" })).toBeNull()
    expect(within(messageCard).getByText(/Approve the appointment draft first, or dismiss it/)).toBeTruthy()
    await userEvent.click(within(bookingCard).getByRole("button", { name: "Dismiss" }))
    expect(actions.dismissCallProposal).toHaveBeenCalledWith({ callId: CALL_ID, proposalId: stale.id, reviewToken: stale.review_token })
    expect(within(messageCard).getByRole("button", { name: "Dismiss" })).toBeTruthy()
  })

  it("withheld snippets say why and never leak the quote", () => {
    const d = detail({ snippets_withheld: true, proposals: [vehicle(2, { fields: [{ name: "make", value: "Tesla", confidence: "high", citations: [cite({ state: "withheld", snippet: undefined })] }] })] })
    const { container } = view(d)
    expect(screen.getByText(/The words behind each proposal are hidden/)).toBeTruthy()
    expect(container.textContent).toMatch(/Hidden\. The call's consent or evidence no longer permits showing it/)
  })

  it("a call whose consent was declined says so and offers nothing to approve", () => {
    const d = detail({ proposals: [], capture: { ...detail().capture, status: "declined", reason: "consent_not_established", intervals: [], gaps: [], review_permitted: false, review_denied_reason: "consent_declined" } })
    d.evidence.selected = null
    view(d)
    expect(screen.getByText("This call can't be used")).toBeTruthy()
    expect(screen.getByText(/No audio or transcript was captured or sent anywhere/)).toBeTruthy()
    expect(screen.getByText("Nothing is proposed for this call")).toBeTruthy()
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull()
  })

  it("partial evidence and out-of-date evidence are loud, with the reasons in words", () => {
    const d = detail()
    d.evidence.selected = { ...d.evidence.selected!, coverage_status: "partial", coverage_reasons: ["call_not_ended", "segment_holes"], current: false, not_current_reason: "evidence_changed", gaps: [{ started_at: "2026-11-20T15:03:00Z", ended_at: "2026-11-20T15:04:00Z", reason: "paused" }] }
    view(d)
    expect(screen.getByText("Partial transcript")).toBeTruthy()
    expect(screen.getByText("Out of date")).toBeTruthy()
    expect(screen.getByText("The call has not ended.")).toBeTruthy()
    expect(screen.getByText("Some transcript segments are missing.")).toBeTruthy()
    expect(screen.getAllByText(/Capture was paused/).length).toBeGreaterThan(0)
  })

  it("extraction runs show unknown outcome and failures honestly, and dropped counts", () => {
    const d = detail()
    d.runs = [
      { ...d.runs[0]!, status: "unknown_outcome", proposal_count: 0 },
      { ...d.runs[0]!, status: "failed_before_effect", failure_code: "extractor_timeout", proposal_count: 0 },
      { ...d.runs[0]!, status: "completed", refused_count: 2, proposal_count: 3 },
    ]
    view(d)
    expect(screen.getByText(/did not try again on its own/)).toBeTruthy()
    expect(screen.getByText(/failed before anything was sent or saved/i)).toBeTruthy()
    expect(screen.getByText(/2 dropped on purpose/)).toBeTruthy()
  })

  it("a manager sees the same facts but no approve, select or dismiss control", () => {
    view(detail({ viewer_role: "manager", can_approve: false }))
    expect(screen.getByText(/Only the shop owner can approve changes/)).toBeTruthy()
    expect(screen.queryByRole("button", { name: /approve|dismiss/i })).toBeNull()
    expect(screen.queryByRole("checkbox")).toBeNull()
    expect(screen.getByRole("button", { name: /refresh/i })).toBeTruthy()
  })

  it("an empty call is written, not blank", () => {
    const d = detail({ proposals: [], proposals_total: 0 })
    view(d)
    expect(screen.getByText("Nothing is proposed for this call")).toBeTruthy()
  })

  it("refresh re-reads from the server and changes nothing", async () => {
    view()
    await userEvent.click(screen.getByRole("button", { name: /refresh/i }))
    expect(nav.refresh).toHaveBeenCalledTimes(1)
    expect(Object.values(actions).every((f) => f.mock.calls.length === 0)).toBe(true)
  })
})

describe("approving", () => {
  const set = () => [vehicle(2), customerChange(1), quote(3)]

  it("a blocked proposal says what to approve first and offers no approve or select", () => {
    render(<ProposalList callId={CALL_ID} proposals={set()} viewerCanApprove snippetsWithheld={false} />)
    const articles = screen.getAllByRole("article")
    const customer = articles.find((a) => /Link this call to an existing customer/.test(a.textContent ?? ""))!
    expect(within(customer).getByText(/Approve the vehicle first/)).toBeTruthy()
    expect(within(customer).queryByRole("button", { name: "Approve" })).toBeNull()
    expect(within(customer).queryByRole("checkbox")).toBeNull()
    const vehicleCard = articles.find((a) => /Add a vehicle/.test(a.textContent ?? ""))!
    expect(within(vehicleCard).getByRole("button", { name: "Approve" })).toBeTruthy()
  })

  it("reports nothing as done until the server answers, then shows the answer", async () => {
    let resolve: (r: DecideResult) => void = () => {}
    actions.approveCallProposal.mockReturnValue(new Promise<DecideResult>((r) => { resolve = r }))
    const v = vehicle(2)
    render(<ProposalList callId={CALL_ID} proposals={[v]} viewerCanApprove snippetsWithheld={false} />)
    await userEvent.click(screen.getByRole("button", { name: "Approve" }))
    expect(actions.approveCallProposal).toHaveBeenCalledWith({ callId: CALL_ID, proposalId: v.id, reviewToken: v.review_token })
    // in flight: busy, no success text, buttons locked
    expect(screen.getByRole("button", { name: "Approving…" }).getAttribute("aria-busy")).toBe("true")
    expect(screen.queryByText("Vehicle saved.")).toBeNull()
    expect((screen.getByRole("button", { name: "Dismiss" }) as HTMLButtonElement).disabled).toBe(true)
    resolve(ok({ steps: [{ proposalId: v.id, result: "approved", message: "Vehicle saved." }] }))
    await waitFor(() => expect(screen.getAllByText("Vehicle saved.").length).toBeGreaterThan(0))
  })

  it("shows a denial as a denial, not a success", async () => {
    const v = vehicle(2)
    actions.approveCallProposal.mockResolvedValue(ok({ ok: false, message: "Consent for this call no longer permits using it. Nothing was changed.", steps: [{ proposalId: v.id, result: "denied", message: "Consent for this call no longer permits using it. Nothing was changed." }] }))
    render(<ProposalList callId={CALL_ID} proposals={[v]} viewerCanApprove snippetsWithheld={false} />)
    await userEvent.click(screen.getByRole("button", { name: "Approve" }))
    await waitFor(() => expect(screen.getAllByRole("alert").length).toBeGreaterThan(0))
    expect(screen.queryByText("Vehicle saved.")).toBeNull()
  })

  it("an action that throws reports an unknown result and tells the owner not to guess", async () => {
    actions.approveCallProposal.mockRejectedValue(new Error("network"))
    render(<ProposalList callId={CALL_ID} proposals={[vehicle(2)]} viewerCanApprove snippetsWithheld={false} />)
    await userEvent.click(screen.getByRole("button", { name: "Approve" }))
    await waitFor(() => expect(screen.getByText(/its result is not known/i)).toBeTruthy())
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(false)
  })

  it("approve-selected sends references only, in the order the server will enforce, and refuses a selection that skips a prerequisite", async () => {
    const [v, c, q] = set()
    actions.approveSelectedCallProposals.mockResolvedValue(ok({ message: "Approved 2 in order." }))
    render(<ProposalList callId={CALL_ID} proposals={[q!, c!, v!]} viewerCanApprove snippetsWithheld={false} />)
    const bulk = () => screen.getByRole("button", { name: /Approve selected/ }) as HTMLButtonElement
    expect(bulk().disabled).toBe(true)
    // only the vehicle is ready; the customer and quote wait for it
    expect(screen.getAllByRole("checkbox")).toHaveLength(1)
    await userEvent.click(screen.getByRole("checkbox", { name: /Select/ }))
    expect(bulk().textContent).toBe("Approve selected (1)")
    await userEvent.click(bulk())
    expect(actions.approveSelectedCallProposals).toHaveBeenCalledWith({ callId: CALL_ID, items: [{ proposalId: v!.id, reviewToken: v!.review_token }] })
    await waitFor(() => expect(screen.getByText(/Approved 2 in order\./)).toBeTruthy())
    expect(Object.keys(actions.approveSelectedCallProposals.mock.calls[0]![0]).sort()).toEqual(["callId", "items"])
  })

  it("selection is dropped when the proposal changed underneath it", async () => {
    const v = vehicle(2)
    const { rerender } = render(<ProposalList callId={CALL_ID} proposals={[v]} viewerCanApprove snippetsWithheld={false} />)
    await userEvent.click(screen.getByRole("checkbox"))
    expect((screen.getByRole("button", { name: /Approve selected \(1\)/ }) as HTMLButtonElement).disabled).toBe(false)
    rerender(<ProposalList callId={CALL_ID} proposals={[{ ...v, review_token: "9".repeat(64) }]} viewerCanApprove snippetsWithheld={false} />)
    expect((screen.getByRole("button", { name: /Approve selected \(0\)/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("dismiss calls the dismiss action with references only", async () => {
    const v = vehicle(2)
    actions.dismissCallProposal.mockResolvedValue(ok({ message: "Dismissed. Nothing was changed.", steps: [{ proposalId: v.id, result: "dismissed", message: "Dismissed. Nothing was changed." }] }))
    render(<ProposalList callId={CALL_ID} proposals={[v]} viewerCanApprove snippetsWithheld={false} />)
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(actions.dismissCallProposal).toHaveBeenCalledWith({ callId: CALL_ID, proposalId: v.id, reviewToken: v.review_token })
    await waitFor(() => expect(screen.getAllByText(/Dismissed\. Nothing was changed\./).length).toBeGreaterThan(0))
  })

  it("a booking card tells the owner availability is checked again and a message card that it is not a delivery receipt", () => {
    render(<ProposalList callId={CALL_ID} proposals={[vehicle(2, { status: "approved", executed: true }), customerChange(1, { status: "approved", executed: true }), booking(4), message(5)]} viewerCanApprove snippetsWithheld={false} />)
    expect(screen.getByText(/Availability is checked again when you approve/)).toBeTruthy()
    expect(screen.getAllByText(/Approved and done/).length).toBe(2)
  })

  it("has accessible structure: every control is named, every proposal is a labelled article, ids are unique", () => {
    const { container } = render(<ProposalList callId={CALL_ID} proposals={set()} viewerCanApprove snippetsWithheld={false} />)
    for (const b of screen.getAllByRole("button")) expect(b.textContent?.trim() || b.getAttribute("aria-label")).toBeTruthy()
    for (const a of screen.getAllByRole("article")) expect(a.getAttribute("aria-labelledby")).toBeTruthy()
    const ids = [...container.querySelectorAll("[id]")].map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(container.querySelector("[aria-live]")).toBeTruthy()
  })
})

describe("the call list", () => {
  const list = (items: unknown[]) => ({ viewer_role: "owner" as const, can_approve: true, items: items as never, next_cursor: null })
  const item = (over = {}) => ({
    call_id: CALL_ID, created_at: "2026-11-20T15:00:00Z", capture_status: "ended", capture_reason: "call_ended", call_ended: true, outcome_unknown: false,
    unresolved_gap: false, latest_revision: 1, coverage_status: "complete", proposals: { total: 3, awaiting: 2, review_only: 1, decided: 0 }, ...over,
  })

  it("lists calls with state, evidence and counts as links", () => {
    render(<CallReviewList list={list([item()])} hrefFor={(id) => `/calls/copilot/${id}`} baseHref="/calls/copilot" nextHref={null} isFirstPage />)
    const link = screen.getByRole("link", { name: /Call on Nov 20/ })
    expect(link.getAttribute("href")).toBe(`/calls/copilot/${CALL_ID}`)
    expect(link.textContent).toMatch(/2 waiting on you/)
    expect(link.textContent).toMatch(/3 proposals · 1 review only · 0 decided/)
  })

  it("writes the empty state, and a declined call stays visible as not captured", () => {
    const { rerender } = render(<CallReviewList list={list([])} hrefFor={(id) => id} baseHref="/x" nextHref={null} isFirstPage />)
    expect(screen.getByText("No calls to review yet")).toBeTruthy()
    rerender(<CallReviewList list={list([item({ capture_status: "declined", coverage_status: null, latest_revision: null, proposals: null })])} hrefFor={(id) => id} baseHref="/x" nextHref={null} isFirstPage />)
    expect(screen.getByText("Consent declined")).toBeTruthy()
    expect(screen.getByText("No evidence yet")).toBeTruthy()
    expect(screen.getByText("Nothing proposed yet.")).toBeTruthy()
  })

  it("paginates with real links and never invents a total", () => {
    render(<CallReviewList list={list([item()])} hrefFor={(id) => id} baseHref="/calls/copilot" nextHref="/calls/copilot?before=abc" isFirstPage={false} />)
    expect(screen.getByRole("link", { name: "Older calls" }).getAttribute("href")).toBe("/calls/copilot?before=abc")
    expect(screen.getByRole("link", { name: "Newer calls" }).getAttribute("href")).toBe("/calls/copilot")
  })
})

describe("server rendering", () => {
  it("renders the whole review to static markup without the browser (no hydration-only data)", () => {
    const html = renderToStaticMarkup(<CallReviewDetailView detail={detail()} checkedAt="2026-11-20T15:30:00Z" />)
    expect(html).toContain("Nov 20, 3:00 PM UTC")
    expect(html).not.toMatch(/undefined|NaN|\[object/)
  })
})
