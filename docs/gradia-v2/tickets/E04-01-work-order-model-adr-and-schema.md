# E04-01 — Work-order model: ADR-004 (jobs vs appointments split) + additive schema for assignments, checklists, inspection, signatures, pickup/drop-off

_Cut 2026-09-01 by the Organizer for autorun Batch 5 (`../program/autorun.md`). Specification only._

## Ticket ID
E04-01

## Epic
E04 — Jobs and team operations (phase P4)

## Status
**draft — batch-gated + ADR-gated.** Autorun Batch 5, queue item 20 (first ticket on `auto/batch-5`). Enters only after Batch 4 is merged. **Prerequisite inside this ticket:** `03-domain-model.md` §6 requires the jobs-vs-appointments split to be decided by ADR *before* E04 tickets build — this ticket's first deliverable is **ADR-004** (proposed by the Builder from the evidence below, accepted at review + founder acceptance) and its schema work does not start until ADR-004 is marked accepted in the ticket file. Risk class **database-sensitive**. Founder acceptance **YES** (Batch 5 rule). Decisions binding: D-036 (team ops = launch requirement), D-018 (born under membership RLS), D-048 (roles), D-049 (Jobs destination = later BUILD_REFERENCE amendment; not here), D-017 (recurring/memberships/fleets separate — not modeled here). No open founder decision blocks it.

## Priority
P4 — Critical for D-036. Everything a crew needs (assignments, checklists, inspection, signatures, QC, pickup/drop-off) is NOT_FOUND (audit 03; verified 2026-09-01: no `jobs`, `work_orders`, `checklists`, `assignments`, `staff` tables; assignment exists only as free text in `access_notes.bay`, `availability.ts:84` "No staff/resource schema exists yet").

## Objective
Decide the split in ADR-004 (planning assumption: split when assignments land — `03` §6) and ship the additive work-order schema under membership RLS: `job_assignments`, `checklist_templates`, `job_checklist_items`, inspection + signature records, pickup/drop-off fields, member availability rows placeholder (E04-05 fills), with generated types, RLS isolation suite extension, and a `jobs.ts` domain layer that later tickets build on — no UI beyond what the ADR requires to be truthful.

## User outcome
Invisible at this ticket's end (schema + domain layer). The owner's data model can now hold "who does this job, what steps it has, what was inspected and signed".

