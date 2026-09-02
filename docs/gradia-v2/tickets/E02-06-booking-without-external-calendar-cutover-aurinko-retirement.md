# E02-06 — Booking without an external calendar: authority cutover, Aurinko retirement, calendar UI parity

_Cut 2026-09-01 by the Organizer for autorun Batch 4 (`../program/autorun.md`). Specification only._

## Ticket ID
E02-06

## Epic
E02 — Native calendar and availability (phase P2) — **E02 exit ticket**

## Status
**draft — batch-gated.** Autorun Batch 4, queue item 20 (last E02 ticket; Batch 4 completes here). Enters after E02-05 is committed. Risk class **calendar + database-sensitive** (dormant-column handling, connection migration) + **security** (credential deletion). Founder acceptance **YES**. Decisions binding: D-013, D-050 (Aurinko retired at end of Batch 4), D-030 (Aurinko transitional → removed), D-046 (Calendar destination), D-043. **Founder precondition:** Production env carries `GOOGLE_OAUTH_*` (and `MICROSOFT_OAUTH_*` if the Microsoft flag will be on) before this ticket's production deploy; the founder removes `AURINKO_*` from Production **after** the reconnect window (never the Builder).

## Priority
P2 — High. Closes E02 acceptance criterion 1 ("a shop with zero connected calendars books, reschedules, reminds, and completes end-to-end") and criterion 5 (no hard external-calendar requirement, test-locked), and executes D-050's retirement so the transitional vendor stops being load-bearing.

## Objective
Flip `nativeCalendarAuthority` to default-on, delete the Aurinko client/routes/columns-usage, migrate existing Aurinko-connected shops into an honest "reconnect" state with owner self-serve reconnection, bring `/calendar` to view parity (day/month/agenda + sync status), update Receptionist copy ("bookings work without a calendar — connect one to sync"), and lock the no-external-requirement invariant with tests.

## User outcome
A brand-new shop books its first appointment with nothing connected. Existing shops see one clear "Reconnect Google Calendar / Gmail" prompt (with what stops working until they do), reconnect in two clicks, and everything resumes. The calendar has day, week, month and agenda views and shows sync state per job.

## Current code references
- Gate to remove permanently: `src/lib/approvals.ts:1309-1325` (behind the flag since E02-02); email gate `approvals.ts:1979-1988` (Aurinko-specific copy "Connect Gmail via Aurinko…") → seam-based "no email connection" written state.
- Aurinko surface to delete: `src/lib/aurinko.ts` (755 lines); routes `src/app/api/aurinko/auth/start`, `auth/callback`, `webhook` (425 lines; intake already delegated to `email-intake.ts` in E02-03); `src/app/actions/shop.ts:594-651` `disconnectEmail()`; env `AURINKO_CLIENT_ID/SECRET/SIGNING_SECRET` (`.env.example:44-50`; `AURINKO_API_BASE` undocumented); settings gate `settings/page.tsx:130-133`; onboarding readers `src/lib/onboarding.ts:12,23`, `onboarding-wizard.tsx:146`, `onboarding-launch-steps.tsx:108`; agent/BI readers listed in E02-02 (already moved to connection health — verify none remain: grep `aurinko_` in `src/` must return only the dormant-column type definitions + the adapter until deletion).
- Columns left dormant (never dropped in this program): `shops.aurinko_*` (5), `appointments.aurinko_calendar_id/aurinko_event_id`, `interactions`/pending metadata `aurinko_message_id` fields — additive rule; a rollback-able drop file goes to `supabase/rollbacks/` **not** `migrations/` (E10 decides drops).
- Provider literal `"aurinko"` in `src/lib/provider-events.ts:33` stays (historical receipts).
- Tests to retire/replace: `eval/aurinko-datetime.test.ts` (`wallTimeToInstant` — keep the function in a neutral `src/lib/datetime.ts` and move the test), Aurinko sections of `eval/webhooks.test.ts`, `eval/tenant-scoping.test.ts` importer inventory rows for the deleted files.
- Calendar UI: `src/lib/data/calendar.ts:57` week-only; `calendar-week.tsx` (626 lines); `src/app/(dashboard)/calendar/page.tsx`; `schedule/page.tsx` redirect. E02 parity annex: day / month / agenda views build in E02.
- Receptionist setup: `src/app/(dashboard)/receptionist/*` copy; `strings.ts`.
- Reminders + no-show ladder depend on appointments only (`cron/reminders`, `cron/no-show-ladder`) — regression scope (E02 epic risk: "trace every consumer of `aurinko_event_id`").
- Docs: `vendors/transitional/aurinko.md` (→ removed), `vendors/registry.md`, `runbooks/calendar-outage.md`, `docs/aurinko-go-live.md` + `docs/calendar-go-live.md` (platform docs — mark superseded), C-09 in `16-document-source-map.md`.

