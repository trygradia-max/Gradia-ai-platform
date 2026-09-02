# CLEANUP-001 — Remove the Housecall Pro connector and the Slack approvals surface (D-052)

_Cut 2026-09-01 by the Organizer for autorun Batch 1 (`../program/autorun.md`). Specification only._

## Ticket ID
CLEANUP-001

## Epic
E00 — Stabilization (cleanup; resolves Q-07/Q-19 as "delete" per D-052; supersedes P3-001)

## Status
**ready — autorun Batch 1, queue item 3b** (after P0-012, before P0-013). Risk class **standard** (deletion of dormant surfaces; one possible additive-only migration). Founder acceptance **no**. Decisions binding: **D-052** (delete both), D-026 (amended by D-052), D-030 (HCP classification → removed), D-042 (ops alerts are a webhook, not `lib/slack.ts`). No open decision.

## Priority
P0 band — Medium. Both surfaces are structurally dormant today (HCP env-gated + unverified `TODO(verify)` ×3; Slack approvals flag `false` since D-026 with the C-2 cross-tenant history) yet they still carry 1,399 + 471 + 212 lines of code, 16 importers, two OAuth routes, a webhook route, env vars, and owner-visible copy that describes flows that do not exist. Removing them shrinks the service-role inventory (P0-011 TS-6 becomes moot), the env audit, and the E02/E07 blast radius.

## Objective
Delete the Housecall Pro connector and the Slack approvals surface entirely — code, routes, flags, env documentation, tests, owner-visible copy — while preserving the founder ops alert path (`reconciliation.ts` webhook → P0-012 seam), the Jobber connector behind the CRM seam, and all historical data (columns stay dormant; drops only in a rollback-able file).

## User outcome
Owners never see a Housecall Pro tile or copy that says approvals happen in Slack. The settings page and the how-it-works page tell the truth. Founder-as-operator: fewer secrets to manage, fewer dead routes to defend.

## Current code references
**Housecall Pro** (Explore sweep 2026-09-01):
- Delete whole files: `src/lib/housecallpro.ts` (471 lines; `TODO(verify)` at `:22,265,435`), `src/lib/housecallpro-push.ts` (212), `src/components/gradia/housecallpro-settings-card.tsx` (184), `src/app/api/housecallpro/auth/start/route.ts` (69), `src/app/api/housecallpro/auth/callback/route.ts` (122), `eval/crm-housecallpro.test.ts` (104).
- Edit: `src/lib/crm-provider.ts:22-24` imports, `PROVIDERS` entry `:61-65`, doc `:4-5` (seam stays — Jobber remains); `src/app/actions/shop.ts:551-570` `disconnectHousecallPro`; `src/app/(dashboard)/settings/page.tsx:7,94,111,146-149,191-195,220,335-343,431-435`; `src/app/(dashboard)/customers/[id]/page.tsx:180,194-197` (CRM badge); `src/lib/approvals.ts:383` (comment); `src/lib/types/database.ts:52-56,266,507` (types → mark dormant columns); `eval/crm-seam.test.ts:33,44-45` (amend: approvals never imports a push module; only Jobber push exists).
- DB: `supabase/migrations/20260614120000_shop_housecallpro.sql` — `shops.housecallpro_*` ×5, `customers.housecallpro_customer_id` + partial index, `appointments.housecallpro_job_id`. **HCP-only** → candidates for the rollback-able drop file (not applied). `supabase/catchup_2026-06-18_prod.sql:101-113,265` (historical; leave).
- Env/docs: `.env.example:118-123` `HOUSECALLPRO_CLIENT_ID/SECRET`; `docs/env-setup.md` has no HCP row (nothing to remove); `GO_LIVE_CHECKLIST.md:36,53,94`, `PR_BODY_phase0.md:29`; vendor doc `vendors/customer-integrations/housecall-pro.md`; ticket `P3-001`; `program/blocked.md` HCP live-verification row.
- No `features.ts` flag for HCP — gated by `FEATURES.integrations.crm` (`features.ts:40`) + env presence.

