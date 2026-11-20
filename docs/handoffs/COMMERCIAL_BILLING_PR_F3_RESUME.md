# Commercial Billing PR F3 — resume handoff

_Started and finished 2026-11-19. Keep current at every milestone._

## Scope (PR F3)

Safe **TEST-mode polling reconciliation of subscription state** for the case where signed Stripe webhooks stop, on top of merged F1 (#151) and F2 (#153) and `origin/main` @ `01eacaa`.
Postgres stays the authority, Stripe is evidence. TEST MODE ONLY. No live Stripe, no production/shared Supabase, no deploy, no production secrets, no real customers, no tax/dunning/refund/price/legal decision.
Do **not** merge the PR (non-draft, awaiting founder review).

## Base / branch

- Worktree `/Users/harryhatch/Gradia/worktrees/claude-commercial-billing-f3-reconciliation`, branch `claude/commercial-billing-f3-reconciliation`, based on `origin/main` @ `01eacaa`.
- `node_modules` is a symlink to `../codex-commercial-env-template/node_modules` (Next 16.4.6, lockfile identical). Untracked; never `git add -A`; never stage `tests/supabase/.temp`.
- Next 16.4.6 route-handler docs (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`) were read; the cron route is unchanged apart from a comment (it stays a GET-only handler wrapped by `runCron`).

## What was built

| Piece | Where |
| --- | --- |
| Migration `20261119120000_commercial_subscription_poll.sql` (schedule + append-only observations, claim/record/overview functions, `subscription_poll` lease row; `apply_evidence` and `commercial_execution_gate` widened in place; three closed sets widened) | `supabase/migrations/` |
| GET-only reader + pure decisions | `src/lib/commercial-subscription-poll.ts` |
| Claim → read → decide → record orchestration | `src/lib/commercial-subscription-poll-service.ts` |
| Fourth leased worker task, run-level 240 s budget | `src/lib/commercial-billing-worker.ts` |
| `normalizeSubscription` exported (single normalizer for webhook + poll) | `src/lib/commercial-webhook.ts` |
| Tests | `eval/commercial-subscription-poll.test.ts` (28), `eval/commercial-billing-worker.test.ts` (19), `eval/integration/commercial-subscription-poll.int.test.ts` (32); existing worker int test updated for the 4th task |
| Upgrade verifier (+ mutation checks) | `scripts/verify-commercial-subscription-poll-migration.py` |
| Docs | `docs/architecture/COMMERCIAL_SANDBOX_ACCEPTANCE.md` ("PR F3"), `COMMERCIAL_RECONCILIATION.md` (limitation 3 note), `docs/qa/COMMERCIAL_SANDBOX_ACCEPTANCE_RUNBOOK.md` (section 7) |

## Design decisions worth knowing (so the next session does not re-derive them)

1. **Evidence source `provider_poll`, not `reviewed_reconciliation`.** The writer's sticky rule only lets `reviewed_reconciliation` clear an integrity block, so a poll can never clear one. The writer refuses `provider_poll`
   unless a verified period is required; the lapse gate opens for polled `active` evidence only with a verified period. (The gate whitelisted its sources; the first integration run proved polled evidence would otherwise
   never reopen it, so the gate was widened deliberately.)
2. **The tenant is never read from Stripe.** The claim returns shop/customer/known subscription/Checkout attempt from server rows. A never-seen subscription is discovered only through the server-held Checkout session. The metadata
   `shop_id` is a cross-check only: a disagreement blocks the customer's own shop (like the webhook) and never touches the shop the metadata named. The metadata `checkout_attempt_id` is discarded.
3. **Ordering.** Polled evidence is ordered at claim time − 5 minutes (the webhook signature tolerance), so a fresh signed webhook always wins.
4. **Ambiguity never becomes `active`.** Truncated list/items, live object, foreign customer, another live subscription on the customer, unverified or elapsed period → `ambiguous`, nothing changes. Restrictive states
   (`past_due`, `canceled`, `incomplete`, `unknown`) are still applied (fail-closed direction).
5. **Rate limit = schedule row.** 15 min normally, 6 h for a healthy `active` shop with > 2 h left, doubling backoff (cap 6 h) on ambiguous/unreadable/refused/abandoned claims. The per-shop claim (account row mutex + live claim) is the safety;
   the worker lease is only an optimization (tested with 10 concurrent claimers and 5 concurrent sweeps).
6. A run in which **every** attempted poll was unreadable is `failed` (503 → ops alert); ambiguity/refusal/overdue is `partial` (visible, no alert).
7. Task is `not_configured` (quiet skip) when `WorkerDeps.subscriptionPollReader` is `undefined`, a misconfiguration when `null`. `resolveWorkerDeps` always sets it.

## Verification (2026-11-19, base `01eacaa`, Node 24.15.0, disposable stack `gradia-isolated-tests`)

- Unit `npm test`: 202 files, 3205 passed, 4 intentional skips (the `jsdom` "navigation not implemented" console noise is pre-existing). `tsc --noEmit` clean (known `@testing-library` types aside); ESLint clean on touched files.
- Integration (applied the new migration to the stack, ledger 128): `commercial-subscription-poll` 32/32 (three consecutive runs), and together with the other commercial suites, `membership-billing` and `tenant-isolation`:
  10 files / 263 tests passed (`commercial-worker` 11, `-reconciliation` 48, `-billing` 72, `-settlement` 33, `-sandbox-operations` 14, `-sandbox-acceptance` 9, `-usage` 21 …).
- Upgrade verifiers: `verify-commercial-subscription-poll-migration.py` PASS (restores the E1 writer and gate from the E1 migration text, seeds legacy data, proves no row rewritten, ACLs, claim/record/ordering/tenant/backoff/immutability, cascade; rolled back);
  `--mutate sticky` and `--mutate tenant` are both detected (EXPECTED FAIL). F1 and F2 verifiers still PASS. The E1/PR C/PR D/usage verifiers assert "my migration is the latest" and fail on `main` already (historical; unchanged).
- `next build --webpack` (Next 16.4.6): exit 0; `/api/cron/commercial-billing` is in the build.
- NOT run: the full 81-file integration run (known unrelated messaging/delivery drift on main, see the F2 handoff); any real Stripe request.

## Manual Stripe evidence still required (nothing below has been run against real Stripe)

Exact steps: runbook section 7 (`docs/qa/COMMERCIAL_SANDBOX_ACCEPTANCE_RUNBOOK.md`). Summary:

1. Confirm real object shapes (list-by-customer on `2024-09-30.acacia` shows the test-clock customer's subscription, `items.has_more=false`, top-level period + `start_date`, item `lookup_key`s; completed hosted Checkout session exposes `subscription` id, `client_reference_id`, `customer`).
2. Webhooks stopped → advance the test clock over a renewal → gate blocks → next cron tick records `applied` → gate allows; a later signed event converges.
3. Failure directions with webhooks stopped: failing card → `past_due` blocks; Dashboard cancel → `canceled` terminal; second live subscription → `ambiguous` `unexpected_subscription`.
4. Dashboard log shows only GETs from the platform key during polling.
5. No 429 at the polling volume. 6. Delete the test clock.
Plus the two earlier manual steps (hosted Checkout completion, Stripe-delivered signed webhook) and the real test-clock harness run (F2 runbook section 4) are still outstanding.

## Founder decisions still open (all fail closed)

Partial-day seat proration; grace/dunning timing; tax; refund/credit eligibility; resubscription after cancel; reviewer role/UI; voice/SMS runtime gating; unknown-delivery resend policy; who triggers `settleCommercialPeriod`
(system actor); Metronome vs Billing Meters; production promotion release decision. New in F3, both optional follow-ups: whether polling should also advance expired Checkout attempts, and whether a duplicate live subscription found by polling
should become a recorded sticky `duplicate_subscription` instead of only blocking polled `active`.

## Exact resume command

```
cd /Users/harryhatch/Gradia/worktrees/claude-commercial-billing-f3-reconciliation && git status -sb && git log --oneline -8 && cat docs/handoffs/COMMERCIAL_BILLING_PR_F3_RESUME.md
```

Test env (disposable stack only): see `COMMERCIAL_BILLING_PR_F_RESUME.md` ("Test env"). Apply a new migration to the stack with `docker exec -i supabase_db_gradia-isolated-tests psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres < <file>`
plus a `supabase_migrations.schema_migrations` insert (`supabase db reset` is denied in this environment).
