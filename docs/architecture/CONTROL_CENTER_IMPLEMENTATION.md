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

1. Persist versioned policies and append-only change/decision evidence; owner-only
   policy mutation, tenant/location relationships, RLS, concurrent revision checks.
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
