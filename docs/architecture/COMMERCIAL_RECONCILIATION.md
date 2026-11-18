# Signed webhook reconciliation, lapse gate, Customer Portal and period binding (Commercial Billing PR E1)

_2026-11-16. Sandbox/test mode only. Pricing authority stays in `src/lib/approved-commercial-catalog.ts`
(catalog `2026-11-03.v1`). This PR makes **signed Stripe events** the way a platform subscription becomes
`active`, `past_due`, `canceled` and so on; stops **new** paid work when billing is not active; adds an
owner-only Customer Portal handoff; binds settlement to the **exact verified Stripe subscription period**; and
fixes the **append-only signed-adjustment contract**. It calls no live Stripe, creates no Dashboard object,
provisions no meter, changes no price or package, and touches no shared or production data._

Postgres is the billing authority. Stripe is evidence. Nothing in this PR issues a refund, a credit, a
cancellation, a retry or a payment.

## What exists

| Piece | Location |
| --- | --- |
| Migration | `supabase/migrations/20261116140000_commercial_reconciliation.sql` |
| Pure webhook rules (config, raw-body signature, envelope, normalization) | `src/lib/commercial-webhook.ts` |
| Orchestration (signature → parse → one atomic database call → HTTP mapping) | `src/lib/commercial-webhook-service.ts` |
| Route (thin adapter, **dedicated** URL) | `src/app/api/stripe/commercial-webhook/route.ts` |
| Lapse gate | `src/lib/commercial-execution-gate.ts`, wired in `src/lib/agent-runtime.ts` |
| Portal | `createPlatformPortalClient` (`stripe-commercial.ts`), `requestCommercialBillingPortal` (`commercial-billing-service.ts`), `openCommercialBillingPortalAction` (`app/actions/commercial-billing.ts`) |
| Settlement window rules | `commercial-settlement.ts`, `commercial-settlement-service.ts` |
| Unit tests (22 + updated 30) | `eval/commercial-webhook.test.ts`, `eval/commercial-settlement.test.ts` |
| Integration tests (48) | `eval/integration/commercial-reconciliation.int.test.ts` (PR C 70 and PR D 33 suites updated and green) |
| Non-destructive upgrade verifier | `scripts/verify-commercial-reconciliation-migration.py` |

> **Update 2026-11-18 (PR F2, `COMMERCIAL_SANDBOX_ACCEPTANCE.md`).** The "exactly **one** item at quantity 1" rule below is replaced by the **exact item set**
> in any order: the licensed base Price (quantity 1) + exactly the six reviewed metered Prices (by lookup key; no quantity). A missing, extra, duplicate, unknown
> or mismatched item (amount, currency, interval, usage type, live price, missing meter, different Product) is `catalog_mismatch` and sticky, as before. Item-level
> periods must agree with each other and with the top-level period. The database is unchanged; metadata remains a cross-check and the tenant still comes only
> from server-held bindings. The worker that dispatches/reconciles/applies is described there too (lease, bounds, cron).

## The endpoint is PLATFORM billing, never Connect

- URL `POST /api/stripe/commercial-webhook`. The Connect/collection webhook (`/api/stripe/webhook`, secret
  `STRIPE_WEBHOOK_SECRET`) is untouched and unrelated.
- Own signing secret `GRADIA_COMMERCIAL_STRIPE_WEBHOOK_SECRET`. The endpoint is **disabled (503)** unless
  `GRADIA_COMMERCIAL_BILLING_STRIPE_MODE=test` and a well-formed `whsec_…` secret are both present.
  It is `webhook_misconfigured` (503, nothing read) when the mode is not `test`, the secret is malformed,
  the secret **equals the Connect webhook secret**, or a **live-shaped** `STRIPE_SECRET_KEY` is present.
- Order of operations is a contract: **configuration → signature over the RAW body → parse → refuse
  Connect/live → normalize → one database call.** Nothing is parsed before the HMAC verifies
  (`request.text()`, the documented Next.js Route Handler pattern; a re-serialized body has a different
  signature). A body that is invalid JSON with a bad signature is reported as `invalid_signature`.
- Refused with 400 and **no database call**: an envelope with an `account` (Connect), `livemode !== false`
  on the event or on the object (a missing flag is not assumed safe), a live-shaped id (`cs_live_…`),
  an invalid envelope, an invalid object. Unhandled event types are acknowledged `200 ignored` with no write.
  Bodies over 1 MB are 413.
- The database also refuses `livemode = true` even from the service role (`22023`), and receipts CHECK
  `livemode = false`.

