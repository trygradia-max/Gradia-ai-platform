# P0-003 — Central appointment conflict service

- **Ticket ID:** P0-003
- **Epic:** E00 — Stabilization
- **Status:** in-review (implemented 2026-07-30 on `fix/p0-003-appointment-conflict-service` by Claude Builder; P0-002 gate was cleared 2026-07-30; awaiting Cursor Reviewer — completion record at the end of this file)
- **Priority:** High (audit: "double-booking is the product's core promise inverted"; risk class: **calendar** — counts against the high-risk WIP limit)

## Objective

Build ONE central availability/conflict service in `src/lib/` that answers: *"is this time range bookable for this shop, and if not, what conflicts with it?"* — consulting (a) existing `appointments` rows, (b) external-calendar busy times via the already-written-but-unused `listCalendarEvents`, and (c) working-hours/capacity from `working-hours.ts`. This ticket delivers the **service and its policy semantics only**; wiring call sites is P0-004.

## User outcome

Foundation for: a voice caller hears "that slot is taken"; an owner sees a conflict warning on an approval card and can override deliberately (recorded); autonomous paths refuse conflicting slots outright. (Owner-visible behavior arrives with P0-004.)

## Current code references

- Audit doc 04-D: "Missing: availability/conflict checking — anywhere. No path (voice, quote accept, drag-reschedule, block-time) queries existing appointments or calendar busy times before insert. `listCalendarEvents` exists but is unused by booking."
- `approvals.ts:663` (`executeBookAppointment`) and `:686-693` (hard Aurinko requirement) — future consumer, NOT modified here.
- `vapi-tools.ts:365` (`proposeBooking`) — future consumer.
- `aurinko.ts:502` (`createCalendarEvent` on `"primary"`); `listCalendarEvents` in the same module.
- `working-hours.ts` — validated per-day hours + capacity math (audit doc 03).
- `appointments` table: times, timezone, status enum, `[block-time]` convention (audit docs 04/05; `HOME_REDESIGN_PLAN.md` uses the `[block-time]` exclusion).
- Decisions: **D-015** (automatic scheduling hard-blocks conflicts), **D-016** (human-approved scheduling may allow a documented override), **D-013** (Gradia DB is becoming the appointment source of truth — design the service around `appointments` as primary, external busy as advisory input).

## Exact scope

1. New module (suggested `src/lib/availability.ts`): `checkAvailability(shopId, {start, end, excludeAppointmentId?})` returning a typed result — `available` | `conflict` with a structured list of conflicts (each: source `appointment|calendar|outside_hours|over_capacity`, ids, human-readable label). Never throws for "busy"; throws only on real errors.
2. Overlap query against `appointments` (exclude cancelled/closed statuses; include block-time rows; `excludeAppointmentId` supports reschedule checks). Time-zone-correct using the appointment row's stored timezone conventions.
3. External busy times via `listCalendarEvents` — **best-effort advisory**: if the calendar call fails or no calendar is connected, the service still answers from Gradia's own data and marks calendar coverage `unchecked` in the result (explicit field — no silent degradation; D-013 makes Gradia's DB the primary truth).
4. Working-hours/capacity check via `working-hours.ts` (outside-hours and over-capacity are distinct conflict kinds; policy for treating them as warn vs block is a caller decision, exposed in the result, not hidden in the service).
5. Policy helper encoding D-015/D-016: `resolveConflictPolicy(context: 'automatic' | 'hitl')` → `hard_block` | `warn_allow_override`. Overrides are the caller's job to record, but the service defines the `ConflictOverride` type (who, when, which conflicts) so P0-004 call sites record uniformly.
6. Unit tests (see below). No call-site changes anywhere.

## Explicit non-goals

