# P0-004A — Appointment booking atomicity and concurrency

- **Ticket ID:** P0-004A
- **Epic:** E00 — Stabilization
- **Status:** **done** (2026-08-11 — merged to `main` in PR #15, commit `2103943`; CI `ci / checks` + `ci-integration / integration` green; independent Cursor review verdict **APPROVE** after one BLOCKER was found and fixed pre-merge; completion record at the end of this file. Production conflict enforcement remains **OFF** — `NEXT_PUBLIC_GRADIA_CONFLICT_ENFORCEMENT=false` or unset)
- **Priority:** High (risk class: **calendar** — shared the high-risk slot with the P0-003/P0-004 sequence; also **database-sensitive** — shipped migration `20260811120000_booking_atomicity.sql`)

> **Provenance note (Organizer, 2026-08-11):** this ticket was promoted out of `../program/backlog.md` Band 2 at the P0-004 close (2026-08-11) and implemented directly from **GitHub issue #13** plus the scope recorded in the P0-004 merge record — a ticket-file spec was never cut before implementation started. This file was written at close as the permanent record; the sections below describe the scope **as shipped**, reconstructed from the issue, the PR, and the review evidence. Recorded for accuracy, not as precedent — the `README.md` template rule (spec before pickup) stands.

## Objective

Make `executeBookAppointment` and the owner-direct scheduling writes atomic and concurrency-safe, so that P0-004's now-authoritative conflict system sits on an executor that cannot report success falsely, duplicate a booking on retry/replay, or lose the race between its availability check and its insert.

## User outcome

- An owner never sees "booked" for an appointment that was not actually persisted in Gradia.
- A retried or replayed approval can never create two appointments for one approved action.
- Two simultaneous bookings for overlapping slots at the same shop cannot both land (when conflict enforcement is on).
- An external calendar hiccup no longer makes a real Gradia booking look failed — it becomes a reconciliation condition instead.

## Gaps closed (from issue #13 / the P0-004 merge record)

1. **False "executed":** `executeBookAppointment` landed the lead and the external calendar event before the appointments insert and still reported "executed" if that insert failed (loud reconciliation log only).
2. **Duplicate / replay:** a retried approval execution could insert a second appointment for the same approved action.
3. **Partial-state ordering:** lead/calendar/appointment/audit writes could interleave so external side effects preceded durable Gradia state.
4. **Check→insert TOCTOU / concurrent-booking race:** the availability check and the insert were separate steps, so two concurrent overlapping bookings could both pass the check and both insert.

## What shipped (scope as merged, PR #15)

1. **Serialized transactional write RPC** — migration `supabase/migrations/20260811120000_booking_atomicity.sql` adds `public.write_appointment_serialized(...)`: takes a **transaction-scoped Postgres advisory lock** (`pg_advisory_xact_lock`) on a per-shop key, so appointment writes for one shop are serialized **across application instances**; re-verifies busy overlap under that lock; performs the insert/update in the same transaction. The advisory-lock key is tenant-scoped (shop id), so shops never contend with each other.
2. **Durable idempotency** — new column `appointments.pending_action_id` (uuid) with a partial unique index (`appointments_pending_action_id_unique`): each approval-backed booking stamps the `pending_actions` id it executed from, making replay/retry of the same approved action a no-op that returns the existing appointment instead of inserting a duplicate.
3. **Persistence-first ordering** — Gradia appointment persistence now **precedes** external calendar synchronization. External sync failures are **reconciliation conditions, not failed Gradia bookings**: the appointment stands, and the sync gap is surfaced for reconciliation rather than reported as a booking failure.
4. **Enforcement gating (`p_enforce_conflicts`)** — the RPC's overlap-refusal step is gated by a `p_enforce_conflicts` boolean argument wired to `FEATURES.conflictEnforcement`, so the transactional overlap refusal follows the same flag as the rest of P0-004 (see the review record below — this was the Cursor BLOCKER fix). **Advisory locking and durable idempotency remain active even when conflict enforcement is OFF** — they are correctness properties, not enforcement policy.
5. **Owner-direct paths** — `src/app/actions/jobs.ts` (drag-reschedule / block-time) routes through the same serialized write path via the new `src/lib/appointment-write.ts` seam; `src/lib/approvals.ts` (booking/reschedule executors) rewired onto it.

**Division of responsibility (deliberate):** the central availability service (`src/lib/availability.ts`, P0-003) remains the **application-level scheduling/conflict engine** — calendar-aware, advisory-snapshot-producing, policy-carrying. The RPC's overlap logic is only a **narrow transactional invariant** (last-line busy-overlap re-check under the lock). Do not grow the RPC into a second conflict engine.

## Explicit non-goals (held at close — now follow-ups)

See "Remaining follow-ups" in the completion record: owner-direct override audit ordering, stronger owner-direct retry idempotency, RPC `search_path` pinning, external-first cancellation ordering, and a proper calendar-sync reconciliation/outbox mechanism were **not** in this ticket's shipped scope.

## Dependencies

P0-004 (done 2026-08-11, PR #12). Decisions D-015/D-016 unchanged; D-012 (ALWAYS_HITL floor) untouched.

## Expected modules affected (as shipped)

`src/lib/approvals.ts` · `src/lib/appointment-write.ts` (new) · `src/app/actions/jobs.ts` · `src/lib/types/database.ts` · `supabase/migrations/20260811120000_booking_atomicity.sql` · test suites `eval/booking-atomicity.test.ts` (new), `eval/integration/booking-atomicity.int.test.ts` (new, real-Postgres), `eval/conflict-callsites.test.ts`, `eval/conflict-enforcement.test.ts`.

## Database / migration impact

One migration (`20260811120000_booking_atomicity.sql`): additive column `appointments.pending_action_id` + partial unique index + `write_appointment_serialized` RPC. Database-sensitive for WIP purposes (recorded retroactively on the board).

## API / UI / Permission impact

None owner-visible. No public API changes; no UI changes; permission model unchanged (executors still run under the existing approval model, ALWAYS_HITL floor untouched).

## Tenant-isolation impact

Advisory-lock key incorporates the shop id — serialization is per shop; the RPC's overlap re-check and idempotency lookup are shop-scoped. Covered in the integration suite.

## Idempotency / Observability requirements

`pending_action_id` provides durable idempotency for approval-backed bookings (replay returns the existing row). External-sync failures after persistence log as reconciliation conditions. Owner-direct paths' retry idempotency is **weaker** — follow-up 2.

## Feature flag

No new flag. The RPC's overlap refusal follows the existing `FEATURES.conflictEnforcement` (`NEXT_PUBLIC_GRADIA_CONFLICT_ENFORCEMENT`) via `p_enforce_conflicts`. Locking + idempotency are unconditional.

## Automated tests

- `eval/booking-atomicity.test.ts` (362 lines, deterministic): false-executed, replay, ordering, and gating behavior.
- `eval/integration/booking-atomicity.int.test.ts` (435 lines, DB tier): **real Postgres concurrency tests** — concurrent overlapping writes serialized by the advisory lock; idempotent replay under the unique index; enforcement-off behavior. Passed in `ci-integration / integration`.
- Extended `eval/conflict-callsites.test.ts` / `eval/conflict-enforcement.test.ts` for the rewired call sites; no locked test weakened.

## Rollback strategy

The migration is additive (column is inert if unread; RPC replaceable). Application rollback = revert PR #15. Conflict-enforcement posture is unchanged by this ticket (flag OFF in production).

---

## Completion record (docs-close session, 2026-08-11)

**Merged:** PR #15 → `main` as `2103943` ("fix: make appointment booking atomic and concurrency-safe"), 2026-08-11. Pre-squash branch commits: `522203f` (Builder implementation) → `31f410a` (Cursor review fix).

**Review evidence:** independent Cursor review verdict **APPROVE**. Cursor found **one BLOCKER** and it was fixed before merge (`31f410a`): the serialized database overlap refusal was still active when conflict enforcement was OFF — the RPC would refuse overlapping writes even with `FEATURES.conflictEnforcement` disabled, breaking the P0-004 dormancy guarantee. The fix added the **`p_enforce_conflicts`** argument so the overlap refusal follows `FEATURES.conflictEnforcement`; advisory locking and durable idempotency deliberately remain active regardless of the flag.

**CI:** final `ci / checks` **passed**; final `ci-integration / integration` **passed** (including the real-Postgres concurrency tests). One temporary CI failure occurred during the run: a **transient upstream Supabase/PostgREST test-fixture failure**, unrelated to the change — the rerun completed green. No gate was bypassed.

**What this closes:** the main booking **false-executed**, **duplicate/replay**, **partial-ordering**, and **check→insert concurrency** gaps from issue #13. Gradia appointment persistence now precedes external calendar synchronization; external sync failures are reconciliation conditions, not failed Gradia bookings; `pending_action_id` gives approval-backed bookings durable idempotency; transaction-scoped advisory locking serializes appointment writes per shop across application instances.

**Production enablement status:** conflict enforcement remains **OFF** in production — `NEXT_PUBLIC_GRADIA_CONFLICT_ENFORCEMENT=false` or unset; only the exact value `"true"` enables, build-time inlined (redeploy required to change). The P0-004A hardening gate on enablement is now satisfied; **the P0-004 founder manual Preview QA (ticket steps 1–7) still gates Production conflict-enforcement enablement** — the flag flip stays the release event per `../releases/README.md` §Standing rules.

### Remaining follow-ups (recorded, not scheduled — Organizer to sequence)

1. Move owner-direct override audit/telemetry **after** successful serialized persistence (today it can precede it on the owner-direct paths).
2. Add stronger owner-direct retry/idempotency handling for drag-reschedule and block-time (no `pending_action_id` equivalent on those paths).
3. Pin the RPC `search_path` (`write_appointment_serialized` currently relies on the default resolution).
4. Address external-first **cancellation** ordering (cancellation paths still touch the external calendar before durable Gradia state).
5. Add a proper calendar-sync **reconciliation/outbox mechanism** (persistence-first ordering surfaces sync gaps; nothing yet retries/repairs them systematically).
6. **P0-004 manual Preview QA** (founder, steps 1–7 on a flag-on Preview) still gates Production conflict-enforcement enablement.

**Sequencing at close:** P0-004A moves to **done**; **P0-005 (webhook event idempotency foundation) moves into the next active implementation position** (it was queued behind this ticket by the 2026-08-11 resequencing). P0-005 is not started.
