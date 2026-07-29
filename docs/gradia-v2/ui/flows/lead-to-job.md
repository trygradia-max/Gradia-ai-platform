# Flow — Lead to Job

_Created 2026-07-25 by the Organizer. Grounded in audit traces E (lead intake), C (quote lifecycle), D (booking) and the 6-stage pipeline. This is the spine of the product._

**Maturity:** PARTIAL — inbound → classify → staged lead/reply → approve → pipeline → quote → book all exist; known gaps: no conflict check on any booking path (P0-003/P0-004), quote-accept forks a duplicate lead and quotes never close (P0-009), pre-approval work nearly invisible on the board.
**Phase/Epic:** Live today; P0 tickets repair the seams.

## Entry point
Inbound SMS/email/call webhook; or manual: pipeline board "New lead" quick-create; or Gradia Agent / Whisper staging `create_lead`.

## User objective
A stranger who reached out becomes a booked, scheduled job with nothing falling through the cracks.

## Required data
At least one channel identity (phone/email); service interest; vehicle (optional, improves quoting); a time for booking.

## Exact steps
1. Inbound message → signature-verified webhook → `findOrCreateCustomer` → interaction recorded → consent ledger updated.
2. Classifier (Haiku, rate-limited) detects lead intent → stages `create_lead` + a drafted reply as approvals.
3. Owner approves in `/approvals` → `executeCreateLead` creates customer/vehicle/lead, moves stage to `new`; reply sends through the ONE send path (A2P gate, quiet hours, STOP).
4. Pipeline advances by code events only: quote sent → `quote_sent`; follow-up timer sweep → `follow_up`; booked; lost.
5. Owner builds a quote (see quote flow) → send stages + executes as owner → public accept page.
6. Customer accepts with a time → `book_appointment` staged → owner approves → calendar event + appointment row + confirmation SMS staged.
7. Job proceeds through the status machine to completion (see `job-completion.md`).

## System decisions
- Every customer-facing outbound is HITL-staged; money + calendar ALWAYS ask (D-011/D-012/D-021).
- **(P0-004)** Booking paths consult the conflict service: automatic paths hard-block (D-015); approval cards show a conflict warning with documented override (D-016).
- **(P0-009)** Quote acceptance resolves the quote's existing lead (no duplicate card); quote closes to booked; expired quotes refuse acceptance.
- Cooldowns and opt-outs enforced at audience and send time.

## AI involvement
Suggest-HITL throughout (classification, reply drafts, follow-up drafts). Package 2 autopilot may auto-execute staged follow-ups through the same executor — never money/calendar.

## Permissions
Owner today. Post-E01: members can work leads per role; approving outbound/booking restricted to roles with approval rights.

## Error states
- Classifier failure: SMS skips (no card); email currently inverts to "is a lead" (flagged for E07 polarity fix) — never silent data loss either way.
- Send held by policy (quiet hours) → stays visible in `/approvals` as held, with the reason.
- Booking execution failure → approval rolls back to pending (never half-booked silently).

## Empty states
- Pipeline empty: "No leads yet. Your first inbound text or call will land here — or add one yourself."

## Success state
Lead card reaches `booked` with the appointment on the calendar, confirmation staged/sent, and the whole trail visible in Activity with "because" lines where the decision log has data.

## Next recommended action
Reminder + no-show ladder arm automatically; owner sees the booking in today's list on Home.

## Mobile behavior
Quick-create, approvals, and board moves all phone-usable; approve-from-notification is the target loop (<60s capture→approve→send per GO_LIVE_CHECKLIST NOW-4).

## Analytics events
`First lead received` (first inbound-created lead), `First customer created`, `First quote sent`, `First appointment booked`, `First AI action approved` (first approval executed).
