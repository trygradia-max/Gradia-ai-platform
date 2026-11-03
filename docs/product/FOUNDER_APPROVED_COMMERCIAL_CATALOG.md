# Founder-approved commercial catalog and margin evidence

_Approved 2026-11-03. Catalog version `2026-11-03.v1`. This file records the
commercial decision and its economics. It does not provision Stripe or authorize
production billing._

## Sellable offer after billing acceptance

Founder Pilot is **$199 per workspace per month** with three billable operator
seats, two active Gradia agents, 100 standard digital outcomes and 100 inbound
voice-agent minutes. An operator is an active owner, manager or staff member who
can configure an agent, approve work, send/reply, change records or run an agent.
Read-only, pending, inactive and revoked memberships do not count. Extra operator
seats are **$39/month**, prorated daily.

The build/test period is 14 days. Billing and the card requirement begin at the
first agent activation, not at draft creation. The default monthly overage cap is
$100; an owner may raise it to $500. Included usage does not roll over. Pilot
accounts providing structured feedback retain the pilot price for 12 months.

| Meter | Included | Overage price |
| --- | ---: | ---: |
| Standard completed digital outcome | 100 | $1.00 |
| Qualified lead handed to a human | 0 | $5.00 |
| Confirmed appointment attributable to Gradia | 0 | $10.00 |
| Inbound voice-agent minute | 100 | Greater of $0.35 or cost / 0.40 |
| SMS segment | 0 | Greater of $0.05 or cost × 3, before exceptional carrier pass-through |

Only the highest-value digital outcome is charged for one workflow. Drafts,
escalations, failures, unknown outcomes and work a human had to finish are not
billable digital outcomes. Provider-incurred voice minutes and message segments
remain usage even when an outcome is not confirmed.

## Profit-margin evidence

These are contribution margins after modeled provider usage and standard domestic
Stripe card processing, but before payroll, support, taxes, general hosting and
other company overhead. They are not accounting profit.

Current public provider evidence gives an inbound local voice cost range of about
**$0.0903–$0.1374/minute**: Vapi hosting, transcriber, model and voice ranges plus
Twilio inbound local transport. At $0.35 retail that is **60.7%–74.2% gross
margin**. The formula raises retail if provider cost rises, preserving a 60% floor.

US outbound long-code SMS is modeled at **$0.0118–$0.0133/segment**, including the
Twilio API price and current carrier range. At $0.05 retail that is approximately
**73.4%–76.4% gross margin** before exceptional fees. The 3× rule preserves at
least 66.7% when ordinary wholesale cost is higher.

Plan estimates assume one $1.15 local number and Stripe domestic-card pricing of
2.9% + $0.30. “Planning” assumes $0.10 internal cost per standard outcome.
“Stress” uses the approved $0.35 outcome stop-cost threshold.

| Plan | Planning contribution margin | Stress contribution margin | Maximum outcome cost for 60% margin |
| --- | ---: | ---: | ---: |
| Founder Pilot / Core | 84.4%–86.8% | 71.9%–74.2% | about $0.59 |
| Growth | 73.0%–77.7% | 48.0%–52.7% | about $0.23 |
| Scale | 61.3%–68.4% | 23.8%–30.8% | about $0.11 |

Founder Pilot/Core clears the margin floor even under the stop-cost stress case.
Growth and Scale do not. They are approved product direction but remain blocked
from Stripe provisioning until the pilot ledger shows their p95 outcome cost stays
below the listed ceiling with adequate room for support and shared infrastructure.

## Planned public catalog

| Plan | Monthly | Seats | Active agents | Digital outcomes | Voice minutes | Launch state |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Core | $199 | 3 | 2 | 100 | 100 | Blocked pending pilot cost evidence |
| Growth | $499 | 8 | 6 | 500 | 500 | Blocked pending pilot cost evidence |
| Scale | $999 | 20 | 15 | 1,500 | 1,500 | Blocked pending pilot cost evidence |

## Source and implementation boundary

Provider assumptions were checked 2026-11-03 against official Vapi pricing,
official Twilio US Voice/SMS pricing and official Stripe pricing. Provider prices
can change; the usage ledger must retain actual wholesale evidence and the margin
gate must be rerun before activation.

- Vapi: https://vapi.ai/pricing
- Twilio Voice: https://www.twilio.com/en-us/voice/pricing/us
- Twilio SMS: https://www.twilio.com/en-us/sms/pricing/us
- Stripe: https://stripe.com/pricing

The executable configuration is in `src/lib/approved-commercial-catalog.ts`.
Margin calculations are in `src/lib/commercial-margin.ts`. The deterministic,
network-free provisioning input is in `src/lib/stripe-commercial-manifest.ts` and
is explicitly disabled. No live Stripe product ID belongs in source.

