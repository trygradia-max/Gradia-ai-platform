# Vendor — Supabase

> **Classification:** core · **Status:** core · Amended 2026-07-27 (vendor-architecture amendment, D-030/ADR-002). Registry: ../registry.md

_Created 2026-07-25 by the Organizer. Vendor registry entry. Facts grounded in the 2026-07-20 audit (docs 02, 05, 06); unverified items are marked. See `08-security-and-reliability.md` and ticket `P0-001`._

## Purpose
Primary data platform: Postgres (28 RLS-enabled tables, 54 idempotent migrations — file-count verified 2026-07-28; the 2026-07-20 audit cited 55 — pgvector for memory/knowledge embeddings), Auth (SSR cookies + PKCE OAuth), and Storage (two private buckets: `recovery-imports`, `job-photos`).

## Data exchanged
All tenant business data: customers, vehicles, leads, quotes, appointments, interactions (with 1536-dim embeddings), pending actions, usage/billing ledgers, encrypted per-shop vendor credentials (`shops` god-table), A2P registration data (EIN/legal identity currently plaintext jsonb — audit doc 05), raw import bodies in `recovery-imports` (PII, purged by retention cron), job photos.

## Authentication
Three clients (`src/lib/supabase/`): anon key + user cookies (RLS-enforced, ~69 modules), service-role key (RLS bypass, ~29–32 files — webhooks/crons/MCP/public quote), browser anon (login form only). Two SQL RPCs trust caller's `p_shop_id`.

## Webhooks
None consumed from Supabase. Gradia does not use Supabase webhooks/realtime (audit doc 02: no realtime subscriptions).

## Rate limits
REQUIRES VERIFICATION — Supabase project tier limits (connections, API throughput) not established in repo. Verify in Supabase dashboard.

## Failure behavior
App-level: "pre-C1 tolerance" (`console.warn` + continue) means a half-migrated DB degrades silently (audit doc 09). No health endpoint until P0-012. Supabase-side outage behavior REQUIRES VERIFICATION.

## Idempotency
Migrations are idempotent (`IF NOT EXISTS`, `ON CONFLICT`). Data-layer idempotency gaps (usage_events, automation_runs) are Gradia-side — tickets P0-005/006/007.

## Cost model
Infra assumed ~$0.50/shop/month in the pricing model (`15-cost-and-margin-model.md`). Actual plan/tier REQUIRES VERIFICATION (Supabase dashboard).

## Monitoring
None specific. DB anomalies surface only via app-level `monitoring.ts` (console-only until P0-012). Supabase dashboard alerts REQUIRES VERIFICATION.

## Test environment
Integration test tier runs against real Postgres via Supabase CLI (pinned 2.98.2) — currently quarantined red in CI (un-quarantine = P0-002). No separate staging project established in repo; REQUIRES VERIFICATION whether one exists.

## Known audit gaps
- **C-1 (CRITICAL): live Postgres superuser connection string committed in `.gitignore:46`, in pushed git history — rotate immediately (P0-001).**
- Service-role tenant scoping is code discipline across ~29 files, not DB-enforced (P0-011).
- Owner-writable ledgers (`usage_events`, `payments`, `shop_metrics` RLS FOR ALL — should be SELECT-only like `credit_grants`).
- Cascade-delete chain `auth.users → shops → everything` destroys financial ledgers and consent history; no soft delete anywhere (E10).
- Platform backups / PITR settings REQUIRES VERIFICATION (audit open question #17 — not inspectable from repo).
- Whether prod DB has the C1 migration applied REQUIRES VERIFICATION (audit open question #16).

## Backup or exit strategy
Backups: Supabase platform feature — tier and PITR status REQUIRES VERIFICATION; a data-restore runbook exists at `runbooks/data-restore.md`. Exit: platform-level dependency (Postgres is portable; Auth, Storage, RLS policies, and pgvector RPCs are a real migration project). Documented as accepted risk; no exit planned.

## Owner
Founder (Harry).
