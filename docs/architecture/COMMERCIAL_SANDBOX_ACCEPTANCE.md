# Stripe sandbox acceptance, dispatch, reconciliation and approved adjustments (Commercial Billing PR F1)

_2026-11-17. Sandbox/test mode only. Pricing authority stays in `src/lib/approved-commercial-catalog.ts`
(catalog `2026-11-03.v1`, Founder Pilot: $199/month, 3 seats, 2 active agents, 100 standard outcomes, 100 voice minutes,
approved overage formulas and the combined cap). The post-pilot proposal is not implemented. This PR calls no live Stripe,
creates no Dashboard object, changes no price or package, touches no shared or production data and wires no public pricing UI._

Postgres stays the billing authority. Stripe is evidence and a collection adapter. PR F1 does not add a second state machine:
every new object hangs off the PR D settlement lines and the PR E1 adjustment contract.

## What exists

| Piece | Location |
| --- | --- |
| Sandbox contract + readiness evaluator + invoice reconstruction (pure) | `src/lib/stripe-sandbox-contract.ts` |
| Read-only sandbox reader | `src/lib/stripe-sandbox-verifier.ts` |
| Operator report (READY / finite blockers) + command | `src/lib/commercial-sandbox-report.ts`, `scripts/commercial-sandbox-acceptance.mjs`, `npm run billing:sandbox-acceptance` |
| Meter reader (reconciliation evidence), meter send now pinned to the reviewed API version | `src/lib/commercial-settlement-provider.ts` |
| Pending-invoice-item provider for approved adjustments | `src/lib/commercial-adjustment-provider.ts` |
| Dispatch sweep, reconciliation, adjustment application | `src/lib/commercial-billing-operations.ts` |
| Migration (adds objects only) | `supabase/migrations/20261117120000_commercial_sandbox_acceptance.sql` |
| Transport: per-call `apiVersion` + echoed `Stripe-Version` capture | `src/lib/stripe.ts` (legacy callers unchanged) |
| Faithful local Stripe fake (injected into the REAL provider code) | `eval/_fake-stripe-sandbox.ts` |
| Tests | `eval/stripe-sandbox-contract.test.ts` (39), `eval/commercial-sandbox-providers.test.ts` (7), `eval/commercial-sandbox-report.test.ts` (4), `eval/integration/commercial-sandbox-operations.int.test.ts` (14), `eval/integration/commercial-sandbox-acceptance.int.test.ts` (9) |
| Non-destructive upgrade verifier | `scripts/verify-commercial-sandbox-acceptance-migration.py` |
| Runbook | `docs/qa/COMMERCIAL_SANDBOX_ACCEPTANCE_RUNBOOK.md` |

## 1. The sandbox contract and the readiness verifier

`stripe-sandbox-contract.ts` states exactly what the Stripe TEST sandbox must hold and judges a read-only snapshot against it.
It contains no Stripe object id, key or secret, and it provisions nothing.

- **Product** named `Gradia Founder Pilot` with metadata `catalog_version=2026-11-03.v1`, `plan_key=founder-pilot` (from the existing manifest).
- **Base Price** looked up by `gradia_founder_pilot_2026_11_monthly`: active, test mode, USD, `per_unit`, licensed, exactly 19,900, monthly x 1.
- **Six meters**, one per settlement component (`gradia_fp_2026_11_<component>`): active, test mode, `sum`, customer mapping `by_id`
  `stripe_customer_id`, value key `value`, no event time window.
- **Six metered Prices** (`gradia_fp_2026_11_<component>_metered`): monthly USD metered, attached to exactly the verified meter. Unit
  amount is derived from the catalog: outcomes at the approved retail rate (100 / 500 / 1000 cents); voice, SMS and seat carry cents so 1 cent.
- **One API version** (`COMMERCIAL_METER_API_VERSION = 2024-09-30.acacia`). The verifier sends it and refuses a provider that does not echo it;
  meter event sends use the same constant, so what is verified is what is used. The older adapter pin (`2024-06-20`) predates Billing Meters.

> **Status: PROPOSAL (`proposed_pending_founder_confirmation`).** The event names, metered-price lookup keys and API version are not
> founder-approved. `REVIEWED_SETTLEMENT_METER_MAPPING` stays **unprovisioned**; a reviewed commit names the verified meters. No environment
> variable can do it.

`evaluateSandboxReadiness` refuses (never repairs): absent, duplicate (more than one active meter / price / product), live, inactive,
wrong currency, wrong amount, wrong interval, wrong usage type or scheme, wrong aggregation, wrong customer mapping or value key,
pre-aggregated meters, a metered Price on the wrong meter, wrong Product name/metadata, an incomplete or unreadable list, and a wrong or
missing echoed API version. Findings are a finite code list in a deterministic order. The reader sends GET only, on the platform account, with
the refused-if-live PR C configuration, and never echoes ids, payloads or secrets.

## 2. Usage reporting: dispatcher, outbox and reconciliation

The outbox already existed (PR D settlement lines: `pending -> in_flight -> delivered | rejected | unknown`, write-once claim token, a 120 s stale
claim becomes `unknown`, append-only `commercial_settlement_events`, deterministic identifier = provider Idempotency-Key). F1 adds the missing
operations around it and changes none of its guarantees.

- **Dispatch sweep.** `commercial_settlement_delivery_pending(limit, shop)` lists pending/in-flight lines; `dispatchPendingSettlementDeliveries`
  runs the SAME claim/record functions per settlement. A crash, a retry or a second worker cannot double-send: a live claim is `in_progress`, a
  delivered line is skipped, `unknown`/`rejected` is never retried. `settleCommercialPeriod` takes an optional `deferDelivery` so a worker owns delivery.
