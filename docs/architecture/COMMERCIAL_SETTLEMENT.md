# Commercial settlement and reviewed meter mapping (Commercial Billing PR D)

_2026-11-15. Sandbox/test mode only. Pricing authority stays in
`src/lib/approved-commercial-catalog.ts` (catalog `2026-11-03.v1`). This PR freezes the
result of the existing deterministic preview for one closed window into an immutable
settlement and records the hand-off of that result to a reviewed Stripe event boundary.
It does not enable checkout, mark an invoice paid, change a subscription, call Stripe
from any automated test, create any Stripe Dashboard object, deploy, or touch shared data._

Gradia's database is the billing authority. Stripe is a collection/reconciliation adapter
that is *told* what the ledger settled. Nothing here reads Stripe state and nothing bills
from model text.

## What exists

| Piece | Location |
| --- | --- |
| Migration | `supabase/migrations/20261115130000_commercial_settlement.sql` |
| Pure contract (components, reviewed mapping, window rules, document, delivery plan, ack verification) | `src/lib/commercial-settlement.ts` |
| Provider boundary (one operation) | `src/lib/commercial-settlement-provider.ts` |
| Server orchestration (preview, settle, deliver, read) | `src/lib/commercial-settlement-service.ts` |
| Shared preview assembly (extracted, behavior unchanged) | `src/lib/commercial-usage-service.ts` (`assembleCommercialPeriodPreview`, `parseMembershipRead`) |
| Unit tests (30) | `eval/commercial-settlement.test.ts` |
| Disposable-Postgres integration tests (33) | `eval/integration/commercial-settlement.int.test.ts` |
| Non-destructive upgrade verifier | `scripts/verify-commercial-settlement-migration.py` |

No UI, server action or route was added. The owner-facing DTOs are the return types of
`previewCommercialSettlement` and `readCommercialSettlement`; wiring them into `/billing`
is a later UI change.

## The settlement

One **settlement per exact window**, immutable:

- Window: half-open `[start, end)`, UTC midnight to UTC midnight, **28–31 days**, and
  closed at the database clock. Open, partial, misaligned and wrong-length windows are
  refused (`CB422`). A first partial period (activation mid-month) is therefore *not*
  settleable until a decision defines it.
- Evidence: the usage + membership reads at one fixed instant (`as_of`, fixed by the
  database clock). The database recomputes a SHA-256 **evidence digest** over exactly the
  immutable evidence a settlement consumes (facts, corrections, prior workflow metrics,
  coverage, membership events; `as_of` excluded) and refuses on mismatch (`CB409`
  "evidence changed"). Late evidence therefore cannot slip into, or silently change, a
  settled window; an exact replay at a later instant over unchanged evidence matches.
- Document: built **only** from an `ok` preview with an available invoice total, by the
  same assembly the preview readers use (`assembleCommercialPeriodPreview`), so settlement
  cannot price differently from the preview. Six components: the five approved metrics
  plus `extra_operator_seat_proration`. `unavailable`, `conflict`, `invalid`,
  `cap_exceeded`, missing coverage, missing wholesale evidence and an unclosed period all
  refuse with an exact block; there is no partial settlement and no zero fallback.
- Highest-value-only outcomes, included allowances, dynamic margin floors, daily seat
  proration and the one combined cap are **not reimplemented**; they come from the PR A/B
  preview unchanged. The database re-checks arithmetic invariants only (totals add up,
  usage ≤ cap, components complete and finite, each delivery equals the settled charge or
  quantity). It does not re-price: pricing stays in one reviewed place.
- Never billed: drafts, failures, unknown outcomes, human-completed work, duplicates and
  inferred legacy usage never enter the ledger (PR A refuses them), so they cannot appear
  in a settlement. The integration suite asserts this end to end.
- Replay: identical request → the original settlement, no provider call, no new rows.
  Changed request, changed evidence or a different identity for the same window → `CB409`.
  An overlapping window → `CB409`. Concurrent identical requests (8 in the test) create one
  settlement and one provider call per line; they serialize on the shop's billing account
  row (the lock PR C already uses).
- Preconditions bound in the database: a billing account bound to the approved catalog
  and plan, a bound platform customer (write-once from PR C), complete membership coverage
  from before the window start. The account state is recorded as evidence
  (`account_version`) but **not required to be `active`**: a closed period can be owed after a
  cancellation. Settlement never reads Stripe and never writes account state.

