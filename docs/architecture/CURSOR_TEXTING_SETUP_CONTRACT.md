# Texting and channel setup: the one contract for the UI

October 17, 2026. For Cursor. This covers the combined result of PRs #88 (A2P
resume and rejection), #89 (independent channel readiness) and #93 (own-number
attestation), as integrated on `claude/integration-oct17`.

Use only the actions and types below. Don't infer readiness from:

- a credential;
- a purchased number;
- a checked setting;
- `a2p_status` alone.

That rule comes from the founder's onboarding handoff
(`ONBOARDING_AND_BUSINESS_UX_HANDOFF.md`). The detailed backend rules live in
`CHANNEL_PROVIDERS.md`, `CHANNEL_READINESS.md` and `BYO_SMS_ATTESTATION.md`.
Where those differ from this page, this page is the UI contract, and the
difference is a bug to report.

Nothing here sends a message, buys a number or activates a provider. Every
action is owner only.

## 1. Channel status cards (#89)

```ts
// src/app/actions/channel-readiness.ts
getChannelReadiness(): Promise<
  | { ok: true; channels: Record<"calls" | "texting" | "email" | "meta", ChannelReadiness> }
  | { ok: false; error: string }
>

// src/lib/channel-readiness.ts
type ChannelReadiness = { channel: ChannelKey; state: ReadinessState; reasons: ReadinessReason[]; message: string }
type ReadinessState = "unavailable" | "not_set_up" | "in_progress" | "action_needed" | "limited" | "ready_to_test" | "ready"
readinessStatusLabel(r): "Not set up" | "Needs your details" | "Submitted for review" | "Needs a correction" | "Ready to test" | "Ready" | null
```

- **One card per channel, each independent.** A pending SMS registration never
  blocks the calls, email or Meta cards.
- **Status labels.** Show `readinessStatusLabel(r)` as the status and
  `r.message` as the explanation.
- **`unavailable`.** The label is `null`: Gradia hasn't configured this
  deployment, and there's nothing for the owner to do. Show "Not available
  yet" and no button.
- **No made-up labels.** Never show "Ready" unless `state === "ready"`.
  "Paused" is never derived; don't invent it.
- **Failed reads.** `ok: false` means the read failed. Show an error and a
  retry, never "Not set up".

Texting `reasons` and the next action for each:

| Reason | State | Next action (button) |
| --- | --- | --- |
| `no_number` | not_set_up | Choose a number |
| `registration_required` | action_needed | Open the registration wizard (§2), `nextAction: "submit"` |
| `registration_pending` | in_progress | None. Optionally "Check status" (§2) |
| `registration_rejected` | action_needed | Wizard, `nextAction` `fix_and_resubmit` or `resubmit_campaign` |
| `not_own_account` | action_needed | "Get a Gradia number", or advanced "Connect my Twilio account" |
| `byo_registration_unconfirmed` | action_needed | Own-number confirmation (§3) |
| `byo_owner_attested` | ready_to_test | "Send a test" (when that exists). Advanced: withdraw (§3) |

## 2. Gradia-number registration wizard (#88)

```ts
// src/app/actions/a2p.ts
getA2pState(): Promise<A2pState>          // no vendor calls
refreshA2pStatus(): Promise<A2pState>     // the "Check status" button; calls the provider seam (held in release)
submitA2pRegistration(input: A2pFormInput): Promise<{ ok: true } | { ok: false; error: string }>
resendA2pOtp(): Promise<{ ok: true } | { ok: false; error: string }>   // sole-proprietor verification text

type A2pState = {
  status: "none" | "draft" | "brand_pending" | "campaign_pending" | "approved" | "rejected"
  failureReason: string | null
  business: A2pBusinessDetails | null      // prefill; preserve on error
  registration?: A2pRegistrationState      // drive the UI from this
}
// src/lib/a2p-state.ts
type A2pRegistrationState = {
  status; nextAction: "submit" | "resume" | "fix_and_resubmit" | "resubmit_campaign" | "wait" | "none"
  failedStep: "profile" | "trust_product" | "brand" | "messaging_service" | "campaign" | "attach_number" | null
  retryable: boolean | null; failureReason: string | null; attempts: number
}
```

