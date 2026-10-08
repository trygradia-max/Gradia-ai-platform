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

## Agent capture integration — September 29

The next bounded slice routes owner-Agent `add_note` and `create_lead`, plus MCP
`propose_lead`, into the existing pending-action review/execution path. These calls
no longer write customers, vehicles, leads or interactions before review. Captures
remain proposals even when a policy would permit autonomous execution; this slice
does not automatically execute them. The existing owner approval handler performs
the write and rechecks current policy. Ordinary human CRM forms are unchanged.

Migration `20260929120000_agent_capture_staging.sql` adds one staging RPC, no tables
or backfill. It locks the shop, checks current owner membership and Shadow Mode,
and uses migration 72's policy trigger. MCP must supply its independently resolved
live same-shop token identity; revocation is checked under a row lock. Model source
labels cannot replace server attribution. Pending actions retain source, requester,
token identity and staged policy revision; execution retains the existing audit.
The RPC restricts capture types to notes/leads. An unchanged command ID retries
idempotently; changed payload/actor/type/source or foreign-shop collisions refuse.
It never treats a chat/tool request as human approval.

Owner tool invocation IDs deterministically bind stable command UUIDs to shop and
source. MCP `propose_lead` now requires a `command_id` UUID reused on retries. MCP
clients must refresh their tool schema. An ambiguous response tells the caller to
check Approvals rather than claim success or automatically retry with a new ID.
Shadow Mode prevents these queue writes in both application and SQL. The existing
Approvals UI renders the unchanged note/lead payloads; no new settings screen exists.

### Verification and limitations

Node 22.23.2; dedicated disposable infrastructure only:

- Hardened unit suite: 1,037 passed, four existing intentional live-test skips,
  91 files. Includes 13 new deterministic capture/real-dispatch tests.
- Database suite: 220 passed, zero skips, 21 files. Ten new cases cover current
  policy, foreign/anonymous actors, stable/concurrent retries, token revocation,
  Shadow Mode, attribution, owner approval and completed-action replay.
- Fresh reset applied all 73 migrations. Exact ledger, policy ACLs, activation and
  claim rollback, membership probes, historical backfill, 26 P0 relationships and
  both inconsistent-data refusal probes passed.
- Lint, offline production build and post-build typecheck passed. No live provider,
  embedding or model calls; embeddings/CRM push are mocked in the execution test.
- The live owner-Agent routing eval fixture/expectations now require honest queued
  capture responses. Live model evaluation was **not run**; prompt wording changed
  to remove the false immediate-save promise. Model quality remains a release gate.

Commands: `node scripts/test-stack.mjs reset`,
`node scripts/isolated-check.mjs unit`,
`node scripts/isolated-check.mjs integration`,
`node scripts/isolated-check.mjs lint`,
`node scripts/isolated-check.mjs build`,
`node scripts/isolated-check.mjs types`, all five existing migration probe scripts,
and `git diff --check`. OS outbound denial stayed in place; integration allowed
only the disposable API. Probes must run sequentially after integration: overlapping
schema-probe transactions with the full suite produced a failed historical probe;
the sequential rerun passed. No failure was accepted as a release skip.

Initial focused testing exposed inappropriate use of the session-only `team_lock`
helper for MCP. The RPC now takes the same shop row lock directly and independently
checks actor/token authority. A revocation fixture incorrectly attempted to disable
the protected owner membership; the corrected test verifies that operation is
refused, rather than weakening owner protection. Final focused/full suites passed.

**Not complete at the September 29 commit:** direct `update_customer`, lead-only
customer materialization in `resolveCustomer`, MCP `find_or_create_customer`/
`record_interaction`, read capability scoping and general MCP token capabilities
remained uncovered. Voice, alerts, cron transport, granular message-purpose rules
and delegated manager approvals also remained separate work.

## Reviewed customer and history commands — October 1

