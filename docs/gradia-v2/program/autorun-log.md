# AUTORUN log

_Append-only. One block per ticket. Builder writes plan + result; Reviewer appends verdict; founder appends acceptance/merge. Format below._

```
## <TICKET> — <title>
- Session: <date/time> · Batch: <n> · Branch: <name>
- Plan: (≤10 lines)
- Result: DONE | BLOCKED | STOPPED — commit <hash>
- Validation: unit <n> · int <n> · tsc ✓ · lint ✓ · build ✓
- Residuals: MEDIUM … / LOW …
- Needs founder: …
- Reviewer: (verdict, findings, review-fix commit)
- Founder: (acceptance PASS/FAIL, merged <hash>)
- NEXT: <next queue item>
```

## PROD-CONFIG-AUDIT — Production configuration audit (docs-only)
- Session: 2026-09-01 21:17 PDT · Batch: 1 · Branch: auto/batch-1 (from main `953cdd5`)
- Preconditions checked at session start: PR #29 MERGED (squash `e02c81a`); main carries D-034/D-035 (`11-decision-log.md:87-88`) and D-053; `auto/batch-1` = `origin/main`; stashes unchanged (3); worktree noise only `.playwright-mcp/` + Cursor's uncommitted SITE-READ markers in `SITE_SYNC.md`. Queue item 1 is first — no prior item to close.
- Plan: (1) grep every `process.env` read under `src/` (both forms + dynamic `envHas` + `env.ts` indirection) → 50 names, matches the Organizer sweep; (2) read each site's absent-var behaviour; (3) presence via `vercel env ls production` only if authenticated — CLI not installed, no login attempted → UNKNOWN except recorded facts (P0-010 close, D-034 guard, P0-004 flag); (4) compare against `docs/env-setup.md` + `.env.example` (computed set differences, not eyeballed); (5) write the runbook: method, 50-row table, findings, founder actions + owner tickets; (6) one-line cross-links ×3; (7) D-036/D-048/D-049 ICP amendments ×2; (8) acceptance: grep re-run, disabled states executed with vars absent, secret-shape scan; (9) full gate; (10) one commit, exact files.
- Result: DONE — commit `0043401`
- Files: `docs/gradia-v2/runbooks/production-config-audit.md` (new) · `docs/env-setup.md` · `docs/gradia-v2/runbooks/exposed-credential.md` · `docs/gradia-v2/program/capability-status.md` · `docs/gradia-v2/ui/design-north-star.md` · `docs/gradia-v2/ui/navigation-model.md`. No `src/` changes.
- Validation: unit 660 passed / 4 skipped (65 files) · int 102 passed / 7 skipped (11 files, local Supabase) · tsc ✓ · lint ✓ · build ✓ · doc secret-shape scan 0 hits · table rows 50 = grep inventory (diff identical)
- Manual acceptance: step 1 executed (50/50 rows with file:line); step 2 executed — throwaway vitest file inside `eval/` (never staged, deleted), 6/6 passed: ConnectionTile `available=false` → "Coming soon" + wait line, no Connect; Twilio creds/status-callback → null; Stripe/Aurinko signature verify → false; Supabase public config → throws; conflict flag → OFF; ENCRYPTION_KEY → encrypt throws / decrypt null; step 3 executed (0 hits); step 4 assigned to the Cursor Reviewer (five-row spot-check).
- Residuals: MEDIUM — presence column is UNKNOWN for 40 of 50 names until the founder runs `vercel env ls production` (§4.1); `SLACK_WEBHOOK_URL` reconciliation read must be sequenced between P0-012 and CLEANUP-001 (§3.9); `ENCRYPTION_KEY` absence degrades silently into the shared Twilio master (§3.7 — P0-012 alert + ENV-VALIDATOR). LOW — `env-setup.md` stale banner/flag section/`CREDIT_COST` line (§3.3, next env-docs pass); `GRADIA_DASHBOARD_URL` billing fallback fail-open (§3.8 → P0-013); `VERCEL_ENV` exposure assumption (§3.10, stricter direction).
- Needs founder: (a) **precondition 4 lists `VAPI_DEFAULT_SHOP_ID` as a Production var to set — contradicts P0-007 (fallback refused in prod), P0-010 (confirmed ABSENT) and `.env.example`; recommend six vars, not seven** (§3.6); (b) run `vercel env ls production` once (names only) and fill the UNKNOWN rows, or install the CLI for autorun; (c) confirm `ENCRYPTION_KEY`, `STRIPE_WEBHOOK_SECRET`, `AURINKO_SIGNING_SECRET`, `VAPI_WEBHOOK_SECRET` present (silent-failure class); (d) confirm Vercel system env exposure (`VERCEL_ENV`); (e) Organizer to cut **ENV-VALIDATOR** (§3.11) if agreed.
- Process notes: `program/capability-status.md` received its one-line cross-link because ticket scope 5 assigns it explicitly (autorun rule 6 vs ticket scope — resolved per autorun.md "ticket wins on scope"). `SITE_SYNC.md` carries Cursor's uncommitted SITE-READ markers, so the Builder appends its block but never stages that file. This log block is written after the commit per rule 4 and will be staged with the next ticket's commit.
- Reviewer: (pending — batch review)
- Founder: (pending)
- NEXT: P0-005A provider_events retention/pruning (queue item 2)

