# Durable lead qualification — backend contract

October 9, 2026. Branch `codex/claude-qualification`. First backend slice of MVP
sequence step 5. This is qualification **persistence**. It is not a qualification
conversation, a nurture engine, a quote, a booking or a claim that the
nurture-to-book loop works.

## What exists

One qualification record per intake workflow, written only by a signed-in owner or
an explicitly delegated manager, with an append-only audit of every accepted change.

It records what a reviewer established about the request:

| Field | Holds |
| --- | --- |
| `service` | A service from the shop's menu, free text, or both |
| `vehicle_condition` | Condition as reported, in text. Separate from vehicle identity |
| `timing` | Earliest date, latest date and/or a text preference |
| `location` | `shop` or `mobile`, with an optional area |
| `constraints` | Up to 10 short constraints |
| `open_questions` | Up to 20 questions, each `open`, `answered` or `dropped` |

It does **not** store a customer or a vehicle. Identity stays on the workflow's
reviewed customer and vehicle links from intake review. An existing structure was
looked for first: `lead_workflows` carries identity only, `leads` carries a pipeline
stage and free-text `car_info`, and nothing held structured, reviewed qualification.
The record is keyed to the workflow rather than added to either table, so it creates
no second CRM entity and leaves the workflow state machine and its history untouched.

Nothing in this slice creates a customer, vehicle, lead, quote, booking, consent
record or message, calls a provider or a model, or runs on a schedule.

## Rules a screen must respect

**Unknown is a value.** All five fields are always present. Each has a `status`:

- `unknown` — nobody has established it. It carries no value and no source.
- `reported` — someone stated it; not checked.
- `confirmed` — a reviewer checked it.

A missing field is refused. Constraints distinguish "nobody has asked"
(`unknown`, empty list) from "there are none" (`reported` or `confirmed`, empty list).

**Provenance is per field.** `source` is `customer`, `staff` or `intake`. `intake`
must cite `evidence_revision`: the revision of a real submission on this workflow
(see intake history). The reviewer, role and time of every change are in the audit.

**Review state and completeness are different things.**

- `review_state` is what a human declared: `in_progress` or `reviewed`. Reads also
  return `not_started` (nothing recorded) and `needs_review` (see below).
- `completeness` is computed: `complete` only when the record is current, the
  vehicle link is confirmed, no field is `unknown` and no question is `open`.
  `missing` lists exactly what is absent.

A record can be `reviewed` and `incomplete` (the reviewer confirmed timing is not
known yet). It can be `complete` and `in_progress`. Neither means "ready to quote".

**A record is only current against what was reviewed.** Every save is bound to the
customer, vehicle and evidence the reviewer was looking at. Reads compare that with
the live workflow and return `needs_review` with `review_reasons`:

| Reason | Cause |
| --- | --- |
| `identity_in_review` | New evidence reopened identity review, or the customer was deleted |
| `customer_changed` | The workflow now points at a different customer (for example after a merge) |
| `vehicle_changed` | The vehicle link was cleared, changed or its details were edited |
| `new_evidence` | A submission arrived after the last save |

The recorded answers are kept and shown; they are just no longer presented as
current. Saving again (after identity is linked) makes the record current.

**Unresolved intake cannot be qualified.** While a workflow is in identity review,
saving is refused with `identity_review_required`.

## Authority

| Actor | Read | Save |
| --- | --- | --- |
| Shop owner | Yes | Yes |
| Manager with `crm.read` | Yes | No |
| Manager with `crm.read` and `leads.qualify` | Yes | Yes |
| Staff, including staff assigned to the customer | No | No |
| Revoked member, other shop's owner, anonymous, service caller without a session | No | No |

`leads.qualify` is a new owner-granted capability, off for everyone by default. No
existing capability's documented meaning covered recording qualification. It is
valid only together with `crm.read` and only on a manager membership. Reading
reuses `crm.read`, which already covers the customer and intake evidence shown.
Authority is rechecked in SQL on every call under the shared shop lock, so a
revoked grant applies to the next command, including an exact retry.

