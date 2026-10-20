# Own-number (BYO) texting: owner attestation

October 15, 2026. Migration `20261015150000_byo_sms_attestation.sql`,
`src/lib/byo-sms-attestation.ts` and the server actions in
`src/app/actions/byo-sms-attestation.ts`.

## Why

`shops.byo_sms_verified` gates every text sent from a number that isn't the
shop's Gradia number. It's checked in `smsGateForShop` at send, and mirrored in
`stage_qualification_question`. Until now nothing in the app wrote it, so every
text from an own number was held, and the gate pointed owners at a control that
didn't exist.

Gradia can't see an own number's carrier registration. The owner has to vouch
for it. This change gives them a narrow, recorded way to do that.

This follows `/Users/harryhatch/Gradia/ONBOARDING_AND_BUSINESS_UX_HANDOFF.md`
(founder request, October 15). Under it:

- The normal path is a Gradia-managed subaccount, with the A2P registration
  made in the customer's own business details. Bring-your-own Twilio is an
  advanced option.
- Readiness is never inferred from a checked setting alone.
- Sending fails closed when Gradia can't establish whose account and
  registration a number uses.

## What it guarantees

- **Owner only.** That means `shops.owner_id` with an active `owner` membership.
  Managers and staff are refused (`forbidden`) whatever their capabilities, and
  so are other shops' owners and anonymous callers. They can't read the state
  or the history either.
- **An explicit statement.** The owner must tick a fixed, versioned statement
  (`BYO_SMS_ATTESTATION_STATEMENT`, version `2026-10-16`). The action requires
  `confirm: true` and the current version. The database rejects any other
  version.
- **Own Twilio account only.** A number can be attested only when the shop has
  its own encrypted Twilio credentials, which is when `resolveTwilioCredentials`
  sends through them (`byo`). Otherwise a send from a non-Gradia number falls
  back to Gradia's pilot account (`env`), where the owner holds no
  registration. So the state is `not_own_account`, attesting is refused, and
  texts stay held. The database checks only that the credentials are present;
  it can't decrypt them or ask Twilio who owns the number.
- **One number on one account.** The owner attests the number they were shown. If the current
  number is different, the call is refused (`number_changed`). Changing
  `twilio_phone_number` afterwards, through any writer, clears the attestation
  and records a `cleared` / `number_changed` event.
- **Account changes clear it.** The attestation is cleared, with an
  `account_changed` event, when the account credential changes or either
  credential is removed. Re-saving credentials re-encrypts them, so it clears
  too and the owner confirms again. Rotating only the auth token doesn't clear
  it.
- **Gradia numbers are untouched.** The gate never consults the flag for the
  Gradia number. Attesting one is refused (`gradia_number`), and moving onto it
  clears any attestation.
- **Who and when.** Every attest, revoke and clear appends a row to
  `byo_sms_attestations`: event, source, number, actor, statement version and
  time. The table is append-only. Updates are refused, and clients can't
  insert, update or delete.
- **No shortcut.** A signed-in session can no longer set
  `shops.byo_sms_verified` directly through the shops owner RLS path, on update
  or insert (`42501`, `attestation_required`). Only the attestation functions
  can. Trusted server code using the service role isn't blocked; no app code
  writes the flag, and a unit test fails if any `src/` file starts referencing
  it.
- **Revocable.** The owner can withdraw the attestation at any time, and texts
  are held again at the next send.
- **Idempotent by state.** Attesting a confirmed number, or revoking an
  unconfirmed one, writes nothing and returns `already_attested` or
  `already_revoked`. Retrying after `uncertain` is safe.

Nothing here sends a text, calls a provider or changes consent. Quiet hours,
consent, STOP, DNC and suppression still apply at send.

**Confirmed isn't Ready.** A confirmed own number is "Ready to test" in the
handoff's status vocabulary. The attestation is the owner's word, and consent,
quiet hours and release gates still apply. `byoSmsSetupStatus(state)` returns
the label.

## Contract for the UI (Cursor)

The gate's message already says *Settings → Business Number*. The control
belongs in the Business number (SMS) settings card.

All three actions take the shop id as a selector only. PostgreSQL checks
authority.

