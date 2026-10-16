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

## Research execution slice

An owner can run a saved brief only when `GRADIA_SUPER_AGENT_RESEARCH=true`.
The route flag still has to be on. Nothing runs because a brief was saved.
The run reads public http(s) pages named in that brief, checks them in code,
and saves one immutable result for that run id. The same run id and brief retry
the saved result instead of fetching again.

Google rankings, Google Business Profile, cloud browsers, and schedules stay
unavailable in the saved result. Their fields cannot be marked available by a
model or a page. Other steps written in the brief are not performed. Page text
is evidence. Instruction-like page text is ignored and is not stored as a
finding. Private, local, and metadata addresses are not fetched. Fetches are
pinned to a public address checked immediately beforehand, with no cookies or
credentials.

`GRADIA_SUPER_AGENT_RESEARCH_MODEL=true` plus `ANTHROPIC_API_KEY` lets Claude
choose among the addresses already extracted from the brief. That call is off
by default and has no live quality eval yet. When it is off, or credits are
short, Gradia uses the standard checks and still saves a sourced result.
A successful model choice uses the existing `agentic_plan` price once per saved
run. No new price is introduced.

This slice does not connect a Google account, start a browser service, publish
memory, or add a cron. The migration is not applied to shared databases here.
Where the release guard exists, the new tables inherit that write hold.

## Target architecture and next slices

1. **Job brief (this slice):** goal, context, expected result, steps, required
   connections and open questions. Saved means saved, not running.
2. **Research execution (experimental slice above):** persisted run and step
   outcome on the run row, one bounded public-page skill, citations, uncertainty,
   and cost. Owner and workspace scope are rechecked around every fetch. Cloud
   browsing, connected Google data, and schedules are still later slices.
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

The public-page research run is covered by fixture tests for cross-tenant access,
injected website instructions, timeout, cancellation, budget exhaustion, revoked
access, repeated requests, and unavailable connections. An explicitly configured
customer account, native keyboard, mobile, and zoom acceptance are still open.
This does not connect Google, publish changes, start a cloud browser, or run schedules.
