# Gradia Agent Builder and pilot pricing recommendation

_Recommendation dated 2026-11-03. This document does not activate a Stripe
catalog, checkout, providers, cron, or production billing._

## Product decision

`/agents` becomes the Agent OS home. It must not remain a redirect to the voice
receptionist. The receptionist is one Gradia playbook/channel, not the product's
top-level agent model.

Use these routes:

- `/agents`: every Gradia agent, lifecycle, active revision, last confirmed run,
  work needing review and a **Create Gradia agent** action.
- `/agents/build`: resumable seven-step builder.
- `/agents/[agentId]`: overview, exact active revision, memory grants, tools,
  limits, schedule, tests and run history.
- `/agents/[agentId]/revisions/[revision]`: immutable configuration and activation
  evidence for one revision.

The builder is:

1. **Job** — role label, one goal, measurable outcomes and stop conditions.
2. **Knowledge** — select only reviewed/published memory revisions. Candidate or
   revoked memory cannot be selected.
3. **Tools** — choose Gradia operations, show effective Control Center mode and
   the reason a tool is available or blocked. Never expose provider credentials,
   raw tool schemas or an unrestricted system prompt.
4. **Limits** — steps/run, runtime, runs/day, concurrency, usage budget and the
   actions that always require a person.
5. **Schedule** — manual, an approved event, or a bounded interval.
6. **Test** — read-only fixture/dry run with source citations, proposed actions,
   cost estimate and explicit unconfirmed outcomes. A test never sends or books.
7. **Activate** — compile server-derived evidence for the exact definition,
   policy and memory revisions. Only an owner can activate. Missing review,
   connector, policy, evaluation or budget evidence disables activation and says
   why.

Every save creates an immutable draft revision. Activation atomically changes one
active pointer; it never mutates an old revision. The detail page distinguishes
draft, active, paused and blocked definitions plus running, waiting, needs-review,
unconfirmed, failed and completed work.

## Recommended pilot offer

Do not launch three public tiers before pilot usage data exists. Sell one clear
founder-led pilot for the first 10 accounts, then use its cohort data to publish
the tiers below.

### Founder pilot — $199/workspace/month

- 3 operator seats.
- Up to 2 active Gradia agents/playbooks.
- 100 standard digital outcomes/month.
- 100 inbound voice-agent minutes/month.
- Email drafting and read-only collaboration included.
- 14-day build/test period; billing starts when the first agent is activated.
- Card required for activation, not for configuring or testing.
- Default monthly overage cap: $100; owner may raise it up to $500.
- No annual commitment during the pilot; preserve the pilot price for 12 months
  for accounts that provide structured feedback.

The pilot is deliberately high enough to prove budget and service value, but low
enough for a local service business to try without an enterprise procurement
cycle.

## Recommended public tiers after pilot evidence

| Plan | Monthly | Included operator seats | Active agents | Standard digital outcomes | Voice minutes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Core | $199 | 3 | 2 | 100 | 100 |
| Growth | $499 | 8 | 6 | 500 | 500 |
| Scale | $999 | 20 | 15 | 1,500 | 1,500 |

An **operator seat** is an active owner, manager or staff member who can configure
agents, approve work, send/reply, change records or run an agent. Read-only users
do not count. Pending invitations and inactive/revoked memberships never count.
Additional operator seats are **$39/month**, prorated daily.

## Usage prices and non-stacking rules

- Standard completed digital outcome: **$1.00**.
- Qualified lead handed to a human: **$5.00**.
- Confirmed appointment attributable to Gradia: **$10.00**.
- Inbound voice-agent time: **$0.35/minute**, rounded to the next 15 seconds.
- SMS: **$0.05/segment** including Gradia orchestration; carrier/A2P surcharges
  that materially vary by destination remain visible pass-through items.
- Email: included at pilot volume; introduce an explicit bulk-email rate only
  after deliverability and provider-cost evidence exists.

Charge only the highest-value digital outcome once per workflow. A qualified lead
that becomes a confirmed appointment is a $10 booking outcome, not $1 + $5 + $10.
Drafts, escalations, failed actions, unknown outcomes and work that required a
human to finish are not billable outcomes. Voice minutes and carrier messages are
still usage because the underlying provider charges occur even when no outcome is
confirmed.

## Margin and cap rules

- Preserve provider cost and customer price as separate evidence.
- Voice retail is `max($0.35/min, wholesale cost / 0.40)` (60% minimum gross
  margin).
- SMS retail is `max($0.05/segment, wholesale cost × 3)` before exceptional
  carrier pass-through fees.
- Model/tool work inside an outcome must maintain at least 65% gross margin; if
  cost exceeds that floor, stop overage work and require a pricing review rather
  than silently changing the customer's price.
- Warn at 50%, 80% and 100% of the monthly overage cap. At 100%, stop new
  automatic paid work while leaving approvals, evidence, exports and revocation
  available.
- No rollover for included usage during the pilot. Never let an allowance hide a
  provider-cost spike.

## Why this is defensible

Current reference points support a seat-plus-usage model: Intercom publishes
human helpdesk seats starting at $29/month and Fin at $0.99 per outcome; Gorgias
publishes roughly $0.90–$1.00 per AI-resolved interaction. Vapi currently lists a
$0.05/min hosting fee before model, voice, transcription and telephony, while US
Twilio voice and SMS add their own per-minute/per-segment costs. Gradia's $1
standard outcome is therefore legible, while $5 qualified-lead and $10 confirmed-
booking outcomes reflect materially higher business value.

Before creating Stripe products, the founder must explicitly approve the plan
names, prices, included units, outcome definitions, operator-seat definition,
rounding, caps, trial activation point, grandfathering, tax/currency policy and
failed-payment behavior. The existing commercial catalog continues to fail closed
until that approval is recorded.
