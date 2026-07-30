# Flow — Trial to Paid

_Created 2026-07-25 by the Organizer. Governed by D-003/D-004/D-005 (no founding pricing; full public pricing; full operational trial with controlled variable-cost allowances) and D-006 (real data import during trial). Supersedes the "free = explore only" posture in GRADIA_PRICING §Paywall for the trial window (source map C-04)._

**Maturity:** TARGET — today `plan=free` can explore but not run agents or send; Stripe Checkout + webhook lifecycle + fail-closed credit machinery all EXIST and are reused. Trial allowance numbers pending decision queue Q-13.
**Phase/Epic:** E03-adjacent commercial work; billing plumbing exists (audit doc 03: subscriptions OPERATIONAL).

## Entry point
Signup → onboarding completes → trial starts automatically (no card required unless the founder decides otherwise — Q-13 includes the card-upfront question); banner + Numbers & Billing page show trial state.

## User objective
Experience the real product — real imports, real sends within allowances, real bookings — and convert without ever hitting a fake wall or a surprise bill.

## Required data
Trial config (length, included allowances in human units, hard caps) from `pricing_config` — never hardcoded; Stripe customer; usage from the `usage_events` ledger.

## Exact steps
1. Trial starts at onboarding completion: full feature access per D-005; allowances stated in human units ("~N texts · ~N calls" — credits in fine print).
2. Owner imports real data (D-006 → `crm-import.md`), connects calendar, runs the product.
3. Metering: every send/run/minute decrements the trial allowance via the existing ledger; pre-run cost estimates shown on campaigns.
4. 80% allowance → warn (in-app + email) with ROI framing from real figures ("Gradia booked N jobs this trial").
5. 100% → fail closed exactly like paid caps: outbound blocked, runtime refuses, voice → take-a-message; **never cut a live call**; CRM/calendar/approvals remain fully usable (D-002 — the non-AI product never locks).
6. Convert: Numbers & Billing → Stripe Checkout (Core $20; Package 2 +$29 offered alongside — both prices always shown together, D-004); webhook flips `plan=active`; allowances become plan credits.
7. Trial expiry without conversion: read-only-plus state — data intact and exportable, sends/agents off, one written path back ("Subscribe to keep working your list"). No data hostage, no deletion.
8. Cancel any time from the billing portal → `Subscription canceled`; same read-only-plus posture; win-back handled honestly.

## System decisions
- No founding/lifetime discounts anywhere in the flow (D-003).
- Trial cost exposure bounded by the existing fail-closed credit machinery + `GLOBAL_DAILY_COST_CEILING_CENTS` (env, P0-010 documents it).
- All prices public and identical to the marketing site (D-004); allowance/pricing values live in `pricing_config`, never code.
- Subscription lifecycle idempotent on Stripe event ids (already the strongest idempotency in the system).

## AI involvement
None in the billing flow itself. Trial AI actions follow normal modes (suggest-HITL default).

## Permissions
Billing actions: owner only (post-E01: owner/billing-admin role).

## Error states
- Checkout abandoned → trial state unchanged; no nagging beyond the standard banner.
- Payment failure post-conversion → `past_due` per existing Stripe webhook handling; grace behavior per pricing doc; fail-closed on caps, never data lockout.
- Webhook missed → reconciliation path; UI never claims paid until the webhook confirms.

## Empty states
- Usage page at zero: "Nothing used yet. Your trial includes ~N texts and ~N minutes — imports and browsing are always free."

## Success state
`plan=active` with the receipt framing ("Gradia answered N calls, booked N jobs — you used N credits"); Package 2 upsell only where relevant and truthful.

## Next recommended action
If converting on Core: pointer to what Package 2 adds (hands-off + phone), anchored to real trial usage. If Package 2: receptionist setup flow.

## Mobile behavior
Checkout and billing portal fully phone-usable (Stripe-hosted); trial banner never blocks content.

## Analytics events
`Trial converted` · `Subscription canceled`. Funnel context: `Account created` → `Business profile completed` → `Import completed` → first-value events → `Trial converted` (funnel defined in 14-product-analytics.md).
