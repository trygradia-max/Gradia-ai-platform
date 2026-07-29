# Flow — Recurring Job Setup

_Created 2026-07-25 by the Organizer. Foundation exists but is unconsumed: `maintenance_schedule` jsonb arms on job completion (audit doc 03 "recurring services PARTIAL — no recurring booking"). Recurring jobs are their own domain, separate from memberships and fleets (D-017)._

**Maturity:** TARGET — armed maintenance schedules exist; no recurring booking engine or UI.
**Phase/Epic:** E06 / P6 (depends on E02 native availability; billing hooks optional via E05).

## Entry point
Job completion ("set up the 6-month follow-up"); customer/vehicle file; Whisper ("schedule Sarah every 8 weeks").

## User objective
Repeat work (maintenance washes, coating maintenance, seasonal details) books itself on a cadence instead of relying on the owner's memory.

## Required data
Customer + vehicle, service(s), cadence (interval or schedule), preferred day/time window, price basis (menu or fixed), end condition (until canceled / N occurrences), scheduling mode (auto-propose vs auto-book).

## Exact steps
1. Owner creates a recurring plan from a job, file, or Whisper → deterministic schedule preview ("next 3: Aug 21, Oct 16, Dec 11").
2. Mode choice: **propose** (default — each occurrence stages a booking approval near its date) or **auto-book** (only into conflict-free slots; hard-block on conflict per D-015, falls back to propose).
3. Each occurrence: availability engine picks/validates the slot → booking created per mode → confirmation + reminder ladder as usual.
4. Vehicle-driven variant: armed `maintenance_schedule` surfaces as a suggested recurring plan the owner accepts once (consumes the existing armed data).
5. Skip/reschedule an occurrence without breaking the series; cancel series any time.

## System decisions
- Occurrence generation is deterministic; no LLM in scheduling.
- Auto-book NEVER overrides conflicts (D-015); human reschedules may, documented (D-016).
- Cooldown/consent rules apply to occurrence notifications; customer STOP pauses notifications, not the owner-facing series.
- Idempotent occurrence creation (series id + occurrence date unique) — no double-booking on cron retry (D-023 pattern).

## AI involvement
Suggest-HITL for the confirmation/reminder message drafts and for proposing plans from maintenance schedules. Calendar writes: proposal mode = HITL; auto-book mode is deterministic-slot-only and logged with Undo (still subject to D-015).

## Permissions
Create/edit series: roles with scheduling rights (post-E01); cancel series: owner/admin or creator.

## Error states
- No available slot in the window → occurrence falls back to a staged proposal, flagged in Activity.
- Customer opted out of SMS → occurrence still books per mode; notification channel falls to email or none, stated on the card.
- Series conflict with a shop closure → occurrences re-proposed, never silently dropped.

## Empty states
- None yet: "No recurring work set up. Turn any finished job into a schedule."

## Success state
Series card showing cadence, next occurrence, and history; occurrences appear in calendar/Home like any booking.

## Next recommended action
Review the next staged occurrence; consider a membership if the customer would save (cross-link, no auto-conversion).

## Mobile behavior
Series creation is a short single-column form; occurrence approvals ride the normal mobile approvals loop.

## Analytics events
`First appointment booked` per normal booking; recurring-specific events (series created/occurrence auto-booked) proposed to the canonical set via decision queue.
