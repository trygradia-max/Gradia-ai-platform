# Vendor Registry — Consolidated Provider Records

_Created 2026-07-27 by the Organizer (vendor-architecture amendment, D-030/ADR-002). One record per provider; facts drawn from the classified vendor docs (which cite the 2026-07-20 audit) — unknown facts are marked **requires verification**, never invented. Classification model and adoption gate: `README.md`. Boundary rule: D-029 / `../adr/ADR-002-provider-boundaries.md`._

## Summary

| Provider | Classification | Status | Core workflows depend on it? | Replacement difficulty |
|---|---|---|---|---|
| Supabase | core | core | Yes — all data, auth, storage | Very high (platform) |
| Vercel | core | core | Yes — runtime + all 8 crons | Medium (stateless compute) |
| Stripe | core | core | Yes — billing/paywall | High (committed, D-019) |
| Twilio | core | core | Yes — SMS channel + numbers | Medium (seamed) |
| Sentry | core | core | No (observability only) | Low |
| Anthropic | ai | strategic | Yes today — all agent/draft/classify paths | High → Medium after E01 gateway |
| OpenAI | ai | strategic | Partially — embeddings/STT degrade gracefully | Embeddings very high; STT low |
| Vapi | ai | strategic | No — voice is a Package-2 add-on | Medium (seamed) |
| Aurinko | transitional | transitional | **Yes today** — booking hard gate (`approvals.ts:686`) until E02 | Medium-high → Medium after E02 |
| Jobber | customer-integrations | optional | No | Low |
| Housecall Pro | customer-integrations | quarantined | No | None (nothing depends on it) |
| Google Calendar/Gmail (direct) | planned-evaluations | planned | — | — |
| Microsoft Graph/Outlook (direct) | planned-evaluations | planned | — | — |
| Product analytics (category) | planned-evaluations | planned | — | — |
| Transactional email (category) | planned-evaluations | planned | — | — |
| Accounting (QBO/Xero) | planned-evaluations | planned | — | — |
| Payment/POS (Square) | planned-evaluations | planned | — | — |

---

## Supabase

