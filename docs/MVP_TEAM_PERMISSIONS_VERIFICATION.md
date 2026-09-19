# Team membership milestone — local verification

## Scope and baseline

This is the first unfinished dependency in the five governing MVP documents.
Documentation PR #46 passed `checks` and `integration`, remained documentation-only,
and merged with merge commit `c24b675f088019774af1ad29fc11482e2c0ef04b`.
`feat/mvp-team-permissions` starts from that exact merged `main`. PRs #44 and #45
are already merged; their consent, tenant, proof, photo and callback controls remain.

This milestone does not activate production. The 35 temporary write guards,
restricted traffic, disabled crons and non-authentication delivery safeguards remain
outside its scope. No shared database operation or provider delivery is required by
this branch. The new migration has been exercised only in disposable infrastructure.

## Existing architecture reused

- Existing Supabase authentication, `shops.owner_id`, session client and owner RLS.
- Existing customer, appointment, vehicle and interaction records. Staff notes are
  internal `note` interactions, with an authenticated actor in metadata.
- Existing owner-only shop resolver, approval engine, consent/proof checks,
  sensitive settings, exports and atomic customer merge.
- Existing hardened Node 22 runner and portable, unlinked disposable Supabase
  configuration. No changes to the shared `supabase/config.toml`.

The missing pieces were individual memberships, explicit role grants, assignments,
revocation, durable invitations and a usable member entry point. Raw `shops` rows
contain connector credentials, so membership does **not** grant raw shop-row SELECT.
A restricted RPC projects workspace name, membership role/grants and location ID.

## Implemented authority

| Operation | Owner | Manager | Staff |
| --- | --- | --- | --- |
| Membership and invitation administration | Yes | Denied | Denied |
| Existing connector, billing, export, merge, autonomy and shop-rule actions | Existing owner paths | Denied | Denied |
| View customers and jobs | Own shop | Explicit `crm.read`, otherwise assigned records only | Assigned records only |
| Add internal customer note | Yes | Explicit `notes.write` plus record access | Assigned customer, including customer of assigned job |
| Job progress | Yes | Explicit `jobs.progress` plus record access | Assigned job |
| Assign/unassign work | Yes | Explicit `assignments.manage`; visible work to staff only | Denied |
| Generic direct customer/job/message/consent writes | Existing owner RLS | Denied | Denied |
| Existing pending-action approval execution | Existing owner path | Denied in this slice | Denied |
| Read immutable team audit | Yes | Denied | Denied |

Manager grants default to empty. They confer no autonomy or outbound-delivery
permission. Staff cannot receive manager grants. Progress permits booked/confirmed
→ checked-in → in-progress → on-hold/completed, and on-hold → in-progress. It cannot
change time, price, payment status or send a notification. An expected-status check
refuses stale updates.

The existing general approval executor is deliberately not widened by adding a
role. Granular delegated approval execution and customer-memory publication belong
to the next command-authority and later memory milestones respectively. There is no
nonfunctional manager approval control in this interface.

All team mutations use the signed-in session. PostgreSQL locks the shop, rechecks
current membership and writes the mutation and actor audit in one transaction.
Revocation removes assignments and blocks subsequent requests using the same JWT.
A stored revocation timestamp also rejects older invitations across email changes.
Only an owner-issued invitation newer than the revocation can reactivate that user.

## Invitation and UI behavior

`/team` provides owner membership management, explicit manager grants, assignments,
permitted customer notes/job progress and team activity. The owner sidebar links to
it. Members without an owned shop reach it through the existing onboarding entry.
Owners retain their existing dashboard and solo onboarding behavior. One location
is created per shop; the unique shop key prevents a second location in this MVP.

Invitations store a SHA-256 digest of a random 256-bit code, a seven-day expiry,
role/grants and actor. Acceptance requires the signed-in user's **currently verified**
email to match. Cancellation, reissue, expiry, reuse and concurrent acceptance fail
closed. The plaintext code is returned once, never stored or placed in a URL.
The owner can securely give it to the invitee for acceptance at `/team`.
**No invitation email is sent.** Live delivery remains blocked.

Loading, empty, pending, success and error states are implemented. Lists show up to
50 customers/jobs, 100 recent notes/invitations and 50 audit entries; this is the
minimal team work surface, not the finished operational CRM or approval inbox.

## Migration and data implications

`20260919120000_shop_memberships.sql` adds five RLS tables:
`shop_memberships`, `shop_locations`, `shop_assignments`, `shop_invitations` and
`shop_team_audit`. It adds explicit RPC ACLs, the owner bootstrap/invariant triggers,
three composite assignment relationships and SELECT-only member policies on
customers, appointments, vehicles and interactions. Existing owner mutation
policies remain unchanged.

Existing shops receive exactly one owner membership and one location without
changing their shop rows. Owner transfer requires a separately reviewed workflow.
Membership administration is through RPCs; generic authenticated table mutation is
revoked, including mutation of audit history.

Customer assignment references refuse deleting/merging an assigned losing customer.
An owner must review and explicitly remove that assignment first, then decide any
new assignment after the merge. This prevents silently losing assignments or
widening staff access to the merged customer. The merge transaction rolls back on
refusal; no data is repaired or reassigned automatically. Appointment deletion keeps
its prior behavior and cascades only that appointment's assignment. Nullable and
existing P0 relationship semantics remain intact.

