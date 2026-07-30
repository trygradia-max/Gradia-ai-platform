# E02 — Native Calendar and Availability

_Created 2026-07-25 by the Organizer. Phase: **P2**. Status: planned._

## Objective

Make Gradia's database the appointment source of truth (D-013): a native availability engine, booking that works with no external calendar connected, and Google + Microsoft calendars demoted to synchronized mirrors (D-014). Conflict policy per D-015/D-016 rides on the P0-003 conflict service.

## User outcome

A shop can take bookings on day one without connecting anything. When they do connect Google or Outlook, external busy blocks flow in, Gradia appointments flow out, and neither system double-books the other. The voice agent can finally say "that slot is taken — how about 2pm?"

## Business reason

Today booking hard-requires Aurinko/Google (`approvals.ts:686` fail-closed) — a shop without Google Calendar cannot confirm any appointment (audit doc 04-D). That's an adoption cliff at the exact first-value moment, and it makes an external vendor authoritative over Gradia's core object. Availability is also the prerequisite for online booking, recurring jobs, memberships, and fleets (E06) and for the receptionist quoting real slots.

## Current foundation

- `appointments` table with times, timezone, status machine, reminder/no-show ladder (audit docs 04-D, 05).
- P0-003 central conflict service + P0-004 enforcement across paths (built on current model).
- `working-hours.ts` validated per-day hours + capacity math; `blockTime` action.
- Aurinko client (`aurinko.ts`) with event CRUD, `listCalendarEvents`, token refresh; `/calendar` week view UI.
- Voice `propose_booking` tool + HITL executor pipeline.

## Missing work

1. Invert authority: `executeBookAppointment` writes the `appointments` row first, unconditionally; calendar event creation becomes best-effort sync, not a gate (remove the `approvals.ts:686` hard requirement).
2. Availability engine: slot computation from working hours + capacity + existing appointments + synced external busy blocks + block-time; queryable ("next 3 open slots for a 2h job").
3. External busy ingestion: pull/subscribe Google busy times via Aurinko; **Microsoft/Outlook support** (Aurinko is believed to support it — **requires verification** per the registry rule, before E02 ticket cutting; unbuilt — new OAuth surface).
4. Two-way sync reconciliation: external edits/deletes of a mirrored event → flag, never silently move the Gradia appointment; sync-state columns + repair sweep.
5. Voice + agent awareness: `propose_booking` and the owner agent consult availability before proposing (closes "AI scheduling PARTIAL" in audit doc 03).
6. Conflict policy finalization on the native model: automation hard-blocks (D-015); HITL warn-with-recorded-override (D-016).
7. Online-booking groundwork only: public availability read API shape (flow ships in E08/E09 era per `ui/flows/online-booking.md`).

### Calendar-parity annex (added 2026-07-27 — every item owned, none silently dropped)

Founder-required calendar parity items not named above, each tagged:

| Item | Owner |
|---|---|
| Buffers (prep/cleanup between jobs) | **Build in E02** — availability-engine input alongside working hours |
| Travel time (mobile jobs) | **Build in E02** — availability input using existing `location_type/address` fields; route *optimization* stays rejected |
| Multi-day work (PPF/wrap jobs spanning days) | **Build in E02** — appointment span support; required before E06 fleet visits |
| Day / month / agenda calendar views (week-only today) | **Build in E02** — UI parity on `/calendar` |
| Tentative holds & quote holds | **Deferred → E05** (holds bind to deposit/quote flow; quote-to-deposit flow owns them) |
| Drop-off / pickup times | **Deferred → E04** (job-day fields on the work-order layer) |
| Waitlists | **Deferred → E08-era online-booking flow** (needs public booking surface to be meaningful) |
| Cancellation policy handling | **Deferred → E05** (fee enforcement needs payments); plain cancel/reschedule ships in E02 |

Deferred items appear in their owning epic's missing-work list when that epic's tickets are cut; the Organizer carries this table forward.

## Domain entities

