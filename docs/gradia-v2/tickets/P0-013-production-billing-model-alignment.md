# P0-013 — Production billing model alignment (D-031 three-tier implementation)

## Ticket ID
P0-013

## Epic
E00 — Stabilization (launch gate; cut 2026-08-28 at the P0-010 close)

## Status
**draft — decision-gated.** May not enter implementation until the founder resolves the Q-22 commercial decisions (tier split, allowances, voice/pack disposition, timing, existing-shop treatment) — WIP rule 5 applies. **Launch-blocking before live paid billing activation:** the `STRIPE_PRICE_*` Production env vars stay unset (checkout fail-closed, proven at the P0-010 acceptance) until this ticket is implemented, reviewed, accepted, and ready for Production. Proceeds independently of — and does not block — P0-011/P0-012.

## Priority
P0 band, High. The code, Stripe products, entitlements, credits, margin report, UI copy, and tests all still encode the superseded Core $20 + Voice $29 model (C-14); the approved public lineup is Core $99 / Pro $149 / Operator $249 (D-031). Incorrect live customer charging is a launch-blocking concern; today it is prevented only by the deliberate absence of the price env vars.

## Objective
Re-base the production billing implementation from the legacy two-SKU model (base subscription + voice add-on boolean) to the founder-approved three-tier lineup, end to end: tier identity in the schema, tier-priced Stripe checkout, tier-aware webhook persistence, tier-derived entitlements and allowances, truthful billing UI, and rewritten commercial test locks — without replacing the existing usage/grants ledger.

## User outcome
An owner subscribes to Core, Pro, or Operator at the public price, sees only current pricing everywhere in the product, and gets exactly the entitlements and allowances the founder approved for their tier. No shop can ever be charged under the retired $20/$29 model.

## Current code references
- `src/lib/pricing.ts` `PLAN` — `CORE_PRICE_CENTS: 2000`, `VOICE_PRICE_CENTS: 2900`, `CORE_INCLUDED_CREDITS: 1200`, `VOICE_INCLUDED_MINUTES: 60`, packs 950cr/$10 + 40min/$10, 25% rollover.
- `src/lib/stripe.ts` — `STRIPE_PRICE_ID` base + `STRIPE_PRICE_VOICE_ADDON` second-item checkout; `add/removeVoiceAddonItem`; pack checkout.
- `src/app/actions/billing.ts` — checkout accepts only `includeVoiceAddon: boolean`; `UsageState.plan` typed bare `string`.
- `src/app/api/stripe/webhook/route.ts` — infers `voice_addon` from subscription items; `planFromSubStatus()` maps to `free|active|past_due` only; `handlePlatformRenewal` hardcodes `PLAN.CORE_INCLUDED_CREDITS`.
- `src/lib/entitlements.ts` — `isPaid()` = `plan === 'active'`; `hasPackage2()` = paid + `voice_addon`; consumed by `autonomy.ts:91`, `agent-runtime.ts`, `automations.ts`, `trust.ts`, `credits.ts`.
- `src/lib/credits.ts` / `src/lib/voice-provider.ts` — allowances keyed off `plan === 'active'` + `voice_addon`.
- `src/lib/margin-report.ts` — `planRevenueCents` from 2000/+2900.
- Schema: `shops.plan text CHECK ('free','active','past_due')` (20260601100000), `shops.voice_addon` (20260611110000); **no tier identity anywhere**. (Note: `inbound_classify` IS in the `usage_events` kind CHECK — 20260713130000 widened it; an earlier discovery-report claim to the contrary was false.)
- UI hardcodes prices as strings: `src/app/billing/page.tsx` ("From $20/month", "$49/mo"), `billing-subscribe.tsx` ("Subscribe — $49|$20/month", "+$29/month"), `usage-meters.tsx` ("Add 950 credits — $10", "Add 40 minutes — $10"), `onboarding-launch-steps.tsx`, `voice-builder.ts` error strings, `how-it-works/page.tsx` ("$20/month. No catch."). None derive from `PLAN`; none are test-locked.
- Tests locking the legacy model: `eval/pricing.test.ts`, `credits.test.ts`, `entitlements.test.ts`, `guardrails.test.ts`, `trust.test.ts`, `margin-report.test.ts`, `voice-builder.test.ts`, `telephony.test.ts`, `eval/_owner.ts`, `production-surfaces.test.ts` env list.
- Gaps to close while in there: zero tests on the Stripe webhook handlers (plan transitions, pack grants, rollover) or the checkout server actions; no `past_due` UI state; the "Cancel anytime" public claim has no in-app cancel/portal flow and no `stripe_customer_id` is stored.