## Operations

All four are session-only RPCs. Use the helpers; they validate replies and never
report a failed read as an empty record.

| Purpose | Helper | RPC |
| --- | --- | --- |
| One record | `loadLeadQualification(db, shopId, workflowId)` | `read_lead_qualification` |
| Queue, 20 per page | `loadLeadQualifications(db, shopId, offset)` | `list_lead_qualifications` |
| Audit, 20 per page | `loadLeadQualificationHistory(db, shopId, workflowId, offset)` | `read_lead_qualification_history` |
| Save | `updateLeadQualification(command)` server action | `update_lead_qualification` |

Helpers: `src/lib/data/lead-qualification.ts`. Action:
`src/app/actions/lead-qualification.ts`. Schemas and types:
`src/lib/lead-qualification.ts`. List and history return up to 21 items; the 21st
means another page exists. The list omits `fields` and `open_questions`.

The action revalidates `/intake` and `/intake/[workflowId]` after an accepted save.

### Reading a record

A linked lead with nothing recorded yet (synthetic):

```json
{
  "workflow_id": "7b1f0c9e-2a44-4d0b-9a55-0c5d1e2f3a41",
  "channel": "website_form",
  "last_received_at": "2026-10-09T15:02:11+00:00",
  "identity": {
    "state": "identity_linked",
    "customer_id": "c2a9d7e0-5b1c-4f6e-8d21-9e0a4b7c6d52",
    "customer_name": "Fictional Lead",
    "vehicle_id": "a4e8b6c2-7d3f-4a19-b0c5-1f2e3d4c5b63",
    "vehicle_status": "confirmed",
    "vehicle": { "year": 2021, "make": "Fictional", "model": "Coupe", "color": null },
    "evidence_revision": 1
  },
  "revision": 0,
  "review_state": "not_started",
  "recorded_review_state": null,
  "review_reasons": [],
  "fields": {
    "service": { "status": "unknown", "source": null, "evidence_revision": null, "service_id": null, "text": null },
    "vehicle_condition": { "status": "unknown", "source": null, "evidence_revision": null, "text": null },
    "timing": { "status": "unknown", "source": null, "evidence_revision": null, "earliest": null, "latest": null, "text": null },
    "location": { "status": "unknown", "source": null, "evidence_revision": null, "type": null, "area": null },
    "constraints": { "status": "unknown", "source": null, "evidence_revision": null, "items": [] }
  },
  "open_questions": [],
  "missing": ["service", "vehicle_condition", "timing", "location", "constraints"],
  "completeness": "incomplete",
  "updated_at": null,
  "updated_by": null,
  "can_update": true
}
```

Show the save controls only when `can_update` is true. `identity.vehicle` is present
only while the vehicle link is confirmed.

### Saving

A save replaces the whole document. Send every field, including the unknown ones.

```json
{
  "shopId": "5d0e1f2a-3b4c-4d5e-8f60-718293a4b5c6",
  "workflowId": "7b1f0c9e-2a44-4d0b-9a55-0c5d1e2f3a41",
  "commandId": "0f9e8d7c-6b5a-4c3d-9e2f-1a0b9c8d7e6f",
  "revision": 0,
  "customerId": "c2a9d7e0-5b1c-4f6e-8d21-9e0a4b7c6d52",
  "vehicleId": "a4e8b6c2-7d3f-4a19-b0c5-1f2e3d4c5b63",
  "reviewState": "in_progress",
  "fields": {
    "service": { "status": "reported", "source": "intake", "evidence_revision": 1, "service_id": null, "text": "Ceramic coating" },
    "vehicle_condition": { "status": "reported", "source": "customer", "evidence_revision": null, "text": "Light swirl marks, no known repaint" },
    "timing": { "status": "reported", "source": "customer", "evidence_revision": null, "earliest": "2026-10-20", "latest": "2026-10-31", "text": "Weekday mornings" },
    "location": { "status": "confirmed", "source": "staff", "evidence_revision": null, "type": "shop", "area": null },
    "constraints": { "status": "unknown", "source": null, "evidence_revision": null, "items": [] }
  },
  "openQuestions": [
    { "id": "3c2b1a09-8f7e-4d6c-a5b4-c3d2e1f0a9b8", "text": "Is the vehicle garage kept?", "status": "open", "answer": null }
  ]
}
```

