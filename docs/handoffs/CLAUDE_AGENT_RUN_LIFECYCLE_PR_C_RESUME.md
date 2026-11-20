# PR C resume handoff: governed run lifecycle

_2026-11-19. Branch `claude/selected-playbook-lifecycle`. PR opened non-draft against `main`; not merged._

## State

PR C is complete as scoped. Nothing is half-done. Read `docs/architecture/AGENT_RUN_LIFECYCLE.md` first; it has
the exact semantics and the numbered limitations.

| Piece | Where |
| --- | --- |
| Migration (tables, functions, claim/finish/unknown re-declared) | `supabase/migrations/20261120103700_agent_run_step_lifecycle.sql` |
| Fail-closed wrappers | `src/lib/agent-os/run-lifecycle.ts` |
| Pre-effect checks (six, fixed) | `src/lib/agent-os/pre-effect-checks.ts` |
| Step runner (effects injected) | `src/lib/agent-os/run-executor.ts` |
| Tick wiring (recovery + resume drain, executor OFF) | `src/lib/agent-runtime.ts` |
| DB-level integration | `eval/integration/agent-run-step-lifecycle.int.test.ts` (36) |
| Runner integration | `eval/integration/agent-run-executor.int.test.ts` (16) |
| Fixture | `eval/integration/_governed-run-fixture.ts` |
| Unit + source locks | `eval/agent-run-step-lifecycle.test.ts` (19) |
| Upgrade probe | `scripts/verify-agent-run-lifecycle-migration.py` |

## Commands (disposable local stack only)

```
# keys for the local stack (never print them)
supabase status --workdir tests -o env      # API_URL, ANON_KEY, SERVICE_ROLE_KEY (stack gradia-isolated-tests, :56531)
SUPABASE_TEST_URL=$API_URL SUPABASE_TEST_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY SUPABASE_TEST_ANON_KEY=$ANON_KEY \
GRADIA_DISPOSABLE_TEST=gradia-isolated-tests EVAL_LIVE=0 INTEGRATION=1 \
  npx vitest run --fileParallelism=false eval/integration/agent-run-step-lifecycle.int.test.ts \
  eval/integration/agent-run-executor.int.test.ts eval/integration/agent-run-lifecycle.int.test.ts \
  eval/integration/agent-runtime-binding.int.test.ts
npm test
GRADIA_PROBE_STACK=<a gradia-* stack still at the previous schema> python3 scripts/verify-agent-run-lifecycle-migration.py
```

Notes that cost time:

- The shared disposable stack is used by several sessions at once. Another session had already taken migration
  version `20261119120000`, so this one is `20261120103700`. If another migration with a later version lands
  first, re-check ordering. `supabase db reset` was not available; apply new SQL with
  `docker exec -i supabase_db_gradia-isolated-tests psql -U postgres < file` plus a ledger insert.
- Founder Pilot allows two active agents per workspace, so the integration tests make one workspace per test.
- A governed definition must pass the real evaluator: `maximumRunsPerDay` must be at most `1440 / everyMinutes`,
  and a definition may only grant tools whose connector is ready (use `crm.edit`, `pipeline.change`, not `sms.*`).
- Mutation checks: re-declare one function from the migration with a broken line on the disposable stack, run the
  suites, then re-declare the original. Done for seven rules; all were caught.
- `tenant-relationships.int.test.ts` "real recipient lookups reject cross-shop IDs and destination mismatches"
  fails in the service-proof send path. It is unrelated to this change; not re-checked on pristine main.

## What the next session must not do

- Enable `GOVERNED_EXECUTOR_ENABLED`, wire a provider, or add an effect outside `StepScope.command`.
- Add a second claim, attempt or command table. PR D should call `registerCommand`, `beginCommandAttempt` and
  `recordAttemptResult` for any provider callback it initiates, and use `resolveReconciliation` for held outcomes.
- Treat `rejected` as anything but "the provider definitively refused before any effect".

## Open items (not in this PR)

Playbook registry and the first pilot playbook; a trusted content classifier (`safetyVerified`); escalation
delivery and an operator surface for waits, control requests and reconciliation; event and manual governed
triggers; ledger retention; the one unrelated integration failure above.
