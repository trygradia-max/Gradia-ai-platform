# Call Copilot PR D — resume handoff

_2026-11-19. Branch `codex/call-copilot-consent`, based on `origin/main` `01eacaa`._

## State

Implemented and verified (see `docs/architecture/CALL_COPILOT_INGRESS.md`): migration
`20261119130000_call_copilot_ingress.sql`, `src/lib/call-copilot/`, 38 unit + 53 integration tests,
and an upgrade probe. Open as a non-draft PR; **not merged**, not deployed.

## Re-run

```sh
npm ci
npm test                                   # unit
# integration (disposable stack only; keys from `supabase status --workdir tests -o env`)
SUPABASE_TEST_URL=http://127.0.0.1:56531 GRADIA_DISPOSABLE_TEST=gradia-isolated-tests INTEGRATION=1 EVAL_LIVE=0 \
  SUPABASE_TEST_SERVICE_ROLE_KEY=... SUPABASE_TEST_ANON_KEY=... \
  npx vitest run --fileParallelism=false eval/integration/call-copilot-ingress.int.test.ts
python3 scripts/verify-call-copilot-migration.py   # needs a stack WITHOUT the migration
```

`supabase db reset` is denied here: apply the migration with `docker exec -i supabase_db_gradia-isolated-tests psql ... < file`
plus a `supabase_migrations.schema_migrations` row, then `NOTIFY pgrst, 'reload schema'`.

## Gotchas

* Another session (commercial billing F3) used timestamp `20261119120000` on the shared stack, so this
  migration is `20261119130000`. Re-check for collisions before merging; renumber the file, the verifier's
  `NEW`, and the ledger row together.
* `tenant-relationships.int.test.ts` "real recipient lookups reject cross-shop IDs and destination
  mismatches" fails with and without this migration (pre-existing).
* Never stage `tests/supabase/.temp`.

## Next (not started)

1. A Twilio `CallCopilotProviderSeam` and signed route, only after counsel approves disclosure wording
   and the controlled-bridge TwiML flow exists; it must assign `sequence` from a Gradia-owned counter.
   Read the Next 16.4.6 route docs under `node_modules/next/dist/docs/` first; update the source lock on purpose.
2. PR E (extraction, proposals): call `requireCaptureGrant` first for every purpose; AND with Control Center policy.
3. Link a Copilot call to `call_records`/`interactions` and add owner-visible capture state (PR F).
4. Retention schedule for this ledger via the safety-retention review.
