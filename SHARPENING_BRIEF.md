# Gradia Agentic Platform — Sharpening Brief for Claude Code
*Hand this file to Claude Code. Drop it in the repo root (or merge the Principles section into CLAUDE.md). 2026-06-09.*

---

## Part 1 — Locked principles (add to CLAUDE.md so every session obeys them)

These are decisions, not suggestions. Do not "improve" them away.

1. **Workflows by default, agents only where steps are unknowable.** Inbound handling stays a fixed pipeline. Never convert Tier-1 workers into loops.
2. **Guardrails live in code, never in prompts.** Autonomy is bounded by tool capability (read-only tools, HITL staging, hard floors ANDed in `isAutonomyAllowed()`), not by instructions.
3. **The planner→runtime split is the destination, not a stepping stone.** LLM plans once; deterministic code executes. No unified runtime brain. Unification happens only at the context layer (shared memory, identity, KB, persona.ts).
4. **Money and calendar writes are always HITL.** No mode, flag, or refactor may bypass this. Locked by tests — extend the tests, never weaken them.
5. **No agent framework migration.** Hand-rolled SDK calls are deliberate. Frameworks are for prototyping spikes only.
6. **Evals gate every model/prompt change.** No prompt edit, model swap, or new recipe ships without passing the harness.
7. **Per-step model routing.** Cheapest model that clears the quality bar per step (Haiku workers, Sonnet planning/BI). Re-test the floor periodically.

## Part 2 — Build queue (priority order)

### P0 — Eval expansion (everything else depends on this)
- Per-worker golden datasets: 30–50 real (anonymized) inbound messages per worker with expected classifications/extractions. Measure recall/precision per worker, not just pass/fail.
- **Signal-to-noise metric for drafts**: of staged `pending_actions`, what % are approved unedited vs. edited vs. rejected? Instrument the approval queue — this is the platform's core quality KPI.
- **Trajectory evals for Ask Gradia**: log tool-call sequences; judge tool *selection* (right tool, called at the right time), not just final answers.
- Add voice transcripts to the harness (persona adherence + tool-call correctness for the Vapi/GPT-4o-mini agent — cross-vendor persona drift is a live risk).

### P1 — Cross-model verification pass ("de-noising")
Before any draft is staged to `pending_actions`, run a separate cheap verifier call (different model than the drafter — e.g., Haiku drafts → Sonnet spot-verify sample, or distinct Haiku prompt acting as critic):
- Checks: persona/tone match vs persona.ts, factual grounding against the customer record & KB (does the quoted service/price exist?), compliance (STOP handling, no fabricated availability), template variable sanity.
- Fail → flag the approval card with the verifier's objection instead of silently staging.
Generation and verification must be separate calls; self-review has blind spots.

### P2 — Recipe promotion pipeline ("promote, don't unify")
- Instrument free-form planner runs: track plan shape, approval rate, edit rate per pattern.
- When a free-form plan pattern hits a threshold (e.g., ≥20 runs, ≥90% approved unedited), surface it as a candidate recipe for human curation into a guardrailed skill.
- **Cap active recipes at 3–5 focused ones.** More skills degrade planner accuracy (SkillsBench: 2–3 focused = +18.6pp; 4+ collapses; comprehensive docs hurt). Retire low-usage recipes when adding new ones.
- Recipes are human-curated, never auto-published from model output.

### P3 — Context engineering hardening
- **RAG selection > RAG recall** in `search_memory`/`search_knowledge`: add a relevance filter step before injection. Semantically-similar-but-irrelevant chunks actively degrade answers (hard distractors cost 6–11 accuracy points even when the right passage is present; better retrievers surface worse distractors). Prefer fewer, verified chunks.
- Per-step context budgets: each worker gets only what its step needs (signature-level vs full-record detail). Audit current prompts for context packing.
- **Memory curation**: structure stored memories with metadata (type, customer, recency, source) and retrieve by context. Add a periodic consolidation job (merge duplicates, expire stale facts). Append-only logs are for audit (`usage_events`), not for retrieval.

### P4 — Trust-dial telemetry (earned autonomy)
- Per action type per shop, compute rolling approval-without-edit rate.
- Surface "this action type has been approved unedited 50× — switch to autonomous?" prompts to owners. Autonomy is granted by evidence, owner-by-owner, action-by-action. Floors (money/calendar) never move.

## Part 5 — Voice alignment
- Single source of truth check: diff the persona/KB context sent to Vapi against what chat agents receive; alert on drift.
- Evaluate replacing or A/B-ing the voice LLM for persona consistency once evals (P0) can measure it.

## Part 3 — What NOT to build (explicit non-goals)
- ❌ Unified reasoning runtime / "one brain" executor
- ❌ Open-ended multi-step planning with write access
- ❌ Fine-tuning (most production agents use none; frontier + good prompts wins at this stage)
- ❌ Auto-generated skills/playbooks without human curation (measured net-negative)
- ❌ Framework migration (LangGraph etc.)
- ❌ Latency micro-optimization (only ~15% of production teams found latency a blocker; minutes-long agent runs are acceptable — optimize correctness first)

## Part 4 — Definition of "super powerful" (the metrics that matter)
Production agents are judged on human hours saved, not autonomy. Track:
1. % of inbound messages fully handled to staged-draft with zero owner edits
2. Approval-without-edit rate (per worker, per recipe, per shop)
3. Owner minutes-to-clear approval queue per day
4. Booked appointments attributable to agent-initiated outreach
5. Verifier catch rate (P1) and false-flag rate
6. Eval pass rate on every model/prompt change (regression gate)

## Sources (verified 2026-06)
- Anthropic, *Building Effective Agents* — workflow/agent taxonomy, tool design (anthropic.com/research/building-effective-agents)
- *Measuring Agents in Production*, Stanford/IBM et al., 306 practitioners (arxiv.org/pdf/2512.04123) — constraints beat capability; HITL eval norms
- InfoWorld / CodeRabbit, *How to build an AI agent that actually works* (Mar 2026) — hybrid architecture, cross-model verification, per-step routing, eval-first
- SkillsBench (arxiv.org/abs/2602.12670) — 2–3 curated skills optimal; self-generated skills net-negative
- *The Distracting Effect* (arxiv.org/abs/2505.06914) — RAG distractor risk
- Neo4j, *Useful AI Agent Case Studies* (Feb 2026) — reliability from structured context layer
- Google Cloud, *A dev's guide to production-ready AI agents* (Feb 2026) — trajectory evals, staged rollout
