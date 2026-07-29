# E08 — Reporting and Responsive PWA

_Created 2026-07-25 by the Organizer. Phase: **P8**. Status: planned._

## Objective

Give owners real reporting — funnel and campaign analytics, a daily brief, exportable reports — and make Gradia an installable, phone-first PWA (D-020) so the whole product works from a pocket.

## User outcome

Every morning the owner gets a brief: yesterday's money, today's jobs, what needs review. They can answer "where do my best leads come from?" and "did that win-back campaign pay?" from real funnels, export a month-end report for their accountant, and run all of it from an installed app icon on their phone.

## Business reason

The ROI story sells Gradia (home analytics header IS the receipt — HOME_REDESIGN_PLAN), but beyond Home the audit shows: funnel analytics PARTIAL, campaign analytics NOT_FOUND, daily brief NOT_FOUND, forecasting NOT_FOUND (doc 03). Detailers live on phones (DESIGN.md's one surviving truth); PWA-before-native is decided (D-020).

## Current foundation

- `home-analytics.ts` — the exemplary pattern: every figure traced to rows, refusal to fabricate deltas (audit doc 08 praises it); this discipline is the law for all reporting (BUILD_REFERENCE §3).
- ROI-receipt machinery (`cron/roi-receipt`, `shop_metrics` snapshots) — the daily brief is "a daily variant" (audit doc 12 item 21).
- `custom_agent_runs` + automation attribution rows (campaign attribution raw material); pipeline `stage_history` (funnel raw material); `payments` mirror (revenue).
- Responsive Tailwind UI already; Recharts/Tremor sourcing rule (BUILD_REFERENCE §6).

## Missing work

1. Funnel analytics: stage-conversion over time from `stage_history` (lead→quote→booked→completed), by source.
2. Campaign object + analytics: attribute replies/bookings/revenue to `custom_agent_runs` (audit doc 12 item 18); per-campaign panel on Receptionist.
3. Daily brief: daily computation + in-app card + optional SMS (reuse receipt sender + A2P gates); written zero-states.
4. Report exports: CSV/print for revenue, jobs, customers (accountant-shaped).
5. PWA: manifest, icons, service worker (app-shell + read-only cache of last-loaded dashboards), installability pass, push-notification groundwork (approvals badge) — scope: offline is *read-only, best-effort*; no offline writes.
6. Mobile interaction pass over core flows (approve, reply, book) per `ui/responsive-rules.md`.

### Report catalog (added 2026-07-27 — founder-required operational reports, tagged to source-domain availability)

Available with E03 data: **lead conversion**, **quote conversion**, **average ticket**, **no-show rate** (data exists today), **rebooking rate**, **lead-source performance**, **customer lifetime value** (row-traced, no modeling). With E05: **revenue**, **collected payments**, **outstanding balances**. With E04 (roadmap rule 8 — hard): **jobs completed**, **service profitability**, **job profitability**, **employee productivity**, **labor utilization**. With E06: **membership revenue & churn**, **fleet revenue**, **fleet account profitability**. Gradia-specific (E09 data): **revenue influenced/recovered by Gradia**, **AI actions approved/edited/rejected**, **calls answered**, **appointments booked**, **quotes recovered**, **hours saved** (only if honestly computable — receipt rule), **opportunity value acted on**, **voice/communication costs per shop**, **gross margin by account** (margin report exists — surface it). Every report obeys the row-traceability law; a report whose source domain hasn't shipped renders nothing rather than estimates.

## Domain entities

New: `campaigns` view/object over `custom_agent_runs` (ADR: table vs derived), report snapshot rows if needed. No core-domain changes.

## Backend services

Analytics accessors under `src/lib/data/` (the accessor convention holds), daily-brief cron, export endpoints (role-gated), service worker + push registration plumbing.

## UI surfaces

Reports section (funnels, campaigns, exports — likely under Home or a new nav decision via `ui/navigation-model.md`... nav change needs a decision-queue entry, not silent IA drift); daily brief card on Home; per-campaign panel; install prompts done tastefully (no nag).

## Integrations

Web Push (browser), existing Twilio path for SMS brief. No new vendors.

## Security implications

Exports are bulk data egress — owner/admin role only, logged. Service worker must never cache another member's/ shop's data (cache keys scoped, cleared on logout). Push payloads carry no PII (badge counts + deep link only).

## Tenant implications

Analytics queries are the first real aggregate load — add composite indexes flagged by audit doc 05 §weakness 10 as they become hot; consider `shop_metrics`-style snapshots over live aggregation for heavy views.

## Migration implications

Additive snapshots/indexes only.

## Product analytics

This epic *consumes* the event set; canonical events unchanged. Dashboards for the funnel in `14-product-analytics.md` become internally visible here.

## Dependencies

E03 (single stage truth — funnels are garbage while `status`/`stage` dual-truth lives), **E04 (hard for job-dependent reports — roadmap rule 8, added 2026-07-27: profitability/productivity/utilization reports do not ship before stable jobs; non-job reports may proceed)**, E07 helpful (reply attribution), E01 (roles for exports). Decisions: D-020 approved; reports nav placement (decision queue Q-16); brief SMS default on/off (decision queue).

## Risks

- Analytics that contradict the Home receipt destroy trust — one shared computation layer, never parallel math (extend `home-analytics.ts` patterns/modules, don't fork them).
- Service workers are a classic staleness footgun — conservative caching, versioned busting, kill-switch flag.
- Campaign attribution overclaiming violates the under-claim discipline — attribute only provable links (reply to the campaign thread, booking from its staged action), label the rest "unattributed".

## Non-goals

No native apps (D-020), no offline writes, no forecasting/projections beyond the existing booked/quotes-out split (fabricated foresight violates the receipt rule), no cross-shop benchmarking, no CLV modeling.

## Feature flags

`FEATURES.reports`, `FEATURES.dailyBrief`, `FEATURES.pwa` (service worker + install), `FEATURES.pushNotifications`.

## Testing requirements

Analytics unit tests proving row-traceability (fixture → exact figures, zero-state refusals); attribution tests (provable-link only); export golden files; PWA: Lighthouse installability green, service-worker staleness/kill-switch tests, logout-clears-cache test; push permission-denied path.

## Rollout plan

Funnels + exports first (data must be trusted before it's daily), daily brief second (in-app before SMS), PWA last (install prompt only after mobile pass ships). Brief SMS respects quiet hours + A2P like every send.

## Acceptance criteria

1. Funnel view shows stage conversion by source, every number traceable to `stage_history` rows on a seeded fixture.
2. A campaign shows sends/replies/bookings/revenue with only provable attribution; "unattributed" is a visible bucket.
3. Daily brief renders with real data and a written zero-state; optional SMS arrives via the policy-gated path.
4. Gradia installs from Chrome/Safari on a phone; core loop (approve → reply → book) works installed; offline shows last-loaded data read-only with an honest banner.
5. Month-end CSV export matches the on-screen report exactly.