- No wiring into booking/reschedule/block-time/voice/quote paths (P0-004).
- No softening of the hard Aurinko dependency at `approvals.ts:686` (E02/P2 scope).
- No native availability *rules* engine (bookable-slot generation, buffers, resources) — E02.
- No UI (P0-004 handles the approval-card warning).
- No changes to `appointments` schema.

## Dependencies

P0-002 (CI must gate before this merges). Decisions D-015/D-016: **approved** — no open decisions.

## Expected modules affected

New `src/lib/availability.ts` (+ its test file). Read-only imports from `aurinko.ts`, `working-hours.ts`, Supabase clients. Zero existing modules modified (a types file export is acceptable).

## Database impact

Read-only queries against `appointments`. Possible new index suggestion (`(shop_id, start_time)` or similar) — propose in the completion report; do NOT add a migration in this ticket unless query analysis shows it's needed at pilot scale (keeps the ticket non-database-sensitive).

## Migration impact

None (see above; any index lands as its own reviewed migration in P0-004 or later).

## API impact

None externally. New internal library API documented in the module header.

## UI impact

None.

## Permission impact

None. Service runs under the caller's client (RLS session or service-role); it must accept an explicit `shopId` and scope every query with it.

## Tenant-isolation impact

Every query `.eq("shop_id", shopId)` — this module will be called from service-role paths (webhooks, executors) where RLS does not backstop. Tenant-isolation test required.

## Security impact

None new. Calendar tokens are only touched via the existing `aurinko.ts` seam.

## Idempotency requirements

Pure read service — naturally idempotent. Result must be deterministic for identical inputs + data state.

## Observability requirements

