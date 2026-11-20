# Founder/operator runbook: Stripe SANDBOX acceptance for the Founder Pilot

Test mode only. Never use a live key, live Dashboard, production Supabase or Vercel. Design: `docs/architecture/COMMERCIAL_SANDBOX_ACCEPTANCE.md` (F1 + "PR F2").
Founder direction (2026-11-18): the F1 meter contract (event names, lookup keys, API version `2024-09-30.acacia`) is the TEST-mode contract. **Production
promotion still needs a final reviewed release decision.**

## 1. Check where you are (no network)

```
npm run billing:sandbox-acceptance          # full report (NOT_READY offline)
npm run billing:sandbox-acceptance -- --local   # exit 0 iff the LOCAL fixtures pass (what CI may run); never prints READY
```

Prints `SANDBOX ACCEPTANCE: READY|NOT_READY`, `LOCAL FIXTURE READINESS: PASS|FAIL`, `REAL STRIPE ACCEPTANCE: NOT RUN|PASSED|...`, a finite ordered blocker list,
the names the sandbox must contain, the manual steps and what the command does NOT prove. Exit 0 = READY, 1 = NOT_READY, 2 = internal error. It never prints a
secret, key, id or URL, refuses a live-shaped key, and does not read `.env` files by itself.

## 2. Stripe Dashboard setup (a human; the command verifies items 2-5 read-only)

1. TEST-mode sandbox only.
2. Product `Gradia Founder Pilot`, metadata `catalog_version=2026-11-03.v1`, `plan_key=founder-pilot`.
3. Recurring monthly USD 199.00 **licensed** Price, lookup key `gradia_founder_pilot_2026_11_monthly`.
4. Six billing meters (sum, customer mapping by id `stripe_customer_id`, value key `value`, no event time window) with the event names the command prints.
5. One **metered** monthly USD Price per meter on the same Product with the printed lookup key and unit amount.
6. A TEST webhook endpoint for `POST /api/stripe/commercial-webhook` pinned to API version `2024-09-30.acacia`; keep its signing secret local.
7. Customer Portal configuration (founder decision).

## 3. Verify the sandbox (read-only network)

```
GRADIA_COMMERCIAL_BILLING_STRIPE_MODE=test STRIPE_SECRET_KEY=sk_test_... \
GRADIA_COMMERCIAL_STRIPE_WEBHOOK_SECRET=whsec_... GRADIA_DASHBOARD_URL=https://... \
CRON_SECRET=... GRADIA_COMMERCIAL_BILLING_WORKER=enabled \
npm run billing:sandbox-acceptance -- --network
```

(Or `node --env-file=<your local env file> scripts/commercial-sandbox-acceptance.mjs --network`.) Only GET requests are sent. Fix each blocker and re-run.

## 4. The real test-clock run (opt-in; mutates only the Stripe TEST sandbox)

```
GRADIA_STRIPE_TEST_CLOCK_ACCEPTANCE=1 GRADIA_COMMERCIAL_BILLING_STRIPE_MODE=test STRIPE_SECRET_KEY=sk_test_... \
npm run billing:test-clock-acceptance -- --i-understand-this-mutates-stripe-test --evidence-out /path/outside/the/repo/evidence.json
```

- It refuses before any request on: no opt-in, no confirmation flag, CI, a live-shaped key, a non-test mode, a foreign API base. Exit 0 = PASSED, 1 = FAILED/INCOMPLETE,
  3 = REFUSED (nothing sent), 2 = internal error.
- It creates a test clock (~25 days back), one customer, one Checkout Session (expired afterwards), one subscription, six meter events, advances two renewals, fails a
  payment, recovers, cancels, then **deletes the test clock** (which deletes the customer and subscription). Output is finite codes and integer cents only: no ids, URLs,
  secrets or payloads. Keep the evidence file out of the repo anyway.
- **If it prints `CLEANUP_FAILED`** (or crashes): open the Stripe TEST Dashboard → Billing → Subscriptions → Simulations, find the simulation named `gradia-f2-acceptance-<run>`
  and "Finish simulation". Meter events cannot be deleted; they hang off the deleted test customer. Stripe also auto-deletes simulations after 30 days.
- `NOT_RUN preview_api_unavailable` means the upcoming-invoice preview endpoint is not available to this account/API version: the run is `INCOMPLETE`, not passed. Record it as
  a finding; do not edit the evidence.
- `OBSERVED late_usage_*` is not pass/fail: it records whether usage for a closed period sent after the invoice finalized was billed on the next invoice. Report it in the production decision.

## 5. The two manual steps (Stripe's API cannot do them)

1. **Hosted Checkout.** Create a Checkout for a sandbox shop through the app (or the real client in a scratch script), open the Checkout URL **in a browser** (never paste it anywhere),
   pay with a test card (`4242 4242 4242 4242`), and confirm the subscription shows the 7 items.
2. **Stripe-delivered webhook.** In the Stripe TEST Dashboard → Developers → Webhooks → your endpoint → event deliveries, confirm a `customer.subscription.*` event was delivered with a 2xx.

When both are truly done, attest them when asking for the final report (this is your explicit claim; the command cannot verify it):

```
npm run billing:sandbox-acceptance -- --network --evidence /path/to/evidence.json \
  --attest hosted_checkout_completion --attest stripe_delivered_webhook
```