## Reviewed event mapping (fail closed)

`REVIEWED_SETTLEMENT_METER_MAPPING` is **code**, not environment. It lists the six finite
components and what number each event carries (`REVIEWED_VALUE_BASIS`):

| Component | Event value |
| --- | --- |
| standard_digital_outcome, qualified_lead, confirmed_appointment | billed quantity (whole units; a fraction is refused, never rounded) |
| inbound_voice_agent_minute, sms_segment | settled charge in cents |
| extra_operator_seat_proration | settled charge in cents |

The voice, SMS and seat values are cents because their unit price varies per fact (markup
floors) or per day; a single provider unit price cannot reproduce it. **This value basis is a
proposal.** It is not an approved commercial term and must be confirmed when meters are
provisioned (see below).

The mapping **ships unprovisioned**: every event name is `null` and `status` is
`unprovisioned`, so `resolveSettlementRuntime` returns `settlement_mapping_unprovisioned` and
`settleCommercialPeriod` refuses before touching the database or the provider. A
provisioned mapping can supply only event names (format-checked, unique, all six present);
it cannot change the value basis. No model, request, caller or environment variable supplies
a metric, event name, quantity, price, customer id, period or tenant id: the shop comes from
the server, the actor is re-verified as a live owner, every number comes from the frozen
document, and the customer comes from the database's own bound account.

## Delivery outbox

`commercial_settlement_lines` holds the immutable settled amounts and the immutable delivery
identity (event name, value, deterministic provider identifier, event timestamp = last second
of the window) with a **forward-only** `delivery_status`:

`pending → in_flight → delivered | rejected | unknown` (`not_required` for zero lines).

- A worker claims a line (`commercial_settlement_delivery_claim`, write-once token), sends
  exactly the payload the database returned, then records the outcome with that token
  (`commercial_settlement_delivery_record`). Record-before-claim, a wrong token, a second
  record and a record after a terminal state are `CB409` (out-of-order).
- A live claim is never handed out twice (`in_progress`). A claim older than 120 s with no
  outcome is marked `unknown` (`stale_in_flight`): it may have reached the provider.
- Classification matches PR C: 400/401/402/403/404 → `rejected` (provider did not act);
  timeout, transport error, unreadable reply, 409/429/5xx → `unknown`. A 2xx whose
  acknowledgement is live-mode, unreadable, or does not match the exact event (identifier,
  event name, customer, value) is `unknown`.
- **Nothing retries an `unknown` or `rejected` line automatically.** A replay or an explicit
  `deliverCommercialSettlement` reports `blocked` and sends nothing. A failed record call
  leaves the line in flight, which becomes `unknown` on the next claim; it is never re-sent.
- `rejected` is terminal in this PR (no requeue path). The reviewed resolution is PR E's
  reconciliation.
- Derived progress (`deriveDeliveryState`): `pending`, `in_flight`, `provider_accepted`,
  `reconciliation_required`, `no_delivery_required`. `provider_accepted` means only that the
  provider acknowledged the events. It is not an invoice, not a payment and not a
  subscription state, and no code path here writes any of those.

## Authority

| Caller | Settle / claim / record | Evidence + settlement read | Tables |
| --- | --- | --- | --- |
| service role | yes, via functions only; `begin` must name a **live owner of that exact shop** | yes | SELECT only |
| live shop owner (session) | no | yes, own shop | none |
| manager, staff, revoked, anonymous, cross-shop | no | `42501` | none |

Claim and record are system operations bound to `(shop, settlement, line)`; they carry no
actor. Browser roles have no table privilege and no writer or helper function privilege. The
three tables are append-only/forward-only for every role including the table owner
(UPDATE/DELETE/TRUNCATE refused; only the shop-deletion cascade removes rows), live mode is
unrepresentable (`provider_mode = 'test'`, customer ids must be `cus_`), event details refuse
URLs and key-shaped text.

## Stripe configuration and the later provisioning dependency

Settlement runs only with the PR C sandbox configuration (`GRADIA_COMMERCIAL_BILLING_STRIPE_MODE=test`,
`sk_test_`/`rk_test_` key, loopback-or-official base; a live key is refused even with the mode
flag) **and** a provisioned mapping. The one provider operation is
`POST /v1/billing/meter_events` on the platform account (no `Stripe-Account` header, the
local identifier doubles as the `Idempotency-Key`). Automated tests use a local fake; the real
client is exercised only against a stubbed `fetch`.

