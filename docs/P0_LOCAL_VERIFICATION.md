# P0 safety branch — final local correction verification

**Verdict: READY FOR PUSH REVIEW.** Both enabled blocking regressions pass.
This is a local engineering verification verdict, not production acceptance.
The founder subsequently authorized a draft PR with automatic deployment disabled
for this exact branch; see the infrastructure safety addendum below.

Branch: `fix/p0-tenant-policy-safety`.
Original main/base: `20e153a8ac7b55bc682e5a49c6e9486ac51e9ae5`.
This bounded correction resumed the existing branch at `0866fae`; all earlier
commits were preserved. Final implementation and tests: `5c38e3e`. This report is
the only subsequent change. No branch was recreated, reset, amended or squashed.

## Root causes and exact fixes

### Durable service proof consumption

The previous HMAC proof authenticated content and context but had no unique nonce
or durable consumption record. Two distinct pending actions could both verify it
and call the transport. Pending-action claiming only prevented repeat execution of
one action ID.

Version 2 proofs now include a random UUID nonce, exact shop, customer, canonical
destination, channel, normalized SHA-256 content hash, workflow context, explicit
service purpose and expiry. Normalization covers Unicode NFC and line endings;
content/whitespace edits still invalidate authority. HMAC authentication covers all
fields. When an action ID is known (held-message review), issuance binds it. For
pre-queue producers, the database binds the first consuming action durably; direct
operator service sends use the nonce as their command identity.

`claim_service_execution` runs before SMS transport or email token refresh. Its
PostgreSQL table has a proof-ID primary key and a unique `(shop_id, action_id)`
constraint. Competing INSERTs serialize through those constraints and produce one
winner. Shop ownership, customer/destination binding, expiry and approved action
identity/type are checked at the database boundary. Application verification also
rechecks signature, content and current workflow ownership. Failed/missing/throwing
claims never authorize a provider call. There is no production process-local cache.

Claims survive pending-action or customer deletion/merge; those identities are
retained as audit values rather than cascading relationships. Completion stamps the
claim after transport success. Owner clients cannot directly modify/delete claim
or audit records. Audit events distinguish execution claimed/completed, same-action
retry, cross-action replay denial, invalid proof, expired proof, context mismatch
and proof lookup failure. Forged token values are not used as audit identities, and
no proof signature or message content is logged. Audit/database outages never turn
a rejection into a send; durable auditing itself cannot be guaranteed during a DB
outage.

### Canonical photo identities

The filename predicate accepted uppercase hex, and signing did not validate raw
appointment identities. Application validation now requires lowercase UUIDs of
exactly 36 characters in shop, appointment and filename positions, exact before/
after phase, exactly three path segments and supported lowercase extensions.
Whitespace (including trailing JavaScript end-anchor edge cases), traversal,
encoded separators, malformed prefixes and phase mismatches are rejected.
Stored values are never silently lowercased or repaired.

Raw invalid appointment IDs are rejected before authentication/database lookup.
Stored paths necessarily require one shop-scoped appointment read to retrieve them;
validation then runs before storage-client creation or signing. Invalid paths cause
zero database mutation, upload and signing effects. Errors give a bounded internal
review reason without disclosing a path or storage details. This is not a claim of
zero database reads for paths stored in the database.

An additive SQL migration installs matching lowercase predicates and revalidates
both appointment photo CHECK constraints. Inconsistent existing paths abort the
whole migration. SQL UUID columns already have canonical database representation;
raw input casing is rejected in the application before UUID coercion. Storage stays
private with no object RLS policies granting direct owner/anonymous access; no
storage permission was broadened. The service-role signing/upload boundary applies
the same canonical predicate used for application/SQL parity verification.

## New local commits

- `5635385` — durable proof claims, sender integration and replay tests.
- `e3ac362` — canonical lowercase photo identifiers and refusal probe.
- `3daf0ff` — correct enum comparison in the PostgreSQL claim function.
- `442808b` — reject trailing whitespace in canonical photo paths/IDs.
- `2fd468e` — distinct invalid/expired/context-mismatch audit reasons and tests.
- `5c38e3e` — prevent reclassification from reopening a spent action.
- Final documentation commit: `docs: record verified durable proof and photo corrections`.

