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

---

## Measurements (Builder record, 2026-09-02 — branch `auto/batch-1b`)

### Method

- **Environment.** Local production build (`next build` + `next start`, Turbopack) against the local Supabase stack (Postgres in Docker, loopback). The Vercel Preview was **not reachable** this session (`npx vercel whoami` → Not authorized; autorun precondition 6 unmet, and no push had happened yet). Absolute TTFB on loopback reads well below Vercel; the numbers that transfer are the structural ones — queries per request, critical-path span, HTML bytes, JS bytes, the interaction breakdown — and those drove the fixes. **Preview re-measurement is assigned to the next Builder session after the founder's push (rule 8).**
- **Seed.** `scripts/perf-seed.mjs` (local-only; refuses any non-loopback Supabase URL): one owner + shop with 600 customers, 700 leads, 150 quotes, 260 appointments, 60 pending + 40 approved actions, 3,000 interactions, 40 payments.
- **Sampler.** `scripts/perf-timing.mjs`, 20 samples per route, with the server running `PERF_TIMING=1` so every Supabase call through `lib/supabase/server.ts` logs `method · table · ms` per request id (never a query string). Baseline = unmodified `e3177bb` plus the inert timing hook, built in a detached worktree and served on `:3101`; after = this branch on `:3100`. Three interleaved rounds (base, after, base, after, base, after). The very first after-run of the evening was discarded: it coincided with autovacuum of the rolled-back inflation rows (visible in `pg_stat_user_tables`, 23:59 UTC) and read 2× slower than every later run.
- **Query plans.** `EXPLAIN (ANALYZE, BUFFERS)` inside one transaction that first inserted 40 other shops' rows and was then rolled back — leads 51,400 · appointments 30,520 · pending_actions 70,200 · interactions 206,002 · customers 21,200.
- **Interaction.** Chrome DevTools performance trace of one Approve tap ("Save the note" on an `add_note` card) on `/approvals`, at 4× CPU throttle and at 1×. Manual DevTools recording, as the ticket allows.
- **Lighthouse.** Lighthouse 12, mobile, simulated throttling, `/dashboard` with the owner cookie. Speed Insights is not enabled (founder toggle) and is not cited.

### Before → after — the five routes (p75 TTFB = median of the three rounds, range in brackets; q/req · DB ms · span from round 2)

| route | TTFB p75 ms before → after | queries/req | DB ms/req | critical-path span ms | HTML KB | JS gzip KB |
|---|---|---|---|---|---|---|
| /dashboard | 135 [126–187] → 130 [129–191] | 81 → **43** | 824 → 494 | 143 → **75** | 2,030 → **338** | 464 → 464 |
| /approvals | 126 [116–157] → 111 [110–226] | 26 → **13** | 217 → 89 | 49 → 36 | 469 → **195** | 436 → 436 |
| /customers | 173 [133–347] → 134 [120–195] | 26 → **15** | 232 → 98 | 47 → 41 | 2,285 → **877** | 447 → 451 |
| /conversations | 127 [105–224] → 146 [137–181] | 30 → **15** | 201 → 119 | 37 → 45 | 148 → 148 | 432 → 432 |
| /settings | 135 [114–208] → 108 [101–122] | 46 → **24** | 211 → 93 | 52 → 41 | 234 → 234 | 477 → 477 |

Reading: on loopback the p75 TTFB barely moves (the DB answers in 3–10 ms per call), and Conversations is inside the noise band. What moved is the count of round-trips and the critical path — Home makes 38 fewer Supabase calls per request and its longest dependent chain halves. On Vercel, where each Supabase call costs 15–60 ms instead of 5, that is the number that turns into TTFB. JS bytes were untouched by design (no boundary moves were evidenced; see causes).

Per-target breakdown of the Home request (avg per request, round 2): before `auth/user ×20.9` · `shops ×25` · `leads ×7` · `pending_actions ×6` · `appointments ×4`; after `auth/user ×0.9` · `shops ×6` · `leads ×8` · `pending_actions ×6` · `appointments ×4`.

### Approve interaction (one tap, `/approvals`, 56–59 pending cards)

| condition | before | after | breakdown after (input / processing / presentation) |
|---|---|---|---|
| 4× CPU throttle | 216 ms (10 / 105 / 101) | **190 ms** (59 / 89 / 42) — 179 ms before the queue was paged (16 / 75 / 88) | presentation cost is gone; the remaining 89 ms is the click handler's React commit + framer-motion exit/layout projection + toast |
| 1× CPU | 85 ms | **75 ms** | target (< 100 ms) met unthrottled; **not met at 4×** — see residuals |

