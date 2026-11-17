# Commercial Billing PR E1 — resume handoff

_Created 2026-11-16. Keep current at every milestone._

## Scope (PR E1)

Signed PLATFORM Stripe webhook reconciliation, subscription lifecycle evidence, safe lapse enforcement, owner-only
test-mode Customer Portal handoff, exact-subscription-period settlement binding, and the append-only signed-adjustment
contract. Fake/local Stripe only. No live Stripe, Dashboard mutation, shared Supabase, Vercel, production secrets/data,
deploy, pricing/package change or merge.

## Base / branch

- Worktree: `/Users/harryhatch/Gradia/worktrees/claude-commercial-billing-reconciliation`
- Branch: `claude/commercial-billing-reconciliation`
- Base: `origin/main` @ `a56a150` (merge of PR #147 settlement).

## Status

- [ ] Reading phase (AGENTS.md, AI_WORK_LOG, five governing docs, catalog, PR A/B/C/D docs, Next.js docs)
- [ ] Design recorded in `docs/architecture/COMMERCIAL_RECONCILIATION.md`
- [ ] Migration
- [ ] Libraries + route
- [ ] Tests (unit + integration)
- [ ] Migration/grant/tenant/upgrade verifier
- [ ] AI_WORK_LOG entry
- [ ] Rebase on latest origin/main, full validation
- [ ] PR opened (non-draft)

## Decisions

1. Migration `20261116140000_commercial_reconciliation.sql` (the local stack already holds an unrelated `20261116120000_provider_boundary_hold_unique`; avoid that version).
2. One transactional DB ingest function (`commercial_webhook_ingest`): the durable receipt is the replay claim (unique event id + payload digest, advisory lock). Tenant is resolved ONLY from
   bound customer / known subscription / checkout attempt / catalog+plan+price. It calls `commercial_subscription_apply_evidence` (extended in place with period params; still the single truth).
3. Ordering: older events never advance; same-second ties resolved by severity rank; canceled is terminal per subscription; integrity reconciliation reasons are sticky until `reviewed_reconciliation`.
4. Periods: new append-only `commercial_subscription_periods` (verified Stripe periods, chain back to subscription start). Settlement begin/evidence now require an exact verified period + complete chain; the UTC-day/28-31-day placeholder is removed for settlement.
   OPEN (fail closed, documented, NOT invented): seat proration refuses windows that are not UTC-midnight aligned (PR B), so unaligned Stripe periods cannot settle until the founder decides partial-day seat policy.
5. Lapse gate: `commercial_execution_gate(shop)`; shops with NO commercial account row are legacy (allowed, explicit). With an account: only `active` + reviewed evidence + period not elapsed allows. Wired at scheduled/run-now agent seams; nothing is deleted or disabled.
6. Provider facts (payment_failed/succeeded, cancellation(+scheduled), refund, credit_note) are append-only; NO automatic refund/credit/cancel/retry. Adjustments: append-only proposal + one human review decision; no `applied` state exists.
7. Portal: owner-only, DB authorizes + returns bound customer, `billing_portal/sessions` test mode, URL host-validated, never stored/logged.

## Last checks

(none yet)

## Uncommitted paths

- `docs/handoffs/COMMERCIAL_BILLING_PR_E_RESUME.md` (this file)

## Exact resume command

```
cd /Users/harryhatch/Gradia/worktrees/claude-commercial-billing-reconciliation && git status -sb && cat docs/handoffs/COMMERCIAL_BILLING_PR_E_RESUME.md
```
