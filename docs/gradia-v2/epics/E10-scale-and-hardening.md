# E10 — Scale and Production Hardening

_Created 2026-07-25 by the Organizer. Phase: **P10**. Status: planned._

## Objective

Convert pilot-scale operational patterns into production mechanisms: an outbox/queue with retry and dead-letter, soft delete plus GDPR-shaped data export/deletion, structured logging + health endpoint + tracing, a Playwright E2E suite, and measured performance headroom for 10× shops.

## User outcome

Owners never notice this epic — that's the point. Failures retry instead of waiting a week, deleting a customer doesn't vaporize financial history, support can answer "what happened at 3:07pm" from structured logs, and the app stays fast as the shop count grows.

## Business reason

Audit doc 10 scores reliability 5 and observability 4: "no queue/retry/dead-letter, weekly cron with no catch-up, silent degradation everywhere… nobody is paged." Doc 05 flags the cascade-delete chain destroying ledgers and zero soft-delete as compliance-shaped risk. These caps block any serious scale sale and every SEV runbook assumes capabilities this epic builds.

## Current foundation

- `pending_actions` is "already an outbox-shaped table" (audit doc 11) — the generalization template.
- P0-012 alert delivery + P0-005 idempotency keys; 8 authenticated crons; Sentry wired (errors only); `monitoring.ts` anomaly checks; recovery-import retention cron as the deletion-pipeline pattern.
- 430-test deterministic tier + integration tier (un-quarantined in P0-002) to build the E2E layer on.

## Missing work

1. **Outbox/queue:** `domain_events` table + retrying drain worker + dead-letter + weekly catch-up; migrate cron sweeps and best-effort side effects (CRM push, decision-log writes, embed jobs) onto it; kill the `.catch(() => null)` silent-drop culture path by path.
2. **Soft delete + data lifecycle:** `deleted_at` on customer-facing entities; de-fang `auth.users → shops → everything` cascade (ledgers/compliance history survive — D-024); customer data export (JSON/CSV) and deletion flow with legal-hold carve-outs.
3. **Observability:** structured logger (replace `[module]` console), `/api/health`, Sentry tracing sample > 0, spend/cron dashboards fed by P0-012 hooks.
4. **E2E suite:** Playwright over the seeded golden path — onboarding → lead → approve → book → complete → invoice — in CI on a real preview deploy.
5. **Performance/scale passes:** paginate unbounded scans (crm-health, sweeps >500 shops), `rate_limits` pruning cron (unbounded growth, audit doc 05), hot composite indexes, HNSW recall check as tenants grow, N+1 interaction pulls.
6. Remaining hygiene: `updated_at` trigger, enum/CHECK normalization (`pending_actions.resolution`), transaction-or-idempotent-RPC pass over the few critical multi-step sequences (merge, booking) per audit doc 09.

## Domain entities

New: `domain_events` (+ dead-letter state). Modified: soft-delete columns across customer-facing tables; constraint normalization.

## Backend services

Queue drain worker (cron-driven; no new infra vendor without ADR), `logger.ts`, health route, export/deletion pipeline, pruning crons.

## UI surfaces

Minimal: data export/delete controls in Settings (role-gated), degraded-integration banners (owner-facing failure surfaces the audit says are missing). No new product surfaces.

## Integrations

Sentry (tracing), possibly a queue vendor **only if** the DB-backed outbox measurably fails (ADR required — default is Postgres-backed, preserving the monolith per D-007/D-008).

## Security implications

Deletion flows are themselves security surfaces (verify requester role, cooling-off, audit record); structured logs must scrub PII/secrets (test-locked); health endpoint exposes no internals unauthenticated.

## Tenant implications

`domain_events` shop-scoped with `forShop()` from birth; export/deletion strictly single-shop; performance work must not trade isolation for speed (no cross-tenant caches).

## Migration implications

Soft-delete columns + cascade rewrites are the most delicate migrations in the program: FK behavior changes need staged verify on a prod clone; every read path must learn `deleted_at IS NULL` (lint rule / view strategy — ADR).

## Product analytics

`Subscription canceled` gains a deletion-request correlation. No other canonical changes.

## Dependencies

P0 complete (alerting, idempotency), E01 (`forShop()` mechanism), stable feature surface (this epic hardens what exists — running it concurrently with heavy feature epics defeats it). Decisions: queue technology ADR; data-retention windows (founder, decision queue — legal-adjacent).

## Risks

- Outbox migration can change side-effect ordering/timing — migrate one producer at a time with shadow-mode comparison.
- Soft-delete read-path misses resurrect "deleted" data in one forgotten query — mechanical enforcement (views or lint) is mandatory, discipline is not accepted (the audit's core lesson).
- E2E flakiness erodes CI trust — quarantine policy with expiry, never permanent `continue-on-error` (we've seen that movie: red since 06-04).

## Non-goals

No microservices (D-008), no Kubernetes/self-hosted infra, no multi-region, no event-sourcing rewrite (outbox ≠ ES), no SOC 2 audit itself (this builds the substrate).

## Feature flags

Per-producer outbox cutover flags; `FEATURES.dataExportDeletion`; logger/health unflagged.

## Testing requirements

Queue: retry/backoff/dead-letter/catch-up unit + chaos tests (kill worker mid-batch → exactly-once effects via idempotency keys); soft-delete: read-path exclusion proven per table, ledger-survival test on account deletion; log-scrubbing tests; E2E golden path green in CI 10 consecutive runs before it gates; perf: seeded 10× fixture benchmarks with recorded baselines.

## Rollout plan

Observability first (see everything before touching anything) → outbox producer-by-producer → soft-delete table-by-table → export/deletion flow → E2E gating on → perf passes continuous. Each SEV runbook gets a game-day exercise against the new machinery.

## Acceptance criteria

1. A failed CRM push retries with backoff and dead-letters visibly; weekly jobs catch up after a missed window; zero `.catch(() => null)` on side-effect paths (grep-test).
2. Deleting a customer soft-deletes; financial ledgers and consent history survive account deletion (D-024 test); export produces a complete, importable archive.
3. `/api/health` + structured logs + tracing answer "what happened" for a staged incident without code archaeology.
4. Playwright golden path gates CI; 10-run stability demonstrated.
5. 10× seeded-scale benchmarks meet recorded targets; `rate_limits` table stops growing unboundedly.
