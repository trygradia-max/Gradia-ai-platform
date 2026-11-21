# Call Copilot PR E: resume handoff

_2026-11-20. Branch `claude/call-copilot-proposals`, based on `origin/main` `afe4f5f` (merged PR D #159 and the
selected-playbook lifecycle). Architecture: `docs/architecture/CALL_COPILOT_PROPOSALS.md`._

## State

Implemented and verified on the disposable stack: migration `20261120140000_call_copilot_proposals.sql`,
`src/lib/call-copilot/{extraction-schema,redaction,transcript,extractor,crm-resolution,planner,proposals}.ts`,
six denial strings in `src/lib/approvals.ts`, unit tests (`eval/call-copilot-{redaction,planner,extraction,proposals-source-lock}.test.ts`,
fixtures `eval/_call-copilot-fixtures.ts`), integration `eval/integration/call-copilot-proposals.int.test.ts`
(41 tests) and the upgrade probe `scripts/verify-call-copilot-proposals-migration.py` (with `--mutate`).
Open as a non-draft PR against `main`; **not merged, not deployed**. No route, UI, provider or live model.

## Evidence (what was actually observed, 2026-11-20, Node 24.15.0, disposable local stacks only)

* Unit: 209 files, 3,365 passed, 4 intentional skips. `tsc --noEmit` clean; full `npm run lint` 0 errors (3 existing warnings);
  `next build --webpack` (Next 16.4.6) exit 0. No route, page or action changed, so the Next route docs were not needed.
* Upgrade probe `scripts/verify-call-copilot-proposals-migration.py`: PASS on a stack holding existing shops, customers,
  vehicles, interactions, pending actions of several types, a receptionist call record and a consented PR D ledger. It proves every
  existing table (rows, columns, policies, grants, triggers, constraints) and the claim functions' ACLs are unchanged, that
  `control_claim` differs from its previous definition only by the recheck hook, that an identical ordinary claim returns and audits
  exactly what it did before, and the new behaviour. `--mutate all`: 15 deliberate defects (hook removed, gate removed before
  storage, card check removed, payload edit allowed, consent / evidence / requester / CRM change ignored, automatic claim allowed,
  open call or pause gap called complete, proposal staged as approved, forged citation trusted, conflict not failing closed,
  memory published active...) each make the probe FAIL.
* From zero: a fresh private stack (`gradia-pr-e-zero`, 131 migrations applied in order by `supabase start`, newest
  `20261120140000`) and the upgraded shared stack have IDENTICAL `call_copilot_*` function / column / constraint definitions and an
  identical `control_claim` (md5 of `pg_get_functiondef`). The private stack was stopped with `--no-backup` afterwards.
* Integration `call-copilot-proposals.int.test.ts` (41 tests): clean 41/41 on the from-zero stack twice at the final tree, and
  3/3 clean on the shared stack at the previous tree (40 tests). Other runs failed only from host load, never from a logic
  assertion: `owner sign-in failed: {}`, `Test timed out in 60000ms` during a 990 s run, and a `fixture` assertion inside
  `createGovernedFixture().governed()` (the trusted evaluator) under the same stall. Test-only fixes made on the way: a bare `4111`
  regex that could match inside a UUID/timestamp, sign-in retry for transport noise.
* Existing integration suites that exercise the replaced `control_claim` (approvals, control-execution, delegated-message-approval,
  agent-capture, mcp-capabilities, reviewed-memory, customer-merge, tenant-isolation, team-permissions, create-quote-action,
  tenant-relationships, service-proof-replay) passed (188 passed, 3 skipped) on the from-zero stack; the failures in that run and
  in the full-folder run on the shared stack were `57014` statement timeouts, code-less transport errors, `An invalid response was
  received from the upstream server`, one sign-in failure, and PR D's exhaustive arrival-order permutation tests timing out
  (60 s each). The host's Docker VM was saturated by other sessions' containers (load average 20-55; one Docker VM process at 860%
  CPU; a `realtime` container on the shared stack at 90% CPU), runs that took 15 s took 100-1,000 s. **A single clean run of the
  whole `eval/integration` folder at the final tree was NOT obtained here; treat `ci-integration` as the authority and re-run the
  folder first on a quiet machine.** Earlier on the shared stack, with the migration applied and before the machine degraded, the whole
  folder gave 1,248 passed / 4 failed (the same transport errors, 3 in `call-copilot-ingress`, 1 in `lead-intake`), and PR D's
  `call-copilot-ingress.int.test.ts` passed 53/53 with the migration applied.