```ts
getByoSmsAttestation({ shopId }): ByoSmsReadResult
attestByoSmsRegistration({ shopId, phoneE164, statementVersion, confirm: true }): ByoSmsAttestResult
revokeByoSmsRegistration({ shopId }): ByoSmsRevokeResult
```

The attestation state (`ByoSmsAttestationState`) is returned by every call:

| Field | Meaning |
| --- | --- |
| `state` | `no_number`: nothing to attest. `gradia_number`: the A2P gate applies; show no attestation control. `not_own_account`: the number isn't on the shop's own Twilio account, so it can't be attested and texts are held. Next action: get a Gradia number, or connect their own Twilio account (advanced). `unconfirmed`: texts from this number are held. `confirmed`: the owner attested this number on their own account. |
| `phone_e164` | The current sending number. Pass it back unchanged as `phoneE164`. |
| `current_statement_version` | Show `BYO_SMS_ATTESTATION_STATEMENT` and pass `BYO_SMS_ATTESTATION_STATEMENT_VERSION`. |
| `last_event` | The latest `attested`, `revoked` or `cleared` event, with number, actor user id, statement version and time, or `null`. A `cleared` event with source `number_changed` or `account_changed` means "your number or Twilio account changed, confirm again". |

Status labels, from `byoSmsSetupStatus`, in the handoff vocabulary:

| `state` | Label |
| --- | --- |
| `no_number` | Not set up |
| `not_own_account` | Needs your details |
| `unconfirmed` | Needs your details |
| `confirmed` | Ready to test, never Ready |
| `gradia_number` | None; use the A2P registration status |

Results:

| Result | What the UI should do |
| --- | --- |
| `ok: true`, `attested` / `already_attested` | Show confirmed for that number. |
| `ok: true`, `revoked` / `already_revoked` | Show unconfirmed. |
| `invalid` (`field`) | A form bug. `confirm` means the box wasn't ticked. `statementVersion` means a stale page, so reload. |
| `forbidden` | Hide the control. Managers and staff should see an owner-only note. |
| `number_changed` | Re-read and show the new number before asking again. |
| `no_number`, `gradia_number` | Re-read. There's nothing to attest. |
| `not_own_account` | Re-read. Offer the next action for `not_own_account`. |
| `not_confirmed` | The response didn't confirm. Re-read before claiming anything. |
| `uncertain` | Re-read. Retrying is safe. |

Copy rules:

- Never say the number is "verified by carriers" or "registered". Say the owner
  *confirmed* it.
- Keep it under an advanced "Connect my Twilio account" path, not the default
  setup.
- Don't claim texts were or will be delivered.

## Provider-verifiable check: considered, not built

For an own number on the shop's own Twilio account, a later check could confirm
that the number belongs to a Messaging Service with a verified US A2P campaign.
That would be one read-only lookup behind the existing telephony seam.

Twilio's current docs (checked October 16, *Troubleshooting and rectifying A2P
campaigns* and the ISV onboarding API guide) say a campaign is the Messaging
Service's UsAppToPerson resource. Its `campaign_status` is `IN_PROGRESS`,
`VERIFIED`, `FAILED` or, rarely, `SUSPENDED`, and a 10DLC number must be added
to that Messaging Service before it can send. It's
deferred for these reasons:

- **It needs live provider calls.** Those are out of scope for this change, and
  activating them belongs to the release lane.
- **It only covers some numbers.** Own numbers on other carriers, or numbers
  pasted onto Gradia's master account, can't be checked this way.
- **A passing check isn't proof.** It confirms the campaign exists, not that
  Gradia's texts fit it.

The `source` column leaves room for it: a future `provider_check` source can be
added to the check constraint without changing how owners attest.

## Limitations

- The attestation is the owner's word. Gradia doesn't verify it.
- Only the account owner can attest. A co-owner with an `owner` membership but
  not `shops.owner_id` is refused.
- Service-role code can still write the flag directly. No app code does, and
  the unit inventory test guards `src/`.
- Channel readiness is reconciled with #89: owner-attested numbers are at most
  Ready to test, and missing own-account credentials require attention.
- The TypeScript gate still checks only the flag. That stays safe because the
  database clears the flag whenever the account or credentials change. The SQL
  mirror in `stage_qualification_question` wasn't redefined, to avoid colliding
  with #83.
- Settings includes the owner confirmation/withdrawal control. Uncertain writes
  are re-read and never presented as definitely unsaved.
