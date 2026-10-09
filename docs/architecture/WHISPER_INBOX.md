# Whisper inbox and operational handoff

## Scope — October 6, 2026

This covers the operational-inbox, exact-context reply and owner-reconciliation slices of milestone 4 in the five governing
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

Since October 8 a manager holding the explicit `approvals.messages` grant can approve
an already queued text or email; staging a reply is still owner-only. See
`CONTROL_CENTER_IMPLEMENTATION.md`.
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

The existing owner purpose-review controls in Approvals now display and bind the
exact inbound message captured by the immutable Whisper staging command. Explicit
service-reply review signs the action, owned customer, channel, canonical destination,
message content, inbound ID and inbound content/time fingerprint. Another or later
inbound message cannot substitute for this context. Changed, missing, outbound or
older-than-48-hour context fails closed. Review does not grant marketing consent or
send anything; STOP, DNC, suppression, policy and durable execution claims still apply.
Legacy producers retain their existing purpose rules; failed context lookup never
falls back to a different conversation. This trusts existing inbound metadata and
explicit owner review, not a new upstream provider-attestation system.

Consumed claims remain visible as held work even when execution rolled back to
pending or an operator previously marked the conversation complete. Approvals shows
a read-only delivery review with claim/response timestamps and reconciliation steps;
editing or reclassifying a claimed action is denied. Provider acceptance is not proof
of delivery. An authorized owner must inspect provider evidence, retain a hold if
uncertain, and explicitly review any replacement under current consent/policy rules.
Owners can now record delivered, not-delivered or still-uncertain assessments with
bounded evidence notes in the same approval page. These are explicitly human reports,
not provider-verified receipts. Each append-only revision captures the session actor,
owner-name snapshot, time and reviewed execution-completion timestamp. Paginated
history preserves earlier decisions. Missing history, changed execution state,
stale revisions and conflicting command reuse fail closed. Exact command retries
are idempotent. Manager/staff/service callers cannot record these owner reviews.

Recording a review never changes the pending action, consumed proof, consent,
conversation hold or policy. No automatic resend, provider lookup or claim release
is implemented. A not-delivered assessment does not itself authorize a replacement.
This prioritizes avoiding duplicate delivery over automatic recovery after an
uncertain provider outcome. The review is operational evidence, not a published
Memory rule or a new instruction for Gradia.

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

Migration 84, `20261005160000_whisper_reply_context.sql`, adds a fixed-search-path
owner/service context resolver and replaces inbox read functions to expose consumed
execution holds. Anonymous access is denied; owner access requires live membership.
It adds no data transformation, repair, transport or new message store.

Migration 85, `20261006120000_delivery_reconciliation.sql`, adds an RLS-enabled
append-only review table with no direct anonymous/authenticated/service privileges.
Two fixed-search-path session-only RPCs enforce live owner authority. A composite
shop/action relationship binds every review to durable consumed authority. Historical
reviews survive pending-action deletion, as consumed proofs already do; deleting
the owning shop cascades via its proof records. No existing deletion behavior,
customer merge or provider executor is changed. Retention/pruning remains disabled.

## Remaining milestone gates

- Independent transactional-email provider choice/setup; real notification delivery
  stays disabled. No immediate email, digest, quiet-hour scheduler or retry worker
  is claimed. In-app notifications require a refresh; there is no realtime feed.
- Provider thread/message identity and true in-thread email reply integration.
- Provider-evidence lookup tooling and separately authorized replacement handling.
  Assessments are persisted, but do not verify a provider receipt, clear the
  execution hold or authorize a resend. Delegated manager review is described below;
  delegated approval or replacement authority is not added.
- Search/filtering, bounded related-record paging and a browsable handoff-audit
  timeline. Related intake/approval references currently return all matching records.
- Full responsive/accessibility acceptance and live-provider pilot acceptance.

## Delegated manager delivery review — October 8, 2026

This is the first delegated manager operation. It supersedes the owner-only limit on
recording delivery assessments, and nothing else. Branch `codex/claude-backend-next`.

An owner can grant a manager `delivery.reconcile` in the existing team settings.
The grant is valid only together with `crm.read` and only on a manager membership;
both tables that carry grants enforce this with constraints, and the team command
schema explains it before the database refuses. Membership or `crm.read` alone
grants nothing. Existing members and invitations are unchanged by the migration.

Migration `20261008120000_delegated_delivery_reconciliation.sql` is migration 88.
A private fixed-search-path helper resolves the caller's live reviewing role (actual
owner, or active manager holding both grants). `record_delivery_reconciliation` and
`read_delivery_reconciliation` keep their signatures and session-only grants and now
use that helper under the same shop lock, so grant removal or revocation applies to
the next command, including an exact retry. Each review stores `actor_role`; all
earlier rows are owner reviews. History shows the recorded role and name snapshot.

`list_delivery_holds` is a new session-only, stable read for the owner or a delegated
manager. It returns pages of 20 consumed sends that are still held, using the inbox
hold definition, with presentation fields only: action, channel, customer name,
message body, claim and provider-response times, and the latest review. Proof
identifiers, signed claims and destinations are not returned. Reading changes nothing.

`/team/delivery-reviews?shop=...` is a minimal surface for this, linked from the team
page for owners and delegated managers. It reuses the existing history and form
components. The owner approval record is unchanged apart from role-neutral wording
("Reported delivered", "delegated manager").

Unchanged on purpose: a manager review cannot approve, edit, reject or stage an
action, read `pending_actions` or proof rows directly, release a proof, clear a hold,
authorize a replacement, grant consent or change policy. `claim_control_action`
still denies every non-owner. Managers still cannot stage replies. No notification,
provider lookup or transport is involved.

Verification, Node 22.23.2, isolated runner, unlinked `gradia-record-fresh` only:
1,235 unit passes (four existing live skips, 109 files); 369 integration passes
(zero skips, 35 files); lint, offline production build and post-build typecheck
passed. All 88 migrations applied from zero and matched the ledger; Whisper, intake,
agent-record, team, control-policy and control-execution catalog probes, all 26
tenant relationship definitions and the tenant/photo refusal probes passed. Seven new
integration cases cover attributed manager reviews, no approval or direct-table
access, both-grant and live-membership checks, grant removal and revocation,
command binding across reviewers and shops, competing owner/manager decisions,
bounded hold listing with zero mutation, and invitation grants. Three new unit cases
cover role attribution, unknown-role refusal and the grant dependency. One test
fixture was corrected (a mixed-key bulk insert nulled `status`); no assertion,
constraint or permission was weakened.

Limits: the new page was compiled and statically rendered in tests, not exercised in
an authenticated browser; responsive and accessibility acceptance belongs to the UI
lane. The hold list has no search or filter. A review is still not assigned to, or
required from, the conversation's current assignee. Committed as `23f2932` and
pushed for review as a pull request; no merge, deployment, shared database or
provider activity.

Manager delivery setup and any provider activation require separate authorization.
No pricing, trial, payments, work orders, campaigns, win-back, review-text or mobile
app scope is added. Qualification and booking remain later dependencies.

## Verification

Final results: 1,176 unit passes (four intentional live skips), 347 integration
passes (zero skips), lint, offline build and post-build types passed. All 85
migrations initialized from zero; catalog, relationship and rollback/refusal probes
passed. See the October 5–6 entries in `docs/AI_WORK_LOG.md` for browser checks.
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
