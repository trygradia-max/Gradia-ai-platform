# Claude handoff — Stripe sandbox browser setup

_Use only after the current onboarding-baseline PR correction is pushed. Run this
as a separate Claude Code session. This handoff authorizes Stripe sandbox/test-mode
configuration only. It does not authorize live charges, production secrets,
deployment, shared-database changes or enabling Gradia checkout._

## Copy-paste prompt

```text
You are configuring the Stripe sandbox for Gradia's approved hybrid commercial
model. Work carefully and keep browser state, source configuration and evidence
aligned. Do not make application-code changes in this task unless you first stop
and report the exact missing contract.

Repository context:
/Users/harryhatch/Gradia/platform is a stale founder checkout and must not be edited,
pulled, cleaned or reset. Read current source from a fresh worktree based on
origin/main. Follow AGENTS.md and read the governing documents in their required
order. Then read:

- docs/product/FOUNDER_APPROVED_COMMERCIAL_CATALOG.md
- docs/architecture/HYBRID_COMMERCIAL_MODEL.md
- docs/roadmap/PRODUCTION_LAUNCH_READINESS_2026-11-04.md
- src/lib/approved-commercial-catalog.ts
- src/lib/stripe-commercial-manifest.ts
- docs/stripe-go-live.md

The three pricing components are:

1. recurring workspace tier;
2. recurring per-operator quantity above included seats;
3. pay-as-you-go agent outcomes, voice and SMS.

They are not three payment rails. The approved current terms are $199/month,
3 included billable operator seats, 2 active agents, 100 standard digital outcomes,
100 inbound voice-agent minutes, $39/month per additional operator seat with daily
proration, and the explicit overage rules/caps in the approved catalog. Do not use
the example prices shown in the founder's social-media screenshots.

NON-NEGOTIABLE SAFETY RULES

- Use Stripe Sandbox/Test mode only. Before every mutation, visibly confirm the
  Dashboard says sandbox/test mode and that created objects have livemode=false.
- Never switch to live mode. Never create live products, prices, meters, customers,
  subscriptions, payment links or webhook endpoints.
- Never reveal, copy into chat, print, commit or log any secret/restricted key or
  webhook signing secret. If authentication, MFA or secret entry is required, pause
  and ask the founder to take over the browser for that field.
- Never change Vercel, Supabase, DNS, production webhooks, Connect live settings,
  tax registrations, bank/payout details or production customer data.
- Never enable Gradia checkout or change the manifest's activation=disabled gate.
- Do not create Growth or Scale products. They remain blocked by margin evidence.
- Do not invent Stripe lookup keys, meter event names, tax policy, dunning policy,
  trials, coupons or discounts.
- Do not use Stripe's hosted pricing-table feature as the billing architecture; it
  cannot represent Gradia's complete usage-based model.
- Treat existing objects as potentially intentional. Inventory first; never delete,
  archive or replace an object merely because its name looks old.

PHASE 1 — READ-ONLY INVENTORY

1. Open the Stripe Dashboard and enter the sandbox/test environment.
2. Record the account ID with all but the final four characters redacted, Dashboard
   API version, sandbox name and visible mode indicator. Do not record secrets.
3. Inventory existing sandbox Products, Prices, Billing Meters, Customer Portal
   configuration, Tax sandbox settings, webhook/event destinations and test
   subscriptions that could match Gradia.
4. Search by the exact lookup keys in STRIPE_COMMERCIAL_PROVISIONING_MANIFEST.
5. Compare every matching object with the manifest. Stop on any incompatible object
   reusing an approved lookup key. Do not mutate around a collision.

PHASE 2 — SAFE SANDBOX CATALOG

Only when no collision exists, create or reuse the sandbox objects explicitly
defined by STRIPE_COMMERCIAL_PROVISIONING_MANIFEST:

- one Gradia Founder Pilot sandbox Product carrying catalog_version and plan_key
  metadata from the manifest;
- the $199 USD monthly workspace subscription Price using the exact lookup key;
- the $39 USD monthly additional-operator Price using the exact lookup key and
  licensed quantity semantics.

Do not create a 14-day Stripe trial: the approved build/test period starts and
billing/card collection begin at first agent activation, which is an application
state transition, not an automatic signup trial.

The current manifest does not yet define Stripe Billing Meter lookup keys or event
names for outcomes, voice and SMS. Do not invent or create meters in the browser.
Instead, produce a proposed mapping that preserves Gradia's append-only usage ledger,
highest-value-only outcome rule, dynamic margin floors and monthly cap. Mark this as
a required reviewed code contract before meter creation.

PHASE 3 — CUSTOMER PORTAL SANDBOX

Configure or verify a sandbox Customer Portal that allows:

- payment-method updates;
- invoice-history viewing;
- billing name/address and tax-ID updates if already supported by the account;
- cancellation at period end with cancellation reasons.

Do not enable unreviewed plan switching, quantity editing, coupons or immediate
cancellation. Do not publish a shareable portal login URL. If privacy-policy, terms
or return URLs are missing, report the missing exact URLs instead of inventing them.

PHASE 4 — TEST EVIDENCE, NO LIVE ACTIVATION

1. Create one clearly named synthetic sandbox customer only if necessary.
2. Do not create a real subscription until the Gradia checkout/subscription-item
   contract exists. If an isolated Dashboard-only subscription is useful for
   verifying the catalog, name it clearly as disposable test evidence and do not
   connect it to a real shop.
3. If possible, use a Stripe test clock/simulation to verify renewal, seat quantity
   proration and cancellation-at-period-end behavior. Use no real customer data.
4. Do not configure a webhook destination without an approved stable non-production
   endpoint and matching application event contract. Record the recommended events,
   but do not point Stripe at production.

DELIVERABLE

Return a concise evidence report containing:

- sandbox/test mode proof and redacted account/sandbox identifier;
- reused and newly created Product/Price IDs (IDs are identifiers, not secrets),
  exact lookup keys, amounts, currency, interval, usage type and metadata;
- portal settings verified or changed;
- any collisions or missing URLs/contracts;
- the exact proposed meter/event mapping, explicitly marked not created;
- screenshots or Dashboard paths for verification;
- a statement that no live-mode, production, secret, deployment or Gradia activation
  change occurred.

Stop immediately if the Dashboard is in live mode, the manifest differs from the
approved catalog, a lookup-key collision exists, or browser automation cannot
reliably confirm the target environment.
```

## Why browser setup is deliberately limited

Stripe objects are settlement infrastructure, not Gradia's pricing authority. The
reviewed source catalog and append-only Gradia usage ledger remain authoritative.
The current manifest defines the workspace and seat prices but not safe Stripe meter
identities for dynamic-margin voice/SMS or highest-value-only outcomes. Creating
those objects manually before the app contract exists would make the Dashboard a
second pricing system and make reconciliation unreliable.

The next engineering PR should define the usage settlement/meter contract,
idempotent provisioning command, webhook-owned subscription state, caps and invoice
reconciliation. After review, Claude may return to the browser to create the exact
test meters and run end-to-end sandbox acceptance.
