# Commercial Billing PR F2 — resume handoff

_Started 2026-11-18. Keep current at every milestone._

## Scope (PR F2)

Close the next launch-critical Founder Pilot Stripe **TEST-mode** gaps after merged PR #151 (F1):

1. exact deterministic subscription item set (licensed base Price + the six reviewed metered Prices);
2. Checkout creation/retrieval + signed-webhook normalization that require that exact set (any order);
3. promote the reviewed settlement mapping (F1 event names) from nulls — value basis unchanged;
4. safe service-only worker entry point (dispatch, reconcile, apply approved adjustments) with a lease;
5. explicit opt-in real Stripe TEST-clock acceptance harness + runbook (never CI, no secrets/IDs/URLs/payloads/PII, cleans up);
6. one-command readiness report that cannot say READY without F1 contract + exact items + webhook rule + worker readiness + real-test evidence.

TEST MODE ONLY. No live Stripe, no production/shared Supabase, no Vercel deploy, no real customers, no public pricing UI, no production secrets.
Founder direction (2026-11-18): the F1 recommended meter contract (event names, lookup keys, API version `2024-09-30.acacia`) is the
TEST-mode implementation contract. Production promotion still requires a final reviewed release decision (recorded in code + docs).
Do **not** merge the PR.

## Base / branch

