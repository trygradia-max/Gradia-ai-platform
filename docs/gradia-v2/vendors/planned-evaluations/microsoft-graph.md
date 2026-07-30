# Planned Evaluation — Microsoft Graph (Outlook Calendar & Mail)

_Created 2026-07-27 (vendor-architecture amendment). Planning only — no vendor is selected or installed. Adoption requires the 17-point checklist in `../README.md` incl. founder approval._

## Why this evaluation exists

D-014 makes Microsoft calendars a **first-class synchronized integration** alongside Google — but **nothing exists today**: no Microsoft path is built even through Aurinko (Aurinko supports it, unbuilt — audit-era note carried in `11-decision-log.md` D-014). This doc specifies Outlook calendar + mail capabilities independently, so `CalendarProvider` (D-029/ADR-002) covers both ecosystems from its first design and Microsoft support is not bolted on Google-shaped assumptions.

## Requirements

### Outlook calendar (behind `CalendarProvider`)
- Event CRUD mirrored FROM Gradia appointments (Gradia DB is the source of truth, D-013); external events flow in as busy blocks only.
- Busy/free (`getSchedule`-style availability — exact endpoint semantics **requires verification**) for the E02 availability engine.
- Incremental sync via delta queries (token lifetimes **requires verification**).
- Change notifications (Graph subscriptions; max subscription lifetime and renewal behavior **requires verification**) with polling fallback.
- Recurring-event and timezone semantics (Graph's series-master/occurrence model differs from Google's — **requires verification**; the `CalendarProvider` interface must not leak either model).
- Provider identifiers stored in integration/sync records only (D-029).

### Outlook mail (connected-mailbox conversations)
- Inbound read for lead intake into the existing classify → stage pipeline; **in-thread replies** (do not inherit the Aurinko threading gap, `aurinko.ts:356`).
- Webhook subscriptions + delta fetch; `internetMessageId`/message-id idempotency (D-023).
- OAuth scopes: narrowest; Azure AD app registration + publisher verification requirements **requires verification**.

### Both
- Per-shop OAuth, encrypted tokens (existing AES-256-GCM pattern), transparent refresh, reconnect alerts.
- Throttling model (Graph 429/`Retry-After` behavior) **requires verification**.

## Current state in Gradia

None. No Microsoft/Graph/Outlook references exist in the codebase; shops with Outlook mailboxes or Microsoft 365 calendars cannot connect at all today. This is net-new work whichever adapter path is chosen.

## Gradia-owned boundary

`CalendarProvider` for calendar; the communications domain for mail (D-029/ADR-002). Two adapter paths exist: Aurinko-mediated Microsoft support (faster, keeps one aggregator) or Graph-direct (no aggregator dependency). The interface must make the choice invisible to domains.

## Trigger / timing

- **Whether/when Microsoft ships at all within E02:** Q-09 (Organizer recommendation: Google-first, Microsoft fast-follow).
- **Aggregated vs direct:** Q-21 (evaluate direct providers only after the native appointment system + `CalendarProvider` are stable, post-E02).
- Earlier trigger: pilot shops materially blocked by no-Outlook support (record demand in `../../customer-feedback/`).

## Candidate options (not selected)

Aurinko's Microsoft support (unbuilt in Gradia) · Microsoft Graph direct · defer Microsoft entirely past E02.

## Open questions → decision queue

Q-09 (Microsoft priority within E02) · Q-21 (direct vs aggregator) · Azure app-verification cost (fold into Q-21 evidence).