- `revision`, `customerId` and `vehicleId` are the values from the read the reviewer
  was looking at. `vehicleId` is `null` when no vehicle is linked.
- `commandId` is a UUID generated once per save attempt. **Reuse the same id when
  retrying the same save.** Generate a new one only for a new edit.
- Question ids are generated by the screen and kept stable across saves.

Success returns the full record, exactly as a read would, plus the outcome:

```json
{ "ok": true, "status": "recorded", "qualification": { "revision": 1, "review_state": "in_progress", "completeness": "incomplete", "missing": ["constraints", "open_questions"], "updated_by": { "actor_id": "…", "label": "Owner", "role": "owner" }, "…": "…" } }
```

`status` is `already_recorded` when the same command id and payload were accepted
before; nothing new was written.

### Every other outcome

| Result | Meaning | What the screen should do |
| --- | --- | --- |
| `{ ok: false, code: "invalid", field }` | The document broke a rule. `field` is a path such as `fields.timing.latest`, `open_questions.answer`, `review_state` or `command` | Point at the field. Nothing was saved |
| `{ ok: false, code: "forbidden" }` | Not signed in to this shop with the needed grant, or the workflow is not in this shop | Remove the save controls; do not retry |
| `{ ok: false, code: "reference_unavailable", reference }` | The `customer`, `vehicle` or `service` named is not this shop's (or the vehicle is not that customer's) | Reload; the record it pointed at is gone or was never valid |
| `{ ok: false, code: "revision_conflict" }` | Someone saved since this reviewer loaded the record | Reload and show their version; do not overwrite |
| `{ ok: false, code: "command_conflict" }` | This command id was already used with a different payload, reviewer or workflow | Generate a new id only after the reviewer has re-reviewed |
| `{ ok: false, code: "identity_review_required" }` | The workflow is in identity review | Send the reviewer to intake review |
| `{ ok: false, code: "customer_changed" }` | The workflow is linked to a different customer than the one sent | Reload |
| `{ ok: false, code: "vehicle_changed" }` | The vehicle link or the vehicle's details changed | Reload; the vehicle may need linking again |
| `{ ok: false, code: "not_confirmed" }` | The database refused or the reply could not be verified. Nothing is assumed saved | Reload before trying again |
| `{ ok: false, code: "uncertain" }` | No reply was received | Retry with the **same** `commandId`, or reload and compare |

Validation paths the database can return: `command`, `review_state`, `fields`,
`fields.<name>`, `fields.<name>.status`, `fields.<name>.source`,
`fields.<name>.evidence_revision`, `fields.service.service_id`, `fields.service.text`,
`fields.vehicle_condition.text`, `fields.timing.earliest`, `fields.timing.latest`,
`fields.timing.text`, `fields.location.type`, `fields.location.area`,
`fields.constraints.items`, `open_questions`, `open_questions.id`,
`open_questions.text`, `open_questions.status`, `open_questions.answer`.

Limits: service text 200; condition 1,000; timing text 300; area 200; each constraint
200; question 500; answer 1,000 characters. Text must be trimmed and free of control
characters. Dates are `YYYY-MM-DD` and `latest` cannot precede `earliest`.

No database message text reaches the caller.

## Next question proposal

October 12, 2026. Branch `auto/qualification-next-question`. Read-only. No migration,
RPC, capability, action or screen was added, and no model or provider is called.

`loadNextQualificationQuestion(db, shopId, workflowId)` reads one record through
`read_lead_qualification` and returns the single next thing to ask, for a reviewer to
read, edit or ignore. `proposeNextQualificationQuestion(record)` is the same rule as a
pure function, for a screen that already holds the record. Both are in the files
listed under Operations.

