# Channel readiness: calls, texting, email, Meta

October 15, 2026. `src/lib/channel-readiness.ts` (pure),
`src/lib/data/channel-readiness.ts` (loader) and the owner server action
`getChannelReadiness()` in `src/app/actions/channel-readiness.ts`.

Each channel gets its own state, derived from the evidence that actually gates it.
The older `connectionStatus()` reports one `connected` flag from credential
presence. It is unchanged, and existing screens still use it until the UI moves to
this contract (Cursor).

"Ready" is never a delivery or activation claim. Providers, crons and live sends
stay held by the release lane.

## States

| State | Meaning |
| --- | --- |
| `unavailable` | This deployment isn't configured for the channel (server env presence only) |
| `not_set_up` | The owner hasn't connected it |
| `in_progress` | Waiting on a third party, for example carrier review |
| `action_needed` | Something specific blocks it; `reasons` say what |
| `limited` | Works, with a named gap |
| `ready` | Every check this code can make passes |

Each channel returns `{ channel, state, reasons, message }`. `message` is
owner-facing text.

## Rules per channel

**Calls**

- `not_set_up`: no voice number, assistant or test call.
- `action_needed`, with each missing piece: `no_voice_number`, `no_assistant`,
  `no_test_call`, `voice_addon_inactive`.
- `ready`: all present and the Voice add-on is on. Same prerequisites as
  `voiceLaunchGate`, plus the add-on that gates calls at runtime.

**Texting**

- `not_set_up`: no number.
- **Gradia number:**
  - A2P `approved` → `ready`.
  - `pending` → `in_progress`.
  - `rejected` → `action_needed` (`registration_rejected`).
  - Not registered → `action_needed` (`registration_required`).
- **Own (BYO) number:** `ready` only with a confirmed carrier registration
  (`byo_sms_verified`). Otherwise `action_needed`
  (`byo_registration_unconfirmed`).
- These match `smsGateForShop`, which holds texts at send time.

**Email**

- `not_set_up`: no mailbox.
- `limited`: connected, but with no inbound subscription
  (`inbound_not_subscribed`). Gradia can send, but customer replies don't arrive.
- `ready`: connected and subscribed.

**Meta lead ads**

- `not_set_up`: no page bound to the shop.
- `limited`: a page is bound (`page_subscription_unverified`). Signed lead
  events for that page are routed to the shop, but Gradia can't yet confirm the
  page's webhook subscription with Meta. **Meta is never reported `ready`.**

## Known gaps, named rather than hidden

- **BYO texting can't be confirmed in the app.** Nothing in the app sets
  `byo_sms_verified`, so a BYO number stays `action_needed` and its texts are
  held. A Settings attestation, or a verified check, is a separate change.
- **A revoked mailbox grant isn't detected here.** It only surfaces when the
  token is next used, and no "reconnect" state is stored. Readiness can't see
  it without a provider call.
- **Meta's page subscription and lead-detail retrieval aren't verified yet.**
- **The UI hasn't switched over.** Moving screens from `connectionStatus()` to
  this contract is UI work for Cursor. `eval/channel-readiness.test.ts` lists
  the cases where the old flag said "connected" but the channel isn't ready.
