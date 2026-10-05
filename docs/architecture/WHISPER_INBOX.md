# Whisper inbox and operational handoff

## Scope — October 5, 2026

This is the first operational-inbox slice of milestone 4 in the five governing
September 11 MVP documents, not completion or activation of that milestone.
`/conversations` remains the single conversation destination. Existing owner
Ask Gradia chat remains separate from customer messages within that page.

The inbox reads existing `interactions` by shop, customer and SMS/email/voice
channel. It does not create another message store, Agent, settings screen or send
executor. Unidentified interactions are counted separately for owner review;
unknown customers are never combined into a shared thread. Ordering uses recording
time plus ID so late-arriving evidence appears as new. Message timestamps show the
original occurrence time. Lists and message history are paginated at 20 rows.

Owners and authorized managers can assign work to an active owner or CRM-read
manager, leave a reason, and mark work needs-reply, held or operator-completed.
Without an eligible assignee, the owner is the fallback. New stored messages reopen
completed work. Pending approvals remain visible; approved actions without a
confirmed result remain held even if an operator marks the thread complete.
Completion is not a delivery receipt. Handoff flags do not pause/cancel queued
actions or override delivery policy; those remain managed through Approvals. Initial needs-reply state requires operator
triage; it is not an AI inference that every historical message needs an answer.

Read acknowledgement is explicit and personal. Opening a page does not mutate
state or consent. Acknowledgement records the latest visible interaction watermark,
not an unbounded "all future messages read" flag. Handoff/reply commands create
idempotent in-app notifications for the current eligible assignee or owner.
Unread notifications are marked on individual list rows and counted for their
recipient. A later handoff creates a new notification after acknowledgement.

## Authority and execution

The existing owner/manager/staff model governs access:

| Actor | Read history / mark own read state | Handoff | Stage reply |
|---|---|---|---|
| Active owner | Owned shop | Yes | Yes |
| Active manager with CRM read | Granted shop | Only with assignments.manage | No |
| Active assigned staff | Assigned customers only | No | No |
| Revoked / foreign / anonymous / sessionless service caller | Denied | Denied | Denied |

The session-only RPC rechecks current membership, ownership and capabilities.
Command IDs bind shop, customer, channel, actor, operation, message watermark,
revision and payload. Exact retries return the existing command; conflicting reuse
or stale decisions fail closed. Shop/metadata locks serialize competing decisions.
State, pending action, audit and notification commit in one transaction.

Owner SMS/email drafts bind the current customer destination and enter existing
`pending_actions`; there is no direct transport call. Both stage as marketing;
this composer cannot assert a service-purpose exemption. Existing Control Center
staging restrictions and final executor policy, permission, recipient, consent,
DNC, suppression and idempotency checks remain authoritative. Queue success means
"draft in Approvals", not sent. Recipient or conversation changes require refresh.
An uncertain command response is never automatically retried with a new ID.

Email currently stages a new outbound message, not a provider-threaded reply.
Voice history is read/handoff-only. Existing intake evidence and reviewed vehicle
references are linked where CRM-read authority permits them. The existing owner
CRM and approval pages are linked only for owners.

## Migration and retention

`20261005120000_conversation_handoff.sql` is migration 83. Four RLS-enabled metadata
tables hold work state, individual read receipts, durable command audit and in-app
notifications. All direct table privileges are revoked from anonymous,
authenticated and service roles. Three fixed-search-path SECURITY DEFINER RPCs
allow authenticated sessions only; their internal authorization helper is private.
Four composite foreign keys bind customer and assignee relationships to the shop.
Customer deletion cascades operational metadata; immutable command audit retains
historical customer/actor IDs and original command binding. Shop deletion cascades
all four. Retention/pruning is not enabled by this slice.

The existing atomic customer merge retains its restrictive consent/provenance
behavior. Added metadata handling preserves notifications, resets read receipts,
clears assignment and holds merged work for review. Colliding work records also
require review; no operator-completed or read state is silently inherited. Audit
bindings remain historical. Existing and new rollback tests protect the merge.

The disposable-only `tests/sql/whisper-failure.sql` trigger injects a failure at
final audit insertion to prove handoff and reply staging roll back. It is not an
application migration. Shared or production migrations were not run.

## Remaining milestone gates

- Independent transactional-email provider choice/setup; real notification delivery
  stays disabled. No immediate email, digest, quiet-hour scheduler or retry worker
  is claimed. In-app notifications require a refresh; there is no realtime feed.
- Provider thread/message identity and true in-thread email reply integration.
- Verified service-reply proof issuance from trusted thread context. Until then,
  replies without required marketing consent remain blocked by the existing sender.
- Actionable uncertain-delivery reconciliation UI. Current UI exposes the hold and
  approval record, but an authorized operator must inspect provider evidence through
  the approved operational process. Never resend automatically after an uncertain
  outcome. Consumed proofs remain consumed; this slice does not weaken that rule.
- Search/filtering, bounded related-record paging and a browsable handoff-audit
  timeline. Related intake/approval references currently return all matching records.
- Full responsive/accessibility acceptance and live-provider pilot acceptance.

Manager delivery setup and any provider activation require separate authorization.
No pricing, trial, payments, work orders, campaigns, win-back, review-text or mobile
app scope is added. Qualification and booking remain later dependencies.

## Verification

Final results: 1,162 unit passes (four intentional live skips), 322 integration
passes (zero skips), lint, offline build and post-build types passed. All 83
migrations initialized from zero; catalog, relationship and rollback/refusal probes
passed. See the matching October 5 entry in `docs/AI_WORK_LOG.md` for browser checks.
Node 22 isolated commands: `node scripts/isolated-check.mjs unit`,
`integration --fresh`, `lint`, `build`, then `types`. The runner uses an empty
environment and OS egress denial; integrations allow only the dedicated loopback
Supabase endpoint. No production/provider credentials or live evaluations are used.

Fresh initialization: `supabase --workdir .local-tools/record-fresh db reset --local
--no-seed`, followed by all three disposable failure fixtures. Verification:
`python3 scripts/verify-whisper-migration.py`,
`python3 scripts/verify-intake-vehicle-migration.py --fresh`,
`python3 scripts/verify-agent-record-migration.py --fresh`, original tenant/photo
refusal probes redirected in memory to this same unlinked disposable stack, and
`git diff --check`. Runtime artifacts and generated credentials stay ignored.
