import type { ApprovalResult, DecisionResult } from "@/lib/approvals"
import type { ReadOutcome } from "@/lib/call-copilot/review-read"
import type { ProposalKind, ReviewDetail, ReviewProposal } from "@/lib/call-copilot/review-dto"
import { freshnessCopy, planSelection, selectionRefusalCopy, type SelectionRefusal } from "@/lib/call-copilot/review-model"

/**
 * Call Copilot review (PR F): the decision orchestration behind the review page's server actions.
 *
 * What this module IS: sequencing, freshness and ordering around the EXISTING approval path. What it is NOT: an
 * executor. It never writes `pending_actions`, never touches a CRM table and never runs a tool. Approving calls the
 * injected `approve`, which in production is `executeApproval` (the one executor: it claims the action in
 * `claim_control_action` -> `control_claim`, which re-verifies membership, active policy, consent, the sealed evidence
 * revision, the agent definition and the customer identity, and the pre-effect recheck guards the effects that run
 * after the claim). Dismissing calls `executeRejection`.
 *
 * Rules enforced here, before the executor is ever asked:
 *   - The reviewer decides on what they SAW: every request carries the `review_token` from the read they were shown.
 *     If anything about the proposal changed since (payload, status, evidence, consent, CRM), nothing runs.
 *   - Only an executable, undecided, fresh proposal can be approved. Review-only kinds can never be approved.
 *   - Dependency order: a vehicle before the customer change, and a quote, booking or message only after the customer
 *     and vehicle proposals are decided. A selection that skips an undecided prerequisite is refused whole.
 *   - Bulk is sequential and deterministic (approval order), re-reads fresh state before EACH item, and stops at the
 *     first item that is not a confirmed success. Nothing after it runs.
 *   - No optimistic claim: the outcome reported is the executor's answer, followed by a fresh read of the proposal.
 *   - A replay (double click, retry, two tabs) is the executor's own `already_decided`: nothing runs twice.
 */

export type DecideDeps = {
  readDetail: () => Promise<ReadOutcome<ReviewDetail>>
  approve: (actionId: string) => Promise<ApprovalResult>
  dismiss: (actionId: string) => Promise<DecisionResult>
}

export type ProposalAfter = {
  proposalId: string
  status: ReviewProposal["status"]
  executed: boolean | null
  freshness: string | null
}

export type StepOutcome =
  | { proposalId: string; result: "approved"; message: string }
  | { proposalId: string; result: "already_decided"; message: string }
  | { proposalId: string; result: "dismissed"; message: string }
  | { proposalId: string; result: "refused"; message: string; code: string }
  | { proposalId: string; result: "denied"; message: string }
  /** The executor could not say what happened. Nothing is assumed; the reviewer must refresh and look. */
  | { proposalId: string; result: "unconfirmed"; message: string }

export type DecideResult = {
  /** True only when every requested step is a confirmed success (approved, or already decided). */
  ok: boolean
  message: string
  steps: StepOutcome[]
  /** Proposals that were selected but NOT attempted because an earlier step did not succeed. */
  notAttempted: string[]
  /** The authoritative state after the run, read again from the database. Null if that read failed. */
  after: ProposalAfter[] | null
}

const UNVERIFIED = "The call could not be verified just now. Nothing was approved. Refresh and try again."
const NOT_OWNER = "Only the shop owner can approve call proposals. You can review them here."

const DONE: Record<ProposalKind, string> = {
  customer: "Customer saved.",
  vehicle: "Vehicle saved.",
  service_request: "Note saved on the customer record.",
  timing: "Note saved on the customer record.",
  quote_draft: "Quote drafted. It has not been sent.",
  appointment_draft: "Appointment booked.",
  message_draft: "Text approved and handed to the provider. This is not a delivery receipt.",
  lead: "Done.", followup_task: "Done.", memory_candidate: "Done.",
}

const UNCERTAIN = /could not be verified|uncertain|status could not|result uncertain/i

function refusalCode(r: SelectionRefusal): string {
  return r.reason === "missing_prerequisite" ? "missing_prerequisite" : r.reason
}

function after(detail: ReadOutcome<ReviewDetail>, ids: string[]): ProposalAfter[] | null {
  if (detail.status !== "ok") return null
  const byId = new Map(detail.value.proposals.map((p) => [p.id, p]))
  return ids.flatMap((id) => {
    const p = byId.get(id)
    return p ? [{ proposalId: id, status: p.status, executed: p.executed, freshness: p.freshness }] : []
  })
}

function refuse(proposalId: string, code: string, message: string): StepOutcome {
  return { proposalId, result: "refused", code, message }
}

/** Approve one proposal after re-checking everything the reviewer saw. Never throws. */
async function approveStep(
  deps: DecideDeps,
  detail: ReviewDetail,
  item: { proposalId: string; reviewToken: string },
): Promise<StepOutcome> {
  if (!detail.can_approve) return refuse(item.proposalId, "not_owner", NOT_OWNER)
  const plan = planSelection(detail, [item])
  if (!plan.ok) return refuse(item.proposalId, refusalCode(plan), selectionRefusalCopy(plan))
  const proposal = plan.ordered[0]!
  if (proposal.freshness) return refuse(item.proposalId, "stale", freshnessCopy(proposal.freshness) ?? UNVERIFIED)
  let result: ApprovalResult
  try {
    result = await deps.approve(proposal.action_id!)
  } catch {
    return { proposalId: item.proposalId, result: "unconfirmed", message: "Result not confirmed. Do not approve again until you refresh and check this proposal." }
  }
  if (!result.ok) {
    if (UNCERTAIN.test(result.error)) return { proposalId: item.proposalId, result: "unconfirmed", message: `${result.error} Refresh and check this proposal before trying again.` }
    return { proposalId: item.proposalId, result: "denied", message: result.error }
  }
  if (result.status === "already_decided") {
    return { proposalId: item.proposalId, result: "already_decided", message: "This was already decided. Nothing new ran." }
  }
  return { proposalId: item.proposalId, result: "approved", message: DONE[proposal.kind] }
}

