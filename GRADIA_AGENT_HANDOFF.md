# Gradia Agent — Handoff / Catch-Up Brief

_For a coworking agent joining the project. Read this first, then the source-of-truth docs in §9._
_Branch: `mvp/phase-0-subtraction` (repo `github.com/trygradia-max/Gradia-ai-platform`). `main` = production._
_State as of commit `a0715cd`. Everything below is built, tested, and pushed — NOT yet merged to `main`._

---

## 1. What this is (one paragraph)

**Gradia Agent** is the shop owner's single conversational box that both **answers** questions about their business and **acts** on their CRM (drafts texts/emails, books, fixes data) — all staged for the owner's approval. It's the fusion of the old "Ask Gradia" read-only chat and the custom-agent act engine into one surface. It is the headline of **Package 1 — Core ($20)** alongside Gradia Whisper. **Package 2 (+$29)** = the voice receptionist + the autonomous (scheduled) chat agent + autonomous mode — already-built code that lights up on upgrade. Mental model: **Core = you ask, it stages, you approve. Package 2 = it watches/acts on its own + answers the phone.**

## 2. The architecture you must respect (locked)

From `CLAUDE.md` / `_docs/GRADIA_AGENT_SHARPENING_BRIEF.md` — these are decisions, not suggestions:

1. **Workflows by default; agent loops only where steps are unknowable.** The box's conversation loop is the one bounded loop; execution is deterministic.
2. **Guardrails live in code/tool capability, never in prompts.** (read-only tools, HITL staging, hard floors.)
3. **Planner→runtime split.** The loop proposes; deterministic code executes. No unified runtime brain.
4. **Money & calendar writes are ALWAYS HITL.** `ALWAYS_HITL` in `autonomy.ts` (book/reschedule/cancel). No mode/flag bypasses this. Extend the locking tests, never weaken them.
5. **No agent-framework migration** (hand-rolled SDK calls are deliberate). No fine-tuning.
6. **Evals gate every model/prompt change.** Run the harness before shipping.
7. **Per-step model routing** — cheapest model that clears the bar (see §6).

**The box's core invariant: it has NO send tool.** It can only `preview` and `stage` into `pending_actions` → the human approves in `/approvals` (or earned-autonomy auto-executes for Package 2). There's a source-scan test (`eval/guardrails.test.ts`) that fails if a send/execute call sneaks into `owner-agent.ts`.

## 3. The capability ladder (all built + live-verified this session)

| Rung | What | Key files |
|---|---|---|
| Box v1 | Read+act loop, SSE endpoint, `/agent` page | `owner-agent.ts`, `app/api/agent/chat/route.ts`, `app/(dashboard)/agent/page.tsx` |
| L1 | Action registry: `draft_reply`, `add_note`, `create_lead`, `propose_booking`, `update_customer` | `owner-agent.ts` |
| L2 | `cold_leads` diagnostic (find revival candidates) | `bi-tools.ts` |
| L3 | Structured vehicle (make/model/year/color) + `last_visit_at` segments | `vehicle.ts`, migration `..._structured_segments.sql`, `..._vehicle_color.sql` |
| L4 | Cross-model verify on every staged draft | `draft-verifier.ts` |
| L5 | Routing/grounding evals + knowledge/services grounding into drafts | `eval/owner-agent-routing.eval.test.ts`, `drafting-context.ts` |
| L6 | Earned autonomy: approval-rate telemetry → "turn on autopilot?" offer | `trust.ts`, `components/gradia/autonomy-offers.tsx` |
| — | CRM cleanup (dedupe + gap detection) + "5 Sarahs" disambiguation + auto-pop on CRM connect | `crm-health.ts`, `app/actions/crm-cleanup.ts`, `components/gradia/crm-cleanup-card.tsx` |

## 4. The non-box systems built this session

- **Packaging/entitlements** — `entitlements.ts` (`isPaid`, `hasPackage2`). Gates: `autonomy.ts:resolveAgentMode` (autonomy = Package 2), `agent-runtime.ts:runScheduledAgents` (paid only). Docs reframed in `_docs/GRADIA_PRICING.md`, `_docs/WHAT_GRADIA_DOES.md`, `GRADIA_MVP_PLAN.md`.
- **Credit fail-closed shutoff** — `credits.ts:checkFeatureAccess` (402 when plan inactive OR allowance spent), wired into `/api/whisper/process` + `/api/bi/chat` + `/api/agent/chat`.
- **Over-usage protection** — `rate-limit.ts` (`rate_limits` table): per-shop/day ceiling on UNMETERED inbound classify (Twilio/Aurinko webhooks) + per-minute burst on owner endpoints. `monitoring.ts` (anomaly scan in reconcile cron). Ops runbook: `docs/OVERUSAGE_RUNBOOK.md`. Limiter fails OPEN (credit gate is the hard ceiling).
- **B2 safe-send (TCPA)** — `send-policy.ts`: quiet-hours (shop timezone), opt-out, marketing-consent (explicit consent OR established relationship/prior inbound). Enforced at `executeSendSms`. Consent ledger on `customers` captured from inbound START/STOP. Closed the BYO-number A2P bypass (`shops.byo_sms_verified`).
- **Shared execution layer** — `agent-runtime.ts:stageOutreachPlan` (resolve audience → draft → stage), used by the box's `stage_outreach`. `maybeAutoExecute` honors per-action-type autonomy (L6).

