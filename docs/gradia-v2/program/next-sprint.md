# Program — Next Sprint

_Created 2026-07-25 by the Organizer. Sprint 2 candidate scope — contingent on Sprint 1 completing (P0-001 + P0-002 done and reviewed). Not started; the Organizer promotes this to `current-sprint.md` when Sprint 1 closes._

_Updated 2026-07-30: **P0-002 is done** (merged PR #9, reviewed APPROVE — evidence in the ticket's completion record). The P0-003 entry condition below is therefore satisfied: P0-003 is the **next active implementation ticket** and may be slotted as soon as WIP limits allow. Implementation has not started. P0-001 remains in-review, so Sprint 1 is not yet closed._

## Candidate scope (all E00 / P0)

### Track A — Scheduling correctness (calendar high-risk slot)

| Ticket | Title | Notes |
|---|---|---|
| P0-003 | Central appointment conflict service | **Done 2026-08-06** — merged PR #10 (`00091db`), Cursor APPROVE; service inert until P0-004. Merge/review record in the ticket file. |
| P0-004 | Conflict enforcement across booking and scheduling paths | **Done 2026-08-11** — merged PR #12 (`3b6d044`), CI green; independent Cursor final review **merge APPROVE · production enablement NOT READY** (verdict supplied to the Founder outside the PR trail). Enforcement dormant behind `NEXT_PUBLIC_GRADIA_CONFLICT_ENFORCEMENT`; enablement gated on founder manual QA + P0-004A. Merge/review record in the ticket file. |
| P0-004A | Appointment booking atomicity and concurrency | **Done 2026-08-11** — merged PR #15 (`2103943`), CI + real-Postgres concurrency tests green; independent Cursor verdict APPROVE (one BLOCKER fixed pre-merge: `p_enforce_conflicts` so the RPC's overlap refusal follows `FEATURES.conflictEnforcement`; locking + idempotency stay active regardless). Production conflict enforcement remains OFF; founder manual Preview QA still gates enablement. Completion record in the ticket file. |

### Track B — Idempotency chain

| Ticket | Title | Notes |
|---|---|---|
| P0-005 | Webhook event idempotency foundation | **Next active implementation position** (P0-004A closed 2026-08-11). Database-sensitive (unique indexes / dedupe strategy migration) — occupies the **one** DB-sensitive slot when it starts. Not started. |
| P0-006 | Twilio inbound replay protection | Depends on P0-005; starts only when P0-005 is done. |
| P0-007 | Vapi transcript and usage replay protection | Depends on P0-005; sequenced after P0-006 or in its slot, respecting the max-2 active limit. |

## Selection rules

1. **Max 2 active at any moment** — the expected cadence is one Track A ticket + one Track B ticket concurrently (e.g. P0-003 + P0-005), each with its own Builder and Reviewer.
2. P0-003/P0-004/P0-004A share the calendar high-risk slot and are strictly sequential (policy implemented in 003, wired in 004, executor hardened in 004A).
3. **P0-004A precedes P0-005** (2026-08-11 resequencing — harden the now-authoritative booking executor before continuing; **satisfied: P0-004A done 2026-08-11**); P0-005 must finish before P0-006 or P0-007 begins — they build on its foundation.
4. If Sprint 1 carries over a ticket, it keeps its slot and Sprint 2 admits only one new ticket until it closes.
5. Any ticket whose decision dependency reopens (see `decision-queue.md`) moves to `blocked.md` immediately.

## Explicitly not in Sprint 2

- P0-008 through P0-012 — remain in `backlog.md`, ordered there; promoted as slots free.
- Anything from P1+ (E01 onward) — D-018 sequencing and the P0-exit gate in `../10-roadmap.md` forbid it before E00 closes.
