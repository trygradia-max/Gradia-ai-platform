# Control Center implementation ledger

## Status and scope

September 24, 2026: founder accepted PR #47's membership-foundation scope, including
its owner-only approval-execution limitation, and authorized moving to the next
MVP dependency. PR #47 remains an unmerged draft at
`96321b6c9761165cdd5ebc1433bc24f4bdff6405`. This branch is stacked on that exact commit.
It does not assume membership migration 70 exists in production.

The five governing MVP documents remain the product authority. This ledger records
implementation evidence; it does not replace their requirements or claim milestone 2
complete. Production guards and every delivery/cron/deployment restriction remain.

## First dependency: policy contract

`src/lib/control-center/policy.ts` is a pure, validated contract and decision function.
It is **not connected to application entry points**, a database authorization gate,
or a provider executor. No new controls are shown to users and no runtime authority
changes in this slice. A passing contract decision cannot authorize a real send.

It separates Off, Read, private Suggest, executable Approval and explicitly granted
Autonomous behavior; Custom composes scoped inputs rather than adding a mode.
Inputs bind shop, location, operation, connector, actor, command ID, canonical payload
hash and policy version. It preserves staged and current versions in the result.
Connector/workspace/location/role/risk/exception ceilings only restrict. Unknown or
missing inputs, policy-read failure, revoked authority and unverified safety deny.
Every action must already appear in the trusted actor's explicit capability set.
Staff cannot obtain general approval or communication authority through that set.

Approved defaults cover reads, private drafts, verified intake, identity review,
communication purposes, voice gates, quote/booking/discount exceptions, CRM changes,
causally bound mechanical updates, evidence, memory publication and notifications.
Outbound voice and campaigns remain unavailable. Setup-gated defaults are not live
activation grants. Separate booking and communication decisions preserve compound
outcomes. Current money/calendar floors remain; new settings cannot remove them.

Legacy `suggest` translates to Approval, preserving its existing staging meaning.
Legacy `autonomous` translates conservatively to Approval pending explicit action
review. This helper performs no settings migration. Unknown legacy values become Off.

The runtime adapter must authenticate humans independently, resolve live membership
and grants, load versioned policies, validate referenced records and destinations,
and derive safety/approval facts itself. Neither a model nor request JSON may supply
trusted facts. Payload hashing must cover the normalized complete command, including
recipient, channel, shop, context and changes. A boolean here is not evidence of
consent, a verified workflow or channel readiness. Durable proof claims and current
send-policy enforcement remain mandatory in addition to policy evaluation.

## Observed authority paths and integration obligations

| Surface / code | Current behavior | Required integration before claiming coverage |
| --- | --- | --- |
| `src/lib/approvals.ts` | Tenant-bound atomic status claim; existing reference/send/booking guards | Recheck live policy, actor and exact reviewed payload at claim/execution; durable decision evidence; delegated manager grants |
| `src/app/actions/approvals.ts`, `quotes.ts` | Owner session approvals, edits and conflict override | Preserve owner authority; scoped manager entry point; edits invalidate approvals; hard conflicts cannot be granted away |
| `src/lib/agent-runtime.ts` | Many recipe-specific pending-action inserts; `maybeAutoExecute` uses legacy settings and automatic context | Policy before staging; private Suggest must not queue; current policy before auto-execution; retain entitlement/floor checks |
| `src/lib/automations.ts` | Separate catalog mode, staging and autopilot; two executor calls omit automatic context | Explicit automation actor/context; common policy before staging and execution; no implicit owner-click classification |
| `src/lib/owner-agent.ts` | `preview_outreach`, `stage_outreach`, `draft_reply`, `add_note`, `create_lead`, `update_customer`, `propose_booking`, BI reads | Direct note/lead/customer writes need command authority; model request is not a human button click; retain private preview behavior |
| `src/lib/mcp/server.ts`, `src/app/api/mcp/route.ts` | Shop-bound token context; proposals plus direct customer/memory operations | Token capabilities and policy must constrain each registered tool; token is not owner-wide action approval |
| `src/lib/vapi-tools.ts`, `src/app/api/vapi/webhook/route.ts` | Capture, history/policy/menu reads and booking/quote/reschedule/cancel proposals | Verified connector identity, bounded inbound-voice activation and per-operation policy; keep deterministic security processing separate |
| `src/app/actions/outbound-sms.ts`, `outbound-email.ts` | Human-direct send and staged proposals | Human authority without redundant approval; connector disable/readiness, consent and proof still enforced |
| `src/lib/twilio.ts`, `aurinko.ts`, `send-policy.ts` | Provider adapters and consent boundaries | Last-mile policy/command evidence plus existing durable proof claims; no fallback provider on denial |
| `src/app/api/twilio/sms/route.ts`, `aurinko/webhook/route.ts` | Inbound processing and business follow-up | Mandatory STOP/suppression/security/delivery processing remains independent of disabled business automation |
| `src/app/api/cron/*` | Agent/catalog scheduling, reminders, retention, reconciliation, ROI receipt and other jobs | Inventory each job's domain and transport effects; `roi-receipt` sends directly; automation actor must not impersonate owner |
| `src/lib/alerts.ts` | Operational alert SMS can call transport directly | Separate internal alert capability and explicit notification setup; no business-send policy bypass |
| `src/app/actions/team.ts` | Session RPCs; live membership, explicit grants, atomic audit | Reuse DB authority; do not route ordinary staff notes/progress through a second AI approval |
| CRM/job/vehicle/pipeline/customer-merge and connector/settings server actions | Human owner authorization, domain/RLS constraints | Preserve AI-Off usability; inventory and classify each command; owner settings cannot be changed by manager grants |

