# E04-05 — Team scheduling: per-member working hours/capacity, per-resource availability, calendar member lanes, job scheduling rules

_Cut 2026-09-01 by the Organizer for autorun Batch 5 (`../program/autorun.md`). Specification only._

## Ticket ID
E04-05

## Epic
E04 — Jobs and team operations (phase P4) — **E04 exit ticket** ("a 3-person shop runs its day")

## Status
**draft — batch-gated.** Autorun Batch 5, queue item 24 (last ticket; Batch 5 completes here). Enters after E04-04 is committed. Risk class **calendar + database-sensitive** (availability semantics + new rows). Founder acceptance **YES — E04 exit: a 3-person shop runs its day** (autorun table). Decisions binding: D-015/D-016 (conflict policy extends to per-resource), D-013, D-048, D-036, E02 non-goal "per-tech/resource calendars (E04)". No open decision.

## Priority
P4 — High. E04 acceptance criterion 2 ("two members can be booked at the same hour; one member cannot be double-booked"). Capacity today is a single shop-level number in jsonb (`working-hours.ts:111 capacityMinutesFor`); the availability engine (E02-01) is one shop calendar.

## Objective
Extend the E02 availability engine from one shop calendar to per-resource: per-member working hours + capacity rows (feeding the engine), assignment-aware conflict detection (a member cannot overlap; the shop can, up to bays/capacity), calendar per-member lanes and a dispatch view, and scheduling rules when assigning (suggest members free at the slot; warn on member overlap with recorded override for HITL; hard-block for automatic paths per D-015). External calendars stay **shop-level mirrors** (no per-member external sync — E04 non-goal).

## User outcome
The owner drags a job onto Marcus's lane at 10:00; Gradia refuses because Marcus is on the PPF job until noon and suggests Priya, who's free. Two techs work two cars at 10:00 in two bays without a conflict. The receptionist still offers only genuinely open shop slots.

## Current code references
- Engine: `src/lib/availability.ts` — `checkAvailability` `:868`, `hoursAndCapacityConflicts` `:705` (capacity math `:719,771-785`), E02-01 `findOpenSlots`, E02-05 default-on enforcement, `external_busy_blocks` (E02-02); comment `:84` "No staff/resource schema exists yet".
- Working hours: `working-hours.ts:69-105` (jsonb per shop), `capacityMinutesFor` `:111`; writer `actions/working-hours.ts:18`.
- Serialized write RPC `write_appointment_serialized` (`20260811120000_booking_atomicity.sql:64-120`) — overlap check is shop-level by `shop_id` advisory lock; per-member overlap must be checked inside the same lock (extend the RPC with an optional member-ids array **or** enforce member overlap in a second serialized step under the same advisory lock — Builder proposes; executor semantics unchanged: booking never fails because of a member conflict on automatic paths — automatic paths book the shop slot without assignment; assignment is an owner action).
- Assignments (E04-02) `job_assignments`; ADR-004 job ref; member rows (E01-01).
- Calendar UI (E02-06 views) `calendar-*.tsx`; jobs board (E04-02); `ownerConflictGate` `actions/jobs.ts:60-160` + override record (D-016).
- Voice/agent booking: `vapi-tools.ts:374`, agent-runtime booking proposals — remain shop-level (no member assignment by AI).
- Specs: E04 epic §Missing work 3, §Risks (per-resource multiplies sync complexity — external stays shop-level), `ui/flows/team-setup.md` step 5/next action ("set their working hours").

## Exact scope
1. **Schema (additive):** `member_availability(id, shop_id, member_id, weekday, start_time, end_time, capacity_minutes?, effective_from, effective_to)` + `member_time_off(id, shop_id, member_id, starts_at, ends_at, reason)`; shop-level `resources` optional (bays) — **only if** ADR-004/E04-02 board needs bays as resources; else capacity stays the shop number. RLS membership; generated types.
2. **Engine extension:** `findOpenSlots`/`checkAvailability` accept `{ resource: { memberIds?: [] } }`: shop-level checks unchanged; member-level: hours, time-off, existing assignments' busy ranges (job spans + buffers + travel) → a member overlap is a **blocking** conflict for that member; shop capacity still governs concurrent jobs. Tests: overlap allowed across members, blocked within one (E04 acceptance criterion 2), DST, spans.
3. **Assignment-time rules (E04-02 actions extended):** assigning a member to a job checks member availability: HITL (owner/admin) → warn + recorded override (D-016 pattern via `ownerConflictGate`); automatic paths never assign. Suggest free members for the slot in the picker (from the engine).
4. **Serialized invariant:** member double-booking prevented under the same per-shop advisory lock (RPC extension or serialized step) so two admins cannot race the same tech into two jobs; idempotent with `pending_action_id`-style keys where applicable.
5. **Calendar member lanes:** day/week views gain a "by member" mode (lanes per active member + unassigned lane); drag onto a lane = assign + reschedule (owner-direct, conflict-gated); dispatch view (E04-02 board) uses the same data.
6. **Per-member hours UI:** Settings → Team → member → working hours + time off (admin+; members may edit their own hours if the shop allows — keep admin+ only in this ticket); written empty state ("Uses the shop's hours until set").
7. **Receptionist unaffected:** voice/agent continue to offer shop-level slots; if the shop's capacity is derived from active members' hours (option in settings: "capacity follows staff on shift" — default off), the engine computes shop capacity per time from member rows; default stays the shop number.
8. **E04 exit rehearsal docs:** `ui/flows/team-setup.md` LIVE, `ui/flows/job-completion.md`, `06` (calendar lanes), `04`, capability-status, `03` §5/§6 status; E04 epic acceptance criteria 1–4 recorded.

