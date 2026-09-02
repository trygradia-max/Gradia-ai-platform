# E03-03 — Lifecycle derivation wired (180/365, D-039) and win-back audiences fueled by lifecycle

_Cut 2026-09-01 by the Organizer for autorun Batch 3 (`../program/autorun.md`). Specification only._

## Ticket ID
E03-03

## Epic
E03 — CRM and import completion (phase P3)

## Status
**draft — batch-gated.** Autorun Batch 3, queue item 12. Enters after E03-02 is committed. Risk class **standard** (cron + audience query; no schema expected). Founder acceptance **no**. Decisions binding: **D-039** (thresholds active <180d / at_risk 180–365 / lapsed >365 approved as implemented), D-011 (approval engine), D-012 (compliance in code), D-045. No open decision.

## Priority
P3 — High. `lifecycle.ts` is finished, tested, and deliberately unwired (`lifecycle.ts:17-19`; zero production importers; `vercel.json` has no lifecycle cron); `customers.lifecycle` is set only on booking completion (`approvals.ts:1500`). The marketed win-back capability "has no fuel": `executeStaleCustomerSms` (`agent-runtime.ts:716`) computes staleness from `interactions` and never reads `lifecycle`; the EBR gate keys off `last_transaction_at`. D-039 unblocks the wiring.

## Objective
Run lifecycle derivation on a cron (and after imports/job completion), surface lifecycle chips on the customer file and a filter in the table, and make the win-back recipe/audience consume `lifecycle` (`at_risk`/`lapsed`) **behind** the unchanged TCPA/EBR + consent + do-not-contact gates — every outbound still staged for approval (D-011).

## User outcome
The owner sees who is at risk and who has lapsed, computed from real service evidence; the win-back automation targets them (and only the ones it may legally text), each message waiting in Approvals.

## Current code references
- `src/lib/lifecycle.ts`: `ACTIVE_WITHIN_DAYS = 180` `:30`, `LAPSED_AFTER_DAYS = 365` `:32`, `lastServiceEvidenceMs` `:41-46` (max of `last_service_at`/`last_visit_at`/`last_transaction_at`), `deriveLifecycle` `:50` (rules `:60-67`; `maintenance` never overridden `:55`; no evidence → unchanged `:58`; `won_back` preserved while fresh `:64`), `runLifecycleDerivation` `:89` (cron-safe, paginated 1000); tests `eval/lifecycle.test.ts`. Sibling unwired: `advanceQuoteFollowUps` `src/lib/pipeline.ts:136-141` (**not** this ticket — note only).
- Column writes: `approvals.ts:1500` (`lifecycle: "active"` on completion); backfill `…c1.sql:137-144`; index `:146-147`. `CustomerLifecycle` type `database.ts:445`.
- Timestamps (E03-04 consolidates; this ticket reads all three via `lastServiceEvidenceMs`): `last_visit_at` written `approvals.ts:1512`; `last_transaction_at` from recovery import (`recovery/review.ts:171-173`, `structured-csv.ts:40,85,338`); `last_service_at` never written.
- Win-back: recipe `stale_customer_sms` `agent-planner.ts:172,227,289`; executor `agent-runtime.ts:716` (dispatch `:1841`; staleness from `interactions.occurred_at` `:774-779`; params `inactive_days` `:746`; select `:758-764` — no `lifecycle`); audience filters `src/lib/agent-audience.ts:188` (lead_status), `:404` (`winbackChannel`/`withinEbrWindow` from `recovery/winback-eligibility.ts:38,56`, `EBR_WINDOW_MONTHS = 18` `:22`); catalog automation `lead_revival` `automations.ts:33,88-96` (defaults off, approval mode).
- Crons: `vercel.json:2-35` (8 crons; `roi-receipt`, `recovery-retention` are `forShop`-converted proofs; E01-02 converted the rest); `cron/automations/route.ts`.
- UI: customer file `customers/[id]/page.tsx`, table `customers-table.tsx`, `HeatBadge`/`StatusPill` components (BUILD_REFERENCE §6 — status tokens only on status).
- Product analytics: none for lifecycle; win-back audience counts are agent-run telemetry.

