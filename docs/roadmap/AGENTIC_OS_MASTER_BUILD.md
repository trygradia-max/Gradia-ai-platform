# Gradia Agentic OS — master build and pilot plan

_Authoritative execution map as of 2026-10-27. This is a build and release plan,
not a claim that every layer is live. Update this file whenever a gate changes._

## The product we are building

Gradia is an operating system for dependable digital employees in service
businesses. A business owner configures a job, approved knowledge, allowed tools,
limits, schedule, stop conditions and review rules. Gradia then proposes or carries
out bounded work, preserves durable state, and shows evidence of what happened.

Gradia is the public agent identity. Claude, OpenAI or another model is replaceable
reasoning infrastructure, not the product identity and never the authorization
boundary. Model text can propose work; it cannot grant itself tools, publish memory,
approve a changed plan, supply credentials or prove that an external action finished.

The first pilot does **not** require arbitrary self-directed agents. It requires one
coherent, inspectable Gradia employee that can reliably handle a narrow set of jobs
with human review and truthful failure states.

## Current truth

### Integrated on `main`

- PR #116: the combined private integration candidate, including the reviewed
  telephony/reconciliation foundation, operations queue read model and selected
  Cursor UX changes. Merged as `4f13093`.
- PR #111: its complete operations-foundation tree was byte-identical to the copy
  integrated by #116, so the superseded PR was closed as incorporated rather than
  creating a misleading second merge.
- PR #118: the first common Agent OS definition/compiler and the reference-video
  layering contract. Merged as `205a853`.
- PR #117: active Control Center policy now gates owner SMS quick replies before
  Twilio. Merged as `e9b008d` after rebase and full GitHub CI.
- Control Center policy, approvals, consent/proof boundaries, tenant isolation,
  operations projection and several domain-specific workflows already exist.

### Latest runtime closure

- PR #117: owner SMS quick replies are evaluated against the active Control Center
  policy before Twilio. It was rebased on the result of #116 and #118. The
  owner keeps a direct-send workflow; denial never creates a second approval or
  reaches the provider. This is a narrow runtime-policy closure, not complete
  coverage of email, voice, alerts, cron or every direct write.

### Defined but not yet fully wired

- The Agent OS definition compiler validates job, reviewed knowledge references,
  Control Center operation grants, schedule, limits, lifecycle, exact-revision
  evaluation evidence, and tenant/revision-scoped trace/cache identity.
- The operations queue and daily brief have a tenant-authorized server read contract.
  No production UI currently consumes the complete contract.
- Existing workflows, pending actions, proofs and agent-run records provide useful
  durable pieces, but there is not yet one restart-safe run/step/attempt lifecycle.
- Retrieval and memory features exist, but reviewed publication, provenance,
  conflict handling and revocation are not yet one enforced memory boundary.
- Multiple model call sites exist, but there is no single normalized model adapter,
  router, semantic cache and provider-boundary classifier used by every employee.

### Explicitly not complete

- Arbitrary autonomous execution, universal browser control or an unrestricted
  “super agent.”
- Persisted immutable employee-definition revisions with one atomic active revision.
- Restart-safe claims, cancellation and reconciliation for every external attempt.
- Reviewed memory publication with source, author, revision, validity and deletion
  propagation.
- The complete Cursor builder and operations/exception-desk UI.
- Signed-in hosted acceptance for the integrated private candidate.
- Public launch, shared-database write unfreeze, live provider/cron activation or
  broad customer sending.

## Reference-video layering translated for Gradia

