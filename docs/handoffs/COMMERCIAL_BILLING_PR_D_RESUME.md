# Commercial Billing PR D — resume handoff

_Updated 2026-11-15 after the implementation was complete and verified._

## Objective

Reviewed Stripe meter/event mapping, deterministic settlement of a closed commercial period from the existing
append-only usage + membership evidence, and an invoice/settlement preview. Does NOT reimplement pricing,
recognition, seat history, checkout or subscription state (PRs A/B/C).

## Baseline / branch

- Worktree: `/Users/harryhatch/Gradia/worktrees/claude-commercial-billing-settlement`
- Branch: `claude/commercial-billing-settlement`
- Started from `origin/main` `c71035f`; rebased onto `1ce68de` (PR #144) before the PR was opened.

## Invariants (do not weaken)

- Postgres ledger is billing authority; Stripe is a test-mode collection adapter only.
- Settle only an exact half-open closed UTC window with complete membership coverage and an `ok` preview.
- Never bill drafts, failures, unknown, human-completed, duplicates, inferred legacy usage.
- Immutable settlement/outbox/evidence, tenant binding, stable idempotency keys, exact replay, changed-replay
  conflict, concurrency protection, explicit unknown. Never auto-retry an ambiguous provider result.
- Only reviewed finite metrics/events; no model-provided names/quantities/prices/ids/periods.
- Test mode only; refuse live-shaped keys/objects; platform billing only, never Connect.
- Settlement never marks an invoice paid or a subscription active (PR E / PR F own that).

## Current checkpoint: IMPLEMENTATION COMPLETE, PR opened for review (do not merge)

Done: migration `supabase/migrations/20261115120000_commercial_settlement.sql`; `src/lib/commercial-settlement.ts`,
`commercial-settlement-provider.ts`, `commercial-settlement-service.ts`; refactor of `commercial-usage-service.ts`
(exports `assembleCommercialPeriodPreview`, `parseMembershipRead`; behavior unchanged); unit tests
`eval/commercial-settlement.test.ts` (30); integration `eval/integration/commercial-settlement.int.test.ts` (33);
verifier `scripts/verify-commercial-settlement-migration.py`; doc `docs/architecture/COMMERCIAL_SETTLEMENT.md`;
`docs/AI_WORK_LOG.md` entry.

## Commands run / results (exact)

- `npx tsc --noEmit -p .`: clean except pre-existing `@testing-library/*` missing from the linked `node_modules`.
- `npx eslint` on all touched files: clean.
- Unit, full (`vitest run --exclude '**/*.eval.test.ts' --exclude '**/integration/**'`): 178 files, 2,679 passed / 4 skipped,
  plus 1 error: `Cannot find package 'jsdom'` (symlinked `node_modules`; `eval/agent-builder-navigation.test.tsx` cannot start;
  unrelated). Re-run after rebase on the commercial subset: 11 files, 258 passed.
- Integration on `gradia-isolated-tests` (:56531): settlement 33/33 (also after rebase); PR A 21/21, PR B 15/15, PR C 70/70.
  The full 69-file integration suite was NOT run.
- `python3 scripts/verify-commercial-settlement-migration.py`: PASS (and FAIL when an expectation is mutated).
- `npx next build --webpack`: pass. Default `next build` (Turbopack) fails only because `node_modules` is a symlink.

## Next exact action (after review)

Address review findings. Do NOT merge. Follow-ups are owned elsewhere (see the "Stripe configuration and the later
provisioning dependency" section of `docs/architecture/COMMERCIAL_SETTLEMENT.md`): founder confirmation of the proposed
value basis, sandbox meter provisioning + a reviewed commit naming the events and flipping the mapping to `provisioned`,
Stripe API version check for `/v1/billing/meter_events`, subscription-period alignment (PR E/F).

## Blockers

None. Decision boundary reached and recorded, not guessed: no approved Stripe meter/event names exist, so the mapping
ships unprovisioned (fail closed); the value basis for voice/SMS/seat (charge cents) is a proposal needing founder sign-off.

## Environment notes

- `node_modules` in this worktree is a symlink to `/Users/harryhatch/Gradia/platform/node_modules`.
- Disposable stack env: `supabase status --workdir tests -o env`; set `SUPABASE_TEST_URL`, `SUPABASE_TEST_ANON_KEY`,
  `SUPABASE_TEST_SERVICE_ROLE_KEY`, `GRADIA_DISPOSABLE_TEST=gradia-isolated-tests`, then
  `EVAL_LIVE=0 INTEGRATION=1 npx vitest run --fileParallelism=false eval/integration/commercial-settlement.int.test.ts`.
- The migration was applied to the stack with `docker exec -i supabase_db_gradia-isolated-tests psql` plus a ledger insert
  (`supabase db reset` is blocked in this environment). The integration fixture backdates coverage via the stack's pg-meta
  `/pg/query` endpoint.