## Exact scope
1. **Cron:** `/api/cron/lifecycle` (daily, off-peak; `Bearer CRON_SECRET`; `forShop` per shop) calling `runLifecycleDerivation`; registered in `vercel.json`; heartbeat stamp for `/api/health` (P0-012 pattern); one aggregated SEV-3 alert on failure. Also trigger derivation for the affected shop after an import commit (E03-02) and after job completion (existing `approvals.ts:1500` path may simply call `deriveLifecycle` for that customer).
2. **Thresholds locked:** 180/365 constants stay in `lifecycle.ts` with a test asserting D-039 values; no per-shop config (D-039: only if pilots ask).
3. **Surfaces:** lifecycle chip on the customer summary card (icon + text; status tokens: `active`=success, `at_risk`=warning, `lapsed`=danger, `maintenance`/`won_back` neutral/info) and a lifecycle filter in the customers table with a written no-results state; counts on the Customers tab header as real numbers.
4. **Win-back fuel:** `executeStaleCustomerSms`/the audience resolver gain a `lifecycle IN ('at_risk','lapsed')` selection path (recipe param `audience: 'lifecycle' | 'inactivity'`, default lifecycle when the column is populated for the shop), **ANDed** with the unchanged gates: `withinEbrWindow` (18-month EBR for SMS), `marketing_consent`/STOP (`sms_opted_out_at`), `do_not_contact`, quiet hours/send policy; email-only beyond EBR per the flow doc. Every draft stages a `pending_actions` row (no autopilot for win-back in this ticket — the automation's mode stays as configured; ALWAYS_HITL unaffected). Audience cap (50/run, MVP §6) respected.
5. **Dry-run preview:** the automation/agent builder shows the resolved lifecycle audience count + 2–3 sample drafts before enabling (MVP §6 guardrail 3 — reuse the existing preview if present; else add the minimal count + samples).
6. **`won_back` transition:** a customer who books after a win-back message → `won_back` (existing rule preserved) — verify the booking-completion path sets it via `deriveLifecycle` rather than hardcoding `active`.
7. Docs: `program/blocked.md` lifecycle row closed (D-039), `04-capability-map.md` (lifecycle/win-back live), `03` §2, `program/capability-status.md`, `08` compliance section (gates unchanged, listed).

## Explicit non-goals
- No timestamp consolidation or column retirement (E03-04). No `advanceQuoteFollowUps` wiring (separate; note in backlog).
- No change to TCPA/EBR/consent/STOP logic or send policy (hard-stop boundary — `send-policy`, autonomy floors).
- No new outbound channel, no email consent model (E07).
- No per-shop thresholds.

## Dependencies
- E03-02 committed (import commit hook). E01-02 (`forShop` crons). P0-012 (alerts/heartbeat).
- Decisions: D-039, D-011, D-012 — Approved.

## Expected modules affected
New: `src/app/api/cron/lifecycle/route.ts`, `eval/lifecycle-cron.test.ts` (+ integration), lifecycle chip/filter components. Modified: `vercel.json`, `src/lib/lifecycle.ts` (no threshold change; D-039 lock test), `src/lib/agent-runtime.ts` (`executeStaleCustomerSms` audience path), `src/lib/agent-audience.ts`, `src/lib/agent-planner.ts` (recipe param — **prompt file**: if the planner prompt text changes to describe the new param, run the planner eval suite and paste results; prefer a schema-only change), `src/lib/automations.ts` (`lead_revival` description), `src/lib/approvals.ts:1500` (derive instead of hardcode), `customers/[id]/page.tsx`, `customers-table.tsx`, `strings.ts`, `program/blocked.md`, docs.

## Database impact
None expected (column + index exist).

## Migration impact
None (explicit). If a heartbeat stamp needs a column and P0-012 did not add a generic one → reuse P0-012's mechanism; no new migration.

## API impact
New cron route (bearer-gated).

## UI impact
Lifecycle chip, filter, counts; dry-run preview in the automation setup; all with written states.

## Permission impact
Filters/chips visible to all members; enabling win-back automation = admin+ (E01-03 floors).

## Tenant-isolation impact
Cron via `forShop` per shop; audience queries shop-scoped; tenant-isolation test: lifecycle run for A never touches B.

## Security impact
Compliance gates unchanged and re-asserted by tests (STOP, EBR, DNC) — the audience change must be provably ANDed, never ORed.

## Idempotency requirements
Derivation is idempotent (pure); cron overlap-safe (pagination + stable order); win-back cooldown (existing `stale_customer_sms` cooldown) prevents re-contact within N days.

## Observability requirements
Per-run log (shops processed, transitions count); heartbeat; alert on failure; audience counts logged per agent run (`agent-runs.ts`).

## Analytics requirements
None new (win-back sends are agent-run telemetry already).

## Feature flag
None for derivation (pure data); win-back audience path rides the existing automation/agent enablement (owner opt-in, approval mode).

## Automated tests
- Unit: D-039 thresholds lock; transitions across the seeded aging fixture (`active`→`at_risk`→`lapsed`; `maintenance` untouched; `won_back` on booking).
- Integration: cron run populates `lifecycle` on a seeded shop; second run no-op; tenant isolation.
- Audience: lifecycle audience ∩ gates — opted-out, DNC, beyond-EBR-SMS customers excluded (table-driven); cap 50; every draft staged, none sent (no direct send assertion).
- Planner eval suite if the prompt text changed (pasted).

## Manual acceptance procedure
1. Builder: seed customers at 100/200/400 days of evidence → run the cron → chips read active/at_risk/lapsed; filter counts match.
2. Builder: enable `lead_revival`/win-back in approval mode → dry-run shows N + samples → run → N staged approvals, zero sends; an opted-out lapsed customer is absent.
3. Builder: complete a booking for a lapsed customer → `won_back`.
4. Reviewer (Cursor): confirm gates ANDed (test names) and send policy untouched.

## Failure cases
- No evidence timestamps on imported rows → lifecycle unchanged (`:58`); surfaced as "unknown" chip state (written), not fabricated.
- Cron failure → alert; next run catches up (pure derivation).

## Rollback strategy
Remove the cron entry (derivation stops; column values remain valid history); revert the audience path (win-back reverts to inactivity-based). No schema.

## Definition of done
`../12-definition-of-done.md` plus: E03 acceptance criterion 5 evidenced (at_risk/lapsed populate on the aging fixture and feed the win-back gate); `program/blocked.md` row closed; capability/domain/compliance docs updated; planner eval results pasted if applicable.
