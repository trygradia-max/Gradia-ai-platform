# Delivery conflict review (backend contract)

Migration `20261021110000_delivery_conflict_review.sql`. It sits on the
existing delivery-review surface (`/team/delivery-reviews`, the
`delivery_review_role` authority) and adds no second dashboard.

## What a conflict is

Twilio's status callbacks for one outbound text can disagree. One says the text
was `delivered` (or `read`) and another says `undelivered`, `failed` or
`canceled`, in either order. Callbacks carry no event time, so Gradia can't
tell which is true. The status route (#99) handles it like this:

- It keeps the first terminal outcome in `interactions.metadata.twilio_status`,
  with `twilio_error_code` if there is one.
- It keeps the contradicting outcome in
  `metadata.twilio_status_conflict = { status, error_code, received_at }`.

That evidence is never edited by a review.

## Who can see and resolve conflicts

The rule is the same as for delivery reconciliation: the shop's owner, or an
**active** manager granted both `crm.read` and `delivery.reconcile`. A revoked
or deactivated member is refused on every call. Anonymous callers and the
sessionless service role are refused too.

## Reads (Supabase RPC, signed-in session)

| RPC | Arguments | Returns |
| --- | --- | --- |
| `list_delivery_conflicts` | `p_shop uuid, p_offset int` | `{ viewer_role, items: Conflict[] }`, 20 per page; a 21st item means there's another page. Unresolved first, then newest |
| `read_delivery_conflict` | `p_shop uuid, p_interaction uuid, p_offset int` | `Conflict & { viewer_role, history: Resolution[] }`, 21 history rows per page, newest first |

Typed wrappers: `readDeliveryConflicts(db, shopId, page)` and
`readDeliveryConflict(db, shopId, interactionId, offset)` in
`src/lib/delivery-reconciliation.ts`. Each returns `{ state: 'ok', … }` or
`{ state: 'unavailable' }`. A refused or malformed read is never an empty "all
clear".

`Conflict` (`deliveryConflictsSchema` / `DeliveryConflict`):

| Field | Type | Meaning |
| --- | --- | --- |
| `interaction_id` | uuid | The outbound text |
| `occurred_at` | timestamptz | When it was recorded |
| `customer_id`, `customer_name` | uuid, text, or null | Customer, when bound |
| `body` | text or null | First 2,000 characters of the text |
| `action_id` | uuid or null | The approval it came from, when there was one |
| `delivery_state` | `'conflicting'` | Always. **Never show it as Delivered or Failed alone** |
| `recorded_status`, `recorded_error_code` | text or null | The first terminal outcome |
| `conflict_status`, `conflict_error_code`, `conflict_received_at` | text or null | The contradicting outcome |
| `review_revision` | int | Number of reviews so far |
| `latest_outcome` | `'delivered' \| 'not_delivered' \| 'unknown'` or null | The latest review's assessment |
| `resolution_state` | `'unresolved' \| 'resolved'` | `resolved` only when the latest review covered **this** conflict (same `conflict_status` and `conflict_received_at`). A newer conflicting callback makes it `unresolved` again |

Labels: `conflictResolutionStates`
(`unresolved`: "Conflicting results, not yet reviewed"; `resolved`: "Conflicting
results, reviewed"). For outcomes, reuse `deliveryOutcomes`.

For any other place that shows an outbound text's delivery (for example the
interaction timeline), use `smsDeliveryState(metadata)` from
`src/lib/twilio-delivery-status.ts`. It returns `state: 'conflicting'` with both
outcomes whenever a conflict is recorded.
**Today `interaction-timeline.tsx` shows "Delivered" for a conflicted text, and
needs to switch to this helper.**

## Write (server action)

`recordDeliveryConflictResolution(input)` in
`src/app/actions/delivery-reconciliation.ts`. Its input is validated by
`conflictResolutionCommandSchema`:

| Field | Type | Notes |
| --- | --- | --- |
| `shopId` | uuid | |
| `interactionId` | uuid | |
| `commandId` | uuid | A new UUID per submission. Retrying the same command returns success once, never twice |
| `revision` | int | The `review_revision` you read |
| `conflictReceivedAt` | string | The `conflict_received_at` you read |
| `outcome` | `'delivered' \| 'not_delivered' \| 'unknown'` | The reviewer's assessment |
| `note` | 10–2,000 characters | Their reason and evidence. Same rules as delivery reconciliation |

It returns `{ ok: true, message }` or `{ ok: false, message }` (plain owner
copy). The RPC is `record_delivery_conflict_resolution`. It is refused with
`PT409` when the review history or the conflict changed since the read, and
with `42501` without authority.

A resolution is **evidence only**. It is stored append-only in
`delivery_conflict_resolutions` with the actor, their role, the shop, the
message, a copy of the outcomes they reviewed, the outcome they chose and their
note. It doesn't change the message's delivery metadata, resend, release
sending authority or clear any hold.
