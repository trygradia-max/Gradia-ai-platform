# Flow — Reschedule, Cancel and Waitlist

_Created 2026-07-27 by the Organizer (audit correction: founder calendar parity requires post-booking changes — reschedule, cancellation, waitlists, reminders — and no flow covered them; `online-booking.md` is initial-booking only). Governed by D-013 (Gradia DB = appointment source of truth), D-015 (automation hard-blocks conflicts), D-016 (documented human override)._

**Maturity:** TARGET — today rescheduling means manual edits against the Aurinko-authoritative calendar; no waitlist exists anywhere.
**Phase/Epic:** E02 / P2 (reschedule + cancel + reminder touchpoints); waitlist may land late-E02 or early-E06 — the E02 epic states which at ticket cutting.

## Entry point
Appointment card (Calendar destination or customer file) → Reschedule / Cancel; inbound customer request via SMS/voice ("can we move Thursday?") → AI stages a reschedule proposal (HITL); reminder reply ("R to reschedule").

## User objective
Move or cancel booked work in seconds without double-booking, losing the slot's revenue, or silently orphaning reminders — and refill freed slots from the waitlist.

## Required data
Appointment (Gradia row, D-013), new slot candidates from the availability engine (P0-003 conflict service + E02 availability), cancellation reason (optional list per shop), waitlist entries (customer, service, time window, priority), reminder ladder state.

## Exact steps
1. **Reschedule:** owner (or AI proposal) picks a new slot → conflict re-check runs on the *new* slot: automation paths hard-block conflicts (D-015); a human owner sees the conflict and may override with the override documented — who/when/what conflict (D-016).
2. Move commits atomically: one appointment updated (never delete+recreate losing history), external mirrors (Google/Microsoft, D-014) updated, reminder ladder rebased to the new time.
3. Customer notified through the standard send path (HITL or autopilot per mode; quiet hours apply).
4. **Cancel:** confirm with reason → appointment marked cancelled (soft state, never row deletion — audit trail), mirrors cleared, reminders halted, linked quote/job returned to its prior actionable state (quote stays accepted; job unscheduled).
5. **Waitlist backfill:** a freed slot inside the waitlist window surfaces matching entries → owner approves the offer (or autopilot per mode) → offer message sent; first confirmed claim books the slot through the standard booking path (calendar write = ALWAYS-HITL for AI; conflicts hard-block).
6. No-show handling (owner marks no-show) records the outcome for reporting (E08 no-show rate) and optionally stages a rebook follow-up.

## System decisions
- Reschedule is an update, not delete+recreate — history, reminders, and job linkage survive the move.
- The waitlist never auto-books: it stages offers; the customer's confirmation books via the conflict-checked path.
- Cancellation fees (if a shop policy exists) ride the E05 invoice flow — this flow only records the fact.
- Repeated customer-initiated reschedules are visible on the customer file (pattern feeds Opportunity/at-risk signals, E09).

## AI involvement
Suggest-HITL: parsing inbound reschedule requests into proposals, drafting notifications and waitlist offers. AI never moves an appointment directly — calendar writes stay ALWAYS-HITL (locked principle #4).

## Permissions
Owner today. Post-E01: reschedule/cancel per role; techs may request but not commit changes to appointments they're assigned to.

## Error states
- New slot conflicts (automation) → hard block with alternatives offered (D-015).
- External mirror update fails → Gradia row is still truth (D-013); sync marked degraded with retry; owner sees mirror status, never a blocked reschedule.
- Waitlist offer claimed after slot re-filled → claim fails cleanly with "slot no longer available" + next alternatives; no double-booking possible (conflict service).
- Notification send fails → appointment change stands; failed send surfaced for manual follow-up (never silent).

## Empty states
- Waitlist: "No one is waiting. Customers land here when their preferred time is full."

## Success state
Appointment shows its new time with change history (who moved it, when, why if given); customer confirmed; freed slots refilled or visibly open on the calendar.

## Next recommended action
After cancel: offer the slot to the waitlist / stage a win-back follow-up. After reschedule: confirm reminder ladder shows the new times.

## Mobile behavior
Reschedule from the appointment card in two taps (new slot picker is the same mobile slot UI as booking); cancel requires explicit confirm; waitlist offers manageable from the approvals loop on phone.

## Analytics events
`Appointment rescheduled` (with initiator: owner/customer/AI-proposed), `Appointment cancelled` (with reason), `Waitlist joined`, `Waitlist slot offered`, `Waitlist slot claimed`, `No-show recorded`.