| Reference layer | Gradia implementation | Remaining release work |
| --- | --- | --- |
| Model/API wrapper | Gradia-owned provider adapter returning structured proposals | Normalize all employee calls; cancellation, latency/cost accounting, no blind provider fallback |
| Identity/persona | System-owned Gradia identity plus owner-configured job | Persist immutable revisions; never expose a raw system-prompt or provider-identity editor |
| RAG/company context | Reviewed shop knowledge and customer context | Publication workflow, provenance, validity windows, conflicts, deletion/revocation propagation |
| Tools/actions | Existing CRM, inbox, booking, quote, messaging and approval operations | Map every grant to Control Center; close unmapped direct-write/cron/alert paths |
| OAuth/RBAC | Server-derived membership, connector ownership and explicit grants | Prove revocation and cross-shop denial at every new runtime entry point |
| Guardrails | Consent, readiness, policy, approval, proof and definition compiler | Deterministic input classification, prompt-injection boundary and PII redaction at provider edges |
| Cache/router | Definition emits scoped routing and cache identities | Implement storage/router; invalidate on tenant, role, policy, definition or knowledge revision change |
| Traces/evals | Revision-bound activation evidence and existing audit records | Durable run/step/tool traces, eval UI, release gates and source-linked outcomes |
| Identity check | Gradia remains the public identity | Test that employees do not volunteer or impersonate underlying providers |

## Target architecture

### Control plane

The control plane owns immutable employee-definition revisions. A revision contains:

1. Job: role, goal, outcomes and stop conditions.
2. Knowledge: only reviewed, tenant-scoped source revisions.
3. Tools: explicit Control Center operations, never arbitrary generated tools.
4. Limits: steps, runtime, concurrency, daily runs and credits.
5. Schedule: manual, event or bounded interval.
6. Evaluation: safety and quality evidence for that exact revision.
7. Lifecycle: draft, active, paused or blocked, with one atomic active revision.

Activation is a server-side transaction. It fails closed if identity, policy,
knowledge, connector readiness, grants or evaluation evidence is missing or stale.

### Execution plane

Extend the existing runtime instead of adding a competing generic task engine:

`trigger → run → step → proposal → authorized command → attempt → evidence → outcome`

Every external command needs a stable command ID and durable attempt. Claims use
compare-and-set semantics and expire only into an **unknown/reconcile** state; claim
expiry is never proof that the provider stopped. Restart resumes persisted work.
Cancellation prevents new work and records whether in-flight provider work could
actually be stopped. Retries are idempotent and policy is rechecked at execution.

### Knowledge plane

Raw websites, documents, messages and tool output are untrusted inputs. They may
create review candidates, not instructions or published facts. A published fact
must carry business, source, author, revision, review state, validity and retention.
Conflicts block dependent activation or work until reviewed. Revocation and deletion
must invalidate retrieval, cache entries and future employee revisions.

### Operations plane

The owner sees one factual work surface:

- Needs review: a human decision is required.
- Waiting: a customer, time window, connector or dependency is pending.
- Unconfirmed: a provider accepted work but completion is not proven.
- Blocked: policy, consent, readiness, budget or stale evidence prevents work.
- Complete: backed by source evidence, not model narration.

A load failure must never look like an empty queue. Partial coverage and observation
time stay visible. Uncertain sends do not receive an unsafe generic retry button.

## Engineering critical path

Work in this order. Later stages cannot be used to hide a missing earlier boundary.

### Gate 0 — integrated baseline

- [x] Merge combined candidate #116.
- [x] Reconcile superseded operations PR #111.
- [x] Rebase, review and merge Agent OS contract #118.
- [x] Rebase, review and merge SMS policy closure #117.
- [ ] Run signed-in hosted acceptance on the resulting private candidate.
- [ ] Reverify migration ledger, upgrade path, freeze guards and tenant isolation on
  the exact release commit.

### Gate 1 — durable definition and execution lifecycle

- [ ] Persist immutable employee-definition revisions and atomic active revision.
- [ ] Compile a saved revision into the existing Control Center operation envelope.
- [ ] Add/normalize durable run, step and attempt records around existing workflows,
  pending actions, provider proofs and agent runs; do not create a second executor.
- [ ] Implement restart-safe claims, leases, heartbeats and compare-and-set state
  transitions with concurrent-worker tests.
- [ ] Implement pause/cancel/kill semantics and distinguish requested cancellation
  from confirmed provider cancellation.
- [ ] Persist wait reason, due time, owner, escalation and reconciliation links.
- [ ] Recheck current policy, consent, connector readiness, approval revision,
  budgets and grants immediately before each consequential operation.
- [ ] Prove restart recovery, idempotent retry, unknown provider outcome, revocation,
  cross-shop denial and concurrent transition behavior in disposable integration.

Acceptance: a worker can stop mid-run, restart, and continue or reconcile without
duplicating an external action or declaring an unknown action complete.

