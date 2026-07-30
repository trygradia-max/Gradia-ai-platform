# 00 — Product Principles

_Created 2026-07-25 by the Organizer. Precedence layer 4 (with `02-target-architecture.md`) — beaten by audited behavior, the decision log (`11-decision-log.md`), and ADRs. Copy/claims remain governed by `_docs/WHAT_GRADIA_DOES.md`; pricing by `_docs/GRADIA_PRICING.md`._

## What Gradia is

**Gradia is the operating system for detailing and automotive appearance shops** (detailing, ceramic coating, PPF, tint) — decision D-001. It holds the shop's customers, vehicles, quotes, jobs, calendar, and every conversation in one system, and then **works** that system: follow-ups drafted, bookings landed, campaigns staged, calls answered — always under the owner's control.

Two things about that sentence:

- **Principle vs positioning.** D-001 governs *build direction*: the scope grows toward a full shop operating system (calendar, jobs, invoices, teams, memberships, fleets). **Update 2026-07-27 (D-033):** the founder adopted the OS category for marketing too — "The operating system for detailing and automotive appearance shops," headline "Run your shop. Capture every lead. Recover more revenue." (resolves Q-14; C-01 updated in `16-document-source-map.md`). Per-feature *claims* still pass `WHAT_GRADIA_DOES.md` (D-028); its headline/claim list awaits the founder's update — flagged, not performed.
- **Who it serves.** Independent detailers and small automotive-appearance shops — one owner today, small teams next (E01). The owner is busy, on their phone, mid-job. Every surface must respect that (see `ui/`).

## Binding product principles

These are decisions, not aspirations. Each cites its authority.

