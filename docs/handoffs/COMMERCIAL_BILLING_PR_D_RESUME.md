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

0. Mandatory reading done (AGENTS.md, AI_WORK_LOG billing entries + head/tail, five governing
   docs by grep for billing relevance + CHEAT_SHEET, catalog, PR A/B/C architecture docs).
   Handoff created. No implementation yet.

## Commands run / results

- `git fetch`; HEAD == origin/main c71035f, tree clean.

## Files changed

- `docs/handoffs/COMMERCIAL_BILLING_PR_D_RESUME.md` (this file)

## Next exact action

Read `src/lib/commercial-usage-preview.ts`, `commercial-usage-service.ts`, `commercial-billing*.ts`,
`stripe-commercial*.ts`, and the PR A/B/C migrations; then design the settlement migration.

## Blockers

None yet. Known: worktree has no `node_modules` (symlink from a sibling checkout for tests).
