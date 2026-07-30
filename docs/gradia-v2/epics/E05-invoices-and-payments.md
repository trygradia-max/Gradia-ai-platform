# E05 — Invoices and Payments

_Created 2026-07-25 by the Organizer. Phase: **P5**. Status: planned._

## Objective

Let shops collect money through Gradia: quote deposits and job invoices on Stripe Connect (D-019), with payment records immutable and replay-safe (D-024), and every money action inside the ALWAYS_HITL floor (D-021).

## User outcome

A detailer sends a quote with a deposit link; the customer pays; the deposit shows on the quote and the job. After the job, one tap sends an invoice; payment lands, is recorded forever, and reconciles to the penny. Refunds are explicit, partial-capable, and auditable.

## Business reason

Money collection is the largest missing limb of the "operating system" scope (D-001) and the stickiest retention feature. The foundation already exists flagged-off (Stripe Connect flow, audit doc 03 "Payments: Connect flag off"), and the platform's own billing stack proves the team can run money safely. Deposits also cut no-shows — a direct, sellable ROI.

## Current foundation

- Platform-side Stripe maturity: webhook lifecycle, `payments` mirror with `(shop_id, stripe_invoice_id)` unique, ledger-derived credits, nightly reconciliation (audit doc 00 — "billing loop is beta-grade").
- Flagged-off Stripe **Connect** onboarding flow (`/api/stripe/connect/*`, gated by middleware 404s since MVP Phase 0).
- Quotes with public accept page + line items in cents; jobs with `payment_status` columns; P0-009 fixed quote↔lead linkage.

## Missing work

