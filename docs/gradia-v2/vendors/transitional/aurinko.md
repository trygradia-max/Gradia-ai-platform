# Vendor — Aurinko

> **Classification:** transitional · **Status:** transitional · Amended 2026-07-27 (vendor-architecture amendment, D-030/ADR-002). Registry: ../registry.md

_Created 2026-07-25 by the Organizer. Vendor registry entry. Facts grounded in the 2026-07-20 audit (docs 04-D/G, 06); unverified items are marked. Runbooks: `docs/aurinko-go-live.md`, `docs/calendar-go-live.md`. Epics: E02 (calendar), E07 (email parity)._

## Approved direction (2026-07-27)

- **Keep during stabilization** — Aurinko stays through P0 and native-calendar development.
- **Gradia's database remains the appointment source of truth** (D-013); Aurinko synchronizes external calendars and connected mailboxes — it is a mirror, not the record.
- **Core calendar records must not depend on Aurinko-specific identifiers** — `aurinko_event_id` and friends become sync-record fields, never core-entity keys (D-029).
- **Aurinko must remain replaceable** behind the Gradia-owned `CalendarProvider` boundary (ADR-002); Aurinko is the first adapter, not the interface.
- **Google Calendar and Microsoft Graph capabilities are specified independently** — see `../planned-evaluations/google-calendar.md` and `../planned-evaluations/microsoft-graph.md`.
- **Direct provider integrations may be evaluated later** — after the native appointment system and `CalendarProvider` are stable (decision Q-21).

## Purpose
Email send/receive and calendar integration (Google today; Microsoft sync is the D-014 target). Currently the calendar side is **load-bearing beyond design intent**: booking hard-requires a connected Aurinko calendar (`approvals.ts:686-693`) — a shop without Google Calendar cannot confirm any appointment. D-013/E02 demotes external calendars to synchronized mirrors.

## Data exchanged
Inbound email content (→ classify → staged lead/reply), outbound approved emails, calendar events (create on `"primary"`, `aurinko_event_id` mirrored onto appointments), OAuth tokens (AES-256-GCM encrypted at rest, transparent refresh with 60s buffer).

## Authentication
OAuth via `/api/aurinko/auth/start` → callback: CSRF nonce cookie, open-redirect-guarded, state check, token exchange, webhook subscribe. Webhook: HMAC-SHA256 + 300s replay window, fail-closed.

## Webhooks
`/api/aurinko/webhook` — inbound email notifications; shop resolved by `accountId`; own-mailbox copies skipped.

## Rate limits
REQUIRES VERIFICATION (Aurinko docs/dashboard).

## Failure behavior
**Known polarity inversion:** email classifier failure defaults to "is a lead" — an LLM outage floods approvals with newsletter cards (E07 fix). Token refresh transparent; no owner-facing reconnect alerts (audit doc 03 integration-reconnect PARTIAL). No email bounce/delivery tracking.

## Idempotency
**Gap:** no inbound dedupe on `aurinko_message_id` — redelivery duplicates cards (P0-005 foundation; redelivery behavior in practice REQUIRES VERIFICATION, audit open question #14). Calendar: partial-unique `aurinko_event_id` on appointments.

## Cost model
REQUIRES VERIFICATION — Aurinko plan/pricing not established in repo; part of the infra assumption in `15-cost-and-margin-model.md`.

## Monitoring
None specific; failures follow the app's silent-degradation pattern until P0-012.

## Test environment
Webhook forgery/tamper/replay covered deterministically; live send/receive CANNOT_VERIFY locally (audit doc 03).

## Known audit gaps
- **No outbound thread matching** — replies send as standalone messages (documented at `aurinko.ts:356-364`; E07).
- No inbound idempotency (above).
- Classifier failure polarity (above).
- No email consent/quiet-hours model, no unsubscribe handling for email (E07).
- Hard booking dependency (C-09 in the source map) until E02 makes Gradia's DB the appointment source of truth (D-013).

## Backup or exit strategy
Aurinko abstracts Google (and future Microsoft) — it *is* the seam for email/calendar. Exit = direct Google/Microsoft API integrations or another unified provider; token model and webhook contract would need rebuilding. E02 reduces criticality by making Gradia the appointment source of truth. No exit planned.

## Owner
Founder (Harry).