The first real-Postgres run exposed `pending_action_type = text` in the claim's
CASE comparison. It correctly failed closed with zero provider calls. The fix casts
`action_type` to text for that comparison; the migration was then reapplied from
zero. The enabled direct-SQL regression now verifies that valid metadata claims
exactly once. An intermediate typecheck overlapped Next's generated-type replacement;
it was rerun successfully after the final production build. Neither interim failure
was ignored or hidden by weakening validation.

## Final verification results

All checks used the existing Node 22.23.2 runtime, locked dependencies, Supabase CLI
2.98.2 and PostgreSQL 17. No dependency installation or upgrade occurred in this
correction. Final unit/integration suites ran against committed code at `5c38e3e`.
The report-only commit does not change executable code or migrations.

| Check | Exact final result |
| --- | --- |
| Full hardened unit suite | Exit 0: **850 passed**, 4 live-model tests skipped; **84 files passed** |
| Full database integration suite | Exit 0: **156 passed**, none skipped; **17 files passed** |
| Durable proof integration file | **15 tests passed** |
| Atomic customer merge file | **9 tests passed** |
| Canonical consent/photo integration file | **7 tests passed** |
| Typecheck after final build | Exit 0, no diagnostics |
| Lint | Exit 0, no warnings or errors |
| Offline production build | Exit 0, `next build --webpack` |
| Fresh disposable initialization | Exit 0, **69 migrations** applied from zero with automatic seed disabled |
| Migration ledger | Exact ordered match against all **69 migration filenames** |
| Tenant manifest | All **26** complete tenant foreign-key definitions matched |
| Tenant inconsistency refusal | Passed: mismatched synthetic quote refused; row and original constraints preserved after rollback |
| Photo inconsistency refusal | Passed: uppercase stored path refused; data and original constraints preserved after rollback |
| Whitespace and tracked-file checks | Passed; no actual credential or generated runtime/database artifact identified |

The previously reported 847 unit tests remain passing. Three additional tests cover
trailing path whitespace, bringing the final total to 850. Live-model tests remain
intentionally skipped; no live evaluation was run.

Exact execution commands, from the isolated worktree:

```sh
.local-tools/node-v22.23.2-darwin-arm64/bin/node scripts/test-stack.mjs reset
.local-tools/node-v22.23.2-darwin-arm64/bin/node scripts/test-stack.mjs credentials
.local-tools/node-v22.23.2-darwin-arm64/bin/node scripts/isolated-check.mjs unit
.local-tools/node-v22.23.2-darwin-arm64/bin/node scripts/isolated-check.mjs integration
.local-tools/node-v22.23.2-darwin-arm64/bin/node scripts/isolated-check.mjs lint
.local-tools/node-v22.23.2-darwin-arm64/bin/node scripts/isolated-check.mjs build
# Must run after build finishes regenerating .next/types:
.local-tools/node-v22.23.2-darwin-arm64/bin/node scripts/isolated-check.mjs types
python3 scripts/verify-tenant-migration.py
python3 scripts/verify-photo-migration.py
git diff --check origin/main..HEAD
git diff --check
git diff --exit-code origin/main -- supabase/config.toml CONTEXT.md package-lock.json
```

Targeted replay/canonical integration ran before the final full suite using the
same isolated runner with `eval/integration/service-proof-replay.int.test.ts` and
`eval/integration/consent-canonical.int.test.ts` arguments. Final logs remain ignored
under `.local-tools/replay-final-*.log`.

## Replay, merge and photo evidence

For **each of SMS and email**, real disposable PostgreSQL tests passed for:

- Sequential cross-action replay: one execution and one mocked transport call.
- Six concurrent pending actions on separate connections: exactly one successful
  execution, five denials, one transport call and five replay-denial audit events.
- Completed-action retry: `already_decided`, with no additional provider call.
- Reloaded execution module plus a new database client: serialized proof remains
  consumed, demonstrating independence from a process-local replay cache.
- Claim database failure: zero transport and email-token-refresh calls.
- Invalid, expired and edited-context authority: distinct durable audit reasons,
  zero provider effects.

