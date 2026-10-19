# Twilio registration recovery, account isolation, and the real-provider checklist

October 19, 2026. Claude review for the release lane.

**Code reviewed.** `origin/main` at `5a64eec`, which includes #79 to #84, plus
the four open Twilio PRs: #87 (subaccount per business), #88 (resumable A2P),
#93 (own-number attestation) and #89 (channel readiness). They are combined on
`claude/twilio-review-oct19`. The merges were clean, except for the work log
and one documentation section, which kept both sides.

**Scope.** This is a review only. Nothing was fixed in these PRs, no provider
was called, no message was sent, no shared migration was applied, and no
writes were unfrozen.

Each finding below was reproduced against real Postgres on the disposable
stack, with Twilio faked at the module boundary, or read directly from the
cited code. The probe file is kept outside the repository, in the shared
session notes, as `twilio-review-probes-oct19.int.test.ts`.

## Verdict

- **Account isolation holds for sends and for every signed callback.** One gap
  remains: the pilot-account fallback combined with free-form number entry
  (I1). It doesn't let anyone send as another business.
- **Registration recovery works for the sequential cases that #88 and #87
  test.** It does **not** hold under concurrency or lost responses (R1 to R3),
  and it stops watching after approval (R4). Those can create billed duplicate
  Twilio resources or leave texting open after a campaign is suspended. Fix
  them before a real registration, or run the live test strictly one step at a
  time (see the checklist).
- **Brand and campaign progress isn't pushed to Gradia** (R6). It moves only
  when someone clicks Check status.

## Account isolation

