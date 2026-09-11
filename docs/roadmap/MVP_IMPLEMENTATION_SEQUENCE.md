# MVP implementation sequence

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

This is a gate-based proposal for the current lead-to-booking direction, not a new
implementation authorization or a claim that PR #44 is merged. It supplements the
older roadmap where the founder's current scope differs. Keep changes small and
reviewable; do not activate tenancy and calendar migrations together. Reuse existing
ticket work after verifying it, rather than rebuilding every old unchecked item.

| Order | Bounded outcome | Reuse / prerequisite | Exit evidence |
| --- | --- | --- | --- |
| 0 | Founder review of draft PR #44 and rollout plan | Existing P0 commits, 69-migration ledger, 26 relationship manifest, 850 unit/156 integration CI evidence | Independent security/migration review; founder separately authorizes merge/deploy; inconsistent data is refused, never repaired silently |
| 1 | Membership and minimum operations scope | `shops`, `shop.ts`, `forShop`, existing appointment/CRM spine | Solo owner and three-person shop; invite/revoke; owner/manager/staff RLS, scoped approvals, assignments and required location identity; additive backfill and tenant tests |
| 2 | Control Center and command authority | Existing approval executor, autonomy and send policy | READ/SUGGEST/APPROVAL/AUTONOMOUS plus Off, explicit action grants, connector ceilings, policy version/audit; all reachable tool paths inventoried; old floors retained until replacement tests pass |
| 3 | Reliable normalized lead intake | Provider event claims, identity/dedupe, import/form adapters | Durable lead event/transition; synthetic duplicate/reordered input and crash recovery; no identity/consent inference; new/ambiguous lead appears in Chief of Staff |
| 4 | Whisper inbox and operational handoff | Interactions, call records, SMS/email transports, existing Chief of Staff | In-thread SMS/email replies, thread context, assignment/unread state, manager approval notification and digest through an independent application-notification adapter; honest held/unknown status |
| 5 | Bounded qualification and nurture workflow | Owner-agent tools, drafter context, planner/runtime recipes | Persisted conversation state; asks missing service/vehicle/timing information; approved per-action nurture; STOP and human takeover interrupt automation; replay does not double-send |
| 6 | Service/quote → availability → booking → pipeline | Existing menu/pricing, quotes, availability and serialized appointment RPC | Menu-grounded quote, duration and capacity; staff/location assignment; approval for exceptions; exactly one booking under concurrency; one linked pipeline update and governed confirmation |
| 7 | Reviewed structured memory and follow-up | Trust resolution, knowledge, interactions, safe merge | Capture draft delta; separate candidate review/publication; next action uses approved rule; consent provenance and rollback tests extend to new references |
| 8 | Connected operational acceptance | All prior gates, channel readiness and model evaluations | Solo and staffed-shop end-to-end walks, failover/hold/recovery drills, no-founder-help setup, traceable summaries, manual CRM with AI Off, explicit release claims |

Implement the narrow model-provider seam while touching a worker in step 5: preserve
its prompt and behavior, validate normalized output and provider metadata, then
expand incrementally. Complete the schema for memory provenance/delta capture when
step 4 edits are introduced; the reusable-rule publication loop lands in step 7.
Do not lose feedback while waiting for the final memory UI.

Step 3 starts with adapters for existing channels and synthetic form/Meta fixtures.
Each new live channel independently passes signature, workspace binding, consent,
readiness and replay gates before activation. SMS registration and Meta review can
run as founder business prerequisites in parallel; this document initiates neither.
Call forwarding/number continuity and a verified inbound call remain necessary for
voice acceptance. “Built” is not “ready to sell.”

Step 6 must resolve Aurinko coupling explicitly: preserve the guarded current path
until a tested native-first path and sync/reconciliation states are ready, or declare
the connected-calendar dependency for a limited pilot. Automatic booking requires
capacity checks at the commit boundary and no unreviewed external busy-time failures.
Do not expand into a full scheduling rewrite to obtain these guarantees.

