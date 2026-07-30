# Tickets — Index

_Bounded implementation ticket specifications. A Builder implements exactly one ticket at a time, exactly as specced. Scope changes go back to the Organizer, never into the diff. Created 2026-07-25._

## P0 ticket index (epic E00 — Stabilization)

| ID | Title | Epic | Status | Priority | Depends on | High-risk class | File |
|---|---|---|---|---|---|---|---|
| P0-001 | Exposed database credential remediation | E00 | **ready — Sprint 1** | Critical | none | security | `P0-001-exposed-database-credential-remediation.md` |
| P0-002 | CI typecheck, lint, build and integration enforcement | E00 | **done** (2026-07-30, PR #9) | Critical | none | none | `P0-002-ci-enforcement.md` |
| P0-003 | Central appointment conflict service | E00 | **ready — next up** (P0-002 gate cleared 2026-07-30; enters implementation when the Organizer slots it — not started) | High | P0-002 (done) | calendar | `P0-003-central-appointment-conflict-service.md` |
| P0-004 | Conflict enforcement across booking and scheduling paths | E00 | draft | High | P0-003 | calendar | `P0-004-conflict-enforcement-booking-paths.md` |
| P0-005 | Webhook event idempotency foundation | E00 | ready-after-P0-002 | High | P0-002 | database-sensitive | `P0-005-webhook-idempotency-foundation.md` |
| P0-006 | Twilio inbound replay protection | E00 | draft | High | P0-005 | none | `P0-006-twilio-inbound-replay-protection.md` |
| P0-007 | Vapi transcript and usage replay protection | E00 | draft | High | P0-005 | payment (metering) | `P0-007-vapi-transcript-usage-replay-protection.md` |
| P0-008 | Twilio subaccount status callback repair | E00 | ready-after-P0-002 | Medium | P0-002 | none | `P0-008-twilio-subaccount-status-callback-repair.md` |
| P0-009 | Quote acceptance, lead linkage and expiration repair | E00 | ready-after-P0-002 (one open decision) | High | P0-002; decision Q-04 (expired-quote UX) for one sub-step | none | `P0-009-quote-acceptance-lead-linkage-expiration.md` |
| P0-010 | Production environment and error-surface cleanup | E00 | ready-after-P0-002 | Medium | P0-002 | none | `P0-010-production-env-error-surface-cleanup.md` |
| P0-011 | Service-role tenant-scoping review and helper design | E00 | ready-after-P0-002 | High | P0-002 | tenancy | `P0-011-service-role-tenant-scoping-review.md` |
| P0-012 | Monitoring alert delivery and incident hooks | E00 | ready-after-P0-002 (one open decision) | Medium | P0-002; decision Q-08 (alert destination) | none | `P0-012-monitoring-alert-delivery-incident-hooks.md` |

## Future-phase tickets (specced early)

| ID | Title | Epic | Status | Priority | Depends on | High-risk class | File |
|---|---|---|---|---|---|---|---|
| P3-001 | Housecall Pro dependency review | E03 | draft (not before P0 exit) | Medium | P0 exit (sprint discipline); feeds decision Q-19 | none (read-only review) | `P3-001-housecallpro-dependency-review.md` |

> **P0-002 completed 2026-07-30** (PR #9, reviewed APPROVE): the `ready-after-P0-002` review gate is now satisfied — tickets carrying that label may enter review once slotted, subject to WIP limits and their own listed decisions (Q-04, Q-08). Labels are left in place per-row until each ticket is actually slotted.

Statuses (complete vocabulary — no other status labels are valid): **draft** (spec exists, prerequisites unresolved) · **ready** (dependencies + decisions resolved, may be picked up) · **ready-after-P0-002** (defined 2026-07-27: the spec is complete and no founder decision blocks it; the ticket may be slotted for implementation when WIP allows, but it may not enter **review** — and therefore cannot merge or reach done — until P0-002 is complete, per the global review gate in `../10-roadmap.md` sequencing rule 2. For **P0-003 only** the gate is stronger: implementation itself may not start before P0-002 is done) · **in-progress** (one Builder assigned, recorded in `../program/work-in-progress.md`) · **in-review** (one Reviewer assigned) · **done** (DoD met, evidence recorded) · **blocked** (recorded in `../program/blocked.md` with reason).

## Ticket template (added 2026-07-27 — the "full ticket template" other docs reference)

Every ticket file MUST contain the following sections, in this order. The structure is derived from the existing P0 tickets, which already comply. A ticket missing any required section is **draft** by definition, regardless of its status line — an Organizer cannot mark it ready, and a Builder cannot pick it up.

| # | Section | Required content |
|---|---|---|
| 1 | **Ticket ID** / **Epic** | ID + owning epic |
| 2 | **Status** | One label from the status vocabulary above, plus any gate note |
| 3 | **Priority** | Phase + severity + one-line why |
| 4 | **Objective** / **User outcome** | What changes and who feels it |
| 5 | **Current code references** | Audit/file:line evidence — claims cite code, never vibes |
| 6 | **Exact scope** | Numbered, bounded list of the work |
| 7 | **Explicit non-goals** | What this ticket deliberately does NOT do |
| 8 | **Dependencies** | Ticket dependencies + binding decisions (D-###/Q-##) — "none" must be stated, not implied |
| 9 | **Expected modules affected** | File-level blast radius |
| 10 | **Database impact** / **Migration impact** | Schema/migration statement — "None" must be explicit (drives the DB-sensitive WIP slot) |
| 11 | **API / UI / Permission impact** | Contract and surface changes, incl. required UI states |
| 12 | **Tenant-isolation / Security impact** | Scoping requirements + at least one isolation test where service-role paths are touched |
| 13 | **Idempotency / Observability / Analytics requirements** | Replay behavior, logging, events ("none" stated explicitly) |
| 14 | **Feature flag** | Flag name, or "None — fix" with justification (D-027) |
| 15 | **Automated tests** | Test classes required (unit / integration / tenant-isolation / failure-path) |
| 16 | **Manual acceptance procedure** | Numbered steps; every step must be executable by the Builder or explicitly assigned to a named human — a step nobody owns is a spec defect |
| 17 | **Failure cases** | What breaks and what the behavior must be |
| 18 | **Rollback strategy** | How to unwind, incl. migration/in-flight-data notes |
| 19 | **Definition of done** | `../12-definition-of-done.md` plus ticket-specific evidence |

## Lifecycle

```
draft ──▶ ready ──▶ in-progress ──▶ in-review ──▶ done
              ▲            │              │
              └── blocked ◀┴──────────────┘  (reason + unblock condition in program/blocked.md)
```

- The Organizer moves tickets to **ready** only when every dependency is done and every referenced decision is Approved in `../11-decision-log.md`.
- A Builder moves a ticket to **in-progress** by recording it in `../program/work-in-progress.md` — never by starting silently.
- **in-review** requires the Builder's completion report (per `../agent-briefs/claude-builder.md`) attached to the ticket file as an appendix or linked run note.
- **done** requires the Reviewer's sign-off against `../12-definition-of-done.md` plus the ticket's own DoD section.

## WIP limits (hard rules — enforced in `../program/work-in-progress.md`)

1. Maximum **two** tickets in-progress at once, total.
2. Maximum **one** database-sensitive ticket (touches migrations/schema) in-progress at a time.
3. Maximum **one** high-risk ticket (payment, tenancy, or calendar class) in-progress at a time.
4. **One Builder and one Reviewer per ticket** — never the same agent/session.
5. **No ticket enters implementation until its dependencies are done and its decisions are resolved.** A ticket that discovers an unresolved founder decision mid-flight stops and moves to blocked — the Builder never decides silently.

## Sprint 1 selection

Per `../program/current-sprint.md`: **P0-001 and P0-002 only.** P0-003 may move to implementation only after P0-002 is complete (a conflict service without CI that can fail is unreviewable). Everything else queues.