`[availability]`-prefixed structured log line on calendar-fetch failure (the `unchecked` degradation must be visible in logs, not silent — this is a named exception to the codebase's quiet-degradation habit, per audit doc 09).

## Analytics requirements

None in this ticket (conflict-encountered/override events belong to P0-004 where user action exists).

## Feature flag

None — the service is inert until P0-004 wires callers (the wiring ticket carries the flag).

## Automated tests

- **Unit:** overlap math (exact-boundary touch = no conflict; containment, partial overlap, spanning = conflict); cancelled/closed exclusion; block-time inclusion; `excludeAppointmentId`; timezone edges (DST boundary day); outside-hours and over-capacity kinds; policy helper mapping (automatic→hard_block, hitl→warn_allow_override).
- **Failure-path:** `listCalendarEvents` throwing / no calendar connected → result carries `calendar: unchecked`, appointments still checked, no throw.
- **Tenant-isolation:** two shops with identical time ranges — shop A's check never sees shop B's appointments (fixture-level, service-role client).
- **Integration (DB tier):** one real-Postgres case via the un-quarantined tier: seed two overlapping appointments, assert conflict payload.

## Manual acceptance procedure

1. In a seeded dev shop, create two appointments 10:00–12:00 and 11:00–13:00 directly; call the service for 11:30–12:30 → conflict listing both.
2. Call for 12:00–13:00 against a 10:00–12:00 booking → available (boundary touch).
3. Disconnect calendar → service answers with `calendar: unchecked`, log line present.
4. Call with `context: 'automatic'` vs `'hitl'` → policy helper returns hard_block vs warn_allow_override.
5. Verify no existing booking path behaves differently (nothing is wired yet): book via approvals as before → unchanged.

## Failure cases

- Calendar API slow/hung → the service must bound the external call (timeout) so booking paths in P0-004 can't hang on it; on timeout → `unchecked`.
- Rows with null/legacy time fields → treated as non-conflicting but logged (never crash the check).
- Unknown status values → conservative: count as busy, log.

## Rollback strategy

Delete/revert the new module; nothing depends on it until P0-004. Zero data impact.

## Definition of done

All of `../12-definition-of-done.md` plus: service + policy helper exist with the typed result contract documented; full unit/failure/tenant test set green in gating CI; one DB-tier integration case green; no call sites modified; index recommendation (if any) written up for P0-004.

## Completion record (Builder, 2026-07-30)

**Branch:** `fix/p0-003-appointment-conflict-service` (base `origin/main`). Implemented by Claude Builder, 2026-07-30. Cursor Reviewer: _unassigned_.

**Delivered:**

- `src/lib/availability.ts` — `checkAvailability(supabase, shopId, {start, end, excludeAppointmentId?, override?, calendarTimeoutMs?})` → typed `AvailabilityResult` (`available`, structured `conflicts[]` with source `appointment|calendar|outside_hours|over_capacity`, ids, ISO ranges, human-readable label, block-time flag, bay resource when recorded, blocking/advisory severity, metadata; explicit `calendar: "checked"|"unchecked"` + reason). Overlap math is half-open `[start, end)` — boundary touch is not a conflict. Appointment end = `ends_at` when valid, else `scheduled_at + duration_minutes` (default 90). Busy statuses: everything except `closed` (cancelled rows are deleted by `executeCancelAppointment`); unknown statuses conservatively busy + logged; unparseable rows skipped + logged, never a crash.
- `resolveConflictPolicy('automatic'|'hitl')` → `hard_block` | `warn_allow_override` (D-015/D-016) and the `ConflictOverride` type (who/when/which conflicts) for uniform P0-004 recording. Passing an override NEVER suppresses detection — test-locked.
- External calendar via existing `listCalendarEvents` seam: best-effort advisory, bounded by a timeout (default 3.5s); not-connected/error/timeout → `calendar: "unchecked"` with an `[availability]`-prefixed log line (named exception to quiet degradation). Events mirroring Gradia appointments (`aurinko_event_id`) are deduped; a reschedule never collides with its own mirror.
- Working hours/capacity via `working-hours.ts`: distinct advisory conflict kinds computed per shop-local day (`shops.timezone`, Intl-based, UTC fallback logged); DST-boundary tested.
- Tenant isolation: every query `.eq("shop_id", shopId)`; service-role fixture test proves shop B's identical window never sees shop A's rows.

**Tests:** `eval/availability.test.ts` (40 unit/failure-path/policy/timezone cases) + `eval/integration/availability.int.test.ts` (4 real-Postgres cases: conflict payload for two seeded overlapping rows, boundary touch available, cross-tenant isolation, reschedule exclusion). No existing test touched.

**Validation (2026-07-30, local):** `npm test` 53 files / 457 passed / 4 skipped · `npx tsc --noEmit` clean · `npm run lint` clean · `npm run build` success · `npm run test:int` 2 files / 8 passed against local Supabase stack (CLI 2.98.2, the pinned version).

**Manual acceptance:** step 1 (two overlapping seeds → conflict listing both) and step 2 (boundary touch → available) executed as real-Postgres integration cases; step 3 (no calendar → `unchecked` + log) executed in integration (seeded shop has no calendar; reason `not_connected`) and unit (error/timeout paths + log assertions); step 4 (policy mapping) executed as a unit case; step 5 (no existing path behaves differently) verified by diff — zero existing modules modified — and by the pre-existing approvals integration suite staying green.

**Index recommendation (for P0-004):** the range query filters `(shop_id, scheduled_at)`; today's `appointments_shop_id_idx` + `appointments_scheduled_at_idx` are adequate at pilot scale. When P0-004 puts the check on every booking path, add a composite `CREATE INDEX appointments_shop_scheduled_idx ON appointments (shop_id, scheduled_at)` as its own reviewed migration.

**Known limitations (documented in the module):** 7-day lookback bounds how far back a still-overlapping long row can start; 1,000-row fetch cap logs when hit; capacity math clips busy ranges to local days in 15-minute quanta (advisory precision); Aurinko event times lacking a UTC offset parse in server-local time (advisory input only; mirror-dedupe removes Gradia-created events).

**Rollback:** revert the branch / delete the module + tests; nothing depends on it until P0-004; zero data impact.
