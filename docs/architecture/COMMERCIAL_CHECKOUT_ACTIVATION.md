# Founder Pilot platform billing state and Checkout at first agent activation (Commercial Billing PR C)

_2026-11-06. Sandbox/test mode only. Pricing authority stays in
`src/lib/approved-commercial-catalog.ts` (catalog `2026-11-03.v1`). This PR adds the
tenant-bound PLATFORM billing state and a fail-closed Checkout handoff at the first
agent activation boundary. It adds no usage meters or settlement (PR D), no webhook
reconciliation, dunning, refunds or Customer Portal (PR E), no live mode, deployment or
shared-data change, and it does not lift the production activation freeze._

## Contract implemented

- Only **Founder Pilot** is sellable: $199 USD/workspace/month, resolved at Stripe by the
  approved lookup key `gradia_founder_pilot_2026_11_monthly`. No Stripe object ID, key or
  secret is committed. Growth and Scale are not provisioned.
- Extra seats and pay-as-you-go are ledger/preview facts. The Checkout carries **one line
  item, quantity 1**; no guessed seat or usage quantity is added.
- There is **no Stripe trial**. The 14 days describe pre-activation build/test access;
  activation is the billing boundary and the card is collected at Checkout.
- Stripe PLATFORM billing is separate from each shop's Connect account. Nothing here sends a
  `Stripe-Account` header, and a Connect id (`acct_…`) cannot be stored as the platform customer.
- The legacy $20 / voice add-on / credit-pack / minute-pack paths are unchanged, still
  unavailable, and **not** routed through this flow. A legacy `shops.plan = 'active'` (or
  `voice_addon`) is never read as Founder Pilot proof (tested).

## Audit: the first-agent-activation command

There is **no persisted Agent OS definition store yet**: `compileAgentDefinition`
(`src/lib/agent-os/definition.ts`) is a pure compiler of `AgentActivationEvidence`, and
`/agents` has no activation write. The only persisted per-agent activation today is
`setCustomAgentEnabled({ enabled: true })` (`src/app/actions/custom-agents.ts`), which flips
`custom_agents.enabled` and is what the scheduled-agents cron reads. So no single canonical
command existed. This PR adds the **smallest seam** every activation path calls:

`authorizeAgentActivation` — `src/lib/agent-os/activation.ts`

It is wired into the one real activation, `setCustomAgentEnabled`. No second agent schema
and no parallel activation system was added.

| Path | Status in this PR |
| --- | --- |
| `setCustomAgentEnabled(true)` | **Wired.** Gated by `authorizeAgentActivation`. Turning an agent **off** is never gated. Re-enabling an already-enabled agent is a no-op and is not re-gated. |
| `saveCustomAgent` (draft, always `enabled:false`) | Not gated — **draft creation never requests billing** (tested). |
| Future Agent OS definition → `active` | **Not wired (no persisted write exists).** The seam takes `existing: { ready } \| { ready:false, reasons }`, so the future activation command passes its `compileAgentDefinition` result and the seam stays the single billing/entitlement gate. |
| `setVoiceLive(true)` (voice receptionist go-live) | **Not wired.** It has its own launch gate and becomes an Agent OS playbook later. Documented rather than half-wired. |
| `activatePolicyDraft`, `setAgentMode` | Policy / autonomy-mode changes, not agent activation. Unchanged. |
| Scheduled-agent runtime (cron) | Unchanged. Already-enabled agents keep running; subscription lapse handling is PR E. |

### Gate order (every gate is an AND, none substitutes for another)

1. **Existing gates** (definition, policy, review, connector, memory, approval). If not ready:
   refused with `existing_gate_blocked` + the exact reasons; **no billing is read and no
   Checkout is created**.
2. **Two-active-agent entitlement** (`FOUNDER_PILOT_POLICY.includedActiveAgents = 2`). This limit
   existed only as a constant and in UI copy; it is now enforced at the seam (count of enabled
   `custom_agents`). An unreadable count fails closed.
3. **Reviewed, persisted Founder Pilot subscription evidence.**

A billing "yes" only lets the existing command proceed. It grants no tool, mode, connector or
approval authority, and the RLS-bound update in `setCustomAgentEnabled` still runs after it.

## Data model (migration `20261106120000_commercial_billing_state.sql`)

Adds objects only. No `shops`, `shop_memberships`, `usage_events`, PR A or PR B row is read for
rewriting, altered or backfilled, and no billing state is invented for existing shops.

| Table | Role |
| --- | --- |
| `commercial_billing_accounts` | One **mutable current-pointer** row per shop: platform customer (write-once), catalog/plan binding (immutable), `state`, `state_reason`, current attempt, current evidence, last reconciled event ref, `version` (advances by exactly 1). |
| `commercial_checkout_attempts` | One row per Checkout request. Identity, request fingerprint and requester are immutable; status moves **forward only**; the provider session id is **write-once**. A partial unique index allows **at most one in-flight attempt per shop**. |
| `commercial_billing_events` | Append-only audit trail with a gapless per-shop sequence. Details are bounded and the database **refuses URLs and key-shaped text**. |
| `commercial_subscription_evidence` | Append-only provider subscription evidence. Only `signed_webhook` / `reviewed_reconciliation` sources are representable; `livemode` is CHECKed false. |