## 5. How to verify / run

- **Pure tests (no network, fast):** `npm test` → 167 passing (these are the locking tests; run on every change).
- **Typecheck:** `npx tsc --noEmit`  ·  **Lint:** `npx eslint <files>`  ·  **Build:** `npm run build` (each phase ends green on build, per `AGENTS.md`).
- **Live evals (cost tokens, gated):** `EVAL_LIVE=1 npx vitest run eval/<file>.eval.test.ts`. Keys load from `.env.local` via `eval/_setup.ts`. Live tests have 120–240s timeouts and are mildly flaky on API latency — that's expected, re-run a single failure before assuming a regression.
- **Model A/B harness:** `GRADIA_LLM_MODEL=<id> EVAL_LIVE=1 npx vitest run eval/owner-agent-routing.eval.test.ts` overrides the brain model.
- **Smoke test (watch the box run):** `EVAL_LIVE=1 npx vitest run eval/owner-agent.eval.test.ts --reporter=verbose` — drives the real loop against a seeded in-memory CRM (cold-lead revival + booking), prints the conversation.

## 6. Backend models (validated, per-step routing)

- **Brain** (conversation loop / planning / BI): **Sonnet 4.6** (`bi-agent.ts:MODEL`, env-overridable via `GRADIA_LLM_MODEL`). A/B'd vs Opus 4.8 — Opus was slower + 1.67× cost with no quality win. Sonnet stays.
- **Workers** (drafting, classification): **Haiku 4.5**.
- **Verifier**: **Sonnet 4.6** (`draft-verifier.ts`) — deliberately a different/stronger model than the Haiku drafters (real cross-model review).
- **Transcription + embeddings**: OpenAI (Whisper + text-embedding-3-small). ⚠️ key is dead — see §7.
- Cost model (2026-06-15): ~$2.55 real cost per 1,000 credits → ~74% margin. `pricing.ts:DEFAULT_PRICING`.

## 7. Open items (what's NOT done)

1. **🔴 Rotate `OPENAI_API_KEY`** — it's expired (401). So `search_knowledge`, `search_memory`, and Gradia Whisper transcription are degraded. Drafting grounding still works (it uses the plain-text `listShopKnowledge`, no embeddings). Drop a fresh key in `.env.local`.
2. **PR to `main`** — branch is pushed but not merged; the box goes live to users only on merge (keep `main` green first).
3. **Settings UI** for quiet-hours and BYO A2P attestation (backend + sane defaults exist; no owner toggle yet).
4. **Inline approval card** in the chat (currently staged drafts route to the existing `/approvals` page).
5. **Consolidate** the scheduled `executeFreeformOutreach` onto `stageOutreachPlan` (it currently mirrors it).
6. **Fuzzy dedupe** (current CRM dedupe is exact-normalized-name only) + **CRM customer import/pull** (connecting a CRM enables push + flags cleanup, but doesn't pull their customer list in — that's the Customer Recovery spec, bigger build).

## 8. Gotchas

- **`AGENTS.md`: "This is NOT the Next.js you know."** Read `node_modules/next/dist/docs/` before writing Next code — APIs differ from training data.
- **Two scratch planning docs are deliberately untracked** (`GRADIA_AGENT_MERGE_BRIEF.md`, `GRADIA_IGFB_CHARGE_REMOVAL_PLAN.md`). Don't commit them; do read the merge brief — it's the box's design doc.
- **The box uses the shop-scoped (RLS) client, never service-role.** Keep it that way.
- **Never weaken `ALWAYS_HITL` or the no-send-tool guarantee.** Extend the locking tests instead.
- Migrations are numbered `supabase/migrations/2026...` — add new ones, don't edit shipped ones. Several this session: `rate_limits`, `safe_send`, `approval_resolution`, `structured_segments`, `vehicle_color`.

## 9. Read next (source of truth, in order)

1. `platform/CLAUDE.md` + `platform/AGENTS.md` — conventions + locked principles.
2. `platform/GRADIA_AGENT_MERGE_BRIEF.md` — the box's design + three-layer architecture (untracked, on disk).
3. `platform/GRADIA_MVP_PLAN.md` — overall MVP source of truth.
4. `_docs/GRADIA_AGENT_SHARPENING_BRIEF.md` — agentic principles + build queue (P0–P5).
5. `_docs/WHAT_GRADIA_DOES.md` — product truth; all copy/claims must match it.
6. `_docs/GRADIA_PRICING.md` — locked pricing + the Package 1/2 reframe.
7. `eval/README.md` — the eval harness tiers.

## 10. The honest one-liner

Gradia Agent went from "a chat box that answers questions" to a **read+act front-office assistant** that diagnoses the shop, segments accurately (vehicle/visit), drafts grounded in real knowledge, verifies every draft cross-model, books, fixes messy data, refuses honestly, keeps sends TCPA-legal, and earns the right to run on its own over time — all stage-only with the owner in control. Verified by 167 pure tests + live evals. Not yet exercised against a real shop's live data, and not yet merged to `main`.