### Gate 2 — reviewed memory

- [ ] Define candidate, reviewed, published, conflicted, revoked and deleted states.
- [ ] Store source, author/reviewer, tenant, revision, validity, retention and
  supersession metadata for every fact.
- [ ] Add an owner review queue and evidence preview before publication.
- [ ] Prevent model/tool/web content from changing system instructions or publishing
  itself as memory.
- [ ] Bind retrieval to explicit employee knowledge grants and exact revisions.
- [ ] Propagate conflicts, revocation and deletion into retrieval and cache invalidation.
- [ ] Add prompt-injection classification and PII minimization/redaction at every
  provider boundary.
- [ ] Test malicious documents, conflicting sources, stale facts, revoked access,
  deletion and cross-business isolation.

Acceptance: an employee can cite exactly which reviewed fact revision influenced a
proposal, and removal of that fact prevents future retrieval and invalidates caches.

### Gate 3 — common model, routing, cache and trace layer

- [ ] One structured model adapter for employee planning/proposals.
- [ ] Bounded iterations, cancellation, timeouts, cost/latency accounting and clear
  provider-error states.
- [ ] System-selected routing strategy; no automatic cross-provider fallback for a
  consequential attempt with an unknown outcome.
- [ ] Tenant/definition/policy/knowledge/role-scoped semantic cache.
- [ ] Durable model, retrieval, policy, tool-attempt and evidence traces with PII-safe
  observability.
- [ ] Offline evaluation suite and exact-revision activation/release gate.

Acceptance: the underlying model can be replaced without changing authority,
identity, lifecycle, evidence or user-visible completion semantics.

### Gate 4 — Cursor configuration and operations UI

- [ ] Builder: **Job → Knowledge → Tools → Limits → Schedule → Test → Activate**.
- [ ] Never expose raw credentials or an unrestricted system prompt.
- [ ] Show the effective operation grant and why each capability is available or
  blocked; activation stays disabled until every server-derived gate passes.
- [ ] Preview/dry run uses fixtures or read-only evidence and cannot silently mutate.
- [ ] Add draft/active/paused/blocked states, revision history, pause and kill actions.
- [ ] Wire the existing authorized `OperationsOverview` DTO to queue, daily brief and
  exception desk views.
- [ ] Render unavailable, empty and partial states distinctly; preserve observed time
  and source links.
- [ ] Show needs-review, waiting, unconfirmed, blocked and completed work distinctly.
- [ ] Preserve keyboard access, accessible names, reduced motion, mobile layout and
  200% zoom; record real signed-in browser evidence.

Acceptance: an owner can configure, test, activate, inspect, pause and stop a bounded
employee without seeing model/provider internals or receiving invented outcomes.

### Gate 5 — first pilot playbooks

Ship a narrow template set, in order:

1. Missed-lead follow-up with approval-first outreach.
2. Appointment coordination with conflict and confirmation evidence.
3. Google Business Profile review/draft assistance; publishing remains separately
   permissioned.
4. Grant research with cited eligibility and deadlines; applications and spending
   remain human-controlled.

Each playbook is versioned and has trigger, steps, waits, stop rules, budgets,
dry-run evidence, idempotency, consent/opt-out and escalation behavior.

Acceptance: each pilot account has an explicit allowed template/configuration and a
human fallback. “Any digital employee” remains an extensibility promise, not an
unrestricted production permission.

## Work lanes

### Claude Code — deep runtime and memory internals

1. Gate 1 persistence/lifecycle as small reviewable PRs.
2. Gate 2 reviewed-memory schema, publication and provenance.
3. Gate 3 normalized provider adapter, classifier, router/cache and durable traces.
4. Disposable integration evidence for restart, concurrency, isolation, revocation,
   injection, deletion and unknown outcomes.

Constraints: extend the existing executor and records; no shared-database changes,
live providers, deploy, merge or activation without explicit authorization. Every
handoff includes exact commits, migration versions, commands/results and limitations.

### Cursor — configuration and operations experience

1. Consume the server-derived builder DTO; do not invent a second agent schema.
2. Build the seven-step builder and gated activation states.
3. Wire the existing operations overview into queue, daily brief and exception desk.
4. Complete signed-in browser acceptance across permission, error, mobile, keyboard,
   reduced-motion and zoom cases.

