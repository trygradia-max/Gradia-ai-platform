# Delivery and texting status: backend values for the UI (Cursor)

October 21, 2026. These are the actual states and the conditions behind them.
Labels and copy are Cursor's to write. Don't show a state the backend didn't
return. Don't treat a state as stronger than its condition.

Sources:

- `src/lib/twilio-delivery-status.ts`
- `src/lib/message-delivery-review.ts`
- `docs/architecture/DELIVERY_CONFLICT_REVIEW.md` (PR2)
- `src/lib/channel-readiness.ts`, with the #108 additions

## 1. One outbound text: `smsDeliveryState(interaction.metadata)`

| `state` | Condition | Must not be shown as |
| --- | --- | --- |
| `queued` | Twilio last reported `queued`, `accepted` or `scheduled` | Sent or delivered |
| `sent` | `sent` or `sending`: handed to the carrier, with no delivery receipt | Delivered |
| `delivered` | `delivered` or `read` | — |
| `failed` | `undelivered`, `failed` or `canceled`. `errorCode` is Twilio's code when given | A retryable error. Nothing resends it |
| `conflicting` | Twilio reported both a delivered and a failed outcome. Fields: `recorded` (first), `conflict`, `errorCode`, `conflictErrorCode` | Delivered or failed on its own. Show both, and link to the delivery review |
| `unknown` | No status, or a status Gradia doesn't know | Delivered |

Statuses only move forward. A late `sent` never replaces `delivered`.

A callback that arrives before the text is saved is kept (PR1) and applied when
the text is saved, so a text may show its final status right away.

**Fix needed in the UI:** `interaction-timeline.tsx` shows "Delivered" for a
conflicted text. Switch it to this helper.

## 2. One approved message: `readMessageDeliveryReview(db, shopId, actionId)`

| `state` | Condition |
| --- | --- |
| `unspent` | Not sent. Still pending, held or refused |
| `claimed` | A send started, but provider acceptance wasn't recorded: **uncertain**. It is never resent automatically. A person reconciles it on the existing delivery-review surface |
| `provider_accepted` | Twilio accepted it. Delivery is in section 1 |
| `unavailable` | The read failed or isn't permitted. **Not an all-clear** |

## 3. Conflict review (PR2): see `DELIVERY_CONFLICT_REVIEW.md` for the full contract

- **Reads:** `list_delivery_conflicts` and `read_delivery_conflict`, through
  the wrappers `readDeliveryConflicts` and `readDeliveryConflict`.
- **Write:** `recordDeliveryConflictResolution`.
- **Who:** the owner, or an active manager with `crm.read` and
  `delivery.reconcile`. A revoked member is refused (`42501`).
- **`delivery_state`:** always `conflicting`.
- **`resolution_state`:**
  - `unresolved`, until a review covers this exact conflict;
  - `resolved`, when one does. A newer conflicting callback makes it
    `unresolved` again.
- **`latest_outcome`:** `delivered`, `not_delivered`, `unknown`, or null.
- **A resolution is evidence only.** It never changes delivery metadata,
  resends, releases a hold or grants sending.

## 4. Texting readiness reasons, with #108

These are added to `channel-readiness.ts` (`texting`):

| Reason | State | Condition |
| --- | --- | --- |
| `registration_suspended` | `action_needed` | Carriers suspended the campaign after approval. The send gate is closed |
| `registration_check_overdue` | `action_needed` | Approved, but the last successful VERIFIED check is older than the evidence limit: 72 hours by default, 7 days at most (the founder's decision, October 21). The send gate is closed until a check succeeds. Showing "Check status" is accurate |

Unchanged, for reference:

- `registration_pending` (`in_progress`)
- `registration_rejected`
- `registration_required`
- `not_own_account`
- `byo_registration_unconfirmed`
- `byo_owner_attested` (`ready_to_test`)
- `no_number`

Removed: the backend's "(1–3 days)" promise in `smsGateForShop` (#108). Don't
reintroduce a time estimate. Provider review times aren't guaranteed.

## Not yet available

- **No automatic status checks.** The status reconciler (#109) is held behind
  `A2P_RECONCILER_ENABLED`, which is off, so status changes only on Check
  status.
- **No push from Twilio.** Brand and campaign status changes aren't sent by
  Twilio.
- **No delivery promise.** Nothing here promises delivery or a notification.
