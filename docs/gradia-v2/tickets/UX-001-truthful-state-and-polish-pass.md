# UX-001 — Truthful state + polish pass (connection truth, stale copy, inline help, required states)

_Cut 2026-09-01 by the Organizer for autorun Batch 1 (`../program/autorun.md` §UI direction, queue item 3c — added by the founder 2026-09-01). Specification only._

## Ticket ID
UX-001

## Epic
E00 — Stabilization (owner-facing truth; BUILD_REFERENCE + `ui/state-matrix.md` enforcement)

## Status
**draft — precondition-gated.** Autorun Batch 1, queue item 3c (after CLEANUP-001, before PERF-001). **Precondition (founder):** Stripe reference screenshots added to `docs/gradia-v2/ui/reference-board.md` with adopt/reject lists (the board's rule: "a reference without both lists is not approved") before this ticket starts. Risk class **standard** (no schema). Founder acceptance: **founder visual review on Preview** (autorun table). Decisions binding: D-025 (no dead controls / fake UI), D-028 (live/beta/planned truth), D-046/D-049 (no nav change), D-052 (Slack copy gone — CLEANUP-001 precedes). No open decision.

## Priority
P0 band — High for trust. Founder repro 2026-09-01: Gmail connected via Aurinko, yet the Email card still says "Connect Gmail". The app's contract is "truthful instrument panel" (BUILD_REFERENCE §0); a connected integration shown as disconnected is the exact failure mode D-025 forbids.

## Objective
(a) Make every ConnectionTile / channel card read **one** source of truth so a connected integration is never shown as "Connect" — find and fix the root cause of the founder repro with a test; (b) remove all stale copy (Slack approval text, "Coming soon" on configured integrations, legacy price strings not owned by P0-013); (c) add Stripe-pattern inline help (one "what this does" line + optional tooltip) on every Settings card, every Approvals card type, and the Receptionist builder, in narrator voice; (d) close the `ui/state-matrix.md` required-states gaps on every dashboard route. Not a redesign.

## User outcome
An owner sees the same truth on Home, Settings and the channel cards: connected means connected. Every card says in one line what it does. No route ever shows a blank, a spinner-for-page, or a dead control.

## Current code references
- **Two truth sources for "email connected":** `src/lib/data/channels.ts:99-101` (`emailSummary`: `aurinko_access_token_enc && aurinko_account_id`), `:131-133` (`calendarSummary`: same); settings tiles `src/app/(dashboard)/settings/page.tsx:278-289` (Email: `connected={Boolean(shop?.aurinko_account_email)}`), `:308-321` (Calendar: same field, label "Google Calendar"); `src/components/gradia/email-settings-card.tsx:41-49` (`initialAccountEmail` prop → `isConnected`), `:136-138` (Connect Gmail button), `:150` (copy). Three different predicates (`token+account_id` vs `account_email` vs prop) — a shop with a token but no `aurinko_account_email` (or a stale/second shop row via the cookie-pinned switcher, `src/lib/shop.ts:35-63`) renders inconsistently. **Root-cause trace is scope item 1** — do not guess.
- "Coming soon" renderer: `src/components/gradia/connection-tile.tsx:50-52` (badge), `:65-69` ("We'll let you know the moment it's ready") — shown whenever `available=false`, i.e. server env absent (`settings/page.tsx:129-149`). `email-settings-card.tsx:141-152` ("Gmail coming soon" / "We're finishing email setup on our side"). PROD-CONFIG-AUDIT lists which vars are absent in Production.
- Stale Slack copy (owner-visible): `email-settings-card.tsx:91` ("becomes a Slack approval card"); `src/app/how-it-works/page.tsx:53,122,141,174`; `add-lead-dialog.tsx:59`; `ai-lead-section.tsx:81` — CLEANUP-001 removes these; UX-001 verifies none remain and covers any residue.
- Legacy price strings (P0-013 owns): `src/app/billing/page.tsx`, `billing-subscribe.tsx`, `usage-meters.tsx`, `onboarding-launch-steps.tsx`, `voice-builder.ts`, `how-it-works/page.tsx` ("$20/month. No catch.") — **UX-001 does not touch these** except to confirm the list is complete in the P0-013 ticket.
- Required states: `ui/state-matrix.md` (matrix + invariants); `loading.tsx` present for activity, approvals, calendar, calls/[callId], conversations, customers, dashboard, receptionist, settings; **missing** for `agent`, `agents`, `agents/build`, `approvals/[id]`, `chat`, `customers/[id]`, `customers/quotes/new`, `customers/recovery`, `leads`, `receptionist/build`, `recovery`, `schedule` (some are redirects — `schedule`, `recovery`, `leads`, `chat`, `agents*` may be redirect stubs; verify each); `error.tsx` at `(dashboard)/` level from P0-010; `strings.ts` owns chrome copy; `ui/copy-guidelines.md` narrator voice; `ui/component-inventory.md`.
- Approvals card types: the `pending_actions` 11-type enum (`03-domain-model.md` §11); card components under `src/components/gradia/*approval*`; Receptionist builder `src/app/(dashboard)/receptionist/build/page.tsx` + `voice-builder.ts`.
- Reference board: `docs/gradia-v2/ui/reference-board.md` (founder adds the Stripe references + adopt/reject lists).

## Exact scope
1. **Root-cause the connection-truth bug:** reproduce with a shop connected via Aurinko; trace `shop.ts` resolution (cookie-pinned shop vs listed shops), the three predicates above, and any stale `aurinko_account_email`; fix **at the root** — one exported helper (e.g. `connectionStatus(shop)` in `src/lib/data/connections.ts`) returning `{ email, calendar, sms, voice, crm }` states from a single predicate set, consumed by `channels.ts`, the settings tiles, `email-settings-card.tsx`, onboarding launch steps and the agent/BI readers that print connection state; regression test with the founder's exact repro shape (token present, `account_email` null / second shop row). E02-02 later moves the predicate to `shop_connections` — the helper is the seam it will replace.
2. **Stale copy sweep:** grep-driven list (Slack, "Coming soon", "Aurinko" in owner-visible strings, "via Aurinko" hints in `channels.ts:106,133,138`) → fix: "Coming soon" becomes an honest **NOT AVAILABLE** state that names what is missing in owner terms ("Email isn't set up for this workspace yet — we're finishing the connection on our side") only when the env is truly absent; when configured, the tile is CONNECT-able. Vendor names out of owner copy per the UX rename map (BUILD_REFERENCE §4) — "Google Calendar"/"Gmail" are product names owners know and stay. All strings in `strings.ts`.
3. **Inline help (Stripe pattern):** for each Settings card, each Approvals card type, and each Receptionist builder step: one narrator line "what this does / what happens when you click" + an optional tooltip for the detail, using existing primitives only (no new components; `component-inventory.md` rule); copy per `copy-guidelines.md` (numbers over adjectives, no exclamation, no emoji). Adopt/reject from the reference board honored.
4. **Required states per route:** for every `(dashboard)` route that is a real page (not a redirect stub): `loading.tsx` skeleton, written empty (first-use / no-results + Clear filters / all-done where applicable), error boundary coverage, success states for async actions, permission-denied honest gate, integration-unavailable state naming the Connect path — per `state-matrix.md`. Redirect stubs get nothing (document which are stubs).
5. **Home/Settings parity test:** one test renders `channels.ts` summaries and the settings tiles from the same seeded shop and asserts equal connection states.
6. Docs: `ui/state-matrix.md` (gaps closed, dated), `ui/component-inventory.md` (helper), `program/capability-status.md`, PROD-CONFIG-AUDIT's "owner-visible copy" column updated.

## Explicit non-goals
- No redesign: no new tokens, no new typeface, no new nav destination, no cinematic motion on dashboard surfaces (BUILD_REFERENCE §1).
- No price-string changes (P0-013). No Slack/HCP code removal (CLEANUP-001). No new components.
- No performance work (PERF-001). No schema.
- No copy changes to agent-authored CHARACTER text (persona-locked).

## Dependencies
- CLEANUP-001 merged-or-committed on the batch branch (stale Slack copy gone first). PROD-CONFIG-AUDIT (which vars are absent → which tiles are legitimately NOT AVAILABLE).
- **Founder precondition:** reference-board entry with Stripe screenshots + adopt/reject lists.
- Decisions: D-025, D-028, D-046, D-049, D-052 — Approved.

## Expected modules affected
New: `src/lib/data/connections.ts` (single truth), missing `loading.tsx` files, `eval/connection-truth.test.ts`. Modified: `src/lib/data/channels.ts`, `settings/page.tsx`, `email-settings-card.tsx`, `connection-tile.tsx` (NOT AVAILABLE state), onboarding launch steps/wizard readers, approval card components (help line), receptionist builder steps, `strings.ts`, `ui/state-matrix.md`, `ui/component-inventory.md`, capability-status.

## Database impact
None.

## Migration impact
None (explicit).

## API impact
None.

## UI impact
Every Settings card, approval card, builder step gains a help line; tiles show truthful states; routes gain skeletons/empty/error states. Mobile + accessibility per DoD F (tooltips keyboard-reachable; `prefers-reduced-motion`).

## Permission impact
None new (role gating arrives with E01-03).

## Tenant-isolation impact
The connection helper reads the resolved shop only; regression test covers the second-shop-row/cookie case so one shop's connection never shows for another.

## Security impact
None new; owner copy must not expose env var names or vendor internals.

## Idempotency requirements
None.

## Observability requirements
None new.

## Analytics requirements
None.

## Feature flag
None — fixes + copy (D-027: nothing incomplete is exposed).

## Automated tests
- Connection-truth unit tests (predicate matrix incl. founder repro shape); Home/Settings parity test.
- Snapshot/source-scan: no "Coming soon" string outside the env-absent path; no "Slack"/"Aurinko" in owner-visible strings (allowlist: none).
- Component tests: help line present per card type; states per route (loading/empty/error) for the listed real pages.
- Accessibility: tooltip focus/escape; reduced-motion respected.

## Manual acceptance procedure
1. Builder: seed the founder repro (Aurinko-connected shop with the mismatching field) → Email card + Home channel card + Settings tile all read Connected; disconnect → all read Connect.
2. Builder: with env absent locally → tiles read NOT AVAILABLE with the honest line; with env present and not connected → Connect.
3. Builder: walk every real dashboard route with an empty shop → written empty states; throw in a loader → error boundary; slow network → skeletons.
4. **Founder (visual review on Preview):** compare against the reference-board adopt list; confirm the connection truth on the founder's shop; PASS/FAIL in `autorun-log.md`.

## Failure cases
- Root cause is a data problem (a second shop row) → fix resolution/switcher truthfully (show which shop is active), never paper over with a broader predicate.
- A route's "empty" needs data the page cannot know → write the honest first-use state, not a fabricated metric (D-025).

## Rollback strategy
Revert the commit; no data.

## Definition of done
`../12-definition-of-done.md` (F in full) plus: root-cause statement in the close record with the regression test name; the stale-copy grep list with dispositions; state-matrix gaps table closed; founder visual review PASS recorded.

---

## Builder record — 2026-09-02 (autorun Batch 1, branch `auto/batch-1`)

**Status line is the Organizer's to flip; this is the implementation record. Founder visual review on Preview (manual acceptance step 4) is still open and holds the ticket out of done.**

### Root-cause statement (scope item 1)

Four surfaces keyed "email connected" off `shops.aurinko_account_email`, a **display** attribute: the Settings Email and Calendar tiles (`settings/page.tsx`), the Email card (`email-settings-card.tsx`), the onboarding InboxStep (`onboarding-wizard.tsx` → `onboarding-launch-steps.tsx`) and the wizard resume predicate (`lib/onboarding.ts`). The Aurinko account fetch returns `email` as **optional** (`lib/aurinko.ts` `getAccount`: `email: obj.email ?? null`) and the OAuth callback stores it verbatim, so a fully successful connection can persist the credential pair (`aurinko_access_token_enc` + `aurinko_account_id` + `aurinko_subscription_id`) with `aurinko_account_email = null`. Home (`channels.ts`), Ask Gradia (`bi-tools.ts`) and the Receptionist prerequisites (`data/agents.ts`) keyed off the credential pair; the agent runtime and Gradia Agent keyed off the token alone. That is exactly the split the founder saw: Home "Live", Settings "Connect Gmail" — and onboarding resuming at step 3 forever. **Shop resolution was ruled out as the cause:** every surface resolves the shop through `requireShop()` (cookie-pinned shop if owned, else oldest owned), so a second shop row renders consistently *disconnected* on every surface and cannot produce a split; the Builder had no access to the founder's production row, so the founder's Preview check on their own shop is the confirming step. Fix at the root: `src/lib/data/connections.ts` — `connectionStatus(shop)` returns `{ email, calendar, sms, voice, crm }` as `{ connected, identity }` from **one** predicate set (credentials decide; identity is display-only and may be null), and `integrationAvailability()` is the one env-presence source. Regression tests: `eval/connection-truth.test.ts` ("founder repro: credentials on file + null display email → connected, identity null"; "inverse: a stale display email with no credentials is NOT connected"; the Home/Settings parity block; "founder repro renders Connected on the Settings tile AND Live on Home") and `eval/onboarding.test.ts` ("UX-001 founder repro: … inbox counts as done").

### Stale-copy grep list with dispositions (scope item 2)

| Hit | Disposition |
|---|---|
| `connection-tile.tsx` "Coming soon" badge + "We'll let you know the moment it's ready." | Replaced by the NOT AVAILABLE state: `STRINGS.connections.notAvailable` + per-integration `notAvailableReason`, no Connect control |
| `email-settings-card.tsx` "Gmail coming soon" / "We're finishing email setup on our side — check back soon." | → `notAvailable` + `notAvailableReason.email`; card now takes `initialConnected` (truth) + `initialAccountEmail` (identity) + `available` |
| `sms-settings-card.tsx` "Numbers coming soon" / "finishing texting setup" | → `notAvailable` + `notAvailableReason.sms` |
| `voice-builder-card.tsx` "We're finishing voice setup on our side — check back soon." | → `notAvailableReason.voice` (Settings + onboarding step 5) |
| `jobber-settings-card.tsx` "Jobber not configured" + `<code>JOBBER_CLIENT_ID</code> / <code>JOBBER_CLIENT_SECRET</code>` | → `notAvailable` + `notAvailableReason.crm`; env-var names removed from owner copy |
| `stripe-settings-card.tsx` "Stripe not configured" + three env-var names | → `notAvailable` + `notAvailableReason.payments` (surface is flag-hidden; fixed for hygiene, scan-locked) |
| `channels.ts` "Vapi-powered phone agent", "piped through Aurinko", "through Twilio", "via Aurinko" hints | Rewritten in product language (Home is owner-visible) |
| `data/agents.ts` prerequisite labels "Vapi assistant connected…", "Gmail connected via Aurinko", "Twilio number…" ×2, "Google Calendar (via Aurinko)"; capability "Confirms deliveries via Twilio callbacks" | Rewritten (Receptionist page) |
| `bi-tools.ts` setup-status reasons "Vapi voice receptionist…", "Gmail (via Aurinko)…", "Twilio number is wired up…" | Rewritten; predicates now from `connectionStatus()` |
| `interaction-timeline.tsx` "Twilio error {code}" | → "Carrier error {code}" |
| Slack (owner-visible) | 0 hits remain — CLEANUP-001 verified; broad scan locked |
| **Not touched, recorded:** `approvals.ts` executor error strings ("Connect Gmail via Aurinko (in /settings)…" ×2, `Aurinko: ${err.message}`) | Executor module — HARD-STOP class for edits outside a ticket's stated scope; copy-only residual for the Organizer (owner sees these as approval failure toasts) |
| **Not touched:** `mcp/server.ts` tool descriptions, `agent-planner.ts` prereq menu | Model-facing text — prompt-adjacent, eval-gated (D-009/#6), not owner-visible |
| **Not touched:** `api/aurinko|jobber/auth/start` "X is not configured on this server yet." | HTTP 500 body on a hidden route (the Connect control is not rendered when unavailable) |

### Inline help (scope item 3)

`HelpTip` (`components/gradia/help-tip.tsx`) is a composition of the existing Tooltip primitive — real `<button aria-label="About …">`, keyboard-reachable, Escape closes, ≤ 2 sentences from `STRINGS.help` (recorded in `ui/component-inventory.md`). Placed on: every Settings ConnectionTile (5) and card title (Service menu, Working hours, Automations, Voice receptionist, Email, SMS, Jobber, Shop knowledge, Review link, Plan & usage, Internal MCP tokens, Clear demo data, How should we act?, Shadow Mode); every approval card type (8 — `STRINGS.help.approvals[action_type]`, rendered beside the card eyebrow); every voice-builder field (greeting, voice, tone, hours, after-hours, bookings, booking link, transfer number, minute budget) plus the "Going live" checklist. Reference-board ADOPT honored: ⓘ on every card title (§3), NOT-copy respected (patterns only). Not done in this ticket (recorded): the per-route dismissable tip bar (§2), KPI-tile ⓘ on Home (§3 second half), filter-chip rows on Customers/Conversations (§5), metric freshness footers (§8) — each is a small follow-up; the ticket's scope named Settings cards, approval types and the builder.

**Discrepancy recorded:** the ticket cites an "11-type" `pending_actions` enum (`03-domain-model.md` §11); `PendingActionType` in code has **8** members. Help copy covers all 8 and the scan test derives the set from the type, so a 9th type fails the test until it has a help line.

### Required states (scope item 4) — see `ui/state-matrix.md` "UX-001 required-states pass"

`loading.tsx` added for `approvals/[id]`, `customers/[id]`, `customers/quotes/new`, `customers/recovery`, `receptionist/build` (flag-gated). Redirect stubs documented and test-locked: `agent`, `agents`, `agents/build`, `chat`, `leads`, `recovery`, `schedule`. Error coverage: `(dashboard)/error.tsx` + `not-found.tsx` (P0-010). Empty states: written on every real route (table in the state matrix); several remain inline rather than in `strings.ts` (LOW residual).

### Parity test (scope item 5)

`eval/connection-truth.test.ts` → "Home / Settings parity": for six seeded rows (empty, founder repro, fully wired, stale-email-only, sms-only, voice-only) `summarizeChannels(row)` statuses equal `connectionStatus(row)` for email/calendar/sms/voice, and the founder-repro row renders `data-connection-state="connected"` on the tile while Home reports `connected`.

### Files

New: `src/lib/data/connections.ts` · `src/components/gradia/help-tip.tsx` · 5 × `loading.tsx` · `eval/connection-truth.test.ts` · `eval/ux-001-truthful-state.test.ts`. Modified (src): `lib/data/channels.ts` (pure `summarizeChannels`) · `lib/onboarding.ts` · `lib/bi-tools.ts` · `lib/data/agents.ts` · `lib/owner-agent.ts` (channel checks only) · `lib/strings.ts` (`connections`, `help`) · `app/(dashboard)/settings/page.tsx` · `app/(dashboard)/customers/[id]/page.tsx` · `app/(dashboard)/approvals/[id]/page.tsx` · `app/onboarding/page.tsx` · components: `connection-tile`, `email-settings-card`, `sms-settings-card`, `jobber-settings-card`, `stripe-settings-card`, `voice-builder-card`, `onboarding-launch-steps`, `onboarding-wizard`, `approvals-list`, `interaction-timeline`, `service-menu-card`, `working-hours-card`, `automations-card`, `knowledge-settings-card`, `review-link-card`, `mcp-tokens-card`, `clear-demo-data-card`, `autonomy-default-card`, `simulation-mode-card`. Tests amended: `eval/onboarding.test.ts` (fixture carries the credential pair; +2 cases). Docs: `ui/state-matrix.md`, `ui/component-inventory.md`, `program/capability-status.md`, `runbooks/production-config-audit.md`, `tickets/P0-013-…md` (price-list check), this file. No schema, no migration, no price strings, no persona text.

### Manual acceptance (DoD G)

1. **Executed (Builder, locally via tests):** founder repro row (credentials present, display email null) → Settings tile `connected`, Home channel `connected`, Email card "Connected as Gmail" (identity fallback), onboarding resumes past step 3; disconnect shape (all null) → every surface `off`/Connect. Test names above.
2. **Executed (Builder):** `integrationAvailability()` with env absent → tiles render NOT AVAILABLE with the honest line and no Connect (tile render test); env present + not connected → Connect.
3. **Executed (Builder, source-level):** every real route has a skeleton (test-locked); empty states walked per the state-matrix table; error boundary present. **Not executed:** a browser walk with a seeded empty shop under a throttled network — assigned to the **founder** as part of step 4 (Preview), where the Preview deploy is the first real render.
4. **Assigned — founder (visual review on Preview):** compare each dashboard route against the reference-board acceptance list; confirm the connection truth on the founder's own shop (Email tile + Home card + Email card all read Connected); record PASS/FAIL in `program/autorun-log.md`.

### Residuals

MEDIUM — `approvals.ts` executor toasts still say "Connect Gmail via Aurinko (in /settings)" (copy-only; Organizer to schedule with E02-03/E02-06 or a tiny copy ticket). LOW — reference-board ADOPT items §2 (tip bar), §5 (filter chips), §8 (freshness footers) and Home KPI ⓘ not in this ticket. LOW — empty-state copy on Customers/Calendar/Quotes/Pipeline is written but inline, not in `strings.ts`. LOW — Activity has no distinct "no results + Clear filters" state (chips reuse first-use copy). LOW — `agent-runtime.ts` gating still keys email off the token alone (execution path; fails honestly at token refresh) — align with `connectionStatus()` when the runtime is next touched. LOW — a2p-wizard has no ⓘ (four state-specific headers; `STRINGS.help.settings.carrier` is authored and ready).
