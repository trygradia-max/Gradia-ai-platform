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

_Update 2026-11-07: Build 1 added the persisted definition store; see the table row below and `AGENT_DEFINITION_REVISIONS.md`. The audit below is the state when this PR was written._

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
| Agent OS definition → `active` | **Wired (Build 1, 2026-11-07).** `agent_definition_activate` calls `commercial_agent_activate` in the same transaction (see `AGENT_DEFINITION_REVISIONS.md`); `commercial_agent_activate` is unchanged. A governed agent can no longer be enabled through the legacy `setCustomAgentEnabled` path. |
| `setVoiceLive(true)` (voice receptionist go-live) | **Not wired.** It has its own launch gate and becomes an Agent OS playbook later. Documented rather than half-wired. |
| `activatePolicyDraft`, `setAgentMode` | Policy / autonomy-mode changes, not agent activation. Unchanged. |
| Scheduled-agent runtime (cron) | Unchanged. Already-enabled agents keep running; subscription lapse handling is PR E. |

### Gate order (every gate is an AND, none substitutes for another)

1. **Existing gates** (definition, policy, review, connector, memory, approval). If not ready:
   refused with `existing_gate_blocked` + the exact reasons; **no billing is read, no writer is
   called and no Checkout is created**.
2. **Final entitlement + write: one database transaction** — `commercial_agent_activate`
   (migration `20261106130000_commercial_agent_activation.sql`). In that single owner-verified
   transaction it: requires the service role *and* a live active owner of the exact shop (`42501`
   otherwise); locks the tenant-bound target agent row (a foreign or unknown id is `agent_not_found`);
   returns `already_active` as an idempotent no-op; locks the shop's billing account row (agent row
   first, account row second, always, so activations serialize per shop without deadlock); **counts
   active agents itself** and refuses at `FOUNDER_PILOT_POLICY.includedActiveAgents = 2`
   (`active_agent_limit_reached`); rechecks the exact reviewed active subscription evidence and catalog
   (state `active`, test mode, evidence `active`, `livemode=false`, catalog `2026-11-03.v1`, plan
   `founder-pilot`, price lookup key, reviewed source); and only then enables **that one agent**.
   An application-supplied count is never an input. The 2-agent limit is checked before the evidence,
   matching the earlier order.
3. **Checkout handoff.** If the database answers `billing_not_active`, the seam reads the display
   state; for `checkout_required`/`checkout_pending` it returns the server-created Checkout
   (repeat requests reuse the same open session). A display read that looks eligible cannot override
   a database refusal: it fails closed as `reconciliation_required`.

`setCustomAgentEnabled(true)` no longer reads a count or writes `enabled`; the database writer is
the only enabling write. Its `blocked.code` additionally includes `agent_not_found`.

**No bypass.** A guard trigger on `custom_agents` (`custom_agents_activation_guard`) refuses any
INSERT/UPDATE that turns `enabled` on unless the caller is the service role or is inside
`commercial_agent_activate` (a transaction-local setting). The owner's RLS-bound direct UPDATE can
therefore no longer enable an agent around the gate; **disabling and draft inserts are untouched and
never require billing**. Service-role fixtures and operators keep their existing authority.

Side effect: a refused activation that reaches the billing lock (limit, no evidence) opens the
shop's `checkout_required` account row (the same row Checkout would open). Refusals for an unknown
agent, a non-owner, or an unready existing gate do not.

A billing "yes" only lets the activation proceed. It grants no tool, mode, connector or approval
authority.

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
  an allowlisted return-target **key** (`agents` → `/agents`, the canonical Agent OS home since
  PR #133, | `billing` → `/billing`).
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
is returned only for a session whose status is exactly `open` on `https://checkout.stripe.com`; a
missing, `null` or unknown status is an unreadable provider response (ambiguous →
`reconciliation_required`), never "open". The URL is **never stored** (the
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
`agent_not_found`,
or the exact `blockingReason` (`checkout_required` carries `billing.checkoutUrl`). `error` is a plain
fallback sentence; the owner UI owns final copy and should key off `code`. No full billing or
agent-builder UI is part of this PR.

## Verification

- Unit: `eval/commercial-billing.test.ts`, `eval/stripe-commercial.test.ts`,
  `eval/custom-agent-activation-billing.test.ts` (fetch is stubbed; the harness blocks the network).
- Integration (disposable stack, real Postgres, fake Stripe client with Stripe-like idempotency):
  `eval/integration/commercial-billing.int.test.ts`.
- Concurrency: from one active agent, two simultaneous activations of two inactive agents (5 rounds,
  and once through the application seam) leave exactly two active with exactly one success; the same
  agent requested twice activates once.
- Non-destructive upgrade verifier: `scripts/verify-commercial-billing-migration.py` — runs both
  migrations' real SQL inside one rolled-back transaction after seeding legacy shops, memberships, PR A usage
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
