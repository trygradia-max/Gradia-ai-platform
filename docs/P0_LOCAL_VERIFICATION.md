# P0 local correction verification

Verdict: **NEEDS CORRECTIONS**. The branch is not ready for push review.
Two newly required regression checks fail. They remain enabled and committed;
no assertion was relaxed or marked expected-failure to obtain a green suite.

Base: `20e153a8ac7b55bc682e5a49c6e9486ac51e9ae5` (`origin/main`, cached locally).
Branch: `fix/p0-tenant-policy-safety`. Verification resumed from the existing clean
worktree at `b1d827e`; no completed work was recreated or discarded. Verification
code is committed through `e1fad3d`. This report is the only subsequent change.

## Blocking findings

1. **Service-purpose proof replay across pending actions.**
   `eval/customer-send-boundary.test.ts` executes two distinct pending actions
   carrying the same valid appointment-bound proof and identical SMS content.
   Both return `ok: true` and the mocked transport is invoked twice. The test
   requires the second operation to be denied with no second transport invocation.
   Proofs bind shop, customer, channel, destination, content, context and expiry,
   but do not bind a pending-action identity or enforce atomic consumption.
   Existing same-action claim/idempotency tests pass; they do not protect a copied
   proof attached to a different action. This is a mocked execution-boundary
   reproduction, not a live-provider test or a demonstrated anonymous exploit.
   Correction needs action-bound authority and atomic replay prevention with safe
   retry semantics, followed by concurrent disposable-database regressions.
2. **Uppercase filename UUIDs can still be signed.**
   `eval/job-photo-signing.test.ts` changes only the UUID hex letters in an owned
   stored filename to uppercase. It receives a signed result and invokes the
   mocked storage client and signer once, contrary to the requested zero-effect
   rejection. Uppercase appointment IDs are rejected on upload; this is a distinct
   filename case. Application and SQL filename predicates both accept `A-F`.
   No cross-tenant bypass is established by this case, but it does not meet the
   requested canonical-case behavior. Correct both predicates consistently and
   retain refusal of inconsistent data rather than repairing it automatically.

This pass changed verification tests and documentation only. Production corrections
for these newly confirmed failures were not silently added to a verification-only
request. No inconsistent production data was queried or discovered.

## Correction and verification commits

Existing corrections (preserved without rewriting):

- `ca8268f`: validate photo phases before effects; fix booking fixture.
- `dc658a1`: separate disposable Supabase configuration from application defaults.
- `fe6d187`: atomic customer merge with restrictive consent evidence preservation.
- `82a942a`: canonical identities and explicit tenant relationship manifest.
- `151b893`: preserve merge provenance and serialize SMS identity checks.
- `b1d827e`: verified service purpose and safe held-message review.

New verification commits:

- `4fc1fc6`: proof expiry and substituted-context regression.
- `54a4ddc`: cross-action replay regression; exact merge provenance and complete
  eight-table rollback assertions.
- `c4aa657`: complete the mocked interaction result required by its existing type.
- `e1fad3d`: phase-mismatch and uppercase filename UUID signing regressions.

The initial five P0 commits (`72603e2`, `f6eb71c`, `b49b772`, `018bd23`, `11034da`)
remain intact. No push, PR, merge, amend, squash, reset or stash was performed.

## Commands and final results

Used the existing locked installation and Node 22.23.2 / npm 10.9.8. No dependencies
were installed or upgraded during this verification. Supabase CLI 2.98.2;
PostgreSQL 17. Commands below ran from the isolated worktree using its existing
Node 22 executable. The runner clears the environment and applies macOS outbound
network denial; only integration permits the exact disposable loopback API.

```sh
node scripts/test-stack.mjs reset
node scripts/test-stack.mjs credentials
node scripts/isolated-check.mjs unit
node scripts/isolated-check.mjs integration
node scripts/isolated-check.mjs types
node scripts/isolated-check.mjs lint
node scripts/isolated-check.mjs build
python3 scripts/verify-tenant-migration.py
git diff --check origin/main..HEAD
git diff --check
```

| Verification | Final result |
| --- | --- |
| Full hardened unit suite | Exit 1: 838 passed, 2 failed, 4 live-model tests skipped; 81 files passed, 2 failed |
| Full disposable database integration | Exit 0: 140 passed in 16 files, none skipped |
| Typecheck | Exit 0, no diagnostics |
| Lint | Exit 0, no warnings or errors |
| Offline production build | Exit 0, `next build --webpack` |
| Fresh initialization | Exit 0; complete 67-migration sequence applied from zero, no seed |
| Migration ledger | Exact ordered match against all 67 repository migration filenames |
| Explicit manifest | All 26 complete foreign-key definitions matched |
| Inconsistent synthetic data | Migration refused the mismatched quote; row and prior constraints preserved after rollback |
| Git whitespace | Current diff and every branch commit checked successfully |

