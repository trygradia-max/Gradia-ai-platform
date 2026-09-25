> **READ FIRST: the five September 11, 2026 governing documents.** They are the founder-approved source of truth for the sellable MVP. Where an older plan conflicts, they win. Do not pick the next feature from `CONTEXT.md`'s build list.

Reading order:

1. `docs/product/GRADIA_MVP_VISION.md` — product, pilot versus full-channel MVP, surfaces.
2. `docs/roadmap/MVP_IMPLEMENTATION_SEQUENCE.md` — dependency order, release gates, what is actually verified.
3. `docs/architecture/GRADIA_AGENT_ARCHITECTURE.md` — monolith, intake, commands, one executor.
4. `docs/architecture/AUTONOMY_APPROVAL_MODES.md` — approval-first matrix. Draft Control Center settings are not live enforcement.
5. `docs/architecture/GRADIA_MEMORY.md` — reviewed structured memory. Not uncontrolled learning.
6. `docs/roadmap/POST_MVP_IDEAS.md` — preserved ideas. Not approved scope.
7. `docs/roadmap/CONTEXT_AUTHORITY_PROPOSAL.md` — proposed `CONTEXT.md` notice. The founder file was not overwritten.
8. `docs/BUILD_REFERENCE.md` — how screens look and sound, when it does not conflict with the five documents.
9. `docs/gradia-v2/` — historical audit trail. `16-document-source-map.md` says what is reference-only.

`CONTEXT.md` on GitHub still claims it outranks every plan. That notice is stale. The uncommitted founder checkout edit is protected and was not changed here. `PROJECT_BRIEF.md` and `GRADIA_MVP_PLAN.md` are historical.

@AGENTS.md
@docs/BUILD_REFERENCE.md

## Locked architectural principles

These are decisions, not suggestions. Do not "improve" them away. Full rationale,
build queue, and sources live in `SHARPENING_BRIEF.md` (2026-06-09).

1. **Workflows by default, agents only where steps are unknowable.** Inbound handling stays a fixed pipeline. Never convert Tier-1 workers into loops.
2. **Guardrails live in code, never in prompts.** Autonomy is bounded by tool capability (read-only tools, HITL staging, hard floors ANDed in `isAutonomyAllowed()`), not by instructions.
3. **The planner→runtime split is the destination, not a stepping stone.** LLM plans once; deterministic code executes. No unified runtime brain. Unification happens only at the context layer (shared memory, identity, KB, `persona.ts`).
4. **Customer-facing effects are approval-first until an explicit per-operation opt-in.** The September 11 matrix in `docs/architecture/AUTONOMY_APPROVAL_MODES.md` replaces the blanket “money and calendar always HITL” rule and D-068’s automatic defaults. Existing locking tests stay until a reviewed replacement covers the new matrix. Do not delete them in a docs pass. STOP, DNC, suppression, hard capacity conflicts and consumed proof never become approvable.
5. **No agent framework migration.** Hand-rolled SDK calls are deliberate. Frameworks are for prototyping spikes only.
6. **Evals gate every model/prompt change.** No prompt edit, model swap, or new recipe ships without passing the harness.
7. **Per-step model routing.** Cheapest model that clears the quality bar per step (Haiku workers, Sonnet planning/BI). Re-test the floor periodically.

