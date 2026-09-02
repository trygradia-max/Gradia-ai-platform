# Vendor — Sentry

> **Classification:** core · **Status:** core · Amended 2026-07-27 (vendor-architecture amendment, D-030/ADR-002). Registry: ../registry.md

_Created 2026-07-25 by the Organizer. Vendor registry entry. Facts grounded in the 2026-07-20 audit (docs 02, 03, 10); unverified items are marked. Ticket: P0-012._

## Purpose
Error tracking for the Next.js app: server + edge + client instrumentation wired. Errors only today — `tracesSampleRate: 0` (no performance tracing), PII off.

## Data exchanged
Application exceptions/stack traces. PII scrubbing is on (audit doc 02: "PII off"); exact scrubbing config REQUIRES VERIFICATION (Sentry project settings).

## Authentication
Sentry DSN via env. Project/org settings REQUIRES VERIFICATION (Sentry dashboard).

## Webhooks
None consumed by Gradia. Sentry→founder alert rules REQUIRES VERIFICATION — audit doc 10 scores observability 4/10 partly because nobody is paged.

## Rate limits
Event quota per plan REQUIRES VERIFICATION.

## Failure behavior
If Sentry is down, error capture is lost silently — no fallback logging path beyond `[module]`-prefixed console logs (no structured logger; E10).

## Idempotency
Not applicable.

## Cost model
Plan/quota REQUIRES VERIFICATION; assumed inside the ~$0.50/shop infra line.

## Monitoring
**Update 2026-09-01 (P0-012 built, autorun Batch 1):** the ops alert seam (`src/lib/alerts.ts`) cross-references Sentry — every alert with an attached exception is `captureException`-ed with tags `severity`, `source`, `ops_alert=true`; SEV-0/1 without an exception become `captureMessage`. Recommended alert rules for the founder to click through (not configured by code): (1) issue alert — tag `ops_alert:true` AND severity in {SEV-0, SEV-1} → notify immediately; (2) issue alert — new issue in `production` → daily digest; (3) metric alert — error events > 20 in 5 min → notify; (4) uptime monitor — `GET /api/health` expects 200 every 1–5 min (Sentry Uptime or any pinger); (5) Sentry Crons are optional — `/api/health` already carries per-cron heartbeats.

Sentry *is* monitoring, but note the gap it does NOT cover: `monitoring.ts` anomaly detection (spend spikes, margin floors), reconciliation drift, and cron failures alert via **console only** — P0-012 wires those to a real destination. ~~Zero `error.tsx` boundaries~~ — resolved 2026-08-28 (P0-010, PR #27): root + `(dashboard)`-level `error.tsx`/`global-error.tsx`/`not-found.tsx` all render designed surfaces and report to Sentry via `captureException` (verified at acceptance).

## Test environment
None established; REQUIRES VERIFICATION whether a separate Sentry env/DSN exists for preview deploys.

## Known audit gaps
- Errors-only posture: no tracing (`tracesSampleRate: 0`), no structured logs (E10). ~~no health endpoint~~ — `GET /api/health` shipped with P0-012 (2026-09-01).
- Alert rules → founder delivery: destination decided (D-042) and the seam built (P0-012, 2026-09-01); Production `OPS_ALERT_WEBHOOK_URL` + the Sentry rules above still REQUIRE the founder to set/verify.
- Silent-degradation culture means many failures never throw, so Sentry never sees them — the deeper fix is the no-silent-failure standard in `08-security-and-reliability.md`.

## Backup or exit strategy
Low coupling — instrumentation is standard `@sentry/nextjs` shape; swapping error trackers is contained. No exit planned.

## Owner
Founder (Harry).
