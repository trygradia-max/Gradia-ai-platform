# Channel provider accounts and readiness

The backend contracts for the provider accounts behind Gradia's customer channels.
This document describes code, not activation: providers, crons and live sends stay
held until the release lane accepts each channel.

## One Twilio subaccount per business

October 15, 2026. Migration 96 and `ensureSubaccount` in
`src/lib/telephony-provider.ts`.

Each business that buys a Gradia number gets exactly one Twilio subaccount, and a
subaccount belongs to exactly one business.

- **When it's created:** on the first number purchase, never at signup or number
  search. The subaccount's FriendlyName is the shop id.
- **A stored SID is never replaced.** If its token no longer decrypts, for
  example after key rotation, the token is fetched again from Twilio for the same
  SID. That only happens if the subaccount is active and named for this shop.
  Otherwise the purchase stops with "needs attention", and no new subaccount is
  created, so the shop's number is never stranded.
- **Orphans are adopted.** If Twilio created a subaccount but Gradia failed to
  save it, the next attempt finds it by name and adopts it. Two active
  subaccounts named for one shop stop the purchase for reconciliation; nothing
  more is created.
- **Concurrent purchases.** The SID is saved only if none is stored. The first
  save wins. Every other attempt closes the duplicate it just created, which has
  no numbers yet, and returns the winner's credentials.
- **One shop per subaccount.** The partial unique index
  `shops_twilio_subaccount_sid_unique` refuses the same SID on two shops.
- **Not changed:** number purchase (still one number per shop), release
  (subaccounts are not closed when a number is released), BYO credentials and
  credential resolution.

Verified by `eval/integration/twilio-subaccount.int.test.ts` against a fake Twilio
Accounts API.

**Release note:** migration 96 fails, changing nothing, if two shops already share
a SID. Reconcile those shops first.
## Resumable SMS (A2P 10DLC) registration

October 15, 2026. Migration 97, `startA2pRegistration` and `syncA2pStatus` in
`src/lib/telephony-provider.ts`, and `describeA2pRegistration` in
`src/lib/a2p-state.ts`.

Carrier registration runs these provider steps in order:

1. customer profile;
2. A2P trust product (EIN path only);
3. brand;
4. messaging service;
5. campaign;
6. attach number.

The first three run on submit. The rest run on status checks, through the status
webhook or the "Check status" button.

**Checkpoints and resume**

- Each step's SID is saved as soon as Twilio returns it.
- After a temporary failure, submitting the **same** details continues after the
  last finished step. No second profile, trust product or brand is created.
- The messaging service is created once and reused if the campaign step fails.
- An attach whose result was lost is retried. "Already attached" counts as done.

**Single-flight** (October 19, migration
`20261019120000_a2p_registration_claim.sql`; review findings R1, R2)

- Before any provider call, submit and status check take the registration's
  claim with a compare-and-swap (`a2p_claim_registration`). A caller that can't
  take it makes no provider call: a second submit is told a submission is
  already in progress, and a second status check reports the stored status.
- Every checkpoint is written only while the claim is held.
- `a2p_finish_registration` releases the claim and, in the same transaction,
  writes the registration status and `shops.a2p_status`.
- The lease is 15 minutes, longer than any server function runs, so a crashed
  holder only delays the next attempt. Both functions are executable by
  `service_role` only.

**Campaigns are never created twice** (findings R3, R5)

- Before creating a campaign, the status check lists the campaigns already on
  the messaging service. One found there (a create whose response was lost) is
  adopted. Only when none exists is a campaign created; creating one submits it
  for review and incurs fees.
- A campaign-only rejection keeps the failed campaign. The next status check
  **edits it in place**, which resubmits it (Twilio errors 30899, 30901, 30909:
  the vetting fee is charged once per campaign). The update sends all seven
  required fields. If Twilio refuses the edit (campaign edit via API is a Twilio
  beta), the refusal is recorded and no new campaign is created.

**Approved registrations keep being checked** (findings R4, R7; migration
`20261019140000_a2p_campaign_suspended.sql`)

Every status check re-reads the campaign of an `approved` or `suspended`
registration. Twilio's `campaign_status` is mapped explicitly:

| `campaign_status` | Registration | `shops.a2p_status` (gate) |
| --- | --- | --- |
| `VERIFIED` | `approved` | `approved` (open) |
| `SUSPENDED` | `suspended` | `suspended` (closed) |
| `FAILED` | `rejected` | `rejected` (closed) |
| `IN_PROGRESS`, `PENDING`, anything else | `campaign_pending` | `pending` (closed) |

- Both statuses are written in one transaction. A verified check also rewrites
  the gate, which repairs a shop left `pending` by the old two-statement write.
- A suspended registration can't be resubmitted. It reopens only when the
  campaign reads `VERIFIED` again.
- A temporary error while re-checking an approved registration is recorded and
  leaves the gate as it was.
- Checks still happen only on the status webhook or "Check status". No cron was
  added (R6); a suspension is noticed on the next check.

**What a resubmission does**

| Situation | Effect |
| --- | --- |
| With carriers (`brand_pending`, `campaign_pending`), `approved` or `suspended` | Refused. Nothing is created |
| Another submit holds the claim | Refused as already in progress. Nothing is created |
| `draft` with a recorded failure, same details | Resume |
| Changed details, or a rejected brand | Fresh chain. TrustHub bundles can't change once reviewed |
| Rejected campaign, same details | The approved brand, messaging service and failed campaign are kept. The next status check edits and resubmits that campaign |

**Failure fields** (migration 97):

- `failed_step`: one of the six steps above.
- `retryable`:
  - `false` means Twilio refused the submitted details (HTTP 400), or carriers
    rejected the brand or campaign. The owner must change something.
  - `true` means a temporary problem: Twilio outage, network, or a failed save.
    Retrying the same details can work. During status checks, temporary
    failures are retried automatically on the next check.
- `failure_reason`: the owner-facing text. Twilio's message for refusals; a
  generic "temporary problem" otherwise.
- `attempts`, `last_attempt_at`.

A failure on submit leaves the row in `draft`. It is never half-registered, and
`shops.a2p_status` stays as it was. A stage is reported as advanced only once it
is saved.

**UI contract**

`getA2pState()` and `refreshA2pStatus()` return `registration`, with:

- `status`;
- `nextAction`;
- `failedStep`;
- `retryable`;
- `failureReason`;
- `attempts`.

| `nextAction` | Meaning | Screen |
| --- | --- | --- |
| `submit` | Nothing submitted yet | Show the form |
| `resume` | Stopped on a temporary problem | "Try again". Same details; finished steps are kept |
| `fix_and_resubmit` | Details refused or brand rejected | Show the reason; edit, then submit |
| `resubmit_campaign` | Only the campaign was rejected | Show the reason; resubmit keeps the brand and edits the campaign |
| `wait` | With carriers | "Check status". A later-step problem retries itself |
| `contact_support` | Carriers suspended the campaign | Texting paused; contact support. "Check status" still re-checks |
| `none` | Approved | Texting open, still re-checked |

**Limits**

- If Twilio creates a step but saving its SID fails, retrying recreates that one
  step. Twilio has no lookup by our key for these resources.
- The Twilio policy and endpoint details stay unverified against live Twilio
  (risk R-09). These tests fake the provider at the `twilio-a2p` module boundary.
- Brand and campaign transitions still rely on status checks. No new cron or
  webhook was added (finding R6).
- `MessageSamples` and the keyword lists are sent as a JSON string inside one
  form field, as before. Twilio's form encoding repeats the key per array item;
  confirm this on the first live registration.
