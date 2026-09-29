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

## Activated policy at the approval claim

September 27, 2026, local branch `codex/mvp-policy-execution` only. This slice uses
the existing Control Center editor and the existing approval executor. It does not
add a second policy editor, and it does not change production, providers, crons, or
write guards.

A saved draft remains inert. The owner activates one saved revision through
`activate_control_policy`, which checks the caller is the current owner and that
the expected active revision still matches. Activation does not connect a provider
or remove a release restriction. Catalog automations and `maybeAutoExecute` call
the executor with an explicit `automatic` context. They are no longer treated as
an owner click. `claim_control_action` rechecks the current policy, owner
membership, and entitlement inside the same transaction as the claim and the
decision audit. There is no legacy fallback when that claim fails.

SMS and email actions still do not carry a trusted granular purpose. The claim
applies the strictest relevant channel rule rather than a label from the payload.
Off, Read, and Suggest block executable staging when a policy is active. Calendar
and quote actions cannot be loosened past approval. With no activated policy, an
owner can still approve a pending action; an automatic claim cannot. Manager and
staff memberships do not gain approval authority in this slice.

Direct tools, inbound voice, human-composed sends, alerts, and cron jobs are not
all covered by this claim. Delegated manager approval remains owner-only on
purpose. Edit and reject still use the existing pending-action claim; they do not
execute a customer effect.

### Execution-slice verification

Node on the disposable stack `gradia-isolated-tests` only. The stack already held
all 72 migrations, including `20260927120000`. This run did not repeat a from-zero
reset.

| Check | Result |
| --- | --- |
| Complete unit suite | 1,024 passed; four unchanged intentional live-test skips; 89 files |
| Complete disposable integration suite | 210 passed; zero skips; 20 files |
| Policy execution integration file | 16 passed, included in the suite above |
| Permission and rollback probe | Passed: exact 72-migration ledger, RLS and RPC ACLs, six tenant relationships, activation and claim roll back when the audit write fails |
| Lint | Passed |
| Offline production build | Passed |
| Typecheck | Passed |

Commands: `node scripts/isolated-check.mjs unit`,
`node scripts/isolated-check.mjs integration`,
`python3 scripts/verify-control-execution.py`,
`node scripts/isolated-check.mjs lint`,
`node scripts/isolated-check.mjs build`, and
`node scripts/isolated-check.mjs types`. The isolated runner denies external
egress. Integration may reach only `http://127.0.0.1:56531`. No live provider or
model test ran. The authenticated Control Center click was not repeated in a
browser: the auth callback sends a completed login to the production origin, so
this session did not sign in. The activation button calls the same owner RPC the
integration tests exercise.

`vercel.json` disables Preview deployment for `codex/mvp-policy-execution`. No
push, merge, production migration, or provider change is included.

### September 29 verification follow-up

Resumed the existing clean implementation commit `f2fccee62c98155708ca412c8040b6807f1fd852`
on `codex/mvp-policy-execution`, based on merged PR #48 at `247bb50`. No application
change or repeated migration reset was needed. This entry supersedes the browser
limitation above: the local smoke harness uses a synthetic password session and
local cookies, without invoking a magic link or the production callback.

| Check on Node 22.23.2 | Result |
| --- | --- |
| Complete hardened unit suite | 1,024 passed, four intentional live-test skips, 89 files |
| Complete disposable integration suite | 210 passed, zero skips, 20 files |
| Existing Control Center browser smoke | Saved revision 2, explicitly activated it, rejected activation of unsaved edits, saved revision 3 while active revision stayed 2; anonymous access redirected to login |
| Ledger and policy probes | Exact 72 migrations; activation/claim audit rollback, RPC ACLs, RLS and six execution tenant relationships passed |
| Earlier migration probes | Membership authority, draft audit rollback, 70→71 backfill, all 26 P0 relationship definitions and both inconsistent-data refusal probes passed |
| Lint / fresh offline build / post-build typecheck | Passed |
| Whitespace and scan | Passed; 851 tracked files before adding the existing work log; no non-placeholder credential-pattern matches, tracked runtime artifacts or new machine paths |

The historical 70→71 probe initially failed because migration 72 adds foreign keys
to policy history. Its disposable transaction now explicitly removes the three
later execution tables before recreating the earlier schema. It still verifies
unchanged shop data and exact backfill counts, then rolls everything back. The
72-schema execution probe passed afterward, verifying restored tables and authority.
This is a test-fixture correction, not a production migration change.

Commands rerun: `node scripts/isolated-check.mjs unit`,
`node scripts/isolated-check.mjs integration`,
`python3 scripts/verify-control-policy-migration.py`,
`python3 scripts/verify-control-execution.py`,
`python3 scripts/verify-team-migration.py`,
`python3 scripts/verify-tenant-migration.py`,
`python3 scripts/verify-photo-migration.py`,
`node scripts/isolated-check.mjs lint`,
`node scripts/isolated-check.mjs build`, followed by
`node scripts/isolated-check.mjs types`, and `git diff --check`.
The ignored browser harness ran under an OS outbound deny allowing only localhost
ports 5360 and 56531; fictional auth/shop fixtures were removed. All application
checks used the existing isolated runner. The initial broad scan matched only
existing password placeholders; the placeholder-safe check passed. Pattern scanning
is not an exhaustive secret audit. Existing Sentry build warnings remain; network
was denied and no release or source-map upload was authorized.

Remaining coverage is unchanged: owner-only queued approvals, conservative channel
purpose and risk/exception intersections, existing money/calendar approval floors,
and legacy entitlement gates. The SQL adapter implements the bounded pending-action
mapping; it does not make the pure TypeScript evaluator universal runtime authority.
Direct tools, human sends, voice, alerts, cron transports and delegated manager
approvals still require integration. Policy changes serialize with claims; they
cannot recall an effect already authorized and in flight. Durable service-proof
consumption and manual reconciliation of uncertain delivery remain unchanged.

The five governing documents and PR #49 reconciliation were not rewritten. The
existing work log is carried forward verbatim with one completion entry. Production,
shared Supabase, provider settings, pricing, release guards and the founder checkout
were untouched. No push, merge or deployment was performed.