| `nextAction` | Show | Button |
| --- | --- | --- |
| `submit` | Empty or prefilled form | Submit for texting approval |
| `resume` | "Your submission stopped partway, and nothing needs changing." Keep the details | Continue submission. It resubmits the **same** details; completed steps aren't repeated |
| `fix_and_resubmit` | `failureReason` and the editable form | Submit corrected details |
| `resubmit_campaign` | "Your business was approved; carriers asked for changes to how you'll text." | Resubmit texting details. The brand is kept |
| `wait` | "Submitted for review. We'll update this page when its status changes. You can keep setting up other channels." | Check status |
| `none` | Approved. Texting readiness still comes from §1 | None |

- **No timing promises.** Don't use the old "usually 1–3 days" or "Calls work
  the whole time" copy, and don't promise any review time.
- **Unknown isn't Ready.** When `refreshA2pStatus` can't reach the provider,
  the result is unknown, not Ready.
- **Owner-reviewed facts only.** The owner must review every fact. Never
  prefill a tax ID, a website, a privacy policy or consent evidence the owner
  didn't enter.
- **The `registration` field.** It's optional only because `refreshA2pStatus`
  returns early without it when there's no shop. If it's absent, treat the
  state as unknown and offer reload.

## 3. Own-number confirmation (#93, advanced path only)

Shown only when texting `reasons` includes `byo_registration_unconfirmed` or
`byo_owner_attested`. It sits under the advanced "Connect my Twilio account"
path, never the default setup.

```ts
// src/app/actions/byo-sms-attestation.ts — shopId is a selector; the database checks owner authority
getByoSmsAttestation({ shopId }): Promise<ByoSmsReadResult>
attestByoSmsRegistration({ shopId, phoneE164, statementVersion, confirm: true }): Promise<ByoSmsAttestResult>
revokeByoSmsRegistration({ shopId }): Promise<ByoSmsRevokeResult>

// src/lib/byo-sms-attestation.ts
BYO_SMS_ATTESTATION_STATEMENT          // show verbatim beside an unticked checkbox
BYO_SMS_ATTESTATION_STATEMENT_VERSION  // pass back as statementVersion
type ByoSmsAttestationState = {
  state: "no_number" | "gradia_number" | "not_own_account" | "unconfirmed" | "confirmed"
  phone_e164: string | null            // pass back unchanged as phoneE164
  current_statement_version: string
  last_event: { event: "attested" | "revoked" | "cleared"; source: "owner_attestation" | "owner_revocation" | "number_changed" | "account_changed";
                phone_e164: string | null; actor_user_id: string | null; statement_version: string | null; created_at: string } | null
}
```

Results:

| Result | UI |
| --- | --- |
| `ok: true`, `attested` / `already_attested` | "You confirmed this number's registration." Status: Ready to test |
| `ok: true`, `revoked` / `already_revoked` | Back to unconfirmed. Texts are held |
| `invalid`, `field: "confirm"` | The box wasn't ticked |
| `invalid`, `field: "statementVersion"` | Stale page. Reload |
| `forbidden` | Managers and staff see an owner-only note. No controls |
| `number_changed` | Re-read, and show the new number before asking again |
| `not_own_account`, `no_number`, `gradia_number` | Re-read. Show the §1 next action instead |
| `not_confirmed`, `uncertain` | Re-read before claiming anything. Retrying is safe |

- **`cleared` events.** When `last_event.event === "cleared"`, explain it: the
  number or the Twilio account changed, so confirm again.
- **Wording.** Say the owner *confirmed* the number. Never say "verified" or
  "registered by carriers".

## Known inconsistencies, so they aren't guessed around

- **Shop selection differs.** §1 and §2 resolve the owner's active shop on the
  server. §3 takes `shopId`, so pass the same active shop id the Settings page
  already uses. Don't let a user choose it.
- **Email `limited` shows "Ready to test".** That's #89's mapping: Gradia can
  send, but replies don't arrive. Keep `r.message` visible so the owner sees
  the gap.
- **A2P status labels.** §2's `status` and §1's texting state come from
  different fields. Always use §1 for the card's status label, and §2 only
  inside the wizard.

## Tests Cursor should cover

- Owner sees the controls. Manager and staff see the owner-only note with no
  controls.
- Refresh mid-flow, and an interrupted submission (`resume`).
- Pending (`wait`), a brand rejection (`fix_and_resubmit`), and a
  campaign-only rejection (`resubmit_campaign`).
- `not_own_account`, and confirm, withdraw, then `cleared` after a number
  change.
- A failed readiness read.
- An unavailable channel.
- Keyboard, zoom and mobile layouts.
