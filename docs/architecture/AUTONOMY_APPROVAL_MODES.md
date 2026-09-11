# Autonomy and approval modes

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

The Gradia Control Center applies **READ → SUGGEST → APPROVAL REQUIRED → AUTONOMOUS**
at connector and individual operation level. These are permissions to attempt a
bounded operation, not a promise that every attempt will execute.

| Mode | Meaning |
| --- | --- |
| READ | Read permitted data only; no domain mutation, proposal queue write or customer communication |
| SUGGEST | Produce a private suggestion/draft; do not queue an executable action until an authorized operator explicitly stages it |
| APPROVAL REQUIRED | Stage an actionable proposal; authorized human reviews exact recipient/content/changes before execution |
| AUTONOMOUS | Execute only within explicitly granted operation rules through the same guarded executor, with complete audit |

**Off** remains a separate disable/kill switch, stronger than READ. Disabling outbound
SMS must not stop mandatory STOP processing. Emergency control must distinguish
connector ingestion from business automation; essential suppression/security event
processing stays active when transport callbacks are accepted. Fully disconnected
connectors cannot provide events and must show that limitation.

Legacy naming is mapped explicitly: old **Assist** corresponds to READ/SUGGEST
according to whether drafting is enabled; old **Approval/HITL** maps to APPROVAL
REQUIRED; old **Custom** means a composition of scoped rules, not a fifth authority
level. Current code's `suggest` already stages approvals, so migrate it to APPROVAL
REQUIRED rather than silently reinterpreting it as the new SUGGEST behavior.
Existing settings stay conservative until an owner reviews the translated policy.

### Policy resolution

Proposed policy inputs: trusted workspace, connector connection, capability/action,
location, actor role, risk, exception conditions and policy version. Store explicit
inheritance separately from a chosen mode. A connector setting is a maximum allowed
mode; individual operations may be stricter. Workspace default fills gaps; an
explicitly reviewed action grant may differ from that default but cannot defeat
workspace ceilings, connector caps, role permissions, location restrictions or
non-bypassable safety rules. Conflicting restrictions resolve to the stricter mode.
Unknown action, missing scope or policy read failure denies execution and explains
why. A grant is not inferred from past approval rates.

Evaluation order, shared by manual and automated entry points:

1. Authenticate actor/integration; resolve workspace, active membership and location.
2. Apply disabled flags, entitlements and capability permission. A pricing entitlement
   never itself authorizes sending, and this document changes no packages.
3. Validate all tenant/parent references, current destination and operation schema.
4. Enforce non-overridable consent/suppression, channel readiness, safe classification,
   quiet hours, financial and booking invariants. Approval cannot bypass these.
5. Resolve explicit action grant/inheritance against connector/workspace/role/location
   ceilings and risk/exception rules. An exception may tighten to approval/deny;
   loosening requires a recorded authorized grant within all hard constraints.
6. Stage, suggest or execute. Re-evaluate at execution against current membership,
   policy and context; record both staged and effective policy versions.
7. Claim stable action/proof identity atomically before external execution. Record
   outcome and delivery uncertainty. Retries do not recreate consumed authority.

A manager approving an action cannot implicitly enable autonomy for future actions.
Editing the message, destination, workflow context or booking invalidates stale
approval/proof. Bulk approval must still evaluate each recipient and action.
Role revocation or a connector being switched Off while an action waits blocks it.

### Example shop configuration (explicit opt-in, not launch defaults)

| Connector / action | Example mode | Additional guard |
| --- | --- | --- |
| SMS / capture lead | AUTONOMOUS | Signature/replay checks, canonical identity; intake does not grant marketing consent |
| SMS / set appointment | APPROVAL REQUIRED | Authorizes neither separate booking nor confirmation without their own policies |
| SMS / nurture | AUTONOMOUS | Destination-bound marketing consent unless valid service context; suppression/quiet hours/cooldown |
| Email / reply | APPROVAL REQUIRED | Thread/customer/destination binding and current channel consent |
| Meta / import lead | AUTONOMOUS | Verified page/workspace binding and replay; form proof must support later outreach separately |
| Calls / answer and qualify | AUTONOMOUS | Approved factual scope, identity uncertainty handling, human escalation |
| Calls / outbound follow-up | APPROVAL REQUIRED | Separate capability, readiness and contact rules; not part of initial launch loop |
| Booking / normal open slot | AUTONOMOUS | Explicit shop grant, service/menu duration, location/staff capacity and serialized conflict check |
| Rescheduling / confirmed appointment | APPROVAL REQUIRED | Ownership, customer intent, new availability, impact and notification review |
| Quoting / menu price | APPROVAL REQUIRED initially | Shop may explicitly grant menu-only autonomy after implementation and review |
| Quoting / discount | APPROVAL REQUIRED | Approved limit; beyond-limit requests cannot use generic CRM mutation to bypass it |
| Follow-up / reminder | APPROVAL REQUIRED initially | Service proof, current booking, once-only transport and quiet hours |
| CRM / note or stage change | Explicit per-action grant | Role, owned record, stage transition and audit; merge is a separately controlled destructive operation |
| Campaigns / segment send | APPROVAL REQUIRED minimum | POST-MVP: reviewed audience snapshot plus per-recipient marketing consent and caps |

