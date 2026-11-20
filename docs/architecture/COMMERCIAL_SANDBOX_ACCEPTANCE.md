# Stripe sandbox acceptance, dispatch, reconciliation and approved adjustments (Commercial Billing PR F1)

_2026-11-17. Sandbox/test mode only. Pricing authority stays in `src/lib/approved-commercial-catalog.ts`
(catalog `2026-11-03.v1`, Founder Pilot: $199/month, 3 seats, 2 active agents, 100 standard outcomes, 100 voice minutes,
approved overage formulas and the combined cap). The post-pilot proposal is not implemented. This PR calls no live Stripe,
creates no Dashboard object, changes no price or package, touches no shared or production data and wires no public pricing UI._

Postgres stays the billing authority. Stripe is evidence and a collection adapter. PR F1 does not add a second state machine:
every new object hangs off the PR D settlement lines and the PR E1 adjustment contract.

> **Update 2026-11-18 (PR F2, section "PR F2" at the end).** The founder directed that the F1 recommended meter contract (event names,
> metered-price lookup keys, API version `2024-09-30.acacia`) is the **TEST-mode implementation contract**. F2 puts the exact item set on
> Checkout and the signed webhook, promotes the settlement mapping, adds a leased billing worker + cron entry point, an opt-in real Stripe
> test-clock harness and a stricter readiness report. F1 limitations 1, 2 and 7 and the "PROPOSAL" status below are superseded; the rest
> stands. Production activation is unchanged: it still needs a final reviewed release decision.

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

> **Status (F1 text; superseded by F2 — now `founder_directed_test_mode_contract`): PROPOSAL (`proposed_pending_founder_confirmation`).** The event names, metered-price lookup keys and API version are not
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

---

# PR F2 — exact item set, worker, test-clock harness (2026-11-18)

Sandbox/test mode only. No live Stripe, no production or shared Supabase, no Vercel deploy, no real customer, no real money, no public
pricing UI. Prices, allowances, caps and the active Founder Pilot catalog (`2026-11-03.v1`) are unchanged. **Production promotion still
requires a final reviewed release decision** (`SANDBOX_PRODUCTION_PROMOTION` in the contract, printed by the report).

## What exists

| Piece | Location |
| --- | --- |
| The exact item set (pure; the single rule for Checkout AND the webhook) | `src/lib/commercial-subscription-items.ts` |
| Read-only snapshot collector (split out of the verifier; no import cycle) | `src/lib/stripe-sandbox-snapshot.ts` |
| Contract v2: founder-directed status, `mappingMatchesSandboxContract`, readiness returns verified Price ids | `src/lib/stripe-sandbox-contract.ts` |
| Checkout resolves/creates/verifies the exact set; injectable transport | `src/lib/stripe-commercial.ts`, `src/lib/commercial-billing-service.ts` |
| Webhook normalization requires the exact set (any order); item periods must agree | `src/lib/commercial-webhook.ts` |
| Reviewed mapping provisioned from one source of event names | `src/lib/commercial-settlement.ts` (`SETTLEMENT_METER_EVENT_NAMES`) |
| Leased, bounded worker | `src/lib/commercial-billing-worker.ts`, `src/lib/commercial-billing-operations.ts` (gate/preflight hooks) |
| Cron entry point (bearer `CRON_SECRET`, GET only) | `src/app/api/cron/commercial-billing/route.ts`, `vercel.json` (`*/10 * * * *`), `src/lib/cron-run.ts` |
| Lease migration (adds objects only) | `supabase/migrations/20261118120000_commercial_worker_lease.sql` |
| Opt-in real test-clock harness + command | `src/lib/stripe-test-clock-acceptance.ts`, `scripts/stripe-test-clock-acceptance.mjs`, `npm run billing:test-clock-acceptance` |
| Readiness report, evidence judge, offline fixtures | `src/lib/commercial-sandbox-report.ts`, `commercial-acceptance-evidence.ts`, `commercial-readiness-fixtures.ts` |
| Fakes (harness logic only; encode stated Stripe assumptions) | `eval/_fake-stripe-test-clock.ts` (+ F1 `eval/_fake-stripe-sandbox.ts`) |
| Upgrade verifier | `scripts/verify-commercial-worker-lease-migration.py` |

