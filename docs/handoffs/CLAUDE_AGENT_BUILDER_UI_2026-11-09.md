# Claude handoff — Gradia Agent builder and configuration UI (Build 2)

## Copy-paste prompt

```text
Implement Build 2 only in this worktree:

/Users/harryhatch/Gradia/worktrees/claude-agent-builder-ui

Branch: claude/agent-builder-ui
Base: current origin/main at or after 96965a9 (merged PR #135)

Read AGENTS.md completely and follow its governing-document order. Then read:
- docs/product/AGENT_BUILDER_AND_PILOT_PRICING.md
- docs/architecture/AGENT_DEFINITION_REVISIONS.md
- docs/architecture/AGENT_OS_LAYERING.md
- docs/architecture/GRADIA_AGENT_ARCHITECTURE.md
- docs/architecture/AUTONOMY_APPROVAL_MODES.md
- docs/architecture/GRADIA_MEMORY.md
- docs/architecture/COMMERCIAL_CHECKOUT_ACTIVATION.md
- docs/handoffs/CLAUDE_AGENT_DEFINITIONS_2026-11-07.md
- current /agents, /receptionist, builder, design-system and navigation code.

Before changing any Next.js file, read the relevant current guides in
node_modules/next/dist/docs, especially layouts/pages, Server and Client Components,
mutations, errors, loading, dynamic routes and accessibility. In this Next version,
route params and search params are promises. Do not rely on remembered Next APIs.

GOAL

Replace the legacy /agents wrappers with the complete, production-quality Gradia
Agent OS home and seven-step definition builder, wired only to the merged Build 1
actions/DTOs. Build the missing detail and immutable revision pages. Reuse the
existing Gradia design system and useful Cursor polish; do not introduce a competing
agent schema, planner, runtime, policy engine, memory store, billing gate or visual
system.

This is an application/UI PR. It may add the smallest session-derived action needed
to create a disabled custom_agents identity before its first definition revision.
It must not add a migration, evaluator, executor, provider/model call, cron, live
send, shared-data write, deployment or production-gate change.

CURRENT TRUTH

- /agents currently imports the receptionist page. Replace that alias.
- /agents/build currently imports the legacy free-form workflow builder. Replace
  that alias. Do not delete the legacy receptionist/playbook routes unless an exact
  usage audit proves they are unused.
- Build 1 is authoritative: src/app/actions/agent-definitions.ts,
  src/lib/agent-os/definition-dto.ts, definition-store.ts and definition.ts.
- Every read is ok | forbidden | unavailable. Forbidden/unavailable must never be
  rendered as an empty agent list, zero blockers or activation eligibility.
- Every definition save is an immutable revision. There is no mutable draft row.
- A real trusted evaluator does not exist. The Test step must state that evaluation
  is unavailable and activation remains blocked; never synthesize passing evidence.
- The runtime still executes legacy custom_agents.config and does not record the
  active definition revision. Do not claim that an activated definition is already
  the revision-bound durable runtime; show this limitation where operationally
  relevant. Billing/evaluation gates currently keep real activation frozen.

ROUTES

1. /agents — Agent OS home
   - Server-load getAgentsHome(); never fetch tenant data from a client effect.
   - Header: Gradia Agents, concise one-Agent-OS explanation, Create Gradia agent.
   - Show active-agent entitlement truth (active count / limit) without presenting
     the planned Core/Growth/Scale tiers as purchasable.
   - Each agent shows name, governed vs legacy, lifecycle, exact active/latest
     revision, newer draft signal, last confirmed run and needs-review count.
   - A null needsReviewCount is Unavailable, not zero. A null lastConfirmedRun means
     no confirmed run only when the enclosing home read succeeded.
   - Cards link to /agents/[agentId]; revision links are explicit.
   - Honest empty, forbidden and unavailable states with a retry/navigation path.
   - Managers/staff can view but cannot see enabled edit/activation controls.

2. /agents/build — resumable seven-step builder
   - Use search params such as ?agent=<uuid>&step=<key>; validate them. New builder
     starts with a bounded identity/name action, then redirects to the exact agent.
   - If a new identity action is required, it must derive actor/shop from session,
     require a live owner, create only custom_agents(enabled=false), validate a
     bounded display name, store no prompt/provider/credential authority and return
     a typed result. A safe empty legacy config is acceptable only because the row
     stays disabled; document it. Do not use saveCustomAgent or the model planner.
   - Seed a complete conservative definition in UI state after identity creation so
     the existing strict schema remains the sole definition vocabulary: no knowledge,
     no tools, manual schedule, maximumConcurrentRuns=1, bounded low limits,
     cost-aware routing. Job fields must still require meaningful owner input.
   - Load getBuilderResume(agentId) on every entry/refresh. Resume the exact latest
     immutable revision; never reconstruct from legacy config or browser storage.
   - Seven steps, in order: Job, Knowledge, Tools, Limits, Schedule, Test, Activate.
   - Desktop step rail and mobile compact progress must both be keyboard accessible.
   - Users may navigate back without losing current local edits. Warn before leaving
     unsaved changes; do not invent autosave.

SAVE/REPLAY CONTRACT

- Save & Continue sends the complete definition through
  saveAgentDefinitionRevision, with parentRevision equal to the exact latest revision.
- Generate one UUID requestId for a save click and reuse it only for an unchanged
  retry. If any field changes after a failed request, generate a new requestId so a
  changed replay never conflicts with the old key.
- On success, use the server-returned revision/hash and refresh from
  getBuilderResume; do not optimistically invent a revision number.
- Show created vs replayed truthfully. Conflicts/pointer changes offer Reload latest;
  never overwrite another tab silently.
- Owner-only editing. Manager/staff and revoked/forbidden sessions are read-only or
  refused according to the DTO; hiding a button is not authorization.

STEP CONTRACTS

Job
- Role label, one clear goal, 1–8 measurable expected outcomes and 1–12 explicit
  stop conditions. Provide bounded add/remove controls, inline validation and useful
  detailing-shop examples. Do not expose a raw system prompt.

Knowledge
- Render only the selected reviewed/published memory pins returned by the DTO.
- The existing Build 1 action does not expose a complete selectable-source catalog.
  Audit for an existing tenant-safe reviewed-memory catalog reader and reuse it if
  exact; otherwise add the smallest read-only, session-derived DTO/action over the
  existing reviewed-memory tables. It must return IDs/names/revision/status only,
  never bodies, cross-shop data, candidates, revoked content or raw embeddings.
- Candidate, stale, expired, changed or revoked memory cannot be selected as current.
- includeShopKnowledge/includeCustomerMemory and maxResultsPerQuery use plain copy;
  they are context choices, never consent or permission grants.

Tools
- Use the existing Control Center operation catalog. Do not expose raw tool schemas,
  model tools, credentials or arbitrary operation strings.
- For saved revisions render RevisionDto.tools effective mode, availability and
  finite reasons. For an unsaved edit, label requested maximum separately from
  server-confirmed effective policy; do not claim availability until saved/reloaded.
- Link blocked policy/connectors to the existing Control Center/settings surface.
- Post-MVP tools remain visibly unavailable, not silently omitted if already saved.

Limits
- Use the exact schema bounds for steps/run, runtime, credits/run, runs/day and
  concurrency=1. Explain that budgets cap attempts and do not guarantee outcomes.
- Do not add pricing fields, seat counts or overage controls to the definition.

Schedule
- Manual, approved event, or interval 15 minutes–7 days. Use owner language and
  show the exact event vocabulary. A schedule does not bypass readiness, consent,
  approval or production holds.

Test
- Render existing exact-revision evaluations if present.
- With no trusted evaluator, show Test runner not available yet and an explicit
  evaluation_required blocker. Do not call a model, send, book, mutate CRM, write
  evaluation evidence or mark the step complete from client state.
- Structure this screen so a later trusted test runner can add cited inputs,
  proposals, unconfirmed outcomes and cost estimates without replacing the page.

Activate
- Always refresh getActivationEligibility for the exact latest revision.
- Map every ACTIVATION_BLOCKERS code to reviewed, plain-language copy and a safe next
  action. Add a source lock test so a new backend code cannot render as success or
  disappear; unknown codes fail closed as evidence unavailable.
- Echo only revision, definitionHash and sources.expectedPointer to
  activateAgentDefinitionRevision. Policy, memory, connector, evaluation and billing
  evidence remain server-derived.
- Owner-only activation, explicit confirmation. Never call activation on page load.
- If the server returns a Checkout handoff, label it as secure Founder Pilot checkout
  and use only the returned server URL. Do not create Stripe objects or client-side
  prices. Show checkout/pending/reconciliation states truthfully.
- Success refreshes all DTOs and links to the detail page. Failure never shows active.

3. /agents/[agentId] — agent detail
   - Await and validate params; server-load getAgentDetail.
   - Overview: lifecycle/reason, active definition, latest draft, role/governance,
     memory, effective tools, limits, schedule, evaluation and activation evidence.
   - Revision history links to immutable revision pages. Clearly label active vs
     superseded/draft.
   - Owner pause/block actions use pauseOrBlockAgentDefinition with a required bounded
     reason, exact expected pointer and confirmation. No resume shortcut: resume is
     fresh activation with fresh evidence.
   - Governed agents are not deletable. Legacy agents show honest conversion guidance;
     an enabled legacy agent must be turned off before its first governed revision.
   - Run history may link to the existing run sheet/path, but do not invent run state
     or silently use the old Agent card DTO as definition truth.

4. /agents/[agentId]/revisions/[revision] — immutable revision
   - Await/validate both params; server-load getAgentRevision.
   - Read-only exact definition, parent, hash (short display + accessible full value),
     author/time, memory pins, tool decisions/reasons, limits, schedule, evaluations,
     activation evidence and eligibility blockers.
   - No edit controls. Offer Create new revision / Continue in builder for owners,
     based on latest server state rather than mutating this revision.

VISUAL/USABILITY CONTRACT

- Reuse existing Gradia tokens, SectionHeader, StatusPill, Button, Card, form controls,
  motion primitives and established dashboard width/spacing. No new brand system,
  giant marketing hero, glassmorphism or novelty animation.
- Cursor branches may be inspected for small component/copy/a11y improvements, but
  do not cherry-pick the experimental Super Agent schema, planner, fake data or
  alternate architecture. Reconcile useful polish by hand against current main.
- Responsive at 320px through desktop. Primary actions remain reachable without
  horizontal scroll. Dialogs/sheets trap focus and restore it. Labels, descriptions,
  errors and status are announced; color is never the sole signal.
- Loading skeletons match final layouts. Expected forbidden/unavailable/not-found
  states render intentionally; unexpected errors use route error boundaries.
- No hydration-dependent tenant truth, fake counts, fake tests, optimistic Active
  badges or raw database/provider error strings.

TESTS/ACCEPTANCE

- Unit/component/source-lock tests for all blocker-copy mappings, lifecycle labels,
  step status, requestId retry/change behavior, schema-bound form conversion and
  read-only role behavior.
- Server/action tests: identity creation owner-only and tenant-bound; invalid/cross-
  tenant IDs; unavailable/forbidden reads never look empty; no client-selected shop.
- Route tests for promise params/searchParams, malformed IDs/revisions and legacy,
  draft, active, paused, blocked, unavailable, manager/staff and empty states.
- Interaction tests: create identity -> save revision -> resume refresh; changed replay
  conflict; stale pointer reload; pause/block confirmation; activation blocker list;
  Checkout handoff; no activation on render; no Test side effect.
- Accessibility: keyboard-only step navigation, visible focus, semantic headings,
  form labels/errors, dialog focus and reduced motion.
- Run focused tests, full unit suite, typecheck, full lint, both supported production
  builds and relevant integration suites. Browser-test the signed-in desktop and
  mobile layouts with disposable/local fixtures if the environment permits. Do not
  use production or shared Supabase.

NON-GOALS

No trusted evaluator implementation, model-generated definition, legacy config
compiler, durable runtime binding, new execution path, provider call, live send,
cron, migration, policy change, memory publication, billing catalog change, Stripe
provisioning, production/shared-data change, deployment or production unfreeze.

HANDBACK

Append docs/AI_WORK_LOG.md. Commit, push and open one PR against current main. Stop
without merging or deploying. Report exact base/head, routes/components/actions,
whether any read-only memory catalog seam was needed, tests/totals, browser evidence,
known limitations and the next dependency (trusted evaluator + lifecycle/runtime
binding, not another UI rewrite).
```

## Review order after Claude opens the PR

1. Server-derived identity creation and tenant/role refusal.
2. Immutable save/replay and refresh behavior.
3. Test/activation honesty and complete blocker mapping.
4. Route states, responsive layout and accessibility.
5. Focused/full validation, then merge if clean.
