# Post-MVP ideas and unresolved commercial questions

Preserved 2026-09-24 from the handoff register and accessible conversation
titles. This file is not MVP authority. The five September 11 documents decide
the sellable MVP. Assistant suggestions and raw notes are not approvals.

Classification: **APPROVED MVP** is required and may still be unbuilt.
**ARCHITECT FOR LATER** keeps a compatible contract. **POST-MVP IDEA** is not
scheduled. **FOUNDER DECISION REQUIRED** is an unresolved commercial or legal
choice. **SUPERSEDED** was replaced on September 11.

Raw notes stay at `/Users/harryhatch/Gradia/_docs/IDEAS_NOTES.md` and in the
handoff copy `ORIGINAL_IDEAS_NOTES.md`. Those files can be stale. Do not turn
them into tickets from this register.

## Highlighted future direction: Gradia Super Agent

> **FOUNDER-REQUESTED FUTURE PRODUCT — October 15, 2026.** A Gradia Super
> Agent with cloud browsers and reusable skills that can work across the business.
> The owner sets the goal: **“Do X using Y, and give me Z.”** This is a highlighted
> future direction, not an addition to the current MVP or a claim of live capability.

The vision is broader than the lead-to-booking loop: an owner can delegate research,
management and recurring business work from a side dashboard inside Gradia. Cloud
browser sessions let the Agent work with permitted websites and business tools;
connected APIs and reusable skills handle supported tasks. The aim is broad business
coverage, with each assignment explicit about what it can access and do—not a
promise that every website or task will be supported immediately.

**Implementation update — October 15:** the founder subsequently approved starting
an experimental digital-employee feature with Claude behind the Gradia interface.
The first slice is job-brief setup and storage; cloud browsing and job execution
remain subsequent work. See [Super Agent architecture](../architecture/GRADIA_SUPER_AGENT.md).

### Side dashboard: set up an agent for a business outcome

An **Agents** panel lets the owner create, configure and monitor multiple named
assignments, all powered by the same Gradia Agent and shared permission system.
They are configurable jobs and skill bundles, not separate customer identities or
unrestricted agents with separate business memory.

Each setup captures:

- **Goal:** the job to accomplish and what counts as finished.
- **Inputs and access:** business context, connected accounts, permitted websites,
  files and skills the assignment may use.
- **Trigger:** run once, run on a schedule, or respond to an approved event.
- **Actions:** research only, prepare drafts, or perform specifically permitted
  changes; identify which actions need owner review.
- **Deliverable:** a shortlist, report, draft, proposed update, completed change or
  notification, including where the owner receives it.
- **Limits:** time/spend budget, stop conditions and who handles a blocked step.

Each assignment card shows its next run, progress, last result, source links,
completed actions and anything awaiting approval. The owner can pause, edit or stop
it. A browser task that needs a login or human intervention returns a clear handoff;
it does not silently report success.

### First examples to explore

| Assignment | X: what it does | Y: what it uses | Z: what the owner receives |
| --- | --- | --- | --- |
| Google Business Profile manager | Review profile information, identify outdated details, prepare posts and review replies, and apply authorized updates | Connected business profile, shop hours/services, approved brand guidance and browser/API skills | A weekly profile report, drafts to approve and a record of completed updates |
| Grant finder | Research relevant business grants, screen likely eligibility and track application deadlines | Business location, ownership/business criteria supplied by the owner, official grant sources and research skills | A sourced shortlist with amounts, deadlines, eligibility uncertainties and a document checklist; application drafts when requested |
| Business operations researcher | Compare suppliers, products or services against the owner's criteria | Approved websites, specifications and budget | A comparison with sources, costs and a recommendation for review |
| Recurring business assistant | Run a configured checklist and flag exceptions or unfinished work | Permitted Gradia records, connected tools and reusable workflow skills | A recurring digest of completed work, exceptions and decisions needed |

Grant matches are research leads, not guarantees of eligibility or awards. Research
and preparation do not automatically authorize application submission. Profile
publishing, external messages, purchases and other consequential actions follow the
assignment's explicit permissions and approval requirements.

### Building blocks for the future product

Cloud browser sessions should be isolated by business, with account access kept
secure and activity traceable. Skills should have defined inputs, allowed actions
and outputs so an owner can reuse a workflow without granting unrestricted access.
Scheduled work needs durable progress, safe retries, budgets and visible failure
recovery. Website content must never grant new permissions or override the owner's
instructions. Completed work should link to evidence, and uncertain outcomes should
remain visible rather than trigger duplicate actions.