## 1. The exact subscription item set

One deterministic set, identified only by **lookup key** (no Stripe object id is in code): the approved **licensed base** Price
(`gradia_founder_pilot_2026_11_monthly`, 19,900 USD, quantity 1) plus **exactly six metered Prices** (`gradia_fp_2026_11_<component>_metered`),
any order. Refused: a missing, extra, duplicate or unknown item (e.g. the operator-seat Price), a wrong amount / currency / interval /
usage type / billing scheme, a live price, a metered Price without a meter, a licensed quantity other than 1, a metered item carrying a
quantity, items that do not share one Product. Metadata is never an input. Tenant comes only from server-held bindings.

- **Checkout creation.** `resolveFounderPilotItemSet()` reads the sandbox (GET only, reviewed API version) and runs `evaluateSandboxReadiness`:
  each lookup key must resolve to exactly one active TEST-mode USD monthly Price with the right amount, usage type and (for metered) the verified
  meter, all on the same approved Product (name + metadata checked), each meter active/`sum`/`by_id stripe_customer_id`/`value`. Nothing is created
  or repaired; an unreachable sandbox is an ambiguous READ (`provider_unavailable`), a mismatch rejects the attempt with `item_set_<finding>`.
  Line items: base ×1, then six metered items with **no quantity** (Stripe: "Quantity should not be defined when `recurring.usage_type=metered`").
- **Checkout retrieval** expands `line_items` and requires the exact set in addition to the shop/attempt/catalog/customer binding. A session
  without expanded line items is never "bound".
- **Fingerprint.** The request fingerprint now includes the item-set digest, so a changed contract is a changed request (an in-flight attempt from
  an older contract conflicts instead of being silently reused).
- **Signed webhook.** `normalizeSubscription` emits `price_lookup_key = <base key>` only for the exact set, otherwise `invalid_items` → the existing sticky
  `catalog_mismatch` (reconciliation_required). The database is unchanged: it already treats anything but the base key as a mismatch and blocks later
  correct events until a reviewed reconciliation. Item-level periods must agree with each other and with the top-level period or the period is unverified.
  Archived Prices are tolerated on an existing subscription (Stripe keeps them); a webhook has no Stripe client, so it cannot prove WHICH meter a metered
  Price is wired to (it requires one to be present). The meter identity is verified at Checkout time and by the readiness command.
- Checkout completion is still never payment proof; `active` still needs signed `active` evidence with a verified period.

## 2. Settlement mapping

`REVIEWED_SETTLEMENT_METER_MAPPING` is now `provisioned` (version `settlement-mapping.v2-sandbox-contract`) with the F1 event names. They live once, in
`SETTLEMENT_METER_EVENT_NAMES`; the sandbox contract derives its meters from them, `mappingMatchesSandboxContract` (used by the worker, the report and a
unit test) requires the mapping to equal the contract exactly (six components, names, value basis). Value basis is unchanged: outcomes carry the
recognized **billed quantity**; voice, SMS and seat carry **settled cents**. Provisioning in code does not create a meter: the dispatch worker still
refuses to send unless the sandbox verifies against the contract.

## 3. The billing worker

Entry point: `GET /api/cron/commercial-billing` (`Authorization: Bearer $CRON_SECRET`, `runCron` wrapper: heartbeat + one ops alert on failure).
**Disabled (200 `disabled`) unless `GRADIA_COMMERCIAL_BILLING_WORKER=enabled`**; enabled with a missing / live-shaped / non-loopback Stripe configuration or a
mapping that is not the exact contract is a 503. It exports GET only. It is registered in `vercel.json` (every 10 minutes) and `CRON_REGISTRY`; scheduling
changes nothing in production by itself (crons, automatic builds and provider activity stay disabled by the existing release gate, and the route stays off
without its flag and a TEST key).

