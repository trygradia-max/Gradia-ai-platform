# Gradia Master Audit & Production Plan — 2026-07-13

_Produced by the master-prompt run (branch `redesign/master-prompt`, cut from `origin/main` @ `df23c9b`). Consolidates the 15 requested deliverables into one grounded document. Every claim below is backed by file:line evidence from a four-way codebase audit run against this snapshot. Locked principles in root `CLAUDE.md` were held throughout._

**Verdict up front:** Gradia is not a prototype. RLS is universal and correct, HITL is enforced in code (not prompts), every API route is authenticated, empty-state discipline is genuinely best-in-class, and mobile is a first-class citizen. The gaps are (a) two correctness bugs, (b) design-token drift — the system exists, enforcement lapsed, (c) missing error surfaces, (d) unmetered inbound LLM cost, and (e) pilot-scale query assumptions. None require a redesign. All are fixable without touching locked architecture.

---

## 1. UX Audit

**Strong:** shared `EmptyState` primitive used across every list surface; skeleton (not spinner) loaders where they exist; optimistic updates with rollback + toast in approvals; resumable onboarding with pure step logic; safe-area-aware mobile composer; real mobile variants for calendar and pipeline (no touch dead-ends).

**Gaps (severity · evidence):**

| # | Finding | Evidence | Sev |
|---|---|---|---|
| 1 | No `error.tsx` / `global-error.tsx` anywhere — server fetch failures render Next's raw crash page | `approvals/[id]/page.tsx:77-79` throws directly | P1 |
| 2 | No `not-found.tsx` — expired public quote token shows a shop's **customer** a generic Next 404 | `q/[token]/page.tsx:28` | P1 |
| 3 | `/billing` lives outside the `(dashboard)` shell; non-subscribed users have no in-app way back | `billing/page.tsx:45-51` (back link only in `active` branch) | P1 |
| 4 | No loading state on the heaviest pages — Settings (~15 awaits) and Customers (async tabs, no Suspense) go blank | `settings/page.tsx:113-208`, `customers/page.tsx:94-121` | P2 |
| 5 | Calendar topbar shows "Gradia" — `TITLES` still maps retired `/schedule`, omits `/calendar` | `page-title.tsx:7-19` | P2 |
| 6 | Onboarding: step-5 upsell detours to out-of-shell `/billing` with no clean return; steps 4/5 render null if `liveShop` is falsy; services step proceeds with zero services | `onboarding-launch-steps.tsx:257`, `onboarding-wizard.tsx:151,159,471-496` | P2 |

## 2. Product Strategy

The strategy is already decided and documented (`GRADIA_MVP_PLAN.md`, `_docs/GRADIA_PRICING.md`, `_docs/WHAT_GRADIA_DOES.md`): AI office for independent detailers, Core $20 (on-request, approve-first) + Voice/Chat Autopilot +$29, one brain, HITL on money/calendar. This audit **affirms** that strategy — the differentiators the code actually delivers (glass-box activity feed, unified cross-channel interaction memory with vector recall, approve-first staging) are real and rare at this price point. Strategy work is not the gap; enforcement and polish are. No repositioning recommended.

## 3. Information Architecture

Current IA: 7 workspace destinations (Home, Approvals, Activity, Conversations, Customers, Calendar, Receptionist) + 2 pinned (Billing, Settings), flat, one level deep, legacy routes preserved as redirects. **Verdict: keep it.** This matches the Linear principle (few top-level destinations, details one hop away) and the spec's "agent is a verb, not a place." Only two IA changes are warranted:
- Bring `/billing` inside the shell (or give it a persistent back path + shell chrome). It is the only nav item that ejects the user.
- Fix the `TITLES` map so every destination names itself.

## 4. Navigation Plan

- **Keep:** sidebar + ⌘K-as-agent. The agent-first ⌘K is a deliberate product bet; do not repurpose it into a plain navigator.
- **Add (post-alpha):** a navigator mode inside the existing command bar — typing matches pages and customers (server search endpoint already exists at `customers?q=`); agent remains the default submit. One surface, two intents, zero new chrome. Estimated: 1–2 days using `cmdk`.
- **Skip:** breadcrumbs. The IA is one level deep; "Back to …" links are correct here.
- **Fix now:** billing shell break, calendar title.

