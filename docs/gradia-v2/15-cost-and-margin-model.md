# 15 — Cost & Margin Model

_Created 2026-07-25 by the Organizer. Condensed operating view of Gradia's unit economics. **`_docs/GRADIA_PRICING.md` (locked 2026-06-11, reframed 06-15) remains the SKU/price/margin source of truth** — this doc summarizes it, adds the vendor cost-driver view, and records the D-005 trial economics frame. On any numeric conflict, GRADIA_PRICING.md wins unless the decision log amends it._

> **⚠ Re-pricing RESOLVED at the decision layer (D-034/D-035, 2026-08-28) — implementation pending (P0-013).** Public/forward pricing: **Core $99 (7,000 credits) / Pro $149 (6,000 credits + 100 min, adds voice + earned autonomy) / Operator $249 (10,000 credits + 180 min, adds team seats)**; trial = 14 days from activation, card-to-convert, 500 credits + 15 min. Full model: rewritten `_docs/GRADIA_PRICING.md` (2026-08-28). The §1–§3 tables below still describe the **$20/$29 model that live billing charges today**, until P0-013 ships. New-tier worst-case margin floors ≈ 76–77%. C-14 narrows from "contradiction" to "implementation lag".

## 1. Packages & meters

| SKU | Price | Includes |
|---|---|---|
| Core (Package 1) | $20/mo | Gradia Agent + Whisper + Ask Gradia + CRM/calendar/approvals; **1,200 credits/mo** (1 credit = 1¢ retail) |
| Voice + Chat Autopilot (Package 2) | +$29/mo | Voice receptionist + business number + **60 voice minutes/mo**; autonomous chat agent + Autonomous mode |
| Credit pack | $10 / 950 credits | Same margin as base |
| Minute pack | $10 / 40 minutes | — |

Two meters, never crossing: message credits vs voice minutes. Rollover: up to 25% of unused included credits roll one month. Full stack = $49/mo. No founding pricing, no lifetime discounts (D-003); full public pricing (D-004).

## 2. Credit menu (retail)

