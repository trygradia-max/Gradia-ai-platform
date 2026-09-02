# E02-02 — Native appointments as source of truth (D-013): `CalendarProvider` seam, `shop_connections`, sync state, authority inversion

_Cut 2026-09-01 by the Organizer for autorun Batch 4 (`../program/autorun.md`). Specification only._

## Ticket ID
E02-02

## Epic
E02 — Native calendar and availability (phase P2)

## Status
**draft — batch-gated.** Autorun Batch 4, queue item 16. Enters after E02-01 is committed on `auto/batch-4`. Risk class **calendar + database-sensitive**. Founder acceptance **YES**. Decisions binding: D-013, D-014, D-029 (ADR-002), D-030, D-050, D-018 (new tables under membership RLS — requires E01-01 merged). No open founder decision blocks it. **ADR required inside the ticket:** busy-block storage shape + sync cadence (E02 epic §Dependencies) — written as `adr/ADR-005-calendar-sync-state.md` (proposed → accepted at review).

## Priority
P2 — High. The hard Aurinko token gate (`approvals.ts:1318-1325`) refuses every booking for a shop without a live Google grant — the adoption cliff at the first-value moment (E02 epic, C-09). The single-provider `shops.aurinko_*` column set also makes Google *and* Microsoft on one shop impossible, which D-014/D-050 require.

## Objective
Make the `appointments` table unconditionally authoritative: the booking executor writes Gradia state first and treats every external calendar as a best-effort mirror behind a Gradia-owned `CalendarProvider` interface; provider credentials and sync cursors move to a per-provider `shop_connections` table; mirror identity and sync health live in provider-generic columns; external busy time lands in `external_busy_blocks`. Aurinko becomes the first adapter behind the seam (retired in E02-06 after E02-03/04 replace it).

## User outcome
A shop with no calendar connected can approve a booking and it exists, reminds, and closes like any other. When a calendar is connected, the appointment mirrors out; if the mirror fails, the owner sees "not synced — retry" on the job, never a refused booking.

## Current code references
- **Hard gate:** `src/lib/approvals.ts:1309-1325` — `loadShopWithToken` + `getAurinkoAccessTokenForShop`; without a token the booking is rolled back with "Connect Google Calendar via Aurinko (in /settings) before approving bookings." Despite `:1339-1344` already stating DB-first ordering.
- `executeBookAppointment()` `:1250`; serialized write `:1369` (`enforceConflicts: FEATURES.conflictEnforcement`); calendar sync second with `calendarId = "primary"` hardcoded `:1531-1535`; `createCalendarEvent` `:1544`; back-link `aurinko_calendar_id`/`aurinko_event_id` `:1553-1566`; failure recorded as `calendar_sync: {status:"failed"}` reconciliation `:1568-1579`; result `calendarEventId` `:1641-1644`.
- `executeCancelAppointment()` `:971` — external delete when `aurinko_event_id && aurinko_calendar_id` `:990-1005`, non-fatal `:1011`. Reschedule executor `:803-809`, mirror update `:917-940` ("mirror follows the truth" `:914-916`).
- Owner-direct paths: `src/app/actions/jobs.ts:278` `rescheduleJob()` — serialized move `:323-333` then best-effort `updateCalendarEventTime` `:342-366`; `blockTime()` `:409` — **never mirrored** (`:440-450`).
- **No seam exists:** `src/lib/calendar-provider.ts` and `src/lib/email-provider.ts` do not exist; closest pattern `src/lib/crm-provider.ts:49-89`. Direct Aurinko imports at `src/lib/approvals.ts:35-40`, `src/app/actions/jobs.ts:8-10`, `src/lib/availability.ts:43`.
- Aurinko client `src/lib/aurinko.ts` (755 lines): `listCalendarEvents` `:527`, `createCalendarEvent` `:571`, `updateCalendarEventTime` `:614`, `deleteCalendarEvent` `:643`, `getAccessTokenForShop` `:718` (decrypts `aurinko_access_token_enc`, refresh at 60s buffer `:30`).
- **Schema (single-provider):** `shops.aurinko_account_id/aurinko_account_email/aurinko_access_token_enc/aurinko_token_expires_at/aurinko_subscription_id` (`20260512110000_shop_aurinko.sql`, `20260515200000_encrypt_aurinko_token.sql`, `20260522110000_aurinko_token_expiry.sql`); `appointments.aurinko_calendar_id/aurinko_event_id` + partial unique on `aurinko_event_id` (`20260512130000_book_appointment.sql:9-17`). No `integrations`/`shop_integrations` table; no `external_busy_blocks`; block-time is `internal_note = "[block-time]"` (`jobs.ts:447`, `data/calendar.ts:110`).
- Indirect `aurinko_*` readers (must switch to `shop_connections` health): `src/lib/agent-runtime.ts:382,922,1500,1739`; `src/lib/owner-agent.ts:165,894`; `src/lib/bi-tools.ts:523-556`; `src/lib/data/channels.ts:101,131`; `src/lib/data/agents.ts:45-46,85-87,113-115`; `src/lib/onboarding.ts:12,23`; `src/app/api/recovery/import/route.ts:83-88`; `src/components/gradia/onboarding-wizard.tsx:146`; `src/components/gradia/onboarding-launch-steps.tsx:108`; settings tiles `src/app/(dashboard)/settings/page.tsx:278-289,308-321` (Email and Calendar tiles are the *same* Aurinko connection rendered twice).
- Target model: `03-domain-model.md` §5, §14 (`shop_connections` fields), cross-cutting rule "provider identifiers are mirrors, never identity"; ADR-002.
- Provider literal: `src/lib/provider-events.ts:33` (`"aurinko"`).

