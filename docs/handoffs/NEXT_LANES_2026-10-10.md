# Next implementation lanes after PRs #64–#67

Start a new branch from updated origin/main after the integration merges. Keep
existing worktrees and uncommitted work intact. Read AGENTS.md and the governing
MVP documents before implementation. These briefs are for the founder to pass to
Cursor and Claude; creating this file does not send a message or start either agent.

## Cursor: usable intake and qualification review

First deliver one bounded PR making the existing qualification backend usable from
intake review. Reuse the shared layout, fields, errors, status pills and review
cards. Reuse `src/lib/data/lead-qualification.ts`,
`src/app/actions/lead-qualification.ts` and the contract in
`docs/architecture/LEAD_QUALIFICATION.md`; do not add a parallel schema or CRM.

Show the reviewed customer/vehicle links, service, reported vehicle condition,
timing, location, constraints and open questions. Keep unknown, reported and
confirmed distinct. Expose current revision, needs-review reasons and field
provenance. Owner and explicitly granted manager can save; CRM-read-only manager
can inspect; staff/revoked users remain denied by existing server checks. Show
stale/conflicting saves without silently overwriting or losing the user's draft.
Reuse stable command IDs for exact retry and existing authority enforcement.
Revalidate the new route after an accepted save. No automatic message, quote,
booking or consent change follows from completion. Do not call it ready to quote.

Verify owner/delegated/read-only/staff/revoked states in an isolated browser,
conflicting edits and retry behavior, empty/error states, mobile, real keyboard
navigation, contrast and 200% zoom. Unit tests, lint, build/types and required CI.
Keep files for the Codex thread-load error fix and Claude proposal lane untouched.

After this PR: a separate login/onboarding visual pass preserving authentication
and redirect behavior; Calendar comes after those two slices. Do not change prices.

## Claude Code: propose the next qualification question

Deliver one backend PR for a session-authorized, read-only next-question proposal
from the persisted qualification record. Reuse its existing loader and authority.
A proposal is returned for human review; this slice does not enqueue or send it.
No migration or model/provider call should be necessary for a deterministic first
slice. Inspect existing helpers first and extend rather than duplicate them.

Select one missing service, vehicle-condition, timing, location or constraints
question (stable documented order). Respect existing open questions. Preserve
unknown vs known-empty values. Return the source qualification/evidence revision
and the field/question being addressed. If identity or evidence needs review,
return that review requirement instead of a customer-facing question. If complete,
return no question without claiming quote/booking readiness. Do not infer prices,
service availability, customer consent, identity or answers from absence.

Existing qualification read permission is not message sending permission. Document
that any later staging step must independently recheck current revision, channel,
recipient, consent and existing policy/approval rules. Do not introduce a second
executor, automatic nurture, cron, booking or schema. Keep UI files untouched.

Tests: permission and tenant isolation using existing loader contracts; each unknown
field; known-empty constraints; open/answered/dropped questions; stale evidence;
identity-review hold; deterministic repeat reads; complete record; no RPC write or
external call. Deliver the response contract and exact verification evidence.

## Codex: integration and release preparation

Merge reviewed PRs with required checks, preserve unresolved-delivery semantics,
and distinguish thread read failures from SQL permission refusals. Deployment is
requested, but the saved Vercel CLI token is invalid and the existing Supabase
project is inactive at the October 10 inspection. After access is restored,
inspect the production migration ledger, guards, environment and recovery plan
before applying the 93-migration baseline or deploying code that depends on it.
Do not equate a deployment with provider activation or completed pilot acceptance.
