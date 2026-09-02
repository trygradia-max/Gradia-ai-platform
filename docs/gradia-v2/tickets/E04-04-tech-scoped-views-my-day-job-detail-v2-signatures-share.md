# E04-04 — Tech-scoped views: "My day", role-scoped job detail v2 (crew notes, signatures, pickup/drop-off), work-order share view, permission teeth

_Cut 2026-09-01 by the Organizer for autorun Batch 5 (`../program/autorun.md`). Specification only._

## Ticket ID
E04-04

## Epic
E04 — Jobs and team operations (phase P4)

## Status
**draft — batch-gated.** Autorun Batch 5, queue item 23. Enters after E04-03 is committed. Risk class **tenancy-adjacent (app-level role scoping; RLS predicate refinement only if ADR-004 chose it)** — treated as **standard** unless a policy changes (then tenancy). Founder acceptance **YES** (Batch 5 rule). Decisions binding: **D-048** (techs see assigned jobs + needed customer context only; no billing/autonomy/unassigned files), D-036, D-049 (no new destination; My day = member-scoped Home variant per E04 epic), D-021/D-012 (money/calendar HITL unaffected). No open decision.

## Priority
P4 — High. E04 acceptance criteria 1 and 3 ("the tech's My day shows it… closes the job"; "a tech cannot reach billing, autonomy controls, or unassigned customers' files — permission tests"). This is the first epic exercising member-scoped **data views** (E04 epic tenant implications); D-036 makes it a launch requirement.

## Objective
Give techs a role-scoped experience: a "My day" Home variant (assigned jobs today/next, checklist progress, notifications), a job detail v2 usable on a phone (crew notes, materials/duration capture groundwork, pickup/drop-off times, customer signature capture for acceptance/completion, inspection + checklist from E04-03), scoping every tech-facing query to assigned jobs and the customer context those jobs need, plus a customer-facing work-order share/print view (read-only, tokenized) — with permission tests on every job surface.

## User outcome
Marcus signs in on his phone and sees only his day; opens a job, reads the access notes, records "started 9:10, ceramic 2 coats", captures the customer's signature at pickup, marks done. He never sees billing, the autonomy switch, or customers he isn't working on. The customer gets a clean work-order summary link.

## Current code references
- Roles/permissions: `src/lib/members.ts` `requireMember`, E01-03 role-aware nav + matrix (`08` permission section), Home `src/app/(dashboard)/dashboard/page.tsx` (owner analytics — must not render for techs), sidebar `app-sidebar.tsx` (tech visibility from E01-03).
- Data loaders to scope: `src/lib/data/calendar.ts`, `src/lib/data/customers.ts:23,126`, conversations/activity loaders, job sheet data; assignments (E04-02) as the scoping key.
- RLS: E01-01 policies (members read all shop rows at DB level); ADR-004 §Tenant/role scoping decided whether tech restriction is app-level only or also RLS (`member_role(shop)`-aware policies on job tables). If RLS-level: policy migration here (tenancy class).
- Job sheet `job-card-sheet.tsx`; photos/inspection (E04-03); signatures table `job_signatures` (E04-01); pickup/drop-off fields (E04-01); `access_notes`, `key_tag`, `internal_note` (C1).
- Quote public page pattern for tokenized read-only views: `src/app/q/[token]/page.tsx` (+ P0-009 rate limit `quote_response` bucket) — the share view copies this pattern (CSPRNG token, expiry, rate limit).
- Print: CSS print styles; `ui/responsive-rules.md`, `ui/accessibility-standard.md`.
- Strings/flows: `strings.ts`; `ui/flows/job-completion.md`; `ui/flows/team-setup.md` step 4 (techs see assigned-job threads only).
- Signature capture: no dependency today — a small canvas component (pointer events → PNG blob → private bucket) with no new package preferred; `signature_pad` only if justified.

## Exact scope
1. **Scoping layer:** `src/lib/scope.ts` — given `{ member, role }` returns the query constraints for job/customer/conversation loaders: owner/admin = shop-wide; tech = jobs where assigned (active) + customers/vehicles referenced by those jobs + conversations threads tied to those customers (read-only) — implemented as an explicit `.in("id", assignedJobIds)`-style constraint applied at the loader boundary (never trusted from the client); if ADR-004 chose RLS-level scoping, add role-aware policies on job tables and keep the app-level constraint for defense-in-depth.
2. **My day (tech Home):** member-scoped Home variant: today's assigned jobs (time, vehicle, service, location/access notes, checklist progress), next-up, unread notifications, empty state ("Nothing assigned today"); no ROI receipt/KPIs/nudges (owner surfaces); mobile-first (bottom composer stays per BUILD_REFERENCE §2 but Whisper for techs is limited to notes on assigned jobs — actions that stage money/calendar remain admin+).
3. **Job detail v2:** crew notes (append-only, member-attributed), materials/duration capture groundwork (free-form structured fields: `started_at`, `finished_at`, `materials_note`; no costing), pickup/drop-off times (E04-01 fields) editable by assigned members, **signature capture** (acceptance at drop-off; completion at pickup) storing a PNG in the private bucket + signer name + timestamp (+ hashed IP/UA) — shown as an immutable record; status transitions available to techs limited to `checked_in → in_progress → completed` (never `paid`/`closed` — money-adjacent stays admin+ per D-021 spirit); reschedule/cancel stay admin+ (calendar HITL floor unaffected).
4. **Permission teeth:** server-side checks on every job/customer/conversation action and loader for `tech` (assigned-only), plus explicit denials for billing, autonomy, agent/automation config, integrations, exports, imports, approvals decisions (tech may **not** approve anything — approvals are owner/admin per D-048 floor); route-level guards render the honest "needs an admin" state.
5. **Work-order share view:** `/w/[token]` read-only customer-facing summary (shop name, vehicle, services, scheduled/pickup times, checklist summary counts, inspection photos if the owner enables sharing, signatures status) — tokenized (CSPRNG, expiring, rate-limited like `/q/[token]`), no PII beyond the customer's own job, print stylesheet; owner/admin generate/revoke the link from the job sheet; **no payment/invoice content** (E05).
6. **Tests:** permission matrix per surface (owner/admin/tech/non-member × job sheet, customer file, conversations, billing, autonomy, approvals, exports, share-link generation); scoping tests (tech sees assigned jobs only; unassign → disappears; cross-shop negatives).
7. Docs: `08` permission matrix, `06` (My day as Home variant), flows (`job-completion.md` LIVE, `team-setup.md` step 4 LIVE), `04`, capability-status; `14` candidates.

