# Immutable Gradia Agent definition revisions (Build 1)

_2026-11-07. Server and database only: no builder UI, route, model call, provider call,
live send, cron activation, Stripe call, usage meter, shared database, deployment or
production-gate change. Cursor Build 2 wires the seven-step builder and the revision
pages to the DTOs below._

## What this adds

Immutable, tenant-bound definition revisions and **one atomic active pointer per existing
`custom_agents` identity**. It reuses, and does not duplicate:

| Concern | Reused authority |
| --- | --- |
| Agent identity / runtime spine | `custom_agents` (no second agent or employee table) |
| Definition vocabulary + compiler | `agentDefinitionDraftSchema`, `compileAgentDefinition` (`src/lib/agent-os/definition.ts`) |
| Policy | active Control Center policy (`control_policy_active/history`) via `evaluatePolicy` |
| Memory | reviewed-memory publication (`reviewed_memory_*`, PR #123) |
| Entitlement | `commercial_agent_activate` (catalog, owner, Founder Pilot evidence, two-active cap) |
| Runtime claims | `claim_scheduled_agent_run` (PR #122) |

Migration: `supabase/migrations/20261107120000_agent_definition_revisions.sql` (objects added;
two existing functions re-declared; two triggers added; **no existing row is rewritten or
backfilled**).

## Identity, revisions and lifecycle

- `agent_definition_state` — the **only mutable row**, one per agent: `lifecycle`
  (`draft | active | paused | blocked`), `active_revision`, `latest_revision`, `version`.
  `lifecycle = 'draft' ⇔ active_revision IS NULL`. Bound to `(shop_id, agent_id)` by a composite
  foreign key to `custom_agents(shop_id, id)`, so a definition can never point across tenants.
- `agent_definition_revisions` — **immutable**. Every save is a new revision (database-assigned,
  gapless per agent) with `parent_revision` lineage, `schema_version`, a database-computed
  `definition_hash` (`sha256` of the stored canonical JSON, which includes the revision number),
  author and timestamp. The stored document always has `lifecycle: "draft"`: activation is a
  pointer, never an edit. A corrected definition is a new revision.
- `agent_definition_memory_pins` — immutable. The exact reviewed memory revision (and its content
  hash) each selected source resolved to when the revision was saved. Only sources that are
  currently *published, valid, unexpired and non-revoked for this shop* can be selected.
- `agent_definition_evaluations` — append-only exact-revision evidence (below).
- `agent_definition_events` — append-only pointer/lifecycle history: `revision_created`,
  `activated`, `superseded`, `paused`, `blocked`. An `activated` event carries the evidence
  snapshot: definition hash and schema, policy revision, memory head, memory pins, ready
  operations, evaluation id/suite/pass rate, billing evidence id.

Saves are idempotent: the caller supplies a `request_id`. The same request id with identical
content returns the same revision (`replayed`); the same id with different content is a conflict
(`AD409`). A different request id with identical content is a new revision.

A revision's number and lifecycle are **never client input**; the input has no `revision` or
`lifecycle` key and is validated by the existing strict schema (no provider, secret, prompt, raw
tool schema, SQL/shell or client-selected tenant or evidence field is representable).

### Legacy agents

Existing agents have **no state row** and are reported `legacy_unversioned`. They are not
backfilled, not treated as reviewed truth, and their scheduled claims behave exactly as before. A
*disabled* legacy agent becomes governed when its owner saves its first revision. An *enabled*
legacy agent is refused (`legacy_agent_enabled`) until the owner turns it off, so the invariant
for every governed agent is **`enabled ⇔ lifecycle = 'active'`**.

## Authority

All commands are `SECURITY DEFINER`, **service-role only**, and name the actor. The database
re-verifies a **live, active owner of that exact shop** on every call (`42501` otherwise).
Anonymous, authenticated (browser), manager, staff, revoked, cross-shop and unknown callers are all
refused. Browser roles have no table privilege and no function privilege at all.

| Command | Purpose |
| --- | --- |
| `agent_definition_create_revision` | Save one immutable revision (owner) |
| `agent_definition_record_evaluation` | Append exact-revision evaluation evidence (trusted evaluator seam) |
| `agent_definition_activate` | Activate one exact revision, atomically with entitlement (owner) |
| `agent_definition_set_lifecycle` | Pause or block the active definition (owner) |
| `agent_definition_actor_role` | Live role of a named actor (server-side reads) |

**Managers and staff are read-only.** No merged explicit delegated `agent.configure` capability
exists (`TEAM_CAPABILITIES` has none), so managers may not draft. Adding one is a separate,
reviewed change. Managers and staff may read the DTOs (they are told `canEdit: false`).

Server actions (`src/app/actions/agent-definitions.ts`) derive the actor and shop from the
session. Arguments name only what the owner is looking at (agent, revision, the hash and pointer
they saw). Policy, knowledge, connector, evaluation and billing evidence are never arguments.

## Activation

`activateAgentDefinition` loads **server-side** evidence for the exact immutable revision,
compiles it through the existing `compileAgentDefinition`, then calls
`agent_definition_activate`. The database re-verifies, under the agent row lock:

1. live owner authority;
2. exact revision, **hash** and supported **schema**; the caller's view of the pointer
   (`pointer_changed` otherwise);
3. the still-current **active policy revision** the application evaluated (`policy_stale`);
4. every **memory pin** is still the active, published, unexpired, non-revoked revision with the
   same content hash (`memory_revoked | memory_changed | memory_stale | memory_expired`) and the
   memory head matches (`knowledge_stale`);
5. readiness of every requested operation (post-MVP tools are never activatable);
6. bounded limits;
7. the **newest** exact-revision evaluation: safety pass and pass rate ≥ 0.95;
8. then, **in the same transaction**, `commercial_agent_activate` (catalog, owner, reviewed
   Founder Pilot evidence, two-active-agent cap) performs the one enabling write, and only if that
   succeeds the pointer, history and evidence are written.

Any later failure rolls back the enabling write **and** the pointer; a commercial refusal never
moves the pointer (`billing_not_active`, `active_agent_limit_reached`, `catalog_mismatch`). When
billing evidence is missing the server-created Checkout is handed back exactly as the legacy path
does (`resolveBlockedActivation`, extracted from `authorizeAgentActivation`). Stale evidence blocks
with a finite reason; it is **never refreshed or guessed**. `commercial_agent_activate` itself is
unchanged.

Concurrency: every command takes the agent row `FOR UPDATE` first (then the billing account row via
`commercial_agent_activate`), so saves serialize per agent (deterministic gapless numbers),
activations of different agents serialize per shop on the billing account (never more than two
active) and two activations of one agent leave exactly one pointer.

### Keeping `enabled` and the pointer consistent

- `custom_agents_activation_guard` (from the commercial migration) is only **strengthened**: it
  keeps its refusal for everyone else and now also refuses turning a *governed* agent on by any
  role, including the service role, except inside `agent_definition_activate`. It became
  `SECURITY DEFINER` so it can see the state table. The legacy `setCustomAgentEnabled(true)` path
  returns a typed `definition_activation_required` for governed agents instead of a raw error.
- Turning a governed active agent **off** by any path (owner direct update included) pauses its
  pointer (`disabled_directly`, recorded). Disabling never needs billing and frees a slot.
- `agent_definition_set_lifecycle` pauses or blocks (and disables) the agent. Resuming is a fresh
  activation with fresh evidence; `blocked → paused` is refused.
- `claim_scheduled_agent_run` was re-declared with **one added check**: a governed agent whose
  lifecycle is not `active` (or has no pointer) returns `agent_unavailable` and creates no claim.
  Legacy agents (no state row) are unchanged.
- A governed agent that has history cannot be deleted from under it (the append-only history
  refuses the cascade unless the whole shop is being deleted). Archive via pause/block.

## Evaluation evidence

`agent_definition_evaluations` rows are bound to the exact revision **and hash** by a composite
foreign key. Fields: suite version, fixture-set id and hash, pass rate, safety result, estimated
credits and cost evidence, `completed_at`, and `source = 'trusted_evaluator'` (the only value the
table accepts). Replays by `(revision, evaluation_key)` are idempotent; a different payload under
the same key conflicts. `completed_at` cannot be in the future.

The only writer is `recordTrustedAgentEvaluation` (service role). It is deliberately **not** a
server action and nothing in the browser can reach it; `agent_definition_activate` never accepts
evaluation facts as input. **No trusted evaluator exists yet** (test execution is out of scope), so
in this PR only test fixtures write evidence and **no real revision can pass the evaluation gate
until the evaluator slice lands**. Failures stay in the record; the newest result wins.

## DTOs for Cursor (`src/lib/agent-os/definition-dto.ts`, `definition-store.ts`)

Every reader returns `DtoResult<T> = {status:'ok',data} | {status:'forbidden'} | {status:'unavailable',reason}`.
A failed or forbidden read is never an empty list and never eligible.

```ts
getAgentsHome(): AgentsHomeDto            // /agents
getAgentDetail(agentId): AgentDetailDto   // /agents/[agentId]
getBuilderResume(agentId): BuilderResumeDto
getAgentRevision(agentId, revision): RevisionDto   // /agents/[agentId]/revisions/[revision]
getActivationEligibility(agentId, revision): ActivationEligibilityDto

saveAgentDefinitionRevision({ agentId, requestId, definition, parentRevision? }): CreateRevisionResult
activateAgentDefinitionRevision({ agentId, revision, expectedHash, expectedPointer }): ActivateDefinitionResult
pauseOrBlockAgentDefinition({ agentId, lifecycle: 'paused'|'blocked', reason, expectedPointer }): LifecycleChangeResult
```

- **`AgentsHomeDto`**: `{ role, canManage, activeAgentCount, activeAgentLimit: 2, agents[] }`, each
  `{ agentId, name, governance: 'governed'|'legacy_unversioned', lifecycle: 'draft'|'active'|'paused'|'blocked'|'legacy_unversioned', enabled, activeRevision, latestRevision, hasUnactivatedDraft, lastConfirmedRun, needsReviewCount: number|null }`
  (`null` = could not be determined, never a silent 0).
- **`BuilderResumeDto`**: `{ agentId, name, governance, lifecycle, role, canEdit, editBlockedReason, latestRevision: { revision, definitionHash, createdAt, parentRevision, definition, memoryPins[] } | null, activeRevision, steps, eligibility }`.
  `steps` is `{ job, knowledge, tools, limits, schedule, test, activate }`, each
  `complete | incomplete | attention | blocked`.
- **`RevisionDto`**: the immutable definition plus `memoryPins[]` (source name, pinned revision, live
  `status`), `tools[]` (per-operation `effectiveMode`, `available`, finite `reasons` from the existing
  policy contract), `limits`, `schedule`, `evaluations[]`, `activation` evidence and `eligibility`.
  No memory body, provider name, secret or Stripe URL is ever included.
- **`ActivationEligibilityDto`**: `{ eligible, alreadyActive, blockers[], billingState, sources }`.
  `blockers` is the finite `ACTIVATION_BLOCKERS` vocabulary (a test keeps it covering every reason
  the SQL can emit). `sources` names the exact versions: definition hash and schema, policy
  revision, knowledge revision, memory pins, evaluation id, ready operations, active-agent count and
  limit, and the pointer the caller must echo back as `expectedPointer`.
- `activateAgentDefinitionRevision` returns `{ ok:true, outcome:'activated'|'already_active', revision }`
  or `{ ok:false, code, reasons[], billing }` (`billing` carries a Checkout URL only while one is open).

## Verification

- Unit: `eval/agent-definition-store.test.ts` (input schema, tool/policy decisions, eligibility,
  fail-closed readers, blocker-vocabulary lock), `eval/custom-agent-activation-billing.test.ts`
  (governed agents refuse the legacy path), `eval/tenant-scoping.test.ts` (reviewed importer).
- Integration (real Postgres, disposable stack): `eval/integration/agent-definition-revisions.int.test.ts`
  — immutability, lineage, replay/conflict, authority matrix, browser denial, stale/revoked/expired/
  wrong-shop memory, policy/knowledge/readiness/evaluation/hash/pointer refusal, rollback, concurrent
  saves/activations/cap, pause/block claims, direct enable/disable, DTOs.
- Upgrade verifier: `scripts/verify-agent-definition-migration.py` — real-SQL upgrade from current
  `main` in a rolled-back transaction, row-exact (content, `xmin`, `ctid`) proof that nothing existing
  was rewritten, ACLs, authority, append-only triggers, **injected-failure rollback in both
  directions**, cap, claims and tenant deletion.

## Limitations (deliberate, fail closed)

1. No trusted evaluator exists, so nothing real can pass the evaluation gate yet; fixtures only.
2. Founder Pilot evidence still cannot be produced in production before PR E (signed webhook), so
   real activation remains frozen exactly as documented in `COMMERCIAL_CHECKOUT_ACTIVATION.md`.
3. Managers/staff are read-only (no delegated `agent.configure` capability exists).
4. Governed claims are gated on lifecycle only. The runtime still executes the legacy
   `custom_agents.config` recipe shape; running the compiled definition is a later slice, and the
   run does not yet record the definition revision it ran under.
5. Legacy agents are not auto-converted, and an *enabled* legacy agent cannot be given a definition
   until it is turned off.
6. A governed agent with history cannot be deleted (pause or block it).
7. Connector readiness is the existing static readiness (no live provider call), so `ready` is never
   a delivery claim; tool availability is a description of what Gradia *may* do, not execution
   authority (the executor still calls the policy engine per command).
8. `supabase db reset` could not be run in the authoring environment; "from zero" evidence is the
   five post-baseline migrations applied in order to the `gradia-record-fresh` stack (itself built
   from zero) plus the same integration suite passing there.

## Next dependency for Cursor Build 2

Wire `/agents`, `/agents/build`, `/agents/[agentId]` and `/agents/[agentId]/revisions/[revision]` to
the actions above. The only prerequisites on the builder side are: create the stub `custom_agents`
row (`enabled=false`) before the first `saveAgentDefinitionRevision`, generate a UUID `requestId` per
save click (reuse it on retry), echo `definitionHash` and `sources.expectedPointer` back on activate,
and render `eligibility.blockers` / `steps` / `tools[].reasons` from codes rather than raw text. The
trusted evaluator (Test step) and PR E (billing evidence) remain upstream of a real activation.

## Review corrections (Codex review of PR #135)

- **Connector readiness is bound to exact evidence.** `agent_definition_connector_fingerprint(shop)`
  is a service-only, database-computed sha256 over the stored facts readiness derives from
  (number, A2P, BYO SMS, voice, calendar/email state, presence of encrypted credentials but
  never their values, and the Meta page-binding count). The application reads it before and
  after its readiness reads (a mismatch yields `connector_stale`, never a mixed snapshot),
  exposes it as `sources.connectorFingerprint`, and passes it to `agent_definition_activate`
  as `p_connector_fingerprint`. The activation transaction locks the shop row and Meta
  binding rows (`FOR SHARE`), recomputes the fingerprint and blocks with `connector_stale`
  on any difference. A NULL fingerprint is `22023`. The fingerprint is recorded in the
  `activated` event. Environment configuration is process-wide, not per-shop, and is not part
  of the fingerprint; time-based A2P freshness is evaluated at read time.
- **Agents home is complete or unavailable.** `lastConfirmedRun` is one exact query per agent
  (newest succeeded, fired run); a failed read makes the home `unavailable`. `needsReviewCount`
  keyset-pages every run that produced approvals, then checks which are still pending; an
  error or exceeding the page ceiling yields `null`, never `0`.

## Builder UI (Build 2)

`/agents`, `/agents/build`, `/agents/[agentId]` and `/agents/[agentId]/revisions/[revision]`
are server-loaded through the Build 1 actions only. Additions to the application seam (no
migration, no evaluator, no executor, no provider call):

- **`createGradiaAgentIdentity({ name })`**: session-derived shop and actor, live-owner check in the
  database, bounded display name (3–80, no control characters or angle brackets, whitespace collapsed),
  at most 50 identities per workspace. It creates only a `custom_agents` row with `enabled = false`.
  `custom_agents.config` is NOT NULL and the legacy cards read it, so the row carries an inert but
  schema-valid config with no recipe, no freeform plan and no schedule: the legacy runtime has nothing to
  execute, and a governed agent can only be enabled inside definition activation. No prompt, provider,
  credential or tool authority is stored. The builder then loads the exact agent by id.
- **`getSelectableMemory()`**: a read-only catalog of reviewed memory sources (id, name, revision,
  status). Only a current, published, unexpired, unrevoked source is `selectable`; candidates, revoked and
  expired sources are listed with their status but cannot be newly selected. Bodies, content hashes,
  safety fields and embeddings are never selected. Owner, manager and staff may read; other callers get
  `forbidden`; any read error is `unavailable`, never an empty catalog.
- **Stale-view saves are conflicts.** `saveAgentDefinitionRevision` accepts `expectedLatestRevision`
  (the latest revision the editor was looking at; `null` = none yet). A save from a stale view returns
  `conflict` and writes nothing, so a second tab cannot silently become the new latest. An already recorded
  request id replays (or conflicts when changed) first. Callers that omit the field keep Build 1 behavior.
  The comparison is atomic: migration `20261110120000_agent_definition_atomic_expected_latest.sql` adds
  `p_expected_latest` to `agent_definition_create_revision` and compares it under the same agent + state
  row locks that allocate the revision number (`stale_latest` blocked result, mapped to `conflict`). Two
  simultaneous saves from the same view therefore produce exactly one revision. The earlier application-side
  pre-read was removed.
- **`definition-schema.ts`** holds the strict definition vocabulary with no server-only imports so the
  builder validates against the same schema the server enforces. `definition.ts` re-exports it unchanged.

Honesty rules the UI enforces: forbidden and unavailable reads render their own states and are never an empty
list or an eligible result; the Test step states the runner is unavailable and never writes evidence;
activation echoes only the revision, its hash and the pointer the owner saw, and runs only from the
confirmation dialog; every `ACTIVATION_BLOCKERS` code has reviewed copy (source-locked) and an unknown code
renders as "could not be confirmed". Agent runs still execute the legacy `config` and do not record the active
definition revision; the UI says so where it matters.