## Exact scope
1. **`CalendarProvider` seam** — `src/lib/calendar-provider.ts`: interface `{ listBusy(range), createEvent, updateEventTime, deleteEvent, capabilities }` keyed by `provider` (`aurinko | google | microsoft`), plus a dispatcher that resolves a shop's connected provider(s) from `shop_connections`. Aurinko adapter = today's functions moved behind it (no behavior change). **Email seam** — `src/lib/email-provider.ts`: `{ sendEmail({to, subject, body, inReplyTo?}), ... }` with the Aurinko adapter wrapping `sendEmailMessage` (`approvals.ts:1994` becomes the only call site of the seam). No vendor types outside the adapters (principle #8, ADR-002 test-locked by a source-scan test).
2. **`shop_connections` table** (one row per shop × provider): `provider`, `status` (`connected|degraded|expired|disconnected`), `account_identifier`, `account_email`, `credentials_enc` (AES-256-GCM via `crypto.ts`), `token_expires_at`, `sync_cursor jsonb`, `webhook_subscription jsonb`, `last_success_at`, `last_failure_at`, `last_error`, timestamps; unique `(shop_id, provider)`; RLS under E01 membership policies (owner/admin read health only — **credentials never readable by any session role**: column-level privacy via a view or the service-role-only read path, per 03 §14 "column privacy"). **Backfill** from `shops.aurinko_*` into an `aurinko` row (idempotent). Old columns become **dual-read → dual-write → dormant** within this ticket (reads switch to `shop_connections`; the callback still writes both until E02-06 removes the Aurinko path). No column drops.
3. **Provider-generic mirror columns on `appointments`:** `external_provider`, `external_calendar_id`, `external_event_id`, `sync_status` (`pending|synced|failed|orphaned`), `synced_at`, `sync_error`; partial unique `(external_provider, external_event_id)`; backfill from `aurinko_calendar_id/aurinko_event_id` with `external_provider='aurinko'`. Old `aurinko_*` appointment columns dual-written until E02-06, then dormant. **`appointments.kind`** (`job|block`, default `job`) replaces the `[block-time]` sentinel (backfill from `internal_note`; the sentinel keeps being written for one release for old readers, then E02-06 drops the write).
4. **`external_busy_blocks` table:** `(shop_id, provider, external_id, starts_at, ends_at, all_day, title_redacted, updated_at)` unique `(shop_id, provider, external_id)`; populated by the sync sweep (item 6); consumed by the availability engine (E02-01 seam) and by `checkAvailability` **instead of** the live 3.5 s calendar fetch (`availability.ts:986-1024`) once populated — the live leg stays as fallback until E02-05 removes it. Storage shape + cadence = ADR-005.
5. **Authority inversion behind `FEATURES.nativeCalendarAuthority` (default OFF this ticket):** with the flag on, `executeBookAppointment` never requires a connection — the token gate `:1318-1325` is skipped; mirror creation runs post-commit through the seam; failure → `sync_status='failed'` + reconciliation record (existing pattern `:1568-1579`) + owner-visible "not synced" state; **no rollback of the appointment ever.** Same for reschedule/cancel executors and the owner-direct `rescheduleJob`/`blockTime` (block-time now mirrors as a busy event when a calendar is connected — closes the "blocks invisible outside Gradia" gap). Flag off = current behavior byte-for-byte (characterization tests).
6. **Sync sweep + repair (cron):** one new cron route (existing `Bearer CRON_SECRET` pattern, `forShop`-converted from day one) that per connected shop: pulls busy ranges into `external_busy_blocks` (through the seam — Aurinko `listCalendarEvents` today, Google/Microsoft deltas later), retries `sync_status='failed'` mirrors (bounded), and flags `orphaned` when a mirrored event disappeared externally. **External edits never move a Gradia appointment** — they raise a flag on the job (E02 acceptance criterion 3). Cadence per ADR-005 (proposal: 10 min, bounded per shop).
7. **Multi-day spans:** `ends_at` treated as the span end everywhere (engine, mirror events, calendar week rendering of a job that crosses days).
8. **Connection health surfaces** read `shop_connections`: settings tiles (`settings/page.tsx:278-321`) become **two independent** ConnectionTiles (Calendar / Email) with 3 states + "Reconnect" on `expired/degraded`; agent/BI/onboarding readers listed above switch from `aurinko_*` to the connection health helper.
9. Docs: ADR-005; `03-domain-model.md` §5/§14 status lines; `vendors/transitional/aurinko.md` "first adapter behind CalendarProvider" note; `runbooks/calendar-outage.md` updated for the flag.

## Explicit non-goals
- No Google/Microsoft adapters (E02-03/04); no Aurinko deletion (E02-06); no flag default flip (E02-06).
- No conflict-policy change or enforcement flip (E02-05).
- No per-member calendars (E04-05); no online booking; no external calendar ever becoming authoritative again (D-013).
- No column drops. No email pipeline changes beyond routing the one send call through the seam.

## Dependencies
- E02-01 committed (seam function for busy source). **E01-01 merged** (membership RLS for new tables, D-018). P0-004A (serialized write) done.
- Decisions: D-013, D-014, D-029, D-030, D-050 — Approved. ADR-005 written in-ticket (mechanism, Organizer/Reviewer sign-off; founder acceptance covers the behavior).

## Expected modules affected
New: `src/lib/calendar-provider.ts`, `src/lib/email-provider.ts`, `src/lib/calendar-sync.ts`, `src/app/api/cron/calendar-sync/route.ts`, `src/lib/shop-connections.ts`, migration(s), ADR-005. Modified: `src/lib/approvals.ts` (book/reschedule/cancel/email executors), `src/app/actions/jobs.ts`, `src/lib/availability.ts` (busy source), `src/lib/aurinko.ts` (adapter wrapping only), `src/app/api/aurinko/auth/callback/route.ts` + `src/app/actions/shop.ts` (write `shop_connections`), `src/lib/data/calendar.ts`, `calendar-week.tsx`, settings tiles, the indirect readers list, `src/lib/features.ts`, `vercel.json` (cron), `.env.example` (none new expected).

## Database impact
New tables `shop_connections`, `external_busy_blocks`; additive columns on `appointments` (`kind`, `external_*`, `sync_*`); backfills; new indexes (`external_busy_blocks(shop_id, starts_at)`, `appointments(shop_id, sync_status)` partial). All under E01 membership RLS; `shop_connections.credentials_enc` unreadable to session roles.

## Migration impact
Two to three additive, idempotent, numbered migrations (tables + columns + backfill), each re-runnable; rollback note per file. **Occupies the DB-sensitive WIP slot.** No drops.

## API impact
Internal seams only. New cron route (bearer-gated). No public routes.

## UI impact
Two ConnectionTiles (Calendar, Email) with 3 states + Reconnect; job/appointment shows sync badge (`synced` / `not synced — retry` / `flagged: changed externally`) as icon + text; `/calendar` renders spans and `kind=block`. Written states in `strings.ts`.

## Permission impact
Connect/disconnect/reconnect and retry-sync: owner/admin (D-048). Health visible to all members.

## Tenant-isolation impact
New tables ship with membership RLS + tenant-isolation tests (E01 RLS suite extension). Cron and executors use `forShop` (ADR-003). Credentials column: negative test that a session client cannot select it.

## Security impact
Credentials move from the `shops` god-table (visible to owner sessions — audit 05/09) into a column no session can read — a net security improvement (03 §14). Encryption unchanged (`crypto.ts`). Redact external event titles in `external_busy_blocks` (store a redacted marker, not customer names from the owner's personal calendar).

## Idempotency requirements
Mirror creation keyed by `appointment.id` (provider event ids stored, never used as identity); sweep upserts busy blocks on `(shop_id, provider, external_id)`; retries bounded; replaying the sweep twice produces no duplicates (test).

## Observability requirements
`[calendar-sync]` structured logs with shop_id + provider + counts; failures emit through the P0-012 alert seam at SEV-3 (aggregate) — one alert per sweep, not per shop; health endpoint gains the cron's last-success stamp.

## Analytics requirements
`Calendar connected` becomes a genuine optional funnel step (14-product-analytics) — event emitted from the connection helper if the D-045 table exists; otherwise noted as pending instrumentation.

## Feature flag
`FEATURES.nativeCalendarAuthority` — default **false** in this ticket (schema, seam, sweep, and health surfaces are live regardless; only the executor gate skip is flagged). Flip = E02-06.

## Automated tests
- Characterization (before refactor): book/reschedule/cancel with flag off — identical outputs, identical reconciliation records.
- Unit: seam dispatch by provider; Aurinko adapter parity; `kind` helper; span handling.
- Integration (real Postgres): migrations re-run twice; backfill equivalence (`aurinko_*` → `shop_connections`/`external_*`); busy-block upsert idempotency; sweep flags orphaned + external-edit without moving the appointment; flag-on booking with zero connections succeeds and reminders schedule.
- Tenant-isolation: `shop_connections`, `external_busy_blocks` cross-shop negatives; credentials column unreadable by session role.
- Source-scan: no `aurinko` import outside `src/lib/aurinko.ts` + the adapter + the OAuth routes (ADR-002 lock) — allowlist explicit.
- Regression: `eval/availability.test.ts`, `eval/booking-atomicity.test.ts`, `eval/appointment-changes.test.ts` green unchanged.

## Manual acceptance procedure
1. Builder (local staging): connect Aurinko on a test shop; run migrations; confirm the `shop_connections` row + `external_*` backfill; disconnect/reconnect via the tiles.
2. Builder: flag off — approve a booking; behavior identical to today. Flag on (local only) — approve a booking on a shop with **no** connection: appointment exists, reminder pending action staged, no error; on a connected shop: mirror created, `sync_status=synced`.
3. Builder: delete the mirrored event externally; run the sweep → job shows "changed externally" flag; appointment time unchanged.
4. Builder: create a personal event externally → after the sweep it appears in `external_busy_blocks` and blocks slots (E02-01 engine).
5. **Founder:** on the batch preview + a founder test shop: steps 2–4 (flag on via preview env is a founder action); confirm the tiles and badges read correctly; record PASS/FAIL in `autorun-log.md`. Production keeps the flag off until E02-06.

## Failure cases
- Mirror create fails (provider down/expired) → appointment stands, `sync_status=failed`, retry by sweep, owner badge; connection `status=degraded/expired` → tile shows Reconnect.
- Sweep truncation/timeouts → bounded per shop, next run continues from the cursor; never deletes busy blocks it could not re-verify.
- Backfill finds an `aurinko_event_id` collision → migration aborts loudly (unique) — resolve before rerun; documented.

## Rollback strategy
Flag off restores today's executor semantics instantly. Tables/columns are additive and dormant if the code is reverted; the sweep cron entry can be removed independently. Dual-write keeps `aurinko_*` columns current, so a full revert of the code loses nothing.

## Definition of done
`../12-definition-of-done.md` plus: ADR-005 accepted; migrations re-run twice + rollback notes; characterization + tenant-isolation + source-scan tests green; founder step 5 PASS recorded; `03-domain-model.md`, `04-capability-map.md`, `program/capability-status.md`, `runbooks/calendar-outage.md`, `vendors/transitional/aurinko.md` updated in the same change.
