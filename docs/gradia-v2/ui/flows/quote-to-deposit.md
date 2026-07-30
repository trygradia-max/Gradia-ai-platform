# Flow — Quote to Deposit

_Created 2026-07-25 by the Organizer. Quote lifecycle grounded in audit trace C; deposits are net-new on Stripe Connect (D-019, existing flagged-off Connect foundation)._

**Maturity:** TARGET — quoting EXISTS end-to-end (builder → pure pricing → send via HITL → public `/q/[token]` accept), but there are no deposits or customer payments today (Stripe Connect flag off). P0-009 repairs (lead linkage, status closure, expiry) land before deposits build on top.
**Phase/Epic:** E05 / P5.

## Entry point
Quote builder from a lead/customer file; or voice `propose_quote` (ALWAYS-HITL); or Gradia Agent on request.

## User objective
Send a professional quote and collect a deposit that commits the customer — high-ticket work (coating/PPF/tint) stops evaporating.

## Required data
Customer, service line items (size-class pricing + condition multipliers), vehicle (for sizing), deposit policy (percent or fixed — per-shop setting, target), `valid_until`.

## Exact steps
1. Owner builds the quote → pure pricing (`quotes.ts`/`service-pricing.ts`) → draft with DB-generated public token.
2. Send → staged as standard send action, executed as owner (A2P/quiet-hours/opt-out apply) → status `sent`, pipeline auto-moves to `quote_sent`.
3. Customer opens `/q/[token]` → first view stamps `viewed`.
4. **(P0-009)** Expired quotes refuse acceptance with an honest state; acceptance resolves the existing lead and closes the quote toward booked.
5. **(TARGET)** Accept screen shows deposit requirement → Stripe Checkout (Connect, on the shop's connected account) → payment succeeds.
6. **(TARGET)** Deposit recorded as an immutable payment event (D-024), keyed by Stripe event id (idempotent, D-023); booking staged with the deposit noted on the approval card.
7. Owner approves booking (calendar write = ALWAYS-HITL) → appointment created; remaining balance tracked toward invoicing (E05).

## System decisions
- Deposit rules deterministic per shop settings; no AI decides amounts.
- Refund policy honored via Stripe; refunds recorded as new immutable events, never edits (D-024).
- Quote follow-up sweeps (day 2/5/12) continue until accepted/expired/lost.
- High-ticket threshold actions require approval regardless of mode (D-021).

## AI involvement
Suggest-HITL: draft quote messages and follow-ups. Deposit collection itself has no AI involvement; money ALWAYS asks.

## Permissions
Owner today. Post-E01: quote creation per role; deposit/refund actions restricted to owner/admin.

## Error states
- Payment failure → customer sees retry with support copy; no booking staged; quote stays accepted-pending-deposit.
- Stripe Connect account not onboarded → deposit step hidden, quote falls back to accept-without-deposit; owner prompted to finish Connect onboarding.
- Webhook not received → reconciliation marks pending; never double-counts on retry (provider event id unique).

## Empty states
- No quotes yet: "No quotes yet. Build one from any lead — pricing comes from your menu."

## Success state
Quote shows accepted + deposit paid (amount traced to a real payment row); booking approved; upcoming revenue on Home shows it in the **booked** bucket, never blended.

## Next recommended action
Approve the booking (if not yet), schedule the job, arm the reminder ladder.

## Mobile behavior
Public quote page is customer-facing mobile-first (view, accept, pay in one column); owner-side builder usable on phone with line-item cards.

## Analytics events
`First quote sent`, `First payment collected` (first deposit), `First appointment booked` (when the deposit-backed booking confirms).