## P0-005A — provider_events retention and pruning
- Session: 2026-09-01 21:27 PDT · Batch: 1 · Branch: auto/batch-1
- Previous item: PROD-CONFIG-AUDIT DONE at `0043401` (not acceptance-gated) → proceed.
- Plan: (1) read ticket + ADR-001 C2 + migration 20260812120000 + claim helper + existing retention cron; (2) policy: completed 30d / failed 90d / floor 7d clamped in SQL / processing never — floor = 2× Stripe's ~3-day retry horizon (longest in the stack); (3) one additive migration: partial index on completed rows + service-role-only `prune_provider_events` RPC, bounded oldest-first `LIMIT … FOR UPDATE SKIP LOCKED` deletes per terminal status, jsonb report with hardening counts; (4) `provider-events-retention.ts` constants + bounded loop (claim module untouched); (5) daily cron route + vercel.json; (6) extend the P0-011 importer inventory (tenant-blind route); (7) unit + real-Postgres integration suites incl. concurrency and the replay tradeoff; (8) apply locally via `supabase migration up --local`, re-apply via container psql, EXPLAIN with 30k rolled-back rows; (9) ticket + ADR-001 + audit-doc records; (10) gate, one commit.
- Result: DONE — commit `0b4426d`
- Files: `supabase/migrations/20260901120000_provider_events_pruning.sql` · `src/lib/provider-events-retention.ts` · `src/app/api/cron/provider-events-prune/route.ts` · `vercel.json` · `eval/tenant-scoping.test.ts` (REVIEWED_IMPORTERS +1) · `eval/provider-events-prune.test.ts` (new, 15) · `eval/integration/provider-events-prune.int.test.ts` (new, 6) · `docs/gradia-v2/tickets/P0-005A-…md` (record appended; Status line left to the Organizer) · `docs/gradia-v2/adr/ADR-001-…md` (addendum) · `docs/gradia-v2/runbooks/production-config-audit.md` (CRON_SECRET row: nine crons) · `program/autorun-log.md` (previous block).
- Validation: unit 675 passed / 4 skipped (66 files; was 660) · int 115 passed / 0 skipped (12 files; was 102 + 7 skipped — session tests now run because the local ANON key was supplied) · tsc ✓ · lint ✓ · build ✓ (`ƒ /api/cron/provider-events-prune`) · migration applied locally + re-applied idempotently (psql in the local container) · EXPLAIN: `Index Scan using provider_events_completed_prune_idx` → LockRows → Limit on 30k synthetic rows (rolled back) · one call pruned exactly 5,000.
- DB-sensitive slot: this ticket shipped **one additive migration** (the ticket allowed zero or one) — occupies the slot during review; the Organizer records it at close. No RLS change (table stays deny-all; RPC service-role only).
- Manual acceptance: step 1 executed locally (integration suite + rolled-back 30k-row run); step 2 registration executed (unit-locked); **first scheduled run + log line on staging/Preview assigned to the founder** after the batch deploys — hold out of done until confirmed.
- Residuals: LOW — metadata/attempt CHECK constraints split (surfaced as WARN counts only); LOW — hardening counts are one sequential scan of the bounded table per day; LOW — RPC accepts any window ≥ 7d from any service-role caller (cron passes constants).
- Needs founder: none new. Organizer: ratify the 30/90/7 windows at closeout (ticket delegated the window to in-ticket approval); the tickets index/boards still show P0-005A as ready.
- Reviewer: (pending — batch review; suggested falsification: run two prunes concurrently against a seeded backlog and diff the deleted id sets; try `p_completed_retention_days = 0` and confirm the 7-day clamp; confirm anon/authenticated EXECUTE is denied)
- Founder: (pending)
- NEXT: P0-012 monitoring alert delivery / incident hooks (queue item 3)