| # | Area | Finding | Evidence | Severity |
| --- | --- | --- | --- | --- |
| I0 | Outbound sends | Every customer text goes through `smsGateForShop` (`outbound-sms.ts`, `approvals.ts`, `roi-receipt`). The only ungated send is `alerts.ts`, Gradia's own ops alert to a configured number. A non-Gradia number opens only with #93's attestation, which needs the shop's own credentials, so the send uses them and Twilio refuses a `From` they don't own. **Holds.** #93's own-account rule carries this; don't relax it | Code read; #93's `not_own_account` integration test | — |
| I1 | Inbound, pilot fallback | `saveTwilioNumber` (`shop.ts`) and the shops owner row policy let an owner record **any** E.164 number, with no ownership check. A shop without its own credentials then verifies inbound signatures with Gradia's **pilot env account** (`resolveTwilioCredentials` step 3). Suppose a number on the master account isn't stored on any shop, for example a pilot number or one released from a shop. An owner who claims it receives that number's inbound texts and drafts. The unique index stops claiming a number another shop already holds, but it also lets someone squat a number before a buyer persists it (the buyer's purchase then rolls back) | `src/lib/twilio.ts:111`, `src/app/actions/shop.ts:274`, `src/app/api/twilio/sms/route.ts:130` | **High before any shared pilot or production number exists on the master account.** Fix: scope the env fallback to an explicit pilot allowlist, and make `twilio_phone_number` server-written only (guard like #93's), or verify ownership through the number's account |
| I2 | Status callbacks | The `?shop=` parameter is inside the signed URL. Verification uses that shop's credentials, and the update is scoped to that shop. An unknown shop is refused. **Holds** | `sms/status/route.ts` | — |
| I3 | A2P callbacks | The shop comes from the signed URL, and the signature is checked with that shop's own **subaccount** token, so another account's signature fails. **Holds.** It returns 404 for an unknown shop and 401 for a bad signature, which leaks whether a shop id exists. Low | `a2p/status/route.ts` | Low |
| I4 | Subaccount ownership | One SID can't belong to two shops (unique index, migration 96). A stored SID named for another shop is refused. Concurrent creation closes the loser's subaccount (#87's tests). **Holds** | `twilio-subaccount.int.test.ts` (7 tests) | — |
| I5 | Delivery status ordering | A late `sent` callback overwrites `delivered`. The update is last-write-wins and nothing ranks the states. **Reproduced (R5).** This was on main before these PRs | Probe R5 | Medium. It makes a delivered message read as not delivered. Fix: rank `queued < sent < delivered/undelivered/failed` and never move back |

## Registration recovery (#88, plus #87's purchase)

| # | Finding | Evidence | Real cost if hit |
| --- | --- | --- | --- |
| R1 | **Double submit creates two customer profiles and two brands.** `startA2pRegistration` has no claim: both calls upsert `draft` and run the whole chain | Probe R1: `profile` and `brand` each called twice | Two TrustHub profiles and **two brand registrations** for one business, each billed, with possible duplicate-brand vetting issues |
| R2 | **Two concurrent status checks after brand approval create two messaging services and two campaigns.** Checkpoints are unconditional (`a2pUpdate` has no status compare-and-swap) | Probe R2 | **Two campaign submissions**. Creating a `Usa2p` campaign "submits the Campaign for review and incurs fees" (Twilio Usa2p docs). One messaging service is orphaned |
| R3 | **A campaign created at Twilio whose response is lost is created again on the next check.** There's no lookup of an existing campaign on the messaging service before creating one | Probe R3 | A second campaign fee, or Twilio refuses the second create and registration stalls with a retryable error |
| R4 | **After approval nothing is re-checked.** `syncA2pStatus` has no branch for `approved`, and `getCampaignStatus` maps anything that isn't VERIFIED or FAILED (including SUSPENDED) to PENDING. A suspended or revoked campaign leaves `a2p_status = approved` and the SMS gate open | Probe R4; `twilio-a2p.ts:437` | Texts keep going out after carriers suspend the campaign. That's a compliance risk |
| R5 | Rejected campaign resubmission creates a **new** campaign (`campaign_sid` cleared, then `createCampaign`). Twilio's guidance is to **edit and resubmit the failed campaign**: the vetting fee is charged once per campaign. Delete and recreate only when the use case is wrong or the brand is at fault | Code read; Twilio error docs 30901, 30899 and 30909 | Another vetting fee per resubmission, and the new create may be refused while the failed campaign is still attached |
| R6 | **Brand and campaign status isn't pushed.** `StatusCallback` is set only on the TrustHub customer profile and trust products. Brand and campaign creation pass none. No cron calls `syncA2pStatus` (`vercel.json`). Progress after brand submission happens only when the owner clicks Check status | `twilio-a2p.ts` (callbacks at 122, 203, 244 and 273 only); `vercel.json` | Registration silently stalls. The handoff copy "We'll update this page when its status changes" would be false. Fix: a held, release-gated sync cron, or Twilio Event Streams |
| R7 | `a2p_registrations.status` and `shops.a2p_status` are written in two separate statements. A crash between them leaves the registration `approved` but the shop `pending`, and R4 means nothing reconciles it. That fails closed (texts held), but it never recovers on its own | Code read (`telephony-provider.ts:592–593`) | Owner stuck as "pending" after approval |
| R8 | **Number purchase isn't single-flight.** `purchaseNumber` checks `shop.gradia_number_e164` from a stale snapshot. Its final write isn't conditional (`.eq("id")` only), so concurrent purchases provision two numbers and the second write overwrites the first. That strands a paid number with Gradia webhooks, and `number_monthly` is metered twice. A provisioning response lost in transit also strands a number, because nothing lists the subaccount's numbers before buying | Code read (`telephony-provider.ts:239, 268–279`); not probed | A monthly number fee per stranded number, and a number routed to Gradia that belongs to no shop. This feeds I1 if it's on the master account |
| R9 | Each customer-profile and trust-product step makes several provider calls (create, add entities, evaluate, submit). Only the final SID is checkpointed, so a failure partway leaves a half-built bundle that a resume doesn't reuse | Code read (`twilio-a2p.ts`) | Orphaned draft TrustHub bundles. They're unbilled but clutter the account |

**What #87 and #88 do prove, with fakes.** These pass on the combined code:

- sequential resume after a temporary failure, without a second profile;
- refusal classification (400 versus temporary);
- a rejected brand starting fresh;
- a campaign-only rejection keeping the brand;
- a subaccount created once, adopted after a lost save, closed when a
  concurrent duplicate loses, refused when it belongs to another shop, and
  unique per business.

## Recommended fixes, smallest first (each its own PR, held from activation)

1. **R1 and R2.** Claim the registration with a compare-and-swap before any
   provider call, for example `attempts` or `status` as an optimistic lock, and
   make every checkpoint conditional on the state it read.
2. **R3 and R5.** Before creating a campaign, read the messaging service's
   existing `Usa2p`. Adopt it if present, and *update* it on resubmission
   instead of creating a new one.
3. **R4 and R7.** Keep polling approved registrations. Map
   SUSPENDED/IN_PROGRESS explicitly. Close the SMS gate on anything that isn't
   VERIFIED. Write both statuses in one transaction (an RPC).
4. **R8.** Make the purchase single-flight. Write the number only if none is
   stored, and before buying, list the subaccount's numbers to adopt one whose
   save failed.
5. **I1.** Scope the pilot env fallback with an explicit allowlist. Make
   `twilio_phone_number` server-written only.
6. **I5.** Rank delivery statuses.
7. **R6.** Add a held status-sync cron, or Event Streams, with the release lane
   deciding activation.

## Migrations (from the October 17 integration work)

Run `scripts/preflight-oct17-migrations.sql`, which is read-only, against the
target database before applying 96 to 98:

- **Blocks:** two shops sharing a subaccount SID (migration 96 would fail and
  change nothing), and objects that exist without their ledger row.
- **Needs a decision:** `byo_sms_verified = true` without the shop's own
  credentials. Recommend clearing these before deploy, because otherwise those
  numbers keep texting open with no attestation record (see #93).

`scripts/verify-oct17-upgrade.sh` proves the refusal, reconciliation and
completion path on the disposable stack. Migration 95 (#83) is already on main.

## Real-provider test checklist

Run this only after the release lane approves each step. It uses a dedicated
test business, a Twilio test or staging parent account, and synthetic
recipients the team owns. Never use a customer's number, and never run against
production data.

The **Fake-tested** column says what the repository's tests already prove with
Twilio faked. **Needs real verification** is what only a live provider can
show.

### 0. Prerequisites (founder or ops, through secure configuration, never in chat or Git)

- [ ] The Twilio parent account is set up to operate as an ISV, and Gradia's
  primary customer profile is **approved**.
- [ ] `TWILIO_PRIMARY_PROFILE_SID` is set in the target environment.
- [ ] Gradia's website, support contact, privacy policy and terms are live.
  The test business has its own legal identity, use case and opt-in method;
  never Gradia's brand for a customer.
- [ ] The hard-coded TrustHub policy SIDs (secondary profile, A2P trust,
  sole-proprietor trust) are checked against current Twilio docs.
- [ ] `GRADIA_DASHBOARD_URL` is the exact public origin Twilio will call.
  Signatures cover the full URL.
- [ ] Preflight shows no blocks, and the `decide` rows have a recorded
  decision.
- [ ] A spending alert is set on the test parent account. Brand and campaign
  fees are real.

### 1. Subaccount and number (#87)

| Step | Fake-tested | Needs real verification |
| --- | --- | --- |
| First purchase creates one subaccount named for the shop | Yes | The subaccount appears under the parent with the shop id as FriendlyName. Its token works |
| Number is bought under the subaccount with Gradia's webhooks | No (purchase is faked) | The number shows on the **subaccount**, not the parent. The SMS URL and status callback are Gradia's. Usage is attributed to the subaccount |
| Search doesn't create a subaccount | Yes (code path) | Abandon the wizard after searching; no new subaccount exists |
| Double-clicking Buy | **No; R8 is open** | Don't test until R8 is fixed. If tested, expect two numbers |
| Release, then re-buy | No | The released number leaves the subaccount. The shop row is cleared. Nothing keeps routing to Gradia |

### 2. Inbound and isolation

| Step | Fake-tested | Needs real verification |
| --- | --- | --- |
| Inbound text to the test number reaches only that shop | Signature and replay logic are unit and integration tested | Text from a team phone; one interaction appears on the right shop, none on others. A redelivery is suppressed |
| A subaccount-signed request fails for another shop | Yes (I2, I3, I4) | Replay a captured, signed callback against another shop's `?shop=`. Expect 401 |
| A free-form number doesn't receive another account's traffic | **No; I1 is open** | Don't put pilot numbers on the master account while I1 is open |
| STOP, START and HELP | Integration tests | STOP from the team phone records the opt-out. A queued message to that phone is then held. Twilio's own STOP handling doesn't conflict |

### 3. A2P registration (#88), one step at a time, never concurrently, until R1 to R3 are fixed

| Step | Fake-tested | Needs real verification |
| --- | --- | --- |
| Submit (EIN path): profile, trust product, brand | Yes, sequential | Each TrustHub bundle reaches `in-review` or `twilio-approved`. The brand is created under the **subaccount**. TrustHub callbacks reach `/api/twilio/a2p/status` and **pass signature verification**. Confirm the body encoding Twilio uses matches `verifyTwilioSignature` (form-encoded) |
| Sole-proprietor path, including the verification text | Partly (OTP resend is faked) | The verification text reaches the owner's mobile. Brand approval follows |
| Temporary failure, then resume | Yes | Hard to force live. Rely on the fakes. Don't create failures by hand |
| Brand approved, then messaging service and campaign | Yes, sequential | **Click Check status once and wait for it to finish (R2).** One messaging service and one campaign exist. Inbound on the service still points at Gradia |
| Status updates arrive without clicking | **No; R6 is open** | Expect no brand or campaign callbacks. Record how long each stage took |
| Campaign verified, then number attached and texting opened | Yes | The number is in the messaging service. `a2p_status` and `shops.a2p_status` are both `approved` (R7). Channel readiness shows texting "Ready" only after this |
| Brand rejected, then fix and resubmit | Yes | Only with real rejection data. Don't force a rejection |
| Campaign rejected, then resubmit | Yes, but against the **wrong behavior (R5)** | **Don't test live until R5 is fixed.** It would create a second campaign and fee |
| Campaign suspended after approval | **No; R4 is open** | Not testable safely. Texting would stay open |

### 4. First real send (only after the release lane unfreezes, and only to a team phone)

| Step | Fake-tested | Needs real verification |
| --- | --- | --- |
| Gate: a Gradia number needs A2P approval; an own number needs attestation plus own credentials | Yes (unit and integration, #93) | Before approval, a send is held with the gate message. After approval, one text arrives |
| Approval: one send per action under retry | Yes (approvals, delivery suites) | Approve once, retry the click, and see exactly one message in Twilio's log |
| Delivery status | Partly; **I5 is open** | Twilio's log shows `delivered` while Gradia may show `sent` if callbacks arrive out of order. Compare both |
| Quiet hours, consent, DNC and suppression | Yes | Spot-check one held case live, with nothing sent |

### 5. Own number (#93, advanced path)

| Step | Fake-tested | Needs real verification |
| --- | --- | --- |
| Attest on own credentials; refused without them | Yes (8 integration tests) | Use a team-owned Twilio account with an approved campaign. After attestation, a test send goes through **that** account (check its log, not Gradia's) |
| Changing credentials clears it | Yes | Re-save credentials; status returns to "Needs your details" |

### 6. Voice (not reviewed in this pass)

- Calls readiness (#89) is separate from SMS approval.
- Before any voice test, verify the following against current Vapi and Twilio
  docs:
  - number import and routing;
  - webhook authentication;
  - transfer and fallback;
  - test-call acceptance.
- Forwarding calls doesn't establish texting ownership.

### Record for each live run

- Date, environment and operator.
- Twilio SIDs, recorded as the last four characters only.
- Each step's result, and the time from submission to each state change.
- Any fee incurred.
- Anything that differed from the fake-tested expectation.
- Store it with the release notes, not in chat.