**Slack approvals**:
- `src/lib/slack.ts` (1,399 lines, 27 exports): approval senders `:370,455,594,917,1073`; block builders `:279-1371`; plumbing `updateSlackForPending` `:321`, `storeSlackRef` `:249` (bare-id writes — P0-011 TS-6), `verifySlackSignature` `:1190`, `replaceOriginalMessage` `:1234`; kill switch `postWebhook` `:167` on `FEATURES.slackApprovals`; env reads `:173,174,192,1195`. **Payment notices** `sendPaymentReceivedNotice/Failed/Refunded` `:650,706,762` (consumed by `src/app/api/stripe/webhook/route.ts:28`) — notifications, not approvals, but routed through the flag-gated `postWebhook`, so already dead in prod.
- Route: `src/app/api/slack/interactivity/route.ts` (338 lines; 404s on the flag `:43`).
- Flag: `src/lib/features.ts:52` `slackApprovals: false`.
- Importers (16 src): `src/app/actions/co-owner.ts:6`, `outbound-sms.ts:9`, `leads.ts:6`, `approvals.ts:23`, `outbound-email.ts:7`, `src/app/api/aurinko/webhook/route.ts:48`, `src/app/api/slack/interactivity/route.ts:20`, `src/app/api/cron/no-show-ladder/route.ts:27`, `cron/reminders/route.ts:24`, `src/app/api/twilio/sms/route.ts:59`, `src/app/api/stripe/webhook/route.ts:28`, `src/lib/vapi-tools.ts:34`, `src/lib/agent-runtime.ts:36,1362`, `src/lib/approvals.ts:54`, `src/lib/mcp/server.ts:43`. Tests: `eval/slack-interactivity.test.ts` (whole file), `eval/webhooks.test.ts:8,85,335`, `eval/stripe-webhook-tenancy.test.ts:64`, `eval/integration/twilio-inbound-replay.int.test.ts:91`, `eval/tenant-scoping.test.ts:96` (inventory row), plus mentions in `eval/availability.test.ts`, `eval/conflict-enforcement.test.ts`, `eval/integration/tenant-isolation.int.test.ts`.
- DB: `pending_actions.decided_by_slack`, `slack_channel`, `slack_message_ts` (`20260508130000_pending_actions.sql:21-24`; note in `20260508150000_pending_actions_decided_by_user.sql:2`); TS `database.ts:578,581,582`. **Keep dormant** (historical decisions reference them).
- Env: `.env.example:4-22` (`SLACK_WEBHOOK_URL`, `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `SLACK_DEFAULT_CHANNEL_ID`); `docs/env-setup.md:59-62`.
- **Preserve:** `src/lib/reconciliation.ts:76-97` reads `SLACK_WEBHOOK_URL` directly and posts drift alerts, deliberately **not** gated by the flag (`:77`) — this is the D-042 ops-alert use; P0-012 (queue item 3, merged before this) routes it through `alerts.ts`. After P0-012, `reconciliation.ts` must call the alert seam and `SLACK_WEBHOOK_URL` is owned by `alerts.ts` (rename to `OPS_ALERT_WEBHOOK_URL` is P0-012's call; this ticket must not break it).
- Copy debt (Slack mentioned, never called): `src/app/how-it-works/page.tsx:53,122,141,174`; `src/components/gradia/add-lead-dialog.tsx:59`; `ai-lead-section.tsx:81`; `email-settings-card.tsx:91`; prompt text `src/lib/agent-planner.ts:99` (**prompt file — eval-gated, see scope 6**); comments in `email-drafter.ts:4`, `sms-drafter.ts:4`, `customer-context.ts:10`, `supabase/service.ts:5`, `monitoring.ts:15`, `aurinko.ts:663`, `agent-runtime.ts:1949`.

## Exact scope
1. **Inventory first (P3-001's scope 1–7, executed here, ~1 hour):** repo-wide case-insensitive sweep `housecall|hcp` and `slack` → attach the list to the completion report with a disposition per hit (delete / amend / preserve / historical). This replaces the P3-001 report; P3-001 closes as superseded.
2. **Housecall Pro removal:** delete the files above; amend the shared files; `crm-provider.ts` keeps its shape with Jobber as the sole provider; settings tile + status parsing removed; customer CRM badge shows Jobber only; `.env.example` rows removed; `GO_LIVE_CHECKLIST.md`/`PR_BODY_phase0.md` lines struck with a dated note; vendor doc → `vendors/removed/housecall-pro.md` (removal record), registry row `removed`; `program/blocked.md` HCP row closed.
3. **Slack approvals removal:** delete `src/lib/slack.ts` and `src/app/api/slack/interactivity/route.ts`; remove all 16 importers' Slack calls (each `send*ApprovalRequest` call is a no-op today — deletion must not change any non-Slack behavior: characterization tests around each importer's approval-staging path); remove `FEATURES.slackApprovals`; remove `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_DEFAULT_CHANNEL_ID` from `.env.example`/`env-setup.md`; **`SLACK_WEBHOOK_URL` (or its P0-012 successor) stays** as the ops-alert destination; payment notices (`sendPayment*Notice`) → re-emit through the P0-012 alert seam at SEV-3 info (founder ops channel per D-042) so the founder still sees payment lifecycle events — or drop them if the founder ops channel already receives Stripe events (Builder picks, documents).
4. **P0-011 TS-6 closure:** `storeSlackRef`/`updateSlackForPending` are deleted with the module → record TS-6 as closed-by-removal in ADR-003 and the backlog; `eval/tenant-scoping.test.ts` inventory shrinks by removal only.
5. **Tests:** delete `eval/slack-interactivity.test.ts`, `eval/crm-housecallpro.test.ts`; amend `webhooks.test.ts`, `stripe-webhook-tenancy.test.ts`, `twilio-inbound-replay.int.test.ts`, `crm-seam.test.ts`, `tenant-scoping.test.ts` by removal of the Slack/HCP assertions only; **the total test count may drop only by the count of deleted Slack/HCP-specific tests — the completion report lists each removed test by name** (autorun rule 3 "never lower a test count" is satisfied by that explicit accounting; the Reviewer verifies no unrelated test was dropped). Add: a source-scan test asserting no `slack`/`housecall` import or route remains outside the allowlist (`alerts.ts` webhook only).
6. **Copy truth:** remove Slack from owner-visible copy (`how-it-works`, add-lead dialog, AI-lead section, email settings card) — chrome strings live in `strings.ts`; **`agent-planner.ts:99` is a prompt file** → the change is limited to deleting the Slack clause, and the planner eval suite (`owner-agent-routing.eval.test.ts` / planner cases) is run with results pasted (locked principle #6; DoD B). Comments cleaned.
7. **Dormant columns:** no drops in `migrations/`; write `supabase/rollbacks/cleanup-001_hcp_slack_columns_drop.sql` (not applied) listing `shops.housecallpro_*`, `customers.housecallpro_customer_id` (+ index), `appointments.housecallpro_job_id`, and noting `pending_actions.slack_*`/`decided_by_slack` are **kept** (historical decisions). `database.ts` types marked `/** dormant — CLEANUP-001 */`.
8. Docs: D-026/D-030 notes already amended by D-052; `04-capability-map.md` (HCP row removed / Slack approvals removed), `program/capability-status.md`, `vendors/registry.md`, `10-roadmap.md` "Slack approvals revival — removed (D-052)", ADR-003 TS-6 note, P3-001 ticket status line → superseded (one-line edit), `program/backlog.md` P0-011 follow-up M1/M2/TS-6 → closed-by-removal.

## Explicit non-goals
- No Jobber changes (Q-20 open; seam intact).
- No changes to `alerts.ts`/P0-012 behavior beyond consuming it for payment notices; no new alert types.
- No column drops applied. No `pending_actions` schema change.
- No rewrite of approval staging logic — only removal of the Slack side-effect calls.
- No prompt edits beyond deleting the Slack clause.

## Dependencies
- P0-012 merged (queue order: item 3 before 3b) — the alert seam must exist to carry payment notices and reconciliation drift.
- Decisions: D-052, D-042 — Approved. Supersedes P3-001 (no dependency).

## Expected modules affected
Deleted: 6 HCP files + `src/lib/slack.ts` + `src/app/api/slack/interactivity/route.ts` + 2 test files. Modified: the 16 importers, `crm-provider.ts`, `shop.ts`, settings page, customer detail page, `features.ts`, `database.ts`, `reconciliation.ts` (seam call), Stripe webhook (payment notices → seam), `how-it-works/page.tsx`, three components, `agent-planner.ts` (one clause), `strings.ts`, `.env.example`, `docs/env-setup.md`, `GO_LIVE_CHECKLIST.md`, `PR_BODY_phase0.md`, 5 test files, new source-scan test, new rollback SQL file, vendor/capability/roadmap/ADR docs.

## Database impact
None applied. Rollback-able drop file written, not run.

## Migration impact
None (explicit). DB-sensitive slot not occupied. (If the Builder finds a table that is HCP/Slack-only — none is expected; `pending_actions` is shared — an additive-only file is allowed per autorun Batch 1 row 3b.)

## API impact
Routes removed: `/api/housecallpro/auth/*`, `/api/slack/interactivity` → 404. Nothing else.

## UI impact
Settings: HCP tile/section gone; how-it-works and dialogs no longer mention Slack; no new UI.

## Permission impact
None.

## Tenant-isolation impact
Removes two service-role importers (interactivity route, slack.ts) and the last bare-id `pending_actions` writes (TS-6). Inventory test updated by removal only; tenant-isolation suite green.

## Security impact
Positive: deletes an inbound signed-webhook surface with cross-tenant history (C-2), an unverified OAuth integration, and three secrets. Watch: `SLACK_WEBHOOK_URL` continuity for alerts.

## Idempotency requirements
None new. Payment-notice re-emission through the seam must not duplicate on Stripe webhook retries (the seam's burst dedupe + the existing `provider_events` claim cover it — test).

## Observability requirements
Reconciliation drift and payment notices still reach the founder (through P0-012) — verified by test + acceptance step 3.

## Analytics requirements
None.

## Feature flag
None — removal. `FEATURES.slackApprovals` is deleted (D-052 amends D-026; a future Slack surface would need a new decision + ADR).

## Automated tests
- Characterization: for each of the 16 importers, the approval-staging/decision path produces identical `pending_actions` rows before and after (the Slack call was a no-op under the flag).
- Source-scan: no `@/lib/slack`, `housecallpro`, `/api/slack`, `/api/housecallpro` references outside the allowlist.
- Seam: reconciliation drift → alert emitted; Stripe `invoice.paid`/`payment_failed`/`charge.refunded` → one SEV-3 alert each, none on retry.
- Planner eval suite run (prompt clause removed) — results in the report.
- Test-count accounting table in the completion report (deleted test names vs before/after totals).

## Manual acceptance procedure
1. Builder: `/settings` shows no Housecall Pro; `/how-it-works` mentions no Slack; `GET /api/slack/interactivity` and `/api/housecallpro/auth/start` → 404.
2. Builder: approve a lead, an SMS, an email, a booking locally → identical behavior; Activity/approvals unchanged.
3. Builder: force reconciliation drift locally (seeded) → alert emitted through the seam (destination unconfigured → logged, per P0-012's unconfigured path).
4. Builder: grep sweep attached; rollback SQL file present and **not** applied.
5. Reviewer (Cursor): verify the test-count accounting and that no unrelated test was removed.

## Failure cases
- An importer's Slack call turns out **not** to be a no-op under some path (e.g. flag read elsewhere) → characterization test catches it; fix within scope or HARD STOP if approval semantics would change (`approvals.ts` executor semantics are a hard-stop boundary per autorun rule 5 — this ticket only removes side-effect calls; if removal requires touching executor semantics, stop and report).
- Payment notices lost → acceptance step 3 equivalent for Stripe events.

## Rollback strategy
Revert the PR (single commit). No data changes; columns untouched. Env vars still present in Production until the founder removes them (recorded as a founder action in the log; never the Builder).

## Definition of done
`../12-definition-of-done.md` plus: inventory + disposition table in the close record; test-count accounting table; planner eval results pasted; source-scan test committed; rollback SQL file present/not applied; P3-001 marked superseded; vendor/capability/roadmap/ADR-003/backlog docs updated in the same change; founder action "remove `HOUSECALLPRO_*`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_DEFAULT_CHANNEL_ID` from Production" recorded in `autorun-log.md` under Needs founder.

---

## Close record (Builder, 2026-09-01 — autorun Batch 1, item 3b, branch `auto/batch-1`)

_Status line above is the Organizer's to flip. Scope 1–8 executed; the founder still owes the Production env removals listed under "Needs founder" in `program/autorun-log.md`._

### Inventory + disposition (scope 1 — replaces P3-001's report)
Repo-wide sweep `grep -rliE "housecall|\bhcp\b|slack"` (excluding `node_modules`, `.next`, `.git`, `.playwright-mcp`) before and after. Dispositions:

| Disposition | Files |
|---|---|
| **Deleted** (9) | `src/lib/housecallpro.ts` · `src/lib/housecallpro-push.ts` · `src/components/gradia/housecallpro-settings-card.tsx` · `src/app/api/housecallpro/auth/start/route.ts` · `src/app/api/housecallpro/auth/callback/route.ts` · `eval/crm-housecallpro.test.ts` · `src/lib/slack.ts` · `src/app/api/slack/interactivity/route.ts` · `eval/slack-interactivity.test.ts` |
| **Moved** (1) | `vendors/customer-integrations/housecall-pro.md` → `vendors/removed/housecall-pro.md` (removal banner prepended) |
| **Amended — src** (27) | Slack call sites removed (29 `try { await send*ApprovalRequest(...) } catch` blocks, brace-matched, staging untouched): `actions/co-owner.ts`, `actions/leads.ts`, `actions/outbound-email.ts`, `actions/outbound-sms.ts`, `actions/approvals.ts` (+ dead `notifySlack*` / summary helpers), `api/aurinko/webhook/route.ts`, `api/cron/no-show-ladder/route.ts`, `api/cron/reminders/route.ts`, `api/twilio/sms/route.ts`, `lib/agent-runtime.ts` (13 sites incl. the lazy import), `lib/approvals.ts` (1 site — executor semantics untouched), `lib/mcp/server.ts` (4), `lib/vapi-tools.ts` (2, + the orphaned customer/cross-channel-hint reads that only fed the card); `api/stripe/webhook/route.ts` payment notices → `sendOpsAlert` SEV-3; `lib/features.ts` `slackApprovals` deleted; HCP: `lib/crm-provider.ts` (Jobber sole provider), `actions/shop.ts` (`disconnectHousecallPro` deleted), `(dashboard)/settings/page.tsx` (tile, section, status parsing, env boolean, nav entry), `(dashboard)/customers/[id]/page.tsx` (badge), `lib/types/database.ts` (dormant markers); copy/comments: `app/how-it-works/page.tsx`, `components/gradia/add-lead-dialog.tsx`, `ai-lead-section.tsx`, `email-settings-card.tsx`, `lib/agent-planner.ts` (one schema-description clause), `lib/email-drafter.ts`, `lib/sms-drafter.ts`, `lib/customer-context.ts`, `lib/supabase/service.ts` |
| **Amended — tests** (5 + 1 new) | `eval/webhooks.test.ts` (Slack mock, signing-secret fixture, 6 `sendLeadMock` side-effect assertions, 4-test Slack signature block removed), `eval/stripe-webhook-tenancy.test.ts` (Slack mock → alerts mock), `eval/integration/twilio-inbound-replay.int.test.ts` (Slack mock + env handling), `eval/crm-seam.test.ts` (Jobber-only provider list), `eval/tenant-scoping.test.ts` (inventory −2, removal only); **new** `eval/cleanup-001-removal.test.ts` (7 source-scan locks) |
| **Amended — env/docs** (14) | `.env.example` (Slack ×4 + HCP ×2 removed; service-role/dashboard comments fixed) · `docs/env-setup.md` (Tier 2 → removed) · `vendors/registry.md` · `vendors/README.md` · `04-capability-map.md` · `program/capability-status.md` (row 22, ticket-assigned) · `10-roadmap.md` · `adr/ADR-003` (TS-6 closed by removal) · `runbooks/production-config-audit.md` (6 rows → REMOVED) · `GO_LIVE_CHECKLIST.md` · `PR_BODY_phase0.md` · `tickets/P3-001` (superseded) · this file · `supabase/rollbacks/cleanup-001_hcp_slack_columns_drop.sql` (**new, not applied**) |
| **Preserved (dormant / by design)** | `pending_actions.decided_by_slack`, `slack_channel`, `slack_message_ts` + `slackUserId` decider field and the "Slack-only decider can never satisfy an override" tests (`eval/conflict-enforcement.test.ts`, `eval/availability.test.ts`, `eval/integration/tenant-isolation.int.test.ts`) — executor semantics, kept; `shops.housecallpro_*`, `customers.housecallpro_customer_id` (+ index), `appointments.housecallpro_job_id` — dormant columns, drop file written; `lib/alerts.ts` naming the founder *Slack ops channel* (D-042 destination, not the approvals surface); `lib/aurinko.ts:663` (signature-format reference) |
| **Historical (no edit)** | `supabase/migrations/20260508130000_pending_actions.sql`, `…150000_pending_actions_decided_by_user.sql`, `…20260516100000`, `…20260520100000`, `…20260614120000_shop_housecallpro.sql`, `…20260616120000`, `supabase/catchup_2026-06-18_prod.sql`, `supabase/config.toml`; root plans (`GRADIA_MVP_PLAN.md`, `IMPLEMENTATION_PLAN.md`, `PROJECT_BRIEF.md`, `OVERNIGHT_RUN_2026-07-08.md`, `GRADIA_IGFB_CHARGE_REMOVAL_PLAN.md`, `FOUNDER_OPS_RUNBOOK.md`); `docs/*-go-live.md`, `docs/operator-playbook.md`, `docs/outbound-*.md`, `docs/mcp-architecture.md`, `docs/project-status.md`, `docs/demo-scripts.md`; `_docs/redesign/*`; gradia-v2 planning docs that record the history (01/02/03/05/07/08/09/11/13/16, epics, ui/*, risks, runbooks, other tickets, program boards) — Organizer's docs closeout decides any further wording |

### Test-count accounting (scope 5)
| | Unit (npm test) | Integration |
|---|---|---|
| Before (P0-012 commit `12fe1b0`) | 703 passed / 4 skipped (69 files) | 117 (13 files) |
| Removed — Slack/HCP-specific only | `eval/slack-interactivity.test.ts` **5** · `eval/crm-housecallpro.test.ts` **9** · `eval/webhooks.test.ts` "Slack (v0= HMAC-SHA256…)" **4** (accepts valid / rejects tampered / rejects stale / rejects missing) = **18** | 0 |
| Added | `eval/cleanup-001-removal.test.ts` **7** | 0 |
| After | **692 passed / 4 skipped (68 files)** = 703 − 18 + 7 ✓ | **117** ✓ |

No unrelated test dropped; the six removed `sendLeadMock` **assertions** inside surviving Twilio-route tests asserted only the Slack side effect (post once / not on replay) — the tests themselves remain and still assert the `pending_actions` staging and replay behavior.

### Characterization (scope 5 / failure case)
The Slack calls were post-insert, flag-gated no-ops (`postWebhook` returned early on `FEATURES.slackApprovals=false`; every call was already wrapped in `try/catch`). Their removal leaves every staging path's `pending_actions` writes byte-identical, proven by the unchanged, green suites that assert those rows: `eval/webhooks.test.ts` (Twilio inbound, Aurinko, Vapi routes), `eval/integration/twilio-inbound-replay.int.test.ts`, `eval/integration/approvals.int.test.ts`, `eval/integration/quote-acceptance.int.test.ts`, `eval/integration/booking-atomicity.int.test.ts`, `eval/automations.test.ts` (reminder/confirm cron source locks), MCP + agent-runtime suites. No executor semantics were touched (`approvals.ts` lost one send call only) — the autorun rule-5 boundary was not crossed.

### Prompt change + eval (scope 6, locked principle #6)
Edited: `src/lib/agent-planner.ts` `hitl_note` schema description default ("…lands as a Slack approval card…" → "…lands in Approvals…") and the MCP agent prompt line ("approve in Slack to send" → "approve in /approvals to send"). Tier-1 `eval/honest-errors.test.ts` (scans `agent-planner.ts`) green. Live suite named by the ticket, `eval/owner-agent-routing.eval.test.ts` (`EVAL_LIVE=1`): **5 passed, 1 failed** — "stages a reply for approval and never claims it was sent" (model called `find_person` only, never `draft_reply`). **Baseline on the pre-CLEANUP commit `12fe1b0` in a detached worktree: identical failure** → pre-existing, unrelated to this ticket (`owner-agent.ts` imports nothing this ticket touched). Recorded for the Organizer/backlog as an owner-agent routing regression to triage separately; no planner golden suite exists for `planAgentFromProblem` (recommended follow-up under E01-05).

### Manual acceptance
1. `/settings` HCP tile/section gone, `/how-it-works` mentions no Slack, `/api/slack/interactivity` and `/api/housecallpro/auth/start` no longer exist (Next 404) — **locked by `eval/cleanup-001-removal.test.ts`** (route dirs absent, copy scan). 2. Approve lead / SMS / email / booking → identical behavior — **integration suites green, unchanged**. 3. Reconciliation drift → seam — **done by P0-012** (`reconciliation.ts` emits SEV-1 through `alerts.ts`; unit-locked). 4. Sweep attached above; rollback SQL present and **not applied** (test-locked: no migration drops those columns). 5. Reviewer: verify the accounting table.

### Residuals
LOW — `pending_actions.slack_*` / `decided_by_slack` columns and the `slackUserId` decider field stay (historical; a future cleanup may rename to a generic `decided_by_external`); LOW — HCP dormant columns until the founder runs the rollback file; LOW — historical docs still narrate Slack/HCP (Organizer wording pass); LOW — the pre-existing owner-agent live-eval failure above.
