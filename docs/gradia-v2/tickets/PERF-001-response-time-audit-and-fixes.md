# PERF-001 — Response-time audit and fixes (measure first, fix the top causes, re-measure)

_Cut 2026-09-01 by the Organizer for autorun Batch 1 (`../program/autorun.md` §UI direction, queue item 3d — added by the founder 2026-09-01). Specification only._

## Ticket ID
PERF-001

## Epic
E00 — Stabilization (performance baseline; BUILD_REFERENCE "fast" bar)

## Status
**draft — batch-gated.** Autorun Batch 1, queue item 3d (after UX-001, before P0-013). Risk class **standard** (DB indexes = additive migration → occupies the DB-sensitive slot while in progress). Founder acceptance **no**. Decisions binding: D-025 (real numbers), D-007/D-008 (monolith; no infra), autorun rule 5 (no caching layer / new infra without a HARD STOP). **Precondition (founder, platform-level, once):** enable Vercel Speed Insights on the project if the Builder is to use it (`@vercel/speed-insights` is **not** in `package.json` today); otherwise the Builder measures with server timings + local Lighthouse and says so.

## Priority
P0 band — Medium-high. "Fast" is part of the Stripe-grade bar the founder set; no route has a recorded p75; Home aggregates several analytics loaders per request and only two migrations add `shop_id`+time composite indexes.

## Objective
Measure first (p75 TTFB + interaction-to-paint on Home, Approvals, Customers, Conversations, Settings), write the numbers into this ticket, fix only the top causes (N+1 in server components, unindexed `shop_id`+time filters, over-fetching on Home analytics, missing skeletons, client bundles that should be server components), then re-measure and record before/after. Targets: **p75 TTFB < 600 ms** on the five routes; **interaction-to-paint < 100 ms** on Approve.

## User outcome
Home, Approvals, Customers, Conversations and Settings open fast on a shop phone; Approve feels instant. Founder-as-operator: a recorded baseline to hold future tickets to.

## Current code references
- Routes: `src/app/(dashboard)/dashboard/page.tsx` (Home), `approvals/page.tsx`, `customers/page.tsx` (3-tab hub `:20-24`), `conversations/page.tsx`, `settings/page.tsx` (single large server page with six env checks + shop loads).
- Home data: `src/lib/data/kpis.ts`, `src/lib/data/roi-receipt.ts`, `src/lib/data/today-money.ts` (`:89,146,202` lead selects), `shop_metrics` snapshots (`03-domain-model.md` §16 — "one shared computation layer extending the `home-analytics` pattern"); ROI receipt cron `cron/roi-receipt`.
- Approve interaction: `src/app/actions/approvals.ts` → `src/lib/approvals.ts` executor (`revalidatePath` targets fixed in P0-010); `ApprovalCard` client component.
- Indexes: `20260806120000_appointments_shop_scheduled_idx.sql` (P0-003) and one other `shop_id` composite — everything else on tenant tables is `shop_id` alone or none (audit doc 05 "missing composite indexes"; E02 epic flags availability hot paths).
- Skeletons: `loading.tsx` present for the five routes (`dashboard`, `approvals`, `customers`, `conversations`, `settings`) — verify they are real skeletons, not spinners (BUILD_REFERENCE §1).
- Client/server boundaries: `src/components/gradia/*.tsx` with `"use client"`; sidebar `app-sidebar.tsx`; calendar week (626 lines client).
- Observability: Sentry `tracesSampleRate: 0` (P0-012 non-goal: stays); `/api/health` (P0-012).
- Instrumentation available: Next.js `Server-Timing` via `headers()`/`after()`, `next build` route size output, Lighthouse CLI; `@vercel/speed-insights` absent.

