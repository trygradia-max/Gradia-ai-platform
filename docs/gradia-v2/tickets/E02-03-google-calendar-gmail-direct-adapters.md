# E02-03 — Direct Google Calendar + Gmail adapters behind `CalendarProvider` / email seam (D-050)

_Cut 2026-09-01 by the Organizer for autorun Batch 4 (`../program/autorun.md`). Specification only._

## Ticket ID
E02-03

## Epic
E02 — Native calendar and availability (phase P2)

## Status
**draft — batch-gated.** Autorun Batch 4, queue item 17. Enters after E02-02 is committed on `auto/batch-4`. Risk class **calendar** (external write path) + **security** (new OAuth + credential storage). Founder acceptance **YES**. Decisions binding: D-050 (Aurinko → direct adapters, Batch 4), D-029/ADR-002, D-013/D-014, D-023, D-043. **Founder preconditions (platform-level, one-time — allowed under principle #9):** a Google Cloud project with an OAuth client (web) whose redirect URIs include the preview + production callback; `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` set in Vercel Preview (and Production at cutover). Gmail restricted-scope verification (CASA) is a founder-run process — see Risks. The Builder never sets env vars or creates cloud resources (autorun rule 6).

## Priority
P2 — High. D-050 replaces the transitional aggregator; Google is the only calendar/mail provider any current shop uses (`aurinko.ts:76` `serviceType: "Google"`), so this adapter is the one that must reach parity before Aurinko can be retired (E02-06).

## Objective
Implement `google` as a `CalendarProvider` adapter (event mirror CRUD, busy ingestion with incremental sync, change notifications with polling fallback) and a Gmail adapter for the email seam (inbound intake into the existing classify → stage pipeline; outbound send **in-thread**; message-id idempotency), each with per-shop OAuth stored in `shop_connections`, independent consents for calendar vs mail, and a ConnectionTile per surface. Vendor adoption recorded via the 17-point checklist.

## User outcome
An owner clicks Connect on the Calendar tile, approves Google Calendar access only, and their appointments mirror to Google while their Google busy time blocks Gradia slots. Connecting Gmail is a separate, optional consent; replies to a customer's email land in the same thread instead of as a new message.

## Current code references
- **No direct Google code exists**: zero matches for `googleapis|accounts.google.com|oauth2` in `src/` and `package.json` (verified 2026-09-01). No `GOOGLE_*` env keys in `.env.example`.
- Aurinko OAuth to copy the pattern from: `src/app/api/aurinko/auth/start/route.ts:48-88` (state/next cookies `:21-22`, gate on client id `:51`), callback `src/app/api/aurinko/auth/callback/route.ts:55-129` (token exchange `:87`, subscription `:100-109`, encryption `:117`, shop write `:125-129`). One grant covers mail + calendar today (`DEFAULT_SCOPES` `aurinko.ts:67`; pre-Calendar shops must reconnect `:61-66`).
- Seam (from E02-02): `src/lib/calendar-provider.ts`, `src/lib/email-provider.ts`; `shop_connections`; `external_busy_blocks`; provider-generic `appointments.external_*`.
- Calendar consumers: `approvals.ts` executors (book `:1250`, cancel `:971`, reschedule `:803`), `src/app/actions/jobs.ts:278,409`, sweep `src/lib/calendar-sync.ts` (E02-02).
- Email: inbound `src/app/api/aurinko/webhook/route.ts:68-425` (signature `:70-73`, shop by account `:94`, classify → stage; `aurinko_message_id` `:178`, `aurinko_inbound_message_id` `:310`); outbound `approvals.ts:1979-1994` (Gmail gate + `sendEmailMessage`), stores `aurinko_message_id` `:2027`; **no threading** (`aurinko.ts:359-364`). Email classifier polarity gap (`vendors/transitional/aurinko.md`) is E07's, not this ticket's.
- Idempotency: `src/lib/provider-events.ts:33` provider literals (add `google`); `claim_provider_event` RPC (`20260812120000_webhook_idempotency.sql`) — D-023.
- Availability leg today: `availability.ts:986-1024` live Aurinko fetch, timeout 3.5 s `:454` — replaced by `external_busy_blocks` (E02-02) which this adapter fills.
- Specs: `vendors/planned-evaluations/google-calendar.md` (requirements + "requires verification" items); `vendors/README.md` 17-point checklist; ADR-002.
- Settings tiles: `settings/page.tsx:278-289` (Email), `:308-321` (Calendar, label "Google Calendar").

## Exact scope
1. **Vendor adoption record:** move `vendors/planned-evaluations/google-calendar.md` → `vendors/core/google.md` with the 17-point checklist filled (founder approval = D-050); registry row updated. Each "requires verification" item resolved from the Google API docs during the build and recorded (sync-token semantics, watch channel lifetime, quota model, Gmail push option).
2. **OAuth (two consents):** `/api/google/auth/start?surface=calendar|mail` + callback, CSRF-nonce cookie pattern, open-redirect guard, PKCE; **calendar consent requests only calendar scopes** (`calendar.events` + `calendar.readonly` for free/busy — narrowest that works; no Gmail scopes); mail consent requests Gmail scopes (`gmail.readonly` + `gmail.send`, or `gmail.modify` only if labels are required — Builder documents the choice). Tokens (refresh + access, expiry) AES-256-GCM in `shop_connections.credentials_enc`, one row per `(shop, 'google_calendar')` and `(shop, 'google_mail')`; transparent refresh with the 60 s buffer pattern; `status=expired` + owner Reconnect on invalid_grant.
3. **Calendar adapter** (`src/lib/providers/google-calendar.ts`): `createEvent/updateEventTime/deleteEvent` on the shop's chosen calendar (default `primary`, selectable later — store `external_calendar_id`), `listBusy(range)` via `events.list` with `syncToken` incremental sync persisted in `shop_connections.sync_cursor` (full resync on 410 GONE), timezone/all-day/recurring-instance expansion (`singleEvents=true`). Mirrored Gradia events are tagged (extended property `gradia_appointment_id`) so the sweep never re-ingests our own mirrors as busy blocks (parity with `availability.ts:1010-1013`). Rate/quota: bounded per shop per sweep; 429/403-rate → backoff, connection `degraded`, never a thrown error into executors.
4. **Change notifications:** `events.watch` channel per connection (renewal before expiry, stored in `webhook_subscription`), receiver `/api/google/calendar/webhook` (channel token verification; notification = "run the sweep for this shop now"); **polling fallback** = the E02-02 sweep cadence. Idempotency via `provider_events` (`google`, channel message number / resource id + timestamp).
5. **Gmail adapter** (`src/lib/providers/gmail.ts`) behind the email seam: outbound `sendEmail` with RFC-2822 `In-Reply-To`/`References` + `threadId` when replying (fixes the Aurinko threading gap — the appointment/lead thread stores the provider thread id in adapter-owned columns/jsonb, never as identity); inbound intake via `history.list` incremental fetch from a cron sweep (baseline) with optional Gmail push (Pub/Sub) only if the founder provisions a topic — **polling is the shipped default** (no new cloud resource required for launch). Inbound messages flow into the **provider-agnostic intake function** extracted from the Aurinko webhook route (`ingestInboundEmail({shopId, provider, messageId, threadId, from, subject, text, receivedAt})` in `src/lib/email-intake.ts`) — the Aurinko route becomes a thin caller (E02-06 deletes it). Own-mailbox copies skipped; `provider_events` claim on `(google, gmail message id)` (D-023).
6. **ConnectionTiles:** Calendar tile → Google Calendar (independent of Email); Email tile → Gmail; each 3-state + Reconnect; identity shown = account email; disconnect revokes the Google token (`oauth2/revoke`) and marks the row `disconnected` (rows kept for history; mirrors keep their `external_*` refs, `sync_status=orphaned` on the next sweep only if the event is gone).
7. **Aurinko coexistence (this ticket only):** a shop may have `aurinko` **or** `google_*` rows; dispatcher prefers `google_*` when both exist; nothing here removes Aurinko (E02-06).
8. **Vendor page + runbook:** `vendors/core/google.md`; `runbooks/calendar-outage.md` gains the Google-specific section (quota exhaustion, watch-channel expiry, revoked consent).
9. Tests + evals per §Automated tests; `.env.example` documents `GOOGLE_OAUTH_CLIENT_ID/SECRET` (+ optional `GOOGLE_PUBSUB_TOPIC`).

## Explicit non-goals
- No Aurinko removal, no `nativeCalendarAuthority` flip (E02-06). No Microsoft (E02-04).
- No email UX changes (composer, threading UI, delivery tracking, classifier polarity — E07). No unsubscribe/consent model for email (E07).
- No calendar picker UI beyond `primary` default (a settings dropdown may ship if trivial; not required).
- No Google Contacts import (E03 fast-follow), no Google Business Profile.
- No public online-booking route.

## Dependencies
- E02-02 merged/committed (seams, `shop_connections`, `external_busy_blocks`, sweep). E01-01 (membership RLS) merged.
- Decisions: D-050, D-029, D-013, D-014, D-023, D-043 — Approved. Vendor adoption checklist completed in-ticket (founder approval already given by D-050).
- **Founder precondition:** Google Cloud OAuth client + Preview env vars (see Status). Without them the Builder ships the code with the tiles showing NOT AVAILABLE (env-absent, honest copy — not "Coming soon" roadmap language; see PROD-CONFIG-AUDIT) and acceptance waits.

## Expected modules affected
New: `src/lib/providers/google-calendar.ts`, `src/lib/providers/gmail.ts`, `src/lib/providers/google-oauth.ts`, `src/lib/email-intake.ts`, `src/app/api/google/auth/start/route.ts`, `src/app/api/google/auth/callback/route.ts`, `src/app/api/google/calendar/webhook/route.ts`, `src/app/api/cron/mail-sync/route.ts` (or fold into `calendar-sync` — Builder chooses, one cron preferred), `vendors/core/google.md`. Modified: `calendar-provider.ts`/`email-provider.ts` registries, `src/app/api/aurinko/webhook/route.ts` (delegate to intake), settings tiles, `provider-events.ts` literals, `.env.example`, `vercel.json` (if a new cron), `runbooks/calendar-outage.md`, `vendors/registry.md`. Dependency: `googleapis` (or `google-auth-library` + REST) — pinned; justified in the vendor page (no other new packages).

## Database impact
Rows in `shop_connections` (new provider values), `external_busy_blocks`, `provider_events`. Possibly one additive migration: a CHECK/enum widening for `provider` values and an adapter-owned `email_threads` mapping (`shop_id, provider, provider_thread_id, customer_id|lead_id`) if threading needs it (Builder may store the thread id in `interactions` metadata jsonb instead — preferred, zero migration).

## Migration impact
Zero or one additive, idempotent migration (provider value widening / thread map). Confirm at slotting; DB-sensitive slot only if a migration is written.

## API impact
New OAuth routes (auth-gated to the session owner/admin), one unauthenticated webhook receiver (channel-token verified, replay-claimed). No public data routes.

## UI impact
Two ConnectionTiles rewired (Google Calendar, Gmail) with written states incl. NOT AVAILABLE (env absent), CONNECTING, CONNECTED (+account email, Manage/Disconnect), EXPIRED (Reconnect). No vendor jargon beyond the product names owners recognize (Google Calendar / Gmail).

## Permission impact
Connect/disconnect: owner/admin (D-048). OAuth callback binds to the **session's** active shop (never to a shop id carried in state) — cross-tenant negative test.

## Tenant-isolation impact
All adapter reads/writes via `forShop` or session client; webhook receiver resolves the shop from the stored channel id/token → `shop_connections` row (indexed), never from payload-supplied ids. Tenant-isolation tests: connection rows, busy blocks, intake results cannot cross shops.

## Security impact
New credential class (Google refresh tokens) — encrypted at rest, never logged, revocable. CSRF/PKCE on OAuth. Webhook channel token = per-connection random secret. Restricted-scope posture: calendar connect never requests Gmail scopes (source-scan test on the scope constants). Redirect allow-list. **Risk:** until Google verifies the OAuth app for Gmail restricted scopes, Gmail connect works only for test users listed on the consent screen (100-user cap) and shows an "unverified app" warning — the tile copy must say so honestly when `GOOGLE_GMAIL_VERIFIED` (env flag) is absent. Calendar scopes are "sensitive", not "restricted" — lighter verification; still founder-run.

## Idempotency requirements
Inbound mail keyed by Gmail message id via `provider_events` (D-023) — redelivery/duplicate history pages produce one intake. Calendar notifications claimed by channel message number; sweeps upsert. Mirror creation keyed by `appointment.id` (extended property) so a retried create never duplicates an event (adapter first searches by the extended property before creating).

## Observability requirements
`[google]` structured logs with shop_id, surface, operation, quota status; connection health (`last_success_at/last_failure_at/last_error`) updated on every call; SEV-2 alert through the P0-012 seam when a shop's connection flips to `expired` (owner-facing reconnect state also shown); sweep counters on `/api/health`.

## Analytics requirements
`Calendar connected` / `Email connected` events (D-045 table if present; else pending).

## Feature flag
`FEATURES.googleDirect` — default **true** in Preview once env is present; the tile is additionally env-gated (absent client id → NOT AVAILABLE). Rollback = flag off (dispatcher falls back to Aurinko rows for existing shops; Google rows stay dormant).

## Automated tests
- Unit (mocked HTTP): OAuth state/PKCE round trip; token refresh + invalid_grant → expired; event create/update/delete payload shapes (timezone, all-day); syncToken incremental + 410 resync; own-mirror exclusion via extended property; Gmail send builds `In-Reply-To`/`References`/`threadId`; history.list incremental intake; own-mailbox skip.
- Provider-contract tests: recorded fixtures for each Google endpoint used (no live calls in CI).
- Idempotency: duplicate notification / duplicate history page → single intake; retried mirror create → single event.
- Tenant-isolation: callback binds to session shop; webhook shop resolution by channel only; cross-shop negatives.
- Source-scan: no `googleapis` import outside `src/lib/providers/google-*.ts` (ADR-002 lock); calendar scope constant contains no `gmail` scope.
- Regression: booking/reschedule/cancel executors + reminders unchanged with a Google-connected shop (integration tier, mocked adapter); E02-01 slot engine consumes Google busy blocks.
- Eval: email classifier/drafter suites unchanged (no prompt change) — assert no prompt file diff.

## Manual acceptance procedure
1. **Founder:** Google Cloud OAuth client created; Preview env vars set; test user (founder account) added to the consent screen. Confirm in `autorun-log.md`.
2. Builder (Preview): connect Google Calendar on a test shop (calendar consent only — screenshot the consent scopes); approve a booking → event appears in Google with the extended property; reschedule/cancel mirror; create a Google event → after sweep it blocks a slot in `/calendar` and in the voice alternatives (E02-01).
3. Builder: connect Gmail (separate consent); send a test email to the shop mailbox → lead card staged once; redeliver/notify twice → still one; approve an email reply → arrives in the same Gmail thread.
4. Builder: revoke access from the Google account page → next sweep marks `expired`; tile shows Reconnect; reconnect restores.
5. **Founder:** repeat steps 2–4 on the founder's own Google account; confirm tile copy and the unverified-app warning behavior; record PASS/FAIL. Production env stays untouched until E02-06 cutover planning.

## Failure cases
- Quota/429 → backoff, `degraded`, executors unaffected (appointment stands). 
- Watch channel expired unnoticed → polling fallback keeps busy blocks within one sweep cadence; renewal failure alerts SEV-3.
- Consent revoked → `expired`, owner reconnect state, SEV-2 alert; no data loss (Gradia is the source of truth).
- Gmail unverified-app cap reached → connect fails with a written explanation; calendar unaffected.
- Google outage → `runbooks/calendar-outage.md` (updated) — booking continues natively.

## Rollback strategy
Flag off → dispatcher ignores `google_*` rows; Aurinko rows (still present until E02-06) resume. Revoke tokens optionally. No schema to unwind beyond dormant rows. Watch channels expire on their own (≤ 1 week) or are stopped by the disconnect path.

## Definition of done
`../12-definition-of-done.md` plus: `vendors/core/google.md` with the 17-point checklist and every "requires verification" item resolved or explicitly deferred with an owner; provider-contract fixtures committed; founder step 5 PASS recorded; `vendors/registry.md`, `runbooks/calendar-outage.md`, `04-capability-map.md`, `program/capability-status.md` updated in the same change.