## Current code references
- **Job = appointment today:** `appointments` columns (base `20260507220000_gradia_core.sql:55-62`; `20260512130000_book_appointment.sql:9-13`; `20260514100000_appointment_reminder.sql:10-11`; `20260618120000_appointment_confirm.sql:6-8`; `20260618130000_crm_specialist_metrics.sql:59`; C1 `20260708120000_crm_foundation_c1.sql:247-265` — `status job_status`, `hold_reason`, `ends_at`, `location_type`, `address`, `travel_fee_cents`, `access_notes jsonb`, `weather_flag`, `service_ids uuid[]`, `quoted_amount_cents`, `payment_status`, `photos_before/after`, `key_tag`, `internal_note`; `20260811120000_booking_atomicity.sql:48-54` `pending_action_id`; E02-02 added `kind`, `external_*`, `sync_*`).
- Enums: `job_status('booked','confirmed','checked_in','in_progress','on_hold','completed','paid','closed')` `…c1.sql:42-44`; `job_hold_reason` `:48`; `job_location_type` `:53`; `job_payment_status` `:57`.
- Domain: `src/lib/jobs.ts` (278 lines: `JOB_STATUSES` `:23`, `JOB_TRANSITIONS` `:41-50`, `canTransition` `:52`, `nextActionsFor` `:57`, `armMaintenanceSchedule` `:92`, `advanceJobStatus` `:133`, `CLOSE_AFTER_PAID_HOURS` `:244`, `closeOldPaidJobs` `:251`); actions `src/app/actions/jobs.ts` (553 lines: `setJobStatus` `:175`, `setJobPaymentStatus` `:192`, `updateJobLogistics` `:223`, `rescheduleJob` `:278`, `blockTime` `:409`, `uploadJobPhoto` `:473`, `getJobPhotoUrls` `:527`); UI `job-card-sheet.tsx` (517 lines), `calendar-week.tsx:29`; tests `eval/jobs.test.ts`.
- Services: `services` (`gradia_core.sql:27-36` + C1 `:292-300` category/size pricing/addon flags); `service-menu.ts`, `service-pricing.ts` (18 call sites), `actions/services.ts`.
- Quotes: `quotes` `…c1.sql:194-221` (no `appointment_id`; link is `appointments.quote_id` `:249` + E03-04's chosen direction).
- Photos: private bucket + signed URLs (`uploadJobPhoto`); **MIME allow-list gap** (E04 epic security).
- Members/roles: E01-01 `members`; `requireMember`; RLS suite + coverage script (new tables must pass).
- Availability: `src/lib/availability.ts` (E02-01 slot engine); per-resource is E04-05.
- No `/jobs` route (schedule folded into Calendar `schedule/page.tsx:3`); IA target: Jobs destination via D-049 amendment (later).
- Annex owners (E04 epic): inspection, signatures, QC, pickup/drop-off = **build in E04**; warranty (E06-era), rework (E05-era), profitability (E08) = deferred.
- Domain rule: `03` §6 "Planning assumption: split when assignments land"; §Cross-cutting: provider ids are mirrors; D-017 separation.

## Exact scope
1. **ADR-004 — jobs vs appointments (`adr/ADR-004-jobs-work-orders.md`):** options: (a) keep `appointments` as the job row and add a work-order layer of child tables (assignments/checklists/inspection/signatures referencing `appointment_id`); (b) new `jobs` table 1:1 with appointments (job = the work; appointment = the time slot) with a migration moving job-only columns; (c) `jobs` 1:N appointments (multi-visit PPF). Evaluate against: E02's native calendar (spans, `kind`), multi-day work, E05 invoices (job-level billing), E06 recurring/fleet visits (D-017 separate domains but they *create* jobs), reporting rule 8, and blast radius (`jobs.ts`, `actions/jobs.ts`, `job-card-sheet.tsx`, 18 pricing call sites). **Builder proposes; Reviewer + founder accept** (recorded in the ticket + ADR status). Planning assumption to test, not assume: (b)/(c) split.
2. **Schema (after ADR accepted; additive; membership RLS from birth; `forShop` for any service-role path):** per the ADR — at minimum: `job_assignments(id, shop_id, job_ref, member_id, role_on_job ENUM('lead','helper'), assigned_by, assigned_at, unassigned_at)` unique active per (job, member); `checklist_templates(id, shop_id, name, service_id nullable, kind ENUM('prep','qc','inspection'), items jsonb[ordered], active)`; `job_checklist_items(id, shop_id, job_ref, template_id, position, label, required, completed_at, completed_by member, note, photo_refs[])`; `job_inspections(id, shop_id, job_ref, kind ENUM('pre','post'), notes, photo_refs[], damage_markers jsonb, created_by, created_at)`; `job_signatures(id, shop_id, job_ref, kind ENUM('acceptance','completion'), signer_name, signed_at, image_ref (private bucket), captured_by member, ip/ua hash)`; pickup/drop-off: `dropoff_at`, `pickup_at`, `pickup_ready_at` on the job row; if (b)/(c): the `jobs` table + FK + backfill from appointments with dual-read for one release. `services.default_checklist_template_id`. Indexes on `(shop_id, job_ref)`, `(shop_id, member_id)`. Generated types regenerated (E03-01 drift check).
3. **Domain layer:** `src/lib/work-orders.ts` (or extend `jobs.ts` per ADR): typed accessors for assignments/checklists/inspections/signatures; status machine unchanged (`JOB_TRANSITIONS`) except a documented rule that `completed` may require `required` checklist items done and a completion signature **only when the template says so** (no global gate).
4. **Photo MIME allow-list** (`uploadJobPhoto`) + size cap — lands here at the latest (E04 epic security).
5. **RLS isolation suite extension + permission floor tests** for the new tables (tech can read assigned-job rows only via E04-04's scoping; at the data level in this ticket: members of the shop; **techs are restricted app-level in E04-04 and by RLS predicate refinement here if the ADR chooses RLS-level tech scoping — decide in ADR-004 §Tenant/role scoping**).
6. Docs: ADR-004; `03-domain-model.md` §6 (current → target resolved), §Cross-cutting schema debts; `04`; `program/capability-status.md`; `ui/flows/job-completion.md`/`lead-to-job.md` maturity lines.

## Explicit non-goals
- No UI beyond truthful states (the job sheet may show "no assignments yet" only if a surface would otherwise lie — else nothing).
- No payroll/timeclock, no inventory/materials costing, no route optimization, no customer-visible tech tracking (E04 non-goals); no warranty/rework/profitability (deferred owners in the annex).
- No per-member availability (E04-05), no notifications (E04-02), no template editor UI (E04-03).
- No changes to conflict/booking executors.

## Dependencies
- Batch 4 merged (E02 native calendar incl. `kind`/spans). E01-01/E01-03 (members, roles). E03-01 (generated types). E03-04 (quote link direction).
- Decisions: D-036, D-018, D-048, D-017 — Approved. **ADR-004 accepted inside the ticket before schema** (Reviewer + founder).

## Expected modules affected
New: `adr/ADR-004-jobs-work-orders.md`, migration(s), `src/lib/work-orders.ts`, `eval/integration/work-orders.int.test.ts`, RLS suite rows. Modified: `src/lib/jobs.ts`, `src/app/actions/jobs.ts` (MIME allow-list), `src/lib/types/database.ts` + generated types, `03`, `04`, capability-status, flows.

## Database impact
Four to six new tables (+ possibly `jobs`), columns on the job row, `services.default_checklist_template_id`, indexes, RLS policies, backfill if split.

## Migration impact
Two to three additive, idempotent migrations with rollback files; **occupies the DB-sensitive slot.** If the ADR chooses a split with backfill: dual-read window documented; no drops.

## API impact
None external.

## UI impact
None (or a single truthful empty line on the job sheet).

## Permission impact
Data-level: shop members; role gating deferred to E04-04 (documented in ADR-004).

## Tenant-isolation impact
New tables under membership RLS + isolation suite; coverage script (E01-01) must pass; `forShop` for crons/service paths.

## Security impact
Signatures/inspection photos in the private bucket with signed URLs; MIME allow-list + size cap; signature image never public; hash (not raw) of IP/UA.

## Idempotency requirements
Assignment insert idempotent (unique active); checklist instantiation from template idempotent per job (unique `(job_ref, template_id, position)`).

## Observability requirements
None new beyond `[work-orders]` logs.

## Analytics requirements
Candidates `job_assigned`, `checklist_completed` recorded in 14 as candidates (decision queue before extending the canonical set — E04 epic).

## Feature flag
`FEATURES.teamOperations` introduced **off** (schema is inert without UI; flag gates E04-02/03/04 surfaces).

## Automated tests
- Migration re-run twice; backfill equivalence if split; RLS isolation + coverage; permission floors; MIME allow-list; status-machine rule (template-gated completion) unit tests; generated-types drift.

## Manual acceptance procedure
1. Builder: apply migrations locally; seed a job with two assignments, a template-instantiated checklist, a pre-inspection, a completion signature; query via the domain layer; RLS negatives.
2. Builder: upload a non-image as a photo → rejected with a written reason.
3. **Founder:** accept ADR-004 (written) and confirm the schema on Preview matches the ADR; PASS/FAIL in `autorun-log.md`.

## Failure cases
- ADR proposes a split that would touch executor semantics (`approvals.ts` booking writes into a new `jobs` table) → design so the executor keeps writing `appointments` and a trigger/domain call creates the job row; if impossible without executor changes → HARD STOP and report (autorun rule 5).
- Backfill ambiguity (appointments without services) → job rows created with nulls, listed in the migration output.

## Rollback strategy
Additive: revert code; tables inert. If split with backfill: dual-read window makes revert lossless; rollback file drops the new tables only after founder decision (never automatic).

## Definition of done
`../12-definition-of-done.md` plus: ADR-004 accepted (status line + founder acceptance recorded); migrations + rollback files; RLS/coverage/permission tests green; `03` §6 updated; founder acceptance PASS recorded.
