# Runbook — Double Billing

_Created 2026-07-25 by the Organizer. Covers (a) double-metered usage — the live defect class: Vapi end-of-call retries double-meter voice minutes because `usage_events` has no vendor_ref uniqueness (**P0-007**), SMS segments can double-meter on webhook echo (**P0-005/006**) — and (b) Stripe-side double charges. Governing invariant: **financial events are immutable and replay-safe (D-024) — correct with compensating entries, never edits.**_

## Trigger / symptoms
- Owner reports credits/minutes draining faster than activity justifies; usage pill vs actual calls don't reconcile.
- Nightly Twilio reconciliation cron (`reconciliation.ts`) reports drift — **note: today that report lands in console logs only (P0-012 gap), so check it manually.**
- Margin report anomaly; Stripe dashboard shows two invoices/charges for one period.

## Severity
- Wrong money movement (Stripe charge duplicated, wrong shop charged): **SEV-0**.
- Metering inflation (credits/minutes over-counted, no card charged yet): **SEV-1** — it becomes real money at the cap (fail-closed lockout) and at pack purchases.

## Immediate containment
1. If a shop is wrongly locked out at its cap: issue a corrective `credit_grants` entry immediately — that restores service without touching the ledger.
2. If a metering source is actively double-writing (webhook retry storm): pause that seam — disable the webhook at the provider console (Vapi dashboard / Twilio console) or flip the owning flag in `features.ts` + redeploy. **Never cut a live call** — budget/containment state applies from the next call (existing invariant).
3. Stripe double **charge**: refund the duplicate in the Stripe dashboard (refund, not invoice edit); the webhook mirrors it into `payments` (refund ≤ amount CHECK exists).

## Diagnosis
- `usage_events`: group by shop/kind/ref-window; duplicates share the same underlying `vendor_ref`/`ref_id` or land seconds apart for one call/message. Cross-check voice against `call_records` (idempotent by `(shop_id, vapi_call_id)` — the count of *records* is trustworthy; the count of *meter rows* is not, pre-P0-007).
- Cross-check Twilio console minutes/segments and Vapi call logs against the ledger (this is exactly what the reconciliation cron does nightly — run its comparison manually for the affected window).
- Stripe: `payments` table is a mirror of paid invoices with a unique `(shop_id, stripe_invoice_id)` — trust Stripe as the source, the mirror for the app view.
- Also verify the RLS posture wasn't the vector: `usage_events`/`payments` are owner-writable FOR ALL today (audit doc 05 weakness 4) — an anomalous row could be session-written. Check row provenance against app logs.

## Recovery
- **Usage over-count:** compensating `credit_grants` (credits) or a minute-pack-equivalent grant (voice). Document the calculation in the grant's reference field. Ledger rows stay untouched.
- **Stripe:** refund via Stripe; confirm webhook wrote the refund mirror.
- Expedite P0-005/007 uniques so replay becomes structurally impossible; tighten ledger RLS to SELECT-only (rides with P0-005 follow-up / `08-security-and-reliability.md`).

## Verification
- Re-run the reconciliation comparison for the window: drift zero (or explained).
- Replay the offending provider event against a test shop: one meter row (P0-007 acceptance).
- Affected shop's balance = ledger derivation (`credits.ts`) matches expected by hand.

## Communication
- Owner gets the honest accounting: what was over-counted, the exact make-good grant, in human units ("~N texts / N minutes") per the pricing doc's copy rules. Same-day for lockouts.

## Postmortem
- Update risk R-05; if detection came from an owner instead of reconciliation, that is a P0-012 alerting failure — record it as such.

## Known gaps
- Reconciliation covers Twilio; Vapi/Anthropic spend reconciliation is thinner — REQUIRES VERIFICATION of current coverage before relying on it.
- Anomaly detection (`monitoring.ts` spend spikes) alerts to console only until P0-012.
- Ledgers being owner-writable (RLS FOR ALL) undermines "immutable" until tightened — treat provenance checks as mandatory in every money incident until then.