- Worktree `/Users/harryhatch/Gradia/worktrees/claude-commercial-billing-sandbox-f2`, branch `claude/commercial-billing-sandbox-f2`,
  based on `origin/main` @ `536bb6b` (merge of PR #151).
- `node_modules` is a symlink (untracked). Never `git add -A`; add explicit paths. Never stage `tests/supabase/.temp`.
- The auto-mode classifier denied reading env/.env files for Stripe variables, so **no real Stripe credentials were inspected or used**.
  The real test-clock run therefore cannot be executed from this session (blocker reported in the PR).

## Audit findings (reading complete)

| # | Finding | Evidence |
| --- | --- | --- |
| A1 | Checkout sends ONE line item (base, qty 1); webhook `normalizeSubscription` requires `items.length === 1`. Meter events can never appear on a real invoice. | `stripe-commercial.ts`, `commercial-webhook.ts` |
| A2 | Stripe docs: Checkout `line_items.quantity` "should not be defined when `recurring.usage_type=metered`" → metered line items carry **no quantity**. Max 20 recurring line items per Checkout. | docs.stripe.com/api/checkout/sessions/create |
| A3 | `REVIEWED_SETTLEMENT_METER_MAPPING` still all-null; F1 contract event names live in `stripe-sandbox-contract.ts` (derived from `commercial-settlement.ts` → single source needed there). | code |
| A4 | Dispatch/reconcile/apply functions exist but nothing schedules or leases them; per-line claim tokens already prevent double-send, but overlapping sweeps duplicate provider reads / evidence rows / API spend. Nothing triggers `settleCommercialPeriod` (needs a live-owner actor) — OUT OF SCOPE, listed as next dependency. | `commercial-billing-operations.ts` |
| A5 | Test clocks (docs): create with `frozen_time` (past allowed for new customers), customer created with `test_clock`, advance ≤ 2 intervals, ≤3 customers / ≤3 subs, `DELETE` clock deletes customers+subs, draft invoice finalizes ~1 h after boundary, list endpoints hide clock objects unless a query clause (customer) is given. Hosted Checkout cannot be completed by API → the harness proves the Checkout *session* via the real client and creates the equivalent subscription by API (labelled honestly). | Stripe docs |
| A6 | Meter event timestamps must be ≤ now+5 min and ≥ now−35 d (real clock) → the harness starts the test clock ~25 days in the past so period 1 spans real "now". | meter event docs |
| A7 | Stripe docs now recommend Metronome for NEW usage-based integrations; Billing Meters "appropriate only if already using" them. Founder directed meters; recorded as a risk for the production decision. | docs.stripe.com/billing/subscriptions/usage-based/recording-usage |
| A8 | Cron mechanism: `Authorization: Bearer ${CRON_SECRET}` + `runCron()` wrapper + `CRON_REGISTRY` test-locked against `vercel.json`. | `src/lib/cron-run.ts`, provider-events-prune route |

## Design decisions

- One pure module `src/lib/commercial-subscription-items.ts` is the only item-set rule (webhook normalization + Checkout verification).
- Webhook: the DB is unchanged; normalization emits `price_lookup_key = <base key>` only for an exact item set, else `invalid_items` → existing sticky `catalog_mismatch`. Metadata stays a cross-check; tenant from server bindings.
- Meter event names: literals in `commercial-settlement.ts` (single source), mapping `provisioned`, version `settlement-mapping.v2-sandbox-contract`; unit test pins equality with the sandbox contract.
- Dispatch worker preflights read-only sandbox readiness (only when there is pending work) and refuses to send otherwise.
- Lease table `commercial_worker_leases` (one row per worker kind, token + expiry + generation) — an optimization against overlap, not the safety (per-line claims remain the safety).
- Cron route `/api/cron/commercial-billing`, disabled unless `GRADIA_COMMERCIAL_BILLING_WORKER=enabled` AND test config.

## Status

- [x] Reading phase (AGENTS.md, AI_WORK_LOG head, five governing docs, CHECKOUT/SETTLEMENT/RECONCILIATION/SANDBOX docs, runbook, F resume, catalog, F1 code)
- [x] Audit + design (this file)
- [x] M1 item-set module (`commercial-subscription-items.ts`) + `stripe-sandbox-snapshot.ts` split + readiness now returns verified price ids + tests (32)
- [x] M2 Checkout create/retrieve with exact set (metered items carry no quantity; retrieval expands `line_items`; reviewed API version) + fingerprint includes item-set digest
- [x] M3 webhook normalization (exact set, any order; item periods must agree) + mapping promoted to provisioned (`SETTLEMENT_METER_EVENT_NAMES` single source) + unit/int fixtures updated; int suites billing/reconciliation/settlement/acceptance/operations green (176)
- [x] M4 migration `20261118120000_commercial_worker_lease.sql` (applied to the local stack + recorded in schema_migrations), `commercial-billing-worker.ts` (leased, bounded, gated, sandbox-preflight), cron route `/api/cron/commercial-billing` (+ CRON_REGISTRY, vercel.json `*/10`, tenant-scoping allowlist), unit 13 + integration 11 green, `scripts/verify-commercial-worker-lease-migration.py` PASS and fails under a mutation (F1 verifier relaxed from "latest" to "present")
- [x] M5 harness `src/lib/stripe-test-clock-acceptance.ts` (+ `scripts/stripe-test-clock-acceptance.mjs`, `npm run billing:test-clock-acceptance`): opt-in env + confirm flag, CI refused, live refused, allowlisted/owned-object fenced transport, always cleans up, finite evidence; fake `eval/_fake-stripe-test-clock.ts`; tests 25. Real run NOT executed (no credentials). `createPlatformStripeClient` now takes an injectable transport; commercial transport allows DELETE (harness-only, fenced). Runbook still to write (M7).
- [x] M6 readiness report rewritten (`commercial-sandbox-report.ts`, `commercial-readiness-fixtures.ts`, `commercial-acceptance-evidence.ts`; script flags `--local`, `--evidence <file>`, `--attest <manual step>`): READY needs local fixtures + exact items + webhook rule + worker config + `--network` sandbox + current real evidence + attested manual steps; offline prints `REAL STRIPE ACCEPTANCE: NOT RUN`; tests 9
- [ ] M7 docs, work log, validation, PR

## Founder decisions still open (all fail closed)

Partial-day seat proration; grace/dunning timing; tax; refund/credit eligibility; resubscription after cancel; reviewer role/UI;
voice/SMS runtime gating; unknown-delivery resend policy; **who/what triggers `settleCommercialPeriod` (system actor)**; Metronome vs
Billing Meters for production; production promotion release decision.

## Exact resume command

```
cd /Users/harryhatch/Gradia/worktrees/claude-commercial-billing-sandbox-f2 && git status -sb && git log --oneline -8 && cat docs/handoffs/COMMERCIAL_BILLING_PR_F2_RESUME.md
```

Test env (disposable stack only): see `COMMERCIAL_BILLING_PR_F_RESUME.md` ("Test env").
