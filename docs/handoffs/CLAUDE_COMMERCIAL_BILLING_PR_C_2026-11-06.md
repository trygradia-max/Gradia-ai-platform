# Claude handoff — commercial billing PR C

## Copy-paste prompt

```text
Implement Commercial Billing PR C only in this worktree:

/Users/harryhatch/Gradia/worktrees/claude-stripe-checkout

Branch: claude/stripe-subscription-checkout
Base: origin/main at or after merge commit 344d671 (PR #132)

Read AGENTS.md completely and follow its required governing-document order. Then
read the approved commercial catalog, hybrid commercial model, production launch
plan, Stripe sandbox handoff/results, PR A usage-recognition architecture, PR B
membership-billing architecture, the current Stripe adapter/webhook/checkout code,
all shop plan/subscription migrations, every agent activation path, and the current
Next.js guides under node_modules/next/dist/docs before changing Next code.

GOAL

Build tenant-safe Stripe PLATFORM customer/subscription state and a fail-closed
Checkout handoff at the first Gradia-agent activation boundary. This is sandbox/test
mode only. Do not implement usage meters/settlement, webhook reconciliation,
dunning, refunds, Customer Portal, live mode, deployment, or shared-data changes.

APPROVED COMMERCIAL CONTRACT

- Only Founder Pilot is sellable: $199 USD per workspace/month.
- It includes 3 billable operator seats, 2 active agents, 100 standard outcomes and
  100 inbound voice-agent minutes. Extra seats and PAYG are ledger/preview facts;
  do not add them as guessed Checkout quantities in this PR.
- Card collection and billing begin at first agent activation, not draft creation.
- There is no Stripe 14-day trial. The 14 days describe pre-activation build/test
  access; activation is the billing boundary.
- Use the approved Stripe lookup key
  `gradia_founder_pilot_2026_11_monthly`. Never commit Stripe object IDs or secret
  keys. Do not provision Growth or Scale.
- Existing legacy $20, voice-add-on, credit-pack and minute-pack checkout paths are
  not the approved commercial authority. Do not route the new activation boundary
  through them and do not silently reinterpret old `shops.plan` values as proof of
  an approved Founder Pilot subscription.

SAFETY BOUNDARY

- Stripe PLATFORM billing is separate from shops' Stripe Connect accounts.
- Refuse any live secret/key or live object. The new flow must be explicitly gated
  to Stripe sandbox/test mode and disabled by default when configuration is absent,
  ambiguous or mismatched.
- Do not lift the production activation freeze. Do not deploy or mutate a shared
  Supabase project. Use fakes and the disposable local stack.
- A browser success redirect is never payment proof. Checkout creation is not an
  active subscription. Only reviewed, persisted subscription evidence may satisfy
  the activation gate; PR E will add signed webhook reconciliation.
- Never log secrets, Checkout URLs, payment details or full Stripe payloads.

REQUIRED SCOPE

1. Audit and name the one canonical first-agent-activation command used by the
   current Agent OS. Do not add a second agent schema or a parallel activation
   system. If no single canonical command exists, add the smallest application
   service seam that current activation paths can call, and document the remaining
   wiring rather than pretending it is complete.
2. Add tenant-bound commercial billing state separate from Stripe Connect:
   - platform customer identity;
   - approved catalog/plan version;
   - checkout request/attempt state with stable idempotency identity;
   - platform subscription identity and finite status;
   - evidence/source timestamps and last reconciled event reference where relevant.
   Preserve immutable event/attempt evidence. Mutable current pointers may advance
   atomically but must not erase history.
3. Define finite fail-closed states. At minimum distinguish unconfigured,
   checkout_required, checkout_pending, active, past_due, canceled, incomplete,
   unknown and reconciliation_required. Unknown/unverified is never active.
4. Server-derived authority only: a live workspace owner may request Checkout for
   that workspace. Managers, staff, revoked, anonymous and cross-tenant callers are
   denied. Browser roles cannot write commercial billing evidence directly.
5. Implement idempotent PLATFORM customer and Checkout-session creation using the
   approved lookup key. Replays return/reuse the existing safe result where Stripe
   permits; changed requests conflict. Concurrent requests must not create multiple
   local authorities or silently create duplicate subscriptions. Treat timeout or
   ambiguous provider outcomes as unknown/reconciliation_required, never as failed
   with permission to retry blindly.
6. Bind Checkout metadata/client reference to the authenticated shop, approved
   catalog version and local checkout attempt ID. Use an allowlisted same-origin
   success/cancel return target; never accept arbitrary redirect URLs from the
   browser.
7. At first agent activation:
   - if there is reviewed active Founder Pilot subscription evidence, allow the
     existing activation command to proceed;
   - if billing is required but absent, do not activate; return a typed
     checkout_required result carrying the server-created Checkout destination;
   - if Checkout/subscription state is pending, unknown, past_due, canceled or
     mismatched, do not activate and return the exact typed reason;
   - repeated activation requests must be deterministic and must not create a new
     Checkout Session each click.
8. Preserve the maximum two-active-agent entitlement and prove that billing does
   not bypass existing policy, review, connector, memory or approval gates.
9. Provide a minimal DTO for Cursor: billing state, activation eligibility, exact
   blocking reason and optional safe Checkout URL. Do not redesign the full billing
   or agent-builder UI in this PR.
10. Keep the legacy Stripe webhook behavior unchanged unless a narrowly necessary
    compatibility fix is required. Signed commercial subscription reconciliation is
    PR E, so local test helpers may seed reviewed evidence but production code may
    not trust redirects or unsigned client assertions.

STRIPE ADAPTER REQUIREMENTS

- Extend the existing adapter rather than adding a second HTTP client.
- Use Stripe idempotency keys and explicit API-version behavior where the current
  adapter supports it. Never infer product/price from display names or amounts.
- Resolve the approved Price by lookup key and verify currency=usd, recurring
  interval=month, active=true and unit_amount=19900 before creating Checkout.
- Bind/reuse one platform Customer per shop. Do not use the shop's connected-account
  ID as the platform customer.
- Make provider calls mockable and network-free in unit/integration tests.

REQUIRED TESTS

- owner allowed; manager/staff/revoked/anonymous/cross-shop denied;
- browser table writes denied and service writers narrowly scoped;
- no configuration, live key, lookup mismatch, wrong amount/currency/interval,
  inactive price and Connect context all fail closed;
- draft creation does not request billing; first activation does;
- active reviewed subscription permits activation while checkout_required,
  pending, incomplete, past_due, canceled, unknown and mismatched catalog block it;
- exact replay and concurrent Checkout requests do not duplicate local authority;
- changed replay conflicts; provider timeout/ambiguous response becomes
  reconciliation_required and cannot trigger blind duplication;
- success/cancel URLs are server-owned and metadata is tenant/catalog/attempt bound;
- a Checkout redirect/client assertion cannot mark a subscription active;
- the two-active-agent limit and existing activation policy gates still hold;
- PR A usage recognition and PR B seat proration tests remain green;
- migration applies from zero and upgrades from current main without rewriting
  shops, memberships, commercial usage or membership billing evidence.

VALIDATION AND HANDBACK

Run focused tests, full unit/lint/typecheck/build, disposable integration tests and
a purpose-built upgrade verifier. Use only Stripe fakes/local HTTP fixtures; do not
make a real Stripe mutation in automated tests. Append docs/AI_WORK_LOG.md, commit,
push and open one PR against current main. Stop for review. Report exact base/head,
migration names, authority changes, Stripe calls introduced, commands/totals,
upgrade evidence, limitations and the DTO Cursor may consume. Do not merge.
```

## Follow-on sequence

PR D maps reviewed Stripe meters/events and settles the PR A ledger. PR E adds
signed webhook reconciliation, dunning/cancellation/refund states and Customer
Portal links. PR F runs test-clock, duplicate/out-of-order webhook, cap and full
sandbox acceptance before any production activation decision.
