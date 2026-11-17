# Commercial Billing PR F — resume handoff

_Started 2026-11-17. Keep current at every milestone._

## Scope (PR F, first slice "F1")

Prove the Founder Pilot commercial system in Stripe **TEST MODE** (or a faithful local fixture) and make sandbox activation
operationally safe. No production, no live Stripe, no shared Supabase, no Vercel, no real customers, no public pricing UI.
Pricing authority stays `src/lib/approved-commercial-catalog.ts` (catalog `2026-11-03.v1`, Founder Pilot only).
Design: `docs/architecture/COMMERCIAL_SANDBOX_ACCEPTANCE.md` (written with the code).

## Base / branch

- Worktree `/Users/harryhatch/Gradia/worktrees/claude-commercial-billing-sandbox-acceptance`, branch `claude/commercial-billing-sandbox-acceptance`,
  based on `origin/main` @ `2d02d5e` (merge of PR #150).
- `node_modules` is a symlink to `/Users/harryhatch/Gradia/platform/node_modules` (untracked; never `git add -A`, add explicit paths).
- Disposable test stack `gradia-isolated-tests` (:56531 API, :56532 Postgres) is up and already holds migrations through `20261116140000`.

## Audit: what PRs A–E already implement (do not duplicate)

| Concern | Already exists | Where |
| --- | --- | --- |
| Approved catalog, deterministic preview, one combined cap, included allowances, highest-value-only, margin floors | PR A/B | `commercial-usage*.ts`, `commercial-pricing.ts`, `commercial-seat-proration.ts` |
| Checkout, platform customer, one-line-item Checkout, ambiguity handling | PR C | `commercial-billing*.ts`, `stripe-commercial.ts` |
| Immutable settlement per exact window + delivery outbox (`pending→in_flight→delivered/rejected/unknown`, write-once claim token, 120 s stale → unknown, never auto-retried), append-only `commercial_settlement_events`, value-basis mapping (quantity vs cents), DB re-check of arithmetic and `usage ≤ cap`, evidence digest + `CB409` on changed replay | PR D | `commercial-settlement*.ts`, migration `20261115130000` |
| Signed platform webhook, durable replay claim, tenant resolution, ordering, sticky integrity reasons, provider facts, verified append-only periods, lapse gate, owner-only Portal, settlement bound to exact verified period, signed-adjustment **contract** (propose/review/read; no application) | PR E1 | `commercial-webhook*.ts`, `commercial-execution-gate.ts`, migration `20261116140000` |

## Exact gap list (what F1 closes vs defers)

| # | Gap | Evidence | F1 |
| --- | --- | --- | --- |
| G1 | No machine check that the Stripe sandbox holds the exact approved Product / base Price / meters. Only the Price is checked, lazily, at Checkout time. | `verifyFounderPilotPrice` only | **Build** (read-only verifier + operator command) |
| G2 | Meter event names/meters are unprovisioned (`REVIEWED_SETTLEMENT_METER_MAPPING` all `null`) and there is no reviewed contract that says what to provision. | `commercial-settlement.ts` | **Build contract**; mapping stays unprovisioned (founder/reviewed commit flips it) |
| G3 | The meter API-version question is open: adapter pin is `2024-06-20`, meters launched with `2024-09-30.acacia`. | COMMERCIAL_SETTLEMENT.md limitation 4 | **Build** a single reviewed meter API version, enforced on verifier AND meter sends via the echoed `Stripe-Version` header; founder confirms |
| G4 | Delivery only runs inside `settleCommercialPeriod`; no worker sweeps pending/stale lines after a crash. | `deliverCommercialSettlement` is per-settlement | **Build** sweep (`commercial_settlement_delivery_pending` + dispatcher) |
| G5 | `unknown` delivery has no exit (never resend is correct, but nothing reconciles). | `delivery_status` guard forbids unknown→delivered | **Build** append-only reconciliation evidence read from Stripe meter event summaries; never resends |
| G6 | Value sent to Stripe vs authorized settlement/cap is checked in SQL at begin only; nothing proves the Stripe-side invoice reproduces the preview. | | **Build** pure invoice reconstruction from lines × metered unit prices; tests prove ≤ cap and = document total |
| G7 | Approved adjustments cannot reach Stripe (no `applied` state). | COMMERCIAL_RECONCILIATION.md "Late evidence" | **Build** application outbox: only `approved` reviews (both signs) → one pending invoice item; replay-safe |
| G8 | No end-to-end acceptance across checkout → webhook → period → usage → preview → settle → dispatch → invoice → failure → recovery → cancel → next period. | | **Build** faithful local fixture + integration test (no network) |
| G9 | No operator runbook / one-command READY report. | | **Build** `npm run billing:sandbox-acceptance` + runbook |
| G10 | Upgrade/RLS/ACL/replay/ordering/concurrency coverage for any new objects. | | **Build** with the migration |
| D1 | **Metered prices are not on the subscription.** Checkout carries exactly one item and the signed webhook refuses anything but exactly one item (`catalog_mismatch`). Meter events bill only if the subscription has a metered Price per meter. | `commercial-webhook.ts`, `commercial-billing-service.ts` | **Deferred** (F2): changes the activation guard; needs founder acceptance of the exact item set |
| D2 | Real Stripe test-clock run (customer + test clock + card + subscription + advance + invoice finalization) and the **invoice-finalization race**: usage for period N must reach Stripe before the renewal invoice finalizes (~1 h after the boundary). | not provable offline | **Deferred** (F2) |
| D3 | Polling reconciliation of subscription state when webhooks stop. | E1 limitation 3 | **Deferred** (F3) |
| D4 | Human review surface and reviewer role for adjustments. | | **Deferred** (founder policy) |
| D5 | Resubscription after cancel; voice/SMS runtime gating; seat partial-day proration; grace/dunning; tax; refund eligibility. | | **Unchanged, fail-closed**; decisions listed below |

## Status

- [x] Reading phase (AGENTS.md, AI_WORK_LOG head, five governing docs via targeted reading, CHECKOUT/SETTLEMENT/RECONCILIATION docs, E1 handoff, catalog, settlement + webhook + stripe adapter code and migrations, Stripe docs for meter events / summaries / meters / prices)
- [x] Audit + gap list (this file)
- [x] Sandbox contract (`stripe-sandbox-contract.ts`) + read-only verifier (`stripe-sandbox-verifier.ts`); transport got `apiVersion` + echoed-version capture
- [x] Operator command `npm run billing:sandbox-acceptance` (offline by default; `--network` = read-only GETs) + `commercial-sandbox-report.ts` + unit tests
- [x] Migration `20261117120000_commercial_sandbox_acceptance.sql` (applied to the local stack + recorded in schema_migrations); services `commercial-billing-operations.ts`, `commercial-adjustment-provider.ts`, reader in `commercial-settlement-provider.ts`
- [x] Upgrade verifier `scripts/verify-commercial-sandbox-acceptance-migration.py` (PASS; fails under a mutated migration)
- [x] Tests: unit 43 (contract/verifier/providers/report), integration operations 14 + lifecycle acceptance 9 (all green on the disposable stack; faithful local Stripe fake `eval/_fake-stripe-sandbox.ts`)
- [ ] REMAINING (usage limit hit here): (1) docs: `docs/architecture/COMMERCIAL_SANDBOX_ACCEPTANCE.md` + operator runbook (`docs/qa/`), covering the contract, outboxes, fake, command, limitations; (2) `docs/AI_WORK_LOG.md` tagged entry; (3) full validation: unit run was started (log not reviewed), `npx tsc --noEmit`, eslint on touched files, `next build --webpack`, FULL integration run compared with pristine `origin/main` (known baseline: ~64 failures in 10 messaging/delivery suites per E1 handoff); (4) `git push -u origin claude/commercial-billing-sandbox-acceptance`, open NON-draft PR to main (no production statement, scope, evidence, limits, founder decisions), do NOT merge.

## Observations to carry into the PR text

- A period whose usage exceeds the single combined cap is `cap_exceeded`: it can never settle (no clamp, no cap-raise flow). Founder decision needed.
- Meter events must reach Stripe before the renewal invoice finalizes; the fake shows later usage as `late_unbilled`. F2 must close this with a real test-clock run.
- Metered prices are not on the subscription and the webhook demands exactly one item (D1). Meter event names / lookup keys / API version `2024-09-30.acacia` are a PROPOSAL; the settlement mapping stays unprovisioned.
- New migration `20261117120000` only adds objects (dispatch worklists, `commercial_delivery_reconciliations`, `commercial_adjustment_applications` + events). `settleCommercialPeriod` gained optional `deferDelivery`.

## Provider facts verified from Stripe docs (2026-11-17)

- `POST /v1/billing/meter_events`: `identifier` uniqueness is enforced "within a rolling period of at least 24 hours"; the doc does **not**
  define the response to a duplicate, so a duplicate-resend is never assumed safe. `timestamp` must be within the past 35 days or ≤5 min ahead.
- `GET /v1/billing/meters/{id}/event_summaries`: `customer`, `start_time`, `end_time` (minute-aligned) required; returns `aggregated_value`.
  Used only as read evidence for reconciliation, never to resend.
- Meter object: `event_name`, `status`, `default_aggregation.formula`, `customer_mapping`, `value_settings.event_payload_key`, `event_time_window`, `livemode`.

## Founder decisions needed (all fail closed in code)

1. Confirm the proposed meter event names / metered-price lookup keys (F1 `stripe-sandbox-contract.ts`) and the meter API version.
2. Exact subscription item set once metered prices are attached (D1), and the webhook rule that accepts it.
3. Resend policy for an `unknown` meter delivery that reconciliation cannot confirm (F1 never resends).
4. Seat partial-day proration; grace/dunning timing; tax; refund/credit eligibility; who reviews adjustments (reviewer role);
   resubscription after cancel; whether voice/SMS channel handlers are gated.

## Uncommitted paths

See `git status`; commit after every milestone.

## Exact resume command

```
cd /Users/harryhatch/Gradia/worktrees/claude-commercial-billing-sandbox-acceptance && git status -sb && git log --oneline -8 && cat docs/handoffs/COMMERCIAL_BILLING_PR_F_RESUME.md
```

Test env (disposable stack only):

```
export SUPABASE_TEST_URL=http://127.0.0.1:56531 GRADIA_DISPOSABLE_TEST=gradia-isolated-tests EVAL_LIVE=0 INTEGRATION=1
# SUPABASE_TEST_ANON_KEY / SUPABASE_TEST_SERVICE_ROLE_KEY: from `supabase status --workdir tests -o env`
```
