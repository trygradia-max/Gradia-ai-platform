# Claude handoff — immutable Gradia Agent definitions

## Copy-paste prompt

```text
Implement Build 1 only in this worktree:

/Users/harryhatch/Gradia/worktrees/claude-agent-definitions

Branch: claude/agent-definition-revisions
Base: current origin/main at or after ca629da (merged PR #134)

Read AGENTS.md completely and follow its governing-document order. Then read:
- docs/product/AGENT_BUILDER_AND_PILOT_PRICING.md
- docs/architecture/AGENT_OS_LAYERING.md
- docs/architecture/GRADIA_AGENT_ARCHITECTURE.md
- docs/architecture/AUTONOMY_APPROVAL_MODES.md
- docs/architecture/GRADIA_MEMORY.md
- docs/architecture/COMMERCIAL_CHECKOUT_ACTIVATION.md
- docs/handoffs/CLAUDE_AGENT_OS_INTERNALS_2026-11-03.md
- the merged definition compiler, reviewed-memory, Control Center, lifecycle,
  connector-readiness, evaluation and commercial activation code/migrations.

Before changing any Next.js file, read the relevant current guides under
node_modules/next/dist/docs. Prefer keeping this PR below the UI/route layer.

GOAL

Persist immutable Gradia Agent definition revisions with one atomic active pointer
per existing `custom_agents` identity. Return the exact tenant-safe DTO required by
the approved seven-step Cursor builder. Do not create a second agent/employee schema,
runtime, policy engine, memory store, executor or billing gate.

IDENTITY AND REVISION CONTRACT

- `custom_agents` remains the current agent identity/runtime spine. Definition
  revisions bind to `(shop_id, agent_id)` and cannot point across tenants.
- Every save creates an immutable revision. Never update/delete an old definition;
  corrections are a new revision with lineage.
- One mutable pointer may advance atomically to the active revision. Preserve an
  append-only activation/pointer event history.
- Lifecycle must distinguish draft, active, paused and blocked. Paused/blocked or
  missing active definitions cannot create new run claims.
- Do not silently backfill legacy mutable `custom_agents.config` as reviewed active
  truth. Existing agents may be reported as `legacy_unversioned` until explicitly
  converted/reviewed.

DEFINITION SHAPE

Use the existing `agentDefinitionDraftSchema` and compiler; do not invent another
definition vocabulary. Persist its bounded Job, Knowledge, Tools, Limits, Schedule
and Routing fields plus stable schema version, definition hash, lineage, author and
timestamps. Provider names, secrets, arbitrary prompts, raw tool schemas, shell/SQL
and client-selected tenant/evidence fields are forbidden.

AUTHORITY

- Server derives the shop and actor from the session. Browser input never chooses a
  shop, actor, policy version, knowledge revision, connector proof, evaluation proof
  or billing evidence.
- Owner may create revisions and is the only role that may activate, pause, block or
  supersede an active pointer in this PR. If a currently merged explicit delegated
  `agent.configure` capability exists, a manager may draft only within that exact
  grant; otherwise managers/staff are read-only and the limitation is documented.
- Revoked, inactive, anonymous and cross-shop callers are denied immediately.
- Browser roles have no direct table mutation access. Narrow SECURITY DEFINER
  commands recheck live authority and tenant ownership.

ACTIVATION

Activation must compile only server-loaded evidence for the exact immutable
revision and fail closed unless all are current and matching:

1. live owner authority;
2. exact definition revision/hash and supported schema;
3. currently active Control Center policy revision and allowed operation grants;
4. selected reviewed/published, unexpired, non-revoked memory revisions for this
   shop and permitted scope;
5. connector/tool readiness for every requested operation;
6. validated budgets/limits and the two-active-agent entitlement;
7. exact-revision evaluation/dry-run evidence with safety pass and required quality
   threshold;
8. reviewed active Founder Pilot subscription evidence.

Reuse the merged `commercial_agent_activate` transaction rather than duplicating its
catalog, owner, subscription and active-agent-limit authority. Compose activation so
the definition pointer cannot become active if the commercial activation fails, and
the legacy agent cannot become enabled if the pointer/evidence write fails. If the
existing function cannot provide that atomic composition safely, make the smallest
reviewed extension in a new migration and prove rollback in both directions. Do not
weaken the direct-enable trigger.

Stale policy, memory, connector, evaluation, definition hash, membership or billing
evidence blocks activation with a finite reason; it never silently refreshes or
guesses. Concurrent activations/revisions must serialize and never create two active
pointers or exceed two active agents.

EVALUATION EVIDENCE

Persist the smallest append-only exact-revision evaluation record needed for
activation: suite version, definition revision/hash, fixture/evidence identity,
pass rate, safety result, cost estimate/evidence, completed time and trusted source.
A client assertion cannot create passing evidence. Test execution itself is not in
scope unless an existing trusted evaluator already exposes the required result.

CURSOR DTO

Return a minimal serializable DTO for:
- `/agents`: identity, lifecycle, active revision, latest draft, last confirmed run,
  needs-review count and truthful legacy/unavailable states;
- builder resume: exact latest immutable revision and completion state for Job,
  Knowledge, Tools, Limits, Schedule, Test and Activate;
- detail/revision pages: definition, selected memory, effective tool/policy reasons,
  limits, schedule, evaluation and activation evidence;
- activation eligibility: finite blockers and exact source/evidence versions.

Reads fail as unavailable/forbidden, never empty or eligible. Do not build or restyle
the Cursor UI in this PR.

REQUIRED TESTS

- immutable revisions; lineage; atomic active pointer; append-only history;
- exact replay returns the same revision/result; changed replay conflicts;
- owner authority, manager/staff/revoked/anonymous/cross-shop denial;
- browser table/function mutation denial and owner/service append-only probes;
- stale/revoked/wrong-shop memory, policy, connector or evaluation refusal;
- definition-hash/revision mismatch and client-supplied proof refusal;
- missing/unknown read and legacy-unversioned states never become active;
- concurrent revision creation gets deterministic revision numbers;
- concurrent activation leaves one pointer and respects the two-agent cap;
- injected failure proves pointer and `custom_agents.enabled` roll back together;
- paused/blocked definitions cannot create new lifecycle claims;
- migration from zero and upgrade from current main without rewriting existing
  agents, runs, memory, policy, membership or commercial billing evidence.

NON-GOALS

No builder UI, no model-generated definition, no new executor, no provider/browser
call, no live send, no cron activation, no Stripe call/provisioning, no usage meters,
no shared database, no deployment and no production-gate change.

VALIDATION/HANDBACK

Run focused and full unit/type/lint/build validation, disposable integration tests
and a purpose-built real-SQL upgrade verifier. Append docs/AI_WORK_LOG.md, commit,
push and open one PR against current main. Stop without merging. Report exact
base/head, migrations, authority changes, DTO shape, commands/totals, concurrency
and rollback evidence, limitations and the next dependency for Cursor Build 2.
```

## Next

After this PR is reviewed and merged, Build 2 wires the seven-step `/agents/build`
and revision/detail UI to this DTO. The legacy mutable workflow builder remains gated.