## Exact scope
1. **Cutover:** `FEATURES.nativeCalendarAuthority` default **true**; remove the gate code path entirely (flag retired after one release — the kill switch for cutover is the PR revert, documented); booking/reschedule/cancel/email executors depend only on the seams. Source-scan test: no `aurinko` import anywhere in `src/` (ADR-002 lock, allowlist empty).
2. **Existing-shop migration (zero founder touch):** for every `shop_connections` row with `provider='aurinko'` and `status=connected`: set `status='migration_required'`, keep the row for history; in-app notice on Home + both tiles: "Reconnect Google Calendar / Gmail — Gradia moved to a direct Google connection. Until you reconnect: appointments still book, reminders still send; calendar mirroring and email intake pause." (written in `strings.ts`, numbers not adjectives); reconnect = the E02-03 flow; on success the Aurinko row → `retired`. Existing `appointments.external_provider='aurinko'` mirrors: re-pointed to the Google event **if** the adapter can find the same event by iCalUID/extended property, else `sync_status='orphaned'` with a written "mirrored before the move" state — never re-created blindly (no duplicate events on the owner's calendar).
3. **Delete Aurinko code:** client, routes, disconnect action, env reads, settings gate, tests; move `wallTimeToInstant` to `src/lib/datetime.ts`; remove `AURINKO_*` from `.env.example` and `docs/env-setup.md`; **columns stay** (dormant) with a comment block in a new `supabase/rollbacks/aurinko_columns_drop.sql` (not applied). Update the `REVIEWED_IMPORTERS` inventory (`eval/tenant-scoping.test.ts`) by removal only.
4. **Calendar view parity:** day, month, agenda views in addition to week (one data loader parameterized by range; shading from E02-01; `kind=block` and multi-day spans rendered; sync badge per job; per-view written empty states); URL state for view + date; mobile: agenda is the default view under the responsive breakpoint (`ui/responsive-rules.md`).
5. **Sync status surfaces:** job sheet shows `synced / not synced — Retry / changed externally / mirrored before the move`; Retry re-queues through the sweep; tiles show `last_success_at` in human terms ("synced 4 min ago").
6. **Receptionist + onboarding copy:** calendar connection is optional everywhere (onboarding launch steps no longer treat calendar as required — D-035 activation gate still counts "calendar connected" as one of its OR-paths; copy reflects it); "bookings work without a calendar — connect one to sync" in `strings.ts`.
7. **Regression proof:** reminders, confirmations, no-show ladder, ROI receipt, BI answers about appointments — identical with zero connections and with Google connected (integration tier).
8. Docs: vendor page → `vendors/removed/aurinko.md` (with the removal record + which columns are dormant), registry row `removed`, C-09 resolved, `runbooks/calendar-outage.md` final, `docs/aurinko-go-live.md`/`calendar-go-live.md` superseded banners, `04-capability-map.md` (#calendar → live, native), E02 epic acceptance recorded, `program/capability-status.md`.

## Explicit non-goals
- No column drops (rollback file only). No per-member lanes (E04-05). No online booking. No email UX (E07).
- No Microsoft flag flip (Organizer flips after the parity window — D-043).
- No new vendor.

## Dependencies
- E02-05 committed; E02-03 (Google) merged-quality; E02-04 present (flag off is fine).
- **Founder precondition:** Production `GOOGLE_OAUTH_*` set before the batch's production deploy (founder daily loop); `AURINKO_*` removal from Production after the reconnect window (founder; recorded in the log).
- Decisions: D-013, D-050, D-030, D-046 — Approved.

## Expected modules affected
Deleted: `src/lib/aurinko.ts`, `src/app/api/aurinko/**`, `eval/aurinko-datetime.test.ts` (moved). Modified: `src/lib/approvals.ts`, `src/app/actions/shop.ts`, `src/app/actions/jobs.ts`, `src/lib/features.ts`, `src/lib/data/calendar.ts` (+ new views), `src/components/gradia/calendar-*.tsx`, `job-card-sheet.tsx`, settings tiles, onboarding files, receptionist copy, `strings.ts`, `src/lib/onboarding.ts`, `eval/tenant-scoping.test.ts`, `eval/webhooks.test.ts`, `.env.example`, `docs/env-setup.md`, migration for `status` values (`migration_required`, `retired`) if enumerated, `supabase/rollbacks/aurinko_columns_drop.sql`, vendor/runbook/capability docs.

## Database impact
Status-value widening on `shop_connections` (if CHECK-constrained); data migration marking Aurinko rows; `sync_status='orphaned'` re-marking. No drops.

## Migration impact
One additive, idempotent migration (value widening + row re-marking). Occupies the DB-sensitive slot. Rollback: rows re-marked `connected` only if the Aurinko code is restored (PR revert) — documented in the migration header.

## API impact
Aurinko routes removed (404 after deploy — any Aurinko webhook still firing is dropped; the subscription is deleted on reconnect/disconnect where the token still works, else expires vendor-side).

## UI impact
Calendar view switcher (day/week/month/agenda), sync badges, reconnect notice, optional-calendar copy; all states written; skeletons for view loads.

## Permission impact
Reconnect: owner/admin. Views: all members (techs see per E04-04 later — no change here).

## Tenant-isolation impact
Migration touches all shops' rows by provider, not by shop input; per-shop reconnect binds to the session shop. Tenant-isolation suite green; inventory test updated by removal only.

## Security impact
Positive: deletes a credential class + an inbound webhook surface. Aurinko tokens: revoked via API where possible during migration (best-effort), credentials_enc for `retired` rows nulled after the reconnect window (data-minimization; do it in the same migration if the window has passed at deploy, else a follow-up cron sweep — Builder documents which).

## Idempotency requirements
Migration re-runnable; mirror re-pointing keyed by iCalUID/extended property (search before create); reconnect twice = one row.

## Observability requirements
Count of `migration_required` shops on `/api/health` (until zero); SEV-2 alert if any shop's email intake fails post-cutover for reasons other than "not reconnected".

## Analytics requirements
`Calendar connected` re-emitted on reconnect (provider dimension).

## Feature flag
`nativeCalendarAuthority` → default true then removed; no new flag. Rollback path is the PR revert (documented in `runbooks/emergency-feature-shutdown.md`).

## Automated tests
- Invariant lock: booking/reschedule/cancel executors succeed with zero `shop_connections` rows (integration); source-scan: no `aurinko` import; no `"Connect Google Calendar via Aurinko"` string.
- Migration: seeded Aurinko-connected shop → `migration_required`; reconnect → `retired` + Google row; mirrors re-pointed or `orphaned`, never duplicated.
- Views: loader per range (day/week/month/agenda) with spans + blocks; empty states; mobile default view.
- Regression: reminders/no-show/ROI/BI suites unchanged; E02-01…05 suites green.

## Manual acceptance procedure
1. Builder (Preview): brand-new shop, nothing connected → voice-book → approve → reminder staged → complete → close. Zero errors, zero "connect calendar" prompts on the booking path.
2. Builder: shop seeded as Aurinko-connected → after deploy sees the reconnect notice; reconnect Google Calendar + Gmail → notice clears; existing mirrored appointment either re-pointed or shows "mirrored before the move"; no duplicate on the Google calendar.
3. Builder: switch views day/week/month/agenda; block + multi-day job render in all; sync badge Retry works.
4. Builder: Receptionist/onboarding copy reads calendar as optional; activation gate still counts calendar as an OR-path (D-035).
5. **Founder:** steps 1–3 on the founder shop in Preview; production deploy plan: (a) `GOOGLE_OAUTH_*` present in Production, (b) deploy batch, (c) reconnect the founder/pilot shops, (d) remove `AURINKO_*` from Production after the window; each step recorded in `autorun-log.md` with PASS/FAIL. **BATCH 4 COMPLETE** line only after (c).

## Failure cases
- Shop never reconnects → appointments unaffected; mirroring/intake paused with a persistent, honest notice; health count stays > 0 (founder sees it).
- Google env missing in Production at deploy → tiles show NOT AVAILABLE; reconnect impossible — **hard stop before deploy** (autorun rule 5: production action required) — the founder precondition exists to prevent this.
- Re-pointing finds two candidate events → mark `orphaned` with reason, never guess.

## Rollback strategy
Revert the PR (restores Aurinko code + flag default off); migration rows re-marked by the rollback SQL in the migration header; dormant columns still hold the old tokens until nulled (do the nulling only after the window — so a rollback within the window is lossless).

## Definition of done
`../12-definition-of-done.md` plus: invariant-lock + source-scan tests committed; founder deploy plan steps (a)–(c) PASS recorded; `vendors/removed/aurinko.md`, registry, C-09, runbooks, `04`/capability-status, E02 epic acceptance criteria 1–5 recorded as met (criterion 3/4 evidence from E02-02/E02-01); `- NEXT: BATCH COMPLETE — Batch 4` written by the Builder in `autorun-log.md`.
