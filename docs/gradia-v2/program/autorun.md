# Program — AUTORUN (batch build mode)

_Created 2026-09-01 by the founder's Cowork session. This file is the control layer for running Claude Code in auto mode across MANY tickets in one session. It sits on top of the lane model (Builder/Reviewer/Organizer/Founder) — it does not replace it; it batches it. When this file and a ticket disagree, the ticket wins on scope; this file wins on process._

## Why this exists

The single-ticket handoff prompt stops after one ticket by design. Auto mode needs: an ordered queue, a per-ticket exit, hard stop conditions, and a log. That's this file plus `autorun-log.md`.

## Founder decisions recorded for autorun (2026-09-01)

- **D-036 (ICP):** Primary ICP moves from solo/mobile detailers to **established automotive-appearance shops** (multi-bay, 2+ staff, detailing/ceramic/PPF/tint). Consequences: multi-user (E01) and jobs/team ops (E04) are launch requirements, not later phases; Operator tier is real; migration/import from existing tools (E03) is a first-run requirement. WHAT_GRADIA_DOES §1 and the marketing ICP need a matching update (docs closeout).
- **D-037 (build mode):** Batch autonomous building is approved under the rules below. Lanes A/D/E/G stay founder-only.
- **Decision-queue batch approval (founder, one line):** the Organizer recommendations for **Q-01(a), Q-02, Q-03, Q-05, Q-08, Q-09, Q-11 ($500), Q-12, Q-15(a), Q-16, Q-17 (owner/admin/tech), Q-23(a)** are ACCEPTED so autorun doesn't stall on them. Q-25 resolved as (a): the date follows the gate; no new alpha date is set. Q-18/Q-19/Q-20/Q-21/Q-24 stay open (not needed before P5). → Organizer records these as D-038…D-049 at the next docs closeout.

## UI direction (founder, 2026-09-01)

Keep the shipped design system (BUILD_REFERENCE + glass-box redesign) and converge the 9-item IA per phase (Q-23a). The bar is **Stripe-grade clarity**: truthful state everywhere, inline explanations on every feature, designed empty/loading/error states, fast. That is enforced by UX-001 + PERF-001 in Batch 1 and by every later ticket's DoD — not by a redesign. The `ui/design-north-star.md` and `navigation-model.md` get a short ICP amendment (established shops with staff) in the PROD-CONFIG-AUDIT docs pass.

## Stack decision (founder, 2026-09-01)

Stack stays as is: Next.js/React/TypeScript · Supabase · Vercel · Stripe · Twilio · Vapi (+OpenAI inside Vapi) · Anthropic. Aurinko is replaced by direct Google/Microsoft adapters in Batch 4 (D-050). Housecall Pro and Slack approvals are deleted in Batch 1 (CLEANUP-001). No other vendor changes without the 17-point checklist in `vendors/README.md`.

## Preconditions (founder, before the first autorun session — ~2 hours)

