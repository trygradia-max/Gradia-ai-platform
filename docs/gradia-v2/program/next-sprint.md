# Program — Next Sprint

_Created 2026-07-25 by the Organizer. Sprint 2 candidate scope — contingent on Sprint 1 completing (P0-001 + P0-002 done and reviewed). Not started; the Organizer promotes this to `current-sprint.md` when Sprint 1 closes._

## Candidate scope (all E00 / P0)

### Track A — Scheduling correctness (calendar high-risk slot)

| Ticket | Title | Notes |
|---|---|---|
| P0-003 | Central appointment conflict service | Enters implementation only after P0-002 is complete (CI must be able to fail its tests). Occupies the **one** calendar high-risk slot. |
| P0-004 | Conflict enforcement across booking and scheduling paths | Strictly sequential after P0-003 — same high-risk slot; never active simultaneously with P0-003. |

### Track B — Idempotency chain

| Ticket | Title | Notes |
|---|---|---|
| P0-005 | Webhook event idempotency foundation | Database-sensitive (unique indexes / dedupe strategy migration) — occupies the **one** DB-sensitive slot. |
| P0-006 | Twilio inbound replay protection | Depends on P0-005; starts only when P0-005 is done. |
| P0-007 | Vapi transcript and usage replay protection | Depends on P0-005; sequenced after P0-006 or in its slot, respecting the max-2 active limit. |

## Selection rules

1. **Max 2 active at any moment** — the expected cadence is one Track A ticket + one Track B ticket concurrently (e.g. P0-003 + P0-005), each with its own Builder and Reviewer.
2. P0-003/P0-004 share the calendar high-risk slot and are strictly sequential (D-015/D-016 policy is implemented in 003, wired in 004).
3. P0-005 must finish before P0-006 or P0-007 begins — they build on its foundation.
4. If Sprint 1 carries over a ticket, it keeps its slot and Sprint 2 admits only one new ticket until it closes.
5. Any ticket whose decision dependency reopens (see `decision-queue.md`) moves to `blocked.md` immediately.

## Explicitly not in Sprint 2

- P0-008 through P0-012 — remain in `backlog.md`, ordered there; promoted as slots free.
- Anything from P1+ (E01 onward) — D-018 sequencing and the P0-exit gate in `../10-roadmap.md` forbid it before E00 closes.
