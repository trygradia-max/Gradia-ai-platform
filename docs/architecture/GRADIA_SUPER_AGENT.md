# Gradia Super Agent — digital employees

Founder approved starting an experimental implementation on October 15, 2026.
This expands the future-product direction; it does not claim the existing MVP is
finished or authorize public launch, provider activation or business-account changes.

## Product language

The user sees **Gradia Super Agent** and **Digital employees**. They describe a job,
what the employee should know and what it should deliver. Example: “Help my detailing
business show up on Google. Give me a prioritized list of problems and improvements.”
Templates are starting points, not a fixed list of permitted business goals. A user
can describe a custom role. Claude is the reasoning provider behind Gradia; users do
not configure model names, tool calls or an orchestration framework.

## Implementation in this slice

The experimental `/employees` page builds editable job briefs and lists the owner's
saved drafts. Google/SEO, grant research and general research templates are included.
An optional Claude planning call turns free text into a strictly validated brief.
Owners can also write briefs without calling a model. Existing pricing, credit checks
and burst limiting apply to the optional model call; no new pricing is introduced.

Briefs are immutable, tenant-scoped records in `super_agent_employee_drafts`.
The same save ID and payload can be retried after an interrupted response. Neither a
model output nor a saved brief grants execution authority. Only owners can read/create
briefs in this first slice. These records are working instructions supplied by an
owner, not published memory, verified business facts or consent.

`NEXT_PUBLIC_GRADIA_SUPER_AGENT=true` enables this experimental route/navigation.
`GRADIA_SUPER_AGENT_PLANNING=true` separately enables Claude-assisted setup.
Both default off. The migration is not applied to shared databases by this change.
If applied where the release guard exists, the new table inherits that write hold.

## Target architecture and next slices

1. **Job brief (this slice):** goal, context, expected result, steps, required
   connections and open questions. Saved means saved, not running.
2. **Research execution:** introduce persisted run/step/outcome records and one
   bounded research skill. Claude can choose research steps within the authorized
   goal. Save citations, uncertainty, costs and a report. Separate generated claims
   from verified evidence. Recheck owner/workspace scope on every run.
3. **Cloud browser:** select and configure an isolated browser service behind a
   Gradia adapter. Bind sessions to a workspace and connected account; expose only
   authorized tools. Handle login/MFA with user handoff. No shared credentials,
   arbitrary local shell, implicit access to the developer machine or fabricated
   browser success. The current app has no cloud-browser adapter from this slice.
4. **Connected skills:** Google Business Profile read/audit first, then proposed
   changes with exact-target review. Researching grants is separate from submitting
   applications. Publishing, messages, purchases and account changes need explicit
   capability/approval contracts and existing execution authority where applicable.
5. **Durable operation:** per-run budgets, cancellation, scheduling, leases, safe
   retry rules and unknown-outcome review. Do not route arbitrary jobs into the
   existing fixed-recipe CRM cron. Do not offer “always on” until this works.
6. **Gradia memory:** retrieve current authorized business records and approved
   memory through the existing memory architecture. Keep run evidence separate
   from reusable learned instructions. New lessons enter candidate review; never
   silently publish a model-generated rule or widen tenant/member access.

“Free roam” means flexible problem-solving and tool selection within the employee's
assigned workspace and authority, not a hard-coded recipe for each goal. Retrieved
websites and documents are evidence, never permission to act. The UI should show
what the employee can currently do, what it needs connected, what was actually done,
and what is waiting for the owner. No unsupported capability should appear active.

## Acceptance still required

First running employee: a sourced SEO/Google audit or grant report against disposable
fixtures and then an explicitly configured account. Tests must cover cross-tenant
access, injected website instructions, timeout, cancellation, budget exhaustion,
revoked access, repeated requests and unavailable connections. Real browser keyboard,
mobile and zoom acceptance remains separate from server rendering and unit tests.
This slice does not execute research, connect Google, publish changes or run schedules.
