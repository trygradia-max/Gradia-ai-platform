# Gradia — Handoff to Astra

_Written 2026-09-08 by a Claude Code session (Fable 5.1) at the end of a verification-and-closeout pass. Every claim below was checked against the code or the tooling on that date; where something was only read from docs and not exercised, it says so. Status labels are exactly: **LIVE** · **BUILT — NEEDS VERIFICATION** · **PARTIALLY BUILT** · **BROKEN** · **ROADMAP** · **DECISION REQUIRED** · **SUPERSEDED**._

_Read `CONTEXT.md` (repo root) before this file. It is the founder's single source of truth for scope and build order and outranks everything, including this handoff. This document describes **what actually exists**; `CONTEXT.md` describes **what gets built next**._

---

## 1. Executive summary

Gradia is a Next.js 16 / Supabase single-tenant-per-shop CRM for automotive appearance shops (detailing, ceramic, PPF, tint), with an approval-gated AI layer on top. What is genuinely solid in code today:

- **The HITL approval engine** (`src/lib/approvals.ts`, 2,167 lines): tenant-bound atomic claim, edit-then-approve, reject/undo, rollback-on-failure, idempotent re-approve, conflict override with a recorded reason. Covered by unit and real-Postgres integration tests. This is the strongest subsystem.
- **Webhook idempotency and booking atomicity**: `provider_events` claims (Twilio, Vapi), a per-shop advisory-locked `write_appointment_serialized` RPC with a `pending_action_id` idempotency key, unique keys on metering and automation runs. Integration-tested for TOCTOU, replay and cross-tenant cases.
- **CRM core**: customer identity spine with phone/email normalisation and dedupe, a first-class `vehicles` table, a six-stage pipeline with timers, quotes with a public accept page, a week calendar with drag-reschedule, a job status machine, a shared pgvector memory layer.
- **Inbound channels**: SMS (Twilio) and email (Aurinko/Gmail) both land as classified, staged leads with drafted replies. Voice (Vapi) has a real 8-tool agent loop.
- **Gmail connection** was founder-verified on 2026-09-02 after a real bug fix.

What is **not** true, and must not be claimed:

- Voice has **never been verified on a real inbound call**. A2P 10DLC has **nothing registered**, so production SMS sending is not possible for any shop. Calendar conflict enforcement is **OFF in production** (double-booking possible). Three-tier billing is an **open, conflicting PR** and Stripe price ids are deliberately **absent from Production** (checkout fails closed).
- There is **one owner login per shop**. No members, roles, seats, invitations or locations exist anywhere in code or schema. "Staffed shop" support is entirely roadmap.
- There is **no Meta lead-ads code** at all (only stale env-var names and two historical migrations). No web-form intake endpoint. No normalised lead-intake seam.
- The agent is **advisory everywhere except voice**: lead creation emits no event, the SMS drafter holds no conversation state, no agent tool moves a pipeline stage, and the owner agent's tools all stop at draft/propose/stage.
- Nothing notifies the owner that an approval is waiting. The unified inbox cannot reply. Call forwarding does not exist. These three are the v1 ship gates the founder set on 2026-09-08 (D-069).

The founder's stated v1 is **"Never miss another call"**: voice receptionist + CRM + pipeline + calendar + quotes + Chief of Staff + approved email. SMS and Meta are explicitly **out of v1**. Of the six D-069 ship gates, **zero are complete** today (B-16 first half is merged; the rest are unstarted).

Verification on 2026-09-08 against `main` @ `20e153a`: dependency install, type check, lint, 779 unit tests, production build (60 routes), 117 DB-backed integration tests, and a clean shadow-DB migration apply all **pass**. No end-to-end browser tests exist in this repo.

---

## 2. Current branch, latest commit, git status

Two separate git repositories live under `~/Gradia/`:

| Repo | Path | Remote | Branch | Head |
|---|---|---|---|---|
| Platform (product) | `~/Gradia/platform` | `github.com/trygradia-max/Gradia-ai-platform` | `main` | `20e153a` — `feat(B-16): onboarding — vehicle-size pricing + working hours step (#41)`, merged 2026-09-05 05:20 UTC |
| Marketing site | `~/Gradia/marketing` | (its own remote) | `site-v2` | `58bef16` — `Close D-067 claims-sweep residuals on demo and industries.` |

This handoff covers the **platform** repo. The marketing repo is a separate lane (see its own `CLAUDE.md`, `NEXT_TASK.md`, `HANDOFF.md`, `REVIEW_NOTES.md`); its working tree has two untracked directories (`.playwright-mcp/`, `.wt-claims/`) and nothing else.

### 2.1 What this session changed in the platform checkout

- Local `main` was **one commit behind `origin/main`** (the B-16 merge). It was fast-forwarded to `20e153a`. Two zero-byte stale lock files (`.git/index.lock`, `.git/ORIG_HEAD.lock`, created 12:34 local with no git process alive) were removed to allow that.
- **Uncommitted change on `main`:** `CONTEXT.md` (25 insertions, 1 deletion) — the founder's own edit from 2026-09-08 12:44 adding §1b "The sellable MVP — D-069", tickets **B-19** (phone number continuity) and **B-20** (owner notification), and a correction to §3 about outbound email. **It was left in place, untouched.** A copy of the same hunks is carried on branch `docs/handoff-astra` (this document's branch) so it is not lost; when that PR merges the local edit becomes identical to `main`.
- No other tracked file in `platform/` was modified by this session.

### 2.2 Open pull requests

| PR | Branch | State | Note |
|---|---|---|---|
| **#42** | `fix/duration-size-class` | **OPEN — opened this session** | B-16 follow-up: voice/drafting surfaces state a duration *range* when vehicle size is unknown. Authored 2026-09-05 by the prior agent session (`4e762a6`, Claude Opus 5); the commit message admits `next build` was never run. This session built it on the Mac merged with `main` (clean `npm ci`, tsc, lint, 786 unit tests, `next build` all green) and opened the PR. Founder acceptance walk still required (§6 step 7 of `CONTEXT.md`). |
| **#38** | `auto/b-02-0903-1728` | OPEN — **CONFLICTING with `main`** (`mergeStateStatus: DIRTY`) | B-02 three-tier billing (P0-013). 45 files incl. migration `20260903120000_p0_013_shop_tier.sql`. Founder/Stripe-gated: needs live Stripe prices + founder acceptance. CI on the branch was green before it went stale. |
| (this doc) | `docs/handoff-astra` | opened at the end of this session | This file + B-16 close line in `CONTEXT.md` + the founder's uncommitted D-069/B-19/B-20 edit + an autorun-log entry. |

### 2.3 Unmerged branches without a PR

