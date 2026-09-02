# E02-05 — Conflict enforcement default-on on the native model (D-015/D-016), external busy blocks as the conflict source

_Cut 2026-09-01 by the Organizer for autorun Batch 4 (`../program/autorun.md`). Specification only._

## Ticket ID
E02-05

## Epic
E02 — Native calendar and availability (phase P2)

## Status
**draft — batch-gated.** Autorun Batch 4, queue item 19. Enters after E02-04 is committed. Risk class **calendar** (booking-path semantics). Founder acceptance **YES** — this ticket *is* the production enablement of conflict enforcement that P0-004 left "NOT READY" pending founder manual acceptance. Decisions binding: D-015, D-016, D-013 — Approved. No open decision.

## Priority
P2 — High. P0-003/P0-004/P0-004A shipped a conflict service that is **OFF in production** (`NEXT_PUBLIC_GRADIA_CONFLICT_ENFORCEMENT` default false, `features.ts:70-74`); a voice/autonomous booking can still land on a taken slot in production. D-015 requires a hard block; D-016 requires recorded HITL overrides. With E02-01–04 the engine finally has a durable external-busy source, so enforcement can be turned on without the 3.5 s live-fetch dependency.

## Objective
Make conflict enforcement the default (flag becomes an opt-out kill switch), re-point the conflict service at `external_busy_blocks` instead of live provider fetches, mirror block-time outward, finalize D-015 (automatic paths hard-block) and D-016 (HITL warn + recorded override) on the native model, and lock both with tests.

## User outcome
A caller can no longer be booked over an existing job by the receptionist. When the owner approves a card that conflicts, the card says so, shows alternatives, and records that the owner overrode it. The owner's block-time shows up in their Google/Outlook calendar.

## Current code references
- Flag: `src/lib/features.ts:59-74` — `conflictEnforcement` getter on `NEXT_PUBLIC_GRADIA_CONFLICT_ENFORCEMENT`, build-time inlined, **default OFF**; reads at `src/lib/approvals.ts:571,867,1369`, `src/app/actions/jobs.ts:330,449`, `src/lib/availability.ts:374`; `.env.example:150`.
- Conflict gate: `approvals.ts:566` `evaluateConflictGate()` (flag short-circuit `:571`, `checkAvailability` `:581`, internal failure fail-closed `:594-620`); `recordAvailabilityOnCard()` `~:658`; `refreshConflictSummary()` `:686`; `CalendarExecutionContext` `:537-540` (`automatic|hitl`, decider).
- Serialized write: `src/lib/appointment-write.ts:74`; RPC `write_appointment_serialized` (`20260811120000_booking_atomicity.sql:64-120`, `p_enforce_conflicts` `:77`, in-lock overlap `:110-120`, busy semantics `:118`).
- Policy: `availability.ts:191` `resolveConflictPolicy()`, `blockingConflicts()` `:204`, `validateConflictOverride()` `:314`, `stagingAvailability()` `:356`, `emitConflictEvent()` `:418`.
- Live calendar leg to remove: `availability.ts:986-1024` (`fetchCalendarEventsBounded` `:831`, `DEFAULT_CALENDAR_TIMEOUT_MS` `:454`, degradation reasons `:93`). Replacement source: `external_busy_blocks` (E02-02/03/04).
- Owner-direct paths: `src/app/actions/jobs.ts:60-160` `ownerConflictGate()` (override record `:154`); `rescheduleJob` `:278`; `blockTime` `:409` (never mirrored — E02-02 added mirroring behind the seam; this ticket verifies + defaults it).
- Voice: `vapi-tools.ts:422-437` automatic refusal (D-015); E02-01 added alternatives.
- Tests that lock today's semantics: `eval/availability.test.ts`, `eval/conflict-enforcement.test.ts`, `eval/booking-atomicity.test.ts`, `eval/integration/conflict-enforcement.int.test.ts`, `eval/integration/booking-atomicity.int.test.ts`.
- P0-004 close record (`P0-004-conflict-enforcement-booking-paths.md`): "production enablement NOT READY — flag flip gated on founder manual acceptance + P0-004A" (P0-004A done 2026-08-11).

## Exact scope
1. **Flag semantics flip:** `conflictEnforcement` defaults **true**; `NEXT_PUBLIC_GRADIA_CONFLICT_ENFORCEMENT=false` becomes the explicit opt-out kill switch (rename to `NEXT_PUBLIC_GRADIA_CONFLICT_ENFORCEMENT_DISABLED=1` is acceptable if it removes ambiguity — document either way in `.env.example` + `runbooks/emergency-feature-shutdown.md`). The RPC's `p_enforce_conflicts` follows the flag as today.
2. **Conflict source = durable busy blocks:** `checkAvailability`'s calendar leg reads `external_busy_blocks` (shop-scoped range query, indexed) and drops the live provider fetch + 3.5 s timeout; `calendar: "unchecked"` now means "no connection / blocks stale beyond N minutes" (stale threshold from ADR-005), surfaced on the card as today's unverified summary. Own mirrors are excluded by construction (sweep never ingests tagged mirrors).
3. **D-015 hard block, every automatic path:** voice `proposeBooking`, agent-runtime/autopilot automations, quote-acceptance booking (`quote-response` → `book_appointment` staging), MCP `propose`/book tools, any cron-driven booking — table of paths + test per path. A blocked automatic booking stages **nothing knowingly conflicting**; voice offers alternatives (E02-01).
4. **D-016 HITL override, recorded:** approval card shows the conflict + alternatives; Approve on a conflicting card requires the explicit override affordance (existing `validateConflictOverride`), records decider (member identity from E01), timestamp, and the conflict snapshot in `action_decisions`; owner-direct drag/reschedule uses the same record (`jobs.ts:154`). Activity feed shows the "because" line only from recorded data (BUILD_REFERENCE §3).
5. **Block-time mirroring default-on:** owner blocks mirror as busy events through the seam when a calendar is connected (E02-02 wiring) — verify both adapters; blocks are `kind=block` rows (E02-02).
6. **Multi-day + span conflicts:** overlap math uses `ends_at` spans everywhere (engine + RPC busy range) — extend the RPC only if its overlap predicate ignores `ends_at` (check `20260811120000_booking_atomicity.sql:110-120`); if a migration is needed it is a `CREATE OR REPLACE` of the function only.
7. Docs: `runbooks/emergency-feature-shutdown.md` (kill switch), `08-security-and-reliability.md` conflict section, P0-004 ticket close record gains the "enabled in production by E02-05" line, `04-capability-map.md`.