Three leased sweeps per invocation, in order: `settlement_dispatch` (pending/in-flight lines → the SAME claim/record functions as settlement),
`delivery_reconcile` (`unknown` lines → append-only provider evidence; never resends), `adjustment_apply` (human-approved adjustments of either sign → one
pending invoice item each; nothing unreviewed or rejected is ever sent).

- **Lease.** `commercial_worker_leases`: one row per worker kind, token + expiry + fencing generation. Acquire (free or expired), renew (current unexpired
  holder only), release (current holder only, finite outcome), operator read (never returns the token). TTL clamped 30 s – 15 min. A holder that lost the lease
  stops before its next item. **The lease is an optimization, not the safety:** every line/adjustment is still claimed with a write-once token, a live claim is
  never handed out twice and `unknown` is never resent, so a lost or expired lease cannot double-send (tested: 4 concurrent workers → one event per line).
- **Bounded.** ≤ 10 settlements / 25 reconciliations / 10 adjustments per run; no new item after 120 s wall clock (an in-flight item finishes; ≤ 6 × 15 s); the
  gate renews the lease before every item; `maxDuration` 300 s.
- **Fail closed.** Dispatch preflights a read-only sandbox verification **only when there is work** and refuses to claim or send otherwise
  (`sandbox_not_ready`, run not ok → 503 → alert). A missing runtime skips the task and releases the lease. An unreadable lease store sweeps nothing.
- **Tenant-safe.** The sweep is tenant-blind like the other crons (allowlisted in `tenant-scoping.test.ts`); every item is bound to its own shop by the
  database row it claims; nothing in the request names a tenant, period, customer, event or amount. Reports and logs carry counts and finite codes only.
- **Not covered.** Nothing schedules `settleCommercialPeriod` (it needs a live-owner actor; a system-actor policy is a founder decision). Until it is
  decided, a closed period must be settled by an authorized path before the worker has anything to dispatch, and usage must reach Stripe before the renewal
  invoice finalizes (~1 h after the boundary). This is the next dependency.

## 4. The real Stripe TEST-clock harness (opt-in)

`npm run billing:test-clock-acceptance -- --i-understand-this-mutates-stripe-test [--evidence-out <file>]` with
`GRADIA_STRIPE_TEST_CLOCK_ACCEPTANCE=1`, `GRADIA_COMMERCIAL_BILLING_STRIPE_MODE=test` and an `sk_test_`/`rk_test_` key. It is **not** reachable from
`npm test`, `npm run test:int` or CI (it refuses when `CI`, `GITHUB_ACTIONS`, `VERCEL` or `BUILDKITE` is truthy). Hard refusals happen before any request:
no opt-in, no confirmation flag, CI, a live-shaped key, a non-test mode, a non-official / non-loopback API base. During the run every request must match an
allowlist of (method, path); mutating requests may address only objects **this run created**; any response saying `livemode: true` or carrying a live-shaped
id/key aborts. It always expires its Checkout Session and deletes the test clock (which deletes the customer and subscription) in `finally`; a failed cleanup
is reported `FAILED` with the exact manual instruction (Billing → Subscriptions → Simulations, TEST mode, delete `gradia-f2-acceptance-*`). It prints and
stores only finite step ids, statuses, finite codes and integer cents/counts: no secret, Stripe id, URL, raw payload or personal datum.

Steps (a failure marks the rest `NOT_RUN`; a limitation is `NOT_RUN`/`MANUAL`, never faked):

