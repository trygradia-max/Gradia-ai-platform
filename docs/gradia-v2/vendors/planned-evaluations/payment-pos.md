# Planned Evaluation — Payment / POS Synchronization (Square)

_Created 2026-07-27 (vendor-architecture amendment). Planning only — no vendor is selected or installed. Adoption requires the 17-point checklist in `../README.md` incl. founder approval._

## Why this evaluation exists

**Stripe Connect remains the first customer-payment architecture (D-019) — this evaluation never replaces it.** Many detailing shops already run Square (or similar POS) for in-person payments; that reality creates four distinct, separable needs worth evaluating **later**:

1. **Customer import** — Square's customer directory as a migration source (through the D-022 import standard: staging → mapping → preview → validation → error report → rollback).
2. **Payment-history import** — past transactions to seed lifetime value, `last_transaction_at`, and lifecycle/win-back fuel (the TCPA 18-month gate keys off transaction recency — imported history makes recovery materially better).
3. **POS synchronization** — ongoing sync of in-person Square payments into Gradia so revenue reporting isn't blind to walk-in volume.
4. **Payment processing via Square** — only if real customers explicitly demand Square over Stripe Connect; not a goal.

## Requirements

- Import paths (1–2) meet the full D-022 import bar; imported payments land as **immutable records clearly marked by source** (D-024) and never mix into Gradia's own `payments` mirror of Stripe invoices without provenance.
- Sync (3) is one-way inbound, idempotent on Square's payment identifiers (D-023); duplicate-safe against a customer paying a Gradia invoice AND appearing in POS data (dedupe rules to be designed).
- Webhook signature verification per the existing four-webhook pattern; retry/replay behavior **requires verification**.
- OAuth per shop, encrypted tokens; rate limits **requires verification**.
- Cost: Square API access pricing **requires verification**.

## Current state in Gradia

No Square references anywhere. Payment collection from customers does not exist yet at all (E05). The recovery import pipeline (mbox/CSV/vCard) is the closest existing machinery and the natural home for needs 1–2.

## Gradia-owned boundary

`PaymentsProvider` stays Stripe-first (D-019/ADR-002); Square import/sync enters as a connector in the customer-integration pattern (`CRMConnector`-style) — **not** as a second payments provider unless need 4 is ever proven.

## Trigger / timing

**Post-E05.** Needs 1–2 could be evaluated alongside E03's import wizard if pilot shops arrive with Square data (record demand in `../../customer-feedback/`); needs 3–4 strictly after E05 stabilizes. Context only: Q-18 (platform fee on Connect) is a separate open question and unaffected by this evaluation.

## Candidate options (not selected)

Square APIs (customers, payments, webhooks) · CSV export from Square through the existing structured-CSV importer (zero-vendor stopgap — consider first for need 1).

## Open questions → decision queue

New queue item at evaluation time (Square connector scope: import-only vs ongoing sync) · dedupe policy between POS payments and Gradia invoices (E05-era design) · whether payment-history import rides E03's wizard early.