## Exact scope
1. Migration: add tier identity to `shops` (recommended: a `tier` column CHECK-constrained to `core|pro|operator`, separate from `plan`, which keeps meaning subscription status) + backfill per the founder's existing-shop decision; rollback file.
2. Replace the two-SKU `PLAN` structure with the founder-approved per-tier structure (prices, included credits, included minutes) in one module; nothing outside it hardcodes a price (D-031 central-configuration clause).
3. Rework `entitlements.ts` to tier-based entitlement functions per the approved feature split; migrate `hasPackage2` consumers; `isPaid` semantics unchanged.
4. Checkout: `startSubscriptionCheckout(tier)`; price id selected from the new per-tier env vars.
5. Webhook: price-id→tier mapping; persist tier on `checkout.session.completed` / `customer.subscription.updated` / `.deleted`; per-tier included credits in `handlePlatformRenewal`; tier upgrade/downgrade transitions; unknown price id → log + no-op (never guess a tier).
6. Credits/minutes: `creditAllowanceThisPeriod` and `voiceBudgetState` read the shop's tier allowances; pack handling per founder decision.
7. Margin report: `planRevenueCents` from tier; floors re-derived per founder numbers.
8. Billing UI: three-tier chooser; all price copy derived from the single pricing source (removes every hardcoded `$20/$29/$49/$10` string, including `how-it-works`); a real `past_due` state; pack buttons per founder decision.
9. `.env.example` + `production-surfaces.test.ts`: new env names documented and locked; retired names removed from both.
10. Rewrite the commercial test locks to the approved numbers; add locks for tier prices, the entitlement matrix, and a source-scan asserting no legacy price literal remains in components; add webhook-handler and checkout-action tests.
11. Docs: founder rewrite of `_docs/GRADIA_PRICING.md` is the implementation act (founder-owned, outside gradia-v2); `15-cost-and-margin-model.md` re-derives floors; decision log + source map close Q-22/C-14.

