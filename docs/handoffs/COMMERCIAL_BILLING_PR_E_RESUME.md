# Commercial Billing PR E1 — resume handoff

_Updated 2026-11-16. Keep current at every milestone._

## Scope (PR E1)

Signed PLATFORM Stripe webhook reconciliation, subscription lifecycle evidence, safe lapse enforcement, owner-only
test-mode Customer Portal handoff, exact-subscription-period settlement binding, and the append-only signed-adjustment
contract. Fake/local Stripe only. No live Stripe, Dashboard mutation, shared Supabase, Vercel, production secrets/data,
deploy, pricing/package change or merge. Full design: `docs/architecture/COMMERCIAL_RECONCILIATION.md`.

## Base / branch

- Worktree: `/Users/harryhatch/Gradia/worktrees/claude-commercial-billing-reconciliation`
- Branch: `claude/commercial-billing-reconciliation` (pushed to `origin`)
- Started from `origin/main` @ `a56a150` (merge of PR #147 settlement). Rebase onto the latest `origin/main` before opening the PR.
- `node_modules` is a symlink to `/Users/harryhatch/Gradia/platform/node_modules` (untracked; never `git add -A`, add explicit paths).

## Status

- [x] Reading phase (AGENTS.md, AI_WORK_LOG, catalog, PR A/B/C/D architecture + handoffs, Next.js Route Handler docs). The five governing
      documents were read for the billing-relevant sections (owner controls billing; approval-first) via targeted search, not every line.
- [x] Design: `docs/architecture/COMMERCIAL_RECONCILIATION.md`
- [x] Migration `supabase/migrations/20261116140000_commercial_reconciliation.sql` (applied to the local stack)
- [x] Libraries + route (`commercial-webhook*.ts`, `commercial-execution-gate.ts`, portal, settlement rules, agent-runtime wiring)
- [x] Tests: unit `eval/commercial-webhook.test.ts` (22), integration `eval/integration/commercial-reconciliation.int.test.ts` (48);
      PR C (70) and PR D (33) integration fixtures updated to seed a verified period
- [x] Upgrade verifier `scripts/verify-commercial-reconciliation-migration.py` (PASS; fails when mutated)
- [x] AI_WORK_LOG entry
- [x] Full validation (see "Last checks")
- [x] PR opened (non-draft), not merged

## Decisions (recorded; do not re-litigate)

1. Migration version `20261116140000` (the local stack already holds an unrelated `20261116120000_provider_boundary_hold_unique`).
2. One transactional DB ingest function: durable receipt = replay claim; tenant resolved ONLY from bound customer / known subscription / own
   Checkout attempt; calls `commercial_subscription_apply_evidence` (extended in place; `p_require_period` is true only on the webhook path so
   existing reviewed/legacy fixtures keep working).
3. Ordering: older never advances; same-second severity rank; canceled terminal; duplicate subscription blocks in any arrival order; integrity
   reasons sticky until `reviewed_reconciliation`.
4. Periods: append-only `commercial_subscription_periods`; settlement begin/evidence require an exact verified period + complete chain.
   OPEN founder decision (fails closed): seat proration refuses windows not aligned to UTC midnight, so an unaligned Stripe period verifies but
   previews `seat_proration_unavailable`.
5. Lapse gate: no account row = legacy (allowed); account present = only reviewed `active` with the period not elapsed; no grace. Wired at the
   scheduled tick, run-now and event recipes only (voice/SMS handlers are a documented follow-on).
6. Provider facts and adjustments never act: no refund/credit/cancel/retry; no `applied` state.
7. Portal: owner-only via DB authority; URL validated, never stored/logged.
8. The older per-migration verifiers (`verify-commercial-billing-migration.py`, `verify-commercial-settlement-migration.py`) assert their
   migration is the latest and are historical (the PR C one already was after PR D). Not changed.

## Last checks (final)

- `origin/main` had not advanced (`a56a150`), so no rebase was needed. Branch pushed.
- Unit (full, excluding eval/integration): 181 files, 2,725 passed / 4 skipped, 0 failed. New: `commercial-webhook` 22; updated: `commercial-settlement` 30,
  `agent-runtime-binding` (+2 lapse-gate tests), `tenant-scoping` (commercial webhook route is a reviewed service-role importer).
- `tsc --noEmit` clean (except the known missing `@testing-library` types); eslint clean on touched files; `next build --webpack` passes and lists
  `/api/stripe/commercial-webhook`.
- Integration on `gradia-isolated-tests` (:56531): reconciliation 48/48; PR C 70/70; PR D 33/33; usage, agent-runtime-binding and
  agent-definition-revisions green. FULL integration run (77 files): 969 passed / 64 failed in 10 files (service-proof-replay, whisper-reply-context,
  held-quote-send, qualification-stale-at-send, qualification-delivery-acceptance, delivery-lifecycle-acceptance, lead-workflow-acceptance,
  delegated-message-approval, twilio-disconnect-mid-send, tenant-relationships). ALL of them fail identically on a pristine `origin/main` worktree against
  the same stack (re-run: 63 in the first nine files, 1 in tenant-relationships): messaging/delivery suites, environment drift from the shared stack,
  not caused by E1. No billing, agent-runtime or settlement suite fails.
- Upgrade verifier `python3 scripts/verify-commercial-reconciliation-migration.py`: PASS (and FAIL under a mutated expectation).

## Remaining

1. PR is open for review. Do NOT merge. Address review findings.
2. If a newer migration lands on `main` with a colliding or later version, rename ours to a later unused version and update
   `scripts/verify-commercial-reconciliation-migration.py` (`NEW`) and the doc/log references.
3. Founder decisions still needed (all fail closed): partial-day seat proration for an unaligned Stripe period, grace length and dunning timing, tax,
   refund/credit eligibility and who reviews adjustments, meter names and the API-version check, Customer Portal Dashboard configuration,
   resubscription after cancellation, whether voice/SMS channel handlers must also be gated.

## Uncommitted paths

None at this checkpoint (everything committed and pushed) except the untracked `tests/supabase/.temp/` stack scratch directory (never add it).

## Exact resume command

```
cd /Users/harryhatch/Gradia/worktrees/claude-commercial-billing-reconciliation && git status -sb && git log --oneline -8 && cat docs/handoffs/COMMERCIAL_BILLING_PR_E_RESUME.md
```

Test env (disposable stack only):

```
export SUPABASE_TEST_URL=http://127.0.0.1:56531 GRADIA_DISPOSABLE_TEST=gradia-isolated-tests EVAL_LIVE=0 INTEGRATION=1
# SUPABASE_TEST_ANON_KEY / SUPABASE_TEST_SERVICE_ROLE_KEY: from `supabase status --workdir tests -o env`
npx vitest run --fileParallelism=false eval/integration/commercial-reconciliation.int.test.ts
python3 scripts/verify-commercial-reconciliation-migration.py
```