## Durable replay claim

`commercial_webhook_receipts` is the claim: one row per verified Stripe event id with the SHA-256 digest of the
raw body (no payload is stored). It is written **last, in the same transaction as the effect**
(`commercial_webhook_ingest`), serialized per event id by an advisory lock, so:

- an identical redelivery returns the original outcome (`replayed: true`) and writes nothing;
- the same event id with different content is `CB409` → HTTP 409, and changes nothing;
- 8 concurrent identical deliveries produce one receipt, one evidence row, one period (tested);
- a crash or a failed call rolls back the effect **and** the claim, so there is no stuck "in progress" state and
  Stripe's retry (HTTP 500) is always safe.

Memory is never used for replay protection.

## Tenant resolution (server-held bindings only)

The application never names a tenant: `p_shop` is not an argument of the ingest function.

| Event object | Resolved from |
| --- | --- |
| subscription / invoice / charge / credit note | the **bound platform customer** (`commercial_billing_accounts.platform_customer_id`, write-once, unique) |
| Checkout session | the recorded provider session id (`commercial_checkout_attempts.provider_session_id`, unique) and its bound customer |
| a subscription not yet known | additionally a **Checkout attempt of that same shop** that holds a recorded session and is still `session_open`/`completed_unverified` (metadata `checkout_attempt_id` is only a *lookup key into server rows*) |
| invoice facts | additionally a subscription this shop already has evidence for |

Outcomes that are not applied are recorded, never guessed: `unresolved` (`customer_unbound`,
`session_unbound`, `subscription_unbound`) changes nothing. A `metadata.shop_id` that **disagrees** with the
resolved shop is an integrity conflict: it is `refused`, **blocks the customer's own shop**
(`reconciliation_required` / `tenant_conflict`) and never touches the shop the metadata named. Catalog, plan and
price must match the account's approved binding: the subscription must be exactly **one** item at quantity 1 whose
price lookup key is `gradia_founder_pilot_2026_11_monthly`; anything else is `catalog_mismatch`.

## One subscription truth: `commercial_subscription_apply_evidence`

The PR C writer is **extended in place** (new optional parameters; the old 12-argument signature is dropped,
named callers are unaffected) and remains the only function that can make an account `active`. The webhook path
calls it with `p_require_period = true`.

Finite states: `active`, `past_due`, `incomplete`, `canceled`, `unknown` (unpaid/paused/trialing), and
`reconciliation_required`. **Checkout completion alone is never active**: `checkout.session.completed` only moves
the attempt to `completed_unverified` and keeps the account `checkout_pending`
(`checkout_completed_awaiting_evidence`); arriving *after* subscription evidence it does not regress the account.

Deterministic ordering (never regresses newer evidence):

| Rule | Behaviour |
| --- | --- |
| Older than the current evidence | recorded, **does not advance** (`out_of_order`) |
| Same second, different state | advances only if strictly more severe (canceled > reconciliation_required > past_due > incomplete > unknown > active), so **both arrival orders converge** |
| `canceled` | terminal for its subscription (`subscription_terminal`); only a *different* subscription could replace it |
| Event about a non-current subscription that is not live | recorded, cannot move the account (`other_subscription`) |
| A second live (or integrity-flagged) subscription for the workspace | `reconciliation_required` / `duplicate_subscription`, **in any arrival order** |
| Integrity reasons (`duplicate_subscription`, `catalog_mismatch`, `customer_mismatch`, `tenant_conflict`, `period_conflict`, `period_unverified`, `session_binding_mismatch`) | **sticky**: a later correct webhook is recorded but `blocked_pending_review`; only a `reviewed_reconciliation` source clears it |
| Signed `active` with no verified period | `reconciliation_required` / `period_unverified` — not active |

`past_due` recovers to `active` only through newer signed `active` evidence.

## Provider facts: recorded, never acted on

`commercial_provider_facts` is append-only evidence of what Stripe **reported**: `payment_failed`,
`payment_succeeded`, `cancellation`, `cancellation_scheduled` (once, when `cancel_at_period_end` first turns
true), `refund` and `credit_note` (provider-reported magnitudes, no sign, no decision). Recording a fact changes
no account state (a payment failure alone does not flip the account; the **subscription status** is the single
truth), creates no settlement, adjustment, line, refund, credit, cancellation or retry, and calls no provider
(the webhook path has no Stripe client at all).

## Lapse enforcement for new paid execution

`commercial_execution_gate(shop)` (service role) answers allow/block from the database at decision time:

