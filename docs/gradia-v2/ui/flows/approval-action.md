# Flow — Approval Action

_Created 2026-07-25 by the Organizer. Grounded in audit trace I and doc 07: the approval engine is the platform's strongest subsystem (atomic claim, edit-then-approve, undo-reject, rollback-on-failure) and the universal AI action model (D-011)._

**Maturity:** EXISTS — `/approvals` inbox with Approve / Edit & approve / Dismiss (never binary approve/reject per BUILD_REFERENCE §3), decision-log "because" lines rendered only where data exists. Known gap: `stageSingle` paths (draft_reply, propose_booking) skip the decision log.
**Phase/Epic:** Live; conflict warnings added by P0-004. The `stageSingle` decision-log gap has a named owner (2026-07-27): it rides the **E01 ticket cut from `program/backlog.md` Band 3 (E01 row)** — the Organizer must include "stageSingle paths record decision-log entries" in E01 ticket scope; until that ticket exists this line is its tracking record.

## Entry point
`/approvals` (sidebar badge = pending count); Home "Needs your review" tile; Activity "Needs review" deep-link; mobile notification (target).

## User objective
Everything the AI wants to do waits here; the owner clears the queue in seconds with full context and control.

## Required data
`pending_actions` row: action type (11-value enum), payload, customer context, drafted content, verifier objections if any, decision-log "because" line where recorded, conflict warning where relevant (P0-004).

## Exact steps
1. Owner opens Approvals → cards listed with what/who/why and qualitative confidence (never percentages).
2. Per card, one of three: **Approve** · **Edit & approve** (modify the draft/time, then approve) · **Dismiss** (undo-friendly reject).
3. Approve → atomic status-guarded claim (`claimPendingAction` — double-approve safe) → the ONE executor performs the real side effect (send policy, A2P, quiet hours, metering all bind at execution).
4. Result stamped (`result_id`), resolution telemetry recorded (approved_unedited / edited / rejected / auto) feeding earned-autonomy recommendations (`trust.ts`).
5. Failure → action rolls back to pending with the failure reason visible; nothing half-executes silently.
6. **(P0-004)** Booking cards show conflict warnings; owner override is documented (D-016).

## System decisions
- Money + calendar actions are ALWAYS-HITL — no mode, flag, or refactor bypasses (locked principle #4, D-021).
- Held sends (quiet hours) stay visible as held with the reason; they release per policy, not silently.
- Package-2 autopilot executes *through this same path* (auto resolution recorded) — the queue is the audit surface either way.
- Slack approval surface stays disabled until tenant authorization is rebuilt (D-026 / audit C-2).

## AI involvement
The queue IS the AI boundary: AI stages, human decides. Edit-then-approve trains resolution telemetry; qualitative confidence only.

## Permissions
Owner today. Post-E01: approval rights are role-scoped; who approved is always recorded (already: decider recorded for audit).

## Error states
- Execution failure → rollback to pending + reason on the card + Activity entry.
- Stale card (customer opted out since staging) → send policy blocks at execution with the block reason shown.
- Concurrent approve attempts → second attempt sees the claim, no double-send.

## Empty states
- "Nothing waiting on you." (all-done reassures, per design system) with a link to Activity for what ran autonomously.

## Success state
Card resolves with visible outcome (sent/booked/created + link to the result); badge decrements; Activity logs the event with its "because" line where data exists.

## Next recommended action
Next card; when the queue is empty, review autonomy recommendations if `trust.ts` has evidence to offer.

## Mobile behavior
Approvals are the core mobile loop: swipe-friendly cards, optimistic slide-out, <60s capture→approve→send (GO_LIVE_CHECKLIST NOW-4).

## Analytics events
`First AI action approved` (first-ever approval executed); `First revenue opportunity acted on` (first approval originating from the opportunity/win-back surfaces).
