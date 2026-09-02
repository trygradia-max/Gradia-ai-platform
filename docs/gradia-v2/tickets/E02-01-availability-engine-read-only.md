# E02-01 — Availability engine (read-only: open-slot computation, shading, voice alternatives)

_Cut 2026-09-01 by the Organizer for autorun Batch 4 (`../program/autorun.md`). Specification only._

## Ticket ID
E02-01

## Epic
E02 — Native calendar and availability (phase P2)

## Status
**draft — batch-gated.** Autorun Batch 4, queue item 15 (first E02 ticket). Enters only after Batch 3 is merged (autorun rule 6). Risk class **calendar (read-only leg — no booking-path write semantics change)**. Founder acceptance **YES** (Batch 4 rule: YES per ticket). Decisions binding: D-013, D-015, D-016 (approved), D-043, D-046. No open founder decision blocks it.

## Priority
P2 — High. Nothing in the repo can *offer* a slot: the voice agent only refuses a stated time (`vapi-tools.ts:422-437`), the calendar shows no availability, and every later domain (online booking, recurring work, memberships, fleets, E04 team scheduling) needs "next open slots for a 2h job" as a primitive.

## Objective
Add slot computation to the existing conflict service so Gradia can answer "when is the shop free?" — from working hours, capacity, buffers, travel time, block-time, existing appointments (including multi-day spans) and, once E02-02/03 land, external busy blocks. Read-only: this ticket changes what Gradia *proposes* and *shows*, never how a booking is written.

## User outcome
The owner sees free/busy shading on `/calendar` for the week. A caller who asks for a taken time hears "that's taken — we have 11:00 or 2:30 open" instead of only "is there another time?". The owner agent proposes real open slots when drafting a booking.

## Current code references
- `src/lib/availability.ts:868` `checkAvailability()` — conflict service (P0-003); three legs (appointments primary, Aurinko advisory, hours/capacity) per the header `:1-35`; `hoursAndCapacityConflicts()` `:705`, capacity math `:719,771-785`; `rangesOverlap()` `:440`; `appointmentBusyRange()` `:487`; `isBusyStatus()` `:509`; `APPOINTMENT_FETCH_LIMIT = 1_000` `:455`, fail-closed on truncation `:951-961`.
- **No slot-suggestion / next-available API exists anywhere in the repo** (verified 2026-09-01).
- `src/lib/working-hours.ts:69-105` `readWorkingHours()` — per-day hours live in jsonb `shops.settings.calendar.working_hours`; defaults 09:00–17:00 `:40-51`; `capacityMinutesFor()` `:111`. Writer `src/app/actions/working-hours.ts:18` (merge at `:41-49`).
- Block-time is an appointment row with `internal_note = "[block-time]"` — written `src/app/actions/jobs.ts:447`, detected `src/lib/data/calendar.ts:110`, rendered `src/components/gradia/calendar-week.tsx:242-477`. (First-class `kind` column arrives in E02-02 — this ticket reads the sentinel through one helper so the switch is a one-line change.)
- `appointments.ends_at` exists (`supabase/migrations/20260708120000_crm_foundation_c1.sql:246-265`) — multi-day spans are storable today but not treated as spans by the engine.
- Voice: `src/lib/vapi-tools.ts:374` `proposeBooking()` → `stagingAvailability()` `:426-430`; on conflict emits `booking_conflict_blocked_automatic` `:432-436` and refuses with "…is there another day or time that works?" `:437`.
- Calendar data: `src/lib/data/calendar.ts:57` `loadCalendarWeek()` (appointments only, `:66-75`); UI `src/components/gradia/calendar-week.tsx` (626 lines).
- Location fields for travel time: `appointments.location_type/address/travel_fee_cents` (`20260708120000_crm_foundation_c1.sql`).
- Tests to preserve: `eval/availability.test.ts`, `eval/booking-atomicity.test.ts`, `eval/appointment-changes.test.ts`, `eval/quote-booking.test.ts`.

## Exact scope
1. **Slot engine** in `src/lib/availability.ts` (extend, do not fork): `findOpenSlots(client, shopId, { durationMinutes, from, to, count, granularityMinutes })` → ordered open slots. Inputs: working hours + capacity (`working-hours.ts`), existing busy appointments incl. `ends_at` spans (multi-day), block-time rows, **buffers** (prep/cleanup minutes) and **travel time** (mobile jobs: a per-shop default travel allowance applied to `location_type = mobile` appointments) — both read from `shops.settings.calendar` (jsonb, additive keys `buffer_minutes`, `mobile_travel_minutes`; no migration). External busy blocks: consume `external_busy_blocks` when E02-02 introduces the table; until then the engine treats the calendar leg exactly as `checkAvailability` does (advisory, degradable) — one clearly named seam function so E02-02/03 only swap the source.
2. **Timezone/DST correctness:** all computation in the shop timezone (existing `appointments.timezone` / shop settings), unit-tested across DST transitions, zero-length and adjacent slots, spans crossing midnight and multiple days.
3. **`/calendar` availability shading** (read-only UI): week view renders open/busy/outside-hours bands from the engine; a written empty state for "no working hours set" (`strings.ts`). No new destination (D-046 ratified Calendar; nothing else moves).
4. **Voice alternatives:** `proposeBooking()` on a blocked slot calls `findOpenSlots(count: 3)` around the requested time and includes them in the spoken refusal ("…we have 11:00 or 2:30 open — does either work?"). Still refuses the conflicting slot (D-015) and still stages nothing knowingly conflicting. Eval fixture: seeded conflict scenario → the agent offers only genuinely open slots (E02 acceptance criterion 4).
5. **Owner agent / planner awareness:** the booking-drafting path in `agent-runtime.ts`/`owner-agent.ts` that proposes a `book_appointment` consults `findOpenSlots` before choosing a time; the approval card carries the availability snapshot exactly as today (`vapi-tools.ts:281-282,309,460`).
6. **Public-availability read shape (groundwork only):** define the DTO the future online-booking API returns (slots only — no customer data) as a type + one unit test; **no route is added**.
7. Working-hours settings UI gains buffer + travel-time fields (Receptionist/Advanced or the existing working-hours editor — Builder chooses the existing surface; no new page).

