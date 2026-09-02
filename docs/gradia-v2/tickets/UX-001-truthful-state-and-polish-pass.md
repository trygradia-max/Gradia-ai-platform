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