## Explicit non-goals
- No new booking surfaces (online booking), no per-member conflicts (E04-05).
- No Aurinko removal / `nativeCalendarAuthority` flip (E02-06) — but this ticket must work with the flag in either state.
- No change to the serialized-write locking model (P0-004A).

## Dependencies
- E02-04 committed (both adapters feed `external_busy_blocks`). E02-01/02 (engine, `kind`, sweep). P0-004A done.
- Decisions: D-015, D-016 — Approved. Founder acceptance of production enablement is this ticket's step 5.

## Expected modules affected
`src/lib/features.ts`, `src/lib/availability.ts` (calendar leg), `src/lib/approvals.ts` (override recording + card summary), `src/app/actions/jobs.ts`, `src/lib/vapi-tools.ts` (verify), `src/lib/agent-runtime.ts`/`automations.ts` (automatic-path table), `src/lib/mcp/server.ts`, `src/app/actions/quote-response.ts` (staging path), possibly `supabase/migrations/<ts>_write_appointment_serialized_spans.sql`, `.env.example`, `runbooks/emergency-feature-shutdown.md`, `vercel.json` (none), tests.

## Database impact
None expected; at most a `CREATE OR REPLACE FUNCTION` for span-aware overlap (no table changes).

## Migration impact
Zero or one function-only migration (idempotent). Confirm at slotting.

## API impact
None external. Card payload gains `alternatives[]` (from E02-01) and `override` record fields.

## UI impact
ApprovalCard: conflict warning (icon + text, status-warning token), alternatives list, explicit "Approve anyway" override affordance with written consequence; Activity "because" line for overrides; calendar drag conflict dialog unchanged in shape.

## Permission impact
Override = owner/admin (D-048; techs cannot override — enforced server-side once E01-03 role checks exist).

## Tenant-isolation impact
Busy-block reads shop-scoped; tenant-isolation test: shop B's busy blocks never affect shop A's conflicts.

## Security impact
Positive: closes the production double-booking exposure. Kill switch documented.

## Idempotency requirements
Unchanged from P0-004A (`pending_action_id` idempotency); override record written once per decision (unique on `pending_action_id` + decision).

## Observability requirements
`booking_conflict_blocked_automatic` / `override_recorded` events continue via `emitConflictEvent`; counts on `/api/health`; SEV-3 alert if the block rate spikes (signal only — threshold noted, not tuned).

## Analytics requirements
None new.

## Feature flag
`conflictEnforcement` default **true**; env kill switch. (D-027: this is the graduation of a flagged high-risk capability to default-on with a documented shutdown path.)

## Automated tests
- Every automatic path in the scope-3 table: conflicting request → refused, nothing staged; non-conflicting → staged (unit + integration).
- HITL: conflicting card → Approve without override refused; with override → executes, `action_decisions` carries decider/snapshot; Activity renders from the record.
- Busy-block source: stale blocks → `unchecked` summary; fresh blocks → conflict; own mirrors excluded.
- Spans: multi-day appointment blocks every day it covers (engine + RPC).
- Kill switch: env set → gate short-circuits exactly as before; RPC `p_enforce_conflicts=false`.
- Regression: all P0-003/004/004A suites green **without modification** (locking tests never weakened — DoD B).

## Manual acceptance procedure
1. Builder (Preview): seed a 10:00–12:00 job; voice-propose 10:30 → refused with alternatives; an autopilot automation targeting 10:30 → nothing staged; quote-accept requesting 10:30 (automatic path) → refused per D-015 with the honest public-quote state and the owner notified (verify the `/q/[token]` copy).
2. Builder: create a conflicting card via a HITL path (owner agent draft) → card shows conflict + alternatives; Approve → refused; Approve anyway → booked, Activity shows the override with decider.
3. Builder: block 13:00–14:00 → appears in the connected Google/Outlook calendar; create an external event → after sweep, conflicts with it are detected without any live fetch (network to provider disabled in test).
4. Builder: set the kill switch on a local build → behavior reverts; unset → restored.
5. **Founder:** run steps 1–3 on the founder shop in Preview; **production enablement decision** recorded in `autorun-log.md` (PASS = enforcement ON at the next production deploy of the batch).

## Failure cases
- Busy blocks stale (sweep down) → conflicts still enforced against Gradia appointments; external side reported `unchecked` on the card; alert from the sweep (E02-02).
- RPC refusal after gate pass (race) → existing `refreshConflictSummary` honest re-run (`approvals.ts:686`).
- Override recorded but executor fails → existing reconciliation; no orphaned override without an appointment (test).

## Rollback strategy
Kill switch env → previous behavior at next deploy (build-time flag); or revert the PR. No data unwind (override records are inert history).

## Definition of done
`../12-definition-of-done.md` plus: automatic-path table with a test per row committed in the ticket close record; founder production-enablement decision recorded; P0-004 ticket close record amended; runbook + capability docs updated in the same change.