`action_decisions` is specifically tied to pending actions and is best-effort; it is
not repurposed for mandatory membership authority audit. The new audit stores actor,
event, subject and bounded change metadata, never note content or invitation codes.

## Verification

Verified implementation HEAD: `85478d02ae4cf047de9f09e800b330ee4bac92a0`.
The subsequent report commit changes documentation only. Node 22.23.2 and the exact
lockfile dependencies are used; no runtime/dependency upgrade.

| Check | Final result |
| --- | --- |
| Complete hardened unit suite | **921 passed, 4 intentional live-test skips**, 86 files; includes 30 new team contract/server-action cases |
| Complete disposable integration suite | **183 passed, zero skipped**, 18 files; includes 27 new membership/invitation/assignment cases |
| Fresh initialization | Dedicated disposable stack removed without backup and recreated; all **70 migrations** applied from zero |
| Ledger/schema probes | Exact repository ledger; all five new RLS tables and explicit RPC ACLs; three composite assignment references |
| Existing safety probes | All **26** reviewed tenant relationships match; tenant and uppercase-photo inconsistent-data probes both refuse without repair |
| Additional SQL probes | Unverified-email acceptance refused; verified acceptance succeeds; forced audit failure rolls back the note |
| Existing-owner backfill | Separate 69→70 probe created exactly one owner membership/location and preserved the original shop row |
| Typecheck | Passed, including the required check after the offline build regenerated Next types |
| Lint | Passed with no errors or warnings |
| Offline production build | Passed with provider/network egress denied; existing Next/Sentry deprecation warnings remain |
| Local browser smoke | Owner controls, staff scope, actual note form/server mutation and revocation UI passed using fictional accounts |
| Repository scans | Whitespace passed; no credential-shaped matches, generated runtime files or new machine-specific paths |

The final database run took 57.93 seconds; the final unit run took 5.38 seconds.
An intervening local run suffered auth/database timeouts (123 passes, 60 tests not
run because four suite setups failed). Those are **not accepted release skips**.
Overlapping local typechecks were stopped; only the dedicated auth/gateway and then
`gradia-isolated-tests` stack were restarted/recreated. The final serial run passed
all 183 cases without relaxing tests, timeouts, RLS or egress controls.

Local commits:

- `e22945775116cdf4b09bb38cb5ffac58c87402f5`: database authority and integration/SQL probes.
- `b4443e1ba6581c0bfc1d70166982fbfe570bf2de`: scoped team UI, session actions and unit coverage.
- `85478d02ae4cf047de9f09e800b330ee4bac92a0`: exact feature-branch Preview exclusion.

The complete branch diff contains **14 files**, including this report. No application
code outside the team entry point, its owner navigation link and member onboarding
redirect was changed. The original checkout remains on its existing `main`, with
only its prior `CONTEXT.md` modification; SHA-256 remains
`9b2c32f773118f8e66e5909aa6a8a0eee1d09e86b210001aee81e5145179f773`.

Commands run from the isolated worktree with Node 22 on PATH:

```sh
npm ci --ignore-scripts --no-audit --no-fund
node scripts/test-stack.mjs reset
# Final clean recreation after local auth recovery:
node scripts/test-stack.mjs stop
node scripts/test-stack.mjs start
node scripts/test-stack.mjs credentials
node scripts/isolated-check.mjs unit
node scripts/isolated-check.mjs integration
node scripts/isolated-check.mjs lint
node scripts/isolated-check.mjs build
node scripts/isolated-check.mjs types
python3 scripts/verify-team-migration.py
python3 scripts/verify-tenant-migration.py
python3 scripts/verify-photo-migration.py
git diff --check
git diff --cached --check
```

The runner strips application environment configuration and denies outbound network
at the OS boundary; integration permits only the dedicated loopback Supabase API.
The existing `gradia-app` stack is not used or reset. Tests use fictional fixtures;
live model, SMS, email, calendar and other provider traffic is unavailable.

Additional disposable checks cover the 69→70 owner backfill; full ledger equality;
all five RLS tables and RPC ACLs; the existing 26 tenant relationships; unverified
invitation refusal; audit-failure rollback; and both existing inconsistent-data
refusal probes. A local production-build browser smoke uses fictional authenticated
users, local-only browser/OS egress, the actual staff note form and revocation UI.
It does not exercise a real login email or any provider.

## Review and remaining gates

- Review RLS/security-definer functions, assignment scope, invitation revocation and
  append-only audit independently before merging.
- Production migration and write-guard release remain separate founder decisions.
  This draft PR must not be merged or deployed as part of implementation.
- Preview is disabled for exactly `feat/mvp-team-permissions` in `vercel.json`, while
  preserving the existing P0 exclusion and every cron definition. Automatic project
  builds and domain assignment were checked read-only and remain disabled.
- Invitation email delivery is not activated. Manager approval execution, full CRM
  navigation/pagination, approval inbox and operational summaries remain later work.
- No new founder product decision blocks this permission foundation.
- Next dependency: the Control Center's common command-authority contract, including
  execution-time capability checks for delegated operational approvals. Membership
  alone must never be treated as permission to use the legacy general executor.
