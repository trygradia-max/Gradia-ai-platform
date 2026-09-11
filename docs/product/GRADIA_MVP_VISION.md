# Gradia Agent MVP vision

> Planning baseline: `main` at `20e153a8ac7b55bc682e5a49c6e9486ac51e9ae5`, plus
> verified draft [PR #44](https://github.com/trygradia-max/Gradia-ai-platform/pull/44)
> at `3b99bf4b5d9022a248bd1716fe2b070d8ae455f5`. PR #44 is **pending, not merged**.
> This documentation branch starts at that reviewed head to describe its safety
> boundaries accurately; inherited changes are not new documentation-phase implementation.
> Source review: 2026-09-10 (local). Static inspection and prior verification are
> distinguished from live acceptance. No production access or live model evaluation.
> The founder's current architecture request governs this proposal where older
> scope documents conflict. Neither the original nor committed `CONTEXT.md` is edited.

## MVP NOW

Gradia is a connected operating system for detailing businesses. The customer
experiences one primary **Gradia Agent**, working through the shop's CRM, calendar,
communications and operating rules. A solo detailer is a one-member workspace; a
staffed shop uses the same product with owner, manager and staff access. The product
must remain useful when every AI action is disabled. A polished chat window without
working operational screens does not meet this definition.

The sellable loop is:

Lead enters → resolve customer and vehicle → qualify → nurture through **Gradia
Whisper** → determine service or quote → check availability → obtain approval when
required → book → update CRM/pipeline → follow up → retain structured Gradia Memory.

“Gradia Whisper” is the proposed customer-facing communications umbrella in this
phase: SMS, email and calls share identity, context, permissions and action history.
Existing voice-note capture remains an input to the same Agent. This does not mean
all channels already work as one conversation or that OpenAI Whisper owns the brand.

| Operational surface | Minimum useful behavior |
| --- | --- |
| Chief of Staff | One operational summary, needs-you queue, approvals, upcoming bookings, assigned work and truthful activity; distinguish proposed, held, executed, delivered and failed |
| Gradia Agent | Persistent ask surface; identify the customer, show proposed changes and why; complete approved capabilities through existing guarded executors |
| Whisper inbox | SMS/email/call context, in-thread reply, handoff owner, unread state, clear delivery/unknown status, consent-aware channel selection |
| Customers and vehicles | Search, create, edit, duplicate review/merge, vehicle association, contact details, notes, communication history, quote/appointment history and next action; export and bounded import |
| Pipeline | Single authoritative stage, accountable owner, next action and due time, quote/booking linkage, no duplicate leads from retries |
| Quotes and calendar | Approved menu pricing, vehicle-dependent duration, conflict/capacity checks, staff assignment and location context, explicit approval for exceptions |
| Team controls | Manager seats and revocable invitations, role permissions, assigned-work view, audit actor identity; solo owner receives the same workflow without team setup burden |
| Control Center | Connector and action controls, effective-policy explanation, per-operation consent/permission gates and workspace kill switch |

Capture enough qualification to book responsibly: requested service, vehicle and
size/condition, desired timing, location, constraints and unresolved questions.
Unknown paint condition or ambiguous identity produces clarification or a manager
handoff, not fabricated facts, prices or availability. A lead is not silently lost
when extraction or a provider fails.

An excellent booking loop includes a lightweight completion outcome and a governed
follow-up, not an entire work-order suite. Staff responsibility and shop capacity
must be explicit; a single global overlap rule cannot represent three people doing
independent jobs. Design for location-scoped operation from the start; the initial
number of active locations remains a launch decision below.

Customer-facing actions default to **APPROVAL REQUIRED** until an authorized shop
owner explicitly enables autonomy for the operation. An inbound message does not
confer blanket marketing consent. STOP, DNC, suppression and destination-bound
permissions cannot be overridden by approval or a more permissive autonomy setting.

## ARCHITECT FOR LATER

Keep Gradia-owned identifiers, explicit workspace/location/actor scope, versioned
policy decisions, stable command IDs and provenance so later services can extend
the loop without replacing it. Specializations are internal skills (qualification,
booking, nurturing, vehicle intelligence, operations), not separate customer agents
with separate data or permissions. Model providers remain replaceable.

Support richer multi-location capacity and resource models through explicit scope,
without adding optimization, routing or workforce management before demand. Keep
communications and model adapters separate from core entities. Capture booking and
follow-up outcomes now so future retention can use verified history.

## POST-MVP

Advanced campaigns/reactivation, complex resource optimization, autonomous outbound
calling, broad CRM integrations and sophisticated analytics follow proven operation
of the individual lead loop. Apply the same action controls when these are added.
No framework migration, microservices rewrite, autonomous code editing or automatic
publication of learned skills. Payments/deposits, fleets, memberships, a full
work-order system, social DMs, photo quoting and native apps are **not approved by
this document**; older excluded items require a separate explicit scope decision,
not an automatic place in a later release. No pricing/package changes are proposed.

## EXISTING SUPPORT

- `src/lib/customers.ts`, CRM server actions/data accessors, first-class vehicles,
  quotes and appointments provide a real domain spine; keep these records.
- `src/app/(dashboard)/dashboard/page.tsx` already renders the Chief of Staff hero,
  approvals and activity. B-03 is implemented despite stale unchecked roadmap boxes.
- `src/lib/owner-agent.ts`, `agent-planner.ts`, `agent-runtime.ts`, `persona.ts`,
  pricing and knowledge helpers provide bounded tools and shared context.
- `src/lib/approvals.ts`, `provider-events.ts`, availability and serialized booking
  protect existing execution. Outbound email exists through Aurinko; missing inbox
  reply is not the same as missing email transport.
- **Pending PR #44 only:** destination-bound permission checks, atomic consent-safe
  customer merge, durable service-proof claims, canonical photo validation and
  tenant relationship constraints. Its green CI does not make it deployed.

## ARCHITECTURAL GAPS

There is no complete normalized intake → durable multi-turn qualification → booking
workflow. `agent-events.ts` handles payment/booking events, not universal lead entry.
`shop.ts` resolves shops by `owner_id`; manager memberships and assignments are not
implemented. Meta Lead Ads and a production-ready public lead-form seam are missing.
The inbox, team operations and action/connector policy matrix need implementation.
Memory retrieval exists, but reviewed structured preferences and rules do not.

Conflicts to retire by explicit follow-up, not bulk rewriting:

| Earlier source | Conflict and treatment |
| --- | --- |
| `CONTEXT.md` §1/§2, D-067 | Staff-only ICP, no solo users, jobs/team scheduling/locations excluded. Current request admits solo and staffed shops; only minimal assignment/capacity/location scope is proposed now |
| Founder D-069 edit / PR #43 handoff | Voice-first v1 excludes SMS/Meta. Current target loop includes them; channel launch gating remains explicit rather than claiming registration/review is complete |
| `CONTEXT.md` D-068 | Default autonomous replies/bookings and several named agents conflict with current approval-by-default, explicitly enabled operations and one primary Agent |
| Historical `PROJECT_BRIEF.md`, `mcp-architecture.md` | Payment-first examples, Slack approvals, direct vendor MCP orchestration and old pricing are not current architecture requirements |

## FOUNDER DECISIONS

**Already supplied:** one primary Agent; Gradia-owned orchestration/data/rules/tools;
replaceable models; solo and multi-person shops; connector/action controls; controlled
learning; no self-modifying code. Approval-first defaults and consent safety remain.

**Still needed before launch:** whether SMS/Meta readiness gates the named sellable
MVP or whether a clearly labeled voice/email pilot precedes it; minimum active
locations at launch; exact manager delegation and staff visibility; operational
response-time/approval-notification targets; acceptance of the manual uncertain-send
reconciliation path. None blocks writing these docs. Do not reopen pricing here.

## ACCEPTANCE CRITERIA

1. In a synthetic solo shop and a three-person shop, the complete loop produces one
   customer/vehicle association, one booking, consistent pipeline state and a linked
   follow-up; replaying intake does not duplicate them.
2. A manager can handle assigned approvals and staff can see only permitted work;
   revoked users lose access to pending actions and stored memory immediately.
3. Agent-off CRM creation/edit/search/merge, pipeline movement, quoting and booking
   work without a model response; identity ambiguity is reviewable.
4. An owner can explain any action from its evidence, applicable rule, policy and
   actor history. A denied action produces no external effect.
5. A customer can opt out between draft and execution and prevent sending. Unknown
   delivery is held for reconciliation, never automatically resent.
6. Channel readiness is shown honestly; blocked SMS/Meta never falls through to a
   different channel without that channel's permissions and consent.

Implementation order: [MVP sequence](../roadmap/MVP_IMPLEMENTATION_SEQUENCE.md).