## Explicit non-goals
- No per-member external calendar sync (external mirrors stay shop-level). No route optimization. No payroll/timeclock. No customer-visible tech tracking.
- No AI-driven assignment; no change to voice/agent booking semantics beyond reading shop capacity.
- No bays/resources unless already required by ADR-004.

## Dependencies
- E04-04 committed. E04-02 (assignments), E02-01/02/05 (engine, busy blocks, enforcement), E01-01 (members).
- Decisions: D-015, D-016, D-013, D-048, D-036 — Approved.

## Expected modules affected
New: migration(s) (`member_availability`, `member_time_off`), `src/lib/member-availability.ts`, `actions/member-availability.ts`, components `member-hours-editor.tsx`, calendar lanes mode, `eval/member-availability.test.ts` (+ integration). Modified: `src/lib/availability.ts`, `working-hours.ts` (capacity-follows-staff option), `actions/assignments.ts` (rules), `actions/jobs.ts` (`ownerConflictGate` member-aware), RPC migration if extended, `job-card-sheet.tsx` picker suggestions, calendar views, Team card, `strings.ts`, docs.

## Database impact
Two additive tables (+ optional RPC `CREATE OR REPLACE` for member overlap); indexes `(shop_id, member_id, weekday)`, `(shop_id, member_id, starts_at)`.

## Migration impact
One to two additive, idempotent migrations with rollback files; **occupies the DB-sensitive slot**; the high-risk calendar slot as well.

## API impact
Server actions; engine API extension (internal).

## UI impact
Member lanes mode, hours editor, picker suggestions, override dialog (existing pattern); DoD F states; mobile: lanes collapse to a member filter.

## Permission impact
Hours/time-off: admin+; assign with override: admin+; techs view their lane only (E04-04 scoping).

## Tenant-isolation impact
Member rows shop-scoped; engine member queries scoped; tests (member of shop A never appears in shop B lanes/suggestions).

## Security impact
None new.

## Idempotency requirements
Assignment + reschedule under the advisory lock; idempotent re-application; hours upsert idempotent per (member, weekday, effective range).

## Observability requirements
Conflict events gain a `resource=member` dimension (`emitConflictEvent`); override records carry member context.

## Analytics requirements
None new (candidates recorded in 14).

## Feature flag
`FEATURES.teamScheduling` — separately flippable from `teamOperations` (E04 epic); default on for pilots with crews; off → shop-level behavior exactly as E02.

## Automated tests
- Engine: member overlap blocked, cross-member allowed, capacity interplay, time-off, hours fallback to shop, DST/spans, buffers/travel per member.
- Race: two concurrent assignments of one member to overlapping jobs → one succeeds (integration, real Postgres).
- HITL override recorded; automatic paths never assign (assertion on voice/agent booking paths).
- Tenant isolation; regression: E02 suites unchanged with the flag off; `eval/jobs.test.ts`.

## Manual acceptance procedure
1. Builder: set hours for two techs; book two 10:00 jobs; assign each to a different tech → allowed; assign the second to the first tech → warn + override path; race test via script → one wins.
2. Builder: calendar by-member lanes; drag a job across lanes; unassigned lane; mobile filter.
3. Builder: voice booking still offers shop-level slots; with "capacity follows staff" on, a day with no staff hours offers no slots.
4. **Founder — E04 exit ("a 3-person shop runs its day"):** on Preview with the 3-member shop: owner sets hours and assigns the day from the board; each tech runs their jobs (My day, checklists, signature); customer share links; no double-booking possible; PASS/FAIL in `autorun-log.md`. `- NEXT: BATCH COMPLETE — Batch 5` only after PASS.

## Failure cases
- Member with no hours → falls back to shop hours (written); time-off overrides.
- RPC extension conflicts with E02-05's span predicate → single `CREATE OR REPLACE` keeps both; suites lock.

## Rollback strategy
Flag off → shop-level engine; tables inert; RPC extension backward-compatible (optional argument); revert commit.

## Definition of done
`../12-definition-of-done.md` plus: E04 acceptance criteria 1–4 evidenced across E04-02/03/04/05 in the close record; race test committed; founder E04-exit acceptance PASS recorded; flows/IA/capability/domain docs updated; the private-beta bar under D-036 ("an established shop can run on Gradia") recorded as met in `program/release-calendar.md` by the Organizer at closeout (noted, not done by the Builder — `program/*.md` is Organizer-only).