| Workspace | Gate |
| --- | --- |
| no commercial billing account | allowed, explicitly **legacy** (PR C invented no billing state for existing shops) |
| account present, reviewed `active` evidence, period not elapsed | allowed |
| `past_due`, `canceled`, `incomplete`, `checkout_*`, `unknown`, `reconciliation_required` | **blocked** with the exact reason |
| `active` but unreviewed/mismatched evidence | blocked (`reconciliation_required`) |
| `active` but the verified period has ended with no newer evidence | blocked (`subscription_period_elapsed`): uncertain |
| the read fails or is unreadable | blocked (`billing_state_unavailable`) |

Wired before any claim or recipe work in the scheduled tick (once per shop per tick), "Run now"
(`runCustomAgent`) and event recipes (`runEventRecipe`). Blocking **only stops new work**: it deletes or edits no
agent definition, evidence, approval or audit row, disables no agent, revokes no membership, and the owner can
still open the app, see billing and reach the Portal. Recovery is automatic when newer `active` evidence arrives.
**No grace period exists**: grace length and automatic dunning timing are founder-policy-required, so `past_due`
blocks immediately (fail closed).

## Owner-only Customer Portal

`openCommercialBillingPortalAction(returnTarget?)` → `requestCommercialBillingPortal`. The database
(`commercial_portal_authorize`, service role) verifies the actor is a **live owner of that exact shop** and returns
the **exact bound platform customer**; managers, staff, revoked operators, other workspaces' owners and anonymous
callers fail (`owner_required`) and the provider is never called. The only client input is an allowlisted
return-target **key**; the return URL is built on the server from `GRADIA_DASHBOARD_URL` (https or loopback) and a
fixed path. `POST /v1/billing_portal/sessions` is PLATFORM, test mode only (no `Stripe-Account` header). The reply is
validated (`livemode=false`, same customer, `https://billing.stripe.com`, no credentials in the URL) and the URL is
**never stored and never logged** (the events table's CHECK forbids URLs; tested). A provider failure creates
nothing and is not retried. Allowed in every state that has a bound customer (an owner with a failed payment must
be able to fix it). What the Portal lets a customer do (cancel, change plan, update card) is Dashboard
configuration — a founder decision not made here.

## Settlement is bound to the exact verified Stripe subscription period

Founder decision 2026-11-16 (2): the period is the exact Stripe subscription period beginning at first activation.

- `commercial_subscription_periods` (append-only) records each **verified** period from clean `active` evidence
  (even if it arrived out of order): period start/end from the signed subscription (top-level fields, or the
  item fields in newer API shapes; if they disagree the period is **unverified**, never guessed) and the
  subscription's own `start_date`. Periods cannot overlap (trigger); an overlap or a changed subscription start is
  `period_conflict` and is not recorded.
- `commercial_settlement_begin` / `commercial_settlement_evidence` (PR D functions, replaced in place, ACLs
  unchanged) now require the window to **equal a verified period exactly** and its chain of contiguous periods to
  reach back to the subscription's start (first activation). The UTC-midnight / 28–31-day placeholder no longer
  authorizes anything. An account in `reconciliation_required` cannot settle. A canceled account can still settle
  a closed, verified period (unchanged PR D rule).
- The value basis is untouched: outcomes carry billed **quantity**; voice, SMS and seat carry **settled cents**.
  No meter or event name is provisioned; the mapping is still unprovisioned and nothing is sent or resent
  (an `unknown`/`rejected` delivery is still never retried automatically).

> **Open founder decision (fails closed, not invented here).** Seat proration (PR B) is UTC-**day** based and
> refuses a period that does not start and end at UTC midnight (`period_not_utc_day_aligned`). A real Stripe period
> starts at the instant of activation, so it is verified and bound but the preview is `blocked` /
> `seat_proration_unavailable` until the founder decides how partial first/last days are counted (or the
> subscription is anchored to UTC midnight). This PR does not guess a partial-day rule because that is a price.

## Late evidence: the signed adjustment contract (no application)

A settled period is never rewritten (settlements, lines and events stay immutable; the PR D `CB409` on changed
evidence stays). Tables `commercial_settlement_adjustments` and `commercial_adjustment_reviews` (append-only) and
service-role functions `commercial_adjustment_propose` / `_review` / `_read` fix the contract:

- signed integer cents (**negative = credit toward the customer, positive = additional charge, never zero**), USD,
  bound to one existing settlement of the same shop, `target_period_start` = that settlement's window end (the
  **next** invoice), a stable idempotency key (exact replay, changed replay `CB409`), an optional provider fact of
  the same shop as evidence;