Not done here, and required before any sandbox settlement can run (each needs its own review):

1. **Founder decisions.** Confirm the value basis above (or choose invoice items instead of
   meter events for the markup metrics and seats); define how a first partial period and any
   non-calendar subscription anchor are settled; decide whether late evidence after a
   settlement becomes a signed adjustment (today it is refused).
2. **Sandbox provisioning (Stripe Dashboard/API, not code).** Create one sandbox meter per
   component with the agreed aggregation and price, attach the metered prices to the
   Founder Pilot subscription, and record the real event names.
3. **A reviewed commit** replacing the `null` event names in `REVIEWED_SETTLEMENT_METER_MAPPING`
   and flipping `status` to `provisioned` (plus a new `mapping.version`). No lookup key, event
   name, tax behavior, discount, trial or credit was invented in this PR.
4. **API version.** The adapter pins Stripe API `2024-06-20`. Billing meters launched with
   `2024-09-30.acacia`; verify `/v1/billing/meter_events` against the pinned version (or
   move the pin in a reviewed change) before the first sandbox send.
5. **Period alignment.** Stripe attributes a meter event to the subscription period that
   contains the event timestamp. The settlement window (UTC-aligned, 28–31 days) must be
   aligned to the subscription's billing period in PR E/F; Stripe also rejects timestamps
   older than 35 days, so a late settlement is `rejected`, never retried.
6. **Reconciliation of the `base` and seat amounts against the Stripe invoice** belongs to PR E
   (signed webhooks) and PR F (test-clock acceptance). Settlement records the base, seat and
   usage totals for that comparison but delivers only the six components.

## Verification

- Unit: `eval/commercial-settlement.test.ts` (mapping fail-closed, window rules, document
  refusals incl. cap/coverage/wholesale/over-correction/legacy metric, highest-value-only,
  markup floor, stable digests and identifiers, fractional refusal, ack verification,
  failure classification, runtime resolution, real provider request shape with a stubbed
  `fetch`).
- Integration (real Postgres, fake provider): 33 tests incl. happy path with exact events,
  exact replay, 8-way concurrency, changed replay, overlap, open/partial/misaligned windows,
  incomplete coverage, missing account/customer, cap refusal, unknown wholesale evidence,
  never-billed outcomes, timeout/409/429/5xx → unknown and not retried, 4xx → rejected,
  live/mismatched/unreadable ack → unknown, stale claim, out-of-order record, cross-tenant
  claim/read, role denial (owner, manager, staff, revoked, anonymous, cross-tenant), table
  denial, immutability for the table owner and cascade, URL/key-free event details.
  Fixture note: the suite backdates one shop's membership coverage with SQL through the local
  stack's pg-meta endpoint (the disposable target is asserted) because the application can
  never create coverage in the past.
- Upgrade: `python3 scripts/verify-commercial-settlement-migration.py` removes the PR D
  objects inside one transaction, seeds legacy shops/usage/membership/billing rows, applies
  the migration's real SQL, proves no existing row changed (content, xmin, position), ACLs,
  authority, refusals, replay/conflict, the claim state machine, immutability and cascade,
  then rolls back. The literal `supabase db reset --version` path is not used.

## Limitations (deliberate, fail closed)

1. Nothing can be settled until the mapping is provisioned (by design).
2. One settlement per window; late evidence and corrections after settlement are refused, not
   adjusted. A signed adjustment record is future work.
3. The database re-checks arithmetic, evidence identity and authority, not pricing; a correct
   document depends on the one reviewed preview code path.
4. `rejected` has no requeue; `unknown` has no automatic exit. PR E reconciliation owns both.
5. Settlement does not collect, invoice, dun, refund, or touch subscription state.
6. Tax, discounts, trials, credits, Growth/Scale and live mode remain out of scope.

## Follow-on

PR E: signed webhook reconciliation (the caller of `commercial_subscription_apply_evidence`),
reconciliation of `unknown`/`rejected` deliveries, dunning/cancellation/refunds, Customer
Portal. PR F: test clocks, duplicate/out-of-order webhooks and full sandbox acceptance.
