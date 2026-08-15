# Runbook — Double Billing

_Created 2026-07-25 by the Organizer. Covers (a) double-metered usage — originally the live defect class: Vapi end-of-call retries double-metered voice minutes, SMS segments could double-meter on webhook echo — and (b) Stripe-side double charges. Governing invariant: **financial events are immutable and replay-safe (D-024) — correct with compensating entries, never edits.**_

> **Status update (P0-007 close, 2026-08-14):** the metering defect class is structurally closed. P0-005 (PR #17) put the `usage_events (shop_id, kind, vendor_ref)` partial unique at the DB; P0-006 (PR #19) made Twilio inbound replay-safe; **P0-007 (PR #21) made the Vapi end-of-call report replay-safe** — `provider_events` claim after authentication, one `voice_minute` row per call (`vendor_ref = vapi_call_id`), transcript idempotent, `recordUsage` failure retryable/fail-closed. A replayed provider event now returns `duplicate:true` with zero ledger deltas (founder-acceptance-proven, including post-restart durability). This runbook remains the response for: Stripe-side double charges, the un-deduped Vapi tool-call surface (backlog follow-up), Aurinko email, and any anomaly that slips past the constraints.

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
- `usage_events`: group by shop/kind/ref-window; duplicates share the same underlying `vendor_ref`/`ref_id` or land seconds apart for one call/message. Cross-check voice against `call_records` (idempotent by `(shop_id, vapi_call_id)`; since P0-007 the meter-row count is also constraint-protected — a duplicate here means something bypassed both the claim and the unique, treat it as its own defect). Cross-check `provider_events` receipts: one `(provider, event_id)` row per logical event.
- Cross-check Twilio console minutes/segments and Vapi call logs against the ledger (this is exactly what the reconciliation cron does nightly — run its comparison manually for the affected window).
- Stripe: `payments` table is a mirror of paid invoices with a unique `(shop_id, stripe_invoice_id)` — trust Stripe as the source, the mirror for the app view.
- RLS posture: since P0-005 (2026-08-13) `usage_events`/`payments`/`shop_metrics` are SELECT-only for owner sessions — session-written anomalous rows are no longer possible via PostgREST; provenance checks remain useful for service-role paths.

## Recovery
- **Usage over-count:** compensating `credit_grants` (credits) or a minute-pack-equivalent grant (voice). Document the calculation in the grant's reference field. Ledger rows stay untouched.
- **Stripe:** refund via Stripe; confirm webhook wrote the refund mirror.
- ~~Expedite P0-005/007 uniques; tighten ledger RLS to SELECT-only~~ — **done** (P0-005 PR #17 shipped both the uniques and SELECT-only ledger RLS; P0-006/P0-007 wired the routes). If this runbook fires post-2026-08-14, the mitigation is finding the bypass, not adding the constraint.

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
- ~~Ledgers owner-writable (RLS FOR ALL)~~ — closed by P0-005 (SELECT-only, 2026-08-13).
- Vapi synchronous tool-call/function-call events are not replay-deduped (P0-007 covered end-of-call only) — backlog follow-up; staging duplicates there are non-financial (HITL cards), but note them in any incident.