export async function approveSelected(
  deps: DecideDeps,
  items: readonly { proposalId: string; reviewToken: string }[],
): Promise<DecideResult> {
  const first = await deps.readDetail()
  if (first.status !== "ok") return { ok: false, message: UNVERIFIED, steps: [], notAttempted: items.map((i) => i.proposalId), after: null }
  const detail = first.value
  if (!detail.can_approve) {
    return { ok: false, message: NOT_OWNER, steps: [], notAttempted: items.map((i) => i.proposalId), after: after(first, items.map((i) => i.proposalId)) }
  }
  // The whole selection is validated and ordered BEFORE anything runs.
  const plan = planSelection(detail, items)
  if (!plan.ok) {
    const id = "proposalId" in plan ? plan.proposalId : (items[0]?.proposalId ?? "")
    return {
      ok: false, message: selectionRefusalCopy(plan), steps: id ? [refuse(id, refusalCode(plan), selectionRefusalCopy(plan))] : [],
      notAttempted: items.map((i) => i.proposalId), after: after(first, items.map((i) => i.proposalId)),
    }
  }
  const tokens = new Map(items.map((i) => [i.proposalId, i.reviewToken]))
  const steps: StepOutcome[] = []
  const notAttempted: string[] = []
  let current: ReadOutcome<ReviewDetail> = first
  for (const [index, p] of plan.ordered.entries()) {
    if (steps.length && steps[steps.length - 1]!.result !== "approved" && steps[steps.length - 1]!.result !== "already_decided") {
      notAttempted.push(p.id)
      continue
    }
    // Fresh state before EACH item (after the first): consent, evidence or the customer may have changed.
    if (index > 0) current = await deps.readDetail()
    if (current.status !== "ok") {
      steps.push(refuse(p.id, "unverified", UNVERIFIED))
      continue
    }
    steps.push(await approveStep(deps, current.value, { proposalId: p.id, reviewToken: tokens.get(p.id)! }))
  }
  const ok = steps.length === plan.ordered.length && steps.every((s) => s.result === "approved" || s.result === "already_decided")
  const last = steps[steps.length - 1]
  const message = ok
    ? steps.length === 1 ? steps[0]!.message : `Approved ${steps.filter((s) => s.result === "approved").length} in order.`
    : `${last?.message ?? UNVERIFIED}${notAttempted.length ? ` ${notAttempted.length} more not attempted.` : ""}`
  const fresh = await deps.readDetail()
  return { ok, message, steps, notAttempted, after: after(fresh, plan.ordered.map((p) => p.id)) }
}

/** Dismiss one executable proposal (reject its pending action). Never a hidden approve. */
export async function dismissProposal(
  deps: DecideDeps,
  item: { proposalId: string; reviewToken: string },
): Promise<DecideResult> {
  const read = await deps.readDetail()
  if (read.status !== "ok") return { ok: false, message: UNVERIFIED, steps: [], notAttempted: [item.proposalId], after: null }
  const detail = read.value
  if (!detail.can_approve) {
    return { ok: false, message: NOT_OWNER, steps: [refuse(item.proposalId, "not_owner", NOT_OWNER)], notAttempted: [], after: after(read, [item.proposalId]) }
  }
  const p = detail.proposals.find((x) => x.id === item.proposalId)
  if (!p) {
    const m = selectionRefusalCopy({ ok: false, reason: "unknown_proposal", proposalId: item.proposalId })
    return { ok: false, message: m, steps: [refuse(item.proposalId, "unknown_proposal", m)], notAttempted: [], after: null }
  }
  if (p.review_token !== item.reviewToken) {
    const m = selectionRefusalCopy({ ok: false, reason: "changed", proposalId: p.id })
    return { ok: false, message: m, steps: [refuse(p.id, "changed", m)], notAttempted: [], after: after(read, [p.id]) }
  }
  if (p.route !== "pending_action" || !p.action_id || (p.status !== "pending" && p.status !== "edit_requested")) {
    const m = "Only a proposal that is waiting on you can be dismissed."
    return { ok: false, message: m, steps: [refuse(p.id, "not_approvable", m)], notAttempted: [], after: after(read, [p.id]) }
  }
  let step: StepOutcome
  try {
    const r = await deps.dismiss(p.action_id)
    if (!r.ok) step = { proposalId: p.id, result: "denied", message: r.error }
    else if (r.status === "already_decided") step = { proposalId: p.id, result: "already_decided", message: "This was already decided. Nothing new ran." }
    else step = { proposalId: p.id, result: "dismissed", message: "Dismissed. Nothing was changed." }
  } catch {
    step = { proposalId: p.id, result: "unconfirmed", message: "Result not confirmed. Refresh and check this proposal." }
  }
  const fresh = await deps.readDetail()
  const ok = step.result === "dismissed" || step.result === "already_decided"
  return { ok, message: step.message, steps: [step], notAttempted: [], after: after(fresh, [p.id]) }
}
