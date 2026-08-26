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
| P0-005 | Webhook event idempotency foundation | **Done 2026-08-13** — merged PR #17 (`e1dedfb`); Cursor APPROVE, no BLOCKER/HIGH; ADR-001 C1/C2/C7 satisfied (incl. zero-row founder production duplicate audit); staging manual acceptance still gates full rollout acceptance of the migrations. Close record in the ticket file. |
| P0-005A | provider_events retention and pruning | **Filed 2026-08-13** (ADR-001 C2); ready, unscheduled — Organizer sequences; must land before P0-006/007 receipt volume grows. |
| P0-006 | Twilio inbound replay protection | **Done 2026-08-14** — merged PR #19 (`76847e4`); CI green incl. integration tier; independent Cursor verdict **APPROVE / safe to merge**, no BLOCKER/HIGH, no review-fix commit; founder real-Twilio staging acceptance completed pre-merge; ADR-001 C3 satisfied for this route; no new migration. Close record in the ticket file. |
| P0-007 | Vapi transcript and usage replay protection | **Done 2026-08-14** — merged PR #21 (`8a4d4d1`); independent Cursor verdict **APPROVE**, no BLOCKER/HIGH, no review-fix commit; founder acceptance PASSED on isolated local staging (replays, post-restart durability, financial reconciliation, prod fallback-guard refusal); ADR-001 C3 + C5 satisfied for the Vapi route; no new migration. Close record in the ticket file. |

## Selection rules

1. **Max 2 active at any moment** — the expected cadence is one Track A ticket + one Track B ticket concurrently (e.g. P0-003 + P0-005), each with its own Builder and Reviewer.
2. P0-003/P0-004/P0-004A share the calendar high-risk slot and are strictly sequential (policy implemented in 003, wired in 004, executor hardened in 004A).
3. **P0-004A precedes P0-005** (2026-08-11 resequencing — harden the now-authoritative booking executor before continuing; **satisfied: P0-004A done 2026-08-11**); P0-005 must finish before P0-006 or P0-007 begins — they build on its foundation (**fully satisfied: P0-005 done 2026-08-13; P0-006 done 2026-08-14; P0-007 done 2026-08-14** — Track B's idempotency chain is complete; the Aurinko email dedupe follow-up in `backlog.md` remains).
4. If Sprint 1 carries over a ticket, it keeps its slot and Sprint 2 admits only one new ticket until it closes.
5. Any ticket whose decision dependency reopens (see `decision-queue.md`) moves to `blocked.md` immediately.

## Explicitly not in Sprint 2

- P0-010 through P0-012 — remain in `backlog.md`, ordered there; promoted as slots free. (Update 2026-08-26: **P0-009 done** — merged PR #25 `d3c0e4d`, Cursor APPROVE with one HIGH fixed pre-merge in `aba1068`, founder acceptance PASS; close record in its ticket file; **P0-010 is now the next implementation position** — blocked only on the `docs/close-p0-009` closeout merge; see `blocked.md`. Prior update 2026-08-25: P0-008 done, PR #23 `1ea198f`.)
- Anything from P1+ (E01 onward) — D-018 sequencing and the P0-exit gate in `../10-roadmap.md` forbid it before E00 closes.