* Local runner caveat: several suites (service-proof-replay, whisper-reply-context, held-quote-send, qualification-*, delivery-*,
  delegated-message-approval...) need `SUPABASE_SERVICE_ROLE_KEY` exported too (CI's `export-test-env.mjs` sets it). Without it 64
  tests fail identically with and without this migration; with it all 103 of those pass on the pre-migration schema.

## Review-fix round (2026-11-20, same branch / PR #162)

Three confirmed blockers fixed in place (the migration is unmerged, so it was edited, not superseded):

1. **Identity.** `run_key` now includes the requesting member and the exact agent definition binding (and the CRM digest includes the shop
   timezone); `proposal_key` includes confidence, ambiguity, customer, vehicle, the CRM binding snapshot, the definition binding and the
   requester. New table `call_copilot_run_proposals` makes a deduplicated answer and its replays name the same ids. Tests: a different known
   customer, a different requester and a changed active definition (revision 2 of the same agent) each create their own run and proposals.
2. **Customer memory is review-only.** `call_copilot_submit_memory_candidate`, `call_copilot_memory_submissions`, the `authenticated`
   grant and `submitMemoryCandidate` are removed; a table CHECK plus a writer guard refuse an executable memory proposal; the review reason is
   now `customer_memory_review_only`. Source lock + probe + integration tests assert no path into reviewed memory.
3. **Post-claim effects.** `call_copilot_pre_effect_recheck` (+ shared `call_copilot_recheck`) and `denyBeforeEffect` in `approvals.ts`
   before booking (twice), draft quote and text. Fail-closed, audited, and mutation-tested (disabling it fails 11 integration tests).
   Granted to `authenticated` as well as `service_role` (the dashboard executor runs with the approver's session); caller verified inside.
4. **Appointment grounding** (`timing-grounding.ts`): start and duration must be literally supported by the cited words in the shop's
   timezone; hedged or ambiguous timing is review-only (unit + integration + planner tests).

### Evidence for the review-fix round (2026-11-20, Node 24.15.0, disposable stacks only)

* Unit: 211 files, 3,400 passed, 4 skipped. `tsc --noEmit` clean; full `npm run lint` 0 errors (3 existing warnings); `next build --webpack`
  (Next 16.4.6) exit 0.
* Probe `scripts/verify-call-copilot-proposals-migration.py` (new `PROBE_PROJECT` override, default unchanged) PASS on a stack reset to the
  pre-migration state; `--mutate all` 21 of 21 defects caught (6 new: run key without requester, proposal key without subject, deduplicated
  answer without ids, pre-effect recheck ignored, pre-effect accepts an unclaimed action, memory stageable).
* From zero: a fresh stack applied all 131 migrations; its `call_copilot_*` / `control_claim` / claim functions (definition md5 + ACL),
  columns, constraints, indexes, triggers and table ACLs are IDENTICAL to the upgraded stack (321 lines compared).
  Integration tests only run against the three allow-listed stack URLs, so they ran on the upgraded `gradia-isolated-tests` stack (the
  from-zero stack uses a different port and the guard in `_db.ts` was deliberately not widened).
* Integration `call-copilot-proposals.int.test.ts`: 69/69 (was 41), including 16 post-claim race tests. With `denyBeforeEffect` disabled, 11
  of them fail (the effect happens), so the tests do exercise the recheck.
* Existing suites touching `control_claim`/booking/quote/text (approvals, control-execution, delegated-message-approval, mcp-capabilities,
  reviewed-memory, customer-merge, tenant-isolation, team-permissions, create-quote-action, service-proof-replay, call-copilot-ingress,
  booking-atomicity, booking-confirmation, conflict-enforcement, booking-duration, agent-records, operations-queue) all passed, but NOT in one
  clean pass: the host was loaded (load average 14-17) and five suites failed on a first attempt only with `createUser failed: {}`,
  `sign-in failed: {}`, `An invalid response was received from the upstream server` or a 60 s hook timeout; each passed when re-run. The full
  `eval/integration` folder was NOT run as one clean pass: treat `ci-integration` as the authority.
* A leftover shop from my own first failed run (hard-coded `aurinko_account_id`) collided with two other suites' fixtures; it was deleted
  from the disposable stack and the new tests use random values.

## Re-run

```sh
npm ci
npm test                                   # unit (EVAL_LIVE=0 INTEGRATION=0)
npx tsc --noEmit -p . && npx eslint src/lib/call-copilot eval/call-copilot-*.ts eval/_call-copilot-fixtures.ts eval/integration/call-copilot-proposals.int.test.ts
# integration (disposable stack ONLY; keys from `supabase status --workdir tests -o env`, never commit them)
SUPABASE_TEST_URL=http://127.0.0.1:56531 GRADIA_DISPOSABLE_TEST=gradia-isolated-tests INTEGRATION=1 EVAL_LIVE=0 \
  SUPABASE_TEST_SERVICE_ROLE_KEY=... SUPABASE_SERVICE_ROLE_KEY=... SUPABASE_TEST_ANON_KEY=... \
  npx vitest run --fileParallelism=false eval/integration/call-copilot-proposals.int.test.ts
python3 scripts/verify-call-copilot-proposals-migration.py              # needs a stack WITHOUT the migration
python3 scripts/verify-call-copilot-proposals-migration.py --mutate all # 15 deliberate defects, each must be caught
```

`supabase db reset` is denied here. Apply by hand: `docker exec -i supabase_db_gradia-isolated-tests psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres < supabase/migrations/20261120140000_call_copilot_proposals.sql`,
then `INSERT INTO supabase_migrations.schema_migrations(version,name) VALUES ('20261120140000','call_copilot_proposals')` and `NOTIFY pgrst, 'reload schema'`.
To return a stack to the pre-migration state (so the probe can run again): drop the six `call_copilot_*` tables listed in the
architecture doc and the functions the migration created (`DROP FUNCTION public.call_copilot_<name>` for each of its
`CREATE FUNCTION` lines except PR D's), re-create `control_claim` from `20261008160000_delegated_message_approval.sql`
(`CREATE OR REPLACE`), delete the ledger row. The probe refuses to run if the migration is already present.

## Gotchas

* The migration timestamp (`20261120140000`) must stay newer than every migration on `main`. Re-check for collisions and
  renumber the file, the verifier's `NEW`, and the ledger row together.
* `control_claim` was replaced with `CREATE OR REPLACE`. If another branch edits `control_claim`, merge by re-copying its
  newest body and re-applying the three hook lines (`eval/call-copilot-proposals-source-lock.test.ts` compares the two
  definitions textually and the probe compares `pg_get_functiondef`).
* Lock order is shop -> call everywhere that matters (`record_extraction` locks the shop first because staging a pending
  action locks it through `control_guard_staging`; the claim already holds it). Do not reverse it.
* The DB card detector is structural on purpose. Do not loosen it to "any Luhn digit run": UUIDs matched it ~10% of the time.
* `tenant-relationships.int.test.ts` "real recipient lookups reject cross-shop IDs..." may fail with and without this
  migration (pre-existing).
* Never stage `tests/supabase/.temp`.
* **Deploy order**: apply the migration BEFORE (or with) the application build. `approvals.ts` now calls
  `call_copilot_pre_effect_recheck` before every booking, draft quote and text, and **fails closed** if it cannot get an explicit yes, so
  code deployed ahead of the migration would refuse those approvals until the function exists.
* Unit tests that fake a Supabase client for `executeApproval` must answer `call_copilot_pre_effect_recheck` with
  `{ ok: true, call_proposal: false }` (see `eval/booking-atomicity.test.ts`).

## Next (not started)

1. **Provider seam + route** (PR D handoff item 1) once counsel approves disclosure wording: it must call
   `requireCaptureGrant('transcription')` for live audio, then `recordTranscriptSegment`, then `sealEvidence` with the
   provider's final-transcript attestation and count. Read the Next 16.4.6 route docs under `node_modules/next/dist/docs/`
   first, and update `eval/call-copilot-source-lock.test.ts` and `...proposals-source-lock.test.ts` on purpose.
2. **A live extractor implementation** behind `CallExtractor`: add an output cache keyed by evidence digest + extractor
   identity first (a repeated request currently re-invokes the seam), evals per `GRADIA_AGENT_SHARPENING_BRIEF` principle 6,
   and a human reconciliation path for `unknown_outcome` runs.
3. **PR F UI** (post-call evidence/proposal review): consume `call_copilot_proposals` through a new owner RLS read policy
   (today service-role only) and show coverage, gaps, citations, ambiguity and the denial reasons. `Approve selected` calls the
   existing `executeApproval`; the vehicle proposal must run before the customer proposal (see limitation 4).
4. Guarded executors for lead stage/owner/next action and follow-up tasks, so those review-only kinds can be staged.
5. **Customer-scoped memory publication AND retrieval**, end to end, before ANY hand-off from a call proposal into reviewed memory
   (there is deliberately none today; limitation 1). Do not re-add `call_copilot_submit_memory_candidate`.
6. Retention for the transcript table via the safety-retention review; transcripts must be deleted before audio rules matter.
