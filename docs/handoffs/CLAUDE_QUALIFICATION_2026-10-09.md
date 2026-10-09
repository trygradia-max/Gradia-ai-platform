# Claude Code: durable qualification, first backend slice

Work in `/Users/harryhatch/Gradia/worktrees/claude-qualification`, branch
`codex/claude-qualification`, created from main 987d50c including #56/#58/#57.
The original Claude checkout is preserved. Read AGENTS.md, the five governing
MVP documents, HANDOFF_CURRENT and LEAD_INTAKE_REVIEW before implementation.

Build the smallest persistent qualification backend needed to carry a reviewed
lead toward a quote or booking. Reuse existing intake, customer/vehicle identity,
record commands, memberships, audit and policy infrastructure. First inspect for
an existing durable qualification structure so this does not create a parallel CRM.

Scope: structured requested service, reviewed vehicle reference and separately
reported vehicle condition, desired timing, service location/area, constraints,
unresolved questions and explicit review state. Unknown is a supported value;
absence must never become inferred completion. Store scoped provenance, revision,
actor and timestamps. Unresolved intake remains in identity review and must not
create a customer, vehicle, quote, booking, consent or outbound message.

Provide bounded session-scoped read/update operations for an owner and explicitly
delegated manager. Reuse a capability only if its documented semantics already
cover qualification; otherwise add a narrowly named owner-granted capability,
default off. Staff do not gain shop-wide access. Authorization and update/audit
must be atomic; reject stale revisions, foreign references and revoked membership.
Use stable command IDs for replay and refuse changed payloads with the same ID.
Follow existing lock ordering and tenant constraints. No LLM inference or provider
calls in this first slice, no new automatic nurture or scheduling engine.

Define one documented UI contract with example synthetic payloads, validation
errors, revision conflicts and permission outcomes. Do not build the UI; Cursor
is standardizing it separately. Do not modify globals.css, shared UI components,
whisper-summary.ts or Codex's running preview. Reserve migration timestamps after
20261009090000 and inventory newly merged migrations before naming yours.

Tests: no data bleed between two shops; owner/manager/staff/revoked roles; invalid
vehicle/customer ownership; malformed fields; unknown versus reviewed completeness;
concurrent edits, replay and changed-command refusal; injected audit failure rolls
back writes; no CRM identity creation, consent change or external effect. Run
Node 22 unit/integration, lint, offline build and post-build types, and migrations
from zero only on your own unlinked disposable stack. Do not reset the public-form
stack at 57331: it currently powers the founder's local preview.

Deliver one PR to main, a schema/RPC contract, exact verification evidence and an
AI_WORK_LOG entry. Keep production and Git deployment settings unchanged. This is
qualification persistence, not a claim that the complete nurture-to-book loop works.