Three replies are possible. Every one carries `basis`: the workflow, qualification
`revision` and `evidence_revision` it was derived from.

```json
{
  "kind": "question",
  "delivery": "none",
  "target": "timing",
  "question_id": null,
  "text": "When would you like to bring it in?",
  "basis": { "workflow_id": "7b1f0c9e-2a44-4d0b-9a55-0c5d1e2f3a41", "revision": 1, "evidence_revision": 1 }
}
```

```json
{ "kind": "review_required", "reasons": ["new_evidence"], "basis": { "…": "…" } }
```

```json
{ "kind": "none", "reason": "complete", "basis": { "…": "…" } }
```

Selection, in this order:

1. **Review first.** A workflow in identity review, or a record that is
   `needs_review`, returns `review_required` with the read's `review_reasons`
   (`identity_in_review`, `customer_changed`, `vehicle_changed`, `new_evidence`). No
   customer-facing question is offered, even if fields are unknown or questions open.
2. **Existing open questions.** The first question with status `open`, verbatim, with
   `target` `open_question` and its `question_id`. `answered` and `dropped` questions
   are skipped. No field question is proposed while one is open.
3. **Unknown fields**, first match of `service`, `vehicle_condition`, `timing`,
   `location`, `constraints`. Only status `unknown` counts. A `reported` or
   `confirmed` field is never re-asked, and a known empty constraint list is an answer.
4. **Vehicle link.** If nothing above applies and the vehicle link is not confirmed,
   `review_required` with `vehicle_unlinked`. A vehicle is linked in intake review; the
   customer is never asked for it here.
5. **Complete.** `none` / `complete`. This says nothing is missing from the record. It
   does not say the lead can be quoted or booked.

What a proposal is not:

- **Not a message.** Nothing is stored, enqueued, staged as an approval or sent.
  `delivery` is always `none`. It leaves no audit row.
- **Not permission to send.** Authority is the read's (`crm.read`). Being able to read
  a qualification is not permission to message the customer.
- **Not an inference.** Field wording is fixed text. It states no price, service
  availability, consent, identity or answer.

Any later step that stages a question for sending must independently recheck, at that
moment: the current qualification `revision` and `evidence_revision` against `basis`,
the channel, the recipient, the customer's consent and opt-out state, and the existing
policy and approval rules. It must use the existing approval executor. None of that is
built here.

`{ ok: false }` from the loader means the read failed or was refused. It never means
there is nothing to ask. A reviewer who wants to keep a proposal records it as an open
question with the existing save.

## Queueing a reviewed question for approval

October 14, 2026. Branch `auto/qualification-question-approval`. This is the step
between a reviewed suggestion and the Approvals inbox. It puts one owner-reviewed
question in the queue as a pending `send_sms` or `send_email` approval. **It sends
nothing.** Sending stays with the owner in Approvals, through the existing executor
and its send-time checks.

### What was missing, and what is reused

The staging path already exists: `whisper_command` with operation `reply`, the
Whisper inbox reply. That RPC runs on the session client. It takes the shop lock,
allows only the active owner and uses a caller-supplied command id. That id is both
the audit key and the pending action id. It re-checks the recipient against the
customer row and refuses a stale conversation. It always classifies the message as
`marketing`, and nothing it stages auto-sends.

What it does not know is qualification, and this is the gap. Nothing ties the
queued message to the qualification revision it came from, so nothing refuses a
question that went stale between review and queueing. There is also no guard
against queueing the same question twice.

The missing step is one SQL function, `stage_qualification_question`. It takes the
shop lock, re-checks the qualification and the contact, and then calls
`whisper_command` in the same transaction. It adds no second executor, no new
action type, no schedule and no provider call. The pending row is the one
`whisper_command` writes. Its payload gains one key, `qualification`, so Approvals
and the executor see an ordinary Whisper reply that can be traced back to the lead.

### Who may queue