The initial typecheck caught a missing `embedded` property in the new replay mock.
Commit `c4aa657` corrected the fixture without changing production types. The final
checks above supersede that intermediate failure. Integration was rerun against
final committed verification code. Application source and migrations remained
unchanged throughout this pass; the offline build verified that same source.
Local command output is retained only under ignored `.local-tools/resume-*.log`.

## Fresh database and atomic merge evidence

Reset only `gradia-isolated-tests`, using its dedicated generated work directory
and `db reset --local --no-seed`. The complete final migration sequence applied
from zero. Five P0 migration files have explicit BEGIN/COMMIT boundaries. The
manifest probe validated all 26 tenant foreign keys, original delete actions,
nullable behavior and column-specific SET NULL without clearing shop identity.
The additional quote/customer/vehicle consistency foreign key is also installed.
The refusal probe inserted deliberately inconsistent synthetic data within a
transaction, attempted the actual manifest migration, verified rollback preserved
the bad row and all original constraints, then rolled back its entire fixture.
This validates disposable schema behavior, not compatibility with production data.

Nine real-Postgres merge tests passed:

- DNC, STOP and matching-destination suppression survive both merge directions.
- Exact original permission rows, timestamps and source evidence survive in merge
  history in both directions; the reconciled timestamp retains its matching source.
- Different destinations and multiple permissions per channel remain separate;
  permission is never transferred to the winner's different address.
- Matching destinations with affirmative versus unknown consent remain unknown.
- All eight child tables move: leads, interactions, appointments, vehicles, quotes,
  payments, call_records and automation_runs. Nested pending customer references
  move while destinations are preserved.
- Foreign/nonexistent customer merges are refused without history writes.
- Injected mid-merge failure rolls back all eight relationships, interaction JSON,
  permission ownership, pending payload, loser email and merge history.

The failure injection trigger comes from `tests/sql/merge-failure.sql` and is
installed only by the disposable bootstrap; it is not a production migration.
Separate canonical tests reject equivalent-email/phone collisions, noncanonical
permission rows and duplicate conflicting permissions without overwriting data.

## Communication and photo results

Passing checks cover forged proof, content and subject edits, wrong shop, customer
and destination, substituted context, missing/reassigned service records, stale or
incorrect inbound conversations and expiration after 24 hours. A verified inbound
reply context must belong to the same customer, destination and channel and be no
more than 48 hours old. Arbitrary caller-selected transactional categories do not
issue proof. Marketing requires affirmative destination-bound channel consent;
legacy generic consent does not substitute. Missing/failed/ambiguous customer
lookups, DNC, STOP and suppression fail closed before transport or token refresh.

Held-message review tests verify foreign action rejection, rejection of forged
quote context as reply authority, explicit marketing review clearing proof, and
recent verified reply review. Approval does not bypass send-time consent checks.
Draft generation is not sending authorization. Live models and drafting quality
were not evaluated. Expiry checks pass; cross-action proof replay fails as above.

SMS START/STOP integration and webhook replay tests passed. STOP records the exact
SMS destination; START changes that destination's permission and does not clear
DNC, operator suppression, email suppression or grant generic marketing consent.
A destination/customer mismatch is refused. Same webhook replay remains idempotent.

Photo tests pass for invalid phase values (including case and metacharacters),
uppercase appointment identity on upload, malformed/traversal/foreign paths and
mismatched phases. Invalid uploads never reach database or storage clients. Invalid
stored signing paths are read from the owned appointment, then refused before
storage/signing; this is zero writes, not zero database reads. Uppercase filename
UUID rejection fails. No real upload or signing service was invoked by these mocks.

## Configuration, history and safety review

Shared `supabase/config.toml` is byte-identical to `origin/main`. Test-only settings
live in `tests/supabase/config.toml`: project `gradia-isolated-tests`, API 56531,
DB 56532 and separate auxiliary ports. The generated config matches that source;
its migrations symlink targets this worktree, and no remote project-ref exists.
There are no application environment files in this worktree. Generated credentials
are local-only under ignored `.local-tools`; bootstrap never prints them.

The bootstrap accepts no link/remote command and refuses a remote-linked directory.
It is independent of the developer's absolute checkout path, with a documented
reserved port range. CI uses the same bootstrap and target validation. It does not
automatically allocate a second concurrent stack; port conflict must fail startup.
The original `gradia-app` and older P0 disposable stack were not reset or reused.

All branch commit trees and tracked file versions were inspected for common token,
private-key, JWT, credential-URL and literal-credential patterns, generated runtime
paths, database artifacts and machine-specific paths. Candidates were reviewed
without printing credential values. No actual credential or generated database/
runtime artifact was identified. Matches were redacted placeholders, test-only
synthetic webhook material and a deliberately invalid credential-URL network test.
This pattern-based scan is evidence, not a mathematical guarantee of secret absence.

