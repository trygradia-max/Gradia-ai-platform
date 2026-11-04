# Commercial usage recognition (Commercial Billing PR A)

_2026-11-04. Backend foundation only. It does not enable checkout, call Stripe, create
meters or webhooks, or invoice anyone. Pricing authority stays in
`src/lib/approved-commercial-catalog.ts` (catalog `2026-11-03.v1`)._

Gradia's database is the billing authority. Stripe will later be a collection and
reconciliation adapter that receives *settled* quantities from this ledger. Nothing
here reads Stripe Dashboard state, and nothing bills from model narration.

## What exists

| Piece | Location |
| --- | --- |
| Migration | `supabase/migrations/20261104130000_commercial_usage_recognition.sql` |
| Contract (metrics, ranks, keys, input schemas) | `src/lib/commercial-usage.ts` |
| Deterministic period preview (pure, exact arithmetic) | `src/lib/commercial-usage-preview.ts` |
| Server wrappers over the RPCs | `src/lib/commercial-usage-service.ts` |
| Upgrade/ACL/immutability probe | `scripts/verify-commercial-usage-migration.py` |

## Data model

- `commercial_catalog_versions` — immutable registry; seeded with `2026-11-03.v1`.
- `commercial_usage_recognitions` — one immutable fact per recognized usage:
  tenant, catalog version, exact metric (five approved values only), quantity,
  source (`usage_event` ledger row or `workflow_outcome`), workflow identity (outcomes),
  nullable wholesale unit cost **with its basis** (NULL is *unknown*, never zero),
  bounded evidence object, `recognized_at` (event time), `recorded_at`, and a
  deterministic `idempotency_key` unique per shop.
- `commercial_usage_corrections` — compensating rows linked to a recognition. A
  recognition is never updated or deleted; corrections can reduce it but never
  exceed its recognized quantity.
- `usage_events` is **not modified**. The only change touching it is a plain unique
  index on `(shop_id, id)` so a recognition holds a tenant-exact foreign key to the
  ledger row it is evidence for.

Append-only is enforced by triggers (including TRUNCATE and the table owner). Only
the cascade from deleting the whole shop removes rows — the existing tenant-deletion
contract. A referenced `usage_events` row cannot be deleted out from under its
recognition.

## Authority

| Caller | Write (recognize / correct) | Read (`commercial_usage_read`) | Tables |
| --- | --- | --- | --- |
| service role | yes, via function only | yes | SELECT only |
| live shop owner | no | yes, own shop | none |
| manager, staff, revoked, anonymous, cross-shop | no | `42501` | none |

Owner authority is re-derived inside the database on every call (`auth.uid()`,
shop owner, active owner membership). The shop for a write comes from server-side
evidence; the function re-validates that the shop exists and that any referenced
ledger row belongs to it.

Failure codes: `42501` authority, `22023` invalid input, `CB422` not billable,
`CB409` conflict with an existing immutable fact.

## Recognition rules enforced at the boundary

- Metrics are exactly `standard_digital_outcome`, `qualified_lead`,
  `confirmed_appointment`, `inbound_voice_agent_minute`, `sms_segment`. Historical
  kinds (`voice_minute`, `agent_run`, …) are refused.
- A digital outcome requires `outcome_state = 'confirmed'` and
  `human_completed = false`. Drafts, proposals, escalations, failures, unknown and
  human-completed work return `CB422` and **store nothing**.
- Provider usage must reference its own tenant's `usage_events` row of the matching
  kind and identical quantity. A ledger row can be recognized once, whatever
  identity is used.
- Voice minutes require explicit `direction = 'inbound'` evidence.
- Identical replay returns the original id; any change to an immutable part
  conflicts; concurrent identical recognition yields one fact and one id.

## Preview

`previewCommercialPeriod` is pure and deterministic over a half-open UTC window
`[start, end)` and an `asOf` instant (only facts/corrections recorded by then count,
so a past preview is reproducible). It applies, in this order: net-of-correction
quantities; highest-value-only outcome per workflow independent of event order;
included allowances consumed in recognition order; fixed rates; dynamic markup
floors per fact (`max(floor, cost × multiplier)`); and one combined monthly cap.
Arithmetic uses scaled integers, never floats.

States: `ok`, `cap_exceeded` (nothing charged), `unavailable` (e.g. missing wholesale
evidence on billable markup usage), `conflict` (over-correction, or a workflow whose
outcome is upgraded in a later period), `invalid`. Non-`ok` results carry **no**
charge fields, so a failure cannot render as `$0`.

## Limitations (deliberate, fail closed)

1. **Seat proration** was unavailable in PR A. PR B
   (`docs/architecture/MEMBERSHIP_BILLING_HISTORY.md`) records immutable membership
   history and computes it only from complete coverage; this usage-only read
   (`readCommercialUsagePreview`) still returns `seat_proration_unavailable`
   (`no_membership_evidence`). Use `readCommercialPeriodPreview` for both.
2. **No producers are wired.** Nothing calls `recognizeCommercialUsage` yet. The
   historical `voice_minute` rows carry no call direction, and their
   `wholesale_cost` is a `pricing_config` rate-card estimate, not provider-reported
   cost. They are never inferred into billable minutes; a future producer must supply
   provider-evidenced direction and wholesale basis explicitly.
3. **No digital-outcome evidence source exists yet.** The data model cannot prove a
   confirmed qualified lead or appointment on its own; the boundary accepts an
   explicit confirmed-outcome assertion from trusted server code and records it. No
   outcome was backfilled from model text or old rows.
4. A workflow whose highest outcome rises across periods returns `conflict`
   (`workflow_spans_periods`) rather than guessing an incremental charge.
5. The cap, taxes, dunning, trials, coupons and refunds are not modeled here.

## Follow-on PRs

B immutable billable membership intervals and daily seat proration · C Stripe
platform customer/subscription state and Checkout at first agent activation · D
reviewed Stripe meter/event mapping, usage settlement, invoice preview · E signed
webhook reconciliation, dunning/cancellation/refund states, Customer Portal links ·
F test-clock, duplicate/out-of-order webhook, cap and full sandbox acceptance.