| Field | Value |
|---|---|
| Classification | core |
| Controlled status | core |
| Strategic importance | Foundational — primary data platform (Postgres + pgvector, Auth, Storage); everything else assumes it |
| Current implementation | 28 RLS tables, 54 idempotent migrations, 3 clients (RLS session / service-role / browser-login-only), 2 RPCs, 2 private buckets |
| Capabilities depending on it | Effectively all data-bearing capabilities (04 map #1–#25) |
| Core workflows depend on it | Yes — total |
| Public marketing status | n/a (infrastructure, not a customer-facing feature) |
| Feature flag | none — always on |
| Live-verification status | Live in production; PITR/backup tier, prod C1-migration state **requires verification** |
| Data exchanged | All tenant business data incl. embeddings, encrypted vendor credentials, A2P identity (EIN plaintext — gap), import PII, job photos |
| Credentials used | Anon key + cookies (RLS), service-role key (~29–32 files), **leaked DB superuser URL in git history (C-1 → P0-001)** |
| Webhooks | None consumed |
| Provider event identifiers | n/a |
| Idempotency status | Migrations idempotent; data-layer gaps are Gradia-side (P0-005/006/007) |
| Tenant-isolation considerations | RLS primary for sessions; service-role paths are code discipline only (P0-011 → E01 mechanism) |
| Outage behavior | App-side "pre-C1 tolerance" degrades silently; Supabase-side behavior **requires verification** |
| Failure fallback | None (no secondary datastore); restore runbook `../runbooks/data-restore.md` |
| Monitoring | App-level `monitoring.ts` only (console until P0-012); dashboard alerts **requires verification** |
| Test environment | Real Postgres via Supabase CLI 2.98.2 in the (quarantined) integration tier; staging project **requires verification** |
| Rate-limit considerations | Tier limits **requires verification** |
| Cost model | ~$0.50/shop/mo infra assumption; actual plan **requires verification** |
| Replacement difficulty | Very high — Postgres portable, but Auth/Storage/RLS/pgvector RPCs are a real migration project |
| Alternative providers | Self-hosted Postgres+pgvector / managed Postgres + separate auth — **requires evaluation** |
| Exit strategy | None planned — documented accepted risk |
| Technical owner | Founder (Harry) |
| Product owner | Founder (Harry) |
| Last verified | 2026-07-20 (audit, code-level); live settings **requires verification** |

## Vercel

| Field | Value |
|---|---|
| Classification | core |
| Controlled status | core |
| Strategic importance | Foundational — runtime for the monolith and all scheduled work |
| Current implementation | Next.js 16 app; 8 cron routes registered from `vercel.json`, `Bearer CRON_SECRET` fail-closed; `main` = production |
| Capabilities depending on it | All runtime capabilities; specifically #1 platform, #25 reliability (crons: reminders, no-show, ROI receipt, retention, sweeps, voice-sync, reconciliation) |
| Core workflows depend on it | Yes — hosting + every background sweep |
| Public marketing status | n/a |
| Feature flag | none — always on |
| Live-verification status | Live; plan limits/timeouts, deploy notifications, staging setup **requires verification** |
| Data exchanged | All app traffic; env vars hold every vendor secret |
| Credentials used | Vercel account (founder); `CRON_SECRET` for cron auth |
| Webhooks | None consumed; crons auto-register on deploy |
| Provider event identifiers | n/a |
| Idempotency status | Not provider-side; sweeps rely on Gradia stamps/`trigger_ref` (race-prone — P0-005) |
| Tenant-isolation considerations | Crons run service-role with per-shop loops (discipline — P0-011) |
| Outage behavior | No queue/retry/dead-letter — failed sweep waits for next tick; weekly jobs have no catch-up |
| Failure fallback | None; cron failures alert nowhere until P0-012 |
| Monitoring | Dashboard cron runs; no alerting wired (P0-012) |
| Test environment | Preview deploys (used for recovery smoke); dedicated staging **requires verification** |
| Rate-limit considerations | Function timeout (hung LLM fetch rides to ~60s kill); configured limits **requires verification** |
| Cost model | Inside ~$0.50/shop/mo infra assumption; plan **requires verification** |
| Replacement difficulty | Medium — stateless; re-host + re-create cron schedule; cron coupling shrinks with E10 outbox |
| Alternative providers | Any Node.js host + scheduler — **requires evaluation** |
| Exit strategy | Contained (state lives in Supabase/Stripe); no exit planned |
| Technical owner | Founder (Harry) |
| Product owner | Founder (Harry) |
| Last verified | 2026-07-20 (audit); dashboard config **requires verification** |

## Stripe

| Field | Value |
|---|---|
| Classification | core |
| Controlled status | core |
| Strategic importance | Foundational — all platform revenue; committed first customer-payment architecture (D-019, Connect at E05) |
| Current implementation | Subscriptions (Core $20 / Package 2 +$29), credit/minute packs via Checkout, webhook lifecycle, prorations, rollover grants; Connect built but flag-gated OFF |
| Capabilities depending on it | #23 trial & subscription billing (live); #11 invoices & payments (target, E05); #8 deposits (target) |
| Core workflows depend on it | Yes — paywall/billing; customer payments only from E05 |
| Public marketing status | Pricing is public claim territory (D-004; `_docs/GRADIA_PRICING.md` wins) |
| Feature flag | Paywall active; **Stripe Connect flag OFF** until E05 |
| Live-verification status | Billing live; test-mode config + fee treatment in margins still unverified. The 5 Stripe env vars **verified in prod 2026-08-28** (P0-010 founder acceptance): `STRIPE_API_BASE` correctly absent; the four `STRIPE_PRICE_*` ids **intentionally absent — recorded exception**, checkout fail-closed until P0-013 (Q-22-gated, launch-blocking) lands |
| Data exchanged | Subscription state, paid-invoice mirror (`payments`), grants (`stripe_ref`), checkout sessions; no card data touches Gradia |
| Credentials used | `STRIPE_SECRET_KEY`, webhook secret (fails closed if unset) |
| Webhooks | `/api/stripe/webhook` (648-line route — god-file candidate), signature-verified, 5-min tolerance, test-locked |
| Provider event identifiers | `stripe_invoice_id`, `stripe_ref` — **the house idempotency model P0-005 copies** |
| Idempotency status | Good: UNIQUE `(shop_id, stripe_invoice_id)`; partial-unique `stripe_ref`; idempotent grants |
| Tenant-isolation considerations | Shop resolved from metadata/connect account; `payments` RLS FOR ALL (owner-editable mirror — D-024 fix rides P0-005/011 follow-ups) |
| Outage behavior | Webhook fails closed; billing gates fail closed at cap |
| Failure fallback | Subscription lapse → `past_due`/`free` gating |
| Monitoring | Nightly reconciliation cron + margin report; drift alerts console-only until P0-012 |
| Test environment | Stripe test mode assumed for E05 acceptance; current config **requires verification** |
| Rate-limit considerations | **requires verification** — no API-limit handling in repo |
| Cost model | Fees not separately modeled — whether inside the ~70% margin assumption **requires verification**; SKUs via `pricing_config`, never code |
| Replacement difficulty | High — committed (D-019); Gradia-side ledgers ease audit but not migration |
| Alternative providers | None planned; Square = later POS/import evaluation only, never a Connect replacement |
| Exit strategy | Unplanned; accepted risk; immutable mirrored ledgers (D-024) are the hedge |
| Technical owner | Founder (Harry) |
| Product owner | Founder (Harry) |
| Last verified | 2026-07-20 (audit); dashboard/test mode **requires verification** |

## Twilio

| Field | Value |
|---|---|
| Classification | core |
| Controlled status | core |
| Strategic importance | Foundational — SMS is a core channel; white-label numbers are the Package-2 substrate |
| Current implementation | ISV subaccount model (+ BYO), A2P 10DLC pipeline, one send path with policy, nightly reconciliation; behind `telephony-provider.ts` |
| Capabilities depending on it | #15 communications (SMS), #20 voice receptionist (numbers/telephony), #22 integrations |
| Core workflows depend on it | Yes — inbound/outbound SMS, consent ledger, reminders |
| Public marketing status | SMS claims live; number/receptionist claims gated on the voice acceptance run |
| Feature flag | SMS always on; numbers/A2P ride Package-2 entitlement |
| Live-verification status | Code CANNOT_VERIFY* live locally; **A2P TrustHub SIDs self-declared unverified** (`twilio-a2p.ts:11-15`) — founder registration run pending |
| Data exchanged | SMS bodies + numbers → `interactions`/consent ledger; status callbacks; A2P identity (EIN plaintext gap); encrypted subaccount tokens |
| Credentials used | Per-shop resolution **subaccount → BYO → env master** (`twilio.ts:105-168`); AES-256-GCM at rest |
| Webhooks | `/api/twilio/sms`, `/api/twilio/sms/status`, `/api/twilio/a2p/status`; HMAC-SHA1, timing-safe, fail-closed, test-locked |
| Provider event identifiers | `MessageSid` — inbound deduped via `provider_events` claim after signature verification (P0-006, 2026-08-14) |
| Idempotency status | **Inbound replay-safe as of P0-006 (PR #19)**; **status callbacks correct + naturally idempotent as of P0-008 (PR #23, 2026-08-25)** — subaccount credential resolution fixed, last-write-wins metadata write (test-asserted, no claim needed). Remaining: A2P DB-error retryability (L4 follow-up); Twilio retry behavior itself rides live acceptance |
| Tenant-isolation considerations | Shop by `To` number (inbound) / signed `?shop=` param (status — verification proves possession of that shop's token; lookup/update shop-scoped as of P0-008); service-role path (P0-011 discipline sweep) |
| Outage behavior | Signature failure rejects; send failures roll approval back to pending |
| Failure fallback | Empty TwiML always returned — no auto-reply path exists |
| Monitoring | Nightly reconciliation vs ledger; console-only drift alerts until P0-012 |
| Test environment | Deterministic forgery/tamper/replay suite; live/test credentials **requires verification** (`docs/twilio-go-live.md`) |
| Rate-limit considerations | Carrier/API limits **requires verification**; Gradia-side per-segment metering + credit gate |
| Cost model | Wholesale per segment on every `usage_events` row (~3.3× markup); A2P ~$2/shop/mo; tariffs **requires verification** |
| Replacement difficulty | Medium — seamed; real costs are number portability + A2P re-registration |
| Alternative providers | Other CPaaS (e.g. Telnyx) — **requires evaluation** behind `TelephonyProvider` |
| Exit strategy | Seam makes swap contained; no exit planned |
| Technical owner | Founder (Harry) |
| Product owner | Founder (Harry) |
| Last verified | 2026-07-20 (audit); live A2P/carrier behavior **requires verification** |

## Sentry

| Field | Value |
|---|---|
| Classification | core |
| Controlled status | core |
| Strategic importance | Core observability substrate (errors only today) |
| Current implementation | `@sentry/nextjs` server+edge+client; `tracesSampleRate: 0`; PII off |
| Capabilities depending on it | #25 reliability & observability |
| Core workflows depend on it | No — loss degrades visibility, not function |
| Public marketing status | n/a |
| Feature flag | none — always on |
| Live-verification status | Wired; alert rules, scrubbing config, preview DSN **requires verification** |
| Data exchanged | Exceptions/stack traces; PII scrubbed (config **requires verification**) |
| Credentials used | DSN via env |
| Webhooks | None |
| Provider event identifiers | n/a |
| Idempotency status | n/a |
| Tenant-isolation considerations | Ensure no tenant PII in events — scrubbing config **requires verification** |
| Outage behavior | Capture lost silently; only `[module]` console logs remain |
| Failure fallback | None (structured logging is E10) |
| Monitoring | Sentry IS monitoring — but `monitoring.ts` anomalies/reconciliation/cron failures bypass it (console-only) until P0-012 |
| Test environment | **requires verification** (separate env/DSN for previews) |
| Rate-limit considerations | Event quota **requires verification** |
| Cost model | Inside infra assumption; plan **requires verification** |
| Replacement difficulty | Low — standard instrumentation shape |
| Alternative providers | Any error tracker — contained swap |
| Exit strategy | Contained; no exit planned |
| Technical owner | Founder (Harry) |
| Product owner | Founder (Harry) |
| Last verified | 2026-07-20 (audit); project settings **requires verification** |

## Anthropic

| Field | Value |
|---|---|
| Classification | ai |
| Controlled status | strategic |
| Strategic importance | Strategic but replaceable behind the `ModelProvider` AI gateway (D-029; gateway is E01 work — **does not exist yet**) |
| Current implementation | Haiku workers (`claude-haiku-4-5-20251001`: classify/draft/extract/whisper-intent) + Sonnet (`claude-sonnet-4-6`: planner, BI loop 6-turn, owner loop 8-turn, verifier, eval judge); model IDs hardcoded in ~14 modules (grep-verified 2026-07-27; violates target D-029 state) |
| Capabilities depending on it | #18 Gradia Agent, #15 communications (drafts/classification), #19 Opportunity Engine, #21 earned autonomy, BI |
| Core workflows depend on it | Yes today — with the D-029 target that no core business logic depends on one model provider |
| Public marketing status | n/a (engine, not offer — WHAT_GRADIA_DOES demotes "AI" terms) |
| Feature flag | none globally; per-surface gates (credits, rate limits, Shadow Mode) |
| Live-verification status | Operational; live evals NOT CI-gated (locked principle #6 gap); ZDR/DPA **requires verification** |
| Data exchanged | Prompts with shop data, customer messages/transcripts (injection surface), knowledge, prices; structured outputs back |
| Credentials used | `ANTHROPIC_API_KEY` |
| Webhooks | None |
| Provider event identifiers | n/a |
| Idempotency status | n/a API-side; duplicate spend on webhook replay is Gradia-side (P0-005/006) |
| Tenant-isolation considerations | Prompts assembled from shop-scoped queries; no cross-tenant context paths found in audit |
| Outage behavior | Asymmetric: SMS classify-failure skips (safe); email classify-failure floods lead cards (E07 polarity fix); no retry on planner/loops/drafters — silent recipient drops |
| Failure fallback | None (no fallback model chain); runbook `../runbooks/ai-provider-outage.md` |
| Monitoring | Credit ledger + prechecks; **no raw token telemetry**; anomaly alerts console-only until P0-012 |
| Test environment | Tier-1 deterministic CI-gated; Tier-2 live goldens on-demand; Tier-3 judge sparing (Q-06 sets gating cadence) |
| Rate-limit considerations | API tier **requires verification**; Gradia-side 20/min owner routes, 400/day classify, credit fail-closed |
| Cost model | Wholesale per `usage_events` row; retail via credit menu; per-step routing = locked principle #7 |
| Replacement difficulty | High today (no seam — shotgun change across ~14 modules); Medium after E01 gateway |
| Alternative providers | OpenAI behind `ModelProvider` (D-029) |
| Exit strategy | The E01 AI gateway (model registry, retries, timeouts, cost/latency/failure recording) IS the exit-readiness work |
| Technical owner | Founder (Harry) |
| Product owner | Founder (Harry) |
| Last verified | 2026-07-20 (audit); account tier/DPA **requires verification** |

## OpenAI

| Field | Value |
|---|---|
| Classification | ai |
| Controlled status | strategic |
| Strategic importance | Strategic but replaceable per D-029 — with one hard exception: embeddings are schema-coupled |
| Current implementation | (1) `text-embedding-3-small`, 1536-dim, baked into vector columns + HNSW; (2) Whisper STT for voice notes; (3) `gpt-4o-mini` as the voice LLM configured on the Vapi assistant (managed via Vapi, not called directly) |
| Capabilities depending on it | #18 (memory/knowledge embeddings), #15 (Whisper STT), #20 (voice LLM via Vapi) |
| Core workflows depend on it | Partially — embeddings/knowledge degrade gracefully (best-effort, non-embedding grounding path survives outage) |
| Public marketing status | n/a |
| Feature flag | none — always on where used |
| Live-verification status | Operational; retention/DPA **requires verification**; GO_LIVE_CHECKLIST notes key rotation — prod value confirmation pending |
| Data exchanged | Interaction/knowledge text (embedding), owner voice-note audio (STT) |
| Credentials used | `OPENAI_API_KEY` |
| Webhooks | None |
| Provider event identifiers | n/a |
| Idempotency status | Re-embedding safe (overwrite) |
| Tenant-isolation considerations | Embedding inputs shop-scoped; HNSW indexes are global (ANN recall degrades post-filter at scale — audit doc 05) |
| Outage behavior | Rows survive embed failure; knowledge search falls to `[]` silently; STT failure surfaces to the whisper route |
| Failure fallback | Non-embedding grounding path (`drafting-context.ts`) keeps drafts working |
| Monitoring | Credit ledger; no token telemetry; console-only anomalies until P0-012 |
| Test environment | CANNOT_VERIFY live locally; no OpenAI-specific eval suite |
| Rate-limit considerations | **requires verification**; whisper route 20/min + credit-gated |
| Cost model | Wholesale on ledger where metered (whisper note = 3 credits retail); tariffs **requires verification** |
| Replacement difficulty | Embeddings **very high** (column migration + re-embed pipeline that doesn't exist); STT low; voice-LLM low (Vapi config swap) |
| Alternative providers | Anthropic (via `ModelProvider`); alternate embedding vendors — **requires evaluation** incl. re-embed strategy |
| Exit strategy | Future gateway must include a re-embed strategy before any embedding migration; STT contained |
| Technical owner | Founder (Harry) |
| Product owner | Founder (Harry) |
| Last verified | 2026-07-20 (audit); account settings **requires verification** |

## Vapi

| Field | Value |
|---|---|
| Classification | ai |
| Controlled status | strategic |
| Strategic importance | Strategic voice engine, replaceable behind `VoiceProvider` (`voice-provider.ts` — already seamed, preserve) |
| Current implementation | Hosted telephony/STT/LLM(`gpt-4o-mini`)/TTS; server-synthesized prompt; 8 HITL tools; per-call glass-box records; budget fail-closed |
| Capabilities depending on it | #20 voice receptionist, #15 (call records/transcripts into shared memory) |
| Core workflows depend on it | No — voice is a Package-2 add-on; core CRM/agent runs without it |
| Public marketing status | **Not marketable until the live acceptance run passes** (WHAT_GRADIA_DOES "not yet claimable") |
| Feature flag | Package-2 entitlement gate (voice paths fire only for entitled shops) |
| Live-verification status | Code-complete; live round-trips (tool payload shapes, retry behavior, number-import webhook clobbering) **requires verification** — founder acceptance run |
| Data exchanged | Tool calls + end-of-call reports in (transcripts → `interactions`, minutes → metering); synthesized prompt out (identity, exact prices, knowledge, hours) |
| Credentials used | Per-shop `x-vapi-secret` (encrypted, `timingSafeEqual`, env fallback legacy) |
| Webhooks | `/api/vapi/webhook` — tools (all writes HITL-staged; ALWAYS_HITL floor) + end-of-call |
| Provider event identifiers | `vapi_call_id` — UNIQUE on `call_records`; `usage_events.vendor_ref` unique (P0-005); `provider_events` claim on `(vapi, call.id)` for end-of-call (P0-007, 2026-08-14) |
| Idempotency status | **End-of-call fully replay-safe as of P0-007 (PR #21):** call_records, transcript rows and voice minutes all idempotent under retry; metering retryable/fail-closed. Remaining: tool-call/function-call events un-deduped (backlog follow-up); Vapi retry behavior itself **requires verification** |
| Tenant-isolation considerations | Shop by `assistantId`; `VAPI_DEFAULT_SHOP_ID` fallback **fails closed in production as of P0-007** (unmatched assistant → 404, zero writes); operational must-be-unset check **done 2026-08-28** (P0-010 founder acceptance: var confirmed ABSENT from Vercel Production). Accepted ADR-001 residual: cross-tenant global call-id pre-claim griefing (denial/under-billing only; mitigation follow-up in backlog) |
| Outage behavior | Budget 80% warn / 100% → `vapi_stale` → hourly voice-sync PATCHes take-a-message fallback |
| Failure fallback | **Never cut a live call** — budget state flips the next call (pricing invariant) |
| Monitoring | Glass-box `/calls/[callId]`; minutes metered; vendor-side monitoring **requires verification** |
| Test environment | Builder go-live gate + test call; live behavior CANNOT_VERIFY locally |
| Rate-limit considerations | **requires verification**; Gradia-side per-shop minute budget fail-closed |
| Cost model | Wholesale ~12¢/min all-in; retail 60 min in Package 2, $10/40-min packs; own meter, never crosses credits |
| Replacement difficulty | Medium — seamed but "contained but real": assistant config, webhook contract, telephony wiring |
| Alternative providers | Future voice provider behind `VoiceProvider` — **requires evaluation** |
| Exit strategy | Seam preserved (D-029); post-call verifier (E09) reduces prompt-only-enforcement coupling |
| Technical owner | Founder (Harry) |
| Product owner | Founder (Harry) |
| Last verified | 2026-07-20 (audit); live round-trips **requires verification** |

## Aurinko

| Field | Value |
|---|---|
| Classification | transitional |
| Controlled status | transitional |
| Strategic importance | Transitional connectivity: unified email + calendar API. Kept through stabilization; must remain replaceable behind `CalendarProvider` (D-029). **Load-bearing beyond design intent today** |
| Current implementation | OAuth (CSRF-guarded), encrypted tokens with transparent refresh, email webhook (HMAC-SHA256 + 300s replay window), calendar event CRUD on `"primary"`, `aurinko_event_id` mirrored onto appointments |
| Capabilities depending on it | #9 calendar & availability, #15 communications (email), #22 integrations |
| Core workflows depend on it | **Yes today** — booking hard-requires a connected calendar (`approvals.ts:686-693`); E02/D-013 demotes it to a synchronized mirror |
| Public marketing status | "One connected system" claims OK; no Aurinko-brand exposure (white-label rule) |
| Feature flag | Calendar/email integration gating per `features.ts` integrations block |
| Live-verification status | Operational (pilot); live send/receive + redelivery behavior **requires verification** (audit open question #14) |
| Data exchanged | Inbound email content, outbound approved emails, calendar events, OAuth tokens (AES-256-GCM at rest) |
| Credentials used | Per-shop OAuth tokens, webhook HMAC secret |
| Webhooks | `/api/aurinko/webhook` — shop by `accountId`, own-mailbox copies skipped |
| Provider event identifiers | `aurinko_message_id` (**not deduped — P0-005 foundation**); `aurinko_event_id` (partial-unique on appointments — a **provider-specific ID on a core entity**, to become a sync-record field per D-029/E02) |
| Idempotency status | Email inbound: gap (redelivery duplicates cards); calendar: partial-unique |
| Tenant-isolation considerations | Service-role webhook path — discipline (P0-011) |
| Outage behavior | **Polarity inversion:** classifier failure → every email becomes a lead card (E07 fix); booking fails closed without calendar (runbook `../runbooks/calendar-outage.md`) |
| Failure fallback | None owner-visible; no reconnect alerts (audit: integration-reconnect PARTIAL) |
| Monitoring | None specific; silent-degradation pattern until P0-012 |
| Test environment | Webhook suite deterministic; live behavior CANNOT_VERIFY locally |
| Rate-limit considerations | **requires verification** |
| Cost model | Per-account subscription — rate **requires verification** (`15-cost-and-margin-model.md` open item) |
| Replacement difficulty | Medium-high today (hard booking gate); Medium after E02 (mirror-only role) |
| Alternative providers | Direct Google Calendar/Gmail + Microsoft Graph (`planned-evaluations/`, Q-21) or another unified provider |
| Exit strategy | E02 makes Gradia the appointment source of truth and inserts `CalendarProvider`; Aurinko becomes one adapter; direct providers evaluated post-E02 (Q-21) |
| Technical owner | Founder (Harry) |
| Product owner | Founder (Harry) |
| Last verified | 2026-07-20 (audit); live/redelivery behavior **requires verification** |

## Jobber

| Field | Value |
|---|---|
| Classification | customer-integrations |
| Controlled status | optional |
| Strategic importance | Optional, customer-demand driven. Migration / temporary synchronization / one-way export bridge while Gradia's native CRM (E03+) becomes the system of record. **Never a core dependency** (D-030, Q-20) |
| Current implementation | One-way best-effort push behind `crm-provider.ts`; Jobber mirror ids on Gradia rows; OAuth with CSRF state; token refresh |
| Capabilities depending on it | #22 integrations only |
| Core workflows depend on it | No — push is best-effort; Gradia fully operational without it (seam no-ops cleanly) |
| Public marketing status | Mentionable as an integration; never a headline |
| Feature flag | Feature-flagged/env-gated connection surface (per D-030 direction) |
| Live-verification status | Push verified per `docs/jobber-go-live.md`; sandbox/dev account **requires verification** |
| Data exchanged | Customers/clients + job/booking details outward; Jobber ids mirrored back; no inbound sync |
| Credentials used | Per-shop OAuth tokens |
| Webhooks | None consumed |
| Provider event identifiers | Mirror-id columns; full idempotency contract **requires verification** live |
| Idempotency status | Mirror ids prevent obvious re-creates; unverified beyond that |
| Tenant-isolation considerations | Per-shop tokens; push runs in shop-scoped paths |
| Outage behavior | Failure never blocks Gradia-side actions; silent divergence possible (no reconciliation) |
| Failure fallback | None needed — optional by design |
| Monitoring | None; console-logged at most |
| Test environment | Seam no-op smoke (GO_LIVE_CHECKLIST NEXT-4); live sandbox **requires verification** |
| Rate-limit considerations | **requires verification** |
| Cost model | No direct cost to Gradia; shop owns its Jobber subscription |
| Replacement difficulty | Low — behind `CRMConnector` seam |
| Alternative providers | Gradia's native CRM is the strategy; other CRMs addable behind the seam on demand |
| Exit strategy | Product strategy itself: re-evaluate ongoing sync after operational parity (Q-20); import-from-Jobber goes through the E03 D-022 wizard |
| Technical owner | Founder (Harry) |
| Product owner | Founder (Harry) |
| Last verified | 2026-07-20 (audit); live contract **requires verification** |

## Housecall Pro

| Field | Value |
|---|---|
| Classification | customer-integrations |
| Controlled status | **quarantined** |
| Strategic importance | None established. Quarantine terms (D-030): not publicly marketed, flag stays disabled, **no new product investment**; import-only vs removal decided via ticket `../tickets/P3-001-housecallpro-dependency-review.md` + decision Q-19. Organizer recommendation: *use as an import source or remove after dependency review; do not maintain as a core bidirectional integration without customer demand* |
| Current implementation | Second push target behind `crm-provider.ts`, same shape as Jobber — but **every endpoint shape is an educated guess** (`housecallpro.ts:22,265,435` `TODO(verify)`) |
| Capabilities depending on it | #22 integrations only |
| Core workflows depend on it | No — nothing depends on it (audit; P3-001 re-verifies) |
| Public marketing status | **Never marketed; stays unmarketed** (D-030) |
| Feature flag | Remains disabled (D-030) |
| Live-verification status | **Never verified live** (audit open question #12) — realistic failure mode is "first real use fails" |
| Data exchanged | Same shape as Jobber (clients/jobs out, mirror ids back) — unverified |
| Credentials used | Per-shop OAuth (same pattern as Jobber); live flow **requires verification** |
| Webhooks | None consumed |
| Provider event identifiers | **requires verification** (endpoint shapes unconfirmed) |
| Idempotency status | **requires verification** |
| Tenant-isolation considerations | Same seam pattern as Jobber; included in the P0-011 sweep |
| Outage behavior | Best-effort; never blocks Gradia |
| Failure fallback | Flag the settings card off (gate, don't delete) |
| Monitoring | None |
| Test environment | No live account ever tested; settings card overstates maturity (audit doc 08) |
| Rate-limit considerations | **requires verification** |
| Cost model | No direct cost; shop owns its HCP subscription |
| Replacement difficulty | None — no exit cost, nothing depends on it |
| Alternative providers | n/a — the question is import-only vs removal (Q-19) |
| Exit strategy | P3-001 produces the removal-vs-import-only evidence; ongoing sync only for an explicit paying-customer requirement |
| Technical owner | Founder (Harry) — live verification is a founder-account action |
| Product owner | Founder (Harry) |
| Last verified | 2026-07-20 (audit, code-level); **live: never** |

---

## Planned evaluations (status: planned — no vendor selected or installed)

Minimal records; each has a full evaluation doc in `planned-evaluations/`. All fields not listed: not selected / requires evaluation. Adoption requires the 17-point gate in `README.md`, founder approval included.

| Provider / category | Doc | Purpose of evaluation | Earliest phase |
|---|---|---|---|
| Google Calendar + Gmail (direct) | `planned-evaluations/google-calendar.md` | Direct provider adapter behind `CalendarProvider`, independent of Aurinko (D-029, Q-21) | Post-E02 |
| Microsoft Graph + Outlook (direct) | `planned-evaluations/microsoft-graph.md` | Microsoft calendar/mail capability specified independently (D-014, Q-09/Q-21) | E02 fast-follow or post-E02 |
| Product analytics | `planned-evaluations/product-analytics.md` | Instrument `../14-product-analytics.md` events; own-DB-table option first (Q-12) | P1+ |
| Transactional email | `planned-evaluations/transactional-email.md` | Application-generated email (invites, receipts, alerts) — distinct from connected-mailbox conversations and campaign email | E01 (invites) |
| Accounting (QuickBooks Online / Xero) | `planned-evaluations/accounting.md` | Invoice/payment sync after E05 stabilizes | Post-E05 |
| Payment/POS (Square) | `planned-evaluations/payment-pos.md` | Customer import, payment-history import, POS sync — **never a Stripe Connect replacement** | Post-E05 |
