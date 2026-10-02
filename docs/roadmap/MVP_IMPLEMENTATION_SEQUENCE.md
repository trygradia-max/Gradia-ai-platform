# MVP implementation sequence

> Implementation baseline: merged `main` at
> `4552f586a3b892b4e112337aca6eb76a530dd829` (PR #45), including merged P0 PR #44.
> Product decisions **approved September 11, 2026** remain unchanged. These five
> documents are the founder-designated source of truth for the sellable MVP build;
> their approved requirements supersede conflicting historical scope documents.
> Existing implementation, future requirements and release permission are distinct.
> Release status verified September 15, 2026 (Pacific): Node 22 deployment and
> founder authentication passed; **35 production write guards remain active**.
> Public access remains restricted to the authentication test gate. Non-authentication
> delivery, crons, automatic builds and automatic domain assignment remain disabled.
> See [verified baseline and production gate](#verified-baseline-and-production-gate).
> This documentation-only update does not authorize feature implementation or lift
> any release gate. Protected `CONTEXT.md` and application code remain unchanged.
>
> **Evidence addendum, 2026-09-24 (Pacific).** Fresh `origin/main` is
> `247bb5056002b97b57bbafd503655f51a498e199`, merge of PR #48, which contains PR #47.
> Step 1’s membership foundation is merged code, not accepted delegated execution.
> Step 2’s policy contract and versioned draft editor are merged code. **Drafts do
> not activate policy.** Runtime authority, effective-policy preview, trusted
> context, activation, durable decisions and delegated manager approval execution
> remain the next incomplete dependency. Do not start a second policy editor.
> Production write guards and channel activation were not re-inspected in this
> documentation pass; the September 15 hold below stays the last documented gate.
> The 15 September 11 decisions are not reopened. Prices, trial caps and seat
> terms stay unresolved in [post-MVP ideas](POST_MVP_IDEAS.md).

## MVP NOW

This is the implementation sequence for the approved sellable MVP. Use the five
linked documents as the requirements baseline when feature work is separately
authorized. Reuse existing ticket work after code verification; do not restart P0
cleanup, migrations or merged security fixes. Keep changes small and reviewable;
do not activate tenancy and calendar migrations together.

### Verified baseline and production gate

| Completed work | Evidence and practical limit |
| --- | --- |
| P0 safety, [PR #44](https://github.com/trygradia-max/Gradia-ai-platform/pull/44) | Merged as `77c1c9acd115806baacb737d3ab65c15be396127`: shop/destination-bound consent, cross-tenant reference checks, atomic consent-preserving customer merge, durable proof replay prevention and canonical photo paths. This is a security foundation, not a completed Agent MVP |
| Database release | Approved cleanup completed once after verified encrypted recovery; shared ledger has all 69 migrations. All 26 tenant relationships, reviewed functions/security definitions/grants and retained `waitlist` schema passed verification. Both inconsistent-data refusal probes passed; no silent repair |
| P0 verification | 850 unit passes, 4 intentional live-test skips, 156 disposable integration passes; Node 22 lint, offline build and post-build typecheck passed. See [P0 verification](../P0_LOCAL_VERIFICATION.md) for the historical exact-commit evidence |
| Callback security, [PR #45](https://github.com/trygradia-max/Gradia-ai-platform/pull/45) | Merged/deployed as `4552f586a3b892b4e112337aca6eb76a530dd829`. Trusted production-origin internal redirects replace unsafe `next` concatenation; `/dashboard` default and successful code exchange preserved. 41 callback regressions; 891 unit passes plus 4 intentional live-test skips; 156 integration passes; lint, offline Node 22 build and post-build typecheck passed; protected `checks` and `integration` passed |
| Production callback probes | 19 token-free deployed failure-path probes and database health passed. Successful-exchange destination validation is covered by isolated regressions; do not describe these probes as 19 real logins |
| Controlled authentication | Founder-reported login corroborated by advanced auth metadata and a browser tab at `https://gradia-ai-platform.vercel.app/onboarding`, without authentication parameters in its address. All 35 public application-table content hashes remained unchanged; retained counts stayed 7 auth users, 10 identities and 5 shops |
| Auth redirect configuration | Site URL is `https://gradia-ai-platform.vercel.app`; explicit allowlist contains that exact origin and `/auth/callback`. Development, ngrok and wildcard Preview entries removed. PR #45 validates the subsequent application redirect; the allowlist alone is not that protection |

**Authentication is accepted; operational production release is not.** The narrow
exception permits only user-requested Supabase login emails. It does not enable
business email, manager notifications, SMS, calls, Meta, campaigns, follow-ups or
unattended delivery. Registration behavior was preserved; testing reused an
existing confirmed account. No addresses, links, tokens or private release artifacts
belong in these documents.

All **35 temporary application-table write guards** remain enabled. The production
domain is bound to the verified deployment, but network/method/path restrictions
still limit access to the controlled test. Crons, automatic Git builds, automatic
domain assignment and non-authentication provider activity remain disabled.
Login landing on onboarding is not proof of onboarding completion or usable CRM:
the guards block onboarding writes, customer edits, booking and other mutations.

Removing those guards and widening traffic require a separate, explicit founder
release decision and controlled verification; neither follows automatically from
successful login or this documentation PR. Preserve application/RLS constraints,
consent and replay protections when removing only temporary release guards.
Provider/channel activation remains a separate decision after its acceptance gates.
Future implementation may use isolated development infrastructure without lifting
production restrictions. The usable manager reconciliation interface and operational
workflow acceptance remain implementation/pilot gates, not completed P0 claims.

### Authoritative document set

- [MVP vision](../product/GRADIA_MVP_VISION.md): product scope and release stages.
- [Agent architecture](../architecture/GRADIA_AGENT_ARCHITECTURE.md): reused systems and incremental contracts.
- [Autonomy and approval modes](../architecture/AUTONOMY_APPROVAL_MODES.md): authority and initial action defaults.
- [Gradia Memory](../architecture/GRADIA_MEMORY.md): evidence, reviewed learning and retention.
- This sequence: dependencies, verification and remaining release obligations.

### Build sequence

| Order | Bounded outcome | Reuse / prerequisite | Exit evidence |
| --- | --- | --- | --- |
| 0 | P0 and callback foundation completed; production write gate remains | PRs #44/#45, 69 migrations, 26 tenant relationships and accepted founder authentication | Separate founder authorization and controlled acceptance before removing the 35 temporary write guards or widening traffic; provider/cron activation remains independently gated |
| 1 | Membership and minimum operations scope | `shops`, `shop.ts`, `forShop`, existing appointment/CRM spine | **BUILT / VERIFY on `main` via PR #48 (includes #47), commit `247bb50`.** Reported at #47 head `96321b6`: 921 unit passes + 4 live skips, 183 integration passes, 70 disposable migrations. Still missing: scoped manager approval execution, invitation delivery, full navigation. Do not mark step 1 accepted from the schema alone |
| 2 | Control Center and command authority | Existing approval executor, autonomy and send policy | **PARTIAL on `main` via PR #48 head `543e3c1`, merge `247bb50`.** Policy contract and owner-only versioned drafts exist. Reported at that head: 1,014 unit passes + 4 live skips, 194 integration passes, 71 migrations from zero; GitHub `checks` and `integration` succeeded before merge. **Drafts do not activate policy.** Next work is runtime authority, not a second editor |
| 3 | Reliable normalized lead intake | Provider event claims, identity/dedupe, import/form adapters | Durable lead event/transition; synthetic duplicate/reordered input and crash recovery; no identity/consent inference; new/ambiguous lead appears in Chief of Staff |
| 4 | Whisper inbox and operational handoff | Interactions, call records, SMS/email transports, existing Chief of Staff | In-thread SMS/email replies, thread context, assignment/unread state, immediate manager notifications and optional digest through an independent transactional-email adapter, quiet hours, deduplication and retry state; honest held/unknown status |
| 5 | Bounded qualification and nurture workflow | Owner-agent tools, drafter context, planner/runtime recipes | Persisted conversation state; asks missing service/vehicle/timing information; approved per-action nurture; STOP and human takeover interrupt automation; replay does not double-send |
| 6 | Service/quote → availability → booking → pipeline | Existing menu/pricing, quotes, availability and serialized appointment RPC | Menu-grounded quote, duration and capacity; staff/location assignment; zero default manager discount limit, owner approval unless delegated, non-overridable hard conflicts; exactly one booking under concurrency; one linked pipeline update and governed confirmation |
| 7 | Reviewed structured memory and follow-up | Trust resolution, knowledge, interactions, safe merge | Capture draft delta; separate candidate review/publication; next action uses approved rule; consent provenance and rollback tests extend to new references |
| 8 | Connected operational acceptance | Applicable pilot gates, then all gates for full-channel MVP; channel readiness and model evaluations | 5–10 controlled pilot shops through verified SMS/website/Meta channels (email after inbound/reply acceptance); all five channels including inbound voice for completed MVP; solo/team walks, hold/recovery drills, traceable summaries and AI-Off CRM |

Implement the narrow model-provider seam while touching a worker in step 5: preserve
its prompt and behavior, validate normalized output and provider metadata, then
expand incrementally without automatic multi-model fallback for MVP. Future provider
changes require quality, safety, cost and latency evaluations with no safety regression.
Complete the schema for memory provenance/delta capture when
step 4 edits are introduced; the reusable-rule publication loop lands in step 7.
Do not lose feedback while waiting for the final memory UI.

Step 3 targets pilot SMS, website intake and Meta adapters, initially using synthetic
fixtures. A controlled pilot may onboard 5–10 shops once enough verified functionality
exists; channels activate independently. Email may join only after complete inbound
and reply acceptance. A limited pilot is never the completed full-channel MVP.
Each new live channel independently passes signature, workspace binding, consent,
readiness and replay gates before activation. SMS registration and Meta review can
run as founder business prerequisites in parallel; this document initiates neither.
The completed full-channel MVP requires SMS, website intake, Meta, email and inbound
voice to pass individual gates. Voice stays Off until real-call, forwarding,
escalation, consent and number-continuity acceptance passes; it does not block the
first non-voice pilot. Outbound calls remain Off. “Built” is not “ready to sell.”

Step 6 must resolve Aurinko coupling explicitly: preserve the guarded current path
until a tested native-first path and sync/reconciliation states are ready, or retain
the connected-calendar dependency for a limited pilot. Required-calendar state is
available/unavailable/unknown; unknown or stale state blocks automatic confirmation.
Qualification and preferred-time collection continue into a held manager-review
action. Automatic booking requires execution-time availability and capacity checks;
ordinary approval/autonomy cannot bypass hard resource/capacity conflicts.
Do not expand into a full scheduling rewrite to obtain these guarantees.

### Cross-cutting release gates

- Every side effect is actor-, tenant-, policy- and consent-controlled; denial has
  zero provider effects. No alternate model/cron/MCP route bypasses approval.
- Migrations apply from zero on a dedicated disposable stack, verify exact ledger,
  constraints, existing deletion behavior and nullable relationships. Test synthetic
  inconsistent data refusal. New relationships extend an explicit reviewed manifest.
- Unit, database integration, typecheck after build, lint, offline build and targeted
  workflow tests pass; live model changes require their own controlled quality evals.
- Unknown transport outcome remains held with manual reconciliation. Never reissue
  a consumed proof or auto-resend to make a dashboard look complete.
- No unapproved production or provider operations. PRs #44 and #45 merged with founder
  authorization; this documentation-only branch is authorized for a draft PR, not
  merge or deployment. The inherited branch exclusion protects the P0 branch only.
  The project-level ignored-build command currently prevents automatic builds;
  historical deployment hosts are denied. Recheck these holds before any future push.
  Releasing documentation does not authorize restoring providers, crons or automatic
  deployments, or count as authenticated pilot workflow acceptance.

## ARCHITECT FOR LATER

Sequence role/location scope before new workflow/memory entities, and command/outbox
identity before more autonomous effects. Retain provider/record separation and
versioned memory/policy. Keep capacity extensible without implementing complex
optimization. Introduce additional workers/services only after measured need; no
new universal orchestrator is a prerequisite.

## POST-MVP

Campaigns/reactivation at scale, richer multi-location resource optimization, broad
connector expansion and advanced analytics follow the lead loop. Payments, fleets,
memberships, full work orders and previously excluded features need a separate
founder scope decision; they are not silently revived from E04–E10. Do not change
pricing or packages as part of architecture implementation.

## EXISTING SUPPORT

The sequence reuses B-03 Chief of Staff, B-16 menu/hours onboarding, CRM and
quote/calendar primitives, approval engine, send boundaries, provider replay claims,
agent recipes, trust telemetry and shared memory. PR #44 adds safety prerequisites,
not the complete Agent MVP. Current GitHub verification is evidence for its exact
commit only; no architecture behavior was executed in this documentation phase.

### Evidence register (read before implementation)

| Reviewed source | How used |
| --- | --- |
| Root `CONTEXT.md`, founder-only diff, `CLAUDE.md`, historical `PROJECT_BRIEF.md` and `SHARPENING_BRIEF.md` | Scope precedence, older exclusions, planner/runtime and control invariants |
| `docs/gradia-v2/00-product-principles.md`, `02-target-architecture.md`, `03-domain-model.md`, `10-roadmap.md` | Retain modular monolith/domain spine; distinguish target architecture from built behavior |
| `docs/gradia-v2/program/current-sprint.md`, `backlog.md`, `11-decision-log.md` | Historical sequence/status and conflicting decisions; no auto-promotion of old tickets |
| [PR #43 handoff](https://github.com/trygradia-max/Gradia-ai-platform/blob/docs/handoff-astra/docs/GRADIA_HANDOFF_TO_ASTRA.md) | Read without merging; voice-first scope, missing team/intake/threading and ticket-number collision; historical operational claims not reverified live |
| `docs/gradia-v2/adr/ADR-003-service-role-tenant-scoping.md`, `vendors/registry.md` | Reuse accepted `forShop` mechanism; provider status claims can be stale |
| `docs/outbound-sms.md`, `outbound-email.md`, `mcp-architecture.md`, E03/E07 epics and approval/inbox flow docs | Communications/CRM intent, stale Slack/provider references and inbox gaps |
| `src/lib/owner-agent.ts`, `agent-planner.ts`, `agent-runtime.ts`, `agent-events.ts`, `autonomy.ts`, `trust.ts` | Actual tools, recipe scheduling, event kinds, hard floors and telemetry |
| `src/lib/shop.ts`, `supabase/for-shop.ts`, `availability.ts`, `approvals.ts`, CRM actions and schema | Owner-only tenancy, existing conflict wiring, external-calendar coupling and dual state |
| `src/lib/memory.ts`, `knowledge.ts`, `customer-context.ts`, `whisper.ts`, `whisper-summary.ts` | Shared recall, limited voice intent parsing, inference versus approved memory |
| `docs/P0_LOCAL_VERIFICATION.md`, merged PRs #44/#45, callback tests and controlled login evidence | Completed safety work, exact-commit verification, authentication acceptance and remaining write/traffic gates |

## ARCHITECTURAL GAPS

The highest-risk gaps are not the model choice: owner-only access, fragmented action
policy, lack of a durable lead workflow, incomplete operational communications,
calendar dependency/capacity semantics and unreviewed memory learning. Intake, email
threading, role-aware retrieval and actionable failure notifications need concrete
acceptance coverage, not just a schema or UI toggle.

Conflict register:

- **Superseded September 11, 2026:** D-069's voice-required first release is replaced
  by a controlled non-voice pilot and a full-channel MVP requiring inbound voice.
  D-067's solo/team/location exclusions and older owner-only launch limitations give
  way to solo/team parity at one active location/mobile service area. No full
  work-order or payment scope is revived.
- B-18 is superseded: one primary Agent, internal skills and optional functional
  activity labels, with no separate personalities or memory silos.
- Old D-021 floors, D-068 defaults and current two-mode code differ. Treat the new
  policy model as a tested migration, not a permission to remove safeguards.
- Legacy `leads.status` and `stage`, flat vehicle fields and first-class vehicles,
  catalog automations and custom recipes overlap. Inventory consumers, choose one
  authoritative field/path, migrate with compatibility checks; no destructive cleanup.
- B-19 is used for both phone continuity and draft-edit capture on unmerged docs
  branches. Assign unique implementation identifiers before ticketing; do not reuse
  that number here.
- Historical outbound/MCP docs mention Slack approvals and HCP, removed by D-052.
  Do not rebuild them. Outbound email exists; email-thread reply remains incomplete.

## FOUNDER DECISIONS

**All 15 decision areas approved September 11, 2026.** No resolved item remains an
open founder choice. The sequence implements the following requirements:

| Area | Decided requirement |
| --- | --- |
| Release stages | 5–10 controlled shops; pilot SMS/website/Meta independently verified, optional email after inbound/reply acceptance; full-channel MVP adds all gates including inbound voice |
| Voice | Replaces voice-required first release; Off until real-call/forwarding/escalation/consent/number-continuity acceptance; outbound calls Off |
| Location | One active operating location/mobile service area, multiple staff/resources/capacity schedules; defer cross-location scheduling/transfers/routing |
| Roles | Owner controls members/connectors/integrations/billing/exports/merges/shop rules/autonomy; managers delegated operations/customer memory; staff assigned work/notes/progress only |
| Booking/pricing | Approval-first; separate normal-booking/menu-quote opt-ins; owner discount approval unless explicit manager limit (default zero); confirmed moves/cancellations approved; hard conflicts never bypassed |
| Notifications | In-app plus independent transactional email; immediate, deduplicated, quiet hours, optional digest; adapter, delivery/retries, no loops, Gmail dependency or Slack approvals |
| Calendar outage | Unknown/stale required calendar blocks automatic confirmation; qualify and hold for manager; independent operation only after verified native authority |
| Autonomy | [Approved initial matrix](../architecture/AUTONOMY_APPROVAL_MODES.md#approved-initial-autonomy-matrix); simple Off/Suggest/Approval required/Autonomous/Custom; direct humans use their authority |
| Whisper | Unified enabled SMS/email/calls; voice notes enter the same Agent, not a separate brain |
| Presentation | One primary Agent; internal skills, optional functional activity labels |
| Solo/team parity | Same complete core; implicit owner assignment for solo; invitations/delegation/assignments/capacity/scoped views for teams |
| Learning | Tenant-isolated structured, versioned evidence and reviewed rules; managers customer scope, owners shop-wide publication, staff propose; human CRM edits need no second approval |
| Retention | Provisional 30-day audio, 12-month content, 90-day rejected candidates; approved memory until superseded/expired/deleted; separate safety evidence policy |
| Uncertain delivery | Visible manager-owned hold, owner fallback, no auto-resend; evidence and confirmed non-delivery before intentional new action/proof; audited resolution |
| Models | Current setup behind Gradia interfaces; no automatic multi-model fallback for MVP; future changes evaluated with no safety regression |

**Remaining implementation/release obligations, not open architecture choices:**
select the transactional-email vendor behind the adapter; privacy/legal review and
final privacy-policy alignment before production retention (including the separate
safety-retention schedule); channel readiness and native-calendar authority acceptance
where applicable. None authorizes live operations in this documentation phase.

## Marketing repository follow-up

Do not edit `Gradia-Web-Cursor` from this platform pass. Local marketing checkout
`58bef16` on `site-v2` was 22 commits ahead of `origin/site-v2` at the 2026-09-24
handoff and was not re-fetched here. Needed corrections, when that repo is edited
on purpose: use one Gradia Agent and Whisper as unified communications; say
controlled pilot versus five-channel MVP; admit solo and staffed shops; call the
dashboard Chief of Staff (Chief of Operations is the same screen); do not claim
SMS, Meta, email reply, or voice are live; do not publish $99/$149/$249, a 14-day
trial, or seat prices as decided. Outbound email exists in the product via
connected Gmail; in-thread inbox reply does not.

## ACCEPTANCE CRITERIA

Every phase has the exit evidence in the sequence table. Final acceptance adds:

1. Run both solo and staffed-shop scenarios across enabled entry channels: ambiguous
   identity, quote exception, customer pause, manager edit, concurrent slot requests,
   provider timeout, membership revocation, STOP and resumed workflow.
2. Replayed events and cross-action proof reuse create zero duplicate transports or
   bookings; unknown outcomes create a visible manager-owned reconciliation task with
   owner fallback and an audited resolution; never automatically resend consumed proof.
3. Every CRM stage, appointment, communication and memory entry links to evidence and
   policy. Operational summaries count real outcomes, not staged drafts as success.
4. An independent reviewer checks tenancy, consent, migration safety and operational
   failure paths. Founder separately accepts usability, channel readiness and claims.
5. Acceptance fixtures cover every initial autonomy row and every role boundary;
   no ordinary approval defeats hard conflicts, STOP or consumed-proof protections.
   Notify without loops and exercise unknown/stale calendar holds.
6. Pilot acceptance records 5–10 shops and their verified active channels. Full-MVP
   acceptance records all five channel gates including the complete inbound voice
   acceptance set. Sales labels match the release stage.
7. Test memory publication roles, provenance/expiry/supersession, retention boundaries
   and safety-record preservation. Privacy/legal approval precedes production cleanup.
8. No code, migrations, credentials, Vercel settings or services change as a side
   effect of accepting this documentation. Implementation starts only when authorized.