1. `sandbox_contract` — the sandbox holds the exact contract (read-only). 2. `clock_and_customer` — test clock starting ~25 days back (so period 1 spans real
"now": meter event timestamps are validated against the real clock) and a customer with a succeeding test card. 3. `checkout_session_exact_items` — the REAL
Checkout client creates a session with the exact items and verifies it back. 4. `subscription_exact_items` — the equivalent subscription by API (items in
reverse order on purpose). 5. `webhook_normalization_exact_items` — the REAL retrieved subscription through the production webhook rules, plus negative controls.
6. `first_period` — starts at activation (the clock start), one month. 7. `meter_events_sent` — six events through the real settlement provider code, before the
renewal. 8. `meter_usage_visible` — the provider's own summaries match. 9. `invoice_preview` — preview total = base + metered (`NOT_RUN` if the endpoint is
unavailable). 10. `renewal_invoice_with_usage` — advance past the boundary + 2 h; the renewal invoice is paid and equals base + usage. 11.
`late_usage_after_finalization` — **OBSERVED**, not pass/fail: usage for the closed period sent after finalization; the code records whether the next invoice
billed it. 12. `payment_failure_lapse` — a card that attaches but cannot be charged; renewal 2 leaves the invoice open and the subscription `past_due`
(and production normalization reports `past_due`). 13. `recovery` — good card restored, invoice paid, subscription `active`. 14. `next_period` — the next period
starts exactly where the previous ended. 15. `cancellation` — canceled, terminal.

**What cannot be automated (recorded as `MANUAL`, never auto-passed):** completing a *hosted* Checkout in a browser (Stripe offers no API) and a
*Stripe-delivered, signed* webhook reaching the endpoint (needs a public endpoint). The harness normalizes real provider objects inside a *locally signed*
envelope; that proves our rule, not Stripe's delivery. Meter events cannot be deleted from a meter (they hang off the deleted test customer). The harness does
not touch Supabase. These limits are printed on every run.

## 5. The readiness report

`npm run billing:sandbox-acceptance [-- --network] [--evidence <file>] [--attest hosted_checkout_completion] [--attest stripe_delivered_webhook] [--local]`.
**READY** requires all of: the F1 contract consistent and the mapping exactly equal to it; the webhook rule accepting exactly the contract set and refusing missing /
extra / duplicate / wrong-quantity / wrong-amount sets (offline fixtures built from the contract); TEST-shaped Stripe, webhook, dashboard and `CRON_SECRET`
configuration with the worker enabled and its mapping exact; a read-only sandbox verification (`--network`); and **real test-clock evidence** that is schema-valid
(strict), carries nothing id/URL/secret-shaped, matches the current contract fingerprint (item-set digest, API version, mapping version), is ≤ 30 days old, passed
every automated step with a clean cleanup — and the two manual steps **attested by the operator** (the file never carries them as passed; an attestation is an
explicit human claim, not verified by code, and a hand-edited evidence file is not cryptographic proof: this is an operator readiness gate, not an audit trail).
Offline, the report prints `LOCAL FIXTURE READINESS: PASS` and `REAL STRIPE ACCEPTANCE: NOT RUN` and can never print READY; `--local` exits 0 iff the local fixtures
pass (for CI).

## Verification (F2)

- Unit: `commercial-subscription-items` (32), `stripe-commercial` (37), `commercial-webhook`, `commercial-settlement` (mapping pinned to the contract),
  `commercial-billing-worker` (13), `stripe-test-clock-acceptance` (25), `commercial-sandbox-report` (9).
- Integration (disposable Postgres, no network): `commercial-worker` (11: lease concurrency/expiry/takeover/role denial/immutability; worker end to end: exactly-once
  dispatch under overlap, held lease, sandbox-not-ready, ambiguous → reconcile once, approved-only adjustments, tenant scoping); the PR C / D / E1 / F1 suites updated
  to the exact item set (incl. 6 new webhook cases: single-item shape, missing, extra, duplicate and wrong-product metered items stay `catalog_mismatch` and sticky).
- Upgrade: `python3 scripts/verify-commercial-worker-lease-migration.py` (rolled back; fails under a mutation that lets an expired holder renew).

## Limitations (F2, all fail closed)

