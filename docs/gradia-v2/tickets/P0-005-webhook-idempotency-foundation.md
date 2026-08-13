# P0-005 — Webhook event idempotency foundation

- **Ticket ID:** P0-005
- **Epic:** E00 — Stabilization
- **Status:** in-review (Builder implementation complete 2026-08-12 on `fix/p0-005-webhook-idempotency`; **ADR-001 accepted with conditions 2026-08-13** — internal gate cleared; remaining gates: independent Cursor Reviewer sign-off (ADR condition C1) + founder production duplicate audit (C7); completion record below)
- **Priority:** High (risk class: **database-sensitive** — counts against the DB WIP limit)

## Objective

Give the platform ONE durable mechanism for provider-event idempotency (D-023), enforced by database constraints, and apply it to the ledger/automation gaps the audit proved: `usage_events` has no idempotency key (double-metering on retry), `automation_runs` dedupes by check-then-insert with no unique index (`agent-runtime.ts:427` admits it), and inbound SMS/email have no event-id dedupe at all. Channel-specific wiring for Twilio and Vapi lands in P0-006/P0-007 on top of this foundation.

## User outcome

A provider retrying a webhook (normal behavior for Twilio/Vapi/Aurinko) can never double-bill a shop's voice minutes, double-fire an automation, or duplicate metering. (Duplicate approval cards close fully in P0-006/007.)

## Current code references

- Audit doc 02 §Webhook flow: "Idempotency: good on Stripe (`stripe_ref`/invoice uniques) and call_records; **absent on inbound SMS/email and voice-minute metering**."
- Audit doc 05 §Schema weaknesses #6: missing uniques on `usage_events` (vendor_ref), `automation_runs(automation_id, trigger_ref)`, reminder dedup.
- `call_records` UNIQUE `(shop_id, vapi_call_id)` — the existing in-house pattern to generalize (audit doc 05).
- `agent-runtime.ts:427` — "no unique index" admission.
- Audit doc 05 §Schema weaknesses #4: `usage_events`/`payments`/`shop_metrics` RLS FOR ALL (owner-writable ledgers) — D-024 context.
- Decisions: **D-023** (provider events idempotent, DB-enforced), **D-024** (financial events immutable + replay-safe).

## Exact scope

1. **Design note first (mini-ADR):** Builder writes `../adr/ADR-001-provider-event-idempotency.md` proposing either (a) per-table unique keys on provider refs (the `call_records` pattern generalized) or (b) a central `provider_events` claim table (`(provider, event_id)` unique, insert-first-then-process). Recommendation + tradeoffs (storage, pruning, multi-table events); Organizer approves before migration is written. One mechanism, applied uniformly — not both ad hoc.
2. Migration(s), additive and idempotent in the house style:
   - `usage_events`: unique partial index on `(shop_id, kind, vendor_ref)` where `vendor_ref` is not null (exact shape per ADR) — kills double-metering.
   - `automation_runs`: unique `(automation_id, trigger_ref)` — kills the double-fire race under overlapping crons.
   - The chosen general mechanism's table/indexes for inbound event ids (consumed by P0-006/007).
3. Code: convert the touched check-then-insert paths to insert-first (rely on the constraint; on unique-violation, treat as duplicate and exit cleanly — a duplicate is a normal outcome, logged at info, not an error).
4. **Ledger immutability (D-024, scoped):** migration flipping `usage_events`, `payments`, `shop_metrics` RLS from FOR ALL to SELECT-only for the owner role (copy the `credit_grants` pattern). Verify no legitimate session-client write exists first (audit says these are service-role-written; confirm by grep).
5. Backfill/duplicate audit: before adding uniques, a one-off check for existing duplicate rows (write the query + result into the completion report); dedupe strategy for any found (expected: none at pilot scale — if found, STOP and report before deleting anything financial).

## Explicit non-goals