SMS segment 4 · Email send 1 · Outreach draft (Haiku) 1 · BI answer 7 · Whisper note 3 · Agentic-mode plan 10 · **Inbound classification, approvals, CRM, calendar, KB ops = 0, never metered** (trust rule: never charge for plumbing the owner didn't initiate). Voice minute ≈ 12¢ wholesale all-in, on its own meter.

## 3. Margin rules (do not drift)

1. Every credit/minute retail-priced at **~3.3× wholesale** → ~70% margin on usage.
2. Included allowance retail value ≈ 70% of plan price → even at 100% burn, plan margin ≥ ~67% after fixed costs.
3. Floors: Core $20 → max COGS ≈ $5.50 (~72% floor) · Package 2 $29 → max COGS ≈ $9 (~69% floor).
4. Verification: per-shop gross margin report from `usage_events` (every row carries wholesale_cost + retail_cost); price changes go through `pricing_config`, never code.
5. Per-shop fixed costs: A2P ~$2/shop/mo, infra ~$0.50/shop/mo.

## 4. Enforcement machinery that already exists (audited)

- **Ledger-derived balance** — `credits.ts` derives from append-only `usage_events`; no stored balance to drift.
- **Fail-closed gates** — staging, autopilot execution, cron entry, and voice all check credits first; at cap: outbound blocked, runtime refuses, inbound voice degrades to take-a-message. **Never cut a live call** — budget state flips the next call.
- **Entitlements** — Package-2 gating in `entitlements.ts`/`autonomy.ts` (drop Package 2 → everything reverts to suggest-first).
- **Reconciliation** — nightly Twilio vendor reconciliation cron; margin report endpoint (CRON_SECRET-gated).
- **Warnings** — 80% usage warning + top-up offer with ROI framing; owner-set auto-top-up ceiling.
- ~~Known leak: metering not idempotent on webhook retry (double-billing voice minutes)~~ — **closed 2026-08-14**: P0-005 ledger unique + P0-007 Vapi route wiring (PR #21); replays are proven no-ops. `recordUsage` now reports `written`/`duplicate`/`failed` and the webhook paths that need durable metering fail closed and retry (P0-006/P0-007); silent-free-usage alerting for remaining best-effort callers still lands via **P0-012**.

## 5. Trial economics (D-005)

**Full operational trial with controlled variable-cost allowances**: trial shops get the real product (D-005) including real imports (D-006), with variable costs capped by trial allowances enforced through the existing fail-closed credit/minute machinery — the same rails as paid caps, smaller numbers.

- Worst-case trial COGS = trial credit allowance × wholesale + trial minutes × ~12¢ + fixed onboarding costs (A2P registration timing is a design point — registering during trial spends ~$2 + carrier fees per shop that may not convert).
- **Numbers set by D-035 (2026-08-28, resolves Q-13):** 14 days from activation (gate: import committed OR service menu + calendar connected), card optional to start / required to convert, 500 credits + 15 voice minutes, number only after card on file. Worst-case trial COGS ≈ $5/shop.
- This supersedes the pre-trial "free = explore only" paywall posture in GRADIA_PRICING §Paywall (recorded as contradiction C-04 in `16-document-source-map.md`); GRADIA_PRICING needs a trial amendment once Q-13 resolves.

## 6. Vendor cost drivers

| Vendor | Driver | Metered today? | Notes |
|---|---|---|---|
| Anthropic | Haiku workers (classify/draft/extract), Sonnet planner + agent/BI loops + verifier | ✅ credits per action type | Per-step routing: cheapest model that clears the bar (locked principle #7) |
| OpenAI | Embeddings (`text-embedding-3-small`), Whisper STT | Whisper → credits; embeddings unmetered (cost noise) | Embedding dim baked into schema — vendor swap = migration (audit doc 09) |
| Twilio | SMS segments, numbers, A2P fees, subaccounts | ✅ per-segment metering + reconciliation | A2P ~$2/shop fixed; status-callback bug closed (P0-008, 2026-08-25) |
| Vapi | Voice minutes (hosts STT/LLM/TTS) | ✅ minutes meter | ~12¢/min wholesale all-in; double-meter risk closed (P0-007, 2026-08-14) |
| Aurinko | Email + calendar API | Email sends → credits | Per-account subscription cost — verify current rate in `vendors/transitional/aurinko.md` |
| Stripe | Platform billing fees; Connect fees at E05 | n/a (COGS on revenue) | Connect economics get modeled in the E05 epic before build |
| Supabase | DB/storage/auth | No (infra fixed) | In the ~$0.50/shop infra estimate; verify plan headroom at scale |
| Vercel | Compute/functions/crons | No (infra fixed) | Same bucket |

## 7. Cost-control invariants

1. Caps **fail closed** everywhere; no unmetered outbound paths (the one metering skip found — approval-time send skipping cap re-check — is tracked in backlog).
2. **Never cut a live call**; degrade at the next call.
3. Owner-set ceilings are the owner's cap, enforced by machinery, not honor.
4. Every `usage_events` row carries wholesale + retail cost so margin is queryable per shop, per kind, per period.
5. Global backstop: `GLOBAL_DAILY_COST_CEILING_CENTS` must be set in prod (P0-010 documents it).
6. Pricing changes go through `pricing_config` + GRADIA_PRICING amendment + decision-log entry — never a code constant.

## 8. Open items (from GRADIA_PRICING + this doc)

- [ ] Q-13: trial allowance numbers + card policy (founder).
- [ ] Verify Stripe Billing products/prices match SKUs in prod (founder-ops).
- [ ] Update `_docs/cost-model.html` default config to the 1,200-credit structure.
- [ ] Model Stripe Connect take-rate/fees for E05 before P5 build.
- [ ] Aurinko per-account cost verification (`vendors/transitional/aurinko.md`).
