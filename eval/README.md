# Verification modes

The deterministic harness never loads `.env.local`. `npm test` forces live and
integration flags off; setup rejects live mode and blocks real sockets/fetch.
Provider mocks may replace fetch, but real outbound sockets remain blocked.

For the isolated macOS P0 worktree (Node 22, locked dependencies already installed):

```sh
node scripts/isolated-check.mjs unit
node scripts/isolated-check.mjs integration
node scripts/isolated-check.mjs types
node scripts/isolated-check.mjs lint
node scripts/isolated-check.mjs build
python3 scripts/verify-tenant-migration.py
```

The runner rejects application environment files, constructs a minimal environment,
and applies an OS-level network deny rule. Integration alone permits the disposable
API at loopback port 55431. Local credentials come from ignored
`.local-tools/test-db.json`, generated privately by the isolated Supabase CLI.
Never copy existing application credentials. Build uses a build-only font fixture
with Geist binaries already bundled in Next, avoiding Google font downloads.

The separate Supabase project is `gradia-p0-tenant-policy-safety`, PostgreSQL 17,
CLI 2.98.2, with distinct ports and no remote link or automatic seed. Do not use
`gradia-app`, reset another stack, or point tests at arbitrary development URLs.
Integration tests create/delete synthetic users and rows; `_db.ts` rejects any
other endpoint before constructing a client. CI uses the same configured target.

`npm run eval` uses a separate config and requires an explicitly supplied
`GRADIA_ALLOW_LIVE_EVAL=1` plus provider credentials. It is never part of isolated
verification and must not run without separate authorization. Existing golden
cases are preserved. Neither setup reads application environment files.

The migration refusal probe creates deliberately inconsistent synthetic tables
inside a transaction, verifies refusal without repair, and rolls back all DDL/data.
It can address only the named disposable P0 database container.