- every adjustment is pending until **one** decision by an identified human reviewer reference
  (`reviewer:<id>`, never an email); a second or different decision is `CB409`; only `approved` / `rejected` exist;
- **there is no `applied` state and no function that applies, credits, refunds or invoices.** Nothing calls
  propose/review from application code; refund/credit **facts do not auto-create adjustments** (refund eligibility
  is founder policy). Who may call review (platform operators are not modelled yet) and how an approved adjustment
  reaches Stripe are follow-on work.

## Authority

| Caller | Ingest / gate / portal authorize / propose / review / period status | Adjustment read | Tables |
| --- | --- | --- | --- |
| service role | yes (functions only; portal names a live owner) | yes | SELECT only |
| live shop owner (session) | no (`42501`) | yes, own shop | none |
| manager, staff, revoked, other-shop owner, anonymous | no (`42501`) | `42501` | none |

All new tables are append-only for every role including the table owner (UPDATE/DELETE/TRUNCATE refused; only the
shop-deletion cascade removes rows). Live mode is unrepresentable; event details refuse URLs and key-shaped text.

## Verification

- Unit (22): config fail-closed, raw-body signature (tamper, secret, stale, malformed, multiple `v1`), Connect/live
  refusal, normalization (exact approved item, period shapes, disagreeing periods), HTTP mapping and ordering
  (signature before parse, no database call on refusal), portal client request shape and reply validation,
  gate interpretation.
- Integration (48, real Postgres, no Stripe): platform-vs-Connect and live-vs-test, durable replay (identical,
  changed, 8-way concurrent, 6 different concurrent events), tenant binding (unknown customer, unbound
  subscription, foreign attempt, metadata conflict), checkout completion not active, every provider status, wrong
  price/quantity/catalog and its stickiness, duplicate subscription, terminal cancel, out-of-order, same-instant
  convergence, facts without effect, lapse (legacy, elapsed, read failure, agent entry points, nothing erased,
  automatic recovery), owner-only portal (every denied role, no customer, unconfigured, provider failure, bad
  target, URL never stored), exact-period binding (shifted/short/long windows, contiguous chain, gap, overlap,
  hand-built settle), adjustment contract, grants/immutability/live-mode.
- Updated and green: PR C (70) and PR D (33) integration suites now seed a verified period.
- Upgrade: `python3 scripts/verify-commercial-reconciliation-migration.py` removes everything E1 added or replaced
  (restoring the PR C writer and PR D functions from their own migration text) inside one transaction, seeds legacy
  data, applies the real SQL, proves no existing row changed (content, xmin, position), ACLs, ingest, gate, portal,
  binding, adjustments and immutability, then rolls back. The older per-migration verifiers
  (`verify-commercial-billing-migration.py`, `verify-commercial-settlement-migration.py`) assert "my migration is the
  latest" and are historical now, as the PR C one already was after PR D.

## Limitations (deliberate, fail closed)

1. Nothing reaches production: no live Stripe, no Dashboard endpoint or portal configuration, no deploy. The
   endpoint is disabled until the sandbox secret and flag are set (a founder step).
2. The gate covers the **agent runtime** entry points (scheduled, run-now, event recipes). Voice/SMS channel
   handlers and `setVoiceLive` are not gated here (they have their own launch gates; wiring them is a follow-on).
   A governed definition's executor is still disabled, so the post-claim re-check is not needed yet.
3. There is no heartbeat/poll: if Stripe stops delivering events the last known state stands until the period ends,
   then the gate blocks (`subscription_period_elapsed`). Reconciling against Stripe by polling is PR F.
4. Tax, grace length, automatic dunning timing, refund eligibility and credit policy are **founder-policy-required**
   and are not implemented (fail closed): no tax, no grace, no automatic refund/credit/cancel/retry.
5. The partial-day seat question above, meter provisioning/event names, and the Stripe API-version check for
   `/v1/billing/meter_events` remain open (see `COMMERCIAL_SETTLEMENT.md`).
6. Resubscription after cancellation (a new Checkout) is not started here; a canceled account stays blocked.
7. A different subscription id after cancellation is accepted by the evidence writer only if it resolves through a
   Checkout this system created.

## Follow-on

PR F: Stripe test-clock acceptance, polling reconciliation, meter provisioning review, the human review surface and
application path for approved adjustments, resubscription, and any production activation decision.
