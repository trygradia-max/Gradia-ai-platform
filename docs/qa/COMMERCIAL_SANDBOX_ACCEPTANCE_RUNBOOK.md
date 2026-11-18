# Founder/operator runbook: Stripe SANDBOX acceptance for the Founder Pilot

Test mode only. Never use a live key, live Dashboard, production Supabase or Vercel. Design: `docs/architecture/COMMERCIAL_SANDBOX_ACCEPTANCE.md`.

## 1. Check where you are (no network)

```
npm run billing:sandbox-acceptance
```

Prints `SANDBOX ACCEPTANCE: READY` or `NOT_READY` with a finite, ordered blocker list, the names the sandbox must contain, the manual
Dashboard steps and what the command does NOT prove. Exit 0 = READY, 1 = NOT_READY, 2 = internal error. It never prints a secret, key, id or URL,
refuses a live-shaped key, and does not read `.env` files by itself.

## 2. Manual Stripe Dashboard steps (a human does these; the command only checks some)

1. Use the **test-mode sandbox** only.
2. Product `Gradia Founder Pilot`, metadata `catalog_version=2026-11-03.v1`, `plan_key=founder-pilot`.
3. Recurring monthly USD 199.00 licensed Price, lookup key `gradia_founder_pilot_2026_11_monthly`.
4. Six billing meters (sum, customer mapping by id `stripe_customer_id`, value key `value`, no event time window) with the event names the command prints.
5. One metered monthly USD Price per meter on the same Product, with the printed lookup key and unit amount.
6. A test-mode webhook endpoint for `POST /api/stripe/commercial-webhook` pinned to API version `2024-09-30.acacia`; keep its signing secret local.
7. Customer Portal configuration (founder decision).
8. When the founder has confirmed the proposed names, a **reviewed commit** names the verified meters in `REVIEWED_SETTLEMENT_METER_MAPPING`.

None of these is performed or verified for you. Items 2-5 are verified by step 3 below; 6-8 are not.

## 3. Verify the sandbox (read-only network)

```
GRADIA_COMMERCIAL_BILLING_STRIPE_MODE=test STRIPE_SECRET_KEY=sk_test_... \
GRADIA_COMMERCIAL_STRIPE_WEBHOOK_SECRET=whsec_... GRADIA_DASHBOARD_URL=https://... \
npm run billing:sandbox-acceptance -- --network
```

(Or `node --env-file=<your local env file> scripts/commercial-sandbox-acceptance.mjs --network`.) Only GET requests are sent. Fix each blocker
in the Dashboard and re-run. The last blocker is normally `settlement_mapping_unprovisioned`, cleared by step 2.8.

## 4. What READY does and does not mean

READY = configuration is test-shaped, the sandbox matches the contract, and the mapping is provisioned. It does **not** prove metered Prices are
on the subscription, a real test-clock run, the webhook endpoint, or the Portal (PR F2).

## 5. Operating the workers (service role; sandbox only)

- Dispatch pending deliveries: `dispatchPendingSettlementDeliveries(serviceClient, runtime, { shopId? })`.
- Reconcile `unknown` deliveries: `reconcileUnknownDeliveries(serviceClient, reader, { shopId? })` (evidence only, never resends).
- Apply approved adjustments: `applyApprovedAdjustments(serviceClient, runtime, { shopId? })` (only reviewer-approved, either sign).

None is scheduled by this PR. An `unknown` or `rejected` line needs a human decision; nothing resends it.

## 6. Tests

```
npm test                                  # unit (no network)
npm run test:int                          # needs the disposable stack; see the resume handoff for the env
python3 scripts/verify-commercial-sandbox-acceptance-migration.py
```