Modified: `appointments` (sync-state, external ref per provider, override audit fields). New: `calendar_connections` (per-provider, per-shop — lands in `shop_connections` if E01's slice exists), `external_busy_blocks` (or transient cache — ADR).

## Backend services

New `src/lib/availability.ts` (consumes P0-003 conflict service), calendar-sync module + repair cron. Modified: `approvals.ts` booking executor, `vapi-tools.ts:propose_booking`, `jobs.ts` reschedule, calendar data accessors.

## UI surfaces

`/calendar` gains availability shading + conflict/override badges + sync-status indicator; Receptionist setup shows "bookings work without a calendar — connect one to sync"; ConnectionTile for Google/Microsoft (3-state, per BUILD_REFERENCE §4); ApprovalCard conflict warning (from P0-004) now shows suggested alternative slots.

## Integrations

Aurinko (Google + Microsoft calendar). Provider seam rule holds: no Aurinko types outside `aurinko.ts` (principle #8). This epic delivers **`CalendarProvider`** (D-029/ADR-002) with Aurinko as its first adapter — Aurinko is classified **transitional** (D-030): core calendar records must not depend on Aurinko-specific identifiers (`aurinko_event_id` is mirror metadata); Google Calendar and Microsoft Graph capabilities are specified independently in `vendors/planned-evaluations/`, and direct provider integrations are a post-E02 evaluation (Q-21).

## Security implications

Public availability read API (groundwork) must leak no customer data — slots only, rate-limited. OAuth for Microsoft mirrors the existing CSRF-nonce pattern. Override actions recorded with member identity (D-016).

## Tenant implications

Availability queries are shop-scoped hot paths — add the composite indexes the audit flagged missing. Multi-member shops (E01): per-resource calendars are **out** (E04 territory); one shop calendar for now.

## Migration implications

Additive columns on `appointments`; new tables; backfill sync-state for existing Aurinko-linked rows. The authority inversion is a code-behavior change, not a data migration — flag-gated cutover.

## Product analytics

Lights up: `Calendar connected` (now optional, so it becomes a real funnel step), `First appointment booked` (bookable without prerequisites).

## Dependencies

E00 (P0-003/004). **E01 hard first (amended 2026-07-27):** E02 creates new tenant tables (`calendar_connections`, `external_busy_blocks`) — D-018 (tenancy before major schema expansion) binds here exactly as it does for E04/E05/E06; new tables are born against membership policies, not `owner_id`. Decisions: D-013–D-016 approved. Open: none blocking; ADR needed for busy-block storage shape and sync cadence; Aurinko-Microsoft capability verification (above).

## Risks

- Two-way sync is the classic corruption zone: reconciliation must be conservative (flag, don't auto-move) or we destroy trust in the core object.
- Removing the Aurinko gate changes confirmation-SMS/reminder assumptions built around calendar success — trace every consumer of `aurinko_event_id`.
- Microsoft OAuth review/verification lead time — start early.

## Non-goals

No per-tech/resource calendars (E04), no online self-serve booking page (later flow), no route planning for mobile jobs, no external calendar as source of truth ever again (D-013).

## Feature flags

`FEATURES.nativeCalendarAuthority` (cutover), `FEATURES.microsoftCalendar`.

## Testing requirements

Conflict/availability unit suite (DST, timezone, zero-length, adjacent slots); sync reconciliation tests (external delete/move/duplicate); booking-with-no-calendar E2E path; regression: reminders + no-show ladder fire identically post-inversion; voice eval: proposes only open slots.

## Rollout plan

1) Ship availability engine read-only (shading in UI). 2) Flip `nativeCalendarAuthority` on internal shop; watch sync repair sweep. 3) Pilot shops; 4) default on; 5) Microsoft flag after Google parity holds two weeks.

## Acceptance criteria

1. A shop with zero connected calendars books, reschedules, reminds, and completes an appointment end-to-end.
2. Autonomous/voice booking cannot create a conflict (D-015); HITL override is possible and recorded (D-016).
3. External busy time blocks Gradia slots within one sync cycle; external edit of a mirrored event raises a flag, never a silent move.
4. Voice agent offers only genuinely open slots on a seeded conflict scenario.
5. `approvals.ts` contains no hard external-calendar requirement (test-locked).
