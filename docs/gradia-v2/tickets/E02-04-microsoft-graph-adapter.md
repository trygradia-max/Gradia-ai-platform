# E02-04 — Microsoft Graph adapter (Outlook calendar + mail) behind `CalendarProvider` / email seam

_Cut 2026-09-01 by the Organizer for autorun Batch 4 (`../program/autorun.md`). Specification only._

## Ticket ID
E02-04

## Epic
E02 — Native calendar and availability (phase P2)

## Status
**draft — batch-gated.** Autorun Batch 4, queue item 18. Enters after E02-03 is committed. Risk class **calendar** + **security** (new OAuth). Founder acceptance **YES**. Decisions binding: D-014 (Microsoft first-class sync), D-043 (Google-first, Microsoft fast-follow — ships behind its own flag, does not hold the E02 exit), D-050 (direct Graph, not Aurinko), D-029/ADR-002, D-023. **Founder precondition (platform-level, once):** Azure AD app registration (multi-tenant + personal accounts), redirect URIs, `MICROSOFT_OAUTH_CLIENT_ID` / `MICROSOFT_OAUTH_CLIENT_SECRET` (+ tenant `common`) in Vercel Preview. Publisher verification is founder-run (see Risks).

## Priority
P2 — Medium-high. Net-new capability: no Microsoft path exists at all today, so shops on Microsoft 365 / Outlook.com cannot connect calendar or mail (`vendors/planned-evaluations/microsoft-graph.md` §Current state). D-036's established-shop ICP raises the odds of Microsoft 365 tenants.

## Objective
Implement `microsoft` as a second adapter behind the exact interfaces E02-02/E02-03 established: Outlook calendar mirror CRUD, busy ingestion via delta queries with Graph change-notification subscriptions + polling fallback, and Outlook mail intake/send in-thread — without leaking Graph's series-master/occurrence model or any Graph type outside the adapter.

## User outcome
A shop on Microsoft 365 connects Outlook Calendar (and optionally Outlook mail) from the same two tiles and gets exactly what a Google shop gets: appointments mirrored out, busy time flowing in, replies in-thread.

## Current code references
- **None exists**: zero matches for `graph.microsoft.com|login.microsoftonline|msal` in `src/`/`package.json` (verified 2026-09-01).
- Interfaces + patterns to conform to: `src/lib/calendar-provider.ts`, `src/lib/email-provider.ts`, `src/lib/email-intake.ts`, `src/lib/providers/google-*.ts`, `src/lib/providers/google-oauth.ts` (E02-02/03) — the Google adapter is the reference implementation; the Microsoft adapter must not require interface changes (if it does, that is an ADR-002 finding to record, not a silent widening).
- `shop_connections` rows `(shop, 'microsoft_calendar')`, `(shop, 'microsoft_mail')`; `external_busy_blocks`; `provider_events` literal `microsoft`.
- Spec: `vendors/planned-evaluations/microsoft-graph.md` (getSchedule vs calendarView semantics, delta token lifetime, subscription max lifetime ~3 days for calendar/mail resources, throttling `Retry-After` — all marked **requires verification**).
- Settings tiles: E02-03's rewired Calendar/Email tiles gain a provider choice (Google / Microsoft) at NOT CONNECTED.

## Exact scope
1. **Vendor adoption record:** `vendors/planned-evaluations/microsoft-graph.md` → `vendors/core/microsoft.md` with the 17-point checklist; registry row. Every "requires verification" item resolved from Graph docs and recorded.
2. **OAuth:** `/api/microsoft/auth/start?surface=calendar|mail` + callback via the `common` endpoint (work/school + personal), PKCE, CSRF nonce, open-redirect guard; scopes: calendar surface `Calendars.ReadWrite` (+ `offline_access`, `User.Read`); mail surface `Mail.Read` + `Mail.Send` (`Mail.ReadWrite` only if justified). Tokens encrypted in `shop_connections`; refresh; `expired` on `invalid_grant`/consent revoked.
3. **Calendar adapter** (`src/lib/providers/microsoft-calendar.ts`): event CRUD on the default calendar (store `external_calendar_id`), mirror tag via open extension / `singleValueExtendedProperties` (`gradia_appointment_id`) so the sweep skips our mirrors; busy ingestion via `calendarView` **delta** (expands occurrences; store `@odata.deltaLink` in `sync_cursor`; full resync on `syncStateNotFound`/410); timezone header `Prefer: outlook.timezone` = shop timezone; all-day handling. Throttling: honor `Retry-After`, `degraded` on sustained 429.
4. **Change notifications:** Graph subscription per connection (`/me/events`, lifetime capped by Graph — renew from the sweep before expiry; `clientState` secret), receiver `/api/microsoft/webhook` (validation-token handshake; `clientState` check; notification = trigger sweep for that shop); polling fallback = sweep cadence. `provider_events` claim on `(microsoft, subscriptionId + changeType + resource + timestamp)`.
5. **Mail adapter** (`src/lib/providers/microsoft-mail.ts`): send via `/me/sendMail` or reply via `/me/messages/{id}/reply` for in-thread (store `conversationId` + `internetMessageId` in adapter-owned metadata); inbound via `/me/mailFolders/inbox/messages/delta` from the mail sweep (baseline polling) + optional subscription; intake through `ingestInboundEmail` with `internetMessageId` as the idempotency key (D-023); own-mailbox skip.
6. **Tiles:** provider picker on NOT CONNECTED (Google / Microsoft); CONNECTED shows account UPN; Reconnect on `expired`. One calendar provider per shop at a time (two would double-mirror — refuse with a written reason; multi-provider mirroring is out).
7. Runbook section (Microsoft: subscription renewal, throttling, admin-consent required tenants) in `runbooks/calendar-outage.md`; `.env.example` docs.