## Explicit non-goals
- Marketing-site pricing page (separately blocked on Q-22 in `../program/blocked.md`).
- Trial system (Q-13; re-derived against the tiers after this ticket).
- Stripe Connect (charging the shop's customers) — untouched.
- Billing Portal / cancel-flow build — flagged as a gap ("Cancel anytime" claim is currently unbacked); folded in only if the founder says so, else its own ticket.
- Repricing the `pricing_config` usage menu (unit costs orthogonal unless the margin re-derivation changes them).
- Any change to HITL/money-write guardrails or the append-only ledger (`usage_events`/`credit_grants` are tier-agnostic and stay as-is).

## Dependencies
- **Q-22 founder decisions (all four options, plus pack/rollover/voice disposition)** — hard gate; nothing enters implementation before they are recorded in `../11-decision-log.md`.
- P0-010 done (recorded the production env exception this ticket lifts).
- Founder-manual Stripe product/price creation in test + live mode (platform-level setup, allowed once — zero founder-touch principle intact).
- WIP slots: payments high-risk class + database-sensitive (one migration).

## Expected modules affected
`supabase/migrations/*` (one additive migration + rollback) · `src/lib/pricing.ts` · `src/lib/stripe.ts` · `src/app/actions/billing.ts` · `src/app/api/stripe/webhook/route.ts` · `src/lib/entitlements.ts` · `src/lib/credits.ts` · `src/lib/voice-provider.ts` · `src/lib/margin-report.ts` · `src/lib/types/database.ts` · billing/onboarding UI components + `how-it-works` · `.env.example` · the commercial test files listed above.

## Database impact
One additive migration: `shops.tier` (or founder-approved equivalent) + backfill. No ledger schema change. **Occupies the database-sensitive WIP slot.**

## Migration impact
Additive + reversible (down file drops the column). Backfill strategy per the founder's existing-shop decision; grandfathered `plan='active'` shops with `stripe_subscription_id IS NULL` (pilot shops) must keep working under whichever tier the founder assigns.

## API impact
`startSubscriptionCheckout` signature changes from `{includeVoiceAddon}` to a tier parameter. Webhook contract with Stripe unchanged (same event subscriptions); persistence semantics extended.

## UI impact
Three-tier chooser on `/billing`; all price copy re-derived from one source; `past_due` state added; usage meters/pill unchanged in mechanics, re-labeled per tier allowances.

## Permission impact
None beyond existing owner-scoped billing actions.

## Tenant-isolation impact
None new — tier is a per-shop column resolved by the same shop-scoped paths. Webhook continues resolving shops by `client_reference_id` / `stripe_subscription_id`. At least one test asserts a tier change on shop A cannot touch shop B.

## Security impact
Removes the standing risk that setting the legacy env vars would wire live checkout to the wrong commercial model. Fail-closed posture preserved: missing price env vars must still throw before any Stripe API call (keep the P0-010 acceptance property under the new names).

## Idempotency requirements
Webhook handlers stay idempotent across Stripe retries (existing `stripe_ref` unique on grants; period-advance idempotent on invoice id). Tier writes are last-truth-from-Stripe and replay-safe.

## Observability requirements
Structured log on every tier transition and on unknown-price-id webhook events. Margin report remains computable through the cutover (legacy rows stay interpretable).

## Analytics requirements
None new.

## Feature flag
Effectively env-gated: the new `STRIPE_PRICE_*` vars act as the rollout switch — absent = checkout fail-closed (today's proven state), present = live. No separate code flag unless review demands one.

## Automated tests
- Unit: tier price/allowance/entitlement-matrix locks (founder-approved numbers); fail-closed checkout with each env var absent; margin per tier.
- Webhook handler tests (new coverage): checkout-completed per tier, upgrade/downgrade, deletion, pack grant, rollover with per-tier credits, replay idempotency, unknown price id.
- Integration: grandfathered `active`+null-subscription shop keeps entitlements; tier change tenant-isolated.
- Source-scan: no legacy price literals (`$20`/`$29`/`$49` as plan prices) in components; env names locked in `.env.example`.

## Manual acceptance procedure
1. Founder records the Q-22 decisions in the decision log (gate to start — Founder).
2. Founder creates the tier Products/Prices in Stripe test mode and sets test env vars (Founder).
3. Builder: checkout each tier in test mode → webhook → tier persisted → entitlements and meters match the approved matrix.
4. Builder: upgrade and downgrade between tiers → prorations sane, tier and allowances follow.
5. Builder: cancel → `free` + entitlements fail closed; reactivate path verified.
6. Builder: unset one price env var → checkout fails before any Stripe call (P0-010 property preserved).
7. Founder: create live Products/Prices, set Production env vars, complete one real checkout at the correct amount, confirm in writing (Founder).
8. Founder: rewrite `_docs/GRADIA_PRICING.md`; Organizer closes Q-22/C-14 (Founder + Organizer).

## Failure cases
- Unknown price id on a webhook → log + no-op, never guess a tier.
- Missed `invoice.paid` renewal → pre-existing period-reset single point of failure; add a reconciliation backstop or record explicit founder acceptance of the risk.
- A grandfathered shop upgrading while legacy Stripe products still exist → both models must not coexist on one subscription; migration rule decided by founder before build.
- Env vars partially set → every checkout path individually fail-closed (test-locked).

## Rollback strategy
Primary rollback is the env switch: unset the new price vars → Production checkout fail-closed again with no partial state (tier only ever written from Stripe truth). Migration ships a down file. Ledger/grants are additive-only — never rewritten. Bad live checkouts unwound via Stripe refund + subscription deletion (webhook returns the shop to `free`).

## Definition of done
Per `../12-definition-of-done.md`, plus: every Q-22 decision cited by D-number in the implementation; founder's written confirmation of one correct live-mode checkout per launched tier; the P0-010 billing-exception guard formally lifted in the close record; `_docs/GRADIA_PRICING.md` rewritten (founder) and C-14 closed in `../16-document-source-map.md`.
