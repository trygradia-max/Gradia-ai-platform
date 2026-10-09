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

The action does not revalidate any path; no screen exists yet. Add that when one does.

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

## Verification

Node 22.23.2, isolated runner with outbound network denied, unlinked disposable
`gradia-record-fresh` stack only. The public-form stack was not touched.

Results are recorded in the October 9 entry of `docs/AI_WORK_LOG.md`.

Commands: `supabase --workdir .local-tools/record-fresh db reset --local --no-seed`;
install the five fixtures in `tests/sql/`; `node scripts/isolated-check.mjs unit`,
`integration --fresh`, `lint`, `build`, `types`;
`python3 scripts/verify-lead-qualification-migration.py` and the existing probes;
`git diff --check`. `tests/sql/qualification-failure.sql` is a disposable-only
trigger that fails the audit insert on a marker value; it is not a migration.

## Limits

- No screen. Cursor owns the UI; this document is the contract.
- A save replaces the whole document. There is no per-field patch and no merge of
  concurrent edits: the second writer gets `revision_conflict`.
- The workflow state machine still has only `identity_review` and
  `identity_linked`. No `qualifying` state or pipeline stage is written.
- Nothing connects a qualification to a quote, an availability check or a booking.
- The Agent does not read or write qualification. No model or provider is involved,
  so persisted multi-turn qualification conversations remain future work.
- The queue has no search or filter. Staff have no access, including for customers
  assigned to them.
- Retention and pruning are not enabled.
- Not applied to any shared or production database.
