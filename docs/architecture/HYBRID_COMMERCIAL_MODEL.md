# Hybrid commercial model

_Contract foundation: 2026-10-29. No new price, seat, trial or overage value
is activated by this document or its accompanying code._

## Approved shape

Gradia's commercial model combines three independent dimensions:

1. A tiered workspace subscription for the product and included capacity.
2. Per-user pricing after a plan's included active-user allowance.
3. Pay-as-you-go usage for measurable agent work, priced from provider cost
   plus an explicit Gradia markup or explicit retail unit rate.

The invoice equation is:

`tier base + extra active-user seats + usage above included allowances`

The images supplied by the founder are product references for those three
pricing shapes. They do not approve the example prices shown in the images.

## Implemented safely in the foundation slice

- `commercial-pricing.ts` validates a complete catalog and has no production
  price defaults.
- Each plan must explicitly provide base price, included seats, extra-seat
  price and its PAYG policy.
- PAYG is `disabled`, `prepaid` or `postpaid`. Postpaid requires an explicit
  positive monthly cap.
- A usage rate is either an explicit retail unit price or an explicit markup
  with a retail floor. There is no hidden/default markup.
- Wholesale provider evidence remains separate from the customer charge.
- `activeMembershipCount` counts distinct active workspace memberships, but
  does not call them billable seats or decide which roles the founder charges.
- Customer-facing billing UI no longer advertises superseded numeric prices.
- Existing checkout, packs and postpaid overage remain unavailable until an
  approved catalog and collection/reconciliation path exist.

## Existing evidence preserved

Do not replace the append-only `usage_events` ledger, `credit_grants`,
`pricing_config`, provider reference/idempotency keys, membership authority or
margin reporting. The future billing adapter consumes those records and adds
settlement evidence; it does not rewrite operational history.

Voice-agent usage may be billed by time because carrier/voice provider cost is
time-based. Non-voice AI work should use customer-visible operations or another
auditable unit rather than pretending wall-clock “agent minutes” match token,
model and tool cost.

## Founder decisions required before live billing

- Plan names and number of tiers.
- Monthly base price per tier.
- Which active roles count as paid users.
- Included seats and extra-seat rate, including proration.
- Included message/AI capacity and voice minutes.
- Prepaid, postpaid or both for overage.
- Retail unit rates or markup/margin floors per usage metric.
- Voice rounding rule and provider-cost reconciliation.
- Default and maximum monthly overage cap.
- Trial start, duration, allowance and card policy.
- Rollover, grandfathering, taxes, currency and failed-payment behavior.

Until those values are recorded, Production Stripe price identifiers stay
unset and checkout fails closed. Historical `$20 + $29` and `$99/$149/$249`
models and PR #38 are implementation references, not commercial approval.
