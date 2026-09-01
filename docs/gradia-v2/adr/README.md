# ADRs — Architecture Decision Records

_Created 2026-07-25 by the Organizer. Precedence layer 3 (see `../16-document-source-map.md`)._

ADRs record **how** decisions (mechanisms), while `../11-decision-log.md` records **what** decisions (product/scope). An ADR is required when a Builder or Organizer must choose between technical mechanisms with lasting consequences — e.g. the P0-005 idempotency mechanism (per-table uniques vs a `provider_events` table), the E01 tenant-scoping mechanism (`forShop()` helper vs Postgres session-variable RLS), or the P10 outbox design.

## Format

`ADR-NNN-<slug>.md` with sections: **Status** (proposed / accepted / superseded-by-ADR-NNN) · **Context** · **Decision** · **Alternatives considered** · **Consequences** · **Links** (tickets, decision-log IDs, audit evidence).

## Rules

- Proposed by anyone; **accepted only with founder or Organizer-with-founder-mandate sign-off**.
- An accepted ADR that contradicts an older doc gets a row in `../16-document-source-map.md` §Contradictions.
- Pre-existing locked architecture principles (root `CLAUDE.md`, sharpening brief) are treated as accepted ADRs by reference — do not restate them here unless amending, which requires founder approval.

## Index

- **ADR-003 — Service-role tenant-scoping mechanism (`forShop`)** (`ADR-003-service-role-tenant-scoping.md`) — **accepted** (founder-APPROVED at the P0-011 acceptance; recorded 2026-09-01 at the close, PR #29 `e02c81a`; proposed 2026-08-28 by the P0-011 Builder): a thin explicit `forShop(client, trustedShopId)` facade — scoped select/update/delete, insert/upsert/**update** all stamping the authorized `shop_id` (forged payload `shop_id` loses; the update-stamping invariant added by Cursor review HIGH #1), empty shopId fails closed, loud `unscoped` escape hatch; Postgres session-variable RLS-for-service-role evaluated and deferred to the E01-era TS-5 design gate. Shipped with P0-011: the facade + two converted cron call sites + the tenant-isolation test tier + the CI-locked 31-file service-role importer inventory. **Migration batches TS-1…TS-6 remain future work — not started.**
- **ADR-002 — Provider boundaries** (`ADR-002-provider-boundaries.md`) — accepted 2026-07-27: Gradia domains depend on Gradia-owned interfaces (CalendarProvider, ModelProvider, VoiceProvider, TelephonyProvider, PaymentsProvider, CRMConnector), never vendor-specific behavior. Pairs with D-029/D-030.
- **ADR-001 — Provider-event idempotency** (`ADR-001-provider-event-idempotency.md`) — **accepted with conditions** 2026-08-13 (Organizer review under explicit founder mandate; proposed 2026-08-12 by the P0-005 Builder): per-table uniques for single-row ledger events (`usage_events`, `automation_runs`) + a central `provider_events` claim table for multi-table inbound webhook events, consumed by P0-006/P0-007. Conditions C1–C7 in the ADR's Approval record bind P0-005 close and P0-006/007. **Condition status 2026-08-14 (P0-007 close, PR #21):** C1 (Cursor APPROVE, no BLOCKER/HIGH), C2 (P0-005A retention ticket filed) and C7 (production duplicate audit — zero rows on both ledgers) satisfied at the P0-005 close (PR #17); **C3 (claim-after-verify, test-locked) satisfied for both consumer routes** — Twilio inbound at the P0-006 close (PR #19) and Vapi end-of-call at the P0-007 close (PR #21); **C5 (Vapi stale threshold) satisfied** at the P0-007 close (`maxDuration=60` strictly below the 300s stale threshold); C4 (Aurinko namespacing) and C6 (time-boxed `outreach_draft` exclusion) remain open on their consumers. Two accepted residuals recorded at the P0-007 close (cross-tenant global call-id griefing; tool-call events not replay-deduped) — see the ADR. Landed after ADR-002 — numbering reflects reservation order, not acceptance order.
