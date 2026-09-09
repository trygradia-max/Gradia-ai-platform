# Isolated P0 implementation — local review record

Base: `20e153a8ac7b55bc682e5a49c6e9486ac51e9ae5`.
Branch: `fix/p0-tenant-policy-safety`.
Worktree: `/Users/harryhatch/Gradia/worktrees/p0-tenant-policy-safety`.

## Implemented

- Deterministic test setup no longer loads application environment files. Socket
  denial survives ordinary mock restoration. Live evals remain in a separate,
  explicitly gated configuration and were not executed.
- A macOS isolated runner clears credentials and denies external network access;
  integration alone permits the exact disposable local Supabase endpoint.
- SMS/email sends resolve one shop-owned customer and bind the actual destination
  to that customer. Missing, ambiguous, failed or mismatched lookups deny sending.
  DNC, SMS STOP, per-channel suppression, marketing consent and SMS quiet hours
  apply to manual and approved customer sends. Email permission precedes token refresh.
- Channel permissions are destination-bound; legacy generic consent and historical
  inbound interactions do not automatically authorize marketing. Known producers
  classify their deterministic purpose; unknown legacy categories remain held.
- Quotes, vehicles, interactions and supplied approval references validate parent
  ownership. Public quote reads reject invalid graphs before returning customer data.
- Photo signing rejects any invalid stored path before constructing a signing client.
- Twenty-six public foreign keys now include shop_id, retaining names, nullable
  relationships and deletion actions. Database checks also enforce photo path scope.
- Denied cross-tenant action probes retain local monitoring without external alerts.

## Environment and commands actually executed

Node 22.23.2 (official archive checksum verified), npm 10.9.8. `npm ci` installed
934 locked packages. No dependency version or package-lock change.

Supabase CLI 2.98.2 / PostgreSQL 17; unique project
`gradia-p0-tenant-policy-safety`. Local API port 55431, database port 55432.
No remote link, application environment file, copied credentials or production data.
The existing `gradia-app` stack was never reset, reused or changed.

The first startup using an internal Docker network could not expose the DB port to
its CLI and failed before migrations. A distinct local bridge resolved startup.
The test processes remained behind their own OS network-denial boundary.

```sh
node scripts/isolated-check.mjs unit
node scripts/isolated-check.mjs types
node scripts/isolated-check.mjs lint
node scripts/isolated-check.mjs integration
node scripts/isolated-check.mjs build
python3 scripts/verify-tenant-migration.py
```

| Check | Final result |
| --- | --- |
| Unit | 80 files passed; 816 tests passed, 4 live-model tests skipped |
| TypeScript | Exit 0; no diagnostics |
| ESLint | Exit 0; no warnings/errors |
| Database integration | 14 files / 125 tests passed; none skipped |
| Offline production build | Exit 0 (`next build --webpack`) |
| Fresh database initialization | All 64 migrations applied from zero, automatic seed disabled |
| Migration refusal probe | Passed: deliberate synthetic mismatch refused without repair; fixture transaction rolled back |
| Diff whitespace | `git diff --check` passed |

The offline build uses a build-only CSS fixture referencing Geist binaries already
bundled in Next. It does not verify Google font availability or the default
Turbopack build path. Production font configuration is unchanged.

The final schema was queried only in the dedicated disposable container: 64
migration records and 26 composite public foreign keys. Owner-session and
service-role regressions cover cross-shop parent insertion/update, recipient
mismatch, channel suppression, photo scope, nullable references and deletion.

Existing tests that expected forged references to create replacement bookings now
require refusal with no replacement lead, booking or provider call. Their safety
assertions were strengthened; golden LLM cases and prompts were not weakened.

## Migration files

- `20260909090000_customer_channel_permissions.sql`: additive permission table;
  no inferred consent or data backfill.
- `20260909091000_tenant_relationships.sql`: tenant-bound relationships and photo
  path checks. Inconsistent existing relationships abort the migration; no rows
  are repaired, reassigned or deleted by the migration.

## Review limitations and next steps

This is the approved first P0 slice, not closure of every Phase-1 finding.

1. Review the new consent representation and plan a verified consent capture path
   before expecting legacy marketing sends to resume. No consent-management UI or
   bulk consent migration is included. Unclassified pending sends require review.
2. Review deployment sequencing: apply the schema before enabling the new send
   boundary. Missing schema fails closed. Existing production data was not queried;
   deployment preflight must check for mismatched relationships and invalid photo
   paths and stop for explicit remediation if any exist.
3. Review customer-merge consent preservation separately (Phase-1 S7), alongside
   remaining action-policy, replay and billing work. This slice does not implement
   the full Control Center or staffed-shop authorization model.
4. Run a browser workflow review on synthetic local data before requesting push/PR
   authorization. No live provider connectivity, visual E2E or production smoke
   test was performed.

No SMS, email, calls, live model/embedding calls or real-provider operations were
performed. Network use outside verification was limited to authorized runtime,
package and container-image acquisition plus Git metadata. No deployment, push,
PR creation, pricing change, or merge of PRs #38/#42/#43 occurred.

Original checkout remains on main with only its founder CONTEXT.md edit.
Its before/after SHA-256 is identical:
`9b2c32f773118f8e66e5909aa6a8a0eee1d09e86b210001aee81e5145179f773`.
The implementation worktree retains the committed CONTEXT.md, without that edit.

## Complete changed-file manifest

- `.github/workflows/ci-integration.yml`
- `.gitignore`
- `docs/P0_LOCAL_VERIFICATION.md`
- `eval/README.md`
- `eval/_live-setup.ts`
- `eval/_network-guard.ts`
- `eval/_setup.ts`
- `eval/_tenant-fixtures.ts`
- `eval/conflict-callsites.test.ts`
- `eval/customer-send-boundary.test.ts`
- `eval/integration/_db.ts`
- `eval/integration/quote-acceptance.int.test.ts`
- `eval/integration/tenant-relationships.int.test.ts`
- `eval/job-photo-paths.test.ts`
- `eval/job-photo-signing.test.ts`
- `eval/network-guard.test.ts`
- `eval/quote-booking.test.ts`
- `eval/quote-reference-boundary.test.ts`
- `eval/quote-response.test.ts`
- `eval/send-policy.test.ts`
- `eval/tenant-references.test.ts`
- `package.json`
- `scripts/isolated-check.mjs`
- `scripts/offline-fonts.cjs`
- `scripts/verify-tenant-migration.py`
- `src/app/actions/co-owner.ts`
- `src/app/actions/crm-cleanup.ts`
- `src/app/actions/jobs.ts`
- `src/app/actions/outbound-email.ts`
- `src/app/actions/outbound-sms.ts`
- `src/app/actions/quote-response.ts`
- `src/app/actions/quotes.ts`
- `src/app/api/aurinko/webhook/route.ts`
- `src/app/api/twilio/sms/route.ts`
- `src/lib/agent-runtime.ts`
- `src/lib/approvals.ts`
- `src/lib/job-photo-paths.ts`
- `src/lib/mcp/server.ts`
- `src/lib/memory.ts`
- `src/lib/monitoring.ts`
- `src/lib/owner-agent.ts`
- `src/lib/send-policy.ts`
- `src/lib/tenant-references.ts`
- `src/lib/vehicles.ts`
- `supabase/config.toml`
- `supabase/migrations/20260909090000_customer_channel_permissions.sql`
- `supabase/migrations/20260909091000_tenant_relationships.sql`
- `vitest.live.config.ts`