## Explicit non-goals
- No per-member availability/lanes (E04-05). No push notifications (E08). No customer-visible tech tracking. No payroll/timeclock (duration capture is groundwork only). No invoices/payments on the share view (E05). No warranty records (E06-era).
- No tech approvals of AI actions; no tech access to Whisper actions that stage money/calendar.

## Dependencies
- E04-03 committed (checklists/inspection). E04-02 (assignments). E01-03 (roles/nav). ADR-004 (scoping level).
- Decisions: D-048, D-036, D-049, D-021, D-012 — Approved.

## Expected modules affected
New: `src/lib/scope.ts`, `src/app/(dashboard)/dashboard/my-day.tsx` (variant), `src/app/w/[token]/page.tsx` + `actions/work-order-share.ts`, `signature-capture.tsx`, `crew-notes.tsx`, `eval/permissions-jobs.test.ts`, `eval/scope.test.ts`; optional RLS migration (if ADR-004 chose it). Modified: loaders (`data/calendar.ts`, `data/customers.ts`, conversations/activity), `job-card-sheet.tsx`, `actions/jobs.ts` (tech-allowed transitions), Home page routing by role, `strings.ts`, docs.

## Database impact
Rows in `job_signatures`, notes; token columns for share links (`work_order_share_tokens` small table or columns on the job row — additive) → one additive migration; role-aware RLS policies only if ADR-004 chose them.

## Migration impact
One additive migration (share tokens; signatures storage refs); optional policy migration (tenancy class → DB + high-risk slots).

## API impact
New public read-only route `/w/[token]` (rate-limited, tokenized); server actions.

## UI impact
My day, job detail v2 sections, signature capture, share/print view; DoD F states; mobile-first; accessibility for the canvas (fallback typed-name attestation for assistive tech users).

## Permission impact
The full D-048 matrix takes effect on job surfaces (documented in `08`).

## Tenant-isolation impact
Tech scoping is within-shop role scoping on top of shop isolation; tests for both; share tokens resolve to a single job in a single shop.

## Security impact
Share tokens CSPRNG + expiry + rate limit; signature images private; no PII leakage on the share view beyond the job; hashed IP/UA only.

## Idempotency requirements
Signature capture idempotent per (job, kind) — second capture requires explicit "replace" by admin; share link regeneration revokes the previous token.

## Observability requirements
`[scope]` denial logs (member id, surface) at info; SEV-3 if a tech hits denied surfaces repeatedly (signal only).

## Analytics requirements
`First job completed` (canonical, now per-member) emitted; candidates recorded.

## Feature flag
`FEATURES.teamOperations` (shared) — My day/scoping apply only to `tech` role; owner/admin unaffected.

## Automated tests
- Permission matrix (table-driven) across all listed surfaces; scoping loader tests; unassign → disappears; share view: token expiry/rate-limit/no-PII snapshot; signature idempotency; tech transition limits; regression suites.

## Manual acceptance procedure
1. Builder (phone viewport, tech account): My day shows assigned jobs only; open job → notes, pickup/drop-off, checklist, signature capture works; complete; `paid`/`closed` unavailable; billing/autonomy/approvals routes → honest denial.
2. Builder: generate a share link → customer view renders without PII beyond the job; expire/revoke works; rate limit trips on abuse.
3. **Founder (E04 exit rehearsal, part 1):** with the 3-member Preview shop, run a job as owner → tech → customer view; PASS/FAIL in `autorun-log.md`.

## Failure cases
- Tech assigned to a job whose customer has other jobs → sees only the customer context needed (profile + vehicle + this job's thread), not the customer's full history — documented boundary.
- Signature upload fails → job cannot be marked completion-signed; status may still complete if the template doesn't require the signature (ADR-004 rule).

## Rollback strategy
Flag off restores admin-wide views for techs? **No** — rollback must not widen access: with the flag off, techs get the E01-03 baseline (nav-limited, read-only) — document. Revert commit; migrations additive.

## Definition of done
`../12-definition-of-done.md` plus: permission matrix tests committed and listed in the close record; E04 acceptance criteria 1 and 3 evidenced; `08`/`06`/flows/capability docs updated; founder acceptance PASS recorded.