This is a surface-level inventory, **not a completed call-by-call coverage claim**.
The runtime integration must expand each family to an explicit action mapping and
lock that mapping with tests. Newly discovered paths remain denied/unactivated until
mapped. Mandatory safety processing is not exposed as an arbitrary caller-selected
operation that bypasses the policy evaluator.

## Remaining work in this milestone

1. Complete active policy publication and append-only execution-decision evidence.
   Draft snapshots, owner-only saves, tenant/location relationships, RLS and
   concurrent revision checks are implemented in the draft-review slice below.
2. Implement trusted command adapters and atomic execution authorization, including
   delegated operational approvals. Existing memberships alone grant no approval.
3. Integrate every staging, direct-write and execution family above. Preserve proof
   at-most-once semantics, hard floors, human-direct behavior and mandatory safety
   callbacks; no process-local claims or trusted caller-supplied classifications.
4. Add usable Control Center controls with effective-policy reasons, inheritance,
   explicit action grants, connector ceilings and workspace automation kill switch.
5. Test fresh migrations, database/RLS denial, revocation/change races, private
   Suggest with zero executable queue writes, and zero provider effects on denial.
6. Run full isolated release verification and obtain founder review before merge.

There is no new founder product decision in this contract slice. It neither starts
lead intake/Whisper/booking workflow work nor lifts any production gate.

## Contract-slice verification

Node 22.23.2, September 24, 2026, using the existing isolated runner:

| Check | Result |
| --- | --- |
| Focused policy contract | 77 passed |
| Complete unit suite | 998 passed; four unchanged intentional live-test skips; 87 files |
| Complete disposable integration suite | 183 passed; zero skips; 18 files |
| Database ledger and membership probes | Exact 70-migration ledger; RLS/ACL/assignment references and transactional audit rollback passed |
| Lint | Passed |
| Offline production build | Passed; existing Sentry configuration warnings, network denied |
| Post-build typecheck | Passed |
| Tracked-file scan | 837 files; no matched credential patterns, tracked runtime directories or newly introduced machine paths |
| Whitespace | Passed |

Commands: `node scripts/isolated-check.mjs unit eval/control-center-policy.test.ts`,
`node scripts/isolated-check.mjs unit`, `node scripts/test-stack.mjs credentials`,
`python3 scripts/verify-team-migration.py`,
`node scripts/isolated-check.mjs integration`,
`node scripts/isolated-check.mjs lint`, `node scripts/isolated-check.mjs build`,
`node scripts/isolated-check.mjs types`, and `git diff --check` (including staged).
Credential generation output stayed private. The runner strips application
configuration and denies external egress; integration allows only the dedicated
local test API. No live provider or model tests ran.

There is no new migration in this slice. The already initialized disposable
70-migration stack was reused and its exact ledger reverified; a fresh migration
application is **not claimed for this run**. PR #47's previous from-zero verification
remains evidence for the unchanged migration files. Future policy persistence must
receive its own from-zero verification.

The exact branch exclusion `codex/mvp-control-center: false` was added to
`vercel.json`; a structural comparison proved every pre-existing setting unchanged.
No Vercel project setting, deployment, domain, production database or provider was
operated. PR #47 remains a draft. This slice remains local pending the remaining
runtime implementation; it is not presented as a completed Control Center PR.

## Versioned policy drafts and owner review

The next local slice adds `/control-center`, linked from Settings, with editable
workspace defaults/ceilings, connector ceilings, individual operation rules, and
role/risk/exception ceilings. It explicitly says that drafts do not alter current
execution. There is no activation button, live-policy pointer or implicit migration
of existing autonomy settings. A saved draft is not an autonomy grant.

