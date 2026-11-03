# Claude Code handoff: complete the deep Agent OS internals

_Prepared 2026-11-03. Start from current `main`. Read `AGENTS.md`, the five
September 11 governing documents and the latest `docs/AI_WORK_LOG.md` entries before
editing. Do not use historical MVP files as current authority._

## What is already merged

- PR #118: the pure Gradia Agent definition/compiler contract.
- PR #121: authorized operations queue and brief UI.
- PR #122: the first scheduled-run durable claim/lease/completion lifecycle in
  `20261029120000_custom_agent_run_lifecycle.sql` and `src/lib/agent-runs.ts`.
- PR #123: reviewed, versioned memory candidate → review → publish/revoke lifecycle
  in `20261103120000_reviewed_agent_memory.sql` and `src/lib/knowledge.ts`.
- Commercial catalog `2026-11-03.v1`: exact founder-approved pilot prices and an
  inactive Stripe manifest. Do not activate billing in this lane.

## Assignment 1: persist immutable agent definitions

Add the smallest tenant-bound persistence layer that stores immutable definition
revisions and one atomic active-revision pointer. Compile only server-loaded data
through the existing Agent OS definition compiler. Never accept a client-selected
shop, policy revision, knowledge revision or activation proof as authority.

Activation must fail closed unless the exact definition has current owner authority,
published knowledge grants, Control Center operation grants, connector readiness,
budget/limit validation and exact-revision dry-run/evaluation evidence. An edit
creates a new draft revision. Activation changes a pointer; it never mutates an
old revision. Pause/blocked/revoked states must prevent new claims.

Required integration evidence: owner versus manager/staff, revocation, cross-shop
denial, concurrent activation, stale policy/memory/evaluation refusal and immutable
old revisions.

## Assignment 2: extend the lifecycle without creating a second executor

Extend `custom_agent_runs` and existing workflows/pending actions/proof claims only
where required. Add durable step/command/attempt evidence around consequential
operations, stable command IDs, compare-and-set transitions, heartbeats and explicit
wait/reconciliation links. Preserve PR #122's rule: an expired or interrupted
provider attempt becomes `unknown`/needs reconciliation, never an automatic retry or
assumed completion.

Recheck membership, active definition, policy, consent, connector readiness,
approval revision, budget and grants immediately before each consequential effect.
Prove worker crash/restart, duplicate triggers, competing workers, requested versus
confirmed cancellation, provider timeout, revoked access and cross-shop denial.

## Assignment 3: close reviewed-memory provider boundaries

Do not replace PR #123's memory tables or create a second knowledge store. Add
prompt-injection classification and minimum-necessary PII redaction at every model,
embedding and future browser boundary. Preserve source content as untrusted evidence;
it cannot grant tools or publish itself. Add malicious-document, conflict, stale
fact, deletion, revoked membership and cross-shop integration coverage.

## Assignment 4: normalize the model/trace seam

Move employee planning calls behind one Gradia-owned structured adapter with bounded
iterations, timeouts, cancellation, token/cost/latency accounting and explicit error
states. Do not introduce automatic cross-provider fallback for consequential unknown
outcomes. Persist definition, policy, knowledge, actor and provider revisions in
traces while minimizing PII. Add exact-revision offline evaluation evidence usable
by the activation transaction.

## Non-goals and handback

No unrestricted “super agent,” arbitrary browser control, generated shell/SQL,
credentials in UI, second executor, shared-database mutation, provider activation,
live send, cron, deployment, Stripe provisioning or public launch. Keep each schema
slice reviewable and reset the disposable stack from zero.

For every PR hand back: exact base/head commits, migrations, changed authority
boundaries, unit/integration/type/lint/build commands and totals, concurrency and
tenant proof, known limitations and the exact next dependency for Cursor's builder.