Additional checks cover bound-action mismatch, unclaimable/missing action, nonce
uniqueness, wrong shop/customer/destination/channel/context, forged signatures,
content edits, normalized-content behavior and expiry. Provider failure followed by
retry invokes the transport once and retains the spent proof. Reclassifying that
same uncertain action as marketing (even with affirmative marketing consent) also
remains blocked; changing category cannot bypass its durable execution history. Same-action and
cross-action retries have separate audit events.

The full suite also retains atomic merge, complete eight-table rollback, both merge
directions, exact consent timestamp/source provenance, destination conflicts,
pending references, START/STOP, DNC/suppression and tenant isolation coverage.

Photo tests cover uppercase characters in every path UUID position, uppercase
appointment input, malformed paths, phase mismatch, whitespace, unsupported
extensions and valid lowercase paths. App/SQL predicates agree; rejected SQL updates
leave the previous valid photo array unchanged. Invalid signing fixtures never
construct storage clients or call signing. Invalid upload inputs never reach DB or
storage clients. The refusal probe applies the actual new migration to an
inconsistent synthetic fixture inside a transaction and rolls back the entire probe.

## Delivery tradeoff and manual reconciliation

This is **at-most-once execution authorization**, not an end-to-end exactly-once
provider-delivery guarantee. Once consumed, a proof is never automatically released,
even if the provider throws, the process crashes or the completion write fails.
A crash before the provider call can therefore leave an unsent message with a spent
proof; a timeout after delivery can leave a sent message with an uncertain outcome.
Automatically resending either case could duplicate a customer message.

The pending message and durable claim/audit history remain available, and retries
return an explicit held/review reason. An operator must:

1. Inspect the pending action, claim/completion audit and any recorded interaction
   or provider message identifier. Reconcile against the provider's delivery history
   using recipient, time and content as necessary; this was not done against any
   real provider during verification.
2. If delivered, do not resend. If still uncertain, retain the hold and investigate.
3. Only after establishing non-delivery, intentionally create a **new action and
   newly verified proof**, subject to all current consent and context checks.
   Reissuing proof on the same consumed action does not bypass the unique action
   constraint. Do not delete the consumption record to retry.

No automatic reconciliation worker or dedicated reconciliation dashboard is added
by this narrow correction. Old version-1 proofs fail closed and require safe
reclassification/reissuance before execution. Review this operational tradeoff and
the existing held-message UI before production rollout.

## Isolation, scan and founder preservation

Only `gradia-isolated-tests` was reset, using its generated ignored work directory:
API port 56531, DB port 56532. The configuration matches the committed test template,
migration symlink targets this worktree and no remote project-ref exists. There are
no application environment files in the worktree. Shared `supabase/config.toml`,
committed CONTEXT and the lockfile match `origin/main`. Neither `gradia-app` nor the
older disposable stack was reset or reused.

The macOS runner clears credentials and denies outbound network traffic. Integration
permits only the dedicated loopback API. Provider transports are mocked; local auth
email stays in the disposable capture service. No production credentials, data,
models, embeddings, SMS, email, phone or real provider operations were used.
Sentry build telemetry notices did not bypass the outbound-denial boundary. Offline
fonts use Next's bundled fixtures. Default Turbopack, browser acceptance, real delivery
and production compatibility were not verified. CI was inspected, not run here;
its JavaScript guard is not an identical OS-level sandbox.

All new commit trees and tracked file versions were scanned for provider tokens,
JWTs, private keys, credential URLs, credential literals, generated runtime/state,
machine-specific paths and unrelated changes. Reported matches were inherited
redacted placeholders, synthetic test material and an unchanged baseline developer
path; none was introduced by these corrections. No actual credential, generated
runtime/database state, task-specific shared configuration or unrelated change was
identified. Scans are pattern-based evidence, not a mathematical secret-absence
proof. Earlier branch history retains previously documented developer paths/test
configuration; it was not rewritten.

The original checkout remains on `main` at the base above with **only** ` M CONTEXT.md`.
Its SHA-256 remains exactly:
`9b2c32f773118f8e66e5909aa6a8a0eee1d09e86b210001aee81e5145179f773`.
The implementation checkout uses the committed main CONTEXT, not the founder edit.
No original checkout files/configuration were changed. No push, PR, merge, deploy,
production/shared Supabase access or real provider send occurred. Founder-provided
empty-production status was not independently verified.

