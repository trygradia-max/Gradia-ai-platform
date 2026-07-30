# Planned Evaluation — Accounting (QuickBooks Online / Xero)

_Created 2026-07-27 (vendor-architecture amendment). Planning only — no vendor is selected or installed. Adoption requires the 17-point checklist in `../README.md` incl. founder approval._

## Why this evaluation exists

Once E05 ships invoices and customer payments (Stripe Connect, D-019), shops will need those records in their books. QuickBooks Online and Xero are the obvious destinations — kept explicitly as **future evaluations, strictly after invoicing and customer payments are stable**. Nothing accounting-related is scheduled before that.

## Requirements

1. **One-way export first** — Gradia invoices, payments, and refunds pushed to the accounting system. **No bidirectional ledger sync**: Gradia's financial records are immutable and replay-safe (D-024); the accounting system is a downstream copy, never a write-back source.
2. **Immutable postings** — corrections flow as compensating entries (credit notes/refund records), mirroring how Gradia itself corrects financial data (D-024, `../../runbooks/double-billing.md`).
3. **Idempotent export** — every posting keyed by Gradia's payment/invoice id (D-023 applied outbound); re-runs never duplicate journal entries.
4. **Mapping** — service categories → income accounts; tax lines and per-jurisdiction tax handling **requires verification** (this is usually the hard part; E05 must first decide what tax data Gradia even records).
5. **Per-shop OAuth** — encrypted token storage (existing AES-256-GCM pattern), reconnect alerts.
6. **Failure behavior** — export failures queue and surface to the owner; books being behind is annoying, silently wrong is unacceptable.
7. **Test environments** — QBO sandbox / Xero demo company availability **requires verification**.

## Current state in Gradia

Nothing. No accounting integration, no invoice object (arrives in E05), no tax model. Platform-side revenue (Gradia's own subscriptions) already lives in Stripe + the `payments` mirror and is out of scope — this evaluation is about the **shop's** books.

## Gradia-owned boundary

An accounting-export connector behind the `CRMConnector`-style integration pattern (D-029): provider ids and cursors live in integration records; Gradia's invoice/payment ids are the identity.

## Trigger / timing

**Post-E05 (P5), demand-driven:** evaluate when paying shops using E05 invoices/payments explicitly request books export (record demand in `../../customer-feedback/`). Not before — building accounting export against an invoice model that doesn't exist yet would be speculative.

## Candidate options (not selected)

QuickBooks Online · Xero · CSV export as the zero-vendor stopgap (may satisfy early demand; consider first).

## Open questions → decision queue

New queue item at evaluation time (QBO vs Xero vs CSV-first) · what tax data E05 records (an E05 design question this evaluation depends on) · whether accountant-facing CSV export lands in E08 reporting regardless.