| Actor | Queue |
| --- | --- |
| Shop owner, active membership | Yes |
| Manager, any grants (including `crm.read` + `leads.qualify`) | No |
| Staff, revoked member, other shop's owner, anonymous, service role | No |

This is the Whisper reply rule, unchanged: only the owner may queue a customer
message. Reading or recording a qualification is not permission to message. A
manager with `approvals.messages` still decides on queued messages through the
existing delegated claim; that is not changed here.

Authority is rechecked under the shop lock on every call, **before** the
exact-retry check. A revoked caller's exact retry is refused.

### Command

Server action `stageQualificationQuestion(input)` in
`src/app/actions/lead-qualification.ts`, over the RPC
`stage_qualification_question`.

```json
{
  "shopId": "5d0e1f2a-3b4c-4d5e-8f60-718293a4b5c6",
  "workflowId": "7b1f0c9e-2a44-4d0b-9a55-0c5d1e2f3a41",
  "commandId": "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d",
  "basis": { "workflow_id": "7b1f0c9e-2a44-4d0b-9a55-0c5d1e2f3a41", "revision": 1, "evidence_revision": 1 },
  "target": "timing",
  "questionId": null,
  "channel": "sms",
  "conversation": { "latestId": "e1d2c3b4-a596-4877-8695-a4b3c2d1e0f9", "revision": 0 },
  "message": { "body": "When would you like to bring it in?", "subject": "", "destination": "+15555550123" }
}
```

- `basis` is the proposal's `basis`, copied unchanged. Its `workflow_id` is
  optional, but when present it must equal `workflowId`; otherwise the result is
  `invalid` with `field: "basis"`. Until October 15 the action wrongly refused
  the published basis because of that key.
- `target` and `questionId` are the proposal's `target` and `question_id`.
  `questionId` is required only when `target` is `open_question`.
- `conversation` holds `latest_id` and `revision` from the Whisper thread read for
  this customer and channel, exactly as a Whisper reply sends them.
- `message.body` is the reviewer's final text. The reviewer may edit the suggested
  wording. `subject` is required for email and must be `""` for SMS.
  `destination` is the customer's phone or email as the reviewer saw it.
- `commandId` is generated once per queue attempt. **Reuse it when retrying.**

The customer is never taken from the caller. It is the workflow's linked customer,
read under the lock.

### Checks, in order, all in one transaction

1. **Shop lock**, then **authority**: the caller is the active owner of this shop.
2. **Shape**: valid ids, a known `target`, `questionId` present exactly for
   `open_question`, channel `sms` or `email`.
3. **Exact retry**: if `commandId` already names a pending action, its recorded
   `qualification` binding and its Whisper binding must both match. If they do,
   the call returns `already_queued` and writes nothing. If either differs, the call
   fails with `command_conflict`. Exact retries skip checks 4–9: they return the
   original outcome even after the record has moved on, as qualification saves do.
4. **Workflow lock**. The workflow must exist in this shop.
5. **Current qualification**: `revision` and `evidence_revision` must equal `basis`
   (`qualification_changed`). After that, the record must not be in identity review
   or `needs_review` (`review_required`).
6. **Target is still the proposal** (`question_resolved`). The database uses the
   rule from `proposeNextQualificationQuestion`: the first `open` question, otherwise
   the first `unknown` field in the fixed order. The target must equal that question.
   The wording may be edited. Which question is asked may not.
7. **Contact hard stops** on the linked customer (`contact_blocked`). These match the
   executor's own denials:
   - `do_not_contact` is not explicitly `false`;
   - for SMS, `sms_opted_out_at` is set;
   - the canonical destination is suppressed in `customer_channel_permissions`.
8. **Channel readiness** (`channel_unavailable`).
   - SMS needs a business number. A Gradia number needs approved A2P. A
     bring-your-own number needs `byo_sms_verified`.
   - Email needs a connected mailbox.
9. **One open question per lead**: no other unexecuted qualification question for
   this workflow may be waiting. That means pending, edit-requested, or approved but
   not sent (`question_pending`). A consumed send claim also blocks replacement while delivery is unconfirmed, even if the action was later rejected or has a result without a completed claim. A double-click with a fresh id cannot queue the
   question twice.
