# Call Copilot PR F: resume handoff

_2026-11-20. Branch `claude/call-copilot-review-ui`, based on `origin/main` `b872e3d` (merged PR E #162). Architecture:
`docs/architecture/CALL_COPILOT_REVIEW.md`._

## State

Implemented, validated locally, PR opened non-draft against `main`; **not merged, not deployed**. No provider, live model,
transcription, extractor seam, memory hand-off or autonomy change.

* Migration `supabase/migrations/20261120160000_call_copilot_review_reads.sql` (objects only: six functions, one index; only
  `call_copilot_review_list` and `call_copilot_review_detail` are executable, by `authenticated`).
* `src/lib/call-copilot/review-{dto,read,model}.ts`, `src/lib/call-review/{decide,cursor,workspace}.ts`,
  `src/app/actions/call-copilot-review.ts`, `src/components/gradia/call-review/*`, routes `/calls/copilot[/id]` and
  `/team/calls[/id]` (+ loading states), links from `/approvals` and `/team`, topbar title.
* Source locks updated on purpose: `eval/call-copilot-source-lock.test.ts`, `eval/call-copilot-proposals-source-lock.test.ts`
  (explicit allow-list in `eval/_call-copilot-pr-f-files.ts`), new `eval/call-copilot-review-source-lock.test.ts`.

## Evidence (2026-11-20, Node 24.15.0, disposable local stacks only)

* Unit: 218 files, 3,509 passed, 4 intentional skips. `tsc --noEmit` clean; `npm run lint` 0 errors (3 existing warnings);
  `next build --webpack` (Next 16.4.6) exit 0, all four new routes dynamic.
* New unit/component/server-action/source-lock tests: model 18, decide 22, actions 10, read 8, pages 9, UI 27, source lock 15.
* Integration `eval/integration/call-copilot-review.int.test.ts`: **26/26** on `gradia-isolated-tests` (tenant, role matrix,
  revocation, table-privilege refusal for owner session and anon, redaction, bounds/pagination, freshness parity with the claim in
  five scenarios, ordered bulk approval through the real executor with replay/idempotency, stop-on-first-denial, manager refusal at the
  app layer and at the claim, dismiss). Existing `call-copilot-proposals` (69) and `call-copilot-ingress` (53) integration suites pass with
  the migration applied (two ingress tests failed once with code-less transport errors right after a Postgres restart and passed on rerun).
* Migration from zero: a fresh private stack (`gradia-pr-f-zero`, 132 migrations applied in order, newest this one) and the upgraded
  shared stack have IDENTICAL definitions and ACLs for all 30 `call_copilot_*` functions and the new index. The private stack was
  stopped with `--no-backup`.
* Upgrade probe `scripts/verify-call-copilot-review-migration.py` (`PROBE_PROJECT=gradia-pr-f-zero`): PASS; `--mutate all` 12/12
  deliberate defects caught (anon grant, missing viewer check, table grant, snippets always shown, no digest check, whole-segment text,
  freshness ignoring CRM, manager without crm.read, cross-shop viewer, inactive member, candidate-id leak, provider-id leak).
* Browser pass (Chrome via Playwright against `next dev` on the private stack, fictional data, password sign-in with an injected
  cookie): list and detail at 1280px and 390px have no horizontal overflow, no duplicate ids, 0 unnamed buttons, sane heading order; a
  real approve (vehicle), approve-selected (customer), dismiss (stale booking) and approve-selected of three in order all returned the
  executor's answer and a fresh read. Screenshots could not be read back in this environment, so visual polish was judged from DOM
  measurements and component tests, not by eye. Browser console output was not reviewed.

## Findings

1. **Postgres 17.6 segfault**: calling a function the role has no EXECUTE on, under `SET LOCAL ROLE anon`, inside a plpgsql block with an
   `EXCEPTION` handler, crashes the backend (reproduced on a private stack; unrelated to the migration). My first probe runs did this on
   the shared `gradia-isolated-tests` stack twice (it recovered in seconds; another session's in-flight test could have seen a transport
   error). The probe no longer does it. Do not write probes that way.
2. **A customer approval stales the booking** (architecture doc, limit 1). Observed in the browser: approving the customer that fills a
   missing e-mail turns the booking into "Can't be approved: the customer record changed". A stale proposal can be dismissed (which also
   stops it blocking its message). The real fix is a PR E planner change (bind only what the booking depends on) or a re-prepare action.
3. `next dev` rewrites the tracked `AGENTS.md`; it was restored before committing.

## Re-run

```sh
npm ci && npm test && npx tsc --noEmit -p . && npm run lint && npx next build --webpack
# integration (disposable stack ONLY; keys from `supabase status --workdir tests -o env`, never commit them)
SUPABASE_TEST_URL=http://127.0.0.1:56531 GRADIA_DISPOSABLE_TEST=gradia-isolated-tests INTEGRATION=1 EVAL_LIVE=0 \
  SUPABASE_TEST_SERVICE_ROLE_KEY=... SUPABASE_SERVICE_ROLE_KEY=... SUPABASE_TEST_ANON_KEY=... \
  npx vitest run --fileParallelism=false eval/integration/call-copilot-review.int.test.ts
PROBE_PROJECT=<private gradia-* stack> python3 scripts/verify-call-copilot-review-migration.py [--mutate all]
```

The probe drops and re-applies the review objects inside one transaction and rolls back, so it runs on a stack that already has the
migration. Apply by hand on a stack with `docker exec -i supabase_db_<project> psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres < supabase/migrations/20261120160000_call_copilot_review_reads.sql`,
then insert the ledger row `('20261120160000','call_copilot_review_reads')` and `NOTIFY pgrst, 'reload schema'`.

## Gotchas

* **Deploy order**: migration first (or together). The pages fail closed (error state, no action) without it.
* The migration timestamp must stay newer than every migration on `main`; renumber the file, the probe's `NEW` and the source lock together.
* Pending-action ids for proposals are hash-derived, not RFC UUIDs: validate their shape only (`review-dto.ts`).
* Events after `call_ended` are ignored by the ledger; tests that need a late decline or pause must use a call that has not ended and
  the next sequence number.
* `staff` memberships cannot hold capabilities (DB check), so "staff with crm.read" cannot exist.
* Never stage `tests/supabase/.temp` or `.playwright-mcp/`.

## Next (not started)

1. Fix or surface limit 1 (planner binding, or an owner-run "prepare again" that reuses the evidence revision).
2. Provider seam + route, live extractor behind `CallExtractor` with an output cache (PR E handoff items).
3. Shop-timezone rendering in the DTO; an unknown-outcome reconciliation action; Edit / Keep-as-note once an edit can issue a fresh,
   re-verified proposal.
4. A signed-in human pass: screen reader, 200% zoom, real phone, manager browser session (the manager read-only route is covered by
   tests, not by a browser run).
