# Flow — Fleet Visit

_Created 2026-07-25 by the Organizer. Nothing exists today (no company/fleet entities — audit doc 03 has no fleet rows; customers are individuals). Fleets are their own domain, separate from recurring jobs and memberships (D-017)._

**Maturity:** TARGET.
**Phase/Epic:** E06 / P6 (depends on E01 for company/contact modeling, E02 availability, E04 multi-vehicle work orders; invoicing via E05).

## Entry point
Fleet account page → "Schedule a visit"; or a standing fleet schedule generating visits.

## User objective
Service a business account's vehicles (dealership lot, rental fleet, company trucks) as one visit with per-vehicle records and one invoice.

## Required data
Fleet account (company, billing contact, terms, location(s)), vehicle roster (target: VIN/plate — schema gap today: no VIN column anywhere, E03 adds it), services per vehicle or per-visit package, visit date/window, PO/reference if required.

## Exact steps
1. Owner creates the fleet account (company + contacts + billing terms) and imports/enters the vehicle roster.
2. Schedule a visit: pick date window → availability engine blocks the capacity (visits consume more than one slot).
3. Build the visit manifest: which vehicles, which services each (defaults from the account's service agreement).
4. Visit day: per-vehicle work orders checked off (E04 checklists/assignments); exceptions noted per vehicle (damage found, skipped — with reason).
5. Visit completion rolls up per-vehicle records into one visit summary.
6. **(E05)** One consolidated invoice on account terms (net-15/30) → immutable payment events on payment (D-024).
7. Standing schedules (weekly lot wash) generate visits via the recurring engine — fleet cadence lives on the account, not per vehicle.

## System decisions
- Company ≠ customer: fleet accounts are company entities with contacts; per-vehicle history still accrues.
- Capacity math treats a visit as bulk load; conflicts hard-block automatic scheduling (D-015).
- Account terms/pricing are deterministic overrides of the menu (documented per account).
- Invoice consolidation rules in code; no AI pricing.

## AI involvement
Suggest-HITL at the edges only: visit-summary drafting for the billing contact, win-back for lapsed accounts. Scheduling, manifests, invoicing: deterministic. Money/calendar ALWAYS ask (D-021).

## Permissions
Fleet accounts + terms: owner/admin. Visit execution: assigned members (E04 roles). Invoicing: owner/admin.

## Error states
- Roster vehicle missing at visit → marked skipped-with-reason, never silently dropped from the invoice.
- Capacity insufficient for the window → visit refuses to auto-schedule; owner picks split dates.
- Invoice dispute → adjustments as new immutable events (credit memo), never edits.

## Empty states
- No fleet accounts: "No business accounts yet. Add a company to service whole fleets on schedule."

## Success state
Completed visit: N vehicles serviced, exceptions listed, one invoice issued — every line traced to a per-vehicle work order.

## Next recommended action
Send the invoice (approval); set/confirm the standing schedule.

## Mobile behavior
Visit-day manifest is the crew's phone surface: check-off list per vehicle, photo capture, exception notes offline-tolerant (PWA, E08).

## Analytics events
`First payment collected` (if applicable); fleet-specific events (account created / visit completed) proposed to the canonical set via decision queue.