1. P0-011 founder acceptance (30 items in the handoff §27) → merge PR #29 → `git switch main && git pull`.
2. Merge `docs/q22-site-v2-planning` (8e1af45) into main via a docs PR so main carries D-034/D-035 and the site-v2 plan. Autorun must not start on a main that lacks the pricing decisions.
3. Organizer session: P0-011 docs closeout + record D-036…D-049 + cut the Batch-2 tickets (below).
4. **Production env:** set `VAPI_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `AURINKO_CLIENT_ID`, `AURINKO_CLIENT_SECRET`, `CRON_SECRET` in Vercel Production — **six vars, corrected 2026-09-02 at the Batch-1 close:** `VAPI_DEFAULT_SHOP_ID` was listed here by mistake; it is refused in Production (P0-007), confirmed absent (P0-010), and stays absent (PROD-CONFIG-AUDIT §3.6). Every "NOT AVAILABLE" tile in /settings (UX-001 replaced "Coming soon") is driven by these being absent. Stripe price vars stay absent until P0-013 lands.
5. Confirm guardrails exist: `.claude/settings.json` deny list + `.git/hooks/pre-push` (founder pushes with `GRADIA_FOUNDER_PUSH=1`).
6. **Preview access for the Builder (added 2026-09-02, rule 8):** Vercel CLI installed and logged into the Gradia team (`npx vercel login` — the founder's account, so `vercel logs` and `vercel env ls` work), and the browser tools available in the session. Without both, rule 8 cannot be satisfied and user-visible tickets end BUILT, not DONE.

## The queue (ordered — autorun works top-down, never skips, never reorders)

### Batch 1 — finish P0 (no new decisions needed) · branch `auto/batch-1`

_Status 2026-09-02 (Organizer close): items **1, 2, 3, 3b, 3c done** — merged in PR #33 (squash `ff66cc9`), plus the out-of-queue Gmail fix PR #34 `cdb0c99` (Aurinko validation ping; see `autorun-log.md` UX-001 for the root-cause correction). Remaining: **3d PERF-001 → 4 P0-013**, on a fresh branch from `main` (suggested `auto/batch-1b`; `auto/batch-1` is merged and must not be reused). PERF-001 measures on the Vercel Preview per rule 8._

| # | Ticket | Risk class | Founder acceptance? |
|---|---|---|---|
| 1 | **PROD-CONFIG-AUDIT** (new, docs-only output): enumerate every `process.env.X` read in `src/`, classify required/optional per code path, compare against `vercel env ls production` if the CLI is authenticated (else against `docs/env-setup.md`), and write `docs/gradia-v2/runbooks/production-config-audit.md` with a PRESENT / ABSENT / UNKNOWN table + which UI surfaces each absent var disables. No code changes. | none | no |
| 2 | P0-005A provider_events retention/pruning | DB (additive) | no |
| 3 | P0-012 monitoring alert delivery (destination per Q-08: Slack ops channel + SMS for SEV-0/1; the seam ships even if the Slack webhook isn't configured yet) | standard | no |
| 3b | **CLEANUP-001** (new): remove the Housecall Pro connector and the Slack approvals surface entirely (code, flags, tests, vendor docs → mark removed). Resolves Q-07/Q-19 as "delete". No migration unless a table is HCP/Slack-only (then additive drop in a rollback-able file). | standard | no |
| 3c | **UX-001 — Truthful state + polish pass** (new, standard risk, no schema): (a) every ConnectionTile / channel card reads the same source of truth and never shows "Connect" for a connected integration (founder repro 2026-09-01: Gmail connected via Aurinko, Email card still says "Connect Gmail" — trace whether the shop switcher / a second shop row or a stale field is the cause and fix at the root, with a test); (b) remove all stale copy (Slack approval card text, "Coming soon" for integrations that are configured, legacy price strings not covered by P0-013); (c) Stripe-pattern inline help: one short "what this does" line + optional tooltip on every Settings card, every Approvals card type, and the Receptionist builder — copy from `ui/copy-guidelines.md` narrator voice, no new components beyond the existing primitives; (d) empty/loading/error states present on every dashboard route per `ui/state-matrix.md`. Founder supplies Stripe reference screenshots in `docs/gradia-v2/ui/reference-board.md` before this ticket starts. Explicitly NOT a redesign: no new tokens, no new nav, no new design language. | standard | founder visual review on Preview |
| 3d | **PERF-001 — Response-time audit and fixes** (new): measure first (Vercel Speed Insights + server timings for Home, Approvals, Customers, Conversations, Settings), write the numbers into the ticket, then fix the top causes only: N+1 queries in server components, unindexed filters on `shop_id`+time columns, over-fetching on Home analytics, missing `loading.tsx` skeletons, client bundles that should be server components. Target: p75 TTFB < 600ms on the five routes, interaction-to-paint < 100ms on Approve. Re-measure and record before/after in the log. No caching layer or new infra without a HARD STOP. | standard (DB indexes = additive migration) | no |
| 4 | **P0-013 production billing model alignment — FULL ticket** (tier column, per-tier PLAN, entitlements, webhook tier mapping, three-tier UI, test locks, Stripe trial_period_days=14 for D-035 interim). Existing pilot shops: grandfather as `core`. | **payments + DB** | **YES — founder + Cursor before merge; Stripe live prices created by founder only** |

### Batch 2 — tenancy + LLM seam (E01) · branch `auto/batch-2` · tickets cut by Organizer in precondition 3
| # | Ticket (to be cut from E01) | Risk | Acceptance |
|---|---|---|---|
| 5 | E01-01 members/roles/invitations schema + RLS (owner/admin/tech per Q-17) | **tenancy + DB** | YES |
| 6 | E01-02 forShop() rollout TS-1…TS-6 (ADR-003 approved by D-0xx at closeout) | tenancy | YES |
| 7 | E01-03 invitation flow UI + role-aware nav | standard | no |
| 8 | E01-04 ModelProvider seam / AI gateway (D-029) | standard | no |
| 9 | E01-05 eval gating in CI on prompt-file change (Q-06 both) | standard | no |

### Batch 3 — CRM completion + imports (E03) · `auto/batch-3`
| 10 | E03-01 direct customer/vehicle create/edit/export (Q-03) | DB | no |
| 11 | E03-02 structured import wizard: CSV + Jobber export + Urable export → staging → mapping → preview → commit → rollback (D-022) | DB | YES (real export files) |
| 12 | E03-03 lifecycle wiring 180/365 + win-back fuel (Q-02) | standard | no |
| 13 | E03-04 retire `leads.status` / single-truth pass | DB | no |
| 14 | P3-001 Housecall Pro dependency review (docs) | none | no |

### Batch 4 — native calendar (E02) · `auto/batch-4`
| 15–20 | E02 tickets: availability engine read-only → native appointments source of truth (D-013) → **direct Google Calendar + Gmail adapter behind `CalendarProvider`/email seam (retire Aurinko; D-050: Aurinko replacement pulled forward from Q-21)** → Microsoft Graph adapter → conflict flag default-on → booking without external calendar | **calendar + DB** | YES per ticket |

### Batch 5 — jobs & team ops (E04) · `auto/batch-5`
| 20–24 | work orders, assignments, checklists, tech-scoped views, job scheduling | DB | YES (E04 exit: a 3-person shop runs its day) |

### Batch 6+ — E07 comms parity → E05 payments → E08 reporting/PWA → E09 differentiation. Tickets cut when Batch 5 closes.

**Private beta gate (from the roadmap): P0–P5 done.** Under D-036 the honest "an established shop can run on Gradia" bar is Batch 5 complete. Reps sell design-partner trials before that only with the Batch-1 product and clear "team features arriving" language.

## Autorun session rules (Builder, auto mode)

1. Start: read this file, `autorun-log.md`, the exact ticket file for the next queue item, and `12-definition-of-done.md`. State a 10-line plan in the log, then build.
2. Work on the batch branch only. **One commit per ticket**, exact-file staging, message `feat|fix(<ticket>): <title>`.
3. Before each commit run `npm test && npx tsc --noEmit && npm run lint && npm run build && npm run test:int`. Red = fix within the ticket or revert the ticket's changes and log BLOCKED. Never commit red. Never lower a test count.
4. After each commit append to `autorun-log.md` AND append a block to `SITE_SYNC.md` (the website handoff — format in that file): ticket · commit hash · files touched · test totals · residuals (MEDIUM/LOW) · anything that needs a founder decision. Then take the next item.
5. **HARD STOP — halt the session and report** when any of these is true: the next ticket is marked "Founder acceptance YES" and the previous acceptance-gated ticket hasn't been merged; a needed decision isn't in the decision log; a migration would be destructive or non-reversible; the change touches `approvals.ts` executor semantics, `send-policy`, autonomy floors, `usage_events`/`credit_grants`/`payments` write paths, webhook signature verification, or `entitlements.ts` outside the ticket's stated scope; a ticket needs > 2× the files its scope lists; any Production/Vercel/Supabase-remote action would be required.
6. Never: push, merge, rebase, `git add -A`, touch stashes, switch to main, edit `.env*`, read/modify `.playwright-mcp/`, edit `program/*.md` other than `autorun-log.md`, set env vars, create Stripe objects, start Batch N+1 before Batch N is merged.
7. Session end = a HARD STOP, the batch complete, or context limit. Always end by writing the `- NEXT:` line in the log. Use exactly `- NEXT: HARD STOP — <reason>` or `- NEXT: BATCH COMPLETE — <batch>` when halting; the loop runner greps for those strings.
8. **Preview + logs before DONE (added 2026-09-02, D-054 — from the Batch-1 Gmail root-cause miss).** No ticket that touches a **user-visible flow** — a page, a tile or card state, a connect/OAuth flow, a webhook that a user-facing state depends on, an approval path, onboarding — is **DONE** until the Builder has **exercised that exact flow on the Vercel Preview deployment with a real browser** and **read `vercel logs` for that deployment while doing it**, and has written what was seen into the ticket's log block (route · action · observed state · the relevant log lines). **Unit and integration tests alone are not acceptance for these tickets.** The Reviewer re-walks the same flow on the Preview before writing PASS. Mechanics: the Builder cannot push (rule 6), so after the commit the Result line reads `BUILT — Preview walk pending`; the Builder continues the queue (rule 5 still governs acceptance-gated ordering); at the start of the next session, after the founder's push, the Builder walks every BUILT ticket on the Preview first and only then rewrites its Result to DONE. If the Preview cannot be reached (no push yet, no CLI login, protected deployment) the ticket stays BUILT and the session's `- NEXT:` line says so — never DONE on tests alone. Tickets with no user-visible flow (docs, pure lib, cron internals, migrations with no UI) are exempt and say so explicitly in the log block.

## Reviewer (Cursor) in batch mode

One review session per batch branch, ticket by ticket in commit order. May add ONE `review-fix(<ticket>)` commit per ticket for BLOCKER/HIGH only. Writes verdicts into `autorun-log.md` under each ticket. Acceptance-gated tickets get the full falsification pass (side-effect absence, cross-tenant negatives, replay).

## Founder daily loop (~45 min)

Morning: read `autorun-log.md` since yesterday. Push the batch branch (`GRADIA_FOUNDER_PUSH=1`), open/refresh the batch PR, watch CI. Hand the Preview URL to the next Builder session so rule-8 walks can happen (any ticket still `BUILT` is not done). Run acceptance only for tickets flagged YES. Merge when green + reviewed + accepted. `git switch main && git pull`. Then an Organizer session does docs closeout for merged tickets and cuts the next batch's tickets if not yet cut. Evening: start the next autorun session.

## Parallelism (two agents, two repos — never the same repo)

- Claude Code autorun → `~/Gradia/platform` (this queue).
- Cursor → either reviewing the last batch branch, or building `~/Gradia/marketing` site-v2 Passes 2–7 per `marketing/AUTORUN.md`. Never both agents writing to `platform/` at the same time.