## 5. User Flows (as-built, key paths)

- **Inbound lead → money:** call/SMS/email → `interactions` row + classify → auto-draft staged to `pending_actions` → owner approves (`/approvals`, 2 clicks, or Home feed inline) → send metered at the boundary (`approvals.ts:1110-1292`) → lead on pipeline → quote (`/customers/quotes/new`, public accept at `/q/[token]`) → appointment → payment rows on Home.
- **Onboarding:** name (required) → services (skippable, warned) → inbox OAuth (skippable) → number + A2P (skippable, 1–3 day verify) → voice builder (add-on gated) → dashboard. Minimum path = name + 4 clicks. Friction points in §1.6.
- **Whisper:** hold-to-talk (mobile bottom bar / Home card) → Whisper transcribe → same owner-agent loop → staged suggestions on Home queue.
- **Approval:** every outbound/money/calendar action stages; `ALWAYS_HITL` set (`autonomy.ts:26-33`) is unbypassable; Package 2 + per-action mode required for auto-execution (`agent-runtime.ts:1952`).

## 6. Design System

The token layer (`globals.css:15-207`) is first-class: closed type scale (12/13/14/16/20/24), closed radii (6/10/16), motion tokens (120ms/300ms), AA-tuned `--status-*` pairs, one accent. **The system is right; the codebase drifted from it.** Enforcement plan:

1. **Status colors (P1, ~40 files):** replace raw `emerald/amber/sky/red` classes with `--status-*` tokens or `StatusPill`. Worst offenders: `heat-badge.tsx:12-13`, `pulse-dot.tsx:9`, `connection-tile.tsx:47`, `approvals-list.tsx:134-145`, `interaction-timeline.tsx:33-43`.
2. **Radius (P1/P2, ~15 files):** cards back to `rounded-md` (10px); 16px reserved for modals per §2.5. `empty-state.tsx:23`, `roi-receipt.tsx:87`, `connection-tile.tsx:41`, etc.
3. **Motion (P1/P2):** remove cinematic layer from dashboard surfaces (`whisper-button.tsx:61-91` halos, `app-sidebar.tsx:173-206` stagger) per "dashboards stay calm"; functional transitions to `duration-[var(--duration-fast)]` (currently `duration-200` in ~20 files).
4. **Typography (P2):** `text-[10px]/[11px]` in 14 files → `.label-eyebrow` or scale steps.
5. **Components (P1):** delete duplicate `motion/section-header.tsx`, migrate its 2 callers; remove reintroduced italic brand device (`whisper-button.tsx:45,142`); consolidate pills onto `StatusPill`; delete unused `badge.tsx` or re-theme it.
6. **Focus (P2):** design-system `focus-visible` ring on raw `<button>` chips (`recovery-flow.tsx:447`, `activity-feed.tsx:78`, `agent-mode-control.tsx:74`).

## 7. Component Inventory

19 `ui/` primitives (Base UI/shadcn, all token-correct) + ~86 `gradia/` product components + 6 `motion/` wrappers. Full annotated table lives in the audit transcript; consolidation targets: 2× SectionHeader → 1, 3× pill primitives → 1, inline button-look reimplementations → `buttonVariants` (`customers/[id]/page.tsx:117`).

## 8. CRM Specification (gap-driven)

**Already best-in-class:** unified cross-channel communication history with pgvector recall; glass-box activity timeline with decision rationale; kanban pipeline with mobile fallback; quote builder + public token accept/decline; CSV recovery import.

**Correctness (fix before anything cosmetic):**
- **Merge data loss (P1):** `quotes.customer_id` and `vehicles.customer_id` are `ON DELETE CASCADE` (`crm_foundation_c1.sql:197,:77`). `actions/customers.ts:160-197` re-points only leads/interactions/appointments then deletes the loser → quotes + vehicles silently destroyed. `actions/crm-cleanup.ts:95-108` re-points vehicles but not quotes. Two divergent implementations, both wired to UI. Fix: single shared merge that re-points **all five** child tables (leads, interactions, appointments, vehicles, quotes) before delete.
- **Unbounded reads (P1):** `data/leads.ts:16-21,37-42` (no limit, on dashboard hot path via `co-owner.ts:73`); `data/revenue.ts:40-43` (all payments rows); `data/today-money.ts:93-97` (all sent quotes).

