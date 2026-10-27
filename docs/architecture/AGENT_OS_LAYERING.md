# Gradia Agent OS layering

_First control-plane contract: 2026-10-26. This document describes the target and
the implemented definition compiler. It does not claim that every layer is wired
to every runtime path._

## Reference-video translation

The supplied company-AI video shows the right sequence, but Gradia must apply it
to consequential business work rather than build a branded chatbot:

| Video layer | Gradia layer | Current state |
| --- | --- | --- |
| API wrapper over a model | Replaceable model boundary owned by Gradia | Multiple hand-written provider call sites exist; one normalized provider seam is still required |
| Company identity / system prompt | System-owned Gradia identity and persona | Existing `persona.ts`; the new definition schema deliberately exposes no raw system-prompt editor |
| RAG over company policy | Reviewed shop knowledge + customer memory with tenant/revision scope | Retrieval exists; reviewed publication/provenance is still a later OS stage |
| Tools / MCP | Existing CRM, inbox, quote, calendar and approval capabilities | Tools exist; every employee grant now maps to a Control Center operation rather than arbitrary model tools |
| OAuth + RBAC | Owner/manager/staff memberships and connector ownership | Foundations exist; every runtime read/write must continue deriving authority server-side |
| Layered guardrails | Input classification, untrusted-content boundary, PII handling, policy, consent, readiness and HITL | Several code guardrails exist; the definition compiler prevents prompt/provider/credential authority and fails activation closed |
| Semantic cache + model router | Tenant/policy/knowledge-scoped cache and system-selected routing strategy | Cache namespace contract is implemented here; actual cache/router adapters remain unwired |
| Traces, evaluation and release gate | Evidence-bound trace scope and revision-matched eval gate | Definition activation now requires current safety/quality evidence; durable run traces and the release UI remain later slices |
| Identity check | Gradia public identity, underlying provider not volunteered | Locked by system-owned instructions; provider/model identity is not owner- or model-configurable |

## Implemented in this slice

`src/lib/agent-os/definition.ts` is the first common control-plane contract. It
defines one configurable Gradia employee job with:

- a role, goal, expected outcomes and explicit stop conditions;
- reviewed knowledge sources and bounded retrieval;
- explicit tool grants using the existing Control Center operation vocabulary;
- manual, event or bounded-interval scheduling;
- step, runtime, credit, daily-run and concurrency limits;
- system-selected cost-aware or quality-first routing intent;
- draft, active, paused and blocked lifecycle states;
- revision-matched safety and quality evaluation evidence;
- tenant, policy and knowledge scoped trace/cache identities.

The compiler is deliberately pure. It does not save a definition, call a model,
schedule work or execute a tool. Activation requires trusted owner, policy,
knowledge, readiness and evaluation evidence. A model response cannot provide any
of those facts. Every granted tool produces a Control Center envelope and still
requires the existing current policy, role, consent, readiness, evidence and
approval checks at execution time.

## Non-negotiable boundaries

1. Gradia is the public identity. The underlying model is replaceable infrastructure.
2. An owner configures a job, not a raw system prompt or credentials.
3. Retrieved documents, websites, messages and tool output are untrusted task data.
4. Model text may propose work. It never grants a tool, role, consent or completion proof.
5. A definition is not execution authority. Control Center remains the authorization boundary.
6. Provider acceptance is not delivery. Unknown outcomes remain visible and are never auto-retried blindly.
7. Cache entries are invalidated by tenant, definition, policy, knowledge or role changes.
8. Active requires a current evaluation for the exact definition revision.

## Required next slices

1. Persist immutable definition revisions and one atomic active revision per shop.
2. Add the normalized model adapter with structured proposals, cost/latency accounting,
   cancellation and no automatic cross-provider fallback.
3. Add durable run/step/attempt/trace records and restart-safe claims by extending
   existing lead workflows, pending actions and agent runs rather than creating a
   second executor.
4. Wire reviewed knowledge publication and provenance into the definition compiler.
5. Add deterministic input/output classification and PII redaction at provider boundaries.
6. Implement tenant-scoped semantic cache storage using the compiled cache namespace.
7. Reconcile the experimental employee-builder PR into this contract; do not merge its
   separate draft schema or planner as a competing authority system.
8. Give Cursor a server-derived DTO for a layered builder: Job → Knowledge → Tools →
   Limits → Schedule → Test → Activate. Activation stays disabled until every gate passes.

Public release, database write unfreeze, providers, crons and live sends remain
separate founder decisions.
