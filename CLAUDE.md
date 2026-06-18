@AGENTS.md
@PROJECT_BRIEF.md
@GRADIA_MVP_PLAN.md
@docs/BUILD_REFERENCE.md

<!-- GRADIA_MVP_PLAN.md is the current source of truth for the refreshed MVP.
     Where it conflicts with PROJECT_BRIEF.md, the MVP plan wins.
     BUILD_REFERENCE.md is the source of truth for how Gradia looks, sounds,
     and behaves — read it before building or refactoring any screen. -->

## Locked architectural principles

These are decisions, not suggestions. Do not "improve" them away. Full rationale,
build queue, and sources live in `SHARPENING_BRIEF.md` (2026-06-09).

1. **Workflows by default, agents only where steps are unknowable.** Inbound handling stays a fixed pipeline. Never convert Tier-1 workers into loops.
2. **Guardrails live in code, never in prompts.** Autonomy is bounded by tool capability (read-only tools, HITL staging, hard floors ANDed in `isAutonomyAllowed()`), not by instructions.
3. **The planner→runtime split is the destination, not a stepping stone.** LLM plans once; deterministic code executes. No unified runtime brain. Unification happens only at the context layer (shared memory, identity, KB, `persona.ts`).
4. **Money and calendar writes are always HITL.** No mode, flag, or refactor may bypass this. Locked by tests — extend the tests, never weaken them.
5. **No agent framework migration.** Hand-rolled SDK calls are deliberate. Frameworks are for prototyping spikes only.
6. **Evals gate every model/prompt change.** No prompt edit, model swap, or new recipe ships without passing the harness.
7. **Per-step model routing.** Cheapest model that clears the quality bar per step (Haiku workers, Sonnet planning/BI). Re-test the floor periodically.