- **Exact binding.** Tenant, subscription period, catalog and customer come from the settlement row (the PR E1 exact-period rules); the event
  name, value, identifier and timestamp (last second of the window) are the immutable line columns. Nothing comes from UI, metadata or a model.
- **Value basis and cap.** Outcome meters carry billed quantity; voice, SMS and seat carry exact settled cents (approved basis, unchanged). The
  one combined cap and included allowances are NOT reimplemented: the deterministic preview decides, the document is built only from an `ok`
  preview, and the database re-checks arithmetic and `usage <= cap`. `reconstructInvoiceFromDocument` / `authorizeInvoiceReconstruction`
  additionally prove that meter values x the metered unit prices plus the base reproduce the settled total exactly and never exceed
  base + seats + cap (any mismatch, e.g. a wrong metered price, refuses).
- **Ambiguous outcomes reconcile, they are not resent.** `commercial_delivery_reconciliations` is append-only evidence of what the provider
  REPORTED (meter event summaries for the customer's minute) for an `unknown` line. The database compares the observed total with the immutable
  event value: `confirmed_delivered` (final, replays), `not_confirmed` (zero/lag; can be re-checked later), `mismatch` (needs a human). The line
  itself is never rewritten. Reconciliation can never resend, only `unknown` lines are accepted, and an unreadable/ambiguous provider read
  records nothing.

## 3. Late evidence: only approved adjustments reach the next invoice

A settled period is never rewritten (PR D `CB409` stays). `commercial_adjustment_applications` (+ events) is an outbox for the PR E1 signed
adjustments: **one row per approved adjustment, ever**. The claim function refuses (CB409) an adjustment with no human review or a rejected one,
whatever its sign or size, checks the settlement customer is the bound platform customer, and the application sends exactly one pending Stripe
invoice item (`POST /v1/invoiceitems`, signed integer cents, USD) with a deterministic identifier as the Idempotency-Key. Negative amounts (credits)
therefore never auto-apply: they need the existing human decision first. No refund, credit-note, payment or cancel call exists. An acknowledgement
that is not exactly the pending item (wrong amount/customer/currency, live, already attached to an invoice) is `unknown`; an ambiguous outcome is
never resent. Nothing in the application calls propose/review: refund and credit facts still do not auto-create adjustments, and who may review
(reviewer role) remains a founder decision.

## 4. Acceptance

`eval/integration/commercial-sandbox-acceptance.int.test.ts` drives the real database and the real provider code against `FakeStripeSandbox`
(a local test clock, signed webhooks via the real handler, meters with identifier uniqueness, event summaries, pending invoice items, invoices):
checkout (completion alone is not active) -> signed `active` at first activation (exact period, first agent activation) -> calendar/shifted
windows refused -> usage recognition -> allowance/cap preview -> settle (deferred) -> dispatch -> invoice total equals the preview and stays
within base + seats + cap -> renewal paid -> renewal payment failure (past_due blocks new paid work; the closed period still settles) ->
recovery (only newer signed `active` evidence) -> duplicate delivery no-op -> cancel (blocks, terminal, open period not settleable, no credit
or refund call). Plus: exactly-at-cap settles and included usage is not sent; over-cap cannot settle and sends nothing; an ambiguous delivery
reconciles without changing the settlement; and the **invoice-finalization race**: usage that reaches Stripe after the renewal invoice finalized is
reported as `late_unbilled`, never silently billed.

The fake models only behaviour the Stripe docs state (identifier uniqueness window, 35-day / 5-minute timestamp window, minute-aligned
summaries). The docs do not define the response to a duplicate meter identifier, so a duplicate resend is never assumed safe.

## 5. Authority and isolation

All new tables: RLS on, no browser role privilege, service role SELECT only; append-only for every role including the table owner (updates,
deletes and truncates refused; only the shop cascade removes rows); applications move forward only. New functions: workers are service role only;
owners may read evidence of their own shop (`42501` for another shop, anonymous, manager/staff). Live mode stays unrepresentable. Nothing weakens
auth, approvals, Agent OS gates, memory review, provider boundaries or existing billing guards.

## Limitations (deliberate, fail closed)

1. **Metered Prices are not on the subscription (D1).** Checkout carries one item and the signed webhook refuses anything but exactly one item
   (`catalog_mismatch`). Until the item set and the webhook rule are decided (PR F2), meter events cannot appear on a real Stripe invoice.
2. **No real Stripe test-clock run (D2).** The lifecycle is proven against a faithful local fixture only. A real run must also prove usage reaches
   Stripe before the renewal invoice finalizes (~1 h after the boundary); today the dispatcher is a worker with no schedule or trigger.
3. **Resend policy.** An `unknown` delivery that reconciliation cannot confirm stays unresolved; F1 never resends.
4. **Cap.** A period whose usage exceeds the single combined cap is `cap_exceeded`: it cannot settle (no clamp, no owner cap-raise flow).
5. **Polling reconciliation of subscription state** when webhooks stop is unchanged (PR F3).
6. **Unresolved founder policy, unchanged and fail-closed:** seat partial-day proration (unaligned Stripe periods), grace/dunning timing, tax,
   refund eligibility, resubscription after cancel, voice/SMS runtime gating, the reviewer role and a human review surface.
7. The mapping is unprovisioned, so no settlement can deliver until a reviewed commit names the verified meters.
