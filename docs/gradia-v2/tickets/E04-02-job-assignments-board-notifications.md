# E04-02 — Job assignments: assign/unassign members, jobs board with assignee filter, assignee notifications, CRM push fields

_Cut 2026-09-01 by the Organizer for autorun Batch 5 (`../program/autorun.md`). Specification only._

## Ticket ID
E04-02

## Epic
E04 — Jobs and team operations (phase P4)

## Status
**draft — batch-gated.** Autorun Batch 5, queue item 21. Enters after E04-01 is committed (ADR-004 accepted). Risk class **standard** (schema from E04-01; UI + actions + notifications). Founder acceptance **YES** (Batch 5 rule). Decisions binding: D-036, D-048 (owner/admin assign; tech views own), D-049 (jobs surface lives inside Customers/Calendar until the Jobs destination amendment — **no new destination here**; the "jobs board" is a view inside the Calendar destination per `06` §Jobs & work orders placement, or a tab in Customers — Builder follows `06`), D-011 (no AI side effects), D-045.

## Priority
P4 — High. E04 acceptance criterion 1 starts here ("owner assigns a job; the tech's My day shows it…"). Assignment is free text today (`access_notes.bay`).

## Objective
Owner/admin assigns one or more members to a job (lead/helper), sees a jobs board filterable by assignee/day/status, changes assignments from the job sheet and the calendar; assignees get an in-app notification (push rides E08 PWA); the Jobber push seam gains assignee fields only if it supports them.

## User outcome
"Tuesday's ceramic job → Marcus" takes two taps; Marcus sees a notification and the job on his list; the owner sees the board by person.

## Current code references
- Schema/domain from E04-01: `job_assignments`, `work-orders.ts`, `FEATURES.teamOperations`.
- Job sheet `src/components/gradia/job-card-sheet.tsx` (517 lines); calendar week `calendar-week.tsx` (day/week/month/agenda from E02-06); `src/app/actions/jobs.ts` (`updateJobLogistics` `:223` writes `access_notes`); data loaders `src/lib/data/calendar.ts`.
- IA: `06-ui-information-architecture.md` §Jobs & work orders (P4: "Job detail stays inside Customers (customer file → job) + day/dispatch view inside Calendar destination"); D-049 target Jobs destination later.
- Notifications: no in-app notification table today (MVP plan §5 `notifications` "never built" — C-03); agent-events pattern `src/lib/agent-events.ts` (fan-out); Approvals badge = pending count (sidebar). **In-app notification = a small `member_notifications` table** (additive) or reuse Activity feed entries scoped to the member — Builder chooses the smaller; prefer Activity entries + a per-member unread marker if Activity already supports actor/target.
- Members: `src/lib/members.ts` (`requireMember`), E01-03 Team card (member names for pickers).
- CRM seam: `src/lib/crm-provider.ts` push-only; Jobber `jobber-push.ts:146` `pushBookingToJobber` — check whether Jobber's request/job accepts an assignee; if not, **out** (E04 epic Integrations).
- Strings: `strings.ts`; flows `ui/flows/job-completion.md`, `team-setup.md` step 5 ("member becomes assignable").
- Analytics candidates: `job_assigned` (14 — candidate; do not extend the canonical set silently).

## Exact scope
1. **Actions:** `assignMembers(jobRef, [{memberId, role}])`, `unassignMember`, `setLeadAssignee` — admin+ (D-048); zod; audit trail (who assigned whom, when) via `job_assignments` columns; idempotent.
2. **Job sheet:** Assignees section (avatars/names, lead badge, add/remove via member picker limited to active members; techs listed first), written empty state ("No one assigned yet"), role-aware controls (tech: read-only).
3. **Jobs board view:** inside the Calendar destination (dispatch/day view) per `06`: list/grid of the day's jobs with assignee chips, filter by assignee/status, unassigned lane; also a per-member column option (feeds E04-05 lanes without per-member availability yet). No new sidebar item (D-049 promotion is a separate BUILD_REFERENCE amendment).
4. **Notifications (in-app):** on assign/unassign/reschedule of an assigned job → notification to the member (table or Activity-scoped entry per the reference above); unread badge on Home for the member; written empty state; **no SMS/email/push** (E08 PWA push later; SMS to staff is out — comms parity E07 may revisit).
5. **CRM push fields:** if `pushBookingToJobber` can carry an assignee/instructions field → include lead assignee name; else record "unsupported" in the seam doc and do nothing.
6. **Analytics:** emit `job_assigned` to the D-045 table if present; mark candidate in 14.
7. Docs: `06` placement note (view inside Calendar), `ui/flows/job-completion.md`, `04`, capability-status.

## Explicit non-goals
- No checklists (E04-03), no tech-scoped data views/My day (E04-04), no per-member availability or double-booking rules (E04-05).
- No SMS/email/push notifications; no customer-visible tech identity.
- No Jobs sidebar destination.

## Dependencies
- E04-01 committed (schema + ADR). E01-03 (members UI/roles). E02-06 (calendar views).
- Decisions: D-036, D-048, D-049, D-045 — Approved.

## Expected modules affected
New: `src/app/actions/assignments.ts`, components `assignees-section.tsx`, `jobs-board.tsx`, `member-picker.tsx`, notifications helper (+ optional `member_notifications` migration), `eval/assignments.test.ts`. Modified: `job-card-sheet.tsx`, calendar page/loader, Home (unread badge), `strings.ts`, `jobber-push.ts` (optional), `features.ts` (flag on for pilots), docs.

## Database impact
None beyond E04-01 unless `member_notifications` is chosen (one additive table under membership RLS).

## Migration impact
Zero or one additive migration (confirm at slotting; DB slot only if written).

## API impact
Server actions only.

## UI impact
Assignees section, board view, notification badge/list; skeletons/empty/error/success per DoD F; mobile: board collapses to a list with assignee chips.

## Permission impact
Assign/unassign: admin+; tech: read-only on assignments; notifications: only to the target member.

## Tenant-isolation impact
Member picker lists only the shop's members; assignment rows shop-scoped; notification rows member-scoped within shop; tests.

## Security impact
None new.

## Idempotency requirements
Assign twice → one active row; unassign twice → no error; notifications deduped per (job, member, event) within a short window.

## Observability requirements
`[assignments]` logs.

## Analytics requirements
`job_assigned` candidate.

## Feature flag
`FEATURES.teamOperations` (from E04-01) — on for pilot shops (per-shop enablement rides the existing per-shop flag mechanism if one exists; else global on at merge with the board hidden for shops with one member — written state).

## Automated tests
- Actions: role matrix (owner/admin/tech), idempotency, audit fields.
- Board loader: filters, unassigned lane, tenant isolation.
- Notifications: created on assign/unassign/reschedule; member-scoped; dedupe.
- Regression: `eval/jobs.test.ts`, calendar suites green.

## Manual acceptance procedure
1. Builder: owner assigns a tech (lead) + helper → sheet + board show both; tech's Home shows the unread notification; unassign → cleared.
2. Builder: as tech → assignment controls hidden; as admin → allowed.
3. **Founder:** on Preview with a 3-member test shop: assign the day's jobs from the board; notifications arrive; PASS/FAIL in `autorun-log.md`.

## Failure cases
- Member removed while assigned → assignment auto-closed by the removal path (E01-03 hook) with a written note on the job.
- Jobber push field unsupported → no-op, documented.

## Rollback strategy
Flag off hides surfaces; revert commit; rows inert.

## Definition of done
`../12-definition-of-done.md` plus: role matrix tests; `06` placement + flow docs updated; founder acceptance PASS recorded.
