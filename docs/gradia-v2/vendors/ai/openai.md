# Vendor — OpenAI

> **Classification:** ai · **Status:** strategic · Amended 2026-07-27 (vendor-architecture amendment, D-030/ADR-002). Registry: ../registry.md

_Created 2026-07-25 by the Organizer. Vendor registry entry. Facts grounded in the 2026-07-20 audit (doc 07); unverified items are marked._

## Strategic note (2026-07-27)

Strategic but replaceable behind Gradia-owned abstractions (D-029): LLM/STT use go through the **`ModelProvider` AI gateway** (built in E01 — no hardcoded model IDs in app modules; retries/timeouts/costs/latency/failures recorded; no core logic on one model provider). Embeddings are the acknowledged exception — schema-coupled (1536-dim), hardest exit in the AI layer; any migration requires a re-embed strategy first. The voice `gpt-4o-mini` sits behind the Vapi assistant config (VoiceProvider side), not this gateway.

## Purpose
Three distinct uses: (1) embeddings — `text-embedding-3-small`, 1536 dimensions, baked into the `interactions`/`shop_knowledge` vector columns and HNSW indexes; (2) Whisper STT for Gradia Whisper voice notes (`/api/whisper/process`); (3) `gpt-4o-mini` as the voice LLM — configured on the Vapi assistant, billed/managed through Vapi, not called directly by Gradia for voice.

## Data exchanged
Interaction/knowledge text for embedding; owner voice-note audio for transcription. Retention/DPA status REQUIRES VERIFICATION (OpenAI dashboard/contract).

## Authentication
`OPENAI_API_KEY` (env; GO_LIVE_CHECKLIST notes it was rotated once — confirm prod holds the rotated value). Raw fetch calls (no SDK framework).

## Webhooks
None.

## Rate limits
REQUIRES VERIFICATION (OpenAI dashboard). Gradia-side: whisper route is session-authed, credit-gated fail-closed, rate-limited 20/min.

## Failure behavior
Embeddings are best-effort — an interaction row survives embed failure (memory degrades, doesn't error); knowledge search fails silently to `[]`; drafting context uses the non-embedding path so grounding survives an embeddings outage (audit doc 07). Embedding calls have retry with backoff; Whisper STT failure surfaces to the whisper route.

## Idempotency
Not applicable at API level; re-embedding is safe (overwrite).

## Cost model
Embedding + STT wholesale costs ride the usage ledger where metered (whisper note = 3 credits retail). Exact per-unit tariffs REQUIRES VERIFICATION.

## Monitoring
Same as Anthropic: credit ledger, no raw token telemetry, console-only anomaly alerts until P0-012.

## Test environment
Live behavior CANNOT_VERIFY locally (audit doc 03); no OpenAI-specific eval suite noted.

## Known audit gaps
- **Embedding vendor + dimension baked into the schema** — a model/vendor migration requires a column migration + re-embed pipeline that doesn't exist (audit doc 09, rewrite-risk #4).
- No provider seam for embeddings/STT (same LLM-seam gap as Anthropic).
- Two clock conventions nit (MCP counters UTC vs quiet-hours shop timezone) unrelated but nearby in the audit.

## Backup or exit strategy
Embeddings: hardest exit in the AI layer — schema-coupled; exit requires new column, dual-write/backfill re-embed pipeline, index rebuild. STT: contained (one route). Voice `gpt-4o-mini`: swap happens at the Vapi assistant config, behind the voice seam. Accepted risk; the future LLM/embedding seam should include a re-embed strategy before any migration is attempted.

## Owner
Founder (Harry).