READY needs everything: the contract, exact items, webhook rule, worker configuration, the verified sandbox, current evidence (≤ 30 days, current contract) and both attestations.

## 6. Operating the worker (service role; sandbox only)

- Route: `GET /api/cron/commercial-billing` with `Authorization: Bearer $CRON_SECRET`. Disabled (200 `disabled`) unless `GRADIA_COMMERCIAL_BILLING_WORKER=enabled` and a TEST key; scheduled
  every 10 minutes in `vercel.json` (no effect while crons/deployments stay disabled). A 503 means misconfigured or the sandbox did not verify (nothing was sent); a 200 with a `lease_held`
  task means an overlapping run was skipped (normal).
- Order per run: dispatch pending deliveries → reconcile `unknown` deliveries (evidence only) → apply human-approved adjustments → (F3) poll due subscriptions (GET only). It never resends an `unknown` or `rejected` line, never
  applies an unreviewed adjustment, and never settles a period (settlement trigger is a founder decision). Usage must reach Stripe before the renewal invoice finalizes (~1 h after the boundary).
- Operator view of leases: `commercial_worker_lease_read()` (service role) shows held / generation / last outcome; the token is never returned.

## 7. Subscription polling (PR F3): the Stripe evidence that is STILL REQUIRED

The polling task (`subscription_poll`, same cron, same flag, GET only) is proven against a local fake provider. **Nothing below has been run against real Stripe**: this session had no Stripe TEST credentials and
does not claim it. Do these in the Stripe TEST sandbox only, with the worker enabled (`GRADIA_COMMERCIAL_BILLING_WORKER=enabled`, a TEST key) against a disposable/sandbox database, never production or shared data. Record
**finite results only** (outcome names and counts from `commercial_subscription_poll_overview()` and the cron response); never paste ids, URLs, keys or payloads.

1. **Real object shapes (read-only).** For one sandbox customer with the 7-item subscription (from section 4/5), confirm with `GET /v1/subscriptions?customer=<id>&status=all` on API version `2024-09-30.acacia`: the
   test-clock customer's subscription IS listed; `items.has_more` is `false`; `current_period_start/end` and `start_date` are present at the top level; every item's `price.lookup_key` is present and the base item
   has `quantity: 1`. For a completed hosted Checkout (manual step 1) confirm `GET /v1/checkout/sessions/<cs_test_id>` returns `status: complete`, `subscription` as an id string, `client_reference_id` equal to the attempt
   and `customer` equal to the bound customer. If any of these differ the poll is `ambiguous` (`items_incomplete`, `period_not_verified`, `session_binding_mismatch`, `session_subscription_missing`, `target_missing`):
   it fails closed, and the finding must be reported before this is relied on.
2. **Webhooks stopped, renewal learned by polling (the main case).** With the dedicated webhook endpoint disabled (Developers → Webhooks → disable, TEST mode) or its signing secret deliberately not configured, advance the
   test clock of an `active` sandbox subscription past its period end plus about 2 h. Confirm in order: the lapse gate blocks (`subscription_period_elapsed`); after the next cron tick the poll records `applied`; the
   account is `active` with a new verified period (source `provider_poll`); the gate allows again; the next poll within the interval is not even claimed (no provider read), and a forced re-poll is `unchanged`.
   Re-enable the endpoint afterwards and confirm a later signed event converges to the same state (a signed event inside the 5-minute window wins over a poll).
3. **The fail-closed directions.** Same setup with webhooks stopped: (a) renewal with a card that cannot be charged (`4000 0000 0000 0341`) → the poll records `past_due` and the gate blocks; (b) cancel the subscription in the
   Dashboard → the poll records `canceled` (terminal) and the account stops being polled; (c) create a second subscription on the same customer in the Dashboard → polled `active` becomes `ambiguous`
   (`unexpected_subscription`) and nothing is marked active.
4. **Zero writes at Stripe.** Compare the Dashboard event log (Developers → Logs, TEST) before and after a poll run: only `GET /v1/subscriptions` and `GET /v1/checkout/sessions/…` requests from the platform key; no POST/DELETE.
5. **Real rate behavior.** Confirm there is no TEST-mode rate-limit response (HTTP 429) for the polling volume (at most 10 shops per run, two reads each). A 429 is recorded as `unreadable` and backs the shop off.
6. **Cleanup.** Polling creates nothing at Stripe. Delete the test clock/simulation as in section 4.

Operator view (service role only): `select public.commercial_subscription_poll_overview();` returns `eligible`, `due`, `claimed`, `never_polled`, `failing`, `overdue`, `oldest_last_observed_at`, `outcomes_24h`
(counts only). Per-shop history is the append-only `commercial_subscription_poll_observations` table. `overdue > 0` or a run that is `failed` means polls are not completing: check the Stripe key and connectivity first.

## 8. Tests

```
npm test                                  # unit (no network)
npm run test:int                          # needs the disposable stack; see the resume handoffs for the env
python3 scripts/verify-commercial-worker-lease-migration.py
python3 scripts/verify-commercial-sandbox-acceptance-migration.py
python3 scripts/verify-commercial-subscription-poll-migration.py            # PASS
python3 scripts/verify-commercial-subscription-poll-migration.py --mutate sticky   # must report EXPECTED FAIL
```
