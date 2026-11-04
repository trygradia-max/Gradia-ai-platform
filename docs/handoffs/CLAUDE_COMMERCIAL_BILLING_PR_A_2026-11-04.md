# Claude handoff — commercial billing PR A

_This assignment starts after Stripe sandbox catalog evidence was merged in PR
#130. It is the first application-side commercial billing slice. It does not enable
checkout, call Stripe, activate meters, deploy, or change production/shared data._

## Copy-paste prompt

```text
Implement Commercial Billing PR A only in this worktree:

/Users/harryhatch/Gradia/worktrees/claude-commercial-billing

Branch: claude/commercial-billing-ledger

Read AGENTS.md completely. Follow its MVP reading order exactly. Then read:

- docs/product/FOUNDER_APPROVED_COMMERCIAL_CATALOG.md
- docs/architecture/HYBRID_COMMERCIAL_MODEL.md
- docs/roadmap/PRODUCTION_LAUNCH_READINESS_2026-11-04.md
- docs/handoffs/CLAUDE_STRIPE_SANDBOX_BROWSER_SETUP_2026-11-04.md
- src/lib/approved-commercial-catalog.ts
- src/lib/commercial-pricing.ts
- src/lib/commercial-margin.ts
- src/lib/stripe-commercial-manifest.ts
- src/lib/billing-seats.ts
- src/lib/credits.ts
- src/lib/reconciliation.ts
- every migration that creates or changes usage_events, pricing_config, credit_grants,
  shop membership authority or ledger RLS
- the existing ledger, tenant, replay, billing-claim and commercial-catalog tests

Before changing any Next.js file, read the relevant current guide in
node_modules/next/dist/docs/ as required by AGENTS.md. Prefer keeping this PR below
the Next/UI layer.

GOAL

Build the tenant-safe, append-only commercial usage-recognition and deterministic
period-preview foundation that Gradia will later settle through Stripe. Gradia's
database remains pricing and billing authority; Stripe is a collection/reconciliation
adapter. Do not bill directly from model narration or from Stripe Dashboard state.

APPROVED COMMERCIAL RULES

- Catalog version 2026-11-03.v1 and Founder Pilot/Core terms already in source.
- Billable metrics are exactly:
  standard_digital_outcome, qualified_lead, confirmed_appointment,
  inbound_voice_agent_minute and sms_segment.
- For one workflow, charge at most the single highest-value confirmed digital
  outcome. Standard outcome < qualified lead < confirmed appointment.
- Drafts, proposals, escalations, failures, unknown outcomes and work a human had to
  finish are not billable digital outcomes.
- Voice minutes and SMS segments remain provider-incurred usage even when a digital
  outcome is not confirmed.
- Included quantities, fixed rates, dynamic markup floors and the monthly cap come
  only from the approved catalog. Do not copy historical pricing_config retail rates
  into the commercial catalog and do not silently rewrite the provider-cost ledger.
- Unknown/missing wholesale evidence must not be silently treated as zero when a
  markup rate depends on it.

PR A SCOPE

1. Audit the existing append-only usage_events ledger and preserve it. Do not turn
   old operational/provider-cost rows into customer-billable outcomes by inference.
2. Add the smallest normalized commercial-recognition contract needed to represent:
   tenant, approved catalog version, exact metric, quantity, source evidence,
   workflow identity where outcome deduplication is required, wholesale evidence,
   recognition time, deterministic idempotency key and compensating correction.
3. Customer-billable recognition must be immutable/append-only. Corrections are
   explicit compensating records linked to the original; never UPDATE or DELETE a
   recognized fact. Shop deletion may follow the existing tenant-deletion contract.
4. Use an authority-checked server/RPC boundary. Browser roles cannot insert, update
   or delete billing evidence. Owners may receive an authorized read/preview DTO;
   staff, revoked, anonymous and cross-shop callers are refused. Do not accept a
   client-selected shop without deriving/rechecking membership server-side.
5. Make recognition atomic and idempotent under concurrent replay. Same idempotency
   identity plus identical immutable fact returns the original ID; changed metric,
   quantity, evidence, workflow, wholesale cost or catalog version conflicts.
6. Build a deterministic period preview over an explicit half-open UTC window. It
   must apply included quantities, highest-value-only outcome recognition, dynamic
   markup floors, and one combined usage cap across metrics. It returns line-item
   evidence and explicit unavailable/invalid/conflict states; it performs no Stripe
   call and creates no invoice.
7. Keep base subscription and seat pricing visible in the preview contract, but do
   not implement daily seat proration in this PR unless exact immutable membership
   interval evidence already exists. If it does not, report `seat_proration_unavailable`
   rather than using the current member count as historical truth.
8. Preserve the distinction between shop-to-customer Stripe Connect invoicing and
   Gradia platform SaaS billing. Connect events must never mutate this platform
   commercial state.
9. No checkout, Stripe meter/event creation, webhook expansion, Customer Portal
   changes, tax, dunning, coupons, trials, refunds, deployment, production secrets,
   feature-flag activation or shared-database mutation in PR A.

REQUIRED TESTS

- exact catalog metrics only; historical/unknown kinds fail closed;
- highest-value-only digital outcome per workflow, independent of event order;
- drafts/failures/unknown/human-completed outcomes are excluded;
- voice/SMS provider usage stays distinct from outcome recognition;
- included allowances and dynamic markup floors calculate exactly;
- missing markup wholesale evidence is unavailable, never zero;
- one combined cap refuses an over-cap preview without partial hidden charging;
- exact replay returns the original recognition ID;
- changed replay conflicts;
- concurrent identical recognition creates one fact and one ID;
- compensating correction is traceable and cannot over-correct;
- owner read succeeds; staff, anonymous, revoked and cross-shop reads/writes fail;
- browser roles cannot mutate the underlying ledger tables directly;
- Connect webhook envelopes cannot drive platform billing;
- half-open period boundaries do not double-count an event at rollover;
- failure/unavailable never renders as zero usage or a $0 invoice claim;
- migration initializes from zero and upgrades the current ledger without rewriting
  existing usage_events rows.

VALIDATION AND HANDOFF

Run focused unit and disposable integration tests, then the repository's complete
required unit/integration/type/lint/build and migration verification in proportion to
the change. Append the required Claude entry to docs/AI_WORK_LOG.md. Commit, push and
open one PR against current main. Report exact migration name, commit, commands,
results, schema/RPC contracts, limitations and follow-on PRs.

If the existing data model cannot prove a billable outcome or historical seat
interval, fail closed and document the missing evidence. Do not invent it, backfill
it from model text or broaden PR A.
```

## Follow-on sequence after PR A

1. PR B: immutable billable membership intervals and daily seat proration.
2. PR C: Stripe platform customer/subscription state and Checkout activation at the
   first agent activation boundary.
3. PR D: reviewed Stripe meter/event mapping, usage settlement and invoice preview.
4. PR E: signed webhook reconciliation, dunning/cancellation/refund states and
   Customer Portal links.
5. PR F: test-clock, duplicate/out-of-order webhook, cap and full sandbox acceptance.

No live-mode activation occurs in those PRs; live launch remains a separate reviewed
release decision.
