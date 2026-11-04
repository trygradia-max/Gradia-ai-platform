# Gradia production launch readiness

_Founder direction recorded 2026-11-04. Gradia is being completed as a fully
sellable production product, not a pilot-only demonstration. This direction does
not waive tenant isolation, consent, billing, provider, migration, deployment or
rollback gates._

## Launch outcome

A detailing business can discover Gradia, choose an offer, create and pay for its
workspace, complete onboarding, configure and activate a Gradia employee, connect
approved channels, operate the core lead-to-payment workflow, understand every
human-review or failure state, and receive support without founder intervention.

The launch loop is:

`offer -> checkout -> workspace -> starting point -> connect -> configure -> test -> activate -> operate -> measure -> bill -> support`

“Merged,” “deployed,” “provider-enabled” and “production-accepted” remain separate
states. A feature is launch-ready only after all four applicable states are true.

## Current evidence on remote `main`

### Product and UI

- Cursor and integration UI work is merged: the app shell and two-pane inbox
  (#59), shared visual system and Home/Conversations/Customers (#63), accessibility
  follow-up (#65), review/activity surfaces (#66), Team/Settings chrome (#67),
  onboarding/intake polish (#69/#72), and later empty-state/copy work (#101-#106).
- The authorized Operations Brief is merged (#121).
- The complete seven-step Gradia Agent builder and exception desk are not yet
  wired to immutable server-derived definitions. `/agents` still contains legacy
  builder paths.
- Signed-in hosted browser acceptance of the exact current `main` remains required.
- Automatic Git deployments are disabled in `vercel.json`; merge does not prove
  that the newest UI is visible on the hosted product.

### Agentic OS

- The layered definition/compiler contract (#118), scheduled-run lifecycle slice
  (#122), reviewed versioned memory (#123), Control Center policy and guarded
  domain workflows are merged.
- Immutable persisted employee-definition revisions, one atomic active revision,
  restart-safe step/command/attempt execution across every consequential effect,
  normalized model/provider boundaries and the complete Agent builder remain.
- The shared quote engine and Quote Builder exist. General Agent OS access still
  needs the distinct approval-gated `quote.create` capability.
- The current appointment-as-job lifecycle is not a full repair-order system.

### Commercial and payments

- Founder-approved pricing and margin evidence are merged (#120/#124): $199 base,
  three operator seats, two active agents, included usage, $39 extra seats and
  explicit outcome/voice/SMS overage rules.
- Gradia subscription checkout intentionally fails closed. The Stripe commercial
  manifest has `activation: "disabled"` and contains no live Stripe IDs.
- Usage settlement, overage-cap enforcement and warnings, daily seat proration,
  activation-triggered billing, dunning, tax policy, Stripe product provisioning,
  webhook reconciliation and production billing acceptance remain incomplete.
- Stripe Connect shop-to-customer invoicing exists as a separate workflow. It is
  not a substitute for Gradia collecting its own SaaS subscription and usage fees.
- The approved catalog still uses the customer-facing name “Founder Pilot.” Before
  public launch, replace it with the final launch offer name without silently
  changing price, inclusions or margin gates.

### Security and operations

- Tenant/RLS, role, consent, webhook-signature, replay/idempotency, provider-proof,
  approval and policy tests exist, and consequential paths generally fail closed.
- Production write guards, channel/provider activation and public promotion remain
  gated. Current documentation says 35 application-table write guards are active.
- Prompt-injection classification and PII minimization are not complete at every
  model/provider boundary. The full malicious-memory/deletion matrix remains.
- The exact current release commit still needs migration-ledger/upgrade verification,
  tenant-isolation probes, dependency and secret/config review, signed-in browser
  acceptance, observability/alerting verification, backup/restore evidence,
  incident ownership and rollback rehearsal.

## Production build order

### 1. Establish the exact release baseline

1. Preserve founder files in the stale local checkout; do not overwrite them.
2. Use a clean worktree from `origin/main` for every new PR.
3. Run unit, integration, type, lint, build, migration-from-zero and upgrade probes.
4. Inventory open PRs; close superseded experiments and reconcile only evidence-backed
   work. Open Cursor PRs #86/#90/#91/#92 and experimental Super Agent PR #85 are not
   considered merged product.
5. Deploy a private candidate from the exact reviewed commit and record the URL and
   environment fingerprint.

### 2. Complete the product spine

1. Persist immutable agent-definition revisions and atomic activation.
2. Extend durable runs into restart-safe steps, commands and provider attempts.
3. Complete reviewed memory provider-boundary safety and normalized model traces.
4. Wire the seven-step builder and operations/exception desk to server DTOs.
5. Add approval-gated `quote.create`; preserve separate send, discount and booking
   permissions.
6. Complete the onboarding starting-point assessment and Call Copilot workflows.
7. Decide and separately scope full repair orders; do not disguise appointments as
   technician/parts/labor/invoice work orders.

### 3. Complete Gradia billing

1. Finalize the public offer name and tax/dunning decisions.
2. Provision versioned Stripe products/prices from the reviewed manifest using a
   controlled, idempotent command; store Stripe IDs outside source configuration.
3. Implement subscription checkout and webhook-owned subscription state.
4. Settle billable operator seats with daily proration and auditable membership
   snapshots.
5. Settle append-only usage into one highest-value outcome plus provider-billed
   voice/SMS units; never bill drafts, failures, unknown outcomes or duplicate work.
6. Enforce the owner-configured monthly cap before new billable work, with warnings,
   deterministic holds and no surprise overage.
7. Implement invoices, payment failure/dunning, cancellation, credits/refunds and
   reconciliation. Prove replay, out-of-order event and duplicate-event behavior.
8. Pass Stripe test-mode end-to-end acceptance before any live-mode activation.

### 4. Security and reliability release gate

1. Threat-model auth, tenant isolation, agent/tool authority, webhooks, uploads,
   memory/RAG injection, SSRF, stored XSS, provider callbacks and billing fraud.
2. Complete provider-boundary classification and PII minimization/redaction.
3. Run dependency/SAST/secret scanning and manually review service-role call sites.
4. Reprove RLS and cross-shop denial for every new table, RPC, cache and background job.
5. Verify rate limits, payload limits, replay claims, idempotency, timeouts, circuit
   behavior and unknown-outcome reconciliation.
6. Verify production secrets, least-privilege provider credentials, rotation and
   environment separation. No credentials in prompts, logs or source.
7. Establish privacy/retention/deletion behavior, call-consent handling and the
   approved safety-evidence retention schedule.
8. Prove monitoring, alerting, support escalation, backup/restore, incident response
   and rollback on the exact candidate.

### 5. Usability and visual acceptance

1. Run every owner workflow with production-like data: signup, checkout, onboarding,
   connect, configure, test, activate, inbox, approval, quote, booking, payment,
   reporting, pause/cancel and support.
2. Eliminate dead ends, legacy duplicate paths, fake counts and states where load
   failure appears empty.
3. Validate mobile, keyboard, accessible names, focus, contrast, reduced motion and
   200% zoom.
4. Validate first-run, empty, partial, error, blocked, waiting, unconfirmed and
   recovery states with real server contracts.
5. Record screenshots and signed-in browser evidence from the exact release commit.

### 6. Controlled production launch

1. Enable deploys for a reviewed candidate, not every branch.
2. Apply migrations with backup, forward/rollback plan and ledger evidence.
3. Activate Stripe and providers independently with kill switches and spend caps.
4. Start with named production accounts as a release cohort, observe outcomes and
   expand traffic only when security, billing and operational evidence remain clean.
5. Publish support, privacy, terms, pricing and service expectations before broad
   self-serve promotion.

## Definition of launched

Gradia is launched only when a new customer can complete the entire launch outcome
without a database edit or founder engineering intervention; billing reconciles to
the append-only ledger; cross-shop access and unauthorized agent actions fail closed;
unknown provider outcomes remain visibly unresolved; core workflows pass signed-in
desktop/mobile acceptance; monitoring and support can detect and recover failures;
and the exact production commit has a written go/no-go record.
