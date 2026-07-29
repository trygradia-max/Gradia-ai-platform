# Flow — Online Booking

_Created 2026-07-25 by the Organizer. No self-serve customer booking page exists today — bookings come only from voice proposals and quote acceptance (audit trace D). This flow depends on native availability._

**Maturity:** TARGET — requires E02 (Gradia DB as appointment source of truth D-013, availability engine, conflict hard-block for automatic paths D-015). Foundations that exist: appointments table, working-hours capacity math, conflict service (P0-003), public-page pattern from `/q/[token]`.
**Phase/Epic:** E02+ (earliest P2; likely ships alongside or after E03 polish).

## Entry point
Public shop booking page (shareable link, later embeddable); links from quotes, SMS confirmations, and the marketing site.

## User objective
A customer books a real, non-conflicting slot for a service without calling — and the owner doesn't get double-booked.

## Required data
Shop services eligible for online booking (per-service toggle + duration), working hours, availability (appointments + external busy time), customer name + phone (E.164) and vehicle basics; deposit rule if the service requires one (E05).

## Exact steps
1. Customer opens the booking page → picks a service (duration + price range from the live menu — one pricing module).
2. Availability engine returns open slots (working hours − existing appointments − external busy − buffer rules).
3. Customer picks a slot, enters name/phone/vehicle.
4. System re-checks the slot at submit (race-safe): automatic path **hard-blocks** conflicts (D-015) — "that slot was just taken", re-offer.
5. Booking policy per shop: **instant-confirm** (writes appointment directly — allowed because the slot check is deterministic and calendar-write-by-customer-request; still logged) or **request-mode** (stages a `book_appointment` approval, D-016 override rules apply). Default: request-mode until the shop opts into instant.
6. Confirmation SMS staged/sent through the one send path; reminder + no-show ladder arm.

## System decisions
- Slot math is 100% deterministic — no AI in availability.
- Conflict rule: automatic = hard-block, no override (D-015); owner-approved requests may override with documented reason (D-016).
- Deposit-required services route through the deposit step before confirmation (E05).
- Duplicate-submit protection: idempotent on (shop, phone, slot) within a window.

## AI involvement
None in the slot flow. Optional downstream: AI drafts the confirmation/follow-up (suggest-HITL or autopilot per shop mode; calendar write itself was customer-initiated and deterministic).

## Permissions
Public page (no auth) — rate-limited, token-scoped to the shop; owner/admin configure which services are bookable online.

## Error states
- No open slots → written state offering "request a time" (stages an approval) instead of a dead end.
- Slot taken at submit → immediate re-offer of nearest alternatives.
- Invalid phone → inline validation (E.164 normalize).
- Shop over capacity / paused → page shows honest paused copy, never a fake calendar.

## Empty states
- Shop with no bookable services: page is not published; owner-side setup screen explains what to enable first.

## Success state
Confirmed (or requested) booking with a real appointment row; owner sees it on Home "today/upcoming"; customer gets confirmation text.

## Next recommended action
Owner: nothing (that's the point) — exceptions surface in Approvals/Activity. Customer: add-to-calendar link.

## Mobile behavior
Customer page is mobile-first (single column, large slot targets); owner config lives in Receptionist/Settings per IA.

## Analytics events
`First appointment booked` (if a shop's first booking arrives this way); booking-source property distinguishes `online_booking` from voice/quote/manual.
