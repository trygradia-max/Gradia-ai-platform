# Program — Current Sprint

_Created 2026-07-25 by the Organizer. Sprint 1 (P0 Stabilization). Started 2026-07-25 · target: alpha 2026-08-07 (**date-vs-gate policy open — Q-25 in `decision-queue.md`**; do not silently relax the P0 exit gate). Governs live sprint state; tickets in `../tickets/`, limits also mirrored in `work-in-progress.md`._

## Sprint goal

Land the two tickets that everything else depends on — **P0-001** (the leaked database credential is rotated and scrubbed from the working tree) and **P0-002** (CI can actually stop a broken build from reaching `main` = production). Nothing from P1+ enters this sprint. Sprint 1 contains **only P0 stabilization work** (epic E00).

Rationale: audit doc 00 names the credential leak the single most serious issue; audit doc 12 orders it first ("nothing else ships until 1–2 land"). P0-002 must complete before any other ticket enters review, because reviewers need a CI that can fail.

## Active implementation tickets

| Ticket | Title | Status | Risk class | Builder | Reviewer |
|---|---|---|---|---|---|
| P0-001 | Exposed database credential remediation | **in-review** (accuracy update 2026-08-06: **merged to `main` 2026-07-30** in PR #8, commit `6adc21c` — the credential is out of HEAD and the regression lock is live in CI; still held out of done pending founder acceptance steps 2 & 6 and formal Reviewer sign-off; Q-01 history decision open) | **Security (standard)** — reclassified 2026-07-27: the ticket declares no schema/migration impact, so it does NOT occupy the DB-sensitive slot (WIP definition = tables/indexes/RLS/migrations) | Claude Builder (session 2026-07-29) | _unassigned — one Cursor Reviewer_ |
| P0-002 | CI typecheck, lint, build and integration enforcement | **done** (2026-07-30 — merged to `main` in PR #9, commit `7e3d530`; Cursor Reviewer verdict APPROVE, no BLOCKER/HIGH findings; completion record in the ticket file) | Standard | Claude Builder | Cursor Reviewer (APPROVE) |

Founder action inside P0-001: the actual password rotation happens in the Supabase dashboard — only the founder can do it. The Builder prepares everything around it (scrub `.gitignore:46`, env updates, delete `.env.local` backups, verification steps). The git-history-scrub sub-step is **blocked** on decision Q-01 (see `blocked.md`) — rotation is NOT blocked by it.

## Queued behind this sprint

- **P0-003** (Central appointment conflict service) — **done 2026-08-06**: merged to `main` in PR #10 (`00091db`), Cursor Reviewer APPROVE, CI + DB integration green. The service (`src/lib/availability.ts`) is **inert until P0-004 wires it** — no booking path changed, no migrations. Merge/review record in the ticket file.
- **P0-004** (Conflict enforcement across booking and scheduling paths) — **done 2026-08-11**: merged to `main` in PR #12 (`3b6d044`), CI + DB integration green; independent Cursor final review **merge APPROVE · production enablement NOT READY** (verdict supplied to the Founder outside the GitHub PR trail — the PR carries no review artifact); fix rounds `d43ce16` (Cursor) and `c0b66b1` (founder rollout/failure-policy) on-branch. Enforcement is **dormant in production** (`NEXT_PUBLIC_GRADIA_CONFLICT_ENFORCEMENT` unset = OFF); production enablement is a separate gate: founder manual QA (steps 1–7) on a flag-on Preview **plus** the P0-004A hardening below. Merge/review record in the ticket file.
- **P0-004A** (Appointment booking atomicity and concurrency) — **done 2026-08-11**: merged to `main` in PR #15 (`2103943`; pre-squash `522203f` Builder → `31f410a` Cursor fix); `ci / checks` + `ci-integration / integration` green including real-Postgres concurrency tests (one transient upstream Supabase/PostgREST fixture failure; rerun green); independent Cursor verdict **APPROVE** — one BLOCKER (serialized overlap refusal active with enforcement OFF) found and fixed pre-merge via `p_enforce_conflicts`. Closes the booking false-executed, duplicate/replay, partial-ordering, and check→insert concurrency gaps; advisory locking + `pending_action_id` idempotency stay active even with enforcement OFF. Production conflict enforcement remains OFF. Completion record: `../tickets/P0-004A-appointment-booking-atomicity-concurrency.md`.
- **P0-005** (Webhook event idempotency foundation) — **done 2026-08-13**: merged to `main` in PR #17 (`e1dedfb`; pre-squash `dec4c38` Builder → `ec28a5a` ADR docs/review); independent Cursor verdict **APPROVE**, no BLOCKER or HIGH code defects (ADR-001 C1); founder production duplicate audit **zero rows** on both ledgers (C7); retention follow-up **P0-005A** filed (C2). Durable `provider_events` claiming + ledger uniques + SELECT-only ledger RLS live; P0-006/007 route wiring deliberately not started. Staging manual acceptance still gates full rollout acceptance of the migrations. Close record: `../tickets/P0-005-webhook-idempotency-foundation.md`.
- **P0-005A** (provider_events retention and pruning) — **filed 2026-08-13** per ADR-001 C2 (`../tickets/P0-005A-provider-events-retention-pruning.md`); ready, unscheduled — must land before P0-006/007 receipt volume makes the claim table operationally significant.
- **P0-006** (Twilio inbound replay protection) — **done 2026-08-14**: merged to `main` in PR #19 (`76847e4`; pre-squash `afb542b` Builder → `89af55c` metering retry-safety fix — a real reliability bug CI exposed, not a review fix); CI green (`ci / checks` + `ci-integration / integration` + Vercel/Preview); independent Cursor verdict **APPROVE / safe to merge**, no BLOCKER or HIGH findings, no review-fix commit required; founder real-Twilio staging acceptance completed pre-merge (valid inbound, MessageSid replay, STOP flow + STOP-SID replay, invalid-signature rejection). Twilio inbound SMS route now claims `provider_events` strictly after signature verification (ADR-001 C3 satisfied for this route); no new migration; status/A2P callbacks remain P0-008. One accepted residual: a provider retry after a genuine metering-write failure may re-run the classifier (non-blocking; optional optimization). Close record: `../tickets/P0-006-twilio-inbound-replay-protection.md`.
- **P0-007** (Vapi transcript and usage replay protection) — now the **next implementation position**, but **blocked** until the `docs/close-p0-006` planning closeout lands on `main` (entry in `blocked.md`; the Organizer flips it to ready on merge). ADR-001 C3 + C5 bind its scope: claim strictly after verification (test-locked) and an explicit route `maxDuration` with `staleAfterSeconds` strictly above it. Occupies the payment/metering high-risk slot when it starts. Not started.

## WIP limits (restated, binding)

| Limit | Rule | Current state |
|---|---|---|
| Active implementation tickets | max **2** | 1 active (P0-001 in-review); P0-002/P0-003/P0-004/P0-004A/P0-005/P0-006 done (latest: P0-006, 2026-08-14, PR #19) — one slot free, reserved next for P0-007 (blocked pending closeout merge) ✓ |
| Database-sensitive tickets active | max **1** | **0** — P0-006 shipped no migration (rode the P0-005 schema); slot free (ADR-001 expects P0-007 to add no schema — its ticket predates P0-005 and lists a migration; reconcile at slotting) ✓ |
| Payment / tenancy / calendar high-risk tickets active | max **1** | 0 — free since the P0-004A close (2026-08-11); P0-005/P0-006 did not occupy it; P0-007 (payment/metering class) will when slotted ✓ |
| Roles per ticket | exactly one Builder + one Reviewer | slots defined above ✓ |
| Entry condition | no ticket enters implementation until dependencies and decisions are resolved | P0-001/P0-002 have no unresolved blockers (Q-01 blocks only the optional history-scrub sub-step) ✓ |

## Definition of sprint success

1. P0-001 done: old credential fails to connect; `.gitignore:46` line gone from HEAD; backup env files deleted; rotation documented (per the ticket's DoD).
2. P0-002 done: a deliberate type error fails CI; lint + `next build` run on every push; `ci-integration.yml` runs green without `continue-on-error`. — **MET 2026-07-30** (PR #9; secret hygiene, typecheck, lint, deterministic tests, build, and DB integration all blocking; GitHub requires `ci / checks` + `ci-integration / integration` on `main`; evidence in the ticket's completion record).
3. Both pass Cursor Reviewer sign-off against `12-definition-of-done.md`.
4. `blocked.md` and `decision-queue.md` updated with anything discovered mid-sprint.

## Carry-over rules

- An unfinished ticket carries into Sprint 2 **keeping its slot** — it is not re-scoped mid-flight.
- A ticket that fails review returns to in-progress under the same Builder; it does not free a WIP slot.
- If a founder decision blocks a ticket mid-sprint, the ticket moves to `blocked.md` and its slot frees; the Organizer may promote the next ready ticket that respects the limits.
- Scope discovered mid-ticket goes to `backlog.md` as a follow-up ticket — never absorbed silently.