Local branch `codex/mvp-policy-execution` only. This slice continues the capture
adapter. Owner-agent `update_customer`, MCP `find_or_create_customer`, and MCP
`record_interaction` now stage `update_customer`, `resolve_customer`, or
`record_interaction`. They do not write customers, vehicles, or interactions
before review. Approval applies the command inside `claim_control_action`, in the
same transaction as the decision audit. A saved draft still does not execute
anything, and these three commands stay on the approval floor even if a policy
would otherwise allow autonomy.

Customer edits carry the reviewed name, phone, email, and vehicle snapshot.
A changed record or a vehicle write that fails rolls the contact change, the
claim, and the audit back together. Customer and vehicle updates set
`updated_at` to `clock_timestamp()`, so a proposal bound to the previous
snapshot cannot land after a later write. A new phone or email does not receive
the old destination's marketing permission. Reported history is stored as
agent-reported, unverified content. It cannot satisfy inbound reply proof.
Consent fields cannot be patched through a customer edit. Records are not merged.

A lead with no customer row is no longer created as a side effect of lookup, and
it is no longer reported as missing. A unique lead with a complete international
phone queues `resolve_customer` and leaves the original reply, edit, or booking
unperformed. Several matching leads are described for the owner to choose.
Shadow Mode does not queue that proposal. Ordinary human CRM forms are unchanged.

### Verification and limitations

Final verification used Node 22.23.2 and the isolated runner with outbound network
denied except the disposable database API. The existing local demo was preserved.
A separate, unlinked `gradia-record-fresh` stack applied all **75 migrations from
zero** and its exact ledger matched the repository. No shared schema was touched.

| Check | Final result |
| --- | --- |
| Full hardened unit suite | 1,048 passed; four intentional live-provider skips; 92 files |
| Full database integration suite | 239 passed; zero skips; 22 files |
| Record-command integration subset | 19 passed |
| Customer-edit/lead-resolution unit subset | 10 passed |
| Lint, offline production build, post-build typecheck | Passed |
| Existing five migration probes | Passed; all 26 tenant relationship definitions verified |
| Record command probe, existing and fresh stack | Passed; exact ledger, ACLs and late-failure rollback |
| Local browser approval | Reviewed fictional email before/after; approved through existing UI; database confirms approved, expected value and exactly one decision audit |
| Whitespace and credential/runtime-artifact inspection | Passed |

Commands (with Node 22 selected): `node scripts/isolated-check.mjs unit`,
`node scripts/isolated-check.mjs integration`, `node scripts/isolated-check.mjs lint`,
`node scripts/isolated-check.mjs build`, `node scripts/isolated-check.mjs types`;
`python3 scripts/verify-control-policy-migration.py`,
`python3 scripts/verify-control-execution.py`,
`python3 scripts/verify-team-migration.py`,
`python3 scripts/verify-tenant-migration.py`,
`python3 scripts/verify-photo-migration.py`,
`python3 scripts/verify-agent-record-migration.py` and the latter with `--fresh`;
`git diff --check`. Migration probes ran sequentially after integration.
Fresh-stack startup used `supabase --workdir .local-tools/record-fresh start`
with an ignored isolated configuration, unique project ID and non-conflicting
ports. Local demo fixtures/configuration/credentials remain ignored.

Additional boundaries verified: complete canonical phone comparison distinguishes
international lead identities with the same trailing digits; failed lookups cannot
queue identity creation; vehicle edits bind both timestamp and reviewed fields;
reported-history parent references must also belong to the selected customer.
The late-failure probe rejects the final pending-action update and verifies that
the domain change and decision audit roll back together. Browser checks are a
focused local smoke test, not comprehensive visual or accessibility coverage.
Live model/prompt evaluation was not run and remains a release gate.

**Still not covered:** MCP read-capability scoping, general token capabilities,
voice, alerts, cron transport, granular message purposes, and delegated manager
approval. The policy milestone is not release-complete. No push, merge,
deployment, shared migration, provider activation, or founder-file change is
included. September 11 product scope and the reconciled pricing remain unchanged.