`20260924120000_control_policy_drafts.sql` adds owner-readable draft and revision
history tables. It initializes existing and new one-location shops with an inherited
baseline. Both tables have composite shop/location constraints. Authenticated and
anonymous clients cannot write them directly; only an authenticated shop owner can
use the save RPC. Manager/staff memberships cannot elevate themselves through it.
The RPC locks the same shop row as membership changes, validates a finite vocabulary,
checks the expected revision, and saves the snapshot and actual actor atomically.
Identical same-revision saves are idempotent. Stale saves return HTTP 409 and require
reload; they never silently overwrite the winner. Unknown scopes, modes, script-like
rules or extra activation/actor fields are rejected. Inheritance is stored explicitly
as null where chosen. No credentials or customer content belongs in a policy draft.

The first focused database run exposed a real error-contract bug: returning SQLSTATE
`40001` for a stale draft caused PostgREST retry loops, timing out two tests. This is
an application conflict, not a retryable serialization failure. The implementation
now uses `PT409`, the supported explicit HTTP conflict response. See
[Supabase's diagnosis](https://supabase.com/docs/guides/troubleshooting/high-cpu-and-infinite-transaction-retries-when-using-custom-error-codes-in-rpc-functions-77326b)
and [PostgREST custom error responses](https://docs.postgrest.org/en/v13/references/errors.html).
No test was skipped or timeout relaxed. The final from-zero reset used the corrected
migration. The first browser attempt also uncovered ambiguous select accessible
names; each mode selector now has its explicit visible label as its accessible name.

Database evidence includes fresh initialization through migration 71, exact ledger,
owner/manager/staff/anonymous boundaries, foreign shop/location refusal, immutable
history for authenticated users, concurrent saves with one winner, actor attribution,
SQL/TypeScript action/mode parity, invalid-definition refusal, and audit-failure
rollback. A transactional 70→71 upgrade probe verifies an existing shop's entire row
is unchanged and exactly one baseline draft/history is created. The existing 26 P0
relationships and both inconsistent-data refusal probes remain verified.

This completes draft persistence/review, **not live command authority**. Remaining
milestone work includes effective-policy previews, trusted context resolution,
activation and durable execution decisions, delegated manager approvals, and complete
integration of staging/direct-write/provider paths. Drafts must not be activated
until those execution and race tests pass. The accepted roadmap and production gates
are unchanged; no additional founder decision is needed to continue local work.

### Draft-review verification results

Node 22.23.2, September 24, 2026 (Pacific):

| Check | Result |
| --- | --- |
| Complete unit suite | 1,014 passed; four unchanged intentional live-test skips; 88 files |
| Complete disposable integration suite | 194 passed; zero skips; 19 files |
| Final migration initialization | All 71 migrations applied from zero on the dedicated disposable stack |
| Migration and failure probes | Exact ledger, existing 26 tenant relationships, membership constraints, two new policy/location relationships, both P0 refusal probes, policy audit rollback in both write orders, and 70→71 backfill passed |
| Lint / offline build / post-build typecheck | Passed |
| Browser smoke | Fictional owner loaded screen, changed ceiling, saved revision 2 through the actual form and RPC, saw saved confirmation and refreshed history; fresh anonymous browser redirected to login |
| Scan / whitespace | 847 tracked files, 15 files changed since the membership base; no matched credential patterns, tracked runtime files or new machine-specific paths; whitespace passed |

Reproducible checks: `node scripts/test-stack.mjs reset`,
`node scripts/isolated-check.mjs unit`,
`node scripts/isolated-check.mjs integration`,
`python3 scripts/verify-control-policy-migration.py`,
`python3 scripts/verify-team-migration.py`,
`python3 scripts/verify-tenant-migration.py`,
`python3 scripts/verify-photo-migration.py`,
`node scripts/isolated-check.mjs lint`,
`node scripts/isolated-check.mjs build`, and
`node scripts/isolated-check.mjs types` after the build. Browser verification used
an ignored local harness, fictional auth records and an OS network deny allowing
only the disposable API and local application. Its fixtures were removed afterward.
No shared database or provider credentials were loaded into the application.

Persistence and tests are committed in `46420f2`; the following local UI/documentation
commit completes this slice. PR #47 and remote branches are unchanged. The founder
checkout remains on `main` with only its original `CONTEXT.md` modification and hash
`9b2c32f773118f8e66e5909aa6a8a0eee1d09e86b210001aee81e5145179f773`.
No push, merge, deployment, production migration, provider activation or write-guard
change is included. These test results do not claim runtime Control Center enforcement.


## Later status — 2026-09-24 documentation recheck

The draft-only limit in this ledger still holds after merge. PR #48 merged to
`main` as `247bb5056002b97b57bbafd503655f51a498e199`. The implementation commit
recorded above remains `543e3c1702abd04c80556b021d2e48a6cefd011c`. Both required
GitHub checks had succeeded. Saving a policy draft still does not activate
executor enforcement. Scoped manager approval execution and full runtime command
authority remain incomplete. This documentation pass did not rerun the 1,014
unit or 194 integration results, and it did not deploy.