A compound “book and text” evaluates booking AND SMS confirmation, independently.
If the booking succeeds and the message is held, show “booked; confirmation held.”
Do not roll back a valid booking or create a second one to retry its notification.
A nurturing approval does not grant a booking action, and a connector's autonomous
capture setting does not grant autonomous outreach.

## ARCHITECT FOR LATER

Use one explainable policy evaluator and versioned rules, not independent checks in
every UI. Preserve workspace/connector/capability/location/role/risk/exception scope
now even if the first UI offers fewer override controls. Policies must be inspectable
as “effective mode because …”, with a preview of which actions a change affects.
Location delegation, bounded discounts and richer exception rules can build on this.
Use a finite, validated rule vocabulary, not executable scripts or prompt clauses.

## POST-MVP

Advanced policy simulations, fine-grained campaign approvals, automatic experiments
and multi-location delegation follow operational use. Trust can recommend a setting;
it never auto-promotes permission. No unconstrained Custom mode and no approval
option for contacting a suppressed/DNC recipient.

## EXISTING SUPPORT

`src/lib/autonomy.ts` has default/per-agent `suggest|autonomous`, package gating and
`ALWAYS_HITL` for booking, reschedule, cancellation and quote creation. `trust.ts`
records approval resolution and recommends eligible changes. `approvals.ts` has the
atomic execution boundary. `send-policy.ts` and **pending PR #44** provide shop- and
destination-bound SMS/email permission checks and durable service-purpose claims.
Catalog `automations.ts` has a separate autopilot model that must use the same policy.

## ARCHITECTURAL GAPS

There is no full connector/action/location/role policy representation or common
resolver. Current two modes cannot express READ, private SUGGEST and explicit
APPROVAL separately. Manager authorization and policy-change audit need implementation.
Direct tool writes and catalog automation are potential alternate paths until covered.

D-021/`CLAUDE.md` blanket money/calendar HITL and D-068 default auto-booking conflict
with each other and this new explicit-grant model. **Current hard floors remain in
code**; normal-booking autonomy is a planned, narrowly specified policy change with
locking tests, not permission to remove the existing tests. D-068's “contact opted-out
records always asks” must never be implemented as approval permitting contact.
The approved P0 consent defaults win. “Inbound = consent” is not a marketing rule.

## FOUNDER DECISIONS

Approved: action/connector configuration and approval-first customer-facing defaults;
shops can explicitly enable bounded autonomy. Open: which managers can approve versus
change policy; discount bands and other risk limits; whether confirmed reschedules
remain permanently human-reviewed or support a later tightly bounded opt-in. Proposed
MVP default: owner manages grants, manager handles delegated approvals, staff cannot
elevate permissions. No billing/seat-price decision is implied.

## ACCEPTANCE CRITERIA

- Table-driven policy tests exercise every scope, inheritance, conflicting settings,
  unknown inputs and policy outage; no missing setting creates autonomy.
- Given the example shop, SMS nurture can run while appointment setting waits; a
  discount waits independently of a normal booking. Each action explains its mode.
- Revocation, STOP, changed content/destination and expired proof between staging and
  execution block transport. Proof races/retries retain PR #44's one-send guarantees.
- Owner, manager, staff, MCP, webhook and cron paths cannot bypass effective policy.
- An edited/rejected draft records feedback but changes neither policy nor consent.
- Existing code floors are preserved until a reviewed replacement rule and equally
  strong regression coverage are implemented and accepted.
