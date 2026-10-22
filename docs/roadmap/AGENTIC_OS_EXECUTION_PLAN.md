# Gradia operations OS — execution and continuation plan

Updated 2026-10-21. User approved this roadmap. It expands the future product scope;
it does not declare these features shipped or change release permissions.

## Product promise

Give a business owner dependable digital employees that keep work moving and show
what actually happened. The interface speaks in outcomes: “3 replies need your
review,” “Waiting for the customer,” and “We could not confirm this send.”
“Agentic operating system” is positioning, not repeated UI jargon. Support service
businesses broadly; do not assume every business is a detailer.

A digital employee has a job, available tools, approved business knowledge,
permissions, spending/time limits, schedule, stop conditions and an evidence-backed
work history. Claude can supply reasoning behind Gradia's interface; Gradia owns
authorization, durable state, memory, auditing, billing and execution controls.
Model text is never permission, proof of completion, or a tool credential.

## Current baseline and boundaries

Starting main: 6d4c235 (integration #102). Shared database was last verified at 101
migrations, with 63 public tables/RLS/freeze guards. Reverify before releases.
Private candidate: https://gradia-ai-platform-4rojr4e8k-gradia1.vercel.app/dashboard
Signed-in hosted acceptance remains outstanding; a deployed login page is not
end-to-end acceptance.

Current GitHub review reverified on 2026-10-22: #107–#110 remain open and green. Claude's
#112 fixture repair, #113 callback evidence, #114 conflict review and stacked #115
lifecycle acceptance are also open and green; none is on main. Cursor's #101 and
#103–#106 remain separate green drafts updated on October 22. Check GitHub again before integrating. The prior
98-baseline migration work is completed evidence, not permission to replay it on
the current shared database. Preserve both work logs and every relevant test.

Public promotion, shared write unfreeze, provider/cron activation, and live Twilio
tests are separate decisions. Do not silently allowlist a pilot or bypass freezes.
Keep employee experiments separate behind existing flags. A private green UI gate
never cancels telephony activation blockers. Do not reset another agent's stack.

## Delivery sequence and acceptance gates

| Stage | Deliverable | Acceptance required |
| --- | --- | --- |
| 0 | Reliable channel/workflow foundation | Review pending telephony PRs together; callback-before-interaction evidence, uncertain outcomes, conflict visibility, ownership isolation, campaign freshness; final-tree unit/integration/types/lint/build, migration uniqueness and upgrade/freeze evidence |
| 1 | Operations queue read model | Existing durable actions remain authoritative; tenant-scoped authorized reads; unknown evidence stays unresolved; failed sources differ from empty; bounded counts; no side effects |
| 2 | Daily brief and exception desk | Deterministic factual summary with source links and observed time; partial/unavailable data visible; permissions match destination; no invented revenue/time saved; no retry button for uncertain sends |
| 3 | Durable work lifecycle | Reuse lead workflows/action records/runtime; add only missing ownership, due time, wait reasons and escalation links; CAS transitions and audit; persisted recovery after restart; distinguish task, approval and provider state |
| 4 | Reviewed business memory | Facts carry business, source, author, revision, validity and review state; conflicts require review; revocation/deletion propagates; tool/web content cannot modify instructions or publish memory |
| 5 | Business playbooks | Versioned trigger/steps/waits/stop rules; dry-run evidence; approval-first; idempotent retries; opt-out, consent, revoked grants, business-hours and budget checks at execution |
| 6 | Digital employee builder | Job templates → connected tools → permissions/limits → preview → activate; separate draft/active/paused/blocked; user can inspect and stop; credentials stored server-side only |
| 7 | Outcome tracking | Source-backed completed work and unresolved work; explicit attribution and time ranges; provider acceptance is not delivery; no estimated savings presented as facts |
| 8 | Browser skills | Isolated per-business sessions, explicit tool/domain scopes, secrets vault, artifact provenance, action confirmation for consequential work, time/cost limits, resumable checkpoints and kill switch |

First employee templates: missed-lead follow-up, appointment coordination, Google
Business Profile review/draft assistance, and grant research with sourced eligibility
and deadlines. Start research/drafting read-only. Publishing, applications, spending,
and customer outreach require appropriate explicit permissions and approval paths.
“Any digital employee” describes extensibility, not unrestricted production access.

## Architecture rules

- Extend existing agent runtime, lead workflows, pending actions, proof consumption
  and delivery-review contracts. Do not add a competing executor or generic task
  database merely to display a queue.
- Reads derive shop/member permissions on the server. A pure projector's shop-ID
  check is defense in depth, not authorization. Never pass a client-chosen shop ID
  straight into a service-role query. Test revoked and cross-business access.
- Model provider adapter: structured proposals plus evidence references; bounded
  iterations, cancellation, cost accounting and deterministic validation. Keep the
  model replaceable. Never execute arbitrary generated shell/SQL or expose secrets.
- Each external operation gets a stable command ID, durable attempt, claim and
  reconciliation path. Claim expiry is not proof that a timed-out provider stopped.
- Store minimal necessary business memory. Record consent/retention and explicit
  publication. Customer text and browser content are untrusted task data.
- Approval is bound to evidence and revision; recheck permissions, consent, freshness
  and limits when executing. A changed plan cannot borrow an old approval.

## Lane ownership and handoff prompts

### Claude Code — backend reliability, then durable lifecycle

Finish the existing callback/reconciliation/delivery conflict assignment first.
Read CLAUDE_NEXT_BUILD_2026-10-21.md in the parent Gradia folder if present. Review
current main and open PR heads; do not duplicate #107–#110. Next implement stage 3
as small PRs after stage 1/2 contracts settle: persist only lifecycle information
missing from current domain records. Prove restart recovery, tenant isolation,
concurrent transitions, unknown provider outcomes and revoked authorization using
disposable integration tests. No shared migrations, live providers, merges or deploys.
Do not replace Codex's projection or Cursor's UI. Append work logs and hand back exact
commits, test commands/results, migration versions and remaining limitations.

### Cursor — finish current UI lane, then operations surfaces

Finish existing copy/onboarding/welcome PRs before creating new operations UI.
Use the existing design tokens/components, accessible keyboard flows, reduced motion,
mobile and 200% zoom checks. Stage 2 starts only when an authorized loader contract
exists. Show needs-review, waiting, and unconfirmed outcomes distinctly; failed load
must not look like an empty queue. Keep source actions' permission checks. No backend
executor, credentials, fake counts or optimistic “done.” Create a separate PR for
brief/queue UI and report real signed-in acceptance vs fixture-only checks.

### Codex — contracts, integration, memory and releases

Own stage 1 projection/authorized read integration and stage 2 evidence contract;
review shared semantics with existing Activity/Approvals before UI use. Reconcile
backend changes on an isolated branch, run final-tree gates, verify migration upgrade
paths/freeze guards, and prepare only an authorized private candidate. Then implement
reviewed memory contracts before enabling employee tools. Keep this continuation file
current, with concrete commits and test results; never infer another lane is finished.

## Exact current implementation checkpoint

Worktree: /Users/harryhatch/Gradia/worktrees/operations-foundation
Branch: codex/operations-foundation

Implemented the pending-action/intake projection and its authorized read boundary:

- `src/lib/operations-queue.ts` remains pure and contains no auth/server imports.
- migrations `20261021120000_operations_queue_read.sql` and
  `20261022120000_operations_queue_intake_brief.sql` add a bounded, mixed-source,
  keyset-paged read-only RPC. It returns no payloads, destinations, intake text,
  provider evidence references or proof claims. Owners see candidate action and
  unresolved intake rows. Managers see intake only under `crm.read`, ordinary
  pending messages only under `crm.read` + `approvals.messages`, and uncertain or
  conflicting sends only under `crm.read` + `delivery.reconcile`. Staff, revoked
  members, cross-shop owners, anonymous users and sessionless service callers are
  denied on every read.
- `src/lib/operations-queue-reader.ts` validates the complete RPC response and turns
  refused, failed, thrown or inconsistent evidence reads into `unavailable`, never
  an empty all-clear. Completed sends no longer occupy a page before being hidden by
  projection. Equal-time action/intake cursors remain stable. Qualification actions
  and their source workflow share one work key and retain both provenance links.
- `src/lib/data/operations-queue.ts` has server-only owner and team-workspace
  overview loaders. Owner identity comes from the request. A manager's URL workspace
  candidate must first match the authenticated `team_workspaces` result, then the
  RPC independently rechecks current membership and grants.
- `OperationsOverview` is the tested Cursor contract: a queue page plus a
  deterministic brief observed at the same server time. Brief counts describe the
  loaded window only; `coverage: partial` remains visible when another page exists;
  unavailable data is never an empty brief. Source links target the existing
  permission-checking Approvals, delivery-review and intake routes.
- No UI/runtime page calls the loaders yet. This is not a universal queue, task
  store, executor, source mutation or provider call.

Next exact steps:
1. Review migration order and conflict semantics again after #113/#114 land; do not
   copy or replace Claude's delivery-conflict RPCs. The queue already reads the shared
   `pending_action_id` evidence shape.
2. Give Cursor `OperationsOverview`, mixed-source cursor semantics and the permission
   fixture matrix. Keep UI off until unavailable/empty/partial states and source-link
   behavior are reviewed; Cursor still owns the components and copy.
3. Reconcile onto the final backend tree after #107–#115 decisions, then run final
   combined CI, migration upgrade/freeze checks and signed-in private acceptance.
4. Add exception-desk presentation only after #114's final conflict contract is
   reconciled. Do not add retry controls for uncertain sends.
5. Public promotion, write unfreeze, provider/cron activation and live Twilio remain
   separate explicit decisions.

## Validation and recovery instructions

Read AGENTS.md and installed Next docs before Next changes. Existing isolated runner:
`node scripts/isolated-check.mjs unit|types|lint|build` (run each separately).
Use Node 22 and installed dependencies. Integration needs a known disposable stack;
do not copy shared production credentials into tests. A failing baseline is investigated,
not waived. No .env files in the isolated checkout. Record final test totals and commit.

If interrupted: inspect git status/log before editing, read this checkpoint and the
latest work log, inspect open PR heads and do not overwrite someone else's work.
Use /Users/harryhatch/Gradia/platform only for orientation: it is a stale checkout.
Do not claim the roadmap complete when only the projection exists. Shipping confidence
comes from the above gates, not an estimated number of days or model credits.

### Validation checkpoint — first projection slice

2026-10-21: isolated Node 22 full unit suite: 1,622 passed / 4 skipped (137 files).
Eleven new evidence-boundary tests pass. Full lint, TypeScript and offline production
build pass. No database integration run for this pure, unused projection: no SQL,
authorized loader or runtime call site changed. This is not the release gate for the
pending telephony integration or a claim of hosted acceptance.

### Validation checkpoint — authorized pending-action loader

2026-10-21, isolated Node 22.22.0: 1,626 unit tests passed / 4 skipped (137
files); lint, TypeScript and offline Next.js 16.2.6 production build passed. A
from-migrations reset of the disposable `gradia-isolated-tests` database applied
exactly 102 migrations through `20261021120000`. The new real-session integration
suite passed 5/5 and covers owner isolation, a manager without grants, distinct
approval/reconciliation grants, staff, revocation, cross-shop/anonymous/service-role
denial, bounded keyset pages, malformed/unreadable evidence and conflict visibility.
The full integration run reached 560 passed / 1 failed / 1 todo; the sole failure was
the documented local gateway error while seeding a booking-concurrency fixture, and
that entire unrelated file passed 13/13 immediately on one targeted rerun. An earlier
Node 24 run similarly hit three BYO gateway errors and passed that file 8/8 on rerun.
No shared database, provider, cron, deploy, write freeze or public traffic changed.

### Validation checkpoint — mixed queue and daily brief read contract

2026-10-22, Node 22.23.4: 1,630 unit tests passed / 4 skipped across 137 files;
lint, TypeScript before and after build, and the offline Next.js 16.2.6 production
build passed. A disposable reset applied exactly 103 migrations through
`20261022120000`; the one queue RPC is security-definer with an empty search path,
granted to `authenticated` only. Its expanded real-session suite passed 8/8,
including unresolved intake, manager grant separation, stable equal-time mixed-source
pagination, completed-send exclusion and the prior authorization/evidence cases.
The full integration run reached 562 passed / 1 failed / 1 todo; the one failure was
an unrelated local gateway error while seeding a Twilio callback case. That complete
file passed 16/16 immediately on a targeted rerun. No shared migration, UI, executor,
provider call, send, cron, deploy, write unfreeze or public promotion occurred.