## Changed files in this bounded correction

**17 files** relative to `0866fae`, including this report.

- `docs/P0_LOCAL_VERIFICATION.md`
- `eval/customer-send-boundary.test.ts`
- `eval/integration/consent-canonical.int.test.ts`
- `eval/integration/service-proof-replay.int.test.ts`
- `eval/job-photo-paths.test.ts`
- `eval/job-photo-signing.test.ts`
- `eval/service-proof-claim.test.ts`
- `scripts/verify-photo-migration.py`
- `src/app/actions/approvals.ts`
- `src/app/actions/jobs.ts`
- `src/app/actions/outbound-sms.ts`
- `src/lib/approvals.ts`
- `src/lib/job-photo-paths.ts`
- `src/lib/send-policy.ts`
- `src/lib/service-purpose.ts`
- `supabase/migrations/20260910100000_service_proof_consumption.sql`
- `supabase/migrations/20260910101000_canonical_photo_identifiers.sql`

## Draft-PR infrastructure safety addendum (2026-09-10)

Previous verified HEAD: `e980d729f04d104f47a61769ca7e028ed6678341`.
Infrastructure-safety commit: `96212f9ac79b02722aa9d9f09141371aa391c091`.
Final publication HEAD is the documentation commit containing this addendum
(resolve with `git rev-parse HEAD`; the PR pins its full hash). A commit cannot
contain its own hash. Only `vercel.json` and this report changed after the previous
verified HEAD; no application, tests, migration or credential changes were made.

Vercel Preview was confirmed to share Production-scoped Supabase configuration.
No values were revealed or changed. The exact branch is now excluded using:

```json
{"git":{"deploymentEnabled":{"fix/p0-tenant-policy-safety":false}}}
```

All nine existing cron definitions are preserved exactly. No global rule, production
exclusion or wildcard was added. Vercel's official Git configuration documentation
states that unspecified branches default to enabled:
https://vercel.com/docs/project-configuration/git-configuration
This is an automatic Git deployment exclusion, not a block on manual deployment.
Do not manually deploy this branch. Merging to main would still permit production
deployment and requires separate founder authorization and rollout review.

Validation and reruns on the infrastructure commit, all final exits 0:

```sh
curl --fail --silent --show-error https://openapi.vercel.sh/vercel.json -o .local-tools/vercel-schema.json
.local-tools/node-v22.23.2-darwin-arm64/bin/node < .local-tools/validate-vercel.txt
.local-tools/node-v22.23.2-darwin-arm64/bin/node scripts/isolated-check.mjs lint
.local-tools/node-v22.23.2-darwin-arm64/bin/node scripts/isolated-check.mjs build
.local-tools/node-v22.23.2-darwin-arm64/bin/node scripts/isolated-check.mjs types
git diff --check origin/main..HEAD
```

The ignored validator uses installed Ajv against the fetched official schema and
asserts deep equality with the previous configuration plus only the exact exclusion.
The upstream schema declares draft-04 but includes an unrelated numeric
exclusiveMinimum in experimentalTriggers; schema self-validation initially failed.
Ajv schema self-validation was disabled, while configuration validation remained
active and passed (no schema/config fields removed). Initial lint found only the
new ignored CommonJS validator helper; it was moved to a text fixture, then full
lint passed unchanged. Offline webpack build passed; post-build typecheck passed
with no diagnostics. Existing Sentry deprecation/missing-token notices remain;
OS-level outbound denial prevented telemetry or provider access.

The prior **850 unit / 156 integration / 69 fresh migration / 26 relationship**
results remain evidence for unchanged executable code. These suites were not rerun
locally for a five-line Vercel-only configuration addition; GitHub CI is monitored
on the draft PR. GitHub workflows contain no deploy or remote database operation.
New tracked diffs contain only the branch exclusion and this report, with no secret,
runtime artifact, database state or unrelated change. The founder checkout remains
on main with only its original CONTEXT.md edit and the exact SHA-256 recorded above.
Post-push Vercel skip and GitHub results are recorded in the PR/final handoff, not
asserted in advance in this pre-push report.
