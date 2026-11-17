# Post-pilot pricing, packaging, expansion and enterprise proposal

_Prepared 2026-11-16 (Pacific) on `origin/main` `a56a150`. **Proposal only.** Every price, allowance,
discount, SLA and package in this document is **PROPOSED, NOT APPROVED and NOT SELLABLE**. It is
founder-directional design input for a future catalog v2._

> **Authority boundary.** Founder Pilot ($199/workspace/month, catalog `2026-11-03.v1`) remains the
> **only approved active catalog**. This document changes no application pricing, no
> `src/lib/approved-commercial-catalog.ts`, no Stripe manifest or Dashboard object, no checkout, no
> sales page, no provider setting and no production or shared data. The planned Core $199 / Growth
> $499 / Scale $999 rows in `FOUNDER_APPROVED_COMMERCIAL_CATALOG.md` stay blocked and recorded as they
> are; this proposal would only replace them if the founder decides so under section 14. Nothing here
> can be quoted to a customer.

Reading order used: `AGENTS.md`, `docs/AI_WORK_LOG.md`, `docs/CHEAT_SHEET.md`, the five September 11
governing documents (MVP vision, implementation sequence, agent architecture, autonomy/approval modes,
Gradia Memory), `FOUNDER_APPROVED_COMMERCIAL_CATALOG.md`, `AGENT_BUILDER_AND_PILOT_PRICING.md`,
`HYBRID_COMMERCIAL_MODEL.md`, `COMMERCIAL_SETTLEMENT.md` (including the 2026-11-16 founder decisions),
`GRADIA_GTM_SALES_MASTER.md` and `PRODUCTION_LAUNCH_READINESS_2026-11-04.md`. Note that
`CHEAT_SHEET.md` still lists the superseded Core $99 / Pro $149 / Operator $249; those figures are not
used here.

## 1. Summary

1. **Ladder (proposed):** Core $299, Growth $799, Scale $1,999, Custom from $3,000+ per workspace per
   month. These are about 1.5x, 1.6x and 2.0x the previously planned $199/$499/$999 rows.
2. **Why the planned rows need revision.** The approved evidence shows Growth (48.0%–52.7%) and Scale
   (23.8%–30.8%) fail the 65% stress contribution target at their planned prices and allowances. A
   higher price **and** a tighter, not larger, included allowance is what clears the gates (section 4).
3. **Gates tested.** Target planning contribution at least 80%, minimum planning at least 75%, stress at
   least 65%, and variable voice/SMS margin at least 70%. Recommended allowances pass all three plan
   gates for Core, Growth, Scale and a $3,000 Custom archetype. Scale passes stress by only 0.9 points.