Start later with a few verified templates—Google Business Profile and grant research
are the founder's examples—then expand the configurable agent catalog. This future
panel does not replace the current MVP's Agent, approvals or business records.

## Preserved ideas

| Idea | Disposition | Notes |
| --- | --- | --- |
| Gradia Super Agent: cloud browsers, skills and configurable business assignments | FOUNDER-REQUESTED FUTURE PRODUCT | Highlighted above; Google Business Profile management and grant research are initial examples. Not current MVP |
| Shop-aware Agent across CRM | APPROVED MVP, bounded | Controlled tools, audit, approved feedback |
| Structured memory of customers, services, staff, capacity | APPROVED MVP for structured context; broader relationship modeling ARCHITECT FOR LATER | Prices and availability stay canonical records |
| Durable individual lead workflow | APPROVED MVP | Arbitrary long-running business goals are POST-MVP IDEA |
| Learning from owner/manager corrections | APPROVED MVP | Reviewed publication only. No self-modifying code |
| Clear action cards with what, why, and evidence | APPROVED MVP | Do not expose implementation internals |
| 5–10 controlled pilot shops | APPROVED MVP cohort | Extra numeric KPI targets are proposals unless a later approval is found |
| One active location or mobile service area | APPROVED MVP | Multi-location routing is ARCHITECT FOR LATER. Keep location identifiers |
| Owner, manager, and staff identity | APPROVED MVP | Seat prices and full-versus-restricted allowances are FOUNDER DECISION REQUIRED |
| “Works for you” outcome language | Direction for copy | Not a license to claim unaccepted channels |
| Chief of Operations | Same screen as Chief of Staff | Do not build a second dashboard |
| AI lead finder for fleets and prospects | POST-MVP IDEA | Explicit request in “Current Gradia MVP Build”. Separate from fleet-account operations. Reviewed outreach only |
| Fleet campaigns and prospect research | POST-MVP IDEA | Consent, provenance, and delivery controls before any activation |
| Multimodal vehicle walkaround and photo options | POST-MVP IDEA | Voice notes already enter the same Agent. Photo quoting is not launch scope |
| Duration prediction, capacity forecasting, digital twin | POST-MVP IDEA | Needs measured outcomes. Do not fabricate metrics |
| Agent-to-agent business coordination | POST-MVP IDEA | Procurement and subcontracting. Keep permission boundaries |
| Developer platform and other verticals | POST-MVP IDEA | No launch marketplace |
| Conversational setup that drafts menu, hours, or rules | POST-MVP IDEA | Never silently publish sensitive changes |
| Advanced analytics and forecasting | POST-MVP IDEA | Truthful operational summaries are MVP. Campaign analytics are not |
| Multi-model routing and automatic fallback | ARCHITECT FOR LATER / POST-MVP | Keep the current model setup |
| Privacy-preserving aggregate learning | POST-MVP IDEA | No cross-shop operational memory |
| Deeper technician workforce management | POST-MVP IDEA | MVP is assignment, progress, and capacity only |
| Payments and POS | FUTURE PRODUCT, not current MVP | Founder wants deposits, invoices, and in-person card capture later. Not authorized in the pilot |
| Full work orders | FUTURE PRODUCT, not current MVP | Founder confirmed 2026-09-24: the job after booking is a later Gradia system. Not in the pilot |
| Win-back campaigns | FUTURE PRODUCT, not current MVP | Founder confirmed 2026-09-24. A reviewed outreach to past customers. Not the one-customer follow-up in the MVP |
| Google review request texts | FUTURE PRODUCT, not current MVP | Founder confirmed 2026-09-24. Ask a customer for a Google review after the job. Not in the pilot |
| On-the-go owner Agent | FUTURE PRODUCT, not current MVP | Founder confirmed 2026-09-24. Owner texts a Gradia number, or talks in an app the way Meta Muse works. Same Agent and approvals. Not a second bot |
| Fleet accounts | DESCRIBED, not current MVP | A multi-vehicle business customer. Not scheduled and not the same as the lead finder |
| Memberships | NOT APPROVED | Needs a separate scope decision |
| Jobber connector | Historical adapter | Live acceptance unverified. Do not show it as working |
| Housecall Pro and Slack approvals | SUPERSEDED | Do not revive |
| Voice-first v1 that excludes SMS and Meta (D-069) | SUPERSEDED 2026-09-11 | Pilot is SMS, website, and Meta. Voice is required for the full five-channel MVP |
| Automatic customer-action defaults (D-068) and named agent roster (B-18) | SUPERSEDED 2026-09-11 | Approval-first matrix. One Agent, internal skills |
| Staff-only ICP and blanket exclusion of any location or assignment (D-067) | SUPERSEDED 2026-09-11 for that exclusion | Solo and staffed shops. One location. Full work orders stay out |

