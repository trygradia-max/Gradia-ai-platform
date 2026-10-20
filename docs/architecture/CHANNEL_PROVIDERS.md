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

**What a resubmission does**

| Situation | Effect |
| --- | --- |
| With carriers (`brand_pending`, `campaign_pending`) or `approved` | Refused. Nothing is created |
| `draft` with a recorded failure, same details | Resume |
| Changed details, or a rejected brand | Fresh chain. TrustHub bundles can't change once reviewed |
| Rejected campaign, same details | The approved brand and messaging service are kept. The next status check creates only a new campaign |

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
| `resubmit_campaign` | Only the campaign was rejected | Show the reason; resubmit keeps the brand |
| `wait` | With carriers | "Check status". A later-step problem retries itself |
| `none` | Approved | Texting open |

**Limits**

- If Twilio creates a step but saving its SID fails, retrying recreates that one
  step. Twilio has no lookup by our key for these resources.
- The Twilio policy and endpoint details stay unverified against live Twilio
  (risk R-09). These tests fake the provider at the `twilio-a2p` module boundary.
- Brand and campaign transitions still rely on status checks. No new cron or
  webhook was added.

## SMS delivery status (review finding I5)

Twilio posts each outbound message's status to `/api/twilio/sms/status`
(`?shop=` inside the signed URL). It doesn't guarantee the order of those
callbacks, so `interactions.metadata.twilio_status` only moves forward:

| Rank | Statuses |
| --- | --- |
| 0 | `accepted`, `scheduled` |
| 1 | `queued` |
| 2 | `sending` |
| 3 | `sent` |
| 4 (terminal) | `delivered`, `undelivered`, `failed`, `canceled` |
| 5 | `read` (only after `delivered`) |

- A status of lower or equal rank never replaces the stored one. A late
  `sent` after `delivered` is ignored, and a replay is a no-op.
- The write is a compare-and-swap on the status the handler read. If
  another callback changed it first, the handler re-reads and decides
  again; after three lost swaps it returns 5xx so Twilio retries.
- An unknown status never replaces a known one.

**Conflicting terminal outcomes.** `delivered` (or `read`) and
`undelivered`/`failed`/`canceled` can both arrive for one message, in either
order. Callbacks carry no event time, so arrival order can't say which is
true. The first terminal outcome stored stays as `twilio_status` (with its
`twilio_error_code`). The later one doesn't replace it. It is written to
`metadata.twilio_status_conflict` as `{status, error_code, received_at}` and
logged as a warning, so the disagreement can be checked against Twilio's
message log. Two terminal failures (for example `undelivered` then `failed`)
aren't a conflict: the first one stays and the second is ignored.

**Limits.** Rows stored before this change aren't backfilled. A message
whose callbacks all arrive before the send path records the interaction
keeps the status from the send response until a later callback arrives.