10. **Existing staging**: `whisper_command(... 'reply' ...)` runs inside the same
    transaction. Its checks still apply:
    - owner only;
    - the conversation must be unchanged (`conversation_changed`), which includes
      the case where the customer has no thread on that channel;
    - the destination must equal the customer's current phone or email
      (`recipient_changed`);
    - body length must be valid;
    - the active Control Center policy must allow staging (`policy_blocked`).
11. The pending row's payload gets
    `qualification: { workflow_id, revision, evidence_revision, target, question_id }`.

Any refusal rolls back everything. Nothing partial is left.

### Result

```json
{ "ok": true, "status": "queued", "actionId": "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d", "workflowId": "7b1f0c9e-…", "channel": "sms" }
```

`status` is `already_queued` for an exact retry. `actionId` always equals `commandId`.
A queued question is **not** sent, approved, or a consent decision.

| Result | Meaning | What the screen should do |
| --- | --- | --- |
| `invalid` + `field` | Shape refused. Nothing was queued | Point at the field |
| `forbidden` | Not this shop's active owner, or the workflow or conversation is not visible | Remove the control; do not retry |
| `command_conflict` | This id was already used for something else | New id only after the reviewer re-reviews |
| `qualification_changed` | The record or its evidence moved since the suggestion | Reload and re-propose |
| `review_required` | Identity or evidence needs review | Send to intake review |
| `question_resolved` | That is no longer the proposed question: the field is known, the question was closed, or another question comes first | Reload and re-propose |
| `question_pending` | A question for this lead is already waiting in Approvals | Point to Approvals |
| `contact_blocked` | Do-not-contact, opted out, or suppressed | Show it; never offer an override here |
| `channel_unavailable` | The channel is not connected or SMS is not carrier-approved | Point to Settings |
| `conversation_changed` | A new message arrived, the thread was handed off, or there is no thread on this channel | Reload the thread |
| `recipient_changed` | The customer's phone or email changed | Reload |
| `policy_blocked` | The active policy does not permit staging this action | Show the policy state |
| `not_confirmed` | Refused or unverifiable reply | Reload before retrying |
| `uncertain` | No reply received | Retry with the **same** `commandId` |

### What still happens at send time, unchanged

When the owner approves, the existing executor runs all its current checks. It
claims the action atomically and re-checks the policy. It verifies the destination,
DNC, opt-out and suppression again. A marketing message needs recorded
`marketing_consent_at`; otherwise the owner must attach the existing reply-purpose
proof to an inbound message less than 48 hours old. It applies quiet hours, the A2P
gate and the at-most-once execution ledger. Email also needs verified reply context.

So a queued question for a lead with no marketing consent and no recent inbound
message **will be held at send**. That is the existing rule and this step does not
loosen it.

### Not in this step

- No screen. Cursor owns the control on `/intake/[workflowId]`.
- Leads with no SMS or email thread, such as website-form leads that never
  messaged, cannot be queued. `whisper_command` needs a conversation. A first
  outbound message to such a lead is a consent question, not a staging gap.
- No automatic queueing, nurture, retry loop, cron, model or provider call.
- No change to `whisper_command`, the executor, consent rules or the action type
  enum.

### Connected acceptance

`eval/integration/lead-workflow-acceptance.int.test.ts` runs one synthetic lead
through every step, with the SMS provider faked:

1. Inbound SMS intake, including the provider redelivering the event.
2. The owner links the identity.
3. The qualification proposal.
4. `stageQualificationQuestion`.
5. Owner or delegated-manager approval through the existing executor.

It covers:

- one transport call under concurrent and exact retries;
- a hold at send without consent or a reviewed reply purpose;
- stale evidence;
- a changed recipient, DNC and STOP after queueing;
- a manager who can approve but cannot queue, and who loses approval when the
  membership is deactivated;
- an unknown provider outcome that never resends and blocks a replacement
  question;
