# Program — AUTORUN (batch build mode)

_Created 2026-09-01 by the founder's Cowork session. This file is the control layer for running Claude Code in auto mode across MANY tickets in one session. It sits on top of the lane model (Builder/Reviewer/Organizer/Founder) — it does not replace it; it batches it. When this file and a ticket disagree, the ticket wins on scope; this file wins on process._

## Why this exists

The single-ticket handoff prompt stops after one ticket by design. Auto mode needs: an ordered queue, a per-ticket exit, hard stop conditions, and a log. That's this file plus `autorun-log.md`.

## Founder decisions recorded for autorun (2026-09-01)

- **D-036 (ICP):** Primary ICP moves from solo/mobile detailers to **established automotive-appearance shops** (multi-bay, 2+ staff, detailing/ceramic/PPF/tint). Consequences: multi-user (E01) and jobs/team ops (E04) are launch requirements, not later phases; Operator tier is real; migration/import from existing tools (E03) is a first-run requirement. WHAT_GRADIA_DOES §1 and the marketing ICP need a matching update (docs closeout).
- **D-037 (build mode):** Batch autonomous building is approved under the rules below. Lanes A/D/E/G stay founder-only.
- **Decision-queue batch approval (founder, one line):** the Organizer recommendations for **Q-01(a), Q-02, Q-03, Q-05, Q-08, Q-09, Q-11 ($500), Q-12, Q-15(a), Q-16, Q-17 (owner/admin/tech), Q-23(a)** are ACCEPTED so autorun doesn't stall on them. Q-25 resolved as (a): the date follows the gate; no new alpha date is set. Q-18/Q-19/Q-20/Q-21/Q-24 stay open (not needed before P5). → Organizer records these as D-038…D-049 at the next docs closeout.

## Stack decision (founder, 2026-09-01)

Stack stays as is: Next.js/React/TypeScript · Supabase · Vercel · Stripe · Twilio · Vapi (+OpenAI inside Vapi) · Anthropic. Aurinko is replaced by direct Google/Microsoft adapters in Batch 4 (D-050). Housecall Pro and Slack approvals are deleted in Batch 1 (CLEANUP-001). No other vendor changes without the 17-point checklist in `vendors/README.md`.

## Preconditions (founder, before the first autorun session — ~2 hours)

1. P0-011 founder acceptance (30 items in the handoff §27) → merge PR #29 → `git switch main && git pull`.
2. Merge `docs/q22-site-v2-planning` (8e1af45) into main via a docs PR so main carries D-034/D-035 and the site-v2 plan. Autorun must not start on a main that lacks the pricing decisions.
3. Organizer session: P0-011 docs closeout + record D-036…D-049 + cut the Batch-2 tickets (below).
4. **Production env:** set `VAPI_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `AURINKO_CLIENT_ID`, `AURINKO_CLIENT_SECRET`, `CRON_SECRET`, `VAPI_DEFAULT_SHOP_ID` in Vercel Production. Every "Coming soon" tile in /settings is driven by these being absent (`settings/page.tsx:129-147`). Stripe price vars stay absent until P0-013 lands.
5. Confirm guardrails exist: `.claude/settings.json` deny list + `.git/hooks/pre-push` (founder pushes with `GRADIA_FOUNDER_PUSH=1`).

## The queue (ordered — autorun works top-down, never skips, never reorders)

### Batch 1 — finish P0 (no new decisions needed) · branch `auto/batch-1`
| # | Ticket | Risk class | Founder acceptance? |
|---|---|---|---|
| 1 | **PROD-CONFIG-AUDIT** (new, docs-only output): enumerate every `process.env.X` read in `src/`, classify required/optional per code path, compare against `vercel env ls production` if the CLI is authenticated (else against `docs/env-setup.md`), and write `docs/gradia-v2/runbooks/production-config-audit.md` with a PRESENT / ABSENT / UNKNOWN table + which UI surfaces each absent var disables. No code changes. | none | no |
| 2 | P0-005A provider_events retention/pruning | DB (additive) | no |
| 3 | P0-012 monitoring alert delivery (destination per Q-08: Slack ops channel + SMS for SEV-0/1; the seam ships even if the Slack webhook isn't configured yet) | standard | no |
| 3b | **CLEANUP-001** (new): remove the Housecall Pro connector and the Slack approvals surface entirely (code, flags, tests, vendor docs → mark removed). Resolves Q-07/Q-19 as "delete". No migration unless a table is HCP/Slack-only (then additive drop in a rollback-able file). | standard | no |
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

## Reviewer (Cursor) in batch mode

One review session per batch branch, ticket by ticket in commit order. May add ONE `review-fix(<ticket>)` commit per ticket for BLOCKER/HIGH only. Writes verdicts into `autorun-log.md` under each ticket. Acceptance-gated tickets get the full falsification pass (side-effect absence, cross-tenant negatives, replay).

## Founder daily loop (~45 min)

Morning: read `autorun-log.md` since yesterday. Push the batch branch (`GRADIA_FOUNDER_PUSH=1`), open/refresh the batch PR, watch CI. Run acceptance only for tickets flagged YES. Merge when green + reviewed + accepted. `git switch main && git pull`. Then an Organizer session does docs closeout for merged tickets and cuts the next batch's tickets if not yet cut. Evening: start the next autorun session.

## Parallelism (two agents, two repos — never the same repo)

- Claude Code autorun → `~/Gradia/platform` (this queue).
- Cursor → either reviewing the last batch branch, or building `~/Gradia/marketing` site-v2 Passes 2–7 per `marketing/AUTORUN.md`. Never both agents writing to `platform/` at the same time.
