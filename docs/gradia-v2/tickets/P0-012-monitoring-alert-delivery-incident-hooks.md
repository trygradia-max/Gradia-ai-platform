# P0-012 — Monitoring alert delivery and incident hooks

## Ticket ID
P0-012

## Epic
E00 — Stabilization

## Status
**done — steps 1–5 — 2026-09-02** (Builder `12fe1b0` on `auto/batch-1`; Cursor PASS 2026-09-02 — fail-open on destination 500, 100× dedupe → 1 delivered, `/api/health` disclosure, wrong bearer on all nine crons; merged to `main` in PR #33 squash `ff66cc9`; one additive migration `20260901130000_cron_heartbeats.sql`, DB-sensitive slot released at close). **Step 6 is outstanding as a founder action** (`../program/backlog.md` Batch-1 residuals): `OPS_ALERT_WEBHOOK_URL` in Production + `POST /api/admin/alert-test` + written receipt; until then the seam is fail-open (console + Sentry) and says so on `/api/health`. _Was:_ **ready-after-P0-002** (reconciled with the index 2026-07-27) — no technical dependencies; enters review only after P0-002 per the global review gate. One open decision noted: the founder's alert destination (Q-08). The delivery **seam** is built destination-agnostic so this does not block; wiring the real destination is the final step and needs the answer.

## Priority
P0 — Medium-high. Audit doc 00 names "quiet-degradation culture without alerting" a top-5 weakness: anomalies, reconciliation drift, and cron failures alert to console only — "failures are silent by design and nobody is paged."

## Objective
Give Gradia a working alarm bell: route existing anomaly/drift/failure signals through one delivery seam to a real founder-facing destination, add a minimal health endpoint, and establish the structured-failure-information convention new code must follow.

## User outcome
(Founder-as-operator outcome:) a spend spike, margin-floor breach, reconciliation drift, or dead cron reaches the founder within minutes on a channel they actually watch — instead of scrolling past in Vercel logs a day later. Shop owners benefit indirectly: incidents get caught before they become customer-visible.

## Current code references
- `monitoring.ts` — anomaly detection exists (spend spikes, margin floors) but **alerts via console only** (audit docs 00, 02 §error handling, 10 §observability score 4).
- Nightly Twilio reconciliation exists (audit doc 00 §billing) — drift results have no delivery channel (audit doc 12 item 12: "monitoring.ts anomalies + reconciliation drift + cron failures → Slack webhook (founder ops channel) instead of console").
- 8 Vercel crons, sequential sweeps, "failure = wait for next tick; weekly jobs have no catch-up" (audit doc 02 §background processing) — failures are invisible.
- **No health endpoint:** "Health checks | NOT_FOUND | No /api/health" (audit doc 03 §Infrastructure).
- Sentry wired (server+edge+client, `tracesSampleRate: 0`, PII off) — errors only, no alerting rules noted (audit doc 02).
- Consistent `[module]` console.error convention; **no structured logger** (audit doc 02) — full structured logging is P10, NOT this ticket.

## Exact scope
1. **Alert delivery seam:** one module (e.g. `src/lib/alerts.ts`) with a narrow interface — `sendOpsAlert({severity, source, title, detail, refs})` — that formats and delivers to a configurable destination (env-configured webhook URL to start). Fail-open by design (an alert-delivery failure must never break the calling path) but self-reporting: delivery failures log loudly and are visible on the health endpoint.
2. **Wire existing signals into the seam:** `monitoring.ts` anomaly outputs; reconciliation drift results; cron failure paths (each of the 8 cron routes wraps its sweep so an unhandled failure emits one alert with the cron name + error summary). Severity mapping documented per SEV-0..3 taxonomy (`runbooks/incident-severity.md`).
3. **Minimal `/api/health`:** unauthenticated-safe (no tenant data, no secrets): app up, DB reachable (cheap query), last-success timestamps for each cron (read from existing stamps where they exist; where none exists, record one — smallest possible mechanism), alert-seam self-status. Returns JSON + appropriate status code for an external uptime pinger.
4. **Structured failure convention (documentation + exemplar):** a short section in `08-security-and-reliability.md` (or referenced from it) defining what a failure log/alert must carry (module, shop_id where applicable, provider ref, action taken, retryability) — plus the seam's payloads as the living example. New-code requirement enforced by review, not retrofit.
5. **Sentry hook:** alert-worthy exceptions also tagged in Sentry (severity tag) so the two systems cross-reference; note (not implement) recommended Sentry alert rules in the completion report for the founder to click through.
6. **Destination wiring:** once the decision-queue answer lands, set the env var in prod and fire a live test alert. Ticket closes only after one real alert is received on the real destination.

## Explicit non-goals
- No structured logger adoption / log aggregation (P10).
- No tracing (`tracesSampleRate` stays as-is).
- No owner-facing (shop-owner) failure surfaces or in-app notifications — this is founder-ops alerting only.
- No queue/retry/dead-letter for crons (P10; alerting on failure is this ticket, retrying is not).
- No paging/rotation tooling (single-founder operation; a webhook destination suffices).
- No new anomaly detectors — deliver the existing signals first.

## Dependencies
- **Decision:** alert destination (decision queue **Q-08**; originally audit doc 13 open question #10) — blocks only step 6 (final wiring). Steps 1–5 proceed.
- Soft: SEV taxonomy from `runbooks/incident-severity.md` (authored by the Organizer this session — available).

## Expected modules affected
- New `src/lib/alerts.ts`
- `src/lib/monitoring.ts` (emit through the seam)
- Reconciliation module (drift → alert)
- 8 cron route handlers (failure wrapper — mechanical, identical pattern)
- New `src/app/api/health/route.ts`
- `.env.example` (destination var, documented)
- `docs/gradia-v2/08-security-and-reliability.md` (convention section)

## Database impact
- Possibly one small additive structure for cron last-success stamps if no reusable stamp exists per cron (verify first — several crons already stamp; reuse before adding). Nothing else.

## Migration impact
- At most one additive, idempotent migration for cron heartbeat stamps (only if needed).

## API impact
- New `GET /api/health` — public, read-only, no tenant data, rate-limit friendly. Contract documented in the route file.

## UI impact
None (founder-ops channel + JSON endpoint only).

## Permission impact
- `/api/health` is deliberately unauthenticated (uptime pingers) — therefore its response must be reviewed for information disclosure: no shop data, no env names, no versions beyond what's already public, no error internals. Cron detail may be gated behind `CRON_SECRET` bearer if the review finds it too chatty — Builder judgment, documented.

## Tenant-isolation impact
- Alerts may reference a shop_id for context; the destination is founder-internal. No cross-tenant exposure paths added. Health endpoint carries zero tenant data.

## Security impact
- Positive: silent failures become visible (the audit's weakness #5).
- Watch: webhook destination URL is a secret (treat like any credential — env only, never logged).

## Idempotency requirements
- Alert emission should dedupe bursts (same source+title within a short window collapses) so a crashloop can't flood the destination — simple in-memory/window guard is acceptable; document the limitation (per-instance).

## Observability requirements
- The seam observes itself: delivery failures counted and exposed on `/api/health`. This ticket IS the observability baseline for everything after it.

## Analytics requirements
None (ops, not product).

## Feature flag
**Env-gated, not feature-flagged:** with no destination configured, the seam logs (current behavior, no regression) and health reports "alerts: unconfigured". This makes deploys safe before the founder decision lands and doubles as the rollback position.

## Automated tests
- **Unit:** severity mapping; payload shape; burst dedupe; destination-unconfigured path logs and returns without throwing.
- **Failure-path:** destination returns 500/timeout → calling code unaffected (fail-open verified), failure counted; malformed alert input rejected safely.
- **Health endpoint:** healthy shape; DB-unreachable shape (degraded status code); no-tenant-data assertion (snapshot the response keys).
- **Cron wrapper:** a cron whose sweep throws emits exactly one alert and still returns its normal error status; a healthy run emits nothing.

## Manual acceptance procedure
1. Deploy to staging with a test webhook destination (e.g. a request-bin).
2. Trigger a synthetic anomaly (seeded spend spike per `monitoring.ts` thresholds) → one formatted alert arrives with severity, source, refs.
3. Force one cron to fail (bad env in staging) → one alert names the cron; next successful run clears it on `/api/health`.
4. Hit `/api/health`: verify statuses, cron timestamps, alert-seam status; verify response contains no tenant/secret data.
5. Point destination at nothing → run steps 2–3 → calling paths behave identically, health shows unconfigured/failed delivery.
6. After founder decision: set prod destination, fire the built-in test alert, founder confirms receipt in writing.

## Failure cases
- Destination down during a real incident → alerts fail-open, counted, visible on health; Sentry still has the exception (dual-channel by design).
- Alert storm from a crashloop → burst dedupe caps it; residual risk documented.
- Health endpoint scraped aggressively → cheap queries only; add rate limit if measurable load appears (note, don't pre-build).

## Rollback strategy
Unset the destination env var (seam reverts to console logging — the exact current behavior) or revert the PR entirely. Health endpoint is read-only and removable independently. No data to unwind (heartbeat stamps, if added, are inert).

## Definition of done
Per `12-definition-of-done.md`, plus: one real alert received on the founder's chosen destination (step 6 evidence), the structured-failure convention section merged into `08-security-and-reliability.md`, and the completion report lists recommended Sentry alert rules for the founder.

---

## Implementation record (Builder, 2026-09-01 — autorun Batch 1, item 3, branch `auto/batch-1`)

_Status line above is the Organizer's to flip. Steps 1–5 built; step 6 (real destination + one real alert received) is the founder's and holds the ticket out of **done**._

**Seam (scope 1):** `src/lib/alerts.ts` — `sendOpsAlert({ severity, source, title, detail?, refs?, error?, bypassDedupe? })`. Destinations by env: `OPS_ALERT_WEBHOOK_URL` (JSON `{ text }`, every severity — the D-042 founder Slack ops channel) and `OPS_ALERT_SMS_TO`/`_FROM` (SEV-0/1 only, env Twilio master). Contract locked by `eval/alerts.test.ts` (14 tests): never throws; unconfigured = log + Sentry only; webhook 5xx / network / timeout → fail-open, counted, **destination URL never logged** (status or error *name* only); SMS body carries severity/source/title only; burst dedupe on (severity, source, title) for 10 min, per instance (documented limitation; N instances ⇒ up to N copies); malformed input rejected and counted; detail/refs truncated; Sentry cross-reference (`captureException` with `severity`/`source`/`ops_alert` tags when an error is attached; `captureMessage` for SEV-0/1 otherwise). Does **not** import `lib/slack.ts` (D-042; CLEANUP-001 can delete it freely).

**Wired signals (scope 2) — severity mapping per `runbooks/incident-severity.md`:**

| Signal | Severity | `source` | Where |
|---|---|---|---|
| `TENANT_SCOPE_VIOLATION` (P0-011) | **SEV-0** (cross-tenant shape starts one level up) | `tenancy` | `monitoring.reportTenantScopeViolation` — fire-and-forget, refusal never waits on delivery |
| `global_ceiling` | **SEV-1** | `monitoring` | `detectUsageAnomalies` |
| Telephony reconciliation drift >2% | **SEV-1** (money metering vs vendor billing) | `reconcile` | `reconciliation.alertDrift` — the direct `SLACK_WEBHOOK_URL` post is gone |
| `spend_spike`, `margin_floor` | **SEV-2** | `monitoring` | `detectUsageAnomalies` (title carries the shop id so shops dedupe independently) |
| Any cron: handler throws **or** returns 5xx | **SEV-2** | `cron/<name>` | `src/lib/cron-run.ts` `runCron` — all **nine** routes (`agents`, `automations`, `no-show-ladder`, `provider-events-prune`, `reconcile`, `recovery-retention`, `reminders`, `roi-receipt`, `voice-sync`) now `export const GET = (request) => runCron("<name>", request, handle)`; auth stays inside each route (401 = no stamp, no alert) |
| Built-in test alert | SEV-3 | `alerts` | `sendTestOpsAlert` ← `POST /api/admin/alert-test` (bearer `CRON_SECRET`, bypasses dedupe) |

**Health (scope 3):** `GET /api/health` — unauthenticated, `Cache-Control: no-store`, one bounded service-role read of the new `cron_heartbeats` table with a 3 s timeout. Contract in the route file: `status` ok/degraded/down (`down` ⇒ 503), `checks.db {ok, latencyMs}`, `checks.alerts` (configured flags + counters + last timestamps), `checks.crons.<name> {lastSuccessAt, lastFailureAt, ok, stale}` (stale = last success older than 2× period + 10 min; never-ran = nulls). Disclosure review: no tenant data, no env names/values, no versions, no error text (the DB error message is logged, not returned) — locked by a key-snapshot test. No rate limit (ticket failure-case note: add one only if pinger load becomes measurable). Cron heartbeat stamps: **no reusable stamp existed** (verified: no `last_run`/`heartbeat` columns anywhere), so **one additive migration** `20260901130000_cron_heartbeats.sql` (one row per cron name; deny-all RLS; `last_error` ≤ 200 chars by CHECK). Stamps are best-effort — a stamp failure logs and never changes the cron outcome.

**Convention (scope 4):** `08-security-and-reliability.md` §7 now carries "Structured failure information — the convention" (module · severity · what happened · shop_id · provider refs · action taken · retryability · exception) with the seam payloads as living examples; §7 bullets 2–3 updated. `runbooks/incident-severity.md` known-gaps bullets updated. **Sentry hook + recommended rules (scope 5):** in the seam (above) and in `vendors/core/sentry.md` §Monitoring — for the founder to click through: (1) issue alert on tag `ops_alert:true` ∧ severity ∈ {SEV-0, SEV-1} → immediate; (2) new issue in `production` → daily digest; (3) metric alert error events > 20 / 5 min; (4) uptime monitor on `GET /api/health` = 200 every 1–5 min; (5) Sentry Crons optional (health already carries heartbeats).

**Tests:** `eval/alerts.test.ts` (14) · `eval/cron-run.test.ts` (12: throw → one alert + failure stamp + 500; own 5xx → one alert, status preserved; healthy → success stamp, no alert; 401 → nothing; stamp failure harmless; error truncation; pure health summary; **two-way registration lock** vercel.json ↔ `CRON_REGISTRY` ↔ every `cron/*/route.ts` wrapped with its own name; schedule-class ↔ period) · `eval/health.test.ts` (4: healthy shape, DB error/timeout → 503, stale/failed → degraded, **disclosure key-snapshot**) · `eval/integration/cron-heartbeats.int.test.ts` (2, real Postgres: stamps alternate, error bounded, anon sees nothing) · `eval/tenant-scoping.test.ts` `REVIEWED_IMPORTERS` +2 (`cron-run.ts`, `health/route.ts`, both tenant-blind). Existing `monitoring`, `reconciliation`, `tenant-isolation` suites unchanged and green with alerts emitting.

**Env/docs:** `.env.example` + `docs/env-setup.md` document the three `OPS_ALERT_*` names; `runbooks/production-config-audit.md` rows added (53), `SLACK_WEBHOOK_URL` row + §3.9 updated (reconciliation read removed).

**Manual acceptance (ticket steps):** 1 (staging deploy with a request-bin destination) — **founder**; 2 (synthetic anomaly → one formatted alert) — the wiring and payload are unit-locked; live run **founder** on staging; 3 (force a cron failure → one alert names the cron; next success clears it on `/api/health`) — unit + integration locked; live run **founder**; 4 (`/api/health` statuses, cron timestamps, seam status, no tenant/secret data) — unit-locked incl. key snapshot; live check **founder**; 5 (destination unset → identical calling behavior, health shows unconfigured) — unit-locked; 6 (Production `OPS_ALERT_WEBHOOK_URL` set, `POST /api/admin/alert-test`, founder confirms receipt in writing) — **founder; closes the ticket**.

**Residuals:** MEDIUM — dedupe is per-instance (documented; a cross-instance window needs a table or the P10 queue); LOW — no rate limit on `/api/health`; LOW — `crons` with a `skipped: "feature disabled"` 200 count as success (truthful: the sweep ran); LOW — handled non-5xx failures inside a sweep (per-shop `catch` + counters) do not alert individually by design (the sweep succeeded; per-item failures stay in logs — P10 metrics); LOW — Sentry rules are recommendations, not code.