## MCP read admission — October 2

The five data-reading tools and five resources now recheck the current shop-bound
MCP token, revocation, shop owner and active owner membership before domain queries
or embedding lookups. The server still scopes every domain query by shop because
its service client bypasses RLS. The activated revision, not the saved draft, supplies
the policy. Missing/failed/malformed authority fails closed with a generic denial;
no active policy preserves the existing authenticated read baseline.

| MCP surface | Required existing policy operations/connectors |
| --- | --- |
| Customer lookup, recent customers, active leads, customer detail | `crm.read` / CRM |
| Recent channel activity, customer timeline | `history.read` / CRM |
| Customer memory and shop knowledge search | `history.read` / CRM plus memory connector ceiling |
| Service menu | `menu.read` / CRM |
| Shop snapshot | Both `crm.read` / CRM and `availability.read` / calendar |

All non-Off modes include read permission. Disabled policy, an effective Off grant,
or an Off workspace, location, owner-role, connector, risk or exception ceiling
blocks the read. Risk/exception ceilings apply conservatively until trusted request
classification exists. Shop knowledge uses the restrictive history-read permission
plus memory ceiling because the current action catalog has no dedicated knowledge
read action. The pure phone normalizer is unchanged and reads no shop data.

Verification on Node 22.23.2: **1,093 unit tests passed**, four existing intentional
live-test skips (94 files); **243 integration tests passed**, zero skips (23 files).
Focused coverage: 45 unit tests plus four database tests. Tests exercise all ten
registered denial boundaries with zero downstream reads/provider calls, subsequent
revocation and policy changes, foreign-shop/owner contexts, disabled scopes,
malformed authority, failed lookups and saved-versus-activated policy behavior.
Lint, offline production build, post-build typecheck and whitespace checks passed.
Commands: `node scripts/isolated-check.mjs unit`, `integration`, `lint`, `build`,
then `types`, under the existing outbound-denying runner. No migrations added;
the verified 75-migration schema remains unchanged. Credential-pattern and generated
artifact inspection includes newly added files. The localhost demo is preserved.

This is per-invocation **read admission**, not a database transaction spanning the
read/provider request: revocation during an already admitted read cannot cancel it.
No persistent per-read audit or per-token capability grant model is added here.
General token capabilities, MCP outbound/calendar proposal staging, voice, alerts,
cron transport, granular message purposes and delegated manager approval remain
unfinished. Authorized semantic searches still use the existing embedding adapter;
none were invoked against real providers during verification. No model prompt was
changed in this slice. This is local implementation, not release authorization.

## MCP capability grants and remaining proposals — October 2

Every token now has an explicit allowlist of ten data-read surfaces and six proposal
tools. No wildcard or implied grant exists. The existing Settings token card lets
the owner select grants at mint time and shows the grants for each token; replace a
token to change its grants through the UI. Existing owner-only token RLS protects
management. Migration `20261002120000_mcp_capabilities.sql` adds a non-null, checked
`capabilities` array with an **empty default for existing and new tokens**. This is
an intentional restrictive rollout: existing MCP integrations lose read/proposal
access until an owner mints and configures an explicitly scoped replacement.
No token is deleted or production credential rotated by this local work.

Read admission requires the exact token grant as well as the previously documented
current owner and activated policy checks. All six MCP proposal tools now use
`stage_agent_capture`: lead capture, identity resolution, reported history, SMS,
email and booking. The database locks/checks the same-shop token, revocation and
proposal grant during staging. Stable command IDs bind retries to one pending row;
changed payloads conflict. Trusted attribution overrides caller source labels.
Approval rechecks the token grant, so removal/revocation holds already queued MCP
work. Legacy queued MCP work without valid token attribution is also held, never
implicitly grandfathered. Shop policy, Shadow Mode, consent, proof and calendar
execution checks remain in force. Token permission never grants direct execution.