### Lighthouse mobile — `/dashboard`

| metric | before | after |
|---|---|---|
| performance score | 0.45 | **0.77** |
| FCP | 1.7 s | 1.4 s |
| LCP | 6.8 s | 5.2 s |
| TBT | 1,680 ms | **180 ms** |
| Speed Index | 5.3 s | 2.9 s |
| CLS | 0 | 0 |

### Causes, ranked by measured impact, and what shipped

1. **User + shop re-resolved by every loader.** `auth.getUser()` ran 21× and the shop row was selected 25× per Home request (8–13× and 10–18× on the other routes) — each loader called `requireShop()`/`requireUser()` with no request memo. Fix: React `cache()` around `getCurrentUser`, `getOptionalShop`, `listShopsForCurrentUser` (`lib/shop.ts`) and `getChannelStatusForCurrentShop` (`lib/data/channels.ts`). `cache()` is scoped to one RSC render; a different request is a different cache, so there is no cross-tenant key to get wrong. Result: `auth/user ×0.9`, `shops ×6` on Home.
2. **Home lead feed rendered 500 scored leads** (2,030 KB of HTML, plus the heat-context fan-out over 500 customers on every visit). Fix: Home asks for 8 (`HOME_LEAD_FEED_CAP`) and shows "See all N in Customers" from an exact count. Result: 338 KB.
3. **Pipeline board rendered 500 cards** (2,285 KB). Fix: `capPipelineCards` keeps the newest 30 per stage; stage totals still count every card (D-025) and a column past its cap prints "N older — search in Customers". Result: 877 KB.
4. **`loadTodayMoney` ran five sequential stages** (independent reads, then an all-leads select, then three dependent follow-ups one after another). Fix: two `Promise.all` stages. Result: Home critical-path span 143 → 75 ms.
5. **Approve tap re-rendered and re-laid-out every card.** Fix: `ApprovalCard` is `React.memo` behind `useCallback` handlers that read the server list through a ref; `layout="position"` instead of full layout; the queue draws 12 cards a page with an exact "Show N more". Result: presentation delay 101 → 42 ms at 4×; total 216 → 190 ms (1×: 85 → 75 ms).

**Not a cause — no index migration.** All twelve hot filters already use an index at 50k–200k rows (existing `(shop_id, …)` composites from C1, the master-audit migration and P0-003): open approvals via `pending_actions_resolution_idx` + `pending_actions_status_idx` (0.37 ms), newest leads via `leads_next_action_idx` (0.43 ms), 7-day appointments via `appointments_shop_status_idx` (0.08 ms), today's bookings via `appointments_shop_scheduled_idx` (0.10 ms), voice interactions and job-status via `interactions_shop_customer_occurred_idx` (3.1 / 0.14 ms), threads via `interactions_shop_id_idx` (1.1 ms), customers via `customers_shop_lifecycle_idx` (0.35 ms). No sequential scan appeared in any plan, so under the ticket's "no index without a plan" rule none ships. The prior session's stashed migration (three composites justified by "Seq Scan → Index Scan") did not reproduce and was dropped; `eval/perf-001.test.ts` locks its absence. **DB-sensitive slot not occupied.**

**Not evidenced — client/server boundary moves.** JS is 432–477 KB gzip on every route and identical across them (shared shell: sidebar, command bar, framer-motion, Radix). No single client component was measurably heavy; moving one would not change the shared chunk. Left for a later bundle-analysis ticket rather than done blind.

### Targets

- **p75 TTFB < 600 ms on the five routes:** met locally with wide margin (max 146 ms). Not yet measured on Preview — **BUILT, not DONE** (rule 8).
- **Interaction-to-paint < 100 ms on Approve:** met at 1× CPU (75 ms); **not met at 4× throttle (190 ms)**. Residual cause: click processing (~90 ms at 4×) = React commit + framer-motion `AnimatePresence` exit/layout projection + sonner toast. Next lever is dropping sibling layout animation (siblings jump instead of slide) or a CSS-only exit — a motion decision under BUILD_REFERENCE §1, so filed as a follow-up for the Organizer rather than decided here.

### Reproduce

`docs/gradia-v2/09-testing-strategy.md` §7 — seed, `PERF_TIMING=1`, sampler, DevTools trace. Any later ticket that touches a dashboard loader re-runs the sampler and records the delta.