## P0-012 — Monitoring alert delivery and incident hooks
- Session: 2026-09-01 21:39 PDT · Batch: 1 · Branch: auto/batch-1
- Previous item: P0-005A DONE at `0b4426d` (not acceptance-gated) → proceed. Decision present: D-042 (Q-08 resolved).
- Plan: (1) read ticket, D-042, severity runbook, monitoring/reconciliation, all cron routes, Sentry wiring; (2) `lib/alerts.ts` seam: env webhook + SEV-0/1 SMS, fail-open, dedupe, validation, Sentry hook, self-status, no `lib/slack.ts` dependency; (3) wire anomalies / tenant-scope violation / reconciliation drift; (4) `lib/cron-run.ts` wrapper + `cron_heartbeats` migration (no reusable stamp existed) applied to all nine cron routes; (5) `GET /api/health` with disclosure review; (6) `POST /api/admin/alert-test` for step 6; (7) convention section + runbook/vendor/env docs; (8) unit + integration suites incl. two-way registration lock; (9) gate, one commit.
- Result: DONE (steps 1–5) — commit `12fe1b0`. Step 6 (real destination + one real alert received) is founder-only and holds the ticket out of done.
- Files: `src/lib/alerts.ts` · `src/lib/cron-run.ts` · `src/app/api/health/route.ts` · `src/app/api/admin/alert-test/route.ts` · `src/lib/monitoring.ts` · `src/lib/reconciliation.ts` · 9 × `src/app/api/cron/*/route.ts` (GET → runCron) · `supabase/migrations/20260901130000_cron_heartbeats.sql` · tests `eval/alerts.test.ts` `eval/cron-run.test.ts` `eval/health.test.ts` `eval/integration/cron-heartbeats.int.test.ts` `eval/tenant-scoping.test.ts` · `.env.example` `docs/env-setup.md` `08-security-and-reliability.md` `runbooks/incident-severity.md` `vendors/core/sentry.md` `runbooks/production-config-audit.md` `tickets/P0-012-…md` · `program/autorun-log.md` (previous block).
- Validation: unit 703 passed / 4 skipped (69 files; was 675) · int 117 passed (13 files; was 115) · tsc ✓ · lint ✓ · build ✓ (`ƒ /api/health`, `ƒ /api/admin/alert-test`) · migration applied locally + re-applied idempotently.
- DB-sensitive slot: **one additive migration** (`cron_heartbeats`; ticket allowed at most one) — second DB-sensitive ticket on this batch branch after P0-005A; sequential, never concurrent; Organizer records at close.
- Severity mapping: TENANT_SCOPE_VIOLATION SEV-0 · global_ceiling SEV-1 · reconciliation drift SEV-1 · spend_spike/margin_floor SEV-2 · cron failure SEV-2 · test alert SEV-3 (table in the ticket record).
- Manual acceptance: steps 2–5 locked by tests locally (anomaly → alert payload; cron failure → one alert + failure stamp, next success clears; health shape/status codes/disclosure snapshot; unconfigured path identical + reported); **steps 1–6 live on staging/Production assigned to the founder**; step 6 closes the ticket.
- Residuals: MEDIUM — dedupe per instance (cross-instance window needs a table or the P10 queue); LOW — no rate limit on `/api/health`; LOW — per-item handled failures inside a successful sweep don't alert individually (logs only; P10 metrics); LOW — Sentry rules are recommendations.
- Needs founder: (a) set `OPS_ALERT_WEBHOOK_URL` (+ optional `OPS_ALERT_SMS_TO/FROM`) in Production after the batch deploys, then `POST /api/admin/alert-test` with the CRON_SECRET bearer and confirm receipt in writing (ticket DoD); (b) point an uptime pinger at `GET /api/health`; (c) click through the five recommended Sentry rules in `vendors/core/sentry.md`. CLEANUP-001 note: the reconciliation `SLACK_WEBHOOK_URL` read is already gone — `lib/slack.ts` can be deleted without an alerts regression.
- Reviewer: (pending — batch review; suggested falsification: post to a webhook that returns 500 and confirm the calling cron still returns its own status with zero throw; hammer one title 100× and confirm one delivery per 10 min per instance; scrape `/api/health` with the DB down and grep the body for any error text; confirm 401 on every cron leaves no heartbeat row)
- Founder: (pending)
- NEXT: CLEANUP-001 remove Housecall Pro connector + Slack approvals surface (queue item 3b)