## Explicit non-goals
- No Aurinko changes/removal (E02-06). No Google changes beyond shared-interface fixes.
- No Teams/Bookings/Places/rooms; no shared mailboxes; no per-member calendars (E04-05).
- No email UX (E07). No SharePoint/OneDrive.

## Dependencies
- E02-03 committed (reference adapter, intake function, tiles). E02-02 (seams/tables). E01-01 (RLS).
- Decisions: D-014, D-043, D-050, D-029, D-023 — Approved.
- **Founder precondition:** Azure app registration + Preview env vars (see Status). Absent → tiles show NOT AVAILABLE honestly; acceptance waits.

## Expected modules affected
New: `src/lib/providers/microsoft-calendar.ts`, `microsoft-mail.ts`, `microsoft-oauth.ts`, `src/app/api/microsoft/auth/start|callback/route.ts`, `src/app/api/microsoft/webhook/route.ts`, `vendors/core/microsoft.md`. Modified: provider registries, tiles (provider picker), sweep (subscription renewal), `provider-events.ts` literal, `.env.example`, `runbooks/calendar-outage.md`, `vendors/registry.md`. Dependency: `@microsoft/microsoft-graph-client` **or** plain `fetch` against Graph REST (preferred — no new package; `@azure/msal-node` only if the OAuth flow cannot be done with the existing PKCE helper). Justify in the vendor page.

## Database impact
Rows only (`shop_connections`, `external_busy_blocks`, `provider_events`). One additive migration only if E02-03 introduced a `provider` CHECK that must widen (then the CHECK widening rides here).

## Migration impact
Zero or one additive value-widening migration. Confirm at slotting.

## API impact
New OAuth routes (session-gated) + one webhook receiver (validation handshake, `clientState`-verified, replay-claimed).

## UI impact
Provider picker on both tiles; written states; account UPN identity. Voice/agent copy unchanged.

## Permission impact
Owner/admin connect/disconnect (D-048). Callback binds to the session's shop only.

## Tenant-isolation impact
Same as E02-03: `forShop`/session client everywhere; webhook shop resolution by stored subscription id + `clientState`; tenant-isolation tests for connection rows, busy blocks, intake.

## Security impact
New credential class; `clientState` per subscription; PKCE; redirect allow-list. Admin-consent-required tenants (org policy) fail connect with a written explanation naming "your Microsoft 365 admin", not an error code. Publisher verification (Microsoft Partner Network) is a founder process; until done the consent screen shows "unverified" — tile copy must say so when `MICROSOFT_PUBLISHER_VERIFIED` is absent.

## Idempotency requirements
Delta pages upsert; notifications claimed via `provider_events`; mirror create looks up by extended property before creating; mail intake keyed by `internetMessageId`.

## Observability requirements
`[microsoft]` structured logs; health fields on the connection; SEV-2 alert on `expired`; subscription renewal failures SEV-3 (aggregate per sweep).

## Analytics requirements
Same events as E02-03 with provider dimension.

## Feature flag
`FEATURES.microsoftCalendar` (named in the E02 epic) — default **false** at merge (D-043 fast-follow); flipped to true by an Organizer docs/flag change after Google parity holds two weeks (E02 rollout plan step 5). Env-gated tile on top.

## Automated tests
- Unit (mocked): OAuth/PKCE; token refresh; event CRUD payloads incl. timezone header; delta paging + resync; occurrence expansion; own-mirror exclusion; sendMail/reply payloads; inbox delta intake; `Retry-After` handling.
- Provider-contract fixtures per Graph endpoint used.
- Idempotency, tenant-isolation, source-scan (no Graph import outside `src/lib/providers/microsoft-*.ts`), interface-conformance test (both adapters satisfy the same `CalendarProvider`/`EmailProvider` type — compile-time + a shared behavioral suite run against both adapters with mocks).
- Regression: E02-01/02/03 suites green unchanged.

## Manual acceptance procedure
1. **Founder:** Azure app registered; Preview env set; founder Microsoft account available. Record in `autorun-log.md`.
2. Builder (Preview): connect Outlook Calendar → book/reschedule/cancel mirror; create an Outlook event → blocks a slot after sweep; notification triggers a sweep within a minute.
3. Builder: connect Outlook mail → inbound test email staged once; reply arrives in-thread in Outlook.
4. Builder: revoke consent → `expired` + Reconnect; attempt to connect Google Calendar while Microsoft is connected → written refusal.
5. **Founder:** repeat 2–4 with the founder Microsoft account; record PASS/FAIL. Flag stays false in Production until the parity window passes.

## Failure cases
- Subscription lifetime expiry missed → polling fallback within one sweep; alert SEV-3.
- Throttled → backoff/degraded; executors unaffected.
- Admin consent required → honest written state; calendar stays native.
- Delta token invalid → full resync; busy blocks rebuilt, never deleted before rebuild completes.

## Rollback strategy
Flag off (default) → adapter dormant; rows stay; subscriptions lapse in ≤ 3 days or are deleted by disconnect. No schema unwind.

## Definition of done
`../12-definition-of-done.md` plus: `vendors/core/microsoft.md` checklist complete; shared adapter conformance suite committed; founder step 5 PASS; registry/runbook/capability docs updated in the same change; the E02 exit criterion is **not** held for this ticket (D-043) — recorded in the ticket close.