## Exact scope
1. **Baseline (write into this ticket file under "Measurements", dated):** for each of the five routes on Preview with a seeded realistic shop (≥ 500 customers, ≥ 200 appointments, ≥ 50 pending actions): p75 TTFB over ≥ 20 samples, server timing breakdown per loader (add `Server-Timing` headers behind `NODE_ENV !== 'production'` **or** a `?__timing=1` guard for owners — Builder chooses, no PII), route JS bundle size from `next build`, Lighthouse mobile score; Approve interaction-to-paint via a Playwright timing script (or manual devtools recording — recorded as such). If Speed Insights is enabled by the founder, cite its p75 too.
2. **Diagnose + rank causes** — top 5 by impact; each with evidence (query plan for DB, waterfall for N+1, bundle analysis for client weight).
3. **Fix only the top causes, one commit's worth:** typical items — (a) N+1 in server components → batched selects / single RPC where an existing one fits; (b) additive composite indexes for `shop_id`+time filters that the plans show (e.g. `pending_actions(shop_id, status, created_at)`, `interactions(shop_id, occurred_at)`, `customers(shop_id, updated_at)` — **only** those measured); (c) Home over-fetch → read `shop_metrics` snapshot where the cron already computes it, compute live only what must be live (no fabricated numbers — D-025); (d) skeletons that are real (`loading.tsx` per route already exist — replace spinner-shaped ones); (e) move client-only-for-no-reason components to server components (measure bundle delta); (f) Approve: optimistic UI is allowed only if the server result reconciles visibly (never "approved" then silently failed — the existing pattern in calendar drag `calendar-week.tsx:114-128` is the model).
4. **Re-measure** identically; record before/after table; targets met or the residual named with the cause and a follow-up.
5. **Guardrail:** any fix that needs a cache layer (Redis, Vercel Runtime Cache, ISR on tenant pages), a queue, or new infra → **HARD STOP** and report (autorun rule 5). `revalidatePath`/`unstable_cache` on per-shop data is likewise out (tenant cache-key risk) unless keyed by shop id and proven in a test — prefer not.
6. Docs: `program/capability-status.md` perf baseline line; `09-testing-strategy.md` gains the timing script as a manual tool; the Measurements section lives in this ticket file (numbers, not prose).

## Explicit non-goals
- No caching layer, no CDN/ISR changes, no edge runtime, no new infra or vendor (Speed Insights enablement is a founder toggle, not a vendor adoption).
- No tracing sample-rate change (P0-012 non-goal).
- No redesign or component rewrites beyond boundary moves; no changes to executor semantics (`approvals.ts`) — Approve speedups stay in the action/UI layer.
- No index on anything not shown in a plan.

## Dependencies
- UX-001 committed (skeleton/state work not duplicated). PROD-CONFIG-AUDIT (Preview env known).
- Decisions: none open. Founder toggle for Speed Insights optional.

## Expected modules affected
Modified: the five route pages + their loaders (`src/lib/data/*.ts`), `src/app/actions/approvals.ts` (client-side reconciliation only), a few `"use client"` components, `loading.tsx` files, one additive migration (indexes), `scripts/perf-timing.mjs` (new), this ticket file (Measurements), capability-status, `09` doc.

## Database impact
Additive composite indexes only, `CREATE INDEX CONCURRENTLY IF NOT EXISTS` where the migration runner allows (else plain `IF NOT EXISTS` with the size noted).

## Migration impact
One additive, idempotent migration (indexes). Occupies the DB-sensitive slot while in progress; rollback = drop indexes (file in `supabase/rollbacks/`).

## API impact
None (timing header is dev/opt-in only).

## UI impact
Faster routes; real skeletons; Approve reconciliation state. No visual redesign.

## Permission impact
None.

## Tenant-isolation impact
Batched selects keep `.eq("shop_id")`/`forShop`; no cross-shop cache keys (none introduced). Any snapshot read is shop-scoped.

## Security impact
Timing header must not leak query text or shop data; opt-in only.

## Idempotency requirements
None.

## Observability requirements
Server-timing breakdown (opt-in) documented; `/api/health` unchanged.

## Analytics requirements
None.

## Feature flag
None (fixes). The opt-in timing header is env/query-gated, not a product flag.

## Automated tests
- Query-count tests for the five loaders (assert ≤ N queries per request with the seeded shop) — locks the N+1 fixes.
- Migration re-run twice; index presence test.
- Component tests unchanged; tenant-isolation suite green.
- Playwright timing script committed (manual tool; not a CI gate).

## Manual acceptance procedure
1. Builder: run the timing script before/after on Preview with the seeded shop; paste the table into this ticket file and the log.
2. Builder: Approve a card on a throttled connection → paint < 100 ms with visible reconciliation.
3. Reviewer (Cursor): verify no cache layer / infra was introduced; indexes match plans cited.

## Failure cases
- Target unreachable without caching → record the residual + cause; do **not** add caching; propose a follow-up in `backlog.md` for the Organizer.
- Index creation locks a large table → note size and prefer CONCURRENTLY; if the runner cannot, schedule the migration note for the founder's deploy window.

## Rollback strategy
Revert the commit; drop the indexes via the rollback file (non-destructive to data).

## Definition of done
`../12-definition-of-done.md` plus: Measurements section with before/after tables and method; query-count tests committed; migration + rollback file; targets met or residuals named with follow-ups filed in `program/backlog.md`.