Live mode is unrepresentable: `provider_mode` and evidence `livemode` are CHECK-constrained to
test, and session ids must match `^cs_test_`.

### Finite states

`unconfigured` · `checkout_required` · `checkout_pending` · `active` · `past_due` · `canceled` ·
`incomplete` · `unknown` · `reconciliation_required`. Unknown or unverified is **never** active.
`unconfigured` is derived from configuration (never persisted by this PR).

`active` requires, together: an `active` account pointer, evidence with provider status `active`,
`livemode=false`, a reviewed source, the approved catalog version, plan and price lookup key, and a
test-mode account (`evaluateBillingSnapshot`). Anything else is `reconciliation_required`
(`catalog_mismatch` when the version/plan differ).

### Authority

- Server-derived: `requireUser` + `requireShop` supply the actor and shop. The only client input is
  an allowlisted return-target **key** (`agents` | `billing`).
- Writers are **service-role only** and name the actor; the database re-verifies the actor is a
  **live, active owner of that exact shop** on every call (`42501` otherwise). Managers, staff,
  revoked operators, cross-shop owners, unknown actors and anonymous callers are refused.
- Browser roles have **no table privilege and no writer function privilege**. The service role has
  SELECT only on the tables; every write goes through the narrow functions.
- Owners read through `commercial_billing_read` (live-owner check via `auth.uid()`); the service
  role may also read.
- `commercial_subscription_apply_evidence` is the **only** writer that can make an account
  `active`. **Nothing in this PR's application code calls it**; PR E's signed webhook will. It exists
  now so the table contract is fixed and so tests can seed reviewed evidence. A Checkout redirect, a
  client assertion, or creating a Session cannot reach it.

## Checkout flow (`requestFounderPilotCheckout`)

1. Config guard (below). Missing/ambiguous/mismatched → `unconfigured`, nothing else happens.
2. `commercial_checkout_begin` (owner check, row lock, decision): `create` · `replay` ·
   `in_progress` · `blocked` · `active`.
3. `create`: verify the Price → bind/reuse the one platform Customer → create the Session →
   record it. Each step records its outcome atomically.
4. `replay`: **retrieve** the existing session from Stripe (no new create) and return its URL while
   open. `expired` closes the attempt and a new one starts; `complete` records
   `completed_unverified` and **stays `checkout_pending`** (a redirect is not payment proof) and is
   never repeated.

Only a state of "no subscription yet" can start a Checkout. `active`, `past_due`, `canceled`,
`incomplete`, `unknown` and `reconciliation_required` never create another Session, so a retry cannot
silently create a duplicate subscription.

### Idempotency and concurrency

- Provider idempotency keys come from **local identities**: `gradia-cb-customer-<shopId>` and
  `gradia-cb-session-<attemptId>`.
- Concurrent first requests serialize on the account row; exactly one attempt is created and the rest
  return `in_progress` (or replay the recorded session). Tested with eight parallel callers: one
  customer call, one session call, one attempt.
- A changed request (different return target, catalog, plan or lookup key) while one is in flight is a
  `CB409` conflict (`checkout_conflict`).

### Ambiguous vs definitive provider outcomes

| Outcome | Treatment |
| --- | --- |
| Timeout, transport error, unreadable 2xx, 5xx, 409, 429 | **Ambiguous.** Attempt → `unknown`, account → `reconciliation_required` with the exact reason (`session_outcome_unknown`, `customer_outcome_unknown`, `session_record_failed`, `customer_bind_failed`). Never retried blindly: later requests send nothing. |
| 400/401/402/403/404 | **Definitive rejection** (nothing exists remotely). Attempt → `rejected`; a later request may start a new attempt. |
| Price lookup failure (read-only) | Attempt `rejected`, no customer or session was created. |
| Attempt `started` for more than 120 s with no recorded outcome (crashed worker) | Marked `unknown` / `stale_in_flight` on the next request; never retried. |

`reconciliation_required` is resolved by PR E's reconciliation (or a reviewed manual correction); this
PR deliberately provides no automatic way out.

## Stripe adapter

`src/lib/stripe.ts` gained one opt-in transport option (`commercial`: key, base, timeout,
idempotency key) and `stripeCommercialRequest`. **Legacy callers are byte-for-byte unchanged**
(env key, env base, no timeout). The typed client is `src/lib/stripe-commercial.ts`, pinned to the
adapter's existing API version `2024-06-20`.

Stripe calls introduced (all PLATFORM, test mode, none run in automated tests against the network):

