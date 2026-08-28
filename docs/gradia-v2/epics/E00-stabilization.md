# E00 — Stabilization

_Created 2026-07-25 by the Organizer. Phase: **P0**. Status: active (Sprint 1)._

## Objective

Convert the platform from "impressive but leaky" (audit doc 00) to a defensible alpha: rotate the leaked credential, make CI able to stop a broken build, eliminate double-booking and duplicate-billing paths, repair the broken provider seams, and give failures a place to land other than the console.

## User outcome

An alpha shop owner can trust that: nobody outside the shop can read their data, an appointment Gradia books doesn't collide with one already on the books, a Twilio or Vapi retry never produces a duplicate approval card or a double-billed minute, delivery status actually records, and an accepted quote closes cleanly instead of forking a duplicate pipeline card.

## Business reason

The 2026-08-07 alpha is not shippable with a live superuser credential in pushed git history (audit C-1) and reliability defects that fire under *normal* provider behavior. Everything in this epic caps the audit's production-readiness score (5.5/10); fixing it moves security and reliability to ≥7 without building anything new.

## Current foundation

- Approval engine (`approvals.ts`) — atomic claim, rollback-on-failure; the pattern every fix extends.
- `call_records` unique `(shop_id, vapi_call_id)` — the idempotency pattern to replicate (audit doc 04-H).
- `listCalendarEvents` (`aurinko.ts`) written and unused; `working-hours.ts` capacity math — conflict-service inputs exist.
- All four webhooks signature-verified and test-locked; 430 passing deterministic tests; `ci.yml` exists (tests only).
- `monitoring.ts` anomaly detection exists — alerts go to console only.

## Missing work — the 12 tickets

| Ticket | Title |
|---|---|
| P0-001 | Exposed database credential remediation |
| P0-002 | CI typecheck, lint, build and integration enforcement |
| P0-003 | Central appointment conflict service |
| P0-004 | Conflict enforcement across booking and scheduling paths |
| P0-005 | Webhook event idempotency foundation |
| P0-006 | Twilio inbound replay protection |
| P0-007 | Vapi transcript and usage replay protection |
| P0-008 | Twilio subaccount status callback repair |
| P0-009 | Quote acceptance, lead linkage and expiration repair |
| P0-010 | Production environment and error-surface cleanup |
| P0-011 | Service-role tenant-scoping review and helper design |
| P0-012 | Monitoring alert delivery and incident hooks |

Full specs in `../tickets/`.

## Domain entities

No new entities. Touched: `appointments` (conflict reads), `pending_actions`, `interactions` (idempotency keys), `usage_events` (vendor_ref uniqueness), `quotes`/`leads` (acceptance linkage), `webhook_events` or equivalent dedupe key store (P0-005 decides shape).

## Backend services

New: conflict service (`P0-003`, one module consumed by every booking path), webhook idempotency helper (`P0-005`), alert delivery (`P0-012`), `forShop()` scoping helper *design* (`P0-011` — design + review only in P0). Modified: `approvals.ts` executors, `api/twilio/sms/status/route.ts`, Vapi end-of-call handler, `quote-response.ts`.

## UI surfaces

Minimal by design: conflict warning on the booking ApprovalCard (P0-004), expired-quote state on `/q/[token]` (P0-009), `error.tsx`/`not-found.tsx` boundaries + stale-copy fixes (P0-010). No new screens.

## Integrations

Twilio (status callback credentials, MessageSid dedupe), Vapi (end-of-call replay), Aurinko (message-id dedupe), Supabase (credential rotation), Sentry/Slack-webhook (alert delivery destination — decision queue Q-08).

## Security implications

P0-001 is the single most serious issue in the audit — treat the credential as compromised until rotated. P0-011 addresses the structural risk (service-role scoping is discipline-only across ~29 files, audit doc 05). P0-010 closes M-1 (unauthenticated LLM action) and deletes loose `.env.local` backups (H-1). Slack path (C-2) stays dormant under D-026 — not fixed here, just locked off.

## Tenant implications

No tenancy model change (that is E01). P0-011 produces the design that makes tenant scoping mechanism instead of discipline; the two stray `.eq("shop_id")` omissions (audit L-1/L-2) belong to the P0-011 sweep, not P0-010 (accuracy correction at the 2026-08-28 P0-010 close — P0-009 already tenant-scoped the `approvals.ts` executor path; P0-011 verifies L-2 there rather than double-fixing).

## Migration implications

Additive only: unique indexes/keys for idempotency (P0-005/006/007), possible dedupe table. No destructive migrations; all reversible by dropping the index. Max one database-sensitive ticket active at a time (WIP rule).

## Product analytics

No new events. Prereq effect: reliable `First appointment booked` and `First payment collected` semantics depend on P0-003/P0-009 (no duplicate leads or double-booked rows polluting the funnel).

## Dependencies

P0-001 precedes everything. P0-002 precedes all other tickets entering review. P0-004 depends on P0-003. P0-006/007 depend on P0-005. Decisions consumed: D-015/D-016 (conflict block-vs-override), D-023/D-024 (idempotency/immutability), D-026 (Slack stays off). Open: alert destination (Q-08), expired-quote UX copy (Q-04).

## Risks

- Credential rotation briefly breaks any founder-local tooling using the old URL (coordinate with founder; runbook `runbooks/exposed-credential.md`).
- Enabling `next build` + typecheck in CI may surface latent errors that block unrelated merges — budget a fix-forward day.
- Conflict enforcement could reject legitimate double-capacity shops — D-016 override path is the escape valve.
- Un-quarantining the integration tier (red since 06-04) may take iteration; keep it a non-blocking follow-up inside P0-002 if it drags.

## Non-goals

No multi-user tenancy (E01), no native calendar authority (E02 — conflict checks here run on the *current* Aurinko-backed model, C-09), no new features, no refactors of the god-files, no history rewrite decision (founder decision Q-01).

## Feature flags

None for fixes (correctness is not optional). Conflict enforcement/override behavior ships behind `FEATURES.conflictEnforcement` per the P0-004 spec (flag name reconciled to the ticket 2026-07-27).

## Testing requirements

Every ticket lists its own. Epic-level: replaying any captured webhook twice yields one card/one meter row; two overlapping bookings cannot both confirm without a recorded override; a deliberate type error fails CI; status callback verifies with subaccount-credential fixture; expired quote rejects server-side. Extend locking tests, never weaken (D-012).

## Rollout plan

Sprint 1: P0-001 + P0-002 (only). Then P0-003 → P0-004; P0-005 → P0-006/007 (pipeline); P0-008/009/010/012 slot around the WIP limits; P0-011 is design/review output, no code rollout. Deploy continuously; nothing here is flag-gated off except the optional override flag.

## Acceptance criteria

1. Old DB credential fails to connect; line absent from HEAD; disposition of history documented (Q-01 answered).
2. CI fails on type error, lint error, broken build; integration tier blocking green.
3. No booking path (voice, quote accept, drag, block-time, HITL executor) can create an overlapping appointment silently; automatic paths hard-block (D-015), HITL warns with recorded override (D-016).
4. Webhook replay tests pass for Twilio, Vapi, Aurinko; voice minutes meter exactly once per call.
5. Delivery status records for Gradia-provisioned (subaccount) numbers.
6. Quote accept resolves the existing lead, advances quote status, and expired quotes are rejected server-side.
7. Anomaly/reconciliation/cron failures deliver to a real destination, not console.
8. Audit re-score: security ≥7, reliability ≥7; alpha go/no-go review passes.
