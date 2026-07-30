# Planned Evaluation — Google Calendar & Gmail (Direct Connectivity)

_Created 2026-07-27 (vendor-architecture amendment). Planning only — no vendor is selected or installed. Adoption requires the 17-point checklist in `../README.md` incl. founder approval._

## Why this evaluation exists

Google Calendar and Gmail are reached today **only through Aurinko** (transitional infrastructure, D-030). D-013 makes Gradia's database the appointment source of truth and D-029/ADR-002 requires a Gradia-owned `CalendarProvider`. This document specifies Google capabilities **independently of Aurinko** so the interface is shaped by what Gradia needs, not by what the aggregator happens to expose — and so a later direct integration (Q-21) is a swap, not a redesign.

## Requirements

### Calendar (behind `CalendarProvider`)
- Event CRUD on the shop's chosen calendar (create/update/cancel mirrored FROM Gradia appointments — Gradia is the source of truth; external events flow IN only as busy blocks).
- Busy/free reads for the availability engine (E02, consumed by the P0-003 conflict service's successor).
- Incremental sync (delta tokens / sync tokens — exact semantics **requires verification**) rather than full re-reads.
- Change notifications (push/watch channels; renewal lifetimes and delivery guarantees **requires verification**) with a polling fallback.
- Timezone-correct all-day and recurring-event handling (recurring expansion semantics **requires verification**).
- Provider identifiers (`event id`, `calendar id`, sync cursors) stored only in integration/sync records — never as the identity of a Gradia appointment (D-029).

### Gmail (connected-mailbox conversations)
- Read inbound mail for lead intake (the existing classify → stage pipeline), send replies **in-thread** (threading is a known Aurinko gap, `aurinko.ts:356` — a direct integration must not inherit it).
- Webhook/push (Pub/Sub watch — **requires verification**) with history-id style incremental fetch.
- Message-id based idempotency (D-023).
- OAuth scopes: narrowest possible; Google's restricted-scope verification/CASA audit requirements for Gmail scopes **requires verification** — this is a real adoption cost and may be the strongest argument for staying on an aggregator.

### Both
- Per-shop OAuth with encrypted token storage (existing AES-256-GCM pattern), transparent refresh, owner-facing reconnect alerts (gap noted in audit doc 03).
- Rate limits and quota model **requires verification**.

## Current state in Gradia

Aurinko provides Google calendar event CRUD (`aurinko.ts:502` on `"primary"`) and email in/out; booking hard-requires the connection (`approvals.ts:686`) — removed by E02. No direct Google API client exists anywhere in the codebase.

## Gradia-owned boundary

`CalendarProvider` (calendar) and the connected-mailbox side of the communications domain (D-029/ADR-002). Aurinko becomes one adapter; Google-direct would be a second adapter behind the same interface.

## Trigger / timing

Per Q-21: **after** the Gradia-native appointment system and `CalendarProvider` interface are stable (post-E02). Earlier only if Aurinko reliability/cost forces it (record evidence in `../transitional/aurinko.md`).

## Candidate options (not selected)

Google Calendar API + Gmail API direct · stay on Aurinko · hybrid (direct calendar, aggregated mail).

## Open questions → decision queue

Q-21 (direct vs aggregator, timing) · Gmail restricted-scope audit cost (fold into Q-21 evidence) · whether mail and calendar must move together or can split.
