# Flow — Invoice and Payment

_Created 2026-07-27 by the Organizer (audit correction: the founder master definition requires an invoicing/payment-collection flow; only deposits were specced — `quote-to-deposit.md`). Builds on Stripe Connect (D-019), immutable financial records (D-024), provider-event idempotency (D-023)._

**Maturity:** TARGET — nothing exists today (WHAT_GRADIA_DOES §3 "no invoicing" stays true as a claim until this ships). Deposits are specced separately in `quote-to-deposit.md`; this flow covers invoice-to-paid.
**Phase/Epic:** E05 / P5. Standalone (no job/quote anchor) invoices are phased *within* E05: anchored invoices first, standalone before E05 exit (per the 2026-07-27 E05 amendment — founder parity requirement).

## Entry point
Job completion ("Create invoice" — `job-completion.md` step 6); quote conversion (accepted quote → invoice carrying deposit credit); customer file → New invoice (standalone, later-E05); payment-reminder follow-up.

## User objective
Turn finished work into collected money without leaving Gradia: invoice, payment link, reminders, receipt — deposits and partials netted automatically.

## Required data
Customer (+ billing contact for company accounts), line items (from job/quote or manual), tax rate (per-shop setting), discounts/fees, deposit already collected (netted), tip option (per-shop setting), payment terms/due date.

## Exact steps
1. Owner reviews the drafted invoice (pre-filled from job/quote line items; standalone starts blank) → totals computed deterministically (tax, discount, deposit credit).
2. Send → staged as a standard send action (HITL; money never auto-sends) → customer receives a payment link.
3. Customer opens the public invoice page → pays in full or partially (per-shop partial-payment policy) → optional tip captured at payment.
4. Payment recorded as an immutable event keyed by Stripe event id (D-023/D-024); invoice balance recomputed from the payment ledger, never stored-mutable.
5. Unpaid past-due → reminder ladder (owner-configured cadence) staged through approvals or autopilot per mode; reminders respect quiet hours/opt-out.
6. Paid in full → receipt sent automatically; job/quote records close their financial loop; Home upcoming-revenue moves the amount from booked to collected.
7. Refund (owner-initiated, owner/admin only) → new immutable negative event via Stripe, never an edit; receipt updated.

## System decisions
- Amounts are deterministic from line items + settings; AI never sets a price or issues a refund.
- Failed payment → invoice reverts to unpaid-with-attempt-logged; customer sees retry; owner alerted after N failures.
- Saved payment methods (Stripe customer objects on the shop's connected account) are opt-in by the customer; Gradia never stores card data.
- Gradia subscription billing and shop customer payments remain separate financial domains (separate Stripe contexts) — never mixed in one ledger.
- Fleet/company invoices (batch, net terms, PO field) layer on in E06 — this flow is the substrate.

## AI involvement
Suggest-HITL only: drafting reminder copy and surfacing overdue invoices (Opportunity Engine, E09). Money movement itself has zero AI involvement (locked principle #4).

## Permissions
Owner today. Post-E01: invoice create per role; send/refund/void restricted to owner/admin; techs see job-linked invoice status only.

## Error states
- Stripe Connect not onboarded → invoice can be created but not sent-for-payment; owner prompted to finish Connect onboarding (mirrors `quote-to-deposit.md`).
- Payment failure → retry surface with support copy; no partial state invented; attempt logged.
- Webhook missed → reconciliation marks pending; provider-event unique key prevents double-count on retry.
- Refund exceeding refundable balance → hard-blocked with a named reason.

## Empty states
- "No invoices yet. Finish a job or convert an accepted quote to create your first."

## Success state
Invoice shows paid, every figure traced to immutable payment rows; receipt delivered; collected revenue on Home reflects it in the collected bucket.

## Next recommended action
Schedule follow-up / maintenance reminder (feeds recurring-work setup, E06); request a review (E09 opportunity).

## Mobile behavior
Customer payment page mobile-first (one column, Apple/Google Pay via Stripe). Owner side: create/send/refund fully usable on phone; reminder approvals in the standard mobile approvals loop.

## Analytics events
`First invoice sent`, `First payment collected` (shared with deposits — first ever), `Invoice paid` (with days-to-pay), `Payment failed`, `Refund issued`.