1. **Standard business operations must work without AI** (D-002). CRM, calendar, quotes, jobs, and invoices are first-class and fully usable with every AI feature off. AI is the differentiator, never a dependency. A capability whose non-AI path is broken is not done (`12-definition-of-done.md`).
2. **Control-first autonomy.** Every agent starts in suggest mode; nothing is sent, booked, or charged without approval in `/approvals`. Owners may graduate an agent to autonomous only when it has earned trust, per-agent and reversible. **Hard floor no mode changes: money and calendar writes always ask first** (D-021; ALWAYS_HITL enforced in `autonomy.ts`, test-locked — audit doc 07). High-ticket actions join the floor (threshold pending, decision queue Q-11).
3. **Guardrails live in code, never in prompts** (D-012). Autonomy floors, send policy, quiet hours, STOP/opt-out, TCPA win-back gates, FTC review neutrality — all enforced in code and locked by CI tests. Extend the locking tests, never weaken them.
4. **One brain, one voice.** Every engine reads and writes the same memory, customer records, knowledge base, and persona (`persona.ts`). Gradia speaks as the shop — *we/us*, never a third-party bot — and every outbound message carries Gradia's name and role.
5. **Fail-closed money.** Credits and voice minutes are metered from an append-only ledger; hitting the cap stops staging and degrades voice gracefully — never a surprise bill, never a cut live call (`GRADIA_PRICING.md` §Paywall). Financial events are immutable and replay-safe (D-024).
6. **Full audit trail.** Every run, plan, staged action, decision "because" line, resolution, and metered cost is recorded and traceable (the 4-layer trail, audit doc 07 §Auditability). Autonomy without logging does not exist.
7. **The shop's data is the shop's.** One tenant-isolated database; imports welcome real data (D-006); export and deletion flows are roadmap obligations (P10), not afterthoughts.
8. **Zero founder-touch per signup** (locked agentic principle #9). Every per-shop setup step — provisioning, registration, wiring, billing — is automated in code or self-serve in the owner's UI. A feature that needs the founder per customer is incomplete.
9. **No fake anything** (D-025). No mock data, fake metrics, dead controls, or simulated integrations. The 2026-07-20 audit verified this culture (doc 08: "unusually honest"); it is now binding policy. Numbers trace to real rows or render a written zero-state.
10. **Truth in claims** (D-028). Product claims distinguish **live**, **beta**, and **planned**. `04-capability-map.md` statuses are the machine-readable form; `WHAT_GRADIA_DOES.md` is the copy-facing form. If a claim isn't backed by a live capability, we don't make it.
11. **Imports are a trust moment** (D-022, D-006). Real CRM/calendar data may be imported during setup and trial; every import goes through staging → mapping → preview → validation → error reporting → rollback. A bad first import loses the customer forever.
12. **Straight commercial dealing.** Full public pricing (D-004); no founding pricing or lifetime discounts (D-003); a full operational trial with controlled variable-cost allowances, fail-closed (D-005). Both package prices always appear together — never a checkout surprise.

## The commercial model (summary — `_docs/GRADIA_PRICING.md` wins on all numbers)

> **Re-pricing in progress (D-031/C-14):** the founder has re-based public pricing to **Core $99 / Pro $149 / Operator $249** as forward direction; the packages below describe live billing today. Implementation details: Q-22. Trial start moves to activation, not signup (D-032, gate definition in Q-13).

- **Package 1 — Gradia Core, $20/mo:** Gradia Agent + Gradia Whisper + Ask Gradia + CRM/calendar/approvals; 1,200 credits/mo. Everything on-request and approve-first. The $20 promise must be fully true on its own.
- **Package 2 — Voice + Chat Autopilot, +$29/mo:** voice receptionist (number + 60 min/mo, own meter) + autonomous chat agent + autonomous mode. Activates already-built, entitlement-gated code.
- Margin rules: ~3.3× wholesale on usage, ≥~67% plan margin at full burn, verified from `usage_events`. Pricing changes go through `pricing_config`, never code. Detail: `15-cost-and-margin-model.md`.
- Trial: full product with capped variable-cost allowances (D-005); allowance numbers open in `program/decision-queue.md` Q-13.

## The locked agentic principles (1–9, restated)

Source: root `CLAUDE.md` / `_docs/GRADIA_AGENT_SHARPENING_BRIEF.md`. Imported into the decision log (D-007..D-012, D-027) and repeated here because every Builder must know them cold:

1. **Workflows by default; agent loops only where steps are unknowable.** Never convert single-turn workers into loops.
2. **Guardrails in code/tool capability, never prompts** (read-only tools, HITL staging, hard floors ANDed in `isAutonomyAllowed()`).
3. **Planner→runtime split is the destination.** LLM plans once; deterministic code executes. Unification only at the context layer (memory, identity, KB, `persona.ts`).
4. **Money and calendar writes are always HITL.** No mode, flag, or refactor bypasses this. Extend the locking tests, never weaken them.
5. **No agent-framework migration; no fine-tuning; no auto-published model-authored skills.** Hand-rolled SDK calls are deliberate (D-010).
6. **Evals gate every model/prompt/recipe change.** No exceptions. (Operationalizing this is P0-002 + `09-testing-strategy.md` — the audit found live tiers not yet CI-gated.)
7. **Per-step model routing:** cheapest model that clears the quality bar (Haiku workers, Sonnet planning/BI).
8. **All vendor calls go through provider seams** (`voice-provider.ts`, `telephony-provider.ts`, `crm-provider.ts`); the missing LLM seam is scheduled work (`02-target-architecture.md`). No vendor types leak past seams.
9. **Zero founder-touch per signup.**

## What Gradia does NOT do

Governed by `WHAT_GRADIA_DOES.md` §3 (claims) and `10-roadmap.md` §rejects (build): no website building/hosting, no Instagram/Facebook DMs, no photo-based quoting, no social posting, no silent autonomy — ever claimed or built without a decision-log entry. Invoicing/payments is **planned** (D-019, E05/P5) but remains on the "do not claim" list until it ships (contradiction C-05).