## Explicit non-goals
- No change to `executeBookAppointment`, `write_appointment_serialized`, the conflict gate, or any write path (E02-02/05).
- No external busy ingestion or sync (E02-02/03/04).
- No `appointments.kind` column or any migration.
- No per-member/resource availability (E04-05), no online-booking route (E08-era), no route optimization (rejected).
- No day/month/agenda views (E02-06).

## Dependencies
- Batch 3 merged (autorun ordering). E01-01 merged (new tables are born under membership RLS — none here, but the engine reads through session/`forShop` clients per ADR-003).
- Decisions: D-013, D-015, D-016, D-043, D-046 — all Approved. None open.

## Expected modules affected
`src/lib/availability.ts` (extend) · `src/lib/working-hours.ts` (buffer/travel readers) · `src/app/actions/working-hours.ts` · `src/lib/data/calendar.ts` · `src/components/gradia/calendar-week.tsx` (shading) · `src/lib/vapi-tools.ts` (`proposeBooking` alternatives) · `src/lib/agent-runtime.ts` / `src/lib/owner-agent.ts` (booking proposal consults slots) · `src/lib/strings.ts` · `eval/availability.test.ts` (+ new slot tests) · voice eval fixture.

## Database impact
None. Reads `appointments` (existing composite index `20260806120000_appointments_shop_scheduled_idx.sql`), `shops.settings` jsonb.

## Migration impact
None (explicit). The DB-sensitive WIP slot is not occupied.

## API impact
None externally. New internal function `findOpenSlots`. The public-availability DTO is a type only.

## UI impact
`/calendar` shading + legend; working-hours editor gains two numeric fields with written help text; voice/agent copy changes are CHARACTER text (persona-locked — eval covers it), not chrome.

## Permission impact
Owner/admin edit buffers and travel time (D-048 floor once E01-03 lands; owner-only today). Everyone who can see `/calendar` sees shading.

## Tenant-isolation impact
All reads shop-scoped (session client with `.eq("shop_id")` or `forShop`). Add one tenant-isolation test: slots for shop A never reflect shop B appointments.

## Security impact
None new. The public DTO must contain no customer/vehicle/lead data — asserted by a snapshot test.

## Idempotency requirements
Pure computation; no writes.

## Observability requirements
Log engine degradation (calendar leg unchecked, truncation) with the existing `[availability]` prefix; count slot queries for the voice path only if trivially available.

## Analytics requirements
None new (D-045 table lands with its own tickets).

## Feature flag
None — read-only additive computation; shading and voice alternatives are safe by construction. (Justification per D-027: nothing incomplete or high-risk is exposed; the flip of write semantics is E02-02's flag.)

## Automated tests
- Unit: slot computation across DST forward/back, midnight-crossing, multi-day `ends_at`, zero-length and adjacent appointments, buffers, travel time for mobile jobs, capacity > 1 overlap, block-time exclusion, truncation fail-closed.
- Tenant-isolation: cross-shop slot leakage negative.
- Voice eval: seeded conflict → offered slots ⊆ open slots; conflicting slot never staged.
- UI: shading renders from engine output; empty state when no hours.
- Regression: `eval/availability.test.ts` unchanged and green; `checkAvailability` behavior byte-identical (characterization test before refactor).

## Manual acceptance procedure
1. Builder: seed a shop with hours 09–17, capacity 1, a 10:00–12:00 job, a block 13:00–14:00, buffer 15 min; `findOpenSlots(120 min)` returns 14:15 (not 14:00) and nothing inside 10:00–12:15.
2. Builder: `/calendar` shows the three bands; remove working hours → written empty state.
3. Builder (voice simulator or eval harness): ask for 10:30 → refusal names two open alternatives; ask for 14:15 → staged normally.
4. **Founder:** on the batch preview, walk steps 1–3 on the founder's test shop and confirm the voice refusal wording; record PASS/FAIL in `autorun-log.md`.

## Failure cases
- Working hours missing → engine returns no slots + reason `no_hours`; UI empty state; voice falls back to today's behavior (asks for another time).
- Appointment fetch truncated → fail closed (no slots, reason `truncated`), same as `checkAvailability`.
- Timezone missing on shop → use existing default resolution; never compute in server-local time.

## Rollback strategy
Revert the PR; no data to unwind (jsonb keys are ignored by older code).

## Definition of done
`../12-definition-of-done.md` plus: characterization test proves `checkAvailability` unchanged; voice eval fixture committed; founder step 4 recorded PASS in `autorun-log.md`; `04-capability-map.md` + `program/capability-status.md` updated ("AI scheduling PARTIAL" → slots offered).
