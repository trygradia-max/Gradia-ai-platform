# Vendor — Anthropic

> **Classification:** ai · **Status:** strategic · Amended 2026-07-27 (vendor-architecture amendment, D-030/ADR-002). Registry: ../registry.md

_Created 2026-07-25 by the Organizer. Vendor registry entry. Facts grounded in the 2026-07-20 audit (doc 07); unverified items are marked. See `02-target-architecture.md` (LLM seam) and `09-testing-strategy.md` (eval gating)._

## Strategic note (2026-07-27)

Strategic but replaceable behind Gradia-owned abstractions (D-029): AI domains use the centralized **`ModelProvider` AI gateway** — no hardcoded model IDs in application modules; retries, timeouts, costs, latency and failures recorded at the gateway; no core business logic depends on one model provider. The gateway does not exist yet — it is built in E01; until then the ~14-module hardcoding below (grep-verified 2026-07-27) is the documented gap, not the target.

## Purpose
Primary LLM vendor for the chat/agent side of the shared brain: Haiku single-turn workers (classifiers, drafters, extractors, whisper intent) and Sonnet for the one-shot agent planner, the two bounded loops (BI chat MAX 6 turns, owner agent MAX 8 turns), the draft verifier, and the eval judge.

## Data exchanged
Prompts containing shop data, customer messages/transcripts (untrusted inbound content is spliced with `---` delimiters — known injection surface), knowledge chunks, menu prices; structured tool outputs back. Zero-data-retention/DPA status REQUIRES VERIFICATION (Anthropic console/contract).

## Authentication
`ANTHROPIC_API_KEY` (env). Two call styles: `@langchain/anthropic` `withStructuredOutput` for Haiku workers (structured-output convenience only — no framework migration, D-010), raw fetch to `/v1/messages` for Sonnet planner/loops (hand-rolled SSE).

## Webhooks
None.

## Rate limits
API tier limits REQUIRES VERIFICATION (Anthropic console). Gradia-side: rate limits on owner routes (`bi_chat`/`agent_chat`/`whisper` 20/min, `inbound_classify` 400/day) + credit gates fail-closed.

## Failure behavior
**Asymmetric by channel (audit doc 04):** on classifier failure, SMS skips (safe) but email defaults to "is a lead" — an Anthropic outage turns every newsletter into approval cards (polarity fix = E07). Retries exist only in `ai-service.ts` (5 attempts, backoff+jitter) and embeddings; planner/loops/drafters have no retry — a transient 429 mid-audience silently drops recipients (`.catch(() => null)`). No request timeouts (hung fetch rides to Vercel's 60s kill).

## Idempotency
Not applicable at the API level; duplicate LLM spend on webhook replay is a Gradia-side gap (P0-005/006).

## Cost model
Wholesale cost carried per `usage_events` row; retail via the credit menu (outreach draft 1 credit, BI answer 7, whisper note 3, agentic plan 10; inbound classification never metered — pricing doc trust rule). Models: `claude-haiku-4-5-20251001` (workers), `claude-sonnet-4-6` (planner/loops/verifier/judge). Per-step routing = locked principle #7 (cheapest model that clears the bar).

## Monitoring
Credit ledger + prechecks + reconciliation; **no raw token telemetry** (audit doc 03). Spend-spike anomaly detection exists (`monitoring.ts`) but alerts console-only until P0-012.

## Test environment
Tier 1 deterministic tests CI-gated; Tier 2 live-model goldens (`npm run eval`, 7 suites) NOT CI-gated; Tier 3 LLM-judge sparing. Eval gating per locked principle #6 is a P0/P1 obligation (cadence = decision queue).

## Known audit gaps
- **No LLM provider seam** — model ids hardcoded in ~14 modules (grep-verified 2026-07-27); `GRADIA_LLM_MODEL` env override affects production (E01/P1 seam work).
- No retry/timeout on most calls; no fallback model chain.
- Live evals gate nothing in CI (violates locked principle #6 in practice).
- Prompt-injection hardening essentially absent beyond structure (E09).
- ~~Unauthenticated LLM-burning action `processRawLeadNote`~~ — **M-1 closed 2026-08-28 by P0-010** (PR #27: session auth, fail-closed plan/credit gates, `ai_lead` rate bucket, credits=0 metering).

## Backup or exit strategy
No seam today — swapping vendors or upgrading models is a shotgun change across ~14 modules (audit doc 09). The planned `llm.ts` seam (model registry, timeouts, retries, error taxonomy) is the exit-readiness work. Until then: single-vendor concentration is an accepted, documented risk; outage runbook at `runbooks/ai-provider-outage.md`.

## Owner
Founder (Harry).