### Cross-cutting release gates

- Every side effect is actor-, tenant-, policy- and consent-controlled; denial has
  zero provider effects. No alternate model/cron/MCP route bypasses approval.
- Migrations apply from zero on a dedicated disposable stack, verify exact ledger,
  constraints, existing deletion behavior and nullable relationships. Test synthetic
  inconsistent data refusal. New relationships extend an explicit reviewed manifest.
- Unit, database integration, typecheck after build, lint, offline build and targeted
  workflow tests pass; live model changes require their own controlled quality evals.
- Unknown transport outcome remains held with manual reconciliation. Never reissue
  a consumed proof or auto-resend to make a dashboard look complete.
- No unapproved production or provider operations. PR #44 remains draft until founder
  changes its status. This documentation branch is local only. The inherited Vercel
  exclusion names the P0 branch **only**; it does not protect a future push of this
  docs branch. A separate deployment-safety preflight is required before any push.

## ARCHITECT FOR LATER

Sequence role/location scope before new workflow/memory entities, and command/outbox
identity before more autonomous effects. Retain provider/record separation and
versioned memory/policy. Keep capacity extensible without implementing complex
optimization. Introduce additional workers/services only after measured need; no
new universal orchestrator is a prerequisite.

## POST-MVP

Campaigns/reactivation at scale, richer multi-location resource optimization, broad
connector expansion and advanced analytics follow the lead loop. Payments, fleets,
memberships, full work orders and previously excluded features need a separate
founder scope decision; they are not silently revived from E04–E10. Do not change
pricing or packages as part of architecture implementation.

## EXISTING SUPPORT

The proposed sequence reuses B-03 Chief of Staff, B-16 menu/hours onboarding, CRM and
quote/calendar primitives, approval engine, send boundaries, provider replay claims,
agent recipes, trust telemetry and shared memory. PR #44 adds safety prerequisites,
not the complete Agent MVP. Current GitHub verification is evidence for its exact
commit only; no architecture behavior was executed in this documentation phase.

### Evidence register (read before implementation)