- No Twilio/Vapi/Aurinko route changes (P0-006/007; Aurinko gets its own follow-up ticket in P0-010's sweep or a new one).
- No queue/outbox/dead-letter (P10, E10).
- No Stripe changes (already idempotent).
- No pruning cron for a claim table (note as follow-up if ADR picks option b).

## Dependencies

P0-002 (the integration tier must be gating — this ticket's proof lives in DB-backed tests). ADR-001 approval is an internal gate within the ticket.

## Expected modules affected

New migration(s) under `supabase/migrations/`; `credits.ts`/metering call sites that write `usage_events`; `automations.ts` / `agent-runtime.ts` trigger_ref paths; possibly a small `provider-events.ts` helper module.

## Database impact

New unique indexes/constraints; possible new `provider_events` table; RLS policy changes on three ledger tables. All additive; no data rewrites (duplicate audit first).

## Migration impact

2–3 numbered migrations, idempotent (`IF NOT EXISTS`), commented in house style. Validated by the un-quarantined integration tier (P0-002).

## API impact

None external. Webhook handlers' internal semantics change in P0-006/007, not here.

## UI impact

None (owner-side reads of ledgers unchanged — SELECT-only RLS preserves reads).

## Permission impact

Owner sessions lose (never-legitimate) write access to `usage_events`/`payments`/`shop_metrics` via PostgREST.

## Tenant-isolation impact

Unique keys include `shop_id` where the ref isn't globally unique (e.g. trigger_ref); claim table (if chosen) carries shop_id and is service-role-only with deny-all RLS like `rate_limits`.

## Security impact

Closes the owner-writable-ledger hole (audit doc 05 weakness #4). Financial history becomes tamper-resistant from the browser session.

## Idempotency requirements

This ticket defines them platform-wide: **every provider event write must be guarded by a database constraint, not a read-check.** Duplicate = clean no-op with info log.

## Observability requirements

Info-level log on duplicate suppression (`[idempotency] duplicate <provider>:<ref> ignored`), counting toward P0-012's future metrics. Migration completion verified in the report.

## Analytics requirements

None owner-facing.

## Feature flag

None — fix, not feature: constraints are the point; a flag that bypasses a unique index is impossible, and code paths must not have a constraint-off mode.

## Automated tests

- **Migration tests (integration tier):** migrations apply cleanly on a fresh DB and on a DB with pre-existing rows.
- **Idempotency replay:** insert the same `usage_events` vendor_ref twice → second is a clean no-op, balance unchanged. Same for `automation_runs(automation_id, trigger_ref)` under simulated concurrent fire (two parallel inserts → exactly one row).
- **Failure-path:** unique-violation handling returns duplicate-outcome, never throws to the webhook caller.
- **Permission tests:** owner session INSERT/UPDATE/DELETE on the three ledgers → denied; SELECT → allowed; service-role writes → allowed.
- **Tenant-isolation:** claim/unique keys never collide across shops for shop-scoped refs.

## Manual acceptance procedure

1. Run the duplicate-audit query against staging; record results (expected zero; if nonzero on financial tables, ticket pauses for Organizer).
2. Apply migrations to staging; spot-check constraints exist (`\d usage_events` etc.).
3. Replay a captured voice-minutes metering write twice (script or test harness) → one ledger row, balance decremented once.
4. Fire the same automation trigger_ref from two overlapping cron invocations → one `automation_runs` row.
5. From a logged-in owner session (browser devtools/PostgREST), attempt to INSERT into `usage_events` → RLS denies.
6. Confirm billing page still renders balances correctly (reads intact).

## Failure cases

- Existing duplicates block a unique index → surfaced by step 1; resolution is an Organizer/founder call (financial rows are never deleted silently — D-024).
- A legitimate session-client ledger write is discovered → stop, report; either move it to service-role or exempt with justification in the ADR.
- Concurrent inserts both erroring instead of one winning → wrong error handling; unique-violation must be caught and treated as duplicate.

## Rollback strategy

Constraints/RLS changes are revertible by a down migration (write it, keep it unapplied). Code paths degrade gracefully without the constraint (they keep their check-then-insert as a fallback until cleanup). No data loss in either direction.

## Definition of done

All of `../12-definition-of-done.md` plus: ADR-001 approved and recorded; constraints live and proven by replay tests in the gating integration tier; ledger RLS SELECT-only with permission tests; duplicate audit documented; P0-006/007 unblocked with the mechanism they consume named in their specs.

## Completion record (Builder, 2026-08-12)

Implementation complete on `fix/p0-005-webhook-idempotency`; full completion
report delivered in the Builder session handoff. Summary:

- **ADR-001** (`../adr/ADR-001-provider-event-idempotency.md`) — per-table
  uniques for single-row ledger events + central `provider_events` claim
  table (claim/complete/fail RPCs) for multi-table inbound events.
  **Accepted with conditions 2026-08-13** (Organizer, founder mandate);
  conditions C1–C7 recorded in the ADR — C1 (independent Cursor review)
  and C7 (production duplicate audit) gate this ticket's done.
- **Migrations:** `20260812120000_webhook_idempotency.sql` (partial uniques
  on `usage_events (shop_id, kind, vendor_ref)` excl. `outreach_draft` and
  `automation_runs (automation_id, trigger_ref)` excl. `failed`;
  `provider_events` table + row-locked claim RPCs, deny-all RLS,
  service-role-only EXECUTE) and `20260812130000_ledger_rls_select_only.sql`
  (usage_events/payments/shop_metrics → SELECT-only for owner sessions).
  Unapplied down migration: `supabase/rollbacks/20260812_p0_005_down.sql`.
- **Code:** `src/lib/provider-events.ts` (claim helper for P0-006/007);
  `recordUsage` writes service-role + treats 23505 as info-level duplicate;
  `automations.ts` claim-first conversion (both paths); session-client
  ledger writers moved to service-role (`recordUsage` internal,
  `backfillStripePayments`); recovery extraction metering switched to
  per-row vendor refs.
- **Duplicate audit:** zero duplicate groups on the local stack (fresh);
  **staging/production run assigned to the founder** (read-only queries in
  the completion report — production DB credentials are not available to
  Builder sessions post-P0-001).
- **Tests:** 25 new DB-backed integration tests (replay, Promise.all
  concurrency on separate connections, stale/failed reclaim, permission,
  tenant isolation, no-poisoning); full tier 6 files / 52 tests green;
  Tier-1 528 green; build + tsc + lint clean. Concurrency suites
  stress-run 6×.
- **Explicitly left out (P0-006/007 boundary):** no webhook route wiring,
  no transcript dedupe, no `VAPI_DEFAULT_SHOP_ID` guard, no pruning cron
  (follow-up), no Aurinko changes.