4. **Two pricing consequences.** (a) Meeting 70% variable voice margin at the high end of provider cost
   needs voice retail near **$0.46/minute** (the pilot's $0.35 yields 60.7%). (b) SMS needs a
   cost/0.30 rule (about 3.3x) instead of the current 3x to hold 70% at the high end.
5. **Nothing here is ready to sell.** Billing settlement, meters, dunning, tax, Stripe provisioning and
   pilot cost evidence are all unfinished. Growth and Scale also rest on cost assumptions the pilot
   ledger has not yet produced.
6. **Expansion is earned, never forced.** Upsell moments are forecast-based, owner-capped, never
   automatic and never block approvals, evidence, exports, STOP or revocation (section 8).
7. **Large contracts sell only what exists.** The consulting firm and sales team sell diagnosis,
   implementation, training and measurement around the one-location product. Multi-location routing,
   outbound calling, payments, repair orders and advanced analytics are not offered as deliverables
   (section 9).

## 2. Evidence base

### 2.1 Provider cost evidence (primary sources, fetched 2026-11-16)

| Cost | Value on the page | Source |
| --- | --- | --- |
| Vapi hosting | $0.05/min pre-paid | https://vapi.ai/pricing |
| Deepgram transcriber | $0.0095–$0.0099/min | same |
| Model (OpenAI) | $0.0077–$0.0452/min | same |
| Voice (ElevenLabs) | $0.0146–$0.0238/min | same |
| Vapi plans | No package $0; Core $29/mo; Pro 10% of hosting, $999/mo minimum; Premier custom | same |
| Twilio inbound local voice | $0.0085/min; number $1.15/mo; outbound $0.0140/min; automatic volume pricing | https://www.twilio.com/en-us/voice/pricing/us |
| Twilio SMS | $0.0083/segment, plus long-code carrier fees $0.0035–$0.005 outbound; 10DLC fees not listed on page | https://www.twilio.com/en-us/sms/pricing/us |
| Stripe cards | 2.9% + 30c domestic; Billing 0.7% (pay-as-you-go); Invoicing 0.4%; Tax Basic 0.5%; ACH 0.8% capped at $5; +1.5% international | https://stripe.com/pricing |

Derived ranges (unchanged from the approved 2026-11-03 evidence, which this refresh reproduces):

- Inbound voice: $0.05 + $0.0095 + $0.0077 + $0.0146 + $0.0085 = **$0.0903/min** (low) through
  $0.05 + $0.0099 + $0.0452 + $0.0238 + $0.0085 = **$0.1374/min** (high).
- Outbound SMS segment: $0.0083 + $0.0035 = **$0.0118** through $0.0083 + $0.005 = **$0.0133**.
- Caveats: Vapi's Pro package (10% of hosting, $999 minimum) and Core ($29) are platform fees not in the
  per-minute range. Twilio may apply volume pricing. 10DLC registration fees and any carrier surcharge
  are excluded, as in the approved catalog. Stripe Billing 0.7% was **not** in the approved margin
  evidence; this proposal adds it (section 3).

### 2.2 SaaS reference pricing (primary vendor pages, fetched 2026-11-16)

These are **reference points, not comparables**. Each serves a different buyer and scope. Pages were
read through an automated page-to-text step; several have toggles whose labels did not survive
extraction, so every figure must be re-confirmed on the live page before any external use.

| Vendor | What the page shows | Reading caution |
| --- | --- | --- |
| Intercom | Full seats $19 (Essential, "New customers save 35%"), $85 (Advanced), $132 (Expert); Fin $0.99 per outcome, charged once per conversation | Annual-versus-monthly label for seat prices not extractable. Support helpdesk buyer, not a detailing shop |
| Zendesk | Suite Team $55/agent (yearly) or $69 (monthly); Professional $115 or $149; AI automated resolutions $1.50 committed, $2.00 pay-as-you-go | Per-agent helpdesk pricing |
| Gorgias | Plans $10–$750/mo (annual billing) with ticket allowances; AI Agent $0.90 per interaction (annual) or $1.00 (monthly); $1.50 above allowance | Page carried a second structured-data block with different plan prices; treat plan prices as unverified |
| Salesforce Agentforce | $2 per conversation; Flex Credits $500 per 100k (about $0.10 per action, $0.15 per voice action); user licenses $5–$150 per user per month; Max edition from $550 per user per month | Enterprise CRM, quoted as "for information purposes" |
| HubSpot Service Hub | Starter from $7 per seat; Professional $90 (annual) or $100 per seat; Enterprise $150; required onboarding $1,500 (Professional) and $3,500 (Enterprise); credits $0.010 each | Customer Agent price per resolution not shown on the page; onboarding fee is a useful precedent for paid implementation |
| Jobber | Core $29–$49; Connect $99–$139 (1 user) up to $229–$299 (10 users); Grow $149–$199 up to $499; Plus $399–$699; extra users $29 per month; **AI Receptionist add-on $29/mo** | Field-service management for the same industry. Page's included-user labels were inconsistent. The $29 receptionist add-on is a **direct price anchor for Gradia's voice story** and a risk (see 4.5) |
| Smith.ai | Human-first plans: Starter $300 (30 calls), Basic $810 (90), Pro $2,100 (300); overage $8.50–$11.50 per call; 10% discount for 12 months | Per-call human receptionist; AI-first tab not captured |

Sources: https://www.intercom.com/pricing, https://www.zendesk.com/pricing/,
https://www.gorgias.com/pricing, https://www.salesforce.com/agentforce/pricing/,
https://www.hubspot.com/pricing/service, https://getjobber.com/pricing/, https://smith.ai/pricing.
A HubSpot customer-platform URL returned 404 and was not used.

What this evidence supports, and what it does not:

- Per-outcome AI pricing of **$0.90–$2.00** per resolved interaction is the market's reference band. Gradia's
  $1.00 standard outcome sits inside it. The $5 qualified-lead and $10 confirmed-appointment prices have
  **no listed equivalent** on these pages; they stand on Gradia's own value argument, which must be proven
  (section 11).
- Required paid onboarding ($1,500–$3,500) exists at HubSpot's Professional and Enterprise tiers, so paid
  implementation is not unusual for operating-system software.
- Industry tools (Jobber) price seats at about $29 and an AI receptionist at $29, but that does not show
  equal capability. It does mean an owner will compare a $299 plan against a $29 add-on and Gradia must
  win on the integrated operating loop, approvals and evidence, not on answering calls alone.
- Nothing here shows what detailing shops will pay for Gradia. That requires the interviews and pilot data
  in section 12.

## 3. Margin method (exact formulas)

All cents unless stated. This reuses `src/lib/commercial-margin.ts` and adds Stripe Billing.

```
gross_margin(R, C)       = (R - C) / R
card_fee(R)              = ceil(R x 0.029 + 30)                       # catalog
billing_fee(R)           = round(R x 0.007)                           # added here (Stripe Billing, PAYG)
payment_cost(R)          = card_fee(R) + billing_fee(R)
plan_cost                = outcomes x c_out + voice_min x c_voice + sms x c_sms
                           + numbers x 115 + payment_cost(R)
plan_contribution(R)     = gross_margin(R, plan_cost)                 # before payroll, support, hosting, tax
```

Cases (all assume the **entire included allowance is consumed**, which is conservative):

| Case | Gate | Outcome cost | Voice cost/min | SMS cost/segment |
| --- | --- | ---: | ---: | ---: |
| Target planning | at least 80% | 10c (approved planning cost) | 11.385c (midpoint) | 1.255c (midpoint) |
| Minimum planning | at least 75% | 15c (**modeling choice**, 1.5x planning) | 13.74c (high) | 1.33c (high) |
| Stress | at least 65% | 35c (approved stop-cost) | 13.74c (high) | 1.33c (high) |

Only the 10c, 35c, voice and SMS ranges and the $1.15 number come from approved evidence. The 15c minimum
case and the midpoint choices are modeling choices a founder may change. The phone-number count per plan
(1/2/3/4) is also an assumption.

Variable overage margin: `(retail - wholesale) / retail`, the catalog's definition, which excludes the
percentage payment fee. Sensitivity: after 3.6% card plus Billing fees, price must be
`wholesale / (0.964 - 0.70)`, i.e. about **$0.52/min voice** (13.74c / 0.264) and about **$0.050 per SMS segment**
(1.33c / 0.264 = 5.04c, so the $0.05 list price sits right at the line). Founders should pick which definition the 70% gate means (decision D-3).

Excluded from every number (as in the approved catalog): payroll, support, onboarding labor, general
hosting and database, 10DLC fees, taxes (Stripe Tax would add 0.5% of revenue, about 0.5 points of margin),
refunds, bad debt, sales commission. Those are handled in sections 6 and 10.

Worked example, proposed Core at the target case (180 outcomes, 125 voice minutes, 300 SMS, 1 number):

```
outcomes   180 x 10        = 1,800.0
voice      125 x 11.385    = 1,423.1
sms        300 x 1.255     =   376.5
number                      =   115.0
card_fee   ceil(29,900 x .029 + 30) = 898 ; billing_fee round(29,900 x .007) = 209  -> 1,107.0
total                       = 4,821.6c = $48.22
contribution = (299.00 - 48.22) / 299.00 = 83.9%
```

Reproduction check: the same code applied to the approved Founder Pilot (100 outcomes, 100 minutes, no
SMS) gives 84.9% target, 81.2% minimum, 71.2% stress. The approved catalog shows 84.4–86.8% planning and
71.9–74.2% stress; the small difference is the added Billing fee and the voice midpoint.

## 4. Proposed ladder and scenario tests

### 4.1 Included-usage scenarios tested

Contribution percentages are **target / minimum planning / stress**. Gate result is PASS only if all three
meet 80 / 75 / 65.

| Plan (price) | Scenario | Outcomes | Voice min | SMS | Numbers | Target | Min | Stress | Gate |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Core $299 | Lean | 150 | 100 | 200 | 1 | 86.2 | 82.9 | 72.9 | PASS |
| Core $299 | Balanced | 200 | 150 | 300 | 1 | 82.3 | 77.7 | 64.3 | fail (stress) |
| Core $299 | Generous | 300 | 250 | 600 | 1 | 73.8 | 66.7 | 46.6 | fail |
| **Core $299** | **Recommended** | **180** | **125** | **300** | **1** | **83.9** | **79.8** | **67.8** | **PASS** |
| Growth $799 | Lean | 500 | 300 | 800 | 2 | 84.3 | 80.2 | 67.7 | PASS |
| Growth $799 | Balanced | 600 | 400 | 1,000 | 2 | 81.3 | 76.3 | 61.2 | fail (stress) |
| Growth $799 | Generous | 900 | 700 | 2,000 | 2 | 71.7 | 63.8 | 41.3 | fail |
| **Growth $799** | **Recommended** | **500** | **350** | **1,000** | **2** | **83.3** | **79.0** | **66.5** | **PASS** |
| Scale $1,999 | Lean | 1,200 | 800 | 1,500 | 3 | 84.7 | 80.7 | 68.7 | PASS |
| Scale $1,999 | Balanced | 1,500 | 1,000 | 2,500 | 3 | 81.4 | 76.4 | 61.4 | fail (stress) |
| Scale $1,999 | Generous | 2,500 | 1,800 | 5,000 | 4 | 70.3 | 61.7 | 36.7 | fail |
| **Scale $1,999** | **Recommended** | **1,300** | **900** | **2,000** | **3** | **83.3** | **78.9** | **65.9** | **PASS (thin)** |
| Custom $3,000 | Archetype | 1,800 | 1,200 | 3,000 | 4 | 84.4 | 80.4 | 68.4 | PASS |

Findings:

- **Included usage is the lever.** The "Generous" scenarios, which match the allowance growth in the
  previously planned ladder, fail even at the higher prices. Stress is binding, not target planning.
- The stress case is dominated by the 35c outcome stop-cost: each included outcome contributes 25c more
  cost than in planning. Pilot data on p95 outcome cost is therefore the single most important evidence
  for Growth and Scale.
- At 75% allowance utilization the recommended plans' target contribution is about 86–87%; at 50% about 90%.
  Unused allowance is margin, which also means heavy light-usage customers are the profitable ones.
- Scale clears stress by 0.9 points. If the pilot shows p95 outcome cost above about 35c, Scale must either
  shrink included outcomes or rise in price before any sale.

### 4.2 Recommended proposed ladder

**PROPOSED. NOT APPROVED. NOT SELLABLE.**

| | Core | Growth | Scale | Custom |
| --- | --- | --- | --- | --- |
| Monthly price (USD) | **$299** | **$799** | **$1,999** | **from $3,000+** |
| Operator seats included | 4 | 10 | 25 | scoped |
| Active agents included | 3 | 8 | 20 | scoped |
| Standard outcomes included | 180 | 500 | 1,300 | scoped |
| Inbound voice minutes included | 125 | 350 | 900 | scoped |
| SMS segments included | 300 | 1,000 | 2,000 | scoped |
| Local numbers included | 1 | 2 | 3 | scoped |
| Setup | self-serve + guided | guided | guided + review | scoped SOW |
| Support | email, business days | priority queue | named contact | contract |
| Pilot lineage | pilot has 3 seats / 2 agents / 100 outcomes / 100 min | | | |

Notes:

- Seat and agent counts are packaging choices, not cost drivers. Seats and agent slots do not appear in the
  margin gates because their direct provider cost is approximately zero. Their real cost is support and
  evaluation time (section 6), and that must be measured in the pilot. These counts keep the previously
  approved Growth/Scale seat and agent intent (8/6, 20/15) roughly while reducing nothing on Core.
- Planned Growth/Scale seat counts are slightly larger here (10/8, 25/20) because they are cheap and make the
  price rise easier to justify. Founder may revert to 8/6 and 20/15 with no margin effect.
- Active agents are bounded by what the Agent builder supports; an agent slot is not a promise of a
  capability. Voice minutes are unusable until the voice channel passes its acceptance gates.
- Included usage does not roll over (consistent with the pilot). Whether committed annual customers get a
  pooled annual allowance is open (D-9).

### 4.3 Comparison with the previously planned rows

| Plan | Planned price | Planned allowance (outcomes/min) | Approved stress | Proposed price | Proposed allowance | Proposed stress |
| --- | ---: | --- | ---: | ---: | --- | ---: |
| Core | $199 | 100 / 100 | 71.9–74.2% | $299 | 180 / 125 | 67.8% |
| Growth | $499 | 500 / 500 | 48.0–52.7% | $799 | 500 / 350 | 66.5% |
| Scale | $999 | 1,500 / 1,500 | 23.8–30.8% | $1,999 | 1,300 / 900 | 65.9% |

The proposed Core has more usage than the pilot and a **lower stress margin** than Founder Pilot; it still
clears the 65% gate. Core $299 is a 50% price increase over $199 (see 7.4 for pilot customers).

### 4.4 Per-unit prices

| Item | Proposed price | Test |
| --- | --- | --- |
| Extra operator seat | Core $39, Growth $35, Scale $29, Custom negotiated; daily proration as in the pilot | No provider cost; keep $39 for continuity at Core. Support load must be measured |
| Extra active agent slot | Core $59, Growth $49, Scale $39 per month | Evaluation and monitoring burden, not provider cost. Assumed support allocation $10 per agent per month, unverified |
| Standard completed digital outcome | **$1.00** on all plans | Inside the $0.90–$2.00 reference band. Margin 90.0% at 10c, 65.0% at 35c; the stop-cost rule (stop overage work if cost exceeds 35% of price) is unchanged |
| Qualified lead handed to a human | **$5.00** | Cost ceiling for 70% margin: $1.50. Cost not yet measured |
| Confirmed appointment attributable to Gradia | **$10.00** | Cost ceiling for 70% margin: $3.00. Cost not yet measured |
| Inbound voice minute | **max($0.46, cost / 0.30)**, rounded to next 15 s | 70.1% at 13.74c, 80.4% at 9.03c |
| SMS segment | **max($0.05, cost / 0.30)** | $0.05 gives 73.4–76.4%; the formula protects the floor if cost rises; 3x rule would give only 66.7% |
| Additional local number | $5/month | Cost $1.15, 77% margin |
| Committed outcome blocks (Scale/Custom) | 10% off $1.00 in blocks of 500, with stop-cost scaled to price | Optional; adds commitment, not discounts on usage already incurred |

Outcome non-stacking, highest-value-only billing, no billing for drafts, escalations, failures, unknown
outcomes or human-finished work, and the 50/80/100% cap warnings are unchanged. Qualified-lead and
appointment prices are deliberately not discounted per tier: they are tied to value, and tiered discounts
would make an appointment cheaper for the customers most likely to book more.

### 4.5 Risks the numbers do not capture

- **Voice price pressure.** Raising voice from $0.35 to $0.46 widens the gap to cheap receptionist add-ons
  (Jobber lists $29/mo). If willingness-to-pay interviews show owners treat voice as a commodity, the
  alternative is to hold $0.35 for the included allowance and accept lower variable voice margin, or bundle
  voice only in Growth and above. Either breaks the 70% gate and is a founder decision (D-3).
- **Price-sensitivity of a local service shop.** $299 is 50% above the approved pilot and is untested.
- **Cost evidence is a model.** Planning outcome cost (10c) and stress cost (35c) are approved assumptions,
  not observations. They must be replaced by the usage ledger before any activation.
- **Support is not in the gates.** At $299 with about $48 of modeled cost, roughly $250 remains per month to
  fund support, infrastructure, sales commission and overhead. One hour of founder support at a $100 loaded
  rate consumes 40% of that on Core.

## 5. Packaging principles

1. **Price the operating system and the verified work, not the model.** Base price buys the workspace,
   seats, agent slots and the first block of usage. Usage prices follow recognized outcomes and provider
   consumption.
2. **Every number the owner sees is a number the ledger can prove.** No outcome is billed from model text;
   drafts, failures and unknown outcomes are free; usage is reconciled to the append-only ledger.
3. **One decision per upgrade.** A plan change should be explainable in one sentence with one forecast
   number. No bundles that hide which part the owner is paying for.
4. **Limits are explained, not enforced by surprise.** Soft warnings come first; the hard stop only affects
   new automatic paid work and never approvals, evidence, exports, revocation or STOP handling.
5. **Fair-use is explicit.** Included usage does not roll over; the owner sets an overage cap; seats count
   only active operator roles.
6. **No feature is priced before it exists.** Packages list only available capabilities. Future items
   (multi-location, analytics, outbound) appear as "design intent" in this document and never in a
   customer-facing artifact until built and accepted.
7. **Authority is not an entitlement.** A plan never grants a Gradia action. Control Center mode, consent
   and policy decide what runs (`AUTONOMY_APPROVAL_MODES.md`, evaluation order step 2).
8. **Headroom before heroics.** Included allowances are sized for stress margin, so a heavy month is
   survivable without repricing or silently throttling the customer.
9. **Grandfathering is a promise.** Existing customers keep their terms for a defined period and are never
   moved without notice and consent (section 7.4).
10. **Same product for every size.** Solo and staffed shops share the complete core product (MVP vision); tiers
    differ in capacity, seats, support and services, not in a degraded core.

## 6. Services, support/SLA and future items

### 6.1 Onboarding and implementation (one-time)

Service margin formula: `(price - hours x loaded_rate) / price`, with a **50% minimum service margin** and
an assumed $100/hour loaded rate (a placeholder; founder must confirm).

| Package | Proposed price | Hours assumed | Cost | Service margin | Scope (existing capability only) |
| --- | ---: | ---: | ---: | ---: | --- |
| Core guided launch | $500 | 2 | $200 | 60.0% | Setup clinic, Starting Point baseline review, first agent test review |
| Growth implementation | $1,800 | 8 | $800 | 55.6% | Workflow map, baseline, channel readiness checklist, two agent builds, training |
| Scale implementation | $3,500 | 16 | $1,600 | 54.3% | Above plus role and Control Center design, measurement plan, 30-day review |
| Custom implementation | scoped, quoted from hours x $100 / 0.50 | | | at least 50% | SOW that lists only Available capabilities |

HubSpot's $1,500 and $3,500 required onboarding fees (section 2.2) are the closest precedent, not a
comparison. Implementation fees are waivable only through the discount authority in section 7.

### 6.2 Support and SLA

The only support commitment today is founder-led pilot support. The proposal below is a **design** that
requires the founder to name support hours, severity levels and the escalation owner (an open item in the
GTM master).

| Tier | Proposed | Response target (business hours) | Notes |
| --- | --- | --- | --- |
| Core | Email and in-app | 2 business days | No uptime SLA |
| Growth | Priority queue | 1 business day; severity-1 within 4 business hours | Named onboarding contact |
| Scale | Named contact | 4 business hours; severity-1 within 2 business hours | Monthly review |
| Custom | Contract | negotiated, **only what staffing supports** | No 24/7 until staffed; no uptime percentage until monitoring and incident evidence exist |
| Premium support add-on | $249/month (Growth+) | upgrades one response tier | Optional |

No uptime or availability percentage is proposed because production monitoring, alerting, backup/restore
and incident evidence are not yet accepted (`PRODUCTION_LAUNCH_READINESS_2026-11-04.md`, section 4).

### 6.3 Future items (design intent only, not offered)

| Item | Proposed price signal | Gate before it may be sold |
| --- | --- | --- |
| Additional location (Growth+) | $249/month with 150 outcomes, 100 min, 300 SMS, 1 number (83.7 / 79.7 / 67.6%) | Founder scope decision, cross-location scope model, capacity and permission build, acceptance. MVP supports one active location or mobile service area per workspace |
| Analytics add-on | $149/month | Sophisticated analytics is POST-MVP; needs scoped definition and evidence-labeled data |
| Outbound campaigns / calling | none | Off for the initial MVP; separate scope decision |
| Payments, repair orders, fleets | none | Not approved scope |

## 7. Discounts, annual contracts and grandfathering

### 7.1 Annual and prepay options (proposed)

- Monthly, no commitment: list price. Pilot terms (no annual commitment) continue for pilot accounts.
- **Annual prepay: 10% off the base fee** (not off usage or services), paid by ACH where possible.
  Reason: ACH is 0.8% capped at $5 versus about 3.6% of the invoice by card plus Billing fees, so a $1,999
  annual invoice paid by card costs about $860 in fees and by ACH about $5 plus Billing's 0.7%. The
  payment saving funds most of the discount; model each contract.
- Implementation fee may be included in an annual contract rather than waived.

### 7.2 Discount authority

Computed contribution at each discount (target / minimum / stress), usage allowance held constant:

| Discount | Core $299 | Growth $799 | Scale $1,999 | Custom $3,000 |
| --- | --- | --- | --- | --- |
| 0% | 83.9 / 79.8 / 67.8 | 83.3 / 79.0 / 66.5 | 83.3 / 78.9 / 65.9 | 84.4 / 80.4 / 68.4 |
| 5% | 83.2 / 78.9 / 66.3 | 82.6 / 78.1 / 64.9 | 82.6 / 78.0 / 64.3 | 83.8 / 79.6 / 66.9 |
| 10% | 82.5 / 78.0 / 64.6 | 81.8 / 77.1 / 63.2 | 81.9 / 77.0 / 62.5 | 83.1 / 78.6 / 65.3 |
| 15% | 81.7 / 76.9 / 62.7 | 80.9 / 75.9 / 61.2 | 81.0 / 75.9 / 60.6 | 82.3 / 77.6 / 63.5 |
| 20% | 80.7 / 75.7 / 60.6 | 80.0 / 74.7 / 59.0 | 80.1 / 74.6 / 58.3 | 81.4 / 76.4 / 61.4 |

Largest discount that keeps target at least 80% and minimum at least 75%: Core 22%, Growth 18.5%, Scale 18%,
Custom 25%. Largest discount that keeps stress at least 65%: Core 8.5%, Growth 4.5%, Scale 2.5%, Custom 10.5%.

| Level | Who | Maximum | Conditions |
| --- | --- | --- | --- |
| L0 | Sales | 0% | List price |
| L1 | Sales rep | 5% on base fee | Annual prepay only; written order form |
| L2 | Sales lead or founder | 10% on base fee | Documented value case (section 11); stress stays at or above 62% |
| L3 | Founder only | 15% on base fee | Design-partner or reference account with written case-study consent; stress at or above 60% |
| Over 15% | Not permitted | | Re-scope included usage instead and rerun all gates |

Rules: discounts apply to the base fee, never to provider-cost-linked usage floors (voice, SMS); cumulative
discounts are capped at the level above; every discount records a margin run and an expiry; no discount may
be offered as "free usage" that bypasses the ledger.

### 7.3 Multi-year

Multi-year price locks are **not proposed** until two quarters of provider cost movement are observed. If the
founder wants multi-year terms, price protection should be limited to the base fee, with voice and SMS floors
indexed to provider cost.

### 7.4 Grandfathering and migration (proposed)

1. Founder Pilot accounts that provide structured feedback keep **$199 and their current inclusions for 12
   months** from first activation, as approved. Nothing here changes that.
2. No automatic move to any new plan. Before the pilot price ends, the owner receives a written offer of
   the closest equivalent plan with a plain comparison (included units, seats, price) at least 60 days
   ahead and may stay on the pilot terms until the date, choose a new plan, or cancel.
3. If a pilot account's voice or SMS usage is still on pilot rates ($0.35, 3x), the unit rates stay until
   the same date. The 60.7% voice margin at the high cost end for those accounts is an accepted, temporary
   exception that the founder should acknowledge (D-3).
4. Customers who join under a later approved catalog keep their plan price for at least 12 months unless
   they request a change or Gradia gives 60 days' notice with an exit right.

## 8. Ethical in-product expansion moments

Principles (apply to every moment): the owner chooses; every price and forecast is visible before action;
the **owner-set monthly cap** governs any paid usage; no plan changes automatically; the "stay as you are"
option is as prominent as the upgrade; and every upgrade has an equally easy downgrade at the next period.
Existing safeguards stay: cap warnings at 50/80/100%; at 100% only new automatic paid work stops, never
approvals, evidence, exports, revocation, STOP or suppression processing.

Forecast rule: show a **range, not a point**. Use month-to-date usage and a trailing-14-day run rate to give
"at this pace, about X to Y by `period_end`", labeled with how many days of data it uses. Show nothing before
7 days of billable data in the period. Never use a forecast to charge; it informs only.

| # | Moment | Trigger (server-derived) | What the owner sees | What the owner can do | What is never done |
| --- | --- | --- | --- | --- | --- |
| 1 | Usage forecast | Forecast high bound exceeds 100% of an included meter before period end | "Projected 540 to 610 outcomes against 500 included. Overage at $1.00 would add about $40 to $110; your cap is $100." | Raise cap, move to next plan with a side-by-side total, do nothing | No auto upgrade, no countdown, no hidden recommendation |
| 2 | Seats | Owner invites an operator beyond included seats (before the invite is sent) | Exact new monthly cost, prorated amount for this period, and the plan where seats are cheaper | Invite, decline, or compare plans | Pending, inactive and revoked users never count; no surprise seat |
| 3 | Active-agent slots | Owner activates an agent beyond included slots | Price of the extra slot and which plan includes it | Activate, pause another agent, upgrade | Activation is not blocked by the offer; never pre-selects an add-on |
| 4 | Voice activation | Owner reaches the voice step **after** acceptance gates pass | Included minutes, price per minute beyond, a worst-case at the owner's cap, and the reminder that voice is bounded by Control Center policy | Enable, test, or leave Off | No prompt while voice is not accepted; no minutes bundled into plans silently |
| 5 | Automation readiness | Starting Point, tests and policy evidence show an agent is ready for a bounded autonomy opt-in | A readiness explanation: evidence list and what changes. **Autonomy is not a paid feature** and is never tied to a plan | Enable per operation or not | Trust never auto-promotes permission; never sell autonomy as a premium tier |
| 6 | Analytics and support | Owner views a report that needs data the plan lacks, or opens a support ticket beyond tier response | Description of what the add-on provides **only if it exists** and its price | Learn more, dismiss for 90 days, subscribe | No tease of unavailable analytics; no nag after dismiss |
| 7 | Location expansion (future) | Owner records a second operating location in onboarding notes | A plain statement that multi-location is not available; offer to join a design-partner list | Join list or ignore | No price, no date, no promise until built and accepted |

Dark-pattern prohibitions (checked at design review): no pre-checked add-ons; no countdown timers or
scarcity claims; no confirmshaming copy; no hiding the cancel, downgrade or cap controls; no blocking
approvals or evidence to push an upgrade; no price shown only after selection; no auto-renew to a higher
plan; no "free" usage that changes terms silently; every upsell has a visible "not now" that suppresses it
for at least 30 days; and every upgrade confirmation shows the next invoice amount and effective date.
Copy follows the narrator voice in `BUILD_REFERENCE.md`: third person, numbers over adjectives, no
exclamation marks.

## 9. Enterprise and consulting motion

### 9.1 What "enterprise" can mean today

The product supports one active location or mobile service area per workspace, owner/manager/staff roles,
approval-first actions and a controlled five-channel roadmap. A "Custom" contract is therefore, for now:

- a **larger or more complex single-location business** (many operators, many agents, high volume), or
- a **multi-workspace group that runs each location as its own workspace** with separate owners, billed on
  one commercial agreement, **if and when** that account administration exists (it does not today); or
- a **design-partner agreement** that is explicitly not a delivery commitment for unbuilt features.

### 9.2 Roles

| Role | Sells and delivers | Does not do |
| --- | --- | --- |
| Gradia sales | Qualifies against the ICP and anti-ICP, runs discovery and demo, builds the value case, prices within discount authority, signs order forms | Promises roadmap features, dates or integrations |
| Consulting firm | Lead-Leak Audit and workflow mapping, Starting Point baseline, change management and training, process design around approvals, measurement and review cadence | Custom development, guaranteed outcomes, anything not marked Available in the GTM matrix |
| Gradia product and engineering | Delivers only what the sequence and acceptance gates have shipped | Builds one-off features for a deal |

The relationship between the consulting firm and Gradia (separate entity, referral arrangement, shared
staff) is not recorded in the repository. Conflict-of-interest disclosure, who contracts with the customer
and how consulting revenue and Gradia revenue are separated are founder decisions (D-12).

### 9.3 Guardrail: no promising unavailable features

1. Every SOW and order-form line maps to a row marked **Merged / production-gated** or better, with current
   status checked against `GRADIA_GTM_SALES_MASTER.md` section 6 and the release evidence on the date of
   signature.
2. A **capability register** dated at signing lists what is live, what is gated, and what is not offered.
3. Anything else is a non-binding design-partner note that states "no delivery date, no commitment, no
   price," and that Gradia may decline to build.
4. No contract references multi-location routing, outbound calling, payments, repair orders, a named
   third-party CRM integration or an uptime percentage unless it exists and has passed acceptance.
5. Results are never guaranteed; value cases use evidence labels (owner estimate, connected evidence,
   Gradia-observed) and never convert unknown to zero.

### 9.4 Enterprise sales cycle (proposed stages)

Qualify (ICP fit, one location or workspace-per-location, named champion) -> Lead-Leak Audit and baseline
-> value case and pricing run -> controlled build/test (14 days, as in the pilot) -> activation decision
-> annual or monthly order form -> 30-day value review. Procurement requests (security questionnaire, DPA,
SSO, SLAs) are answered only with what exists; items that do not exist are listed as not available.

### 9.5 Custom pricing structure

`custom_price = max(3,000, plan_contribution_floor_price)`, where the floor price is the lowest R that holds
target 80% / minimum 75% / stress 65% given the negotiated allowance. Add seats and agent slots per the
Scale rate card, services from section 6.1, support from 6.2. Usage floors for voice and SMS stay on the
cost/0.30 rule so enterprise terms cannot erode wholesale margin.

## 10. Sales compensation considerations (proposed principles, no amounts)

- Pay on **collected, net-new recurring revenue after the first successful billing period**, with a clawback
  if the customer cancels or is refunded within 90 days. Booked revenue is not collected revenue.
- Do **not** pay commission on usage or overage, which would reward steering customers into the cap.
- Pay on the **margin-qualified** base fee: contracts below the L2/L3 discount authority carry a reduced
  rate; no accelerators for deals needing founder discount approval.
- No spiffs for custom features, unreleased integrations or term lengths that outrun the cost evidence.
- Referral or consulting fees must be disclosed to the customer and capped (a proposal: at most 10% of the
  first 12 months of collected base fees, payable as collected).
- Quota should include an activation and 30-day value-review metric so reps are rewarded for customers
  who stay, not only for signatures.
- Until a sales team exists and the first 10 pilot accounts have settled, compensation stays at founder
  discretion; creating a plan is a decision (D-13).

## 11. Value proof required before pricing above the pilot

No price in this proposal may be defended publicly until the following exist. Missing evidence is "unknown,"
never zero, per `GRADIA_GTM_SALES_MASTER.md`.

| Proof | Evidence class | Minimum |
| --- | --- | --- |
| Time to first useful verified outcome | Gradia-observed | Median across pilot accounts |
| Inquiry-to-next-action coverage and speed | Starting Point baseline versus a like-for-like window | At least 5 accounts with compatible definitions |
| Confirmed appointments attributable to Gradia | Connected calendar and booking evidence | Counted only with evidence; not drafts |
| Owner/staff hours saved | Owner estimate, labeled | Never combined with connected evidence |
| Cost to serve | Usage ledger: p50/p95 outcome cost, voice cost, SMS cost, support minutes per account | Full period for every pilot account |
| Unknown-outcome and manual-completion rates | Ledger | Within agreed bounds |
| Retention intent | Structured feedback at day 30/60/90 | 70% or more would continue at a price within the tested band (target to confirm) |
| Reconciliation | Ledger-to-Stripe variance | Zero unexplained variance in sandbox before live billing |

Break-even template (a formula, not a claim): `required additional confirmed bookings per month = plan price /
(average ticket x contribution margin on a booking)`. As an arithmetic illustration only, with a booked
ticket of $300 and a 40% margin, $299 requires 2.5 bookings, $799 requires 6.7 and $1,999 requires 16.7.
**These ticket and margin inputs are illustrative, not evidence.** The owner must supply their own, the
shop's baseline must show whether those bookings would otherwise have been lost, and the claim must remain
labeled owner-provided.

## 12. Experiments, willingness-to-pay interviews and pilot metrics

No live price experiment is run while Founder Pilot is the approved catalog. Everything below is
**research with prospects and pilot accounts**; none changes a displayed price.

### 12.1 Willingness-to-pay interviews

Target: 15 to 20 owner interviews across at least three segments (solo mobile, small staffed shop, larger
multi-bay shop), mixing pilot and non-pilot owners. Run after each has seen the product, never before they
understand what it does.

- Value first: "Walk me through the last inquiry that took longest to answer. What did it cost you?"
- Van Westendorp price-sensitivity questions on the total monthly workspace price: too cheap to trust, a
  bargain, getting expensive, too expensive.
- Gabor-Granger for the three plans at $199, $299, $399, $499, $799.
- Unit-price reaction: standard outcome $1, qualified lead $5, confirmed appointment $10, voice $0.35 versus
  $0.46, with the cap explained. Ask which units they would not accept.
- Comparison stack: what do they pay now for CRM, texting, answering, scheduling; what would Gradia replace.
- Procurement: who approves, what annual commitment is tolerable, whether they prefer ACH.
- Record exact words, role, size, channels and evidence class. Disclose that the prices are hypothetical;
  do not present proposed prices as available.

### 12.2 Experiments (no price change to production)

| Experiment | Question | Method | Decision rule |
| --- | --- | --- | --- |
| E1 Allowance sizing | Is 180 / 500 / 1,300 outcomes the right allowance? | Pilot ledger: outcomes per account per period | Set allowance near p75 usage while stress margin holds |
| E2 Outcome cost | Is p95 outcome cost below 35c? | Ledger | If not, shrink allowance or reprice before any sale |
| E3 Voice price band | $0.35 versus $0.46 | Interview exercise, not live test | If majority reject $0.46, decide D-3 |
| E4 Outcome-credit bundle | Do owners prefer typed meters or a single credit pool? | Prototype comparison in interviews | Choose the simpler explanation that preserves non-stacking |
| E5 Annual prepay | Does 10% off earn annual commitment? | Interview intent plus pilot renewal conversation | Keep only if intent and margin hold |
| E6 Forecast clarity | Do owners understand range forecasts and caps? | Usability test of a mockup | Comprehension of 80% or more before shipping the moments in section 8 |
| E7 Implementation pricing | Are $500 / $1,800 / $3,500 accepted and profitable? | Track actual hours in pilot onboarding | Adjust hours-based formula |

Any experiment that would show different live prices to different customers is **out of scope** until a
founder-approved catalog v2 and a documented fairness and disclosure rule exist.

### 12.3 Pilot metrics to collect now

From `GRADIA_GTM_SALES_MASTER.md` section 22, with pricing focus: included-unit utilization by meter,
overage-cap warnings and holds, outcome/voice/SMS wholesale cost and customer price, contribution margin by
account and meter, support minutes per account, unknown-outcome rate, manual-completion rate, active operator
seats by role, active agents per account, time to first verified outcome, day-30/60/90 retention intent,
failed payment state, and ledger-to-Stripe variance. Add: forecast-moment impressions and what owners chose
(accept, decline, raise cap), and any complaints about billing clarity.

## 13. Dependencies and what must be true before catalog v2

1. Pilot cost evidence: p50/p95 outcome cost and at least one full period of voice and SMS wholesale costs.
2. Commercial billing complete and accepted (`COMMERCIAL_SETTLEMENT.md` follow-on): period binding to the
   exact Stripe subscription period, adjustment records, signed webhooks, reconciliation, dunning,
   cancellation, refund and credit policy, Stripe test-mode acceptance.
3. Tax treatment decided (Stripe Tax would add about 0.5% of revenue, or $0.50 per transaction by API).
4. Support hours, severity levels and escalation owner defined.
5. Public offer name decided (the readiness plan requires replacing "Founder Pilot" without silently
   changing price or margin gates).
6. Voice acceptance (real-call, forwarding, escalation, consent, number continuity) complete before any
   voice minute is sold.
7. Catalog and manifest are updated in a separate, reviewed code change; this document authorizes none.
8. Margin gate rerun against live provider prices on the date of activation, as the approved catalog
   requires.

## 14. Exact founder decisions needed before catalog v2

| ID | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| D-1 | Adopt the 299 / 799 / 1,999 / 3,000+ ladder as the target, or return to 199 / 499 / 999 with tighter allowances | Proposed ladder; planned ladder; other | Adopt the proposed ladder as the *target* only after pilot evidence confirms outcome cost |
| D-2 | Included allowances | Recommended; Lean; Balanced | Recommended (Balanced and Generous fail stress) |
| D-3 | Variable voice/SMS rule | Voice $0.46 versus keep $0.35; margin definition before or after payment fees; SMS 3.33x versus 3x | $0.46 and cost/0.30 under the catalog definition; revisit after interviews. If $0.35 is kept, record the 60.7% exception |
| D-4 | Margin case definitions | 15c minimum outcome cost, midpoint costs, phone-number counts | Confirm or replace after pilot ledger |
| D-5 | Seat prices and counts | $39/$35/$29; 4/10/25 | Accept; adjust counts freely |
| D-6 | Active-agent slot price and support allocation | $59/$49/$39 | Measure first; accept provisional |
| D-7 | Implementation packages and loaded hourly rate | $500 / $1,800 / $3,500; $100/h | Confirm the rate, then accept |
| D-8 | Support tiers and SLA language | Section 6.2 | Name hours and owner; defer any uptime figure |
| D-9 | Annual allowance model | 10% prepay; pooled annual allowance versus monthly non-rollover | 10% prepay, no pooling |
| D-10 | Discount authority levels | L1 5%, L2 10%, L3 15% | Accept; stress floors 62% and 60% need explicit acceptance |
| D-11 | Grandfathering and notice period | 12 months, 60 days' notice, no auto-migration | Accept |
| D-12 | Consulting-firm relationship and disclosure | Referral, separate contracting, shared staff | Separate contract and written disclosure |
| D-13 | Sales compensation structure | Section 10 principles | Defer amounts until 10 accounts have settled |
| D-14 | Expansion moments | Which of the seven ship, owner forecast cap rules | Ship 1, 2, 3 first; 4 with voice; 5 only as readiness explanation; 6 and 7 when real |
| D-15 | Location add-on price signal | $249 | Design-only until scope decision |
| D-16 | Tax, dunning, refund/credit authority, public name | open items in GTM master | Resolve before billing acceptance |

## 15. What this document did not do

No code, migration, provider call, Stripe call, checkout, sales-page, manifest, deploy, shared-data or
production change. No customer was contacted. No price here is approved or may be quoted. The live
`approved-commercial-catalog.ts` and its tests are untouched. All third-party figures are as shown on the
cited vendor pages on 2026-11-16 and may change; several vendor pages were read through
an automated text-extraction step and need human confirmation before any external citation.
