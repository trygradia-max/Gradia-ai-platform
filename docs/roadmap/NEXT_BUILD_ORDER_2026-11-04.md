# Gradia next build order: baseline, Agent OS and Call Copilot

_Founder-approved build order: 2026-11-04. `AGENTIC_OS_MASTER_BUILD.md` remains the
overall gate map; this file defines the next reviewable PR sequence._

## Outcome

Reach a controlled pilot where Gradia knows the shop's starting operational state,
runs one bounded employee definition safely, and can assist a human-handled inbound
call without requiring a digital receptionist.

## Merge order

### PR A — onboarding baseline contract and persistence

- Versioned assessment/question catalog and tenant-bound revisions.
- Owner submission, delegated manager draft and staff denial.
- Evidence classes, units, periods and deterministic derived metrics.
- Starting-point/day-30 server DTOs; no UI and no model dependency.
- Disposable integration proof for revision immutability, unknown-versus-zero,
  revocation and cross-shop denial.

This can proceed independently of Agent execution because it grants no tools or
autonomy.

### PR B — immutable Gradia employee definitions

- Persist immutable definition revisions and one atomic active pointer.
- Compile server-loaded policy, reviewed knowledge, tools, budgets and evaluation.
- Fail activation on stale/missing evidence or authority.
- Prove concurrent activation, revocation, tenant isolation and old-revision
  immutability.

### PR C — complete the selected-playbook lifecycle

- Extend the merged scheduled-run claim into steps, stable commands and attempts.
- Heartbeats, pause/cancel/kill, wait/reconciliation links and restart recovery.
- Recheck policy, consent, readiness, approval, budget and grants before effects.
- No second executor and no automatic retry of unknown provider outcomes.

### PR D — Call Copilot ingress and consent evidence

- Human-first inbound bridge using existing telephony/provider seams.
- All-party disclosure/consent state machine and pause/stop capture.
- Extend existing call records/interactions; idempotent callback ordering.
- No model extraction or CRM mutation in this PR.

Depends on the lifecycle/unknown-outcome behavior required by this call path.

### PR E — Call Copilot extraction and CRM proposals

- Structured, source-cited extraction from completed/partial transcripts.
- Existing customer/vehicle resolution and ambiguity handling.
- Pending CRM/quote/booking/task/message proposals, approval-first.
- Reviewed-memory candidates remain separate and inert until publication.
- Prompt-injection classification and PII/payment-data minimization.

### PR F — Cursor onboarding and Call Copilot experience

- Insert **Starting point** after shop profile; resumable, accessible and mobile.
- Factual baseline report with evidence/period labels and no invented ROI.
- Call capture state plus post-call evidence/proposal review.
- Consume server DTOs only; no client-chosen shop, policy or consent authority.
- Signed-in owner/manager/staff, error, keyboard, reduced-motion, 200%-zoom and
  real-phone acceptance.

### PR G — builder completion and pilot integration

- `/agents`: Job → Knowledge → Tools → Limits → Schedule → Test → Activate.
- Attach the chosen pilot playbook and optional Call Copilot capability to an exact
  active definition revision.
- Expose `quote.create` as a distinct approval-required tool using the existing
  quote engine; keep create, send, discount and booking as separate grants.
- End-to-end synthetic, mocked-provider and explicitly authorized test-account walk.
- Final-tree migration, unit, integration, type, lint, build and hosted acceptance.

### PR H — commercial settlement and controlled pilot candidate

- Usage/outcome attribution, non-stacking, seat proration and cap enforcement.
- Stripe provisioning/reconciliation only after tax/dunning decisions.
- Exact pilot-account grants, support owner, kill switch and release packet.
- Separate founder go/no-go per account; no global provider/write unfreeze.

## Parallel founder lane

While engineering builds A–G, the founder completes pilot businesses, success
measures, counsel-approved call disclosure/recording handling, privacy/retention,
Twilio/A2P/provider setup, support/escalation ownership, tax/dunning decisions and
per-account production authorization.

## Definition of “truly agentic” for this build

Gradia is agentic when it can observe an allowed trigger, resume durable work,
retrieve only reviewed context, propose or execute only explicit tools, wait and
escalate truthfully, preserve evidence, reconcile unknown outcomes and stop when
authority is revoked. More feature names or model calls do not satisfy this bar.

The current pilot does not require a full repair-order domain. Gradia may use the
existing lightweight appointment/job lifecycle, but technician/labor/parts/inspection/
invoice repair orders remain a separately approved future product.

