# Commercial Billing PR D — resume handoff

_Keep this file current after every milestone. Started 2026-11-15._

## Objective

Reviewed Stripe meter/event mapping, deterministic settlement of a closed commercial
period from the existing append-only usage + membership evidence, and an
invoice/settlement preview. Does NOT reimplement pricing, recognition, seat history,
checkout or subscription state (PRs A/B/C).

## Baseline / branch

- Worktree: `/Users/harryhatch/Gradia/worktrees/claude-commercial-billing-settlement`
- Branch: `claude/commercial-billing-settlement`
- Base: `origin/main` `c71035fb5280f725c268f7995ef0e532c5a3b039`

## Invariants (do not weaken)

- Postgres ledger is billing authority; Stripe is a test-mode collection adapter only.
- Settle only an exact half-open closed UTC window with complete membership coverage and
  an `ok` deterministic preview. Highest-value-only outcomes, included usage, dynamic
  margin floors, daily seat proration, one combined cap exactly as the PR A/B preview.
- Never bill drafts, failures, unknown, human-completed, duplicates, inferred legacy usage.
- Immutable attempts/outbox/evidence, tenant binding, stable idempotency keys, exact replay,
  changed-replay conflict, concurrency protection, explicit unknown/reconciliation-required.
  Never auto-retry an ambiguous provider result.
- Only reviewed finite metrics/events; no model-provided names/quantities/prices/ids/periods.
- Test mode only; refuse live-shaped keys/objects; platform billing only, never Connect.
- No real Stripe call/object, deploy, shared Supabase change, secrets, merge, UI redesign.
- Settlement never marks an invoice paid or a subscription active (PR E / PR F own that).
- Missing Stripe meter/product identifiers => fail-closed config; do not invent lookup keys,
  meter event names, tax, discounts, trials, credits or terms.

## Current checkpoint

1. DONE: mandatory reading; handoff; migration `supabase/migrations/20261115120000_commercial_settlement.sql`
   (applied to disposable stack `gradia-isolated-tests` :56531 via `docker exec -i supabase_db_gradia-isolated-tests psql`
   + a `supabase_migrations.schema_migrations` insert); pure contract `src/lib/commercial-settlement.ts`;
   provider boundary `src/lib/commercial-settlement-provider.ts`; service
   `src/lib/commercial-settlement-service.ts`; small refactor of `commercial-usage-service.ts`
   (exports `assembleCommercialPeriodPreview`, `parseMembershipRead`; behavior unchanged);
   unit tests `eval/commercial-settlement.test.ts` (30 pass).
2. TODO (in order): integration test `eval/integration/commercial-settlement.int.test.ts`; upgrade verifier
   `scripts/verify-commercial-settlement-migration.py`; architecture doc
   `docs/architecture/COMMERCIAL_SETTLEMENT.md`; `docs/AI_WORK_LOG.md` entry; lint / typecheck /
   production build / full unit; rebase on origin/main; push; open non-draft PR to main (do NOT merge).

## Design decisions (for reviewers)

- One settlement per exact window (UNIQUE shop+window); changed replay or late evidence => `CB409`.
- DB recomputes an evidence digest (usage + membership reads at the fixed `as_of`) and refuses on mismatch.
- Meter mapping is reviewed code and ships UNPROVISIONED (all event names null) => fail closed.
  Value basis (PROPOSED; founder confirmation needed at provisioning): outcomes = `billed_quantity`,
  voice/SMS/seat = `charge_cents` (their price is per-fact/per-day, one provider unit price cannot express it).
  Seat proration is a 6th component (otherwise it has no delivery path).
- Delivery: claim (token) -> provider -> record; stale in_flight (>120 s) => unknown; never auto-retried.
- Rejected deliveries are terminal in PR D (no requeue path) -> PR E reconciliation.
- Meter API version: the adapter pins Stripe API `2024-06-20`; confirm `/v1/billing/meter_events` support
  (Meters launched with `2024-09-30.acacia`) before provisioning. PR F dependency.

## Commands run / results

- `git fetch`; HEAD == origin/main c71035f, tree clean at start.
- `npx tsc --noEmit`: only pre-existing errors (`@testing-library/*` missing from linked node_modules).
- Existing usage/seat unit tests after refactor: 87 pass. New unit file: 30 pass.
- Migration applied cleanly on the disposable stack.

## Files changed

- supabase/migrations/20261115120000_commercial_settlement.sql
- src/lib/commercial-settlement.ts, commercial-settlement-provider.ts, commercial-settlement-service.ts
- src/lib/commercial-usage-service.ts (refactor only)
- eval/commercial-settlement.test.ts
- docs/handoffs/COMMERCIAL_BILLING_PR_D_RESUME.md

## Next exact action

Write `eval/integration/commercial-settlement.int.test.ts` (seed shop + bound platform customer + usage +
membership coverage; env from `supabase status --workdir tests -o env`, `GRADIA_DISPOSABLE_TEST=gradia-isolated-tests`,
run `EVAL_LIVE=0 INTEGRATION=1 npx vitest run --fileParallelism=false eval/integration/commercial-settlement.int.test.ts`).

## Blockers

None. Worktree `node_modules` is a symlink to `/Users/harryhatch/Gradia/platform/node_modules`
(lacks @testing-library, so `eval/agent-builder-navigation.test.tsx` cannot run; unrelated).
