# E01-04 — `ModelProvider` seam / AI gateway (D-029): one `llm.ts`, model registry, retries/timeouts, per-call cost + latency recording

_Cut 2026-09-01 by the Organizer for autorun Batch 2 (`../program/autorun.md`). Specification only._

## Ticket ID
E01-04

## Epic
E01 — Organization, tenancy and backend foundation (phase P1)

## Status
**draft — batch-gated.** Autorun Batch 2, queue item 8. Enters after E01-03 is committed. Risk class **standard** (invisible refactor; eval-gated per locked principle #6). Founder acceptance **no**. Decisions binding: **D-029** (Gradia-owned `ModelProvider`; centralized gateway; no hardcoded model ids in app modules; retries/timeouts/costs/latency/failures recorded), D-010 (no framework migration — `@langchain/anthropic` stays a structured-output convenience), D-009, D-012, principle #7 (per-step model routing). No open decision. **Note:** the E01-05 eval-gating ticket depends on Q-06, which is still open — this ticket runs the existing eval suites on its own (locked principle #6) and does not need Q-06.

## Priority
P1 — High. Thirteen hardcoded model ids across 13 modules, 13 duplicated API-key helpers, retry/backoff in exactly one module (`ai-service.ts:188`), zero timeouts/AbortSignals elsewhere, two raw-`fetch` Anthropic call sites (`bi-agent.ts`, `agent-planner.ts`), and `GRADIA_LLM_MODEL` with **production effect** (`bi-agent.ts:27`) — the seam D-029 named as missing (audit 07/09; `vendors/ai/anthropic.md:42`).

## Objective
Introduce `src/lib/llm.ts` — the single gateway every LLM call goes through: a task-tier model registry (`worker` → Haiku, `planner`/`verifier`/`bi` → Sonnet; ids live only here), uniform timeouts + AbortSignal, exponential backoff with jitter on transient errors (generalizing `withBackoffRetry`), an error taxonomy, and a per-call record (model, tier, tokens in/out, latency, attempts, outcome, cost estimate) — then migrate all 13 call sites so no app module names a model id, kill the production effect of `GRADIA_LLM_MODEL`, and prove no behavior drift with the Tier-2 eval suites.

## User outcome
Invisible to owners except reliability: a simulated 429 retries instead of dropping a campaign recipient (E01 acceptance criterion 3). Founder-as-operator: one place to change a model, and real per-call cost/latency data for the margin model (15).

## Current code references
- **No gateway:** `src/lib/llm.ts`, `ai.ts`, `model-router.ts` absent (verified 2026-09-01). `src/lib/ai-service.ts` is lead extraction (owns the only retry: `withBackoffRetry` `:188`, `isTransientApiError` `:151-186`, used at `:236`).
- **LangChain `ChatAnthropic` sites (11 files / 16 instantiations):** `ai-service.ts:223`; `draft-verifier.ts:123`; `email-drafter.ts:158,257,291`; `email-classifier.ts:92`; `sms-drafter.ts:97,194,319,349`; `sms-classifier.ts:83`; `whisper.ts:167`; `whisper-summary.ts:103`; `recovery/extract.ts:146`; `recovery/vehicle-llm.ts:54`; `eval/_lib.ts:63` (judge).
- **Raw fetch Anthropic Messages:** `bi-agent.ts:23,165-201` (streaming SSE reader `:191-201`, bare throw `:186`); `agent-planner.ts:18,398-421` (forced `tool_choice` `:416`).
- **OpenAI raw fetch:** `embeddings.ts:19,55-73` (embeddings), `whisper.ts:112,138-147` (STT). Vapi-side model config `vapi.ts:71,274-275` (`gpt-4o-mini` — third-party runtime, **not** this seam).
- **Hardcoded model ids (13):** `ai-service.ts:12`, `email-drafter.ts:24`, `email-classifier.ts:14`, `sms-drafter.ts:26`, `sms-classifier.ts:15`, `whisper.ts:15`, `whisper-summary.ts:14`, `recovery/extract.ts:17`, `recovery/vehicle-llm.ts:15` (all `claude-haiku-4-5-20251001`); `draft-verifier.ts:32`, `agent-planner.ts:20`, `eval/_lib.ts:64` (`claude-sonnet-4-6`); `vapi.ts:275` (`gpt-4o-mini`, excluded).
- **`GRADIA_LLM_MODEL`:** `bi-agent.ts:27` (prod effect); `eval/owner-agent-routing.eval.test.ts:18`; `GRADIA_AGENT_HANDOFF.md:53,58`.
- **API-key helpers duplicated (12 sites):** `ai-service.ts:73-77`, `draft-verifier.ts:121`, `email-drafter.ts:90-91`, `email-classifier.ts:78-79`, `sms-drafter.ts:80-81`, `sms-classifier.ts:70-71`, `whisper.ts:107-108`, `whisper-summary.ts:100`, `bi-agent.ts:114-115`, `agent-planner.ts:373-374`, `recovery/extract.ts:128-129`, `recovery/vehicle-llm.ts:48-49`. `src/lib/env.ts` validates only Supabase vars.
- **Cost recording today:** `usage_events` kinds `outreach_draft|bi_answer|whisper_note|agentic_plan|inbound_classify` (`database.ts:132-144`; CHECK widened `20260611110000_pricing_skus.sql:21-24`; unique `(shop_id, kind, vendor_ref)` `20260812120000_webhook_idempotency.sql:46-47`); writer `credits.ts:73` `recordUsage` (best-effort); pricing `pricing.ts:38-40`. **Gap:** per product action at flat SKU prices — no tokens, latency, attempts, failures; the 10 drafter/classifier calls have no metering hook.
- Prompt files (unchanged by this ticket; the eval gate watches them): `persona.ts`, `vapi-prompt.ts`, drafters/classifiers `SYSTEM` constants, `bi-agent.ts:31,69`, `owner-agent.ts:92`, `agent-planner.ts:349`, `whisper.ts:74`, `ai-service.ts:46,58`.
- Evals: `eval/README.md:7-42` tiers; live suites `eval/*.eval.test.ts` (7), gate `eval/_lib.ts:10-11` (`EVAL_LIVE=1`), golden cases `eval/cases/*.json`; scripts `npm run eval`.
- Provider docs: `vendors/ai/anthropic.md`, `vendors/ai/openai.md`; ADR-002 boundary rule.

## Exact scope
1. **`src/lib/llm.ts` gateway:** `ModelProvider` interface (`complete`, `completeStructured<T>(schema)`, `stream`, `embed` is **out** — see non-goals) with an Anthropic adapter (LangChain `ChatAnthropic` for structured output where used today; raw Messages API for streaming/tool-forced calls, wrapped once); **model registry by task tier**: `worker` (extraction, classification, drafting, whisper, recovery) → `claude-haiku-4-5-20251001`; `planner`, `verifier`, `bi`, `judge` → `claude-sonnet-4-6`; ids appear **only** in `llm.ts` (source-scan test). Options per call: `timeoutMs` (defaults per tier), `maxTokens`, `temperature`, `signal`.
2. **Reliability:** generalize `withBackoffRetry`/`isTransientApiError` into the gateway (429/408/5xx/529/overloaded/network; jittered exponential, capped attempts per tier; respects `Retry-After`); hard timeout via AbortController; typed error taxonomy (`LlmRateLimited`, `LlmTimeout`, `LlmProviderError`, `LlmInvalidOutput`) so callers keep their existing fail-closed/degrade behavior by mapping — **no call site changes its fallback semantics** (characterization).
3. **Per-call record (`llm_calls`):** append-only, service-role-only (like `usage_events` — D-024 pattern), `shop_id` nullable (platform calls), `tier`, `model`, `purpose` (caller tag), `tokens_in/out`, `latency_ms`, `attempts`, `outcome`, `estimated_cost_cents` (from a wholesale table in `pricing.ts`, not owner-facing), `usage_event_id` nullable link when the call maps to a metered product action; 30-day retention via the existing retention-cron pattern (bounded delete). **This is observability/margin data, not the billing ledger** — `usage_events`/credits semantics untouched (autorun hard-stop boundary).
4. **Migrate the 13 call sites** (including `eval/_lib.ts` judge; excluding `vapi.ts` and OpenAI embeddings/STT): each becomes `llm.complete({ tier, purpose, ... })`; delete the 12 key helpers (one `env` accessor in `llm.ts`; `src/lib/env.ts` gains `ANTHROPIC_API_KEY` validation with a lazy, fail-loud check — not at import time, so builds without the key still succeed as today).
5. **`GRADIA_LLM_MODEL`:** production effect removed; honored **only** when `EVAL_LIVE=1`/non-production (documented in `.env.example` as an eval override); `bi-agent.ts` reads the registry.
6. **Streaming:** `bi-agent`'s SSE path goes through `llm.stream` (same wire format), preserving the current UI streaming contract (`src/app/api/bi/chat/route.ts`).
7. **Evals:** run every Tier-2 suite that covers a migrated module (`extraction`, `classification`, `bi`, `owner-agent`, `owner-agent-routing`, `recovery-extraction`, `review-request`, `draft-verifier` live section) before and after; results pasted in the completion report (DoD B). Prompt files must not change (assert by diff).
8. Docs: `vendors/ai/anthropic.md` (seam present; `GRADIA_LLM_MODEL` defect closed), `02-target-architecture.md` §AI gateway status, `15-cost-and-margin-model.md` (per-call data source now exists), ADR-002 note.

## Explicit non-goals
- No OpenAI embeddings/STT migration (embedding vendor/dimension is P10 per `02` §AI gateway exclusions; STT stays a thin call) — record as a `llm.ts` follow-up.
- No prompt edits, no model swaps (Haiku/Sonnet mapping preserved exactly), no new recipes.
- No Vapi in-call model changes. No LangGraph (D-010).
- No owner-facing cost display; no change to `usage_events` pricing or credit decrements.
- No caching layer (prompt caching headers may be passed through where already used — `bi-agent` cache blocks — unchanged).

## Dependencies
- E01-03 committed (ordering only). P0-012 merged (failure alerts). No decision open (Q-06 is E01-05's).

## Expected modules affected
New: `src/lib/llm.ts`, `src/lib/llm/anthropic-adapter.ts`, migration `llm_calls` (+ retention hook in `cron/recovery-retention` or a new small cron), `eval/llm-gateway.test.ts`. Modified: the 13 call-site files, `src/lib/env.ts`, `src/lib/pricing.ts` (wholesale table), `src/lib/credits.ts` (optional link id only), `.env.example`, `eval/_lib.ts`, `vendors/ai/anthropic.md`, `02`, `15` docs.

## Database impact
New append-only table `llm_calls` (service-role write, owner SELECT via shop_id RLS **or** no owner access at all — Builder chooses no-owner-access; it is ops data) + retention delete.

## Migration impact
One additive, idempotent migration. Occupies the DB-sensitive slot while in progress (confirm at slotting — if the Builder defers `llm_calls` to structured logs only, state it; the D-029 "recorded" requirement is then met by logs + Sentry breadcrumbs until the table lands — **preferred: ship the table**).

## API impact
None external; internal gateway API.

## UI impact
None.

## Permission impact
None.

## Tenant-isolation impact
`llm_calls.shop_id` stamped via `forShop` where a shop context exists; platform calls null. No owner-readable PII (prompts/outputs are **not** stored — only counts).

## Security impact
API key read in one place; never logged; error messages from the provider never surface raw to owners (P0-010 M-1 follow-up: wrap provider failures in honest generic copy — this ticket implements it at the gateway boundary).

## Idempotency requirements
Retries must be safe: only idempotent generation calls are retried (all current sites are read-only generation; any future call with side effects passes `retry: false`). `llm_calls` rows per attempt-group (one row, `attempts` count).

## Observability requirements
Structured `[llm]` log per call (tier, purpose, latency, attempts, outcome — no content); SEV-2 alert through P0-012 on sustained provider failure rate (threshold noted); `/api/health` gains last-success per tier.

## Analytics requirements
None (ops data).

## Feature flag
None — invisible refactor gated by evals + characterization tests (E01 epic: "LLM seam … not flagged").

## Automated tests
- Unit: registry resolves tiers; timeout aborts; backoff on 429/529 with `Retry-After`; error taxonomy mapping; structured-output validation failure → `LlmInvalidOutput`; no model id outside `llm.ts` (source-scan); no `process.env.ANTHROPIC_API_KEY` outside `llm.ts`/`env.ts`.
- Characterization per migrated module (mocked provider): identical outputs/fallbacks for success, transient failure, invalid JSON.
- Simulated 429 in the outreach drafting path → retried, recipient not dropped (E01 acceptance criterion 3).
- `llm_calls` integration: row per call, retention prunes, RLS (no owner access).
- Evals (Tier 2) per scope 7 — pasted.

## Manual acceptance procedure
1. Builder: `npm run eval` (live, founder key in `.env.local`) before and after; paste per-suite pass counts — no regression.
2. Builder: inject a fake 429 (env-driven test hook in the adapter, dev-only) during a campaign draft → observe retry + success; `llm_calls` shows `attempts=2`.
3. Builder: set `GRADIA_LLM_MODEL` in a production-mode local build → ignored (registry model used); in `EVAL_LIVE=1` → honored.
4. Reviewer (Cursor): confirm prompt files unchanged (diff), model mapping unchanged, and the metering ledger untouched.

## Failure cases
- Provider down → callers see the same degrade behavior as today (classifier default, drafter failure surfaced honestly) + one aggregated SEV-2 alert; no retry storms (cap + jitter).
- `llm_calls` insert fails → best-effort, never blocks the call (like `recordUsage`).
- Streaming abort mid-answer → partial content handled as today.

## Rollback strategy
Revert the commit (call sites return to inline clients). `llm_calls` table stays dormant. No prompt/model change to unwind.

## Definition of done
`../12-definition-of-done.md` plus: eval results before/after pasted; source-scan tests committed; `llm_calls` migration re-run twice + retention verified; `vendors/ai/anthropic.md`, `02`, `15` updated; P0-010 M-1 follow-up recorded as closed at the gateway boundary in `program/backlog.md`.