Constraints: no fake counts, optimistic completion, credential fields, backend
executor, client-chosen shop authority or generic retry for uncertain sends.

### Codex — contracts, integration and release evidence

1. Own definition/control-plane contracts and reconcile the PR stack.
2. Review database/runtime/UI seams so there is one authority model and one executor.
3. Keep this file current with merged commits, test evidence and open gates.
4. Run final-tree unit, integration, type, lint, build, migration and hosted acceptance.
5. Prepare a private candidate; public promotion remains a founder decision.

## Founder-only checklist

These cannot be completed by code alone and should not be silently inferred:

### Pilot offer and accounts

- [ ] Choose the first 3–5 pilot businesses and a named owner/operator at each.
- [ ] Select exactly which first playbook each account receives.
- [ ] Agree success measures: response time, reviewed/completed work, booking outcomes,
  unresolved events and weekly operator feedback—not invented “time saved.”
- [ ] Decide pilot duration, price/free terms, included seats/usage and overage policy.
- [ ] Approve support/escalation hours and who handles a blocked or uncertain action.

### Legal, consent and trust

- [ ] Approve Terms, Privacy Policy, DPA/subprocessor list, retention/deletion policy
  and AI/customer-data disclosures for pilots.
- [ ] Confirm SMS/email consent language, STOP/help handling, quiet hours and outreach
  purposes with counsel for the target jurisdictions.
- [ ] Complete Twilio A2P registration and Meta/Google/provider app review where used.
- [ ] Approve pilot-facing explanation of Gradia identity, human review and limitations.

### Providers and operations

- [ ] Select/approve model and transactional-email providers plus spending ceilings.
- [ ] Supply production credentials through the approved secret path; never in chat,
  source, fixtures or the employee builder.
- [ ] Decide per-provider rollout account, number/domain, sender identity and fallback.
- [ ] Authorize, separately and explicitly: production migrations, shared writes,
  provider credentials, crons, live sends and public traffic.
- [ ] Name the incident owner and define the pause/kill and customer-notification path.

### Release acceptance

- [ ] Personally accept the signed-in private candidate for owner and manager roles.
- [ ] Review the exact pilot configurations, grants, budgets and stop conditions.
- [ ] Approve the release evidence packet and known limitations.
- [ ] Give a written go/no-go for each pilot account; no global unfreeze is required.

## Pilot go-to-market gate

Gradia is ready for **controlled pilot accounts** when all of the following are true:

- Gate 0 is complete on one exact release commit.
- At least the lifecycle portions required by the chosen playbook pass Gate 1.
- Every fact used by that playbook comes from Gate 2 reviewed memory or an explicitly
  read-only, source-linked runtime lookup.
- The relevant builder/operations surfaces in Gate 4 have signed-in acceptance.
- One playbook passes its end-to-end evidence matrix with providers mocked, then with
  an explicitly authorized test account.
- Founder legal/provider/pilot decisions above are complete for that account.
- The account has bounded grants/budgets, human fallback, monitoring and a kill switch.

This means the product is close to a **private, narrow pilot** but not ready for a
broad public “autonomous OS” launch. The shortest honest path is one lifecycle-safe,
reviewed-memory-backed playbook for a handful of accounts—not finishing every future
agent capability first.

## Definition of Agentic OS complete

The platform may call the system a production Agentic OS only when an owner can:

1. Configure a bounded Gradia employee without editing hidden authority or credentials.
2. Activate an exact evaluated revision using reviewed knowledge and explicit tools.
3. Observe durable progress and restart recovery across every run and external attempt.
4. Distinguish proposed, waiting, blocked, unconfirmed and evidence-complete work.
5. Inspect why a decision happened and which source/policy/revision authorized it.
6. Revoke knowledge, grants or the employee and see that change enforced immediately.
7. Pause or kill future work without the UI pretending in-flight provider work stopped.
8. Replace the underlying model without changing the safety, identity or evidence model.

Until then, describe the implemented pieces precisely: control plane, operations
foundation, bounded employee pilot, or Agentic OS in development.