- a website-only lead that is refused.

These transitions are **not supported** by current code. They are recorded here
rather than tested as correct:

- **A queued question is not withdrawn when the record moves on.** The executor
  does not know the qualification binding. If the answer arrives, or the record
  changes, after queueing, the owner can still approve and send the now-stale
  question. Only the reviewer's judgment in Approvals stops it.
- **Nothing records that a question was asked.** After a question is sent and its
  delivery confirmed, the same proposal, with the same basis, can be queued again.
- **The inbound reply does not update the record.** Answers are recorded by a
  person through `update_lead_qualification`. There is no automatic parsing.
- **Email was not exercised end to end.** The suite drives SMS only. Email staging
  is covered by the staging tests, and the email send-time rules by the Whisper
  reply-context tests.

## Schema

Migration `20261009100000_lead_qualification.sql`, migration 93.

- `lead_qualifications` — primary key `(shop_id, workflow_id)`, cascading from
  `lead_workflows(shop_id, id)`. Holds the current document, `revision`,
  `review_state`, and the reviewed customer, vehicle and evidence revision. A table
  check runs the same validator the RPC uses.
- `lead_qualification_revisions` — append-only audit, primary key `command_id`,
  unique `(shop_id, workflow_id, revision)`, cascading from the record. Each row has
  the full document, the reviewer's id, role and name snapshot, the time and the
  exact command binding.
- Both tables have row-level security enabled and every direct privilege revoked
  from anonymous, authenticated and service roles. They are reachable only through
  the four RPCs.
- The reviewed customer and vehicle ids are deliberately not foreign keys: the
  existing atomic customer merge is unchanged, and a merge or relink surfaces as
  `needs_review` instead of silently carrying a review to another person.
- Lock order on save: shop, workflow, customer, vehicle — the order intake review
  already uses. Authorization, validation, the record and its audit row commit in
  one transaction.
- `shop_memberships` and `shop_invitations` accept `leads.qualify` and require
  `crm.read` with it. No existing member receives it.

Migration `20261014120000_qualification_question_staging.sql`, migration 94, adds one
function only: `stage_qualification_question`. It is session-only, with a fixed
search path, granted to `authenticated` and revoked from `anon` and `service_role`.
It adds no table, column, index, trigger, enum value or grant on any table.

## Verification

Node 22.23.2, isolated runner with outbound network denied, unlinked disposable
`gradia-record-fresh` stack only. The public-form stack was not touched.

Results, including an unresolved local-stack instability seen after the final merge
of `main`, are recorded in the October 9 entry of `docs/AI_WORK_LOG.md`.

Commands: `supabase --workdir .local-tools/record-fresh db reset --local --no-seed`;
install the five fixtures in `tests/sql/`; `node scripts/isolated-check.mjs unit`,
`integration --fresh`, `lint`, `build`, `types`;
`python3 scripts/verify-lead-qualification-migration.py` and the existing probes;
`git diff --check`. `tests/sql/qualification-failure.sql` is a disposable-only
trigger that fails the audit insert on a marker value; it is not a migration.

## Limits

- Screen: `/intake` lists records; `/intake/[workflowId]#qualification` reviews
  and edits them. Unknown, provenance, stale (`needs_review`), and save conflicts
  are presentation-only on this contract. Nothing here quotes, books, or messages.
- A save replaces the whole document. There is no per-field patch and no merge of
  concurrent edits: the second writer gets `revision_conflict`.
- The workflow state machine still has only `identity_review` and
  `identity_linked`. No `qualifying` state or pipeline stage is written.
- Nothing connects a qualification to a quote, an availability check or a booking.
- A reviewed question can be queued as a pending message approval (owner only, see
  above). There is no screen for it yet, and nothing queues or sends one on its own.
- The Agent does not read or write qualification. No model or provider is involved,
  so persisted multi-turn qualification conversations remain future work.
- The queue has no search or filter. Staff have no access, including for customers
  assigned to them.
- Retention and pruning are not enabled.
- Not applied to any shared or production database.