**Capability gaps vs the HubSpot/Pipedrive bar (post-alpha queue, in order):**
1. Pagination/cursor on customers, pipeline, quotes (today: silent truncation at 200–500 — a 201-customer shop cannot find customer #201).
2. Tags UI — `customers.tags` column exists (`crm_foundation_c1.sql:135`), zero reads/writes anywhere. Ship filter chips + editor.
3. Lifecycle/heat/date filters on customers list (columns already computed nightly by `lifecycle.ts`, never displayed).
4. Bulk actions (multi-select → tag/DNC/export) on customers table.
5. Saved views (persisted filter sets) — last; needs 1–3 first.
6. Search on Pipeline and Quotes tabs (customers-tab search pattern already exists to copy).

## 9. AI Workflow Specification

**Affirmed as-built** (matches locked principles): workflows by default — 8 coded recipe handlers + planner constrained to a discriminated union of recipe ids (`agent-planner.ts:101-228`, the model cannot invent behavior); one hand-rolled streaming loop primitive (`bi-agent.ts:155-239`) shared by BI and owner agents; staging-only action tools (no send tool exists in any loop); cross-model Sonnet critic on every staged draft; per-step model routing (Haiku workers, Sonnet planning) exactly as principle 7 prescribes. Prompt caching on static prefixes.

**Note:** the P0 deterministic person-lookup gap (agent can't find lead "mike") is real and confirmed in this audit's architecture read — it is owned by the `fix/post-deploy-1` lane per today's `RUN_2026-07-13_FIX_PASS.md` and deliberately **not** duplicated here.

**Post-alpha AI surface ideas that fit the existing runtime (no new engines):** lead-priority ordering on the pipeline from existing heat/urgency columns; "draft follow-up" quick action on customer detail (routes to existing staging tools); automation attribution rollup on Home (data already in `automation_runs`).

## 10. Database Recommendations (all additive)

1. Composite index `interactions (shop_id, customer_id, occurred_at DESC)` — three hot readers sort-scan without it (`data/customers.ts:89-99,144-149`, `mcp/server.ts:772-778`).
2. Expression indexes for JSONB hot filters: `interactions (metadata->>'vapi_call_id')`, `pending_actions (payload->>'vapi_call_id')`, `pending_actions (payload->>'customer_id')` (`call-records.ts:85,92`, `pipeline.ts:84-89`).
3. Merge-safety: keep CASCADE (correct for true deletes) but make app-level merge re-point all children first (§8). Optionally a `merge_customers` SQL function for atomicity — Supabase JS has no transactions; today a mid-merge failure half-merges (`actions/customers.ts:122-127` acknowledges this).
4. Vehicle truth consolidation (post-alpha): `vehicles` table + `customers.vehicle_*` + `leads.vehicle_*` are three sources of one fact, held together by a deprecated write-through shim (`lib/vehicles.ts:8-21`). Plan a read-migration to the table, then drop the flat columns.
5. `lastInteractionByCustomer` (`data/customers.ts:89-110`) fetches every interaction row for 200 customers to take one per customer — replace with a `DISTINCT ON` RPC.

## 11. Architecture Improvements

- **Aurinko seam (P2, largest structural asymmetry):** voice and telephony have provider seams; email/calendar has none — `@/lib/aurinko` imported directly in `approvals.ts:22`, `actions/jobs.ts:10`, `actions/shop.ts:10`, API routes. Create `email-calendar-provider.ts` mirroring the other seams. Post-alpha; mechanical.
- **Telephony seam bypasses:** `cron/roi-receipt/route.ts:24` sends SMS via `@/lib/twilio` directly; `twilio-number-picker.tsx:17` imports a vendor type client-side (neutral `AvailableNumber` already exists). Migrate both.
- **MCP defense-in-depth (P2):** MCP tools run service-role with manual `shop_id` filters only (`mcp/route.ts:62-64`) — correct today, but one forgotten filter in a future tool is a cross-tenant leak. Add a scoped-client wrapper or a test asserting every tool query carries shop scope.
- **`vapi/webhook` resolve-before-verify** (`route.ts:246` vs `:254`): reviewed and **won't-fix** — the verification secret is per-shop (assistant-bound), so shop resolution must precede verification; resolution is read-only and a forged assistantId fails verification. Already documented in-code.
- **FK sub-fetches without redundant shop guard** (`actions/pipeline.ts:151-156,164-168`, `actions/quotes.ts:203-208`) — RLS-backstopped today; add the `.eq("shop_id")` so the defense-in-depth invariant stays uniform.

## 12. Performance Optimization Plan

1. **Code-splitting (P1):** zero `next/dynamic` in the codebase. Dynamic-import: `recharts` sparkline in `kpi-row.tsx:4` (dashboard hot path), `BiChat` inside `command-bar.tsx` (loads for every user, used on demand), recovery flow, quote builder.
2. **Query bounds (P1):** limits on `data/leads.ts`, `data/revenue.ts` (or SQL `sum()` RPC), `data/today-money.ts` — see §8.
3. **Parallelize recipe loops (P2):** `executeLeadFollowupSms` issues up to 50 sequential per-lead queries; `executeStaleCustomerSms:774-798` already shows the batched `in(ids)` pattern — port it.
4. **Narrow hot selects (P2):** `select("*")` on shops rows in `agent/chat:100-104`, `bi/chat`, `twilio/sms:107-111` pulls encrypted token columns per request (server-only, verified not exposed — efficiency, not security).
5. framer-motion is load-bearing in the sidebar so it stays in the shell bundle; acceptable — but stop adding it to leaf components that only need a CSS transition.

## 13. Accessibility Audit

**Strong:** real ARIA on custom controls (`role="switch"` DNC toggle, `role="radiogroup"` mode dial, keyboard-enabled pipeline cards `pipeline-board.tsx:354-367`); `sr-only` labels on all icon buttons; universal `useReducedMotion` + CSS fallback (`globals.css:289-298`); Base UI overlays (focus trap/Esc/return-focus); no `window.confirm`; no div-as-button traps.

**Gaps:** focus-visible ring missing on ~24 raw button/chip surfaces (§6.6); non-token `*-500` status text unverified for AA on near-black (`agent-card.tsx:110`, `approvals-list.tsx:134`, `a2p-wizard.tsx:144`) — the token sweep in §6.1 fixes this class of issue wholesale; status-by-color-alone risk disappears with `StatusPill` adoption (icon+text baked in).

## 14. Mobile Optimization Plan

Mobile is already a strength: bottom tap-to-talk composer with safe-area insets, day-list calendar variant, stage-button pipeline fallback for touch, icon-collapsing topbar. Remaining: add `loading.tsx` to the heavy pages (worst on mobile connections, §1.4); new-lead modal autofocus + `inputmode="tel"` (owned by fix-pass lane, item 3); verify 44px touch targets on the pill/chip surfaces during the §6 sweep.

## 15. Production Roadmap

**This branch (pre-alpha, no launch risk — all additive/self-contained):**
- Wave 1 — correctness: unified merge (quotes+vehicles re-pointed), error/not-found/global-error boundaries (branded, incl. public `/q`), billing shell fix, calendar title, query bounds. 
- Wave 2 — design-system enforcement sweep (§6.1–6.6): tokens, radii, motion, duplicates, focus.
- Wave 3 — perf + metering: dynamic imports, inbound classify/draft metering (per `gradia-metering-billing` conventions — see below), index migration, recipe batching, webhook reorder.

**Fix-pass lane (owned by `fix/post-deploy-1`, not this branch):** deterministic person lookup, honest-failure copy, pipeline board polish, Today coherence, demo-data hygiene.

**Post-alpha (Aug 7+), in order of leverage:** CRM pagination → tags UI → filters → bulk actions → saved views (§8); command-bar navigator mode (§4); Aurinko seam (§11); vehicle-truth consolidation (§10.4); light theme (`.light` tokens already defined, unshipped).

**Margin follow-ups for the founder (pricing decisions, not code):** `outreach_draft` at 0.3¢ wholesale doesn't cover its Haiku draft + Sonnet critic; Whisper meters `whisper_note` only while running the full Sonnet owner-agent loop that `bi_answer` charges 1.5¢ for. Both are pricing-config decisions per `_docs/GRADIA_PRICING.md` — flagged, not changed here.
