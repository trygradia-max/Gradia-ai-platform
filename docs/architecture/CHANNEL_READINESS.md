# Channel readiness: calls, texting, email, Meta

October 15, 2026. `src/lib/channel-readiness.ts` (pure),
`src/lib/data/channel-readiness.ts` (loader) and the owner server action
`getChannelReadiness()` in `src/app/actions/channel-readiness.ts`.

Each channel gets its own state, derived from the evidence that actually gates it.
The older `connectionStatus()` reports one `connected` flag from credential
presence. It is unchanged, and existing screens still use it until the UI moves to
this contract (Cursor).

"Ready" is never a delivery or activation claim. Providers, crons and live sends
stay held by the release lane. Following
`/Users/harryhatch/Gradia/ONBOARDING_AND_BUSINESS_UX_HANDOFF.md`, a checked
setting alone is never `ready`.

## States

| State | Meaning | Handoff status |
| --- | --- | --- |
| `unavailable` | This deployment isn't configured for the channel (server env presence only) | None. It's Gradia's to fix, not the owner's |
| `not_set_up` | The owner hasn't connected it | Not set up |
| `in_progress` | Waiting on a third party, for example carrier review | Submitted for review |
| `action_needed` | Something specific blocks it; `reasons` say what | Needs a correction for `registration_rejected`, otherwise Needs your details |
| `limited` | Works, with a named gap | Ready to test |
| `ready_to_test` | The gate passes only on the owner's word, which Gradia can't verify | Ready to test |
| `ready` | Every check this code can make passes | Ready |

Each channel returns `{ channel, state, reasons, message }`. `message` is
owner-facing text. `readinessStatusLabel(result)` returns the handoff status
from the table. "Paused" is never derived here.

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
- **Own (BYO) number:** never `ready`. The owner's attestation is a checked
  setting, not a check Gradia made. The rules follow
  `docs/architecture/BYO_SMS_ATTESTATION.md` (PR #93):
  - The shop doesn't have both of its own encrypted Twilio credentials
    (`twilio_account_sid_enc` and `twilio_auth_token_enc`) → `action_needed`
    (`not_own_account`). A send from this number would fall back to Gradia's
    pilot env account, where the owner holds no registration. This is checked
    before `byo_sms_verified`, so a flag set any other way never counts.
  - Own credentials, not attested → `action_needed`
    (`byo_registration_unconfirmed`).
  - Own credentials, attested (`byo_sms_verified`) → `ready_to_test`
    (`byo_owner_attested`). That's "Ready to test", the same as
    `byoSmsSetupStatus("confirmed")` in #93.
- The send gate is `smsGateForShop`. For a Gradia number, readiness matches it.
  For an own number, readiness is stricter: it also requires the shop's own
  account.

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

- **BYO texting is the owner's word.** PR #93 adds the only writer of
  `byo_sms_verified`, an owner-only attestation allowed only on the shop's own
  Twilio credentials. Readiness reports it as `ready_to_test` at most. A
  provider-verified check of the number's campaign isn't built. Until #93
  merges, nothing in the app sets the flag.
- **Credential presence, not ownership.** Readiness, like #93's database check,
  sees only that both encrypted credentials are present. It doesn't decrypt
  them or ask Twilio who owns the number. If they can't be decrypted at send
  time, `resolveTwilioCredentials` falls back to the env account while
  `smsGateForShop` still checks only the flag. That send-path gap isn't fixed
  here.
- **A Gradia number's A2P approval still reports `ready`.** The handoff says
  approval alone isn't proof of readiness while consent or release gates
  remain held. Those gates aren't in this module.
- **A revoked mailbox grant isn't detected here.** It only surfaces when the
  token is next used, and no "reconnect" state is stored. Readiness can't see
  it without a provider call.
- **Meta's page subscription and lead-detail retrieval aren't verified yet.**
- **The UI hasn't switched over.** Moving screens from `connectionStatus()` to
  this contract is UI work for Cursor. `eval/channel-readiness.test.ts` lists
  the cases where the old flag said "connected" but the channel isn't ready.