1. **The real run has not been executed.** No Stripe TEST credentials were available to this session (and none were read). The harness is proven against a local
   stand-in whose Stripe assumptions are documented in its header; real Stripe may differ (e.g. `create_preview` availability, line shapes, retry timing). Treat the
   first real run as the acceptance test of those assumptions.
2. Hosted Checkout and Stripe-delivered webhooks are manual (above).
3. Nothing triggers settlement (system-actor policy undecided).
4. Stripe's current docs recommend Metronome for NEW usage-based integrations and describe Billing Meters as appropriate for existing users; the founder directed
   meters for this contract. Revisit before the production decision.
5. Resend policy for an `unknown` delivery that reconciliation cannot confirm, seat partial-day proration, grace/dunning, tax, refund/credit eligibility,
   resubscription, reviewer role/UI and voice/SMS runtime gating remain open and unimplemented.
6. Polling reconciliation of subscription state when webhooks stop: implemented in PR F3 (next section); the real-Stripe evidence for it is still manual (runbook section 7).

---

# PR F3 — polling reconciliation of subscription state (2026-11-19)

Sandbox/test mode only. No live Stripe, no production or shared Supabase, no deploy, no real customer, no real money, no public pricing UI. Prices, allowances, caps, the exact
Founder Pilot item set, period boundaries, signed adjustments and cents-based charges are unchanged. Nothing in this PR mutates Stripe: the new reader admits GET only.

**Problem.** Subscription state reaches Postgres only through signed webhooks (PR E1). If Stripe stops delivering, the last state stands until the verified period ends, then the lapse gate
blocks (`subscription_period_elapsed`): a paying workspace that renewed is blocked, and a workspace that canceled or failed payment keeps working until the period ends.

**Approach.** Postgres stays the authority and Stripe stays evidence. A leased worker task compares what Stripe REPORTS for the subscription the SERVER already binds to a shop with what the
database holds, and hands a material difference to the one subscription writer (`commercial_subscription_apply_evidence`) under a new evidence source, `provider_poll`.

## What exists

| Piece | Location |
| --- | --- |
| Migration (new tables + 3 functions; two functions and three closed sets widened in place) | `supabase/migrations/20261119120000_commercial_subscription_poll.sql` |
| GET-only provider reader + pure decisions (the SAME normalizer as the signed webhook) | `src/lib/commercial-subscription-poll.ts` (`normalizeSubscription` is now exported from `commercial-webhook.ts`) |
| Claim / read / decide / record orchestration, sweep report | `src/lib/commercial-subscription-poll-service.ts` |
| Fourth leased worker task `subscription_poll` (bounded, run-level time budget) | `src/lib/commercial-billing-worker.ts`; entry point unchanged (`GET /api/cron/commercial-billing`) |
| Unit tests | `eval/commercial-subscription-poll.test.ts` (28), `eval/commercial-billing-worker.test.ts` (19, +6 poll) |
| Integration tests (real Postgres, fake provider reader) | `eval/integration/commercial-subscription-poll.int.test.ts` (32) |
| Non-destructive upgrade verifier (+ `--mutate sticky|tenant`, which MUST fail) | `scripts/verify-commercial-subscription-poll-migration.py` |

## The flow (one shop per claim)

1. **Claim** (`commercial_subscription_poll_claim`, service role). Eligible = a test-mode account with a bound platform customer in `checkout_pending`, `active`, `past_due`, `incomplete` or
   `unknown`, AND something server-held to compare (recorded subscription evidence, or a Checkout attempt with a recorded session). `canceled` is terminal and `reconciliation_required` is a
   sticky integrity block, so neither is polled. The account row is the per-shop mutex (`FOR UPDATE SKIP LOCKED`, schedule re-read under it), so concurrent claimers cannot both win a shop.
   The claim returns the tenant, the bound customer, the known subscription and the Checkout session/attempt: all from server rows. Nothing comes from the request, the environment or Stripe.
