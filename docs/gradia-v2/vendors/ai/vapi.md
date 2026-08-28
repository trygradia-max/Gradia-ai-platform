# Vendor — Vapi

> **Classification:** ai · **Status:** strategic · Amended 2026-07-27 (vendor-architecture amendment, D-030/ADR-002). Registry: ../registry.md

_Created 2026-07-25 by the Organizer. Vendor registry entry. Facts grounded in the 2026-07-20 audit (docs 00, 04-H, 07) and `_docs/GRADIA_TELEPHONY_VOICE_BUILDER_SPEC.md`; unverified items are marked. Runbook: `docs/vapi-go-live.md`. Ticket: P0-007._

## Strategic note (2026-07-27)

Strategic but replaceable (D-029): voice workflows use the Gradia-owned **`VoiceProvider`** boundary (`voice-provider.ts`) — already seamed and disciplined; **preserve it**. Provider-specific IDs (`vapi_call_id`, assistant IDs) stay in call/sync records, never as core-entity identifiers. Provider retries, timeouts, costs, latency and failures must be recorded (P0-007 closes the metering-idempotency half; P0-012 the alerting half).

## Purpose
Hosted voice receptionist engine: Vapi carries telephony, STT, the voice LLM (`gpt-4o-mini` configured on the assistant), and TTS. Gradia synthesizes the assistant prompt server-side from shop data (`vapi-prompt.ts`) and exposes 8 HITL tools via webhook; unification with the chat engine is at the context layer only (locked principle #3).

## Data exchanged
Call audio handled by Vapi; Gradia receives tool calls and end-of-call reports (full transcript turns → `interactions`, matched by phone), call metadata (`call_records`), per-call minutes for metering. Outbound: synthesized system prompt containing shop identity, exact menu prices (shared `service-pricing`), knowledge chunks, hours, escalation rules.

## Authentication
Per-shop `x-vapi-secret` (decrypted, `timingSafeEqual`, env fallback for legacy), fail-closed; shop resolved by `assistantId`. Test-locked by the webhook suite.

## Webhooks
`/api/vapi/webhook` — tool calls (every write staged HITL; booking/quote in the ALWAYS_HITL floor) and end-of-call reports (transcript, metering, budget check, `call_records` upsert).

## Rate limits
REQUIRES VERIFICATION (Vapi dashboard/docs). Gradia-side ceiling: voice-minute budget per shop, fail-closed.

## Failure behavior
Budget at 80% → warn; at 100% → assistant flagged `vapi_stale` and the hourly voice-sync cron PATCHes a take-a-message fallback. **Never cut a live call** — budget state flips the next call (pricing doc invariant). Webhook auth failure → reject.

## Idempotency
**Closed 2026-08-14 (P0-007, PR #21):** the whole end-of-call report is now replay-safe — the route claims `provider_events` (`provider='vapi'`, `event_id=call.id`) strictly after `x-vapi-secret` authentication (ADR-001 C3); transcript ingestion is idempotent; voice minutes carry `vapi_call_id` as `usage_events.vendor_ref` under the P0-005 durable unique, with `recordUsage` failure retryable/fail-closed; route `maxDuration=60` sits strictly below the 300s stale threshold (ADR-001 C5); completed events never reopen. `call_records` upsert remains idempotent on UNIQUE `(shop_id, vapi_call_id)` (and stays best-effort — accepted residual). **Remaining gap:** synchronous tool-call/function-call events are not replay-deduped (backlog follow-up — candidate identity `toolCallId`). Actual Vapi retry behavior still REQUIRES VERIFICATION (audit open question #13), but replay is now structurally a no-op regardless.

## Cost model
Wholesale ~12¢/min all-in (pricing doc). Retail: Package 2 includes 60 min/mo; extra $10/40-minute pack; metered in minutes on its own meter (never crosses with message credits).

## Monitoring
Per-call glass-box records at `/calls/[callId]`; minutes metered into `usage_events`; budget checks in the webhook. Vendor-side monitoring REQUIRES VERIFICATION. Alert delivery ties to P0-012.

## Test environment
Voice builder includes a go-live gate + test call (audit doc 00). Live round-trips (tool-call payload shapes, retry behavior, number-import webhook clobbering) CANNOT be verified locally — audit open question #13; founder acceptance run required before marketing the voice claim (WHAT_GRADIA_DOES "not yet claimable").

## Known audit gaps
- ~~End-of-call double-metering on retry~~ — **closed by P0-007** (2026-08-14, PR #21; see §Idempotency).
- `VAPI_DEFAULT_SHOP_ID` fallback — **code-side prod guard closed by P0-007** (production fails closed for unmatched assistants); the operational must-be-unset verification **done 2026-08-28** — founder confirmed the var ABSENT from Vercel Production at the P0-010 acceptance (audit open question #18 closed).
- Vapi tool-call/function-call events not replay-deduped — recorded P0-007 follow-up (backlog Band 2).
- Vapi tool params are not zod-validated (tolerant string coercion, `vapi-tools.ts:79-91`) — gap-analysis P2 item.
- Voice trusts prompt-only price/policy enforcement — no post-call verifier on what was *said* (E09 voice quote verifier).
- Knowledge text spliced verbatim into the voice prompt (prompt-injection surface, E09).

## Backup or exit strategy
Voice is behind `voice-provider.ts` (locked principle #8) — swap is contained but real (assistant config, webhook contract, telephony wiring). The audit notes a provider change is "a contained but real piece of work." No exit planned.

## Owner
Founder (Harry).