1. Connect onboarding: per-shop Express account, ConnectionTile status, payout visibility.
2. Deposit on quote: owner sets deposit (fixed/%) → public quote page collects via Checkout/PaymentIntent → deposit recorded, quote state advances (`ui/flows/quote-to-deposit.md`).
3. Invoices: generate from job line items; send link via existing SMS/email HITL path; partial payments; receipts.
4. `customer_payments` ledger (distinct from platform `payments`): append-only, provider-event-idempotent (P0-005 pattern), SELECT-only RLS from day one (the `credit_grants` pattern — audit doc 05 §weakness 4).
5. Refunds: HITL-staged action type in the approval engine (extends the 11-type enum).
6. Reconciliation sweep for Connect events (reuse nightly-reconciliation pattern).
7. Whisper/agent verbs ("charge her $450") stage payment requests — never execute (PROJECT_BRIEF's Whisper-billing vision returns, HITL-safe).

### Payments parity annex (added 2026-07-27 — each item owned)

| Item | Owner |
|---|---|
| **Standalone invoices** (no job/quote anchor) | **Build before E05 exit** — founder-required parity; anchored invoices ship first, standalone follows within the epic (see Non-goals amendment) |
| Tips | **Build in E05** — a Checkout option, cheap once invoices exist |
| Payment reminders (unpaid invoice follow-up) | **Build in E05** — rides the existing HITL send path |
| Failed-payment handling (customer payment declines) | **Build in E05** — honest status + retry link; membership dunning stays E06 |
| Saved payment methods (card on file via Stripe) | **Deferred → E06** — becomes necessary with membership billing; earlier it's surface area without demand |
| Account credit (customer balance) | **Deferred → E06-era** — meaningful with memberships/fleets; modeled as ledger rows, never a mutable balance |
| Fleet net terms + batch invoicing | **E06** (already owned there) |
| Gift cards | **Delayed indefinitely** — master spec: "later when justified"; no epic owns it until demand exists |
| Accounting integration | **Delayed** — `vendors/planned-evaluations/accounting.md` |

## Domain entities

New: `customer_payments`, `invoices`, `invoice_line_items` (or jsonb + constraints — ADR), deposit fields on `quotes`. Modified: `appointments.payment_status` wired to real events.

## Backend services

`src/lib/connect.ts` (or extend `stripe.ts` behind a clear boundary), invoice module, refund executor in `approvals.ts`, Connect webhook route (signature-verified, idempotent).

## UI surfaces

Settings/Numbers & Billing: Connect onboarding tile; quote builder deposit control; public quote page payment step; job detail payment panel + invoice send; Approvals: payment/refund cards; customer file payment history.

## Integrations

Stripe Connect (Express). Platform billing and shop money never mix accounts; two meters/ledgers stay separate. This epic formalizes **`PaymentsProvider`** (D-029); Stripe Connect remains the first customer-payment architecture (D-019) — Square is a later planned evaluation (`vendors/planned-evaluations/payment-pos.md`) for import/POS sync, never a Connect replacement.

## Security implications

Highest-stakes epic: PCI stays on Stripe (Checkout/Elements only — card data never touches Gradia); Connect webhooks signature-verified + idempotent from day one; refunds owner/admin-only (E01 roles); public payment surfaces rate-limited + token-hardened (extends the P0-009/L-3 quote-token work); ALWAYS_HITL floor extended to every new money action type with locking tests (D-012/D-021).

## Tenant implications

Connect account id per shop (in `shop_connections`); `customer_payments` shop-scoped, SELECT-only to sessions; cross-shop payment misroute = SEV-1 class (runbook `runbooks/double-billing.md`).

## Migration implications

Additive tables with DB constraints for durable invariants (amount > 0, refund ≤ captured — mirroring existing `payments` CHECKs). No retirement. One database-sensitive + high-risk ticket at a time (WIP rule binds hard here).

## Product analytics

Lights up: `First payment collected`. Improves `Trial converted` correlation analysis (payments = strongest activation signal).

## Dependencies

E01 (roles — hard), P0-005 (idempotency pattern — hard), P0-009 (quote linkage — done in P0), E04 helpful (invoices from jobs) but quote deposits can precede E04 completion. **Transaction-boundary prerequisite (added 2026-07-27):** the atomic-write mechanism for multi-step financial flows is chosen (ADR) and test-proven before the first Connect ticket merges — `08-security-and-reliability.md` §Transaction boundaries. Decisions: D-019/D-021/D-024 approved; high-ticket approval threshold (Q-11); platform fee on Connect payments? (decision queue Q-18).

## Risks

- Money bugs are trust-fatal and regulator-adjacent: test-mode-only until the full failure-path suite passes; reconciliation before GA.
- Connect onboarding friction (KYC) at a bad moment in the funnel — make it deferrable, never a setup-wizard blocker.
- Refund/dispute flows are where immutability designs usually crack — model disputes as new events, never edits (D-024).

## Non-goals

No BNPL/Gradia Pay (historical Phase-3 vision — rejected for now), no card-present/terminal hardware, no autonomous money actions ever (D-021 floor), no second processor. **Amended 2026-07-27:** the former "no invoicing without a job/quote anchor" non-goal is retired — standalone invoices are founder-required operational parity; the epic sequences anchored invoices first, standalone before exit (parity annex above).

## Feature flags

`FEATURES.customerPayments` (master), `FEATURES.quoteDeposits`, `FEATURES.jobInvoices` — separately flippable, all default off until pilot sign-off.

## Testing requirements

Idempotency replay tests on every Connect event type; failure-path tests (payment fails, webhook late, partial refund, dispute); immutability tests (no UPDATE path exists for `customer_payments`; RLS SELECT-only verified); permission tests (tech cannot refund); locking test: new money action types in ALWAYS_HITL; reconciliation drift test; E2E in Stripe test mode: quote→deposit→job→invoice→refund.

## Rollout plan

Test-mode internal shop → 2–3 pilot shops live-mode with daily reconciliation review → flag default-on. Marketing claims stay off until GA (WHAT_GRADIA_DOES §3 line retires only then — C-05).

## Acceptance criteria

1. Quote deposit collected end-to-end in test mode; quote/job/pipeline states all advance; no duplicate lead (P0-009 holds).
2. Invoice sent, paid, receipted; partial payment handled; refund staged HITL, executed, reconciled.
3. Replaying every Connect webhook twice produces exactly one ledger row (D-023/D-024).
4. `customer_payments` has no update/delete path (schema + RLS + test proof).
5. Nightly reconciliation reports zero drift across a pilot week.