- `docs/b-16-close` (`c9ff8a0`) — one-line CONTEXT.md close of B-16 first half. **Folded into `docs/handoff-astra` via cherry-pick;** safe to delete after that merges.
- `docs/idea-review-2026-09-04` (`dfe0c8c`) — the 2026-09-04 ideas review, decision **Q-26**, and a ticket file `B-19-draft-edit-delta-capture.md`. **Numbering collision:** `CONTEXT.md` (uncommitted) now uses **B-19 for phone number continuity**. One of the two must be renumbered before either is built.
- `wip/p0-013` — superseded by PR #38.
- `auto/b-01…`, `auto/b-03…`, `auto/b-00…`, `auto/b-16…`, `auto/batch-1*`, `fix/aurinko-webhook-validation`, `docs/*` — all merged; branches left in place.
- Five stashes exist (`git stash list`): two PERF-001 partials from 2026-09-02 (superseded by PR #36), an organizer planning stash, a P0-006 WIP, and "founder ops local edit" on `main`. `git stash pop/drop` is on the deny list; leave them.

---

## 3. Technology stack and important dependencies

From `package.json` (no `.nvmrc` in `platform/`; CI uses Node 22, the Mac has Node 24.15, `@types/node` is ^20):

- **Next.js 16.2.6** (App Router, Turbopack builds, `src/proxy.ts` replaces `middleware.ts`), **React 19.2.4**, **TypeScript 5**, **Tailwind v4**, Radix + base-ui + shadcn primitives, `framer-motion`, `recharts`, `sonner`, `lucide-react`.
- **Supabase**: `@supabase/supabase-js` 2.105, `@supabase/ssr`; Postgres with pgvector; Supabase Auth (Google OAuth + magic link); Storage buckets `recovery-imports` and job photos. Supabase CLI **pinned 2.98.2** in CI (local install is also 2.98.2; a newer CLI broke the local stack once — see `.github/workflows/ci-integration.yml`).
- **LLMs**: Anthropic Claude via `@langchain/anthropic` (`ChatAnthropic`, primary worker model `claude-haiku-4-5-20251001` in `src/lib/ai-service.ts`; `GRADIA_LLM_MODEL` env override exists); OpenAI for embeddings (`text-embedding-3-small`, 1536 dims baked into the `interactions` schema) and Whisper transcription. `langchain` is used for structured output only; there is **no agent framework** by design (locked principle).
- **Vendors, all via hand-rolled `fetch`** behind seams: Twilio (`src/lib/twilio.ts`, `telephony-provider.ts`, `twilio-a2p.ts`), Vapi (`vapi.ts`, `voice-provider.ts`), Aurinko for Gmail + Google Calendar (`aurinko.ts`), Stripe platform billing (`stripe.ts`, no Stripe SDK), Jobber GraphQL (`jobber.ts`, `jobber-push.ts`, `crm-provider.ts`).
- **MCP server** (`@modelcontextprotocol/sdk`) at `/api/mcp` with 12 tools and hashed bearer tokens.
- **Observability**: `@sentry/nextjs` 10 (wrapped in `next.config.ts`; emits two `disableLogger` deprecation warnings on every build), an ops alert seam (`src/lib/alerts.ts`), `GET /api/health`, cron heartbeats.
- **Tests**: Vitest 4.1.8 (`eval/` directory), ESLint 9 with `eslint-config-next`.
- **Hosting**: Vercel (production `https://gradia-ai-platform.vercel.app`; nine crons in `vercel.json`). The Vercel CLI is **not** logged in on this machine (`npx vercel whoami` → "Not authorized" as of 2026-09-02).

---

## 4. Exact local setup

```bash
cd ~/Gradia/platform
nvm use 22            # CI version; 24 also works locally
npm ci                # clean install from package-lock.json (verified 2026-09-08)
cp .env.example .env.local   # then fill values — see §5. .env.local is gitignored and on the agent deny list.
supabase start        # local Postgres/Auth/PostgREST; applies every migration in supabase/migrations
npm run dev           # http://localhost:3000
```

The local Supabase project id is `gradia-app` (containers `supabase_*_gradia-app`; Studio at `http://127.0.0.1:54323`, API at `http://127.0.0.1:54321`). As of 2026-09-08 that stack had been running for 13 days and **carries one migration that is not on `main`** (`20260903120000` from PR #38: `shops.tier`, `shops.trial_ends_at`, `shops_tier_check`). `supabase migration list --local` shows it applied with no matching file. It is harmless for tests but means the local DB is not a faithful mirror of `main`; a `supabase db reset` (founder-only, on the deny list) would clear it.

Seeding: `npm run seed:smoke` (`scripts/seed-smoke.mjs`, reads `.env.local`) writes explicitly-marked demo rows; Settings → Developer has a "Clear demo data" card that deletes exactly those rows. `scripts/perf-seed.mjs` / `perf-timing.mjs` are the PERF-001 loopback-only tools.

---

## 5. Required environment variable names (no values)

Read directly from `process.env.*` in `src/` on 2026-09-08. Documented in `.env.example` and `docs/env-setup.md`; the presence audit lives in `docs/gradia-v2/runbooks/production-config-audit.md`.

**Boot-required:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `GRADIA_DASHBOARD_URL`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CRON_SECRET` (every cron fails closed without it), `ENCRYPTION_KEY` (64 hex chars; encrypts Twilio/Aurinko/Jobber/Vapi secrets at rest; rotation is manual).

**Per feature:** `VAPI_API_KEY`, `VAPI_WEBHOOK_SECRET`, `VAPI_DEFAULT_SHOP_ID` (dev only; fails closed in prod) · `AURINKO_CLIENT_ID`, `AURINKO_CLIENT_SECRET`, `AURINKO_SIGNING_SECRET` · `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PRIMARY_PROFILE_SID` · `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`, `STRIPE_PRICE_VOICE_ADDON`, `STRIPE_PRICE_CREDIT_PACK`, `STRIPE_PRICE_MINUTE_PACK` (the four `STRIPE_PRICE_*` are **intentionally unset in Production** until P0-013/B-02 lands) · `STRIPE_CONNECT_CLIENT_ID`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (Connect is flag-hidden and out of scope) · `JOBBER_CLIENT_ID`, `JOBBER_CLIENT_SECRET` · `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `NEXT_PUBLIC_SENTRY_ENVIRONMENT` · `OPS_ALERT_WEBHOOK_URL`, `OPS_ALERT_SMS_TO`, `OPS_ALERT_SMS_FROM` (alert destination — **not configured** as of the last record; alerts are console + Sentry only) · `GLOBAL_DAILY_COST_CEILING_CENTS` · `NEXT_PUBLIC_GRADIA_CONFLICT_ENFORCEMENT` (only the exact string `true` enables; **OFF in Production**) · `GRADIA_LLM_MODEL` (optional override).

**Test/mock seams (never set in real environments):** `STRIPE_API_BASE`, `TWILIO_API_BASE`, `TWILIO_MESSAGING_API_BASE`, `TWILIO_TRUSTHUB_API_BASE`, `VAPI_API_BASE`, `AURINKO_API_BASE`, `PERF_TIMING`.

**Integration tests:** `SUPABASE_TEST_URL`, `SUPABASE_TEST_SERVICE_ROLE_KEY`, `SUPABASE_TEST_ANON_KEY` (+ `INTEGRATION=1`, set by the npm script). Live evals: `EVAL_LIVE=1` + `ANTHROPIC_API_KEY`.

**Stale in `.env.example`:** `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` (no reader in `src/`), and the `ENCRYPTION_KEY` comment still mentions `shops.instagram_page_access_token_enc` (column exists from a 2026-05 migration; no code reads it). `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` are build-time only (read in `next.config.ts`, not `src/`). Missing from `.env.example` but read: `TWILIO_PRIMARY_PROFILE_SID`, `GRADIA_LLM_MODEL`. The banner in `docs/env-setup.md` claiming four keys are missing from the template is itself out of date.

---

## 6. Exact commands

| Purpose | Command | Result on 2026-09-08 (`main` @ `20e153a`) |
|---|---|---|
| Dependency install validation | `npm ci --dry-run` / clean `npm ci` in a fresh worktree | exit 0 (dry run reports one extraneous package would be removed; `npm ls` shows 5 extraneous `@emnapi`/`@napi-rs` wasm helpers — harmless) |
| Type check | `npx tsc --noEmit -p tsconfig.json` | clean |
| Lint | `npm run lint` (→ `eslint`) | clean |
| Unit tests | `npm test` (→ `vitest run`, excludes `*.eval.test.ts` and `integration/`) | **74 files, 779 passed, 4 skipped** |
| Integration tests (real Postgres) | `npm run test:int` with the three `SUPABASE_TEST_*` vars exported from `supabase status -o json` | **13 files, 117 passed** |
| Live LLM evals | `npm run eval` (`EVAL_LIVE=1`) | **not run** (spends Anthropic tokens). Known: `eval/owner-agent-routing.eval.test.ts` "stages a reply for approval…" fails on `main` since before CLEANUP-001 — the model never calls `draft_reply` (recorded in `backlog.md` Band 2 #10). |
| Production build | `npm run build` (→ `next build`, Turbopack) | success, 60 routes, 2 Sentry deprecation warnings |
| Migration validation | `supabase db diff --local --schema public` (boots a shadow DB, applies all 62 migrations, diffs against the local DB) | all 62 apply with NOTICE-only output; diff = only the PR #38 `tier`/`trial_ends_at` columns present locally (see §4) |
| E2E / browser tests | — | **none exist** in `platform/` (no Playwright dependency; the marketing repo has Playwright MCP tooling only) |
| Dev server | `npm run dev` | — |
| Smoke seed | `npm run seed:smoke` | — |
| One ticket, on demand | `~/Gradia/scripts/jarvis.sh [B-xx]` | refuses on a dirty tree |

CI: `.github/workflows/ci.yml` (unit/tsc/lint/build) and `ci-integration.yml` (Supabase stack + `test:int`), both **blocking**, both green on `20e153a` and on PR #38's last push. `continue-on-error` on test jobs is forbidden by `docs/gradia-v2/09-testing-strategy.md` §5.

---

## 7. Repository and folder map (platform)

```
platform/
  CONTEXT.md                 ← single source of truth: scope (D-067), v1 (D-069), build list §4, guardrails §5, session rules §6
  CLAUDE.md                  ← "read CONTEXT.md first"; locked architectural principles
  .claude/settings.json      ← agent permission deny/allow list (main push, merge, rm -rf, .env, db push/reset all denied)
  .git/hooks/pre-push        ← blocks pushes to main unless GRADIA_FOUNDER_PUSH=1
  src/
    proxy.ts                 ← Next 16 middleware: session refresh + flag-gated 404 for /api/stripe/connect
    instrumentation*.ts      ← Sentry
    app/
      (dashboard)/           ← authenticated shell (layout redirects to /login or /onboarding)
        dashboard/           ← Chief of Staff (B-03)
        approvals/ activity/ conversations/ customers/ (+[id], quotes/new, recovery) calendar/ calls/[callId]/ receptionist/ (+build) settings/
        agent/ agents/ leads/ recovery/ schedule/ chat/   ← redirects to canonical routes
      onboarding/            ← 6-step wizard (post B-16)
      login/ auth/callback/  ← Supabase Auth (Google OAuth, magic link)
      billing/ how-it-works/ q/[token]/   ← Numbers & Billing, marketing-ish explainer, public quote page
      actions/               ← 32 server-action modules (shop, jobs, approvals, quotes, pipeline, customers, services, …)
      api/                   ← route handlers: twilio/{sms,sms/status,a2p/status}, vapi/webhook, aurinko/{auth,webhook}, jobber/auth, stripe/{webhook,connect}, cron/* (9), export, health, mcp, agent/chat, bi/chat, whisper/process, recovery/import, admin/*
    lib/                     ← 120+ modules, 32.8k lines; see §21 "files to inspect first"
      data/                  ← server loaders per screen (activity, kpis, pipeline, calendar, connections, …)
      recovery/              ← customer-recovery import pipeline (mbox/contacts/CSV → extract → review → win-back)
      supabase/              ← client/server/middleware factories + forShop() tenant facade
      mcp/                   ← MCP server + token auth
      types/database.ts      ← hand-written row types (no generated types)
    components/gradia/       ← 79 product components; components/ui/ ← 17 shadcn primitives
  supabase/migrations/       ← 62 SQL migrations (2026-05-07 → 2026-09-01); supabase/rollbacks/ ← 2 down-scripts (not applied)
  eval/                      ← 81 unit test files, 7 live-eval files, integration/ (13 files); README.md explains tiers
  docs/                      ← BUILD_REFERENCE.md (look/sound/behave), go-live runbooks per vendor, gradia-v2/ (planning library, decision log 11-, capability map 04-, program/ boards + autorun-log.md, tickets/)
  scripts/                   ← seed-smoke, perf tools, two vendor spikes
  GRADIA_AGENT_HANDOFF.md    ← July 2026 handoff, historical (pre-D-067); GO_LIVE_CHECKLIST.md, OVERNIGHT_REPORT.md, RUN_*.md, *_PLAN.md — all superseded by CONTEXT.md §9
~/Gradia/_docs/              ← cross-cutting specs (WHAT_GRADIA_DOES.md = claim law; pricing; CRM foundation spec)
~/Gradia/scripts/            ← jarvis.sh, nightly.sh, autorun drivers (founder tooling)
```

---

## 8. Architecture summary

- **Server-first Next.js.** Screens are React Server Components calling loaders in `src/lib/data/*` with a per-request `cache()`-memoised user/shop resolution (`src/lib/shop.ts`). Mutations are server actions (`src/app/actions/*`) that call `requireUser()` → `requireShop()` and write through the **session** Supabase client (RLS-bound).
- **Two Supabase clients.** Session client (RLS) for UI paths; **service-role client** (bypasses RLS) for webhooks, crons and the approval executor. 32 files import `createServiceClient`; the list is CI-locked by `eval/tenant-scoping.test.ts`.
- **Planner → deterministic runtime** (locked principle #3). LLMs classify, extract, draft and plan; deterministic code executes. Every customer-facing write is a `pending_actions` row executed by `executeApproval()` in `src/lib/approvals.ts`. The owner agent, voice agent, Whisper, automations, scheduled agents and the MCP server all **stage** into that one table; there is no second execution path.
- **Shared brain**: `interactions` (pgvector embeddings), `shop_knowledge` (chunked RAG), one persona, one service-pricing module (`service-pricing.ts`) feeding voice, quotes and drafts identically.
- **Guardrails in code, not prompts** (locked principle #2): `ALWAYS_HITL` floor in `autonomy.ts`, `send-policy.ts` (quiet hours, STOP, marketing consent), `agent-audience.ts` caps and cooldowns, `rate-limit.ts` buckets, `credits.ts` fail-closed metering, source-scan tests that fail if a send call appears in the owner-agent or BI tool layer.
- **Idempotency**: `provider_events` claim RPCs (Twilio inbound, Vapi end-of-call), `write_appointment_serialized` RPC with advisory lock + `pending_action_id` unique, `usage_events (shop_id, kind, vendor_ref)` unique, `automation_runs (automation_id, trigger_ref)` unique.
- **Feature flags** in `src/lib/features.ts` (compile-time constants) plus one operational env flag for conflict enforcement. "Gate, don't delete" is the convention; D-067 out-of-scope surfaces (payments/Connect, workflow builder) are flag-hidden.
- **Autonomy model in code** is still the old binary `suggest | autonomous` per agent key, gated behind `hasPackage2()` (paid plan + voice add-on), with `ALWAYS_HITL = {book, reschedule, cancel, create_quote}`. The founder's D-068 four-tier reversibility ladder is **not implemented** (ticket B-17).

---

## 9. Authentication and onboarding flow

**Auth (LIVE):** Supabase Auth. `login-form.tsx` offers Google OAuth (`signInWithOAuth`) and a magic link (`signInWithOtp`); `/auth/callback/route.ts` exchanges the code and redirects to `next` on the **request's own origin** (Preview-safe). `src/proxy.ts` → `updateSession()` refreshes the cookie session and redirects unauthenticated requests for `/dashboard`, `/leads`, `/schedule`, `/settings`, `/onboarding` to `/login`. **Finding:** that prefix list predates the current routes (`/customers`, `/calendar`, `/conversations`, `/approvals`, `/activity`, `/receptionist`, `/billing` are absent), but every `(dashboard)` page is protected anyway by the layout's `requireShop()` → `requireUser()` → `redirect("/login")`. Protection is real; the middleware list is stale.

**Onboarding (BUILT — NEEDS VERIFICATION on Preview):** `src/app/onboarding/page.tsx` + `onboarding-wizard.tsx` + `onboarding-launch-steps.tsx`. New shops are inserted with `settings.onboarding_done = false` (`actions/shop.ts`); the dashboard layout routes such shops to `/onboarding`. Six steps after B-16: (1) shop name/location/phone → (2) services + pricing via the real `ServiceMenuCard` (size-class prices, per-size durations, condition bumps) → (3) working hours (`saveWorkingHours`, gated on `hasCustomWorkingHours`) → (4) inbox = Aurinko Gmail OAuth (returns to `?step=4`… note the OAuth `next` target is `step=5` on `main`; verify the landing step on Preview) → (5) number = Twilio number picker + A2P wizard → (6) receptionist = voice builder + test call. `deriveWizardStep()` resumes at the first incomplete step; steps 4–6 are skippable. **Missing from onboarding (B-16 second half, not built):** SMS consent language (A-05, lawyer question), A2P status step (B-15b), Meta connection, surfacing the existing calendar-connect flow. Founder acceptance walk on the B-16 Preview was not recorded in the log.

---

## 10. Organisation, shop, location, member, role and permission model

**What exists (LIVE):** `shops.owner_id → auth.users.id`. One user may own several shops (`listShopsForCurrentUser`, `ShopSwitcher`, cookie `gradia_active_shop`, "add another shop" via `/onboarding?new=1`). All 32 RLS policies resolve tenancy as `shop_id IN (SELECT id FROM shops WHERE owner_id = auth.uid())`.

**What does not exist (ROADMAP):** no `members`, `roles`, `invitations`, `seats` or `locations` tables; no `role` column anywhere; `grep -rniE "location_id|locations"` in `src/` returns 0. The `actions/co-owner.ts` file is a follow-up drafter widget, not a co-owner role. "Staffed shop" = the ICP in `CONTEXT.md` §1, but the code is strictly one-owner-per-shop (A-08 in `CONTEXT.md`: "Staff logins — the one item from the §2 cut list that will come back"). The planning library designs this as epic E01 (`docs/gradia-v2/04-capability-map.md` rows 3–4: members/roles *planned*, locations *planned*).

**Solo vs staffed:** because the data model has no member concept, a solo detailer and a 10-person shop are represented identically today (one owner, one shop row). There are not two products; there is one product that only serves the owner.

---

## 11. Database schema and migration status

62 migrations in `supabase/migrations/` (first `20260507220000_gradia_core.sql`, last `20260901130000_cron_heartbeats.sql`), plus `supabase/catchup_2026-06-18_prod.sql` (historical). All are additive except the two **unapplied** rollback scripts in `supabase/rollbacks/` (`20260812_p0_005_down.sql`, `cleanup-001_hcp_slack_columns_drop.sql` — the latter is destructive and founder-run only).

**Tables (30):** `shops` (tenant root; ~60 columns incl. encrypted vendor secrets, `plan`, `credit_limit`, `a2p_status`, `voice_config`, `simulation_mode`, `settings` jsonb), `customers`, `leads`, `vehicles`, `services`, `quotes`, `appointments` (doubles as the job record), `interactions` (pgvector), `pending_actions`, `action_decisions`, `call_records`, `bi_conversations`, `bi_messages`, `custom_agents`, `custom_agent_runs`, `automations`, `automation_runs`, `shop_knowledge`, `mcp_tokens`, `credit_grants`, `usage_events`, `payments`, `statements`, `pricing_config` (global), `rate_limits`, `a2p_registrations`, `import_jobs`, `import_messages`, `provider_events`, `cron_heartbeats`, `shop_metrics`.

**Functions/RPCs:** `write_appointment_serialized`, `claim_provider_event`, `complete_provider_event`, `fail_provider_event`, `prune_provider_events`, `match_customer_memory`, `match_shop_knowledge`, `revenue_summary`.

**RLS:** enabled on 29 tables; 32 `CREATE POLICY` statements. Ledger tables (`usage_events`, `payments`, `shop_metrics`) are SELECT-only for owner sessions (integration-locked). `provider_events` and `cron_heartbeats` are service-role-only.

**Row types** are hand-maintained in `src/lib/types/database.ts` (900 lines) — there is no generated Supabase type file, so schema/type drift is possible and several optional columns are marked "present only once the C1 migration is applied" with best-effort tolerant writes.

**Known schema debt:** dual truth `leads.status` (`new|quoted|booked`) vs `leads.stage` (`crm_stage` enum, 6 values) — B-11; deprecated write-through vehicle columns on `customers`/`leads`; dormant Housecall Pro and Instagram columns; `vehicles.vin` exists but no UI writes it; `customers.lifecycle` derivation (`lifecycle.ts`) is **not wired to any cron**.

**Migration status:** Production and CI apply from this folder; `main` and the shadow DB agree. The **local** dev DB additionally has PR #38's `20260903120000` applied (see §4).

---

## 12. Tenant isolation approach

- **Session paths:** RLS as above. Server actions also add `.eq("shop_id", shop.id)` explicitly (belt and braces).
- **Service-role paths:** RLS is bypassed, so every query must carry an explicit tenant predicate. P0-011 (PR #29) closed the audit findings: approval claims are **tenant-bound** (`claimPendingAction(shopId)` where `shopId` comes only from the session, a verified provider mapping, or a cron-loaded row — never from request input; `eval/tenant-scoping.test.ts` locks the call sites), Stripe webhook resolves the shop from `client_reference_id` / `stripe_subscription_id` and rejects Connect events on the platform path, Vapi webhook resolves the shop by assistant and verifies a **per-shop** server secret.
- **`forShop()` facade** (`src/lib/supabase/for-shop.ts`, ADR-003): applies `shop_id` by construction, stamps it over forged payloads on insert/update, exposes `unscoped` as the loud escape hatch. **Adoption is the gap:** 4 call sites vs **323 raw `.from("…")` calls in `src/lib`** (543 in `src/`). Tenancy on service-role paths is therefore still per-line discipline (`CONTEXT.md` §5 guardrail 5: "`.eq("id", …)` alone is not authorization"). Q-26 option 3 recommends a two-shop red-team acceptance run before onboarding paying shops.
- **Violation signal:** a failed tenant-bound claim emits `TENANT_SCOPE_VIOLATION` (SEV-0 through `alerts.ts`); delivery destination is not yet configured (see §24).
- **Integration-tested:** cross-tenant availability, concurrent bookings in two shops, ledger visibility.

---

## 13. CRM capability inventory

| Area | Status | Notes |
|---|---|---|
| Customer identity spine | LIVE | `customers.ts`: `normalizePhone/normalizeEmail`, `findCustomerByChannel`, `findOrCreateCustomer` (fills missing identifiers on match). Used by SMS, email, voice, imports, MCP. |
| Customer list + search | LIVE | `/customers?tab=customers` → `CustomersTable` (overflow-x scroll, min-width columns). |
| Customer detail | LIVE | `/customers/[id]`: identity card, LLM summary card (`whisperCustomerSummary`), interaction timeline, pipeline card (leads + appointments), `SmsQuickReply`, merge dialog, do-not-contact toggle, heat badge. |
| Direct "add customer" / edit form | ROADMAP (B-11) | No create form. `updateCustomerDetails` exists in `actions/crm-cleanup.ts` for the cleanup card only. |
| Merge / dedupe | LIVE | `merge-customers.ts` re-points all 8 child tables before delete (fixed a 2026-07-13 data-loss bug); `listMergeCandidates`, `CustomerMergeDialog`, `CrmCleanupCard` clusters by phone/email. Not transactional (Supabase JS has no transactions) — failure mode is a re-runnable half-merge, never a lost child. |
| Do-not-contact / opt-out / consent | LIVE | `customers.do_not_contact`, `sms_opted_out_at`, `marketing_consent_at/_source`; inbound STOP/START keywords update the ledger; `send-policy.ts` enforces at the send boundary. |
| Lifecycle (`lead/active/maintenance/at_risk/lapsed/won_back`) | PARTIALLY BUILT | Pure derivation in `lifecycle.ts` is test-locked; **no cron calls it** (needs founder sign-off per the file header; D-039 approved the thresholds). |
| Export | LIVE | `GET /api/export?entity=customers|vehicles|leads|appointments|conversations&format=csv|json` (B-01, PR #37); session-scoped shop id, rate-limited, embedding columns stripped, **10k-row cap with no "partial" banner**. Settings → Developer card. |
| Import | BUILT — NEEDS VERIFICATION | Customer-recovery pipeline (`lib/recovery/*`, `/customers/recovery`): mbox / contacts / structured CSV → LLM extraction → review queue → accept. `FEATURES.customerRecovery = true` with the note "verify a CSV import end-to-end before prod deploy". B-13 "minimal CSV import with dedupe on phone/email" is still listed as unbuilt in `CONTEXT.md`, i.e. the recovery wizard is not considered the simple import. |
| Vehicles | LIVE (data), PARTIALLY BUILT (UI) | See §14. |
| Pipeline | LIVE | See §16. |
| Quotes | LIVE (needs Preview walk for B-16 pricing) | See §17. |
| Jobs / work orders | SUPERSEDED (D-067) but code ships | See §17. |
| Reporting | PARTIALLY BUILT | See matrix. |

---

## 14. Customer and vehicle record capabilities

- **Customer columns:** name, phone, email, deprecated vehicle_* write-through, `last_visit_at`, `last_transaction_at`, `source` (import/inbound_sms/voice/manual/…), consent fields, `do_not_contact`, `jobber_client_id`, dormant `housecallpro_customer_id`.
- **Vehicle row** (`vehicles`, CRM C1): `year/make/model/trim/color`, `size_class` (`sedan|coupe|truck_suv|xl_van|exotic|rv|boat|motorcycle`), `plate`, `vin`, `photos[]`, paint/interior condition scores + notes, `coating/ppf/tint` jsonb, `maintenance_schedule[]`, `notes`, `import_job_id`. One customer → many vehicles.
- **Code:** `vehicles.ts` (`upsertCustomerVehicle`, `getPrimaryVehicle`, `vehiclesByCustomerIds`, audience filter by vehicle), `vehicle.ts` (`parseVehicle` from free text → make/model/year/color only; **no make/model → size_class inference exists**), `actions/quotes.ts::addCustomerVehicleFromText`.
- **Gaps:** no VIN input in any component (grep confirms); no per-vehicle history view; `maintenance_schedule` is armed by job completion but never consumed (recurring jobs are out of scope, D-067); condition scores are set only through the quote builder path.

---

## 15. Lead intake sources and normalisation

There is **no normalised intake seam** (B-05). Each source writes its own way:

| Source | Status | Path | Writes |
|---|---|---|---|
| Inbound SMS (Twilio) | LIVE in code; **cannot run in prod until A2P registers** | `api/twilio/sms/route.ts`: resolve shop by `To` → verify signature → claim `provider_events` (`MessageSid`) → STOP/START consent ledger → YES confirms nearest appointment → `findOrCreateCustomer` → record interaction → rate-limited `classifySms` → if lead: stage `create_lead` + drafted `send_sms` reply | `pending_actions` |
| Inbound email (Aurinko/Gmail) | LIVE (Gmail connect founder-verified 2026-09-02) | `api/aurinko/webhook/route.ts`: validation-ping echo → signature → shop by account → fetch message → interaction → rate-limited `classifyEmail` → propose lead + best-effort `draftEmailReply` | `pending_actions`. **Does not claim `provider_events`** (dedupe follow-up open). |
| Inbound call (Vapi) | BUILT — NEEDS VERIFICATION (never a real call) | `api/vapi/webhook/route.ts`: shop by assistant → per-shop secret → `function-call`/`tool-calls` dispatch to 8 tools; `end-of-call-report` claims `provider_events` (`call.id`), persists `call_records` + transcript turns, meters minutes | `captureLead` writes lead/customer and may stage `book_appointment` (`vapi-tools.ts:168–318`; verify the exact write path on a real call) |
| Manual (owner) | LIVE | `AddLeadDialog` → `actions/leads.ts::createLead` **stages a `create_lead` approval**; pipeline quick-add `quickCreateLead` writes `leads` directly | mixed |
| Whisper (voice memo) | LIVE (needs device check) | `/api/whisper/process`: OpenAI transcription → `streamOwnerAgent` → `create_lead` tool | direct/staged per tool |
| MCP (`/api/mcp`) | BUILT — NEEDS VERIFICATION | `propose_lead`, `find_or_create_customer`, `record_interaction`, `propose_booking/sms/email` … 12 tools, hashed token, 5,000/day cap | stages |
| Imports | BUILT — NEEDS VERIFICATION | recovery pipeline (§13) | `customers`/`vehicles`, `leads` with `stage` via `mapStageValue` |
| Website form | ROADMAP (B-06) | no endpoint; `grep "web.?form"` finds only A2P sample copy | — |
| Meta lead ads | ROADMAP (B-07) | no code | — |
| Jobber | BUILT — NEEDS VERIFICATION / DECISION REQUIRED (A-13) | outbound push only (`pushLeadToCrm`, `pushBookingToCrm`) | — |

**Normalisation** is limited to phone/email keys (`customers.ts`, `recovery/dedupe.ts`). Lead creation **emits no event** (G-01), so only SMS-originated leads get agent follow-through today.

---

## 16. Pipeline

- **Stages (LIVE, code-moved):** `new → needs_quote → quote_sent → follow_up → booked | lost` (`pipeline.ts::PIPELINE_STAGES`), timers `new 5 min · needs_quote 8 h · quote_sent 2 d · follow_up 4 d` set `next_action_at`; cards turn amber/red past it. `stage_history` jsonb with `by: owner|system`. Lost reasons `price|timing|no_response|competitor|other`.
- **Auto-moves:** agent lead → `new`; quote sent → `quote_sent`; timer → `follow_up`; booking approved → `booked`. Legacy `status` still written (dual truth, B-11).
- **Board:** `PipelineBoard` on `/customers?tab=pipeline` — six columns on `lg+`, a scrollable table below that; HTML5 drag between columns (`setLeadStage`), quick-create, lead detail in a `Sheet` (`getLeadDetail`, `addLeadNote`). 30 cards/column cap with truthful totals (PERF-001).
- **Not present:** stage customisation, ownership/assignee, queues, SLAs beyond the fixed timers, an agent tool to move stages (G-03), a dedicated nav destination (U-02; B-14).
- **Verified by:** `eval/pipeline.test.ts` (unit); rendered board not walked this session.

---

## 17. Conversations, notes, calls, email, SMS, quotes, appointments, jobs, follow-up history

- **Interactions (LIVE):** `interactions` rows per channel (`voice|sms|email|web|note`), role (`customer|gradia|system`), embedded for memory search (`memory.ts`, `match_customer_memory`). Timeline on customer detail; `/conversations` renders threads read-only (`conversation-threads.tsx`, **no composer — U-07/B-12**); "Ask Gradia" (`BiChat`) is mounted on the same page (U-04).
- **Notes:** `add_note` pending action (HITL) and `addLeadNote` (direct). Whisper `add_note` intent.
- **Call records (LIVE in code):** `call_records` + `/calls/[callId]` (transcript turns, staged actions, outcome). Glass-box capture (`action_decisions` "because" lines).
- **Email:** inbound as §15; outbound only as `send_email` pending actions executed via `aurinko.ts::sendEmailMessage` **as the shop's Gmail**. No Gradia-owned transactional sender (B-20). No in-thread reply from the inbox.
- **SMS:** outbound only via `send_sms` pending actions (`executeSendSms` → `smsGateForShop` → `twilio.ts::sendOutboundSms` on the shop's subaccount/BYO number) guarded by `send-policy.ts`; `sendOperatorSms` is the owner's direct quick-reply from the customer page (warn-but-allow to opted-out, D-041). Delivery status callback `api/twilio/sms/status` (P0-008).
- **Quotes (LIVE):** `QuoteBuilder` at `/customers/quotes/new` and `quotes-list.tsx`; line items priced through `service-pricing.ts` (size class, condition multipliers, ranges); `sendQuote` stages `send_sms`/`send_email` with the public link; `/q/[token]` (uuid token, no expiry regeneration) stamps viewed, enforces `valid_until` server-side, accept/decline is replay-safe and rate-limited (P0-009); accept stages `book_appointment` reusing the quote's lead; quote closes to `booked` only after durable appointment persistence. Statuses `draft|sent|viewed|accepted|declined|expired|booked`. Agent-proposed quotes are `create_quote` approvals that create a **draft** only.
- **Appointments (LIVE):** all time-range writes go through `appointment-write.ts` → `write_appointment_serialized`. Booking, reschedule, cancel, block-time. `aurinko_event_id` written when a calendar is connected (external coupling, G-06); sync failure **after** persistence is recorded in `calendar_sync` metadata, never orphaned.
- **Jobs (SUPERSEDED by D-067, code still ships):** `jobs.ts` status machine (`booked→confirmed→checked_in→in_progress→on_hold→completed→paid→closed`), `actions/jobs.ts` (`setJobStatus`, `setJobPaymentStatus` manual toggle, `updateJobLogistics`, `rescheduleJob`, `blockTime`, `uploadJobPhoto` to the photos bucket), `JobCardSheet` on the calendar. The founder cut jobs/work orders/checklists from scope on 2026-09-03; nothing has been removed or flag-hidden yet (B-14 says "everything in §2 flag-hidden, not deleted").
- **Follow-up history:** `pending_actions.resolution` (`approved_unedited|approved_edited|rejected|auto`, `trust.ts`), `action_decisions`, `custom_agent_runs`, `automation_runs`, and the activity feed (`data/activity.ts`) reading all four.

---

## 18. Calendar, availability, capacity, assignment, handoff

- **Calendar (LIVE, week only):** `/calendar` → `CalendarWeekView` (`loadCalendarWeek`), drag-to-reschedule with a P0-004 busy-slot warning that asks for a recorded reason. No month view.
- **Availability (BUILT, dormant):** `availability.ts` (1,050 lines) is the single conflict algorithm: appointment overlap, external calendar leg (Aurinko, advisory), **working hours and daily capacity** (`hoursAndCapacityConflicts` — capacity = workable minutes per day from `settings.calendar.working_hours`, not bays/staff), D-015 hard-block for automatic context, D-016 documented override for HITL. `checkAvailability` runs on every booking/reschedule/block path **only when `FEATURES.conflictEnforcement` is true**; the RPC's in-lock overlap refusal is likewise gated. **Production flag is OFF → double-booking is possible today** (B-09). Locking and idempotency apply regardless of the flag (integration-locked). Note from Q-26: `availability.ts` reads no service data; the default reservation is `DEFAULT_DURATION_MINUTES = 90`.
- **Working hours (LIVE):** `working-hours.ts`, Settings card + onboarding step 3, `capacityMinutesFor`.
- **Assignment / handoff / staff capacity / bays / locations:** ROADMAP — no columns, no code (`grep assign|capacity|handoff` hits only the availability capacity kind and the A-06 escalation note). A-06 "escalation / human handoff when the agent is out of depth" is unbuilt.
- **Reminders and no-show ladder (BUILT — NEEDS VERIFICATION):** crons `reminders` (hourly) and `no-show-ladder` (hourly :15) stage HITL confirm/reminder texts; YES on inbound SMS confirms (`confirmed_at`), idempotent via `confirm_pending_action_id`.

---

## 19. Gradia Agent — capabilities and exact executable actions

**Executable action types (the only things that ever change the outside world), `PendingActionType`:** `create_lead` · `add_note` · `book_appointment` · `reschedule_appointment` · `cancel_appointment` · `send_sms` · `send_email` · `create_quote`. Executors live in `approvals.ts::executeApproval` (lines 475–530 dispatch; edit-path dispatch at 2051–2104). `ALWAYS_HITL` = `book_appointment`, `reschedule_appointment`, `cancel_appointment`, `create_quote` — never auto-executed in any mode (`eval/guardrails.test.ts`).

**Surfaces that stage those actions:**

| Surface | Tools / recipes | Status |
|---|---|---|
| Owner agent (`owner-agent.ts::streamOwnerAgent`, `/api/agent/chat`, `⌘K` command bar, mobile composer, Whisper) | 7 write-ish tools: `preview_outreach`, `stage_outreach`, `draft_reply`, `add_note`, `create_lead`, `propose_booking`, `update_customer` + 14 read-only BI tools (`bi-tools.ts`: `count_leads`, `recent_leads`, `customer_count`, `channel_volume`, `upcoming_appointments`, `find_person`, `search_memory`, `search_knowledge`, `revenue_in_window`, `top_heat_leads`, `check_setup_status`, `recommend_next_setup`, `link_to_setup`, `cold_leads`). Source-scan test proves no send call in the module. | LIVE (chat), advisory by design (G-04) |
| Voice agent (`vapi.ts` tool defs, `vapi-tools.ts` handlers) | `capture_lead`, `propose_booking`, `quote_service`, `propose_quote`, `lookup_customer_history`, `lookup_shop_policy`, `reschedule_appointment`, `cancel_appointment` — a genuine multi-turn loop; the reference implementation per `CONTEXT.md` §4f | BUILT — NEEDS VERIFICATION |
| Runtime recipes (`agent-runtime.ts`, cron `agents` hourly) | `lead_followup_sms`, `appointment_reminder_email`, `appointment_reminder_sms`, `stale_customer_sms`, `payment_received_thank_you_sms`, `booking_approved_prep_email`, `review_request_sms`, `review_request_email`; plus `freeform` audience plans (`agent-planner.ts`, ≤200 recipients, cooldown, opt-out, dry-run preview). Self-serve builder UI is flag-hidden (`workflowBuilder: false`). | BUILT — NEEDS VERIFICATION |
| Automations catalog (`automations.ts`, cron `automations` every 5 min) | `new_lead_instant`, `missed_call_textback`, `quote_followup`, `lead_revival`, `appt_confirmation`, `appt_reminder`, `job_completed`, `review_request`; mode `approval|autopilot`; none touches money/calendar | BUILT — NEEDS VERIFICATION |
| SMS drafter / email drafter | one classify + one drafted reply per inbound; **no conversation state** (G-02) | LIVE (SMS blocked by A2P in prod) |
| MCP server | 12 tools (§15) | BUILT — NEEDS VERIFICATION |

**Modes:** `autonomy.ts`: per-shop default + per-agent override, `suggest` unless `hasPackage2(shop)`; earned-autonomy recommendations from `trust.ts` (≥15 decisions, ≥90 % unedited, 90-day window). Shadow mode: `shops.simulation_mode` (computes/logs, stages nothing). Every agent action writes: `pending_actions` (+`resolution`), `action_decisions`, `interactions`, `custom_agent_runs` — the "4-layer audit trail".

**Gaps (all in `CONTEXT.md` §4f/§4g):** no event on lead creation (G-01), no SMS conversation loop (G-02), no stage-move tool (G-03), no completing tools for non-floor actions (G-04), D-068 ladder not implemented (B-17), no named agent roster (B-18), no escalation to a human (A-06).

---

## 20. Gradia Whisper

- **What it is in code:** tap-to-talk voice memos from the owner. `use-whisper-recorder.ts` → `POST /api/whisper/process` (paywall-gated, metered) → `whisper.ts::transcribeAudio` (OpenAI) → the transcript is routed through `streamOwnerAgent` (same tools as the command bar). `parseWhisperIntent` (2 intents `create_lead|add_note`, structured output) also exists. Actions: `whisperDraftReply`, `whisperCustomerSummary` (`whisper-summary.ts` builds facts, deterministic fallback summary).
- **Suggestion sweep:** `whisper-suggestion-sweep.ts` (run inside the `automations` cron) stages `pending_actions` with `payload.source = "whisper_suggestion"` for stale quotes, follow-ups due and revival leads (`whisper-suggestions.ts` pickers, deduped). After B-03 these render as ordinary cards in the Chief of Staff needs-you queue; the dedicated `WhisperSuggestionQueue` rail is unmounted but its file remains.
- **Status:** BUILT — NEEDS VERIFICATION on a real phone (GO_LIVE_CHECKLIST NOW-2 smoke steps were never recorded as run). No vision/multimodal (cut, D-067).

---

## 21. Approval Mode — behaviour and routing

- **Behaviour (LIVE, integration-tested):** a `pending_actions` row is claimed atomically (`status pending → approved` with `.eq("shop_id")`), executed, and on executor failure rolled back to `pending` with no partial writes; a second approve returns `already_decided`; edit-then-approve (`updatePendingProposal`, `approveWithEdits`) re-validates the payload against the claimed shop; reject and undo-reject; conflict override requires a reason and records audit evidence; `send_sms` executor applies quiet hours / STOP / marketing consent and **holds** (stays staged) when unsafe.
- **Where approvals appear:** Chief of Staff needs-you queue and `/approvals` (same `ApprovalsList`, same server actions `approveFromDashboard`, `approveWithConflictOverride`, `rejectFromDashboard`, `undoRejectFromDashboard`). 12-card pages with "Show N more".
- **Routing:** everything routes to the single owner. Slack approvals were deleted (CLEANUP-001, D-052). **No notification of any kind exists** (`grep -riE "web.?push|notifyOwner|owner.?notif|daily.?digest" src/` = 0) — B-20, v1 ship gate. Approval-by-role, delegation and escalation do not exist (no roles).
- **Verified by:** `eval/integration/approvals.int.test.ts`, `conflict-enforcement.int.test.ts`, `booking-atomicity.int.test.ts` (117 integration tests green 2026-09-08).

---

## 22. Chief of Staff dashboard

- **Status:** PARTIALLY BUILT (B-03 first half merged in PR #39; founder acceptance walk not recorded).
- **What renders** (`src/app/(dashboard)/dashboard/page.tsx`): `DashboardHero` (shop name, live-channel count from `connectionStatus()`, `AddLeadDialog`), `KpiRow` (7-day series from `interactions`/`leads`/`appointments`), the needs-you queue (`listOpenApprovalsForCurrentShop` → `ApprovalsList`, uncapped), the activity stream (`listActivityFeed` over `pending_actions`, `call_records`, `custom_agent_runs`, `action_decisions`, 40 items). This answers "what happened / what Gradia handled / what needs you" in one page.
- **Still open from B-03:** six superseded component files remain in the repo unmounted (`welcome-modal.tsx`, `whisper-suggestion-queue.tsx`, `booked-today.tsx`, `whisper-button.tsx`, `ai-lead-section.tsx`, `channel-connection-card.tsx`) plus an `ai-lead-section` line in `eval/cleanup-001-removal.test.ts`; unused money loaders (`revenue.ts`, `roi-receipt.ts`, `today-money.ts`) kept because a perf test exercises one. `/approvals` and `/activity` still exist as nav destinations (B-14). The internal name "Chief of Staff" is banned from **marketing** copy (it is "Home" there); inside the product code it is the B-03 name.
- **Command bar:** `command-bar.tsx` is mounted app-wide and **already binds ⌘K/Ctrl-K** (`onKey` at line 51). `CONTEXT.md` §4e U-09 ("No ⌘K … no keyboard binding was found") is **wrong as written**; B-04's remaining work is persistence on Chief of Staff, write tools through the approval executor, and removing the duplicate `BiChat` mount on `/conversations`.

---

## 23. Integration inventory

| Integration | Status | Evidence | Notes |
|---|---|---|---|
| Supabase (DB/Auth/Storage/pgvector) | LIVE | everything | — |
| Anthropic Claude | LIVE | `ai-service.ts`, classifiers, drafters, planner, BI | Haiku workers, Sonnet for planning/BI per principle #7; eval harness gates prompt changes (live evals not run this session) |
| OpenAI (embeddings + transcription) | LIVE | `embeddings.ts`, `whisper.ts` | model change requires a migration (dims baked in) |
| Twilio SMS inbound/outbound, status callbacks, number search/purchase, subaccounts | BUILT — NEEDS VERIFICATION (outbound blocked in prod) | `twilio.ts`, `telephony-provider.ts`, `api/twilio/*`, `actions/twilio-provision.ts` | Signature verification + replay claims are unit/integration-tested; **no A2P Brand/Campaign exists** (founder, `CONTEXT.md` §7) so no shop can send SMS in production |
| Twilio A2P 10DLC registration (Trust Hub) | BUILT — NEEDS VERIFICATION | `twilio-a2p.ts`, `a2p-schema.ts`, `a2p-wizard.tsx`, `api/twilio/a2p/status` | "policy SIDs unverified live" (`blocked.md`); per-shop fees/timelines unknown (A-02) |
| Vapi voice receptionist (assistant compose/sync, number attach, test call, webhook, minutes metering) | BUILT — NEEDS VERIFICATION | `vapi.ts`, `voice-provider.ts`, `vapi-tools.ts`, `vapi-prompt.ts`, `api/vapi/webhook`, `cron/voice-sync` | **Never verified on a real inbound call** — not claimable (guardrail 6) |
| Aurinko — Gmail (OAuth, subscription, inbound webhook, send) | LIVE | `aurinko.ts`, `api/aurinko/*` | Connect founder-verified 2026-09-02 after PR #34 (validation-ping fix); Preview redirect fixed in PR #40 |
| Aurinko — Google Calendar (list/create/update/delete events) | BUILT — NEEDS VERIFICATION | `aurinko.ts` calendar fns, `approvals.ts` booking executor, `availability.ts` external leg | Booking writes events when connected; external-calendar coupling is the recorded top operational risk (G-06); native calendar is designed (E02) not built |
| Stripe — platform subscription + credits + packs (`/billing`, webhook) | LIVE with a **deliberate production exception** | `stripe.ts`, `api/stripe/webhook`, `credits.ts`, `entitlements.ts`, `pricing.ts` | Paywall flag on; `STRIPE_PRICE_*` absent in prod → checkout fails closed; code still encodes the superseded $20/$29 model (`PLAN.CORE_PRICE_CENTS = 2000`, `VOICE_PRICE_CENTS = 2900`); the $99/$149/$249 three-tier model is PR #38 (conflicting). Webhook signature-verified; **no `provider_events` claim** (per-instance dedupe only) |
| Stripe Connect (charging the shop's customers) | SUPERSEDED (D-067: payments never) | `actions/stripe-connect.ts`, `api/stripe/connect/*`, `stripe-embedded-onboarding.tsx` | `FEATURES.integrations.payments = false`; routes 404 via `proxy.ts` |
| Jobber (OAuth, push lead/booking as Request) | BUILT — NEEDS VERIFICATION → **DECISION REQUIRED** (A-13: verify or delete) | `jobber.ts`, `jobber-push.ts`, `crm-provider.ts`, Settings tile | Never verified live; same category as the deleted Housecall Pro connector |
| Housecall Pro, Slack approvals/alerts | SUPERSEDED (removed 2026-09-01, CLEANUP-001) | dormant columns only | Six env vars still to be removed from Vercel (founder) |
| Meta — lead ads, Messenger/Instagram DMs | ROADMAP (lead ads, B-07) / SUPERSEDED (DMs, D-067) | **no code in `src/`**; migrations `20260519130000_shop_instagram`, `20260520100000/210000_send_*_dm_action` are historical; `META_*` in `.env.example` are dead | Direct live ingestion: **does not exist**. Nothing in the UI references Meta except onboarding copy in `CONTEXT.md`. Meta Business Verification + App Review for `leads_retrieval` is a founder-only prerequisite (§7) |
| Sentry | BUILT — NEEDS VERIFICATION | `instrumentation*.ts`, `next.config.ts` | DSN presence in prod unknown (config audit); five alert rules to click through (backlog) |
| Ops alerts seam (webhook + SMS) | BUILT — NEEDS VERIFICATION | `alerts.ts`, `api/admin/alert-test`, `/api/health` | destination not configured → fail-open to console + Sentry |
| MCP server | BUILT — NEEDS VERIFICATION | `lib/mcp/*`, `api/mcp`, Settings → Developer tokens card | — |

---

## 24. Error handling, retries, idempotency, collision prevention, audit, rollback

- **Webhooks:** verify signature → claim `provider_events` (Twilio inbound, Vapi end-of-call) → process → complete/fail; DB failure on claim → 5xx so the provider retries; stale claims reclaimable after the route's `maxDuration`. Aurinko and Stripe webhooks verify signatures but **do not claim** (documented follow-ups). Pruning cron keeps `completed` 30 d / `failed` 90 d / floor 7 d (founder ratification pending).
- **Bookings:** advisory lock + in-lock overlap check + `pending_action_id` unique; replay returns `exists`. Persistence-first ordering: external calendar event creation happens after the row is durable, failure recorded, never orphaned.
- **Approvals:** claim/rollback as §21. Known narrow window (P0-009 M-1): quote `accepted` flip and the `pending_actions` insert are not atomic.
- **Metering:** `usage_events` unique on `vendor_ref`; `recordUsage` returns `written|duplicate|failed`; credits fail closed at `credit_limit`.
- **Rate limits:** `rate_limits` table, buckets in `rate-limit.ts` (inbound classify ceilings, quote response, data export, LLM action 20/60 s, MCP 5,000/day).
- **Crons:** `runCron()` wraps all nine with heartbeats; `CRON_SECRET` fail-closed; `/api/health` reports `ok|degraded|down` (503 on down). Lifecycle derivation has no cron (§13).
- **Audit:** `pending_actions` (+`resolution`, decider), `action_decisions`, `interactions`, `custom_agent_runs`, `automation_runs`, `call_records`, `provider_events`, `cron_heartbeats`. No general-purpose audit log table for owner CRUD (e.g. a customer edit or merge is not journaled beyond `interactions` where the code chooses to record one).
- **Rollback:** executor-level only. Two SQL down-scripts exist and are unapplied. No application-level "undo" for executed sends; undo exists for **rejections** (`undoRejectFromDashboard`) and appointments can be rescheduled/cancelled via HITL.
- **Transactions:** none in application code (Supabase JS); multi-table invariants are enforced by RPCs or by ordering.

---

## 25. Existing tests and important coverage gaps

- **Unit (74 files / 779 tests):** guardrails (HITL floor, autonomy resolution, no-send source scans), webhook signatures (76 tests), availability (56), conflict enforcement (27), quote response (22), structured CSV import (21), service pricing (17 + 7 on PR #42), credits/pricing/entitlements, tenant scoping and service-role inventory, connection truth, onboarding resume logic, working hours, send policy, agent audience, trust, no-show ladder, provider-event pruning, perf-001 query-shape locks, export, request-origin, repo hygiene, honest errors, production surfaces.
- **Integration (13 files / 117 tests, real Postgres):** approvals atomic claim/rollback/idempotency, booking atomicity + TOCTOU + cross-tenant, conflict enforcement with the flag on and off, availability, ledger RLS, provider-events claims and pruning, cron heartbeats, quote acceptance.
- **Live evals (7 files, not run):** extraction, classification, BI exactness + tone judge, owner-agent routing (one known failure), review-request, recovery extraction.
- **Gaps:** no browser/E2E tests at all; no component/render tests (every UI claim in this doc is "not walked"); Aurinko end-to-end (only the route's signature/ping behaviour is tested); Vapi tool handlers against a real call; Twilio A2P flows; Stripe checkout end-to-end; Jobber; recovery import against real files; responsive layouts; `lifecycle.ts` wiring (there is none); the D-068 ladder (tests still encode the old category rule and must be **rewritten**, not deleted, when B-17 lands).

---

## 26. Known bugs, dead buttons, unfinished pages, mock data, placeholders, hardcoded values

- **DECISION REQUIRED — booking duration when vehicle size is unknown:** `vapi-tools.ts::lookupServiceDuration` (line 221) writes the flat `duration_minutes` into `book_appointment`; with per-size durations and an unknown vehicle, the shortest under-books and the longest wastes the bay. PR #42 fixes the *spoken* surfaces only. Also no make/model → size inference exists.
- **Double-booking possible in production** (conflict flag OFF) — B-09.
- **PR #38 conflicts with `main`;** the `20260903120000` migration in it is already applied to the local dev DB.
- **B-19 ticket-number collision** (phone continuity in `CONTEXT.md` vs draft/edit delta capture on `docs/idea-review-2026-09-04`).
- **Onboarding OAuth return step:** `api/aurinko/auth/start` comments and the inbox step link say `?step=5` after B-16 while the inbox step is step 4 in the six-step wizard — read `onboarding-launch-steps.tsx` before touching; verify on Preview where the owner lands after connecting Gmail.
- **Middleware protected-prefix list is stale** (§9) — harmless today because the layout guards, but a new top-level authenticated route outside `(dashboard)` would rely on it.
- **Unified inbox has no reply composer** (`conversation-threads.tsx`) — B-12.
- **Settings has 13 sections** including a "More" (`id="soon"`) section and an out-of-scope "Payments" section (Connect, flag-hidden) — A-14; "NOT AVAILABLE" honest states replaced "Coming soon" in UX-001 but some approval-executor toast copy still says "Connect Gmail via Aurinko".
- **Six orphaned components + three unused money loaders** from B-03 (§22).
- **Jobs UI ships despite D-067** (§17) — not yet flag-hidden.
- **Hardcoded prices:** `pricing.ts` `PLAN.CORE_PRICE_CENTS = 2000`, `VOICE_PRICE_CENTS = 2900` (superseded model); `DEFAULT_PRICING` table for unit costs; `availability.ts` `DEFAULT_DURATION_MINUTES = 90`; pipeline timers; lifecycle 180/365 days; `MAX_CANDIDATES = 500`, recipient cap 200, `MCP_DAILY_REQUEST_CAP = 5000`; export cap 10,000 rows with silent truncation.
- **Demo/sample data:** only via `seed:smoke` with explicit markers and a "Clear demo data" card; `simulation_mode` is a real shadow-mode feature, not mock data. **Zero `TODO`/`FIXME`** in `src/` (verified).
- **Stale docs:** `README.md` is the create-next-app boilerplate; `GO_LIVE_CHECKLIST.md` (July), `GRADIA_AGENT_HANDOFF.md` (July), `docs/project-status.md` (May, banner-marked), `PLAN.md`, `*_PLAN.md`, `program/current-sprint.md` etc. are all superseded by `CONTEXT.md` §9. `docs/env-setup.md` banner is stale (§5). `program/capability-status.md` last reconciled 2026-09-02 and does not yet reflect B-01/B-03/B-00/B-16.

---

## 27. Security and privacy concerns

- **P0-001 exposed database credential:** password rotated 2026-07-29 with no live exposure; **git history not scrubbed** (D-038, rotate-only); the remediation ticket was never merged. `git add .`/`-A` stay denied because that is how it reached history.
- **Service-role tenancy is discipline, not mechanism:** 4 `forShop()` sites vs 323 raw queries in `src/lib` (§12). Recommended: two-shop red-team acceptance run (Q-26 #3) before paying customers.
- **Secrets at rest:** AES-256-GCM via `crypto.ts` with a single `ENCRYPTION_KEY`; rotation is manual and losing it forces every shop to reconnect. `vapi_server_secret_enc` per shop; legacy assistants fall back to the global secret.
- **Alert delivery unconfigured:** `TENANT_SCOPE_VIOLATION` and cron failures reach console + Sentry only until the founder sets `OPS_ALERT_WEBHOOK_URL` (backlog Band 2 #1).
- **Production env presence UNKNOWN for most vars** (PROD-CONFIG-AUDIT; Vercel CLI not logged in). Six dead vars (HCP/Slack) still to remove.
- **Quote public tokens** are `gen_random_uuid()` with no expiry/regeneration (deferred).
- **Stripe webhook dedupe is per-instance** (ops noise, not a money bug).
- **No ToS / privacy policy / DPA** (A-11), **no tested backup/restore posture** (A-12), **no support channel** (A-10).
- **TCPA:** consent capture at the form boundary does not exist because no form intake exists (A-05); the send-side gates do.
- **Export** hands the whole tenant's data to any owner session (intended) — rate-limited, no audit row of who exported.

---

## 28. Performance concerns

PERF-001 (PR #36, measured locally on a 600-customer seed): Home 81 → 43 queries/request, auth round-trips 21 → 1, HTML 2 MB → 338 KB, mobile Lighthouse 0.45 → 0.77; Approvals paged. Preview re-measurement was never done (Vercel CLI). Open residuals: `getCrmCleanupState` reads every customer + vehicle on each `/customers` render; shared JS shell 432–477 KB gzip on every route (sidebar + command bar + framer + Radix), no per-component culprit identified; Approve interaction 190 ms at 4× CPU (framer `AnimatePresence` exit + toast); `leads` fetched several times per Home render across loaders (some now unused after B-03); no request-end timing hook. No caching layer, queue or outbox exists (deliberately; E10).

---

## 29. UI and usability problems

From the founder's 2026-09-03 audits (`CONTEXT.md` §4d/§4e), with current status:

- U-01 Home was 14 stacked components → **mostly fixed** by B-03 (page rewritten; file cleanup half done).
- U-02 `/customers` is three products (pipeline, customers, quotes as tabs on one route) → open (B-14).
- U-03 six "recent things" surfaces and no "start here" → **partially fixed** (Chief of Staff exists; `/approvals`, `/activity` still in nav).
- U-04 Ask Gradia bolted onto Conversations → open (B-04).
- U-05 nav is 9 items; `Numbers & Billing` mixes setup and account → open (B-14).
- U-06 duplicate `CrmCleanupCard` → **fixed** (Customers only).
- U-07 inbox cannot reply → open (B-12) — "the worst flow in the product".
- U-08 detail records are full-page → partially (pipeline uses a `Sheet`; customers/approvals do not).
- U-09 no ⌘K → **finding was incorrect**; binding exists (§22).
- U-11 the visual system is current (160 tokens, Geist); do not restyle — fix structure.
- A-07 Chief of Staff one-handed on a phone → unverified.

---

## 30. Desktop and mobile responsiveness

Responsive layouts exist (`use-mobile.ts`, `MobileComposer`, collapsible sidebar, `overflow-x-auto` tables, pipeline switches from a 6-column grid to a scrollable table below `lg`, customers table min-width columns). Local mobile Lighthouse on Home is 0.77 (PERF-001). **Nothing has been verified on a real phone** this cycle; the calendar week view and the onboarding wizard's `ServiceMenuCard` on narrow screens are the likeliest problem areas. Status: BUILT — NEEDS VERIFICATION. Installable/offline PWA is out of scope (D-067).

---

## 31. Roadmap — completed, active, remaining (mirrors `CONTEXT.md` §4 as of 2026-09-08)

**Completed (merged to `main`):** P0-002…P0-012 hardening chain (CI gates, idempotency, tenancy, env, quote acceptance, alerts), PROD-CONFIG-AUDIT, P0-005A, CLEANUP-001, UX-001, PERF-001, **B-01** data export (#37), **B-00** Preview auth redirect (#40), **B-03 first half** Chief of Staff (#39), **B-16 first half** onboarding services/pricing + hours (#41).

**Active / awaiting founder:** **PR #42** duration range (acceptance walk); **PR #38 / B-02** three-tier billing (rebase + Stripe live prices + acceptance); founder-only §7 items — register Gradia's own A2P Brand + Campaign, **voice acceptance run on a real call**, Meta Business Verification + App Review, Stripe live prices, merge PRs daily; the uncommitted D-069 edit to `CONTEXT.md`.

**Remaining, in the founder's order:** B-19 phone number continuity (v1 gate) → B-20 owner notification + Gradia-owned transactional sender (v1 gate) → B-02 → B-03 remainder → B-04 command bar write tools → B-05 intake seam → B-06 existing channels into it → B-07 Meta lead ads (blocked on App Review; out of v1) → B-08 instant response (a–d: lead event, SMS loop, stage-move tool, completing tools) → **B-09 conflict enforcement ON (v1 gate)** → B-10 book from SMS → B-11 CRM holes → B-15b A2P data in onboarding → B-16 second half → B-12 inbox reply → B-13 CSV import → B-14 nav cut → B-15 design pass → B-17 autonomy ladder (D-068) → B-18 named agents. Plus adoption blockers A-01…A-16 and Q-26 dispositions (decision-gated).

**D-069 v1 ship gate:** (1) voice acceptance run — not done; (2) B-19 — 0 code; (3) B-20 — 0 code; (4) B-16 — first half merged; (5) B-09 — flag OFF; (6) zero-founder-touch setup + real call — not demonstrated.

---

## 32. Recommended next five engineering priorities (with code evidence)

1. **B-19 — conditional call forwarding + verification step.** `grep -riE "call.?forward|hosted.?number" src/` → 0 matches; the voice product cannot be sold to a shop that keeps its number. Smallest v1 gate with the highest sales value. Touches `voice-provider.ts`, `telephony-provider.ts`, Settings → Voice, onboarding step 6.
2. **B-20 — owner notification on a pending approval, with a Gradia-owned transactional sender.** `grep -riE "web.?push|notifyOwner|owner.?notif|daily.?digest" src/` → 0; the only outbound email is `aurinko.ts::sendEmailMessage` sent *as the shop* on approval (circular). Needs a new vendor seam (e.g. transactional email), per-shop on/off, quiet hours, one daily digest; hook at the `pending_actions` insert sites (there are many — consider a single `stagePendingAction()` helper first, which also serves B-05).
3. **B-09 — conflict enforcement ON.** `FEATURES.conflictEnforcement` reads `NEXT_PUBLIC_GRADIA_CONFLICT_ENFORCEMENT`, OFF in Production; the integration suite already proves both flag states (`"flag OFF → overlap NOT refused"`). Work = founder walk on a flag-on Preview (P0-004 steps 1–7), flip, redeploy. While there, resolve the duration decision (§26) so what gets reserved is honest.
4. **B-05/B-06 + B-08a — one lead-intake seam that emits an event.** `quickCreateLead`/`createLead`/`captureLead`/Aurinko/import each write differently and fire nothing (G-01); `agent-events.ts` only knows `payment_received` and `booking_approved`. Without this the "new lead → qualify → book" promise only works for inbound SMS, and SMS is out of v1. Build the seam before B-07 so Meta lands inside it.
5. **Tenancy mechanism before paying shops — `forShop()` rollout + two-shop red team.** 4 sites vs 323 raw queries in `src/lib`; ADR-003 enumerates migration batches TS-1…TS-6; Q-26 #3 specifies the red-team run. Cheapest insurance against the one failure that ends the company.

Not on this list but blocking revenue: rebase **PR #38** (billing) once the founder creates live prices, and the **voice acceptance run** (founder-only, no engineering).

---

## 33. Exact files to inspect first

1. `CONTEXT.md` — scope, v1, build order, guardrails, session rules. Read it fully.
2. `.claude/settings.json` and `.git/hooks/pre-push` — what an agent may and may not run.
3. `src/lib/approvals.ts` — the execution spine; `src/lib/autonomy.ts`, `src/lib/trust.ts`, `src/lib/send-policy.ts` — the floors.
4. `src/lib/types/database.ts` and `supabase/migrations/20260708120000_crm_foundation_c1.sql` — the data model.
5. `src/lib/shop.ts`, `src/lib/supabase/for-shop.ts`, `eval/tenant-scoping.test.ts` — tenancy.
6. `src/lib/appointment-write.ts`, `src/lib/availability.ts`, `supabase/migrations/20260811120000_booking_atomicity.sql` — booking safety.
7. `src/lib/provider-events.ts`, `src/app/api/twilio/sms/route.ts`, `src/app/api/vapi/webhook/route.ts`, `src/app/api/aurinko/webhook/route.ts` — inbound channels.
8. `src/lib/agent-runtime.ts`, `src/lib/owner-agent.ts`, `src/lib/vapi-tools.ts`, `src/lib/agent-planner.ts`, `src/lib/automations.ts` — the agent surfaces.
9. `src/lib/features.ts`, `src/proxy.ts`, `src/app/(dashboard)/layout.tsx` — gates.
10. `src/app/(dashboard)/dashboard/page.tsx`, `src/components/gradia/approvals-list.tsx`, `src/components/gradia/onboarding-wizard.tsx`, `src/lib/onboarding.ts` — the two screens the v1 gates care about.
11. `eval/README.md`, `eval/guardrails.test.ts`, `eval/integration/_db.ts`, `.github/workflows/*.yml` — how the gate runs.
12. `docs/gradia-v2/program/autorun-log.md` (session history, most recent last), `docs/gradia-v2/11-decision-log.md`, `docs/gradia-v2/program/backlog.md` Band 2, `docs/gradia-v2/program/decision-queue.md` — why things are the way they are.

---

## 34. Capability matrix

Legend: **LIVE** · **BUILT — NEEDS VERIFICATION (BNV)** · **PARTIALLY BUILT (PB)** · **BROKEN** · **ROADMAP** · **DECISION REQUIRED (DR)** · **SUPERSEDED**. "Verified" states what this session actually did; "tests pass" never means "works on a Preview" (CONTEXT §6 step 7).

| # | Capability | Status |
|---|---|---|
| 1 | Workspace onboarding | BNV |
| 2 | Solo detailer workflow | PB |
| 3 | Staffed shop workflow | ROADMAP |
| 4 | Multiple locations | ROADMAP |
| 5 | Roles and seats | ROADMAP |
| 6 | CRM (as an operational whole) | PB |
| 7 | Customers | LIVE (+ROADMAP gaps) |
| 8 | Vehicles | LIVE data / PB UI |
| 9 | Pipeline | LIVE |
| 10 | Unified inbox | PB (read-only) |
| 11 | SMS | BNV (prod-blocked) |
| 12 | Phone / calls | BNV |
| 13 | Email | LIVE inbound + approved send / PB reply |
| 14 | Forms | ROADMAP |
| 15 | Meta leads | ROADMAP |
| 16 | Quotes | LIVE |
| 17 | Follow-ups | BNV |
| 18 | Booking | LIVE (atomic) / DR (duration) |
| 19 | Calendar | PB (week only, enforcement OFF) |
| 20 | Staff assignment | ROADMAP |
| 21 | Shop capacity | PB (hours-based only) |
| 22 | Jobs | SUPERSEDED (code ships) |
| 23 | Gradia Agent | PB (advisory except voice) |
| 24 | Gradia Whisper | BNV |
| 25 | Approval Mode | LIVE |
| 26 | Chief of Staff dashboard | PB |
| 27 | Reporting | PB |
| 28 | Audit history | LIVE (agent) / PB (owner CRUD) |
| 29 | Retention / reactivation | BNV |
| 30 | Integrations (see §23) | mixed |

### Detail

**1. Workspace onboarding — BNV.** Evidence: `src/app/onboarding/page.tsx`, `components/gradia/onboarding-wizard.tsx`, `onboarding-launch-steps.tsx`, `lib/onboarding.ts`, `actions/onboarding.ts`, `actions/shop.ts` (`settings.onboarding_done:false` at insert). Works: six-step wizard, resume logic, real `ServiceMenuCard` and hours step, Gmail OAuth hop, Twilio number + A2P wizard, voice builder + test call, dashboard gate. Missing: SMS consent copy, A2P status step, Meta, calendar-connect surfacing (B-16 second half); OAuth return-step mismatch to verify (§26). Verified: `eval/onboarding.test.ts` + `working-hours.test.ts` pass; build green; **not walked on Preview** (no founder record either).

**2. Solo detailer workflow — PB.** Evidence: one owner, one shop row is the only model (§10); every screen works for that owner. Works: lead in (SMS/email/voice), pipeline, quote, book, calendar, approvals, export. Missing: owner notification (B-20), inbox reply (B-12), conflict enforcement (B-09), SMS in prod (A2P), voice unverified, no call forwarding (B-19). Verified: tests + build; no end-to-end walk.

**3. Staffed shop workflow — ROADMAP.** Evidence: no members/roles/assignments/handoffs in schema or code (`grep` counts in §10). Works: nothing beyond the owner model. Missing: everything (E01 members, E04 teams). Verified: grep + migration inventory.

**4. Multiple locations — ROADMAP.** Evidence: `shops.location` is a free-text string; `location_id|locations` → 0 hits; D-067 removed "Locations, bays, bookable resources" from scope. Multi-**shop** per owner exists (switcher) — not the same thing.

**5. Roles and seats — ROADMAP.** Evidence: RLS keyed solely on `owner_id`; no `role` column; A-08 lists staff logins as a returning requirement. Verified: schema grep.

**6. CRM (operational whole) — PB.** Evidence: §13. Works: identity spine, list/detail, merge/dedupe, DNC/consent, export, pipeline, quotes, timeline. Missing: add/edit customer form, VIN field, lifecycle cron, simple CSV import, `status`/`stage` dual truth, owner CRUD audit. Verified: unit tests for `customers`, `merge`, `crm-health`, `pipeline`, `export`; screens not walked.

**7. Customers — LIVE.** Evidence: `lib/customers.ts`, `data/customers.ts`, `customers-table.tsx`, `/customers/[id]/page.tsx`, `merge-customers.ts`. Works: find/create by phone/email, list, detail, merge, DNC, quick SMS. Missing: create/edit form (B-11), companies (out of scope). Verified: unit tests; export integration read.

**8. Vehicles — LIVE data / PB UI.** Evidence: `vehicles` table, `lib/vehicles.ts`, `lib/vehicle.ts`, quote builder vehicle picker. Missing: VIN/trim inputs, per-vehicle history view, size inference. Verified: `eval/vehicle.test.ts`, `service-pricing.test.ts`.

**9. Pipeline — LIVE.** Evidence: §16. Missing: customisation, ownership, agent stage-move tool. Verified: `eval/pipeline.test.ts`; board not walked.

**10. Unified inbox — PB.** Evidence: `/conversations/page.tsx` mounts `ConversationThreads` (no composer) + `BiChat`. Works: read threads across channels. Missing: reply (B-12), filters, side panel. Verified: source read.

**11. SMS — BNV, production-blocked.** Evidence: §15/§17 paths; `telephony-provider.ts::smsGateForShop`; `shops.a2p_status`, `byo_sms_verified`. Works in code: inbound with replay safety, consent keywords, drafted replies, HITL send with policy gates, status callbacks, number purchase, subaccounts. Missing: any registered A2P brand/campaign (founder), conversation loop (G-02), book-from-SMS (B-10). Verified: `webhooks.test.ts`, `send-policy.test.ts`, `telephony.test.ts`, integration provider-events; no live Twilio traffic this session.

**12. Phone / calls — BNV.** Evidence: Vapi seam and webhook (§15/§19), `call_records`, `/calls/[callId]`, `cron/voice-sync`, minutes budget. Missing: real-call acceptance, call forwarding/porting (B-19), tool-call replay dedupe (recorded follow-up). Verified: `voice-builder.test.ts`, webhook auth tests; **never on a real call**.

**13. Email — LIVE inbound and approved send / PB reply.** Evidence: §15/§17; founder-verified Gmail connect. Missing: in-thread reply from inbox, Gradia-owned sender, `provider_events` claim on the Aurinko webhook. Verified: Aurinko route tests (ping, signatures); Gmail connect founder-verified 2026-09-02.

**14. Forms — ROADMAP.** Evidence: no route, no component; only A2P sample text mentions "web form". B-06.

**15. Meta leads — ROADMAP.** Evidence: no `src/` code; dead env names; historical DM migrations. UI references: none. Direct live ingestion: **none**. Prerequisite: founder Meta App Review (`leads_retrieval`). B-07 is designed to land inside the B-05 seam.

**16. Quotes — LIVE.** Evidence: §17; P0-009 repair merged. Missing: expired-quote re-quote CTA (Q-04 open), token regeneration, shop-local expiry (L-1). Verified: `quotes.test.ts`, `quote-response.test.ts`, `quote-booking.test.ts`, integration `quote-acceptance.int.test.ts`.

**17. Follow-ups — BNV.** Evidence: pipeline timers, `whisper-suggestion-sweep.ts`, automations `quote_followup`/`lead_revival`, recipe `lead_followup_sms`, no-show ladder, `co-owner.ts` one-click draft. Missing: none of it is verified as a live loop; all HITL-staged; SMS prod-blocked. Verified: `automations.test.ts`, `whisper-suggestions.test.ts`, `no-show-ladder.test.ts`, integration `automation_runs` uniqueness.

**18. Booking — LIVE (atomic) / DR (duration).** Evidence: §17/§18; `write_appointment_serialized`. Works: HITL book/reschedule/cancel with idempotency and locking; quote accept → staged booking; voice `propose_booking`. Decision required: reserved duration when size unknown (§26). Verified: `booking-atomicity.test.ts` + `.int.test.ts` (TOCTOU, replay, cross-tenant).

**19. Calendar — PB.** Evidence: §18. Works: week view, drag reschedule, block time, working hours, hours/capacity advisory conflicts. Missing: enforcement ON, month view, native source of truth (Aurinko coupling). Verified: `availability.test.ts` (56), `conflict-enforcement` unit + int; view not walked.

**20. Staff assignment — ROADMAP.** Evidence: no `assigned_to`/member concept; `grep assign` hits only unrelated text. Blocked on roles (E01).

**21. Shop capacity — PB.** Evidence: `working-hours.ts::capacityMinutesFor` → `availability.ts::hoursAndCapacityConflicts` (`over_capacity`, advisory). Missing: bays/staff/concurrency capacity, any enforcement (flag OFF). Verified: availability unit tests, integration "capacity > 1 preserved" case.

**22. Jobs — SUPERSEDED (D-067) but shipping.** Evidence: `lib/jobs.ts`, `actions/jobs.ts`, `job-card-sheet.tsx`, photos bucket, `payment_status` toggle. Founder cut jobs/work orders/checklists on 2026-09-03; nothing removed or hidden yet (B-14 will flag-hide). Verified: `jobs.test.ts` passes; UI not walked.

**23. Gradia Agent — PB.** Evidence: §19. Works: chat over the shop's data, staging of 8 action types, recipes, automations, MCP. Missing: G-01…G-04, B-17 ladder, B-18 names, A-06 escalation. Verified: guardrail source scans, routing unit tests; **one live eval known failing**; no Preview walk.

**24. Gradia Whisper — BNV.** Evidence: §20. Verified: `whisper-summary.test.ts`, `whisper-suggestions.test.ts`; no device test.

**25. Approval Mode — LIVE.** Evidence: §21. Missing: notification (B-20), role routing (no roles), D-068 tiers. Verified: 117 integration tests incl. approvals/conflicts; needs-you queue render not walked.

**26. Chief of Staff dashboard — PB.** Evidence: §22. Verified: `perf-001.test.ts` locks the 4-surface composition and the 6 deletions; build green; **founder Preview walk not recorded**.

**27. Reporting — PB.** Evidence: `data/kpis.ts` (7-day series), `data/revenue.ts` + `revenue_summary` RPC, `data/roi-receipt.ts` + weekly `roi-receipt` cron (owner SMS, A2P-gated), `margin-report.ts` + `api/admin/margin-report` (founder), `shop_metrics` (CRM specialist metrics), `crm-health.ts`. Works: KPI row on Chief of Staff. Missing: funnel/campaign analytics (out of scope), daily brief, any surface for the revenue/ROI loaders since B-03 unmounted them. Verified: `roi-receipt.test.ts`, `margin-report.test.ts`, `today-money.test.ts`.

**28. Audit history — LIVE for agent actions / PB for owner CRUD.** Evidence: §24. Verified: activity feed loader read; `glass-box-capture.test.ts`.

**29. Retention / reactivation — BNV.** Evidence: `lib/recovery/*` (import → extract → review → win-back with 18-month EBR window and SMS/email channel eligibility), `lifecycle.ts` (unwired), `automations` `lead_revival`, recipe `stale_customer_sms`, `LeadLifecycle` revival funnel on leads, `recovery-retention` cron (30-day purge of import artefacts). Missing: lifecycle cron, a verified import on real files, SMS in prod, memberships/recurring (out of scope). Verified: nine `recovery-*.test.ts` files, `lifecycle.test.ts`, `recovery-retention.test.ts`.

**30. Integrations — see §23.**

---

## 35. Autorun-log entry for this session

Appended to `docs/gradia-v2/program/autorun-log.md` on the `docs/handoff-astra` branch: state check, the lock-file/fast-forward note, the full gate results, PR #42, and this document.

_End of handoff._
