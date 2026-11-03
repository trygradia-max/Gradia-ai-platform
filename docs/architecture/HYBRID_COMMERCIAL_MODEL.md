# Hybrid commercial model

_Contract foundation: 2026-10-29. Founder-approved catalog added 2026-11-03.
Product approval does not activate Stripe, checkout or production billing._

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

## Founder decisions recorded 2026-11-03

- Founder Pilot: $199/workspace/month; three operator seats; two active agents;
  100 standard outcomes; 100 inbound voice minutes.
- Active owner, manager and staff roles are billable operators; read-only, pending,
  inactive and revoked memberships are excluded. Extra seats are $39/month with
  daily proration.
- Postpaid overage: standard outcome $1; qualified lead $5; confirmed appointment
  $10; voice greater of $0.35/minute or cost / 0.40; SMS greater of $0.05/segment
  or cost × 3. Only the highest-value digital outcome is charged per workflow.
- Default cap $100/month, owner-adjustable to $500. No included-usage rollover.
- Fourteen-day build/test period; billing and card requirement begin at first agent
  activation. Qualifying pilot accounts retain the price for 12 months.
- USD. Planned Core/Growth/Scale terms are recorded but blocked pending pilot cost
  evidence and are not part of the activatable catalog.

Tax treatment and failed-payment/dunning behavior still require explicit founder
approval. Ledger settlement, cap enforcement/warnings, proration, activation billing,
Stripe provisioning/webhook reconciliation and production acceptance remain unbuilt.
Production Stripe identifiers therefore stay unset and checkout continues to fail
closed. Historical `$20 + $29` and `$99/$149/$249` models and PR #38 are not the
approved catalog. See `docs/product/FOUNDER_APPROVED_COMMERCIAL_CATALOG.md`.