## CLEANUP-001 — Remove Housecall Pro connector + Slack approvals surface (D-052)
- Session: 2026-09-01 21:53 PDT · Batch: 1 · Branch: auto/batch-1
- Previous item: P0-012 DONE (steps 1–5) at `12fe1b0`; not acceptance-gated → proceed. Decisions present: D-052, D-042.
- Plan: (1) sweep + dispositions (P3-001's scope, executed here); (2) delete 9 files, move the vendor doc to `removed/`; (3) brace-matched removal of every `send*ApprovalRequest` try/catch (29 sites) — staging untouched, executor untouched; (4) payment notices → `sendOpsAlert` SEV-3; (5) HCP out of seam/settings/customer page/shop actions, columns marked dormant, drop file in `supabase/rollbacks/` (not applied); (6) copy + one prompt clause, comments; (7) tests amended by removal only + new source-scan suite; (8) env/vendor/capability/roadmap/ADR/config-audit docs; (9) gate + live eval; (10) one commit.
- Result: DONE — commit `4bd2468`
- Validation: unit **692 passed / 4 skipped (68 files)** — accounting: 703 − 18 removed (slack-interactivity 5, crm-housecallpro 9, webhooks Slack-signature block 4) + 7 new = 692 ✓ · int 117 passed (13 files, unchanged) · tsc ✓ · lint ✓ (0 warnings after removing four dead `crossChannelHint` reads + two unused type imports) · build ✓ · Tier-1 `honest-errors` ✓ · **live `owner-agent-routing.eval.test.ts`: 5/6 — the failing case ("stages a reply for approval…", model never calls `draft_reply`) fails identically on the pre-CLEANUP commit `12fe1b0` (verified in a detached worktree) → pre-existing, not a regression.**
- Migration: none (rollback file only). DB-sensitive slot not occupied.
- Manual acceptance: steps 1–4 executed via tests + suites (close record); step 5 assigned to the Cursor Reviewer (accounting table).
- Residuals: LOW — `pending_actions.slack_*`/`decided_by_slack` + `slackUserId` decider stay (historical); LOW — HCP dormant columns until the founder runs the rollback file; LOW — historical docs still narrate Slack/HCP (Organizer wording pass); LOW — pre-existing owner-agent live-eval failure needs its own triage.
- Needs founder: (a) remove `HOUSECALLPRO_CLIENT_ID`, `HOUSECALLPRO_CLIENT_SECRET`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_DEFAULT_CHANNEL_ID`, `SLACK_WEBHOOK_URL` from Vercel Production (no reader remains; ticket DoD); (b) decide when to run `supabase/rollbacks/cleanup-001_hcp_slack_columns_drop.sql` (optional, destructive, by hand); (c) Organizer: flip P3-001 index row to superseded, backlog row 3b, record TS-6 closure in the P0-011 follow-ups; triage the owner-agent live-eval failure (backlog).
- Reviewer: (pending — batch review; suggested falsification: diff `pending_actions` inserts before/after on one importer per class; confirm `approvals.ts` diff is import + one try/catch only; re-run the accounting)
- Founder: (pending)
- Process note: this block was appended before the commit landed (a shell word-splitting slip stalled `git add`); hash corrected to `4bd2468`; `autorun-log.md` itself is not in `4bd2468` and rides the next commit.
- NEXT: UX-001 truthful state + polish pass (queue item 3c — founder visual review on Preview; check `ui/reference-board.md` precondition first)
