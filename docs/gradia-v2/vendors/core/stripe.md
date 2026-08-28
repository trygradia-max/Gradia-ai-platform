# Vendor — Stripe

> **Classification:** core · **Status:** core · Amended 2026-07-27 (vendor-architecture amendment, D-030/ADR-002). Registry: ../registry.md · Stripe Connect remains the first customer-payment architecture (D-019).

_Created 2026-07-25 by the Organizer. Vendor registry entry. Facts grounded in the 2026-07-20 audit (docs 00, 02, 03, 05, 06) and `_docs/GRADIA_PRICING.md`; unverified items are marked. See `15-cost-and-margin-model.md`, epic E05, decision D-019._

## Purpose
Platform billing: Core $20/mo + Package 2 (+$29/mo) subscriptions, credit packs ($10/950 credits) and minute packs ($10/40 min) via Checkout, webhook-driven subscription lifecycle, prorations, rollover grants. _(These are the currently-implemented SKUs; D-031 re-bases forward pricing to three tiers — see contradiction C-14 and Q-22. Do not create new Stripe products from this paragraph.)_ **Stripe Connect** (charging the shop's customers) exists but is flag-gated OFF; D-019 commits customer payments to Connect-first when E05 builds invoices/deposits.

## Data exchanged
Shop subscription state (`shops.plan`, subscription ids), paid-invoice mirror (`payments` table), credit grants (`credit_grants` with `stripe_ref`), checkout sessions. No card data touches Gradia (Stripe-hosted surfaces).

## Authentication
`STRIPE_SECRET_KEY` server-side; webhook signature verification with 5-minute tolerance, fails closed if secret unset (audit doc 06 route matrix). `docs/stripe-go-live.md` is the go-live runbook.

## Webhooks
`/api/stripe/webhook` (648-line route — audit doc 09 flags size): subscription lifecycle + invoice events. Signature-verified, test-locked (forgery/tamper/replay suite).

## Rate limits
REQUIRES VERIFICATION — no Stripe API limit handling established in repo.

## Failure behavior
Webhook fails closed on bad signature/missing secret. Billing gates fail closed at credit cap (paywall behavior per GRADIA_PRICING). Subscription lapse → `past_due`/`free` gating downstream.

## Idempotency
**The house model to copy** (audit doc 02): UNIQUE `(shop_id, stripe_invoice_id)` on `payments`; partial-unique `stripe_ref` on `credit_grants`; rollover grants idempotent. P0-005 extends this pattern to the other providers.

## Cost model
Stripe fees not separately modeled in the pricing doc (margin floors are usage-COGS based); REQUIRES VERIFICATION whether fees are inside the ~70% margin assumption. Prices/SKUs managed via `pricing_config` table, never code (pricing doc rule).

## Monitoring
Nightly reconciliation cron + per-shop margin report from `usage_events` (wholesale vs retail per row). Reconciliation drift alerts are console-only until P0-012.

## Test environment
Stripe test mode assumed for E05 acceptance ("collected end-to-end in test mode" — roadmap). Current test-mode configuration REQUIRES VERIFICATION (Stripe dashboard / `docs/stripe-go-live.md`).

## Known audit gaps
- `payments` RLS is FOR ALL — an owner session could edit its own revenue mirror (should be SELECT-only; rides with P0-005/P0-011 follow-ups, D-024).
- Approval-time send skips the cap re-check (usage metering gap, audit doc 03).
- Webhook route is a god-file candidate (648 lines).
- ~~Whether the five Stripe-related env vars are set in prod REQUIRES VERIFICATION (P0-010).~~ **Verified 2026-08-28 (P0-010 founder acceptance):** `STRIPE_API_BASE` correctly absent; `STRIPE_PRICE_ID` / `STRIPE_PRICE_VOICE_ADDON` / `STRIPE_PRICE_CREDIT_PACK` / `STRIPE_PRICE_MINUTE_PACK` **intentionally absent from Production** — a recorded exception, not a gap: the live code still encodes the legacy $20/$29 SKUs (C-14), so checkout stays fail-closed (proven to throw before any Stripe API call — no session, no charge, no local state change). Do not set them, and do not create placeholder or legacy Price ids, until **P0-013 — Production billing model alignment** (decision-gated on Q-22, launch-blocking before live paid billing) is implemented, reviewed, accepted, and ready.

## Backup or exit strategy
Stripe is the committed processor (D-019 — Connect first; no second processor before it). Financial history is mirrored into Gradia's ledgers (`payments`, `usage_events`, `credit_grants`) which must be immutable and replay-safe (D-024). Exit unplanned; accepted risk.

## Owner
Founder (Harry).