SMS/email proposals require the referenced customer and exact canonical destination
in the same shop and always stage as marketing. Service classification, proof
injection and hidden reference/transport fields are rejected by the RPC. Existing
execution still enforces destination-bound permission; staging is not permission
to send. Booking proposals require an owned customer and matching contacts. MCP
booking staging no longer calls availability/providers: authoritative availability
is checked in the existing approval executor. Cards therefore do not receive the
old advisory availability snapshot from MCP staging. No provider call occurs on
denied proposal dispatch. Pure phone normalization remains a data-free helper.

### Verification

Node 22.23.2: **1,102 unit tests passed**, four intentional live skips (95 files);
**254 database integration tests passed**, zero skips (24 files). Lint, offline
production build and post-build typecheck passed. Whitespace, credential-pattern,
machine-path and generated-artifact scans passed. All **76 migrations** initialized
from zero; exact ledger, all **26 tenant relationships**, tenant/photo refusal
probes and atomic-record late-failure probe passed.

The usual disposable stack had a migration from other work (`20261001130000`),
so migration-up refused it; no repair/reset was attempted. Tests instead used the
separate unlinked `gradia-record-fresh` stack. The test runner and socket guard now
explicitly allow either exact project/origin pair, never arbitrary URLs or credentials.
`--fresh` selects only the dedicated second stack. The original local demo is
preserved; it has not been migrated to this slice and token-management UI should
not be used there to verify the new schema. A browser interaction test of the new
grant picker remains outstanding; build/typecheck cover the UI compilation.

Commands: `supabase --workdir .local-tools/record-fresh db reset --local --no-seed`;
install `tests/sql/merge-failure.sql` only in `supabase_db_gradia-record-fresh`;
`node scripts/isolated-check.mjs unit`, `integration --fresh`, `lint`, `build`,
`types`; `python3 scripts/verify-agent-record-migration.py --fresh`; existing tenant
and photo probes run with their fixed target/config names substituted in memory
for this separate disposable stack; `git diff --check`.

The first full integration attempt correctly failed the merge rollback test because
fresh initialization omitted its test-only fault trigger. Installing the existing
fixture and rerunning all tests passed; no assertion or release skip was added.
The old source assertion requiring MCP staging to import availability was replaced
with a staging-only regression while retaining the central availability checks for
execution. MCP test tokens now explicitly receive the capabilities used by their
fixtures; empty, unknown, wrong-shop and removed grants have separate denial tests.

Remaining limits: no persistent per-read audit, no cancellation of already admitted
reads or external work, no self-service in-place grant editing (revoke/reissue), and
no live model/tool-routing evaluation. Read-admission race limitations above remain.
The wider voice/alert/cron adapters, granular message purposes and delegated manager
approval are still unfinished. Tool schema changes require live evaluation before
release activation; no real provider/model was contacted here. No push, merge,
deployment, shared database change or founder-file change is included.

## Delegated manager authority — October 8 status

The first explicit delegated manager grant now exists: `delivery.reconcile`, limited
to recording human delivery assessments on consumed sends. See
`docs/architecture/WHISPER_INBOX.md`. It does not touch `claim_control_action`:
queued approvals, edits, rejections and staging remain owner-only, and the policy's
manager role ceiling is still not consulted at execution. Delegated approval
execution remains the open part of item 2 above. It needs a decision on which action
families a manager may approve and an executor path that does not depend on
owner-only row access; neither is started here.

## Delegated manager message approval — October 8

Branch `codex/claude-delegated-message-approval`, stacked on the delivery-review
slice. Founder decision recorded this session: the first delegated approval family
is **queued customer messages only** (`send_sms`, `send_email`). Bookings, quotes,
captures, record edits and identity resolution stay owner-only.

