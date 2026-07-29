# E04 — Jobs and Team Operations

_Created 2026-07-25 by the Organizer. Phase: **P4**. Status: planned._

## Objective

Grow the single-operator job model into team operations: work orders with assignments and checklists, per-member scheduling on the E02 availability engine, and job-day tooling (statuses, photos, notes) that a crew actually uses on their phones.

## User outcome

A 3-person shop runs its day in Gradia: the owner assigns Tuesday's ceramic job to Marcus, Marcus sees his day, checks off the prep list, uploads before/after photos, and marks it done — and the owner sees all of it without a phone call.

## Business reason

Single-operator is an alpha constraint, not the market: detailing/PPF/tint shops with revenue worth $49/mo mostly have crews. Audit doc 03: job assignments/checklists/team scheduling all NOT_FOUND. This epic is what makes E01's tenancy commercially real.

## Current foundation

- `appointments`-as-jobs: validated status machine (booked→…→closed), timeline events, before/after photos (private bucket + signed URLs), 48h close sweep, payment_status fields (audit docs 03/05).
- E01 members/roles; E02 availability engine.
- `jobs.ts` + `actions/jobs.ts`; location fields (`location_type/address/travel_fee`) for mobile jobs.

## Missing work

1. Assignment model: job ↔ member(s); assignee visibility rules.
2. Checklists: per-service template checklists + per-job instances; completion tracking.
3. Team scheduling: per-member working hours/capacity feeding availability (extends E02 from one shop calendar to per-resource); "my day" view.
4. Job detail v2: crew notes, materials/duration capture groundwork for costing.
5. Notifications to assignees (in-app first; push rides E08 PWA).
6. Work-order print/share view (customer-facing summary).

### Work-order parity annex (added 2026-07-27 — each item owned)

| Item | Owner |
|---|---|
| Damage inspection (pre-work walk-around, photos + notes) | **Build in E04** — extends the existing before-photos machinery |
| Customer signatures (job acceptance / completion) | **Build in E04** — required for high-ticket PPF/coating work orders |
| Quality control (completion check step) | **Build in E04** — a checklist-template variant, not a new system |
| Pickup / drop-off times on the job | **Build in E04** (carried from the E02 annex) |
| Warranty record creation on completion (coating/PPF/tint) | **Deferred → E06-era** — writes the vehicle warranty records the CRM target defines; needs no payments |
| Rework tracking (job reopened / redo linkage) | **Deferred → E05-era** — meaningful once invoices exist (rework vs re-billing) |
| Job profitability (labor + materials vs invoice) | **Deferred → E08** — needs E05 invoices + E04 time/materials capture; explicitly a report, not a job-screen number (roadmap rule 8) |

Costing/inventory remain out per Non-goals; the annex adds capture surfaces, not a costing engine.

## Domain entities

New: `job_assignments`, `checklist_templates`, `job_checklist_items`, per-member availability rows. Modified: `appointments` (assignment refs), `services` (checklist template link).

## Backend services

Extend `jobs.ts`, `availability.ts` (per-resource), new `checklists.ts`; notification fan-out via existing agent-events pattern.

## UI surfaces

Jobs board with assignee filter; "My day" (member-scoped home variant); job detail with checklist + crew notes; checklist template editor under Receptionist/Advanced or Settings; calendar per-member lanes.

## Integrations

None new. CRM push (Jobber/HCP) gains assignee fields only if the seam supports it — otherwise out.

## Security implications

Role boundaries get teeth: techs see assigned jobs + needed customer context, not the whole CRM, billing, or autonomy controls (permission tests per surface). Photo upload MIME allow-list (audit gap) lands here at the latest.

## Tenant implications

First epic exercising member-scoped *data views* inside a shop (row-level shop isolation + app-level role filtering). Assignment rows must carry shop_id and be covered by the E01 RLS suite.

## Migration implications

Additive tables; checklist template seed per service category. No retirements.

## Product analytics

Lights up: `First job completed` (now meaningful per-member). Candidate additions (decision queue): job_assigned, checklist_completed.

## Dependencies

E01 (roles — hard), E02 (availability — hard for team scheduling; assignments/checklists could ship before per-member lanes). Decisions: role taxonomy (Q-17) settles what techs can see. **Prerequisite ADR (amended 2026-07-27): the jobs-vs-appointments table split is decided by ADR *before* E04 ticket cutting** — not mid-epic (`03-domain-model.md` §6); the annex items above (signatures, inspection, QC) bear directly on the split.

## Risks

- Scope creep toward full FSM (field-service management) — checklists and assignments only; costing/inventory are explicitly out.
- Per-resource availability multiplies E02 sync complexity — external calendars stay shop-level mirrors; per-member external sync is out.

## Non-goals

No payroll/timeclock, no inventory/materials costing, no route optimization, no per-member external calendar sync, no customer-visible tech tracking ("Uber view").

## Feature flags

`FEATURES.teamOperations` (assignments/checklists), `FEATURES.teamScheduling` (per-member lanes) — separately flippable.

## Testing requirements

Permission tests: tech vs admin vs owner on every job surface. Availability tests with multiple resources (overlap allowed across members, blocked within one). Checklist template→instance integrity. Photo MIME validation tests. RLS suite extension for new tables.

## Rollout plan

Assignments + checklists first (flag on pilots with crews); per-member scheduling second; work-order share view last. Collect pilot feedback in `customer-feedback/` before widening.

## Acceptance criteria

1. Owner assigns a job; the tech's "My day" shows it; the tech completes the checklist and closes the job; the owner sees the trail.
2. Two members can be booked at the same hour; one member cannot be double-booked (E02 engine, per-resource).
3. A tech cannot reach billing, autonomy controls, or unassigned customers' files (permission tests).
4. Checklist templates apply per service and survive service edits.