## Six long-term directions

From the raw idea notes, kept as POST-MVP IDEA, not a roadmap:

1. Ongoing assignments that last weeks, beyond the individual lead loop.
2. Multimodal capture while walking a vehicle.
3. Prediction and optimization of duration, capacity, and outcomes.
4. An operational “what if” model with explicit assumptions.
5. Agent-to-agent coordination with other businesses.
6. A developer or partner platform and other verticals.

The AI fleet lead finder is an additional explicit POST-MVP IDEA, not one of
those six and not part of fleet-account operations.

## Founder commercial decisions — 2026-09-24

**No free trial.** Founder decision in the Cursor session the same evening:
there is no GTM budget for a trial, so do not offer one. Delete the idea of a
14-day free trial from anything presented as current. If a trial is ever
reconsidered, it may expose manual shop tools only. It must not include the
Agent, voice, SMS, email sending, or other model spend. That exception is not
authorized now.

**Payments and POS are a future product, not this MVP.** The founder wants
Gradia to take shop payments later: deposits, invoices, and in-person card
capture (a point of sale). That does not authorize Stripe Connect, charging
cards, or a payments build in the current pilot. Scheduling it still needs its
own scope decision when the lead-to-booking loop is accepted.

**Win-back campaigns and Google review texts are future products, not this
MVP.** Confirmed 2026-09-24. A win-back campaign is a reviewed message to past
customers who went quiet. A review request asks a customer to leave a Google
review after the job. The MVP still includes one-customer follow-up only:
confirmation, reminder, and check-in for the lead already in play. These two
sends need their own consent and opt-out rules before any build.

**On-the-go owner access is a future product, not this MVP.** Confirmed
2026-09-24. The owner can run Gradia from the bay or the truck in either of
two ways: text a Gradia number, or talk inside an app the way Meta Muse works.
Both reach the same Gradia Agent. They do not create a second assistant.
Approvals, consent, and the shop's rules still apply. This is the owner
operating the shop, not a customer marketing channel. It is not authorized
in the pilot.

Monthly prices and seat counts are still not chosen. Older $20/$29 and
$99/$149/$249 figures are not approval. PR #38 does not set price. How many
owner, manager, or staff seats a plan includes is still open. Core, Pro, and
Operator may share one permission model later; entitlements are not confirmed.
Privacy/legal retention review is still required before production cleanup.

## What fleet accounts and work orders are

These stay out of the current MVP. They are described here so later sessions
do not invent a different meaning.

A **fleet account** is a business customer, not one vehicle owner. A rental
company, dealer, or mobile operator has many vehicles, one billing contact,
and repeating work. Gradia does not have that company record, shared billing,
or fleet scheduling today. The separate post-MVP idea of an AI lead finder
that prospects fleets is not the same thing as operating a fleet account.

A **full work-order system** is a future Gradia product, confirmed by the
founder on 2026-09-24. It is the job after the appointment is booked: assign
a technician, list the steps, track parts and photos, mark the job started
and finished, and hand it to an invoice. The approved MVP keeps only a
lightweight assignment and completion note on the booking. The future system
is not authorized in the pilot. It does not include bays or payroll until a
later scope decision says so. Payments and POS sit after that job and are
also future, not current.

## GTM notes that are not product requirements

Brayden’s sales focus, in the KPI planning conversation, is daily outreach and
converting interested detailers into the 5–10 shop pilot. Copy should lead with
customer outcomes. Suggested posting cadence and comprehension percentages from
assistant drafts are not KPIs. Potential quote value is not collected revenue.
This repository does not send outreach.

## Inaccessible sources

Conversation titles and IDs are listed in the 2026-09-24 handoff
`IDEAS_AND_SOURCE_REGISTER.md`. Older pages of those tasks, ChatGPT attachments,
private Claude history, and the full historical websites were not recovered.
No missing conversation text is invented here.
