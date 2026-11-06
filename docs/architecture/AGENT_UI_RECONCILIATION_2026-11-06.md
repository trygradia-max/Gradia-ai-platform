# Agent UI reconciliation

_Reviewed 2026-11-06 against current `main`. This change corrects information
architecture only. It does not activate the legacy workflow builder, create a new
agent schema, call a provider, enable cron, deploy or lift a production gate._

## Current decision

`/agents` is the canonical Gradia Agent OS home. The voice receptionist is one
playbook/channel of Gradia, not the top-level product model. The sidebar therefore
links to **Gradia Agents**, `/agents` renders the existing authorized agent overview,
and `/agents/build` is the canonical builder address.

The existing self-serve workflow builder remains gated by
`FEATURES.workflowBuilder = false`. It persists the legacy mutable `custom_agents`
configuration and can enable the existing scheduled runtime. It is not the approved
seven-step immutable definition builder and must not be presented as one.

## Draft PR audit

- PRs #85, #86, #90 and #92 implemented a parallel Super Agent/employee schema plus
  separate research, browser and memory stores. They conflict with one primary
  Gradia Agent, the merged Control Center, durable lifecycle and reviewed-memory
  contracts. They were closed without merging; history remains available.
- PR #91 was superseded. Its channel-readiness/onboarding work reached `main`
  through later integrations and its remaining loopback callback behavior shipped
  in PR #96.
- PRs #52 and #53 were preservation WIPs from an old application tree. Later
  reviewed PRs selectively integrated the app shell, inbox, CRM, quote, pipeline
  and navigation work. Direct merge would overwrite newer tenant, delivery and
  Agent OS behavior, so the WIPs were closed while preserving their branches.
- The marketing repository's current `main` already contains the newer truthful
  pilot-recruitment site. The old `site-v2` branch has no commits ahead of current
  marketing `main`, and superseded `$20`, Founding 100 and July-launch claims are
  absent from the current site.

## Required before enabling the builder

1. Persist immutable employee-definition revisions with one atomic active pointer.
2. Return the reviewed memory, tool/readiness, effective-policy, budget and
   evaluation DTOs required by the seven approved builder steps.
3. Wire first activation through the reviewed Founder Pilot subscription gate.
4. Add the seven-step UI: Job, Knowledge, Tools, Limits, Schedule, Test, Activate.
5. Prove owner activation, manager/staff denial, two-active-agent entitlement,
   revision immutability, dry-run non-effect and truthful blocked/unknown states.

Until those prerequisites land, configuration and testing may remain available in
reviewed development lanes, but production activation stays fail closed.