An owner grants a manager `approvals.messages` in the existing team settings. It is
valid only together with `crm.read` and only on a manager membership; constraints on
memberships and invitations enforce that. No grant is added to any existing member.

Migration `20261008160000_delegated_message_approval.sql` is migration 90 (renumbered
after public form intake took the earlier timestamp on `main`). The claim
body moves, unchanged for owners and automatic callers, into a private
`control_claim` function that no API role can execute. `claim_control_action` keeps
its signature and grants and calls it with no review binding, so it can never
authorize a manager. A new session-only `claim_delegated_message` always uses the
signed-in caller as the actor. For a manager the claim requires, inside the same
shop-locked transaction as the audit and the status change:

- an active manager membership holding both grants, on the caller's own session;
  a service caller can never act as a manager and a manager is never automatic;
- a message action that is still `pending` (not mid-edit) and whose payload hash
  equals the hash the manager was shown, so any edit forces a fresh review;
- the existing MCP token recheck and the activated policy, further tightened by
  the policy's manager role ceiling when one is set.

Every decision row now records `actor_role`. A manager attempting any other action
type is refused with an audited `owner_approval_required` decision.

`list_delegated_message_approvals` is a session-only read for the owner or a
delegated manager: pages of 20 pending, unspent messages with recipient, subject,
body, purpose, reason and the review hash. Proofs, tokens and internal references
are not returned. Managers still have no direct access to `pending_actions`.

Execution reuses the one executor. `executeApproval` takes an optional delegated
option: the claim runs on the manager's session, and only after it succeeds do the
unchanged send executors run with a service client scoped to the shop id the claim
returned. They need shop credentials and owner-only rows a manager session cannot
read. A refused claim never touches that client. `approveDelegatedMessage` is the
only new service-client importer and is registered in the reviewed inventory test.
Send policy is untouched: consent, STOP, DNC, quiet hours, channel readiness,
exact-context proof and at-most-once claims all still decide whether anything sends.
A manager cannot reclassify a message's purpose; that stays an owner review.

`/team/approvals?shop=...` is a minimal manager surface linked from the team page.

### Verification and limits

Node 22.23.2, isolated runner, unlinked `gradia-record-fresh` only, rerun in full after
merging `main` (which now contains the delivery-review slice and public form intake):
1,262 unit passes (four existing live skips, 111 files); 397 integration passes (zero
skips, 37 files); lint, offline production build and post-build typecheck passed. All
90 migrations applied from zero and matched the ledger. A new catalog probe,
`scripts/verify-delegated-approval-migration.py`, and the existing Whisper, intake,
agent-record, team, tenant, photo, control-policy and control-execution probes
passed, including claim/audit rollback and all 26 tenant relationship definitions.
The public-form probe targets its own separate stack and was not rerun here.

Twenty-one new integration cases cover the audited manager claim, stale, malformed
and mid-edit reviews, eight owner-only action types, the owner entry point and
service callers, grant, role, revocation and cross-shop boundaries, an owner/manager
race, the bounded queue with zero mutation, the manager ceiling and connector
switches, and end-to-end SMS and email execution with mocked transports: sent
exactly once under concurrent approval, not sent without owner purpose review or
consent, and blocked by STOP and do-not-contact. Thirteen new unit cases cover the
action and the executor's delegated path.

Two test-run findings: a granted manager calling the owner entry point was first
refused as `review_changed`; the role check now requires the review binding, so the
refusal is `actor_not_authorized`. And `create_quote` is not in the
`pending_action_type` enum in any migration, so it cannot be queued on a database
built from this repository; that is pre-existing and left for a separate fix.

Limits: managers can approve but not edit or reject; rejection still uses the
owner-only pending-action update. The page was compiled, not exercised in an
authenticated browser. A manager approval does not stamp the trust resolution used
for autonomy recommendations, so it cannot influence them. No manager notification
is sent when messages are waiting. Live provider behaviour was mocked. No merge,
deployment, shared database or provider activity.
