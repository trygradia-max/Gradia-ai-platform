# E04-03 — Checklists: per-service templates, per-job instances, QC variant, pre/post inspection walk-around with photos

_Cut 2026-09-01 by the Organizer for autorun Batch 5 (`../program/autorun.md`). Specification only._

## Ticket ID
E04-03

## Epic
E04 — Jobs and team operations (phase P4)

## Status
**draft — batch-gated.** Autorun Batch 5, queue item 22. Enters after E04-02 is committed. Risk class **standard** (schema from E04-01; UI + actions; storage for photos exists). Founder acceptance **YES** (Batch 5 rule). Decisions binding: D-036, D-048, D-025 (real completion state, never fabricated), D-002 (works without AI). No open decision.

## Priority
P4 — High. E04 acceptance criteria 1 and 4 ("tech completes the checklist and closes the job"; "checklist templates apply per service and survive service edits"). Inspection + QC are annex items owned by E04 (established shops doing PPF/coating need the walk-around record).

## Objective
Owners maintain checklist templates (prep / QC / inspection kinds; per service or generic) with a seeded starter set per service category; every job instantiates its checklists from its services at booking/confirm time (and on service change), techs check items off (with optional photo/note), QC is a completion-check template variant, and the pre/post inspection walk-around records damage markers + photos — all feeding the job's completion rule from ADR-004.

## User outcome
Marcus opens the job, sees the prep list for a ceramic coating, ticks each step, snaps the pre-inspection photos with a note about the door ding, and the QC step blocks "done" until the required items are checked.

## Current code references
- Schema/domain from E04-01: `checklist_templates`, `job_checklist_items`, `job_inspections`, `services.default_checklist_template_id`, completion rule in `work-orders.ts`/`jobs.ts`.
- Services: `services` table + `service-menu.ts` (`DETAILER_TEMPLATE_MENU` `:137` — seed source for starter checklists per category), `actions/services.ts` (edit paths → template link survives edits).
- Jobs: `jobs.ts` transitions (`completed` gate), `actions/jobs.ts` (`setJobStatus` `:175`, photo upload `:473` with MIME allow-list from E04-01), `job-card-sheet.tsx`.
- Photos: private bucket + signed URLs; `photos_before/after` arrays on the job row (existing before/after machinery the inspection extends — E04 epic annex).
- Receptionist/Settings: template editor placement "under Receptionist/Advanced or Settings" (E04 epic UI surfaces) — progressive disclosure (BUILD_REFERENCE §3 Receptionist).
- Strings/flows: `strings.ts`, `ui/flows/job-completion.md`.

## Exact scope
1. **Templates:** CRUD (admin+) for `checklist_templates` (name, kind prep/qc/inspection, items ordered with `required` flags, service link or generic); seeded starter templates per service category from the detailer template menu (idempotent seed per shop on first visit or on service creation — zero founder touch); editor under Settings → Services (or Receptionist/Advanced — Builder follows `06`; one place).
2. **Instantiation:** when a job is confirmed/created with `service_ids`, instantiate items from each service's template (+ generic) → `job_checklist_items` (idempotent per job/template); on service change → add missing / mark removed (never delete completed items); template edits do **not** rewrite existing job instances (E04 acceptance criterion 4 "survive service edits" = instances are snapshots; the template link survives service edits).
3. **Tech UI on the job sheet (mobile-first):** checklist section grouped by kind; tap to complete (records member + time), optional note/photo per item; required items marked; progress as real counts ("6 of 9"); written empty state when a job has no template ("No checklist for this service — add one in Settings").
4. **QC variant:** a `qc` template's items act as the completion check: `completed` transition refuses (written reason listing missing required items) when required QC/prep items are incomplete **only if the shop's template marks them required** (ADR-004 rule).
5. **Inspection walk-around:** pre (at check-in) and post (at completion) inspection records: notes, photos (reuse before/after machinery; allow-list), simple damage markers (jsonb list of {area, type, note}) — no drawing canvas; written state when skipped ("No pre-inspection recorded").
6. **Owner visibility:** job sheet shows checklist completion + inspection summaries; Activity entry on job completion includes "N of N checklist items, inspection recorded" from real data (BUILD_REFERENCE §3 because-line rule).
7. Docs: `ui/flows/job-completion.md` (LIVE behind flag), `04`, capability-status; `14` candidate `checklist_completed`.

## Explicit non-goals
- No signatures capture UI (E04-04), no My day (E04-04), no per-member scheduling (E04-05).
- No warranty record creation (E06-era), no rework tracking (E05-era), no costing/materials engine (capture-only groundwork is E04-04's crew notes).
- No drawing/annotation canvas for damage; no customer-facing inspection share (E04-04 share view may include it read-only).

## Dependencies
- E04-02 committed. E04-01 (schema/ADR). E03-01 (service/vehicle CRUD).
- Decisions: D-036, D-048, D-025, D-002 — Approved.

## Expected modules affected
New: `src/app/actions/checklists.ts`, `src/app/actions/inspections.ts`, components `checklist-section.tsx`, `checklist-template-editor.tsx`, `inspection-section.tsx`, seed `src/lib/checklist-seed.ts`, `eval/checklists.test.ts`. Modified: `jobs.ts` (completion rule), `actions/jobs.ts` (status gate + instantiation hook), `job-card-sheet.tsx`, Settings/services page, `strings.ts`, flows/capability docs.

## Database impact
None beyond E04-01 (rows only). If the seed needs a `seeded_at` marker → one additive column (confirm at slotting).

## Migration impact
Zero or one additive migration.

## API impact
Server actions only.

## UI impact
Template editor, checklist + inspection sections on the job sheet (mobile-first: large tap targets, offline-tolerant messaging is E08), Activity line; DoD F states.

## Permission impact
Templates: admin+; item completion/inspection: any assigned member (tech included) — via E04-04 scoping (until then: any member); status gate server-side.

## Tenant-isolation impact
Templates/items/inspections shop-scoped (RLS from E04-01); seed per shop; tests.

## Security impact
Photo MIME/size allow-list (E04-01); signed URLs; notes are internal.

## Idempotency requirements
Instantiation idempotent per (job, template, position); completion toggles idempotent; seed idempotent.

## Observability requirements
`[checklists]` logs; completion-gate refusals logged with missing items count.

## Analytics requirements
`checklist_completed` candidate (14).

## Feature flag
`FEATURES.teamOperations` (shared).

## Automated tests
- Template CRUD + role matrix; seed idempotency; instantiation on create/confirm/service change (snapshots preserved); completion gate (required vs optional, template-driven); inspection record; Activity line from real counts; tenant isolation; regression `eval/jobs.test.ts`.

## Manual acceptance procedure
1. Builder: create a QC template with one required item for "Ceramic coating"; book that service → job shows prep + QC lists; try to complete → refused naming the item; complete it → allowed; Activity shows "N of N".
2. Builder: edit the service name/price → job instance unchanged; new bookings pick up the edited template.
3. Builder (phone viewport): tick items, add a photo + damage note in pre-inspection.
4. **Founder:** on Preview with the 3-member shop: a tech runs a job's checklist end-to-end; PASS/FAIL in `autorun-log.md`.

## Failure cases
- Job with no services → generic template only or written empty state.
- Photo upload fails → item stays incomplete with an actionable error; never silently marked done.

## Rollback strategy
Flag off hides sections; completion gate disabled with the flag; rows inert; revert commit.

## Definition of done
`../12-definition-of-done.md` plus: E04 acceptance criterion 4 evidenced; seed per category committed; flow/capability docs updated; founder acceptance PASS recorded.
