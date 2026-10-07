# Whisper inbox and operational handoff

## Scope — October 6, 2026

This covers the operational-inbox, exact-context reply, owner-reconciliation, provider-threaded email and disabled manager-delivery slices of milestone 4 in the five governing
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

The existing owner purpose-review controls in Approvals now display and bind the
exact inbound message captured by the immutable Whisper staging command. Explicit
service-reply review signs the action, owned customer, channel, canonical destination,
message content, inbound ID and inbound content/time fingerprint. Another or later
inbound message cannot substitute for this context. Changed, missing, outbound or
older-than-48-hour context fails closed. Review does not grant marketing consent or
send anything; STOP, DNC, suppression, policy and durable execution claims still apply.
Legacy producers retain their existing purpose rules; failed context lookup never
falls back to a different conversation. SMS retains its inbound metadata trust boundary. Email now additionally requires
insert-only provider evidence recorded after signature-verified Aurinko intake.
This evidence is bound to the current mailbox account, interaction content/time,
customer and canonical sender; browser sessions cannot create or alter it.

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

## Provider-threaded email

Migration 86, `20261006140000_email_reply_evidence.sql`, records the fetched
provider message and optional thread identity in an insert-only service table.
Its shop/interaction FK and trigger reject foreign interactions, outbound messages,
account mismatches and substituted message IDs. The immutable Whisper command
resolves the exact inbound evidence; mutable pending-action source labels cannot
bypass it. Old email interactions without verified evidence are held, not backfilled
or silently sent as new threads. Existing email proofs need fresh owner review
because their fingerprint now includes mailbox/message/thread identity.

The existing approval executor uses Aurinko's documented
[`POST /email/messages/{messageId}/reply`](https://apirefs.aurinko.io/#tag/Messages)
with one explicit destination and empty CC/BCC. There is no reply-all, tracking or
standalone fallback. Unsupported message IDs are held; the accepted ID alphabet is
letters, digits, `_+=.-`, excluding dot-only path segments, with a 1,024-character
limit. Provider pilot validation must confirm that supported mailbox IDs fit this
conservative boundary. A response without confirmed provider acceptance/message ID
is uncertain, not successful delivery.

Marketing consent remains required for marketing replies. After it passes, a
separate execution-only signed claim binds the same action and content. That claim
uses existing durable proof consumption but cannot authorize a service-consent
exemption. Both reviewed service replies and consented marketing replies retain
at-most-once transport authority across uncertain outcomes. Old non-Whisper email
producers still use their existing standalone path; they are not claimed as
provider-threaded by this slice.

## Independent manager email

Migration 87, `20261006150000_manager_notification_delivery.sql`, adds owner-only,
revision-checked preferences and audited settings, durable delivery batches and
per-notification deduplication. The existing Settings email section exposes off,
immediate and daily-digest preferences, timezone, quiet hours, and the latest 20
attempts. There is no second settings screen. Saving preferences sends nothing.

The service-only worker claims existing unread handoff/reply notifications for a
currently active, confirmed owner or CRM-read manager. Initial enable does not
backfill historical notifications. Digests contain up to 50 updates, once per
recipient/local day. Quiet hours delay both modes. Emails contain only an operational
count and the fixed production workspace link, never customer content. Customer
mailbox credentials are not used. Recipient authority is checked at claim time;
opening the link independently rechecks live application access.

An optional Resend adapter is implemented against its
[documented idempotency contract](https://resend.com/changelog/idempotency-keys).
No provider is selected by default. Delivery requires all four explicit runtime
settings in `.env.example`, separate credentials and separately authorized worker
scheduling. No route or cron invokes the worker in this slice, and live delivery
remains disabled. The old in-app notification `email_state` remains historical
`disabled`; actual delivery history lives in the new batch records.

Only explicit rate limiting is retryable: at most three claims, the same ID/payload,
and less than 23 hours from creation (inside the provider's 24-hour dedupe window).
Changed settings, recipient, sender, acknowledged/deleted work or expired retry
windows cancel the retry. Timeouts, ambiguous responses, server failures and stale
claims become unknown and never automatically resend. Accepted means accepted by
the provider, not delivered. Failed completion writes retain the claimed batch;
a subsequent worker pass marks stale claims unknown. Owners see these states in
Settings and must reconcile provider evidence manually; no retry/resend UI exists.

## Remaining milestone gates

- Choose/setup an independent transactional-email provider and authorize worker
  scheduling plus activation. Resend is an optional adapter, not an approved live
  provider. In-app notifications still require refresh; there is no realtime feed.
- Live provider pilot acceptance of Aurinko threading, explicit recipients,
  notification sender verification and delivery receipts. No provider was contacted
  by the implementation tests.
- Provider-evidence lookup tooling and separately authorized replacement handling.
  Owner assessments are persisted, but do not verify a provider receipt, clear the
  execution hold or authorize a resend. Delegated manager reconciliation is not added.
- Search/filtering, bounded related-record paging and a browsable handoff-audit
  timeline. Related intake/approval references currently return all matching records.
- Full responsive/accessibility acceptance.

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
