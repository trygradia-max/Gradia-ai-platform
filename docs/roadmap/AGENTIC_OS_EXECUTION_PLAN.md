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

Pending backend review at planning time: #108 → #109 → #110, plus #107. Check GitHub
again before integrating: CI, migration heads and branches can change. The prior
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

Implemented first slice: src/lib/operations-queue.ts and eval/operations-queue.test.ts.
This is an internal pure projection of pending actions, NOT a wired app feature, new
database, universal queue or daily brief. It preserves source ordering, exposes
loaded-window counts, rejects mixed-shop input, strips payloads, retains conflicts
and uncertain sends, and never executes work. Completed rows are omitted, not labelled
as delivered. No runtime call sites exist yet. No migrations or provider calls.

Next exact steps:
1. Review projection semantics against Activity/inbox and the new delivery conflict
   work. Do not import server-auth modules into a shared pure module.
2. Add an owner-authorized server loader deriving shop context; fetch bounded action
   rows and claim/conflict evidence scoped by shop, with pagination and failure states.
   Establish manager grant filtering before exposing to managers; staff fail closed.
3. Add integration tests for owner, manager without grant, revoked user, mixed tenant,
   unreadable evidence and pagination. Use a disposable database only.
4. Extend read model to intake workflows without duplicating the action for the same
   work; define grouping/provenance, then generate a deterministic brief from that model.
5. Give Cursor the tested loader types and fixture matrix. Keep UI off until reviewed.
6. Final combined CI, signed-in private acceptance, then explicit release decision.

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
