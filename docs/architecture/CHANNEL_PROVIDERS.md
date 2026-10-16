# Channel provider accounts and readiness

The backend contracts for the provider accounts behind Gradia's customer channels.
This document describes code, not activation: providers, crons and live sends stay
held until the release lane accepts each channel.

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