2. **Read** (GET only, PLATFORM account, reviewed API version, the refused-if-live PR C configuration). A known subscription costs ONE list read of that customer
   (`GET /v1/subscriptions?customer=…&status=all`). A subscription this shop has never recorded is discovered ONLY through the server-held Checkout session
   (`GET /v1/checkout/sessions/{id}`: attempt reference, subscription mode, test mode and bound customer all verified; metadata is not consulted), then the same list read.
3. **Decide** (pure). The answer must be COMPLETE (list and items not truncated), TEST-mode and about the bound customer, or it is `ambiguous` and changes nothing. The exact Founder Pilot item
   set and period agreement are judged by the same normalizer as the webhook. `active` is never produced from ambiguous evidence (see table).
4. **Record** (`commercial_subscription_poll_record`). One observation per claim, ever. A material difference goes through `commercial_subscription_apply_evidence('provider_poll', …)`.

| Situation | Result |
| --- | --- |
| Provider and database agree | `unchanged`: an observation row only (no evidence row, no state change) |
| Renewal / recovery / cancellation / payment failure the webhook never delivered | `applied` (or `not_current` if the writer's ordering says so) through the single writer |
| Truncated list or items, live object, foreign customer, unreadable entry, target missing, unrecognised status | `ambiguous` (finite code), nothing changes |
| `active` with another live subscription on the customer (possible duplicate), an unverified period, or an already-elapsed period | `ambiguous`; a MORE RESTRICTIVE state (`past_due`, `canceled`, `incomplete`, `unknown`) is still applied: that is the fail-closed direction |
| Never-seen subscription that the server-held session did not name | `ambiguous` (`subscription_unbound`); a stray subscription is never adopted |
| Checkout session still open / expired | `session_pending`, nothing changes |
| Provider read failed | `unreadable` (finite code, never the error text), nothing changes, the shop backs off |
| Observation about a customer other than the server-held binding | `refused` (`customer_mismatch`), nothing changes |
| Metadata `shop_id` disagrees with the server binding | `refused` (`tenant_conflict`): blocks ONLY the customer's own shop (sticky, as the webhook does); the shop the metadata named is untouched |
| Account already sticky, or terminal `canceled` | not claimed; if the block lands between claim and record the writer records the polled evidence as `blocked_pending_review` and changes nothing |

## Guarantees and where each is enforced

- **Tenant-bound.** Shop, customer, known subscription and attempt come from the claim; the record function re-checks the customer against `commercial_billing_accounts.platform_customer_id`, requires the
  claim to be the live claim of that exact shop, and ignores the metadata `checkout_attempt_id` (discarded in the reader). Provider metadata is only a cross-check.
- **Replay-safe.** `commercial_subscription_poll_observations` (append-only, UNIQUE claim token) is the replay claim: an identical replay returns the stored result, changed content is `CB409`, a
  superseded or expired claim is `CB409` and writes nothing. The polled evidence id is `poll_<claim token>`. Concurrent identical records write one observation and one evidence row.
- **Rate-limited.** `commercial_subscription_poll_schedule` holds `next_due_at`. After a poll: 6 h for a healthy `active` shop with more than 2 h left in its verified period, otherwise 15 min;
  after an `ambiguous` / `unreadable` / `refused` poll (or an abandoned claim) the wait is 15 min doubling per consecutive failure, capped at 6 h. The worker also caps polls per run (10) and
  gives the poll task a 60 s budget inside a 240 s run budget.
- **Lease-safe.** The `subscription_poll` lease row stops overlapping cron runs from doing the same sweep. The lease is an optimization: the per-shop claim is the safety (tested: 10 concurrent claimers
  → one winner; 5 concurrent sweeps → one provider read, one observation, one evidence row). A holder that lost the lease stops before its next claim.
- **Ordering.** Polled evidence is ordered at the claim time MINUS the 5-minute webhook signature tolerance, so a signed webhook created in that window always wins and the poll never overrides fresher
  signed evidence (`out_of_order`). Older evidence cannot regress newer, `canceled` stays terminal, a second live subscription is `duplicate_subscription`: all existing writer rules.
- **Sticky integrity failures are preserved.** `provider_poll` is not `reviewed_reconciliation`: the writer's sticky rule still blocks it, and polling never clears a block. A polled catalog mismatch is the same sticky
  failure the webhook produces.
- **Never active from ambiguous or unverified evidence.** `provider_poll` is refused by the writer unless `p_require_period` is true (an `active` without a verified period is not active), the record function refuses an
  elapsed/unverified period, and the lapse gate accepts polled `active` evidence only with a verified period. Checkout completion is still never payment proof.
- **Observable.** Every poll is a durable observation row (finite outcome + reason, digest, no payload, URL, secret or id in logs); the worker reports counts, `overdue` (eligible shops an hour late) and `failing`
  (shops backing off); `commercial_subscription_poll_overview()` gives the same counts to an operator; a run in which every attempted poll was unreadable is `failed` (503, ops alert), any ambiguity/refusal is `partial`.
- **Live mode and provider mutation stay fail-closed.** The reader type admits GET only; the worker is disabled without the flag and a TEST key; a live-shaped key, a live object, a Connect account or a non-loopback
  base is refused before any read; the database refuses live evidence. Nothing here can create a settlement, adjustment, refund, credit, cancellation, retry, payment or meter event.
- **Unknown delivery outcomes are reconciled, never resent.** Unchanged: `unknown` meter deliveries are reconciled by `delivery_reconcile` (evidence only) and ambiguous adjustment applications are never resent. The poll task
  touches neither (it has no settlement, line or adjustment access), and a held/ambiguous poll never triggers a resend.

## Widened in place (the only changes to existing behavior)

- `commercial_subscription_apply_evidence` and `commercial_execution_gate`: byte-identical to PR E1 except the source set also contains `provider_poll`, the writer refuses it without a required verified period, and the gate
  opens for it only with a verified period. The migration text diff is two small hunks per function.
- Closed sets: `commercial_subscription_evidence.evidence_source`, `commercial_billing_events.kind` (+`subscription_poll_conflict`), `commercial_worker_leases.worker` (+`subscription_poll`, one new idle row).
- Worker report: a task skipped as `not_configured` (older callers/tests) is not an error; a `null` poll reader is a misconfiguration like the other runtimes. The run now has a 240 s total budget (each task still 120 s, poll 60 s).

## Limitations (all fail closed)

1. **Not exercised against real Stripe.** The reader and decisions are proven against a local fake provider that encodes the documented object shapes. The real shapes (list-by-customer on `2024-09-30.acacia`
   with a test-clock customer, `items.has_more`, top-level period fields, `subscription` on a completed session, `client_reference_id`) are an assumption until the manual evidence in runbook section 7 is gathered; if
   any field differs the poll is `ambiguous` (finite code) and changes nothing.
2. Provider facts (`payment_failed`/`cancellation` rows) are written only by the signed-webhook path; polling updates subscription evidence and state, not the fact ledger. Refund/credit facts are never polled.
3. A second live subscription on the bound customer blocks polled `active` (ambiguous) but is not itself recorded or adopted: duplicates are still surfaced by the webhook path / a human. Resubscription after cancel is not implemented.
4. Checkout sessions that expired are observed (`session_pending`/`session_expired`) but the attempt row is not advanced by polling.
5. Unknown **Checkout create** outcomes (an attempt `unknown` before a session id exists) are not reconciled by polling (Stripe offers no lookup by our idempotency key without a session id). They remain a manual
   reconciliation as before.
6. Founder policy still open and unimplemented: partial-day seat proration, grace/dunning timing, tax, refund/credit eligibility, resubscription, reviewer role/UI, voice/SMS runtime gating, unknown-delivery resend
   policy, who triggers `settleCommercialPeriod`, Metronome vs Billing Meters, and the production promotion decision.