An unchanged baseline implementation document retains a developer path. Earlier
branch versions of this report retain its old absolute worktree path, and the
initial harness commit retains historical disposable settings in shared config.
The final report and shared config correct these; history was deliberately not
rewritten. Review the preserved history before pushing. The net changed-file list
below is confined to P0 safety, its harness, fixtures, consent review and reporting.
No pricing/package definitions, lockfile or founder context changes were introduced.

The JavaScript guard covers ordinary Node fetch/TCP, with explicit TLS denial
coverage. The macOS runner additionally denies outbound traffic at the OS boundary.
CI was inspected but not executed here and does not provide an identical OS sandbox.
The offline build uses bundled Geist font fixtures, not Google downloads. Sentry
emitted telemetry/source-map notices; outbound traffic was denied and no auth token
was supplied. Default Turbopack, browser UI acceptance and real providers were not
verified. No deployment or production compatibility claim is made.

## Original checkout and remaining review

Original checkout remained on `main` at the base above, with only ` M CONTEXT.md`.
Its SHA-256 remained exactly:
`9b2c32f773118f8e66e5909aa6a8a0eee1d09e86b210001aee81e5145179f773`.
The implementation worktree's CONTEXT matches committed main, not the founder edit.
No real SMS, email, calls, external provider/model/embedding operation, production
access, push, PR or deployment was performed. The founder's statement that production
has no actual users or shops is recorded as supplied information, not independently
verified evidence.

Before push review: correct the two failing regressions, add database concurrency
coverage for proof consumption, rerun this full verification, review all five P0
migrations and retained commit history, and inspect the held-message UI. The broader
Control Center, staffed-workspace policy model and other Phase-1 findings are not
closed by this P0 slice. No founder action is needed to interpret the failures;
implementation of the newly identified corrections requires a follow-up scope.

## Complete net branch file manifest

- `.github/workflows/ci-integration.yml`
- `.gitignore`
- `docs/P0_LOCAL_VERIFICATION.md`
- `eval/README.md`
- `eval/_live-setup.ts`
- `eval/_network-guard.ts`
- `eval/_setup.ts`
- `eval/_tenant-fixtures.ts`
- `eval/conflict-callsites.test.ts`
- `eval/contact-destination.test.ts`
- `eval/customer-send-boundary.test.ts`
- `eval/integration/_db.ts`
- `eval/integration/consent-canonical.int.test.ts`
- `eval/integration/customer-merge.int.test.ts`
- `eval/integration/quote-acceptance.int.test.ts`
- `eval/integration/tenant-relationships.int.test.ts`
- `eval/integration/twilio-inbound-replay.int.test.ts`
- `eval/job-photo-paths.test.ts`
- `eval/job-photo-signing.test.ts`
- `eval/network-guard.test.ts`
- `eval/purpose-review.test.ts`
- `eval/quote-booking.test.ts`
- `eval/quote-reference-boundary.test.ts`
- `eval/quote-response.test.ts`
- `eval/recovery-dedupe.test.ts`
- `eval/recovery-structured-csv.test.ts`
- `eval/send-policy.test.ts`
- `eval/service-purpose.test.ts`
- `eval/tenant-references.test.ts`
- `eval/webhooks.test.ts`
- `package.json`
- `scripts/export-test-env.mjs`
- `scripts/isolated-check.mjs`
- `scripts/offline-fonts.cjs`
- `scripts/test-stack.mjs`
- `scripts/verify-tenant-migration.py`
- `src/app/actions/approvals.ts`
- `src/app/actions/co-owner.ts`
- `src/app/actions/crm-cleanup.ts`
- `src/app/actions/customers.ts`
- `src/app/actions/jobs.ts`
- `src/app/actions/outbound-email.ts`
- `src/app/actions/outbound-sms.ts`
- `src/app/actions/quote-response.ts`
- `src/app/actions/quotes.ts`
- `src/app/api/aurinko/webhook/route.ts`
- `src/app/api/twilio/sms/route.ts`
- `src/components/gradia/pending-proposal-editor.tsx`
- `src/lib/agent-runtime.ts`
- `src/lib/approvals.ts`
- `src/lib/contact-destination.ts`
- `src/lib/customers.ts`
- `src/lib/job-photo-paths.ts`
- `src/lib/mcp/server.ts`
- `src/lib/memory.ts`
- `src/lib/merge-customers.ts`
- `src/lib/monitoring.ts`
- `src/lib/owner-agent.ts`
- `src/lib/send-policy.ts`
- `src/lib/service-purpose.ts`
- `src/lib/strings.ts`
- `src/lib/tenant-references.ts`
- `src/lib/vehicles.ts`
- `supabase/migrations/20260909090000_customer_channel_permissions.sql`
- `supabase/migrations/20260909091000_tenant_relationships.sql`
- `supabase/migrations/20260910090000_atomic_customer_merge.sql`
- `supabase/migrations/20260910091000_canonical_permissions.sql`
- `supabase/migrations/20260910092000_sms_channel_lifecycle.sql`
- `tests/sql/merge-failure.sql`
- `tests/supabase/config.toml`
- `vitest.live.config.ts`