| Reviewed source | How used |
| --- | --- |
| Root `CONTEXT.md`, founder-only diff, `CLAUDE.md`, historical `PROJECT_BRIEF.md` and `SHARPENING_BRIEF.md` | Scope precedence, older exclusions, planner/runtime and control invariants |
| `docs/gradia-v2/00-product-principles.md`, `02-target-architecture.md`, `03-domain-model.md`, `10-roadmap.md` | Retain modular monolith/domain spine; distinguish target architecture from built behavior |
| `docs/gradia-v2/program/current-sprint.md`, `backlog.md`, `11-decision-log.md` | Historical sequence/status and conflicting decisions; no auto-promotion of old tickets |
| [PR #43 handoff](https://github.com/trygradia-max/Gradia-ai-platform/blob/docs/handoff-astra/docs/GRADIA_HANDOFF_TO_ASTRA.md) | Read without merging; voice-first scope, missing team/intake/threading and ticket-number collision; historical operational claims not reverified live |
| `docs/gradia-v2/adr/ADR-003-service-role-tenant-scoping.md`, `vendors/registry.md` | Reuse accepted `forShop` mechanism; provider status claims can be stale |
| `docs/outbound-sms.md`, `outbound-email.md`, `mcp-architecture.md`, E03/E07 epics and approval/inbox flow docs | Communications/CRM intent, stale Slack/provider references and inbox gaps |
| `src/lib/owner-agent.ts`, `agent-planner.ts`, `agent-runtime.ts`, `agent-events.ts`, `autonomy.ts`, `trust.ts` | Actual tools, recipe scheduling, event kinds, hard floors and telemetry |
| `src/lib/shop.ts`, `supabase/for-shop.ts`, `availability.ts`, `approvals.ts`, CRM actions and schema | Owner-only tenancy, existing conflict wiring, external-calendar coupling and dual state |
| `src/lib/memory.ts`, `knowledge.ts`, `customer-context.ts`, `whisper.ts`, `whisper-summary.ts` | Shared recall, limited voice intent parsing, inference versus approved memory |
| `docs/P0_LOCAL_VERIFICATION.md`, PR #44 state/head and safety implementation | Pending safety work, verification limits and deployment exclusion |

## ARCHITECTURAL GAPS

The highest-risk gaps are not the model choice: owner-only access, fragmented action
policy, lack of a durable lead workflow, incomplete operational communications,
calendar dependency/capacity semantics and unreviewed memory learning. Intake, email
threading, role-aware retrieval and actionable failure notifications need concrete
acceptance coverage, not just a schema or UI toggle.

Conflict register:

- D-067 and D-069 exclude parts of the newly requested MVP. These five documents
  capture the new proposed implementation scope without overwriting founder history.
- Old B-18 named-agent roster conflicts with the one primary Agent; internal skill
  labels can explain work without creating multiple customer-facing personalities.
- Old D-021 floors, D-068 defaults and current two-mode code differ. Treat the new
  policy model as a tested migration, not a permission to remove safeguards.
- Legacy `leads.status` and `stage`, flat vehicle fields and first-class vehicles,
  catalog automations and custom recipes overlap. Inventory consumers, choose one
  authoritative field/path, migrate with compatibility checks; no destructive cleanup.
- B-19 is used for both phone continuity and draft-edit capture on unmerged docs
  branches. Assign unique implementation identifiers before ticketing; do not reuse
  that number here.
- Historical outbound/MCP docs mention Slack approvals and HCP, removed by D-052.
  Do not rebuild them. Outbound email exists; email-thread reply remains incomplete.

## FOUNDER DECISIONS

| Decision | Proposed working default | Needed before |
| --- | --- | --- |
| Launch claim: connected MVP versus voice/email pilot | Full target stays as requested; label any earlier pilot explicitly | External claims / step 8 |
| Initial location breadth | Scope records/policies by location now; no cross-location optimizer | Step 1 schema and staffed-shop acceptance |
| Manager and staff grants | Owner controls autonomy; managers approve assigned operations; staff cannot elevate policy | Steps 1–2 |
| Booking risk/discount limits | Explicit normal-booking opt-in; exceptions and confirmed reschedules require approval | Steps 2/6 |
| Application notification provider and timing | Independent transactional channel, no approval-notification recursion; no vendor selected here | Step 4 |
| Memory retention/publication permissions | Evidence automatic, extracted reusable rules reviewed | Steps 4/7 |
| Native calendar transition / outage policy | Preserve current safe behavior until replacement is verified; no silent “free” on unknown | Step 6 |
| Uncertain-delivery operations | Human reconciliation, new action/proof only after confirmed non-delivery | Step 8 |

These are bounded implementation decisions. The founder has already approved the
product direction, approval-first consent defaults and customer-merge preservation;
those should not be asked again. Channel readiness remains unverified in this phase.

## ACCEPTANCE CRITERIA

Every phase has the exit evidence in the sequence table. Final acceptance adds:

1. Run both solo and staffed-shop scenarios across enabled entry channels: ambiguous
   identity, quote exception, customer pause, manager edit, concurrent slot requests,
   provider timeout, membership revocation, STOP and resumed workflow.
2. Replayed events and cross-action proof reuse create zero duplicate transports or
   bookings; unknown outcomes create a visible assigned reconciliation task.
3. Every CRM stage, appointment, communication and memory entry links to evidence and
   policy. Operational summaries count real outcomes, not staged drafts as success.
4. An independent reviewer checks tenancy, consent, migration safety and operational
   failure paths. Founder separately accepts usability, channel readiness and claims.
5. No code, migrations, credentials, Vercel settings or services change as a side
   effect of accepting this documentation. Implementation starts only when authorized.