| Call | Purpose |
| --- | --- |
| `GET /v1/prices?lookup_keys[0]=…&limit=3` | Resolve the approved Price. Must be exactly one, `active`, USD, `recurring.interval=month` × 1, `unit_amount=19900`, `per_unit`, `licensed`, `livemode=false`, lookup key equal. |
| `POST /v1/customers` (Idempotency-Key) | One platform Customer per shop; metadata `shop_id`, `catalog_version`, `plan_key`. |
| `POST /v1/checkout/sessions` (Idempotency-Key) | `mode=subscription`, one line item × 1, `client_reference_id` = local attempt id, metadata and `subscription_data.metadata` bound to shop, catalog, plan and attempt, `payment_method_collection=always`, no trial. |
| `GET /v1/checkout/sessions/{id}` | Replay: status/URL, plus verification that the session is bound to this shop, attempt, catalog and customer. |

### Safety gates

Configuration (`resolveCommercialStripeConfig`) requires **all** of
`GRADIA_COMMERCIAL_BILLING_STRIPE_MODE=test`, `STRIPE_SECRET_KEY` matching `sk_test_…`/`rk_test_…`, and
`STRIPE_API_BASE` unset or a loopback fixture. Absent → `billing_unconfigured` (the default).
Present but wrong, live-shaped, or pointing at another host → `billing_misconfigured`. A live key is
refused even if the mode flag says `test`. Every provider object must report `livemode=false`. Return
URLs need `GRADIA_DASHBOARD_URL` (https, or loopback http); success/cancel URLs are built on the server
from that origin and an allowlisted path, and carry **no session id or trusted flag**. The Checkout URL
is returned only for an `open` session on `https://checkout.stripe.com`, is **never stored** (the
database refuses it) and is never logged.

## DTO for Cursor

`getCommercialBillingState()` and `requestFounderPilotCheckoutAction(returnTarget?)`
(`src/app/actions/commercial-billing.ts`) return:

```ts
type CommercialBillingDto = {
  state: "unconfigured" | "checkout_required" | "checkout_pending" | "active" | "past_due"
       | "canceled" | "incomplete" | "unknown" | "reconciliation_required"
  eligibleToActivate: boolean              // true ONLY for reviewed, current-catalog active evidence
  blockingReason: CommercialBlockingReason | null   // exact, finite (see commercial-billing.ts)
  checkoutUrl: string | null               // only while a bound session is open; null once eligible
  catalogVersion: "2026-11-03.v1"
  planKey: "founder-pilot"
  providerMode: "test"
}
```

`setCustomAgentEnabled` now returns, on refusal, `{ ok:false, error, blocked: { proceed:false,
code, billing, reasons? } }` where `code` is `existing_gate_blocked`, `active_agent_limit_reached`,
or the exact `blockingReason` (`checkout_required` carries `billing.checkoutUrl`). `error` is a plain
fallback sentence; the owner UI owns final copy and should key off `code`. No full billing or
agent-builder UI is part of this PR.

## Verification

- Unit: `eval/commercial-billing.test.ts`, `eval/stripe-commercial.test.ts`,
  `eval/custom-agent-activation-billing.test.ts` (fetch is stubbed; the harness blocks the network).
- Integration (disposable stack, real Postgres, fake Stripe client with Stripe-like idempotency):
  `eval/integration/commercial-billing.int.test.ts`.
- Non-destructive upgrade verifier: `scripts/verify-commercial-billing-migration.py` — runs the real
  migration SQL inside one rolled-back transaction after seeding legacy shops, memberships, PR A usage
  and PR B membership evidence, and proves nothing was rewritten.

## Limitations (deliberate, fail closed)

1. **Nothing can make an account `active` in production yet.** Signed webhook reconciliation is PR E, so
   with this PR merged, enabling an agent is refused (`checkout_required` → Checkout → still blocked)
   until that lands and a production activation decision is made. This is the intended freeze, not a bug.
   Existing already-enabled agents are not touched.
2. `reconciliation_required` has no automatic exit until PR E.
3. Customer idempotency is Stripe's 24 h replay window; an orphaned customer after a crash is possible
   but cannot be double-bound, and the shop stays blocked until reconciled.
4. The scheduled-agents runtime is not billing-gated (PR E handles lapse/cancellation).
5. `setVoiceLive` and the future Agent OS definition activation are not wired (see the audit table).
6. Webhook, dunning, refunds, Customer Portal, tax, usage meters/settlement, caps, extra-seat
   quantities and Growth/Scale remain out of scope.
7. The Postgres build in the local Supabase stack segfaults when `SET ROLE` is followed by a handled permission
   error inside a `DO` block, so the verifier simulates roles with the JWT claim and proves EXECUTE
   grants with `has_function_privilege`; the integration suite exercises real `anon`/`authenticated`
   PostgREST calls.

## Follow-on

PR D maps reviewed Stripe meters/events and settles the PR A ledger. PR E adds signed webhook
reconciliation (the caller of `commercial_subscription_apply_evidence`), dunning/cancellation/refund
states and Customer Portal links. PR F runs test-clock, duplicate/out-of-order webhook, cap and full
sandbox acceptance before any production activation decision.
