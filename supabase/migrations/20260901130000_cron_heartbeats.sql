-- P0-012 — cron heartbeat stamps (monitoring alert delivery / incident hooks).
--
-- The smallest durable mechanism for "when did each scheduled job last
-- succeed / fail": one row per cron name, upserted by the shared cron
-- wrapper (src/lib/cron-run.ts) and read by GET /api/health. No cron had a
-- reusable success stamp before this (verified 2026-09-01: no last_run /
-- heartbeat columns anywhere), so this is additive and inert on its own.
--
-- Deny-all RLS like provider_events / rate_limits: the service client
-- (crons, health) is the only writer/reader; anon/authenticated see nothing.
-- last_error is a sanitized, truncated message — never payloads or secrets
-- (the wrapper truncates to 200 chars; the CHECK is the backstop).
--
-- Idempotent + additive. Rollback: DROP TABLE IF EXISTS public.cron_heartbeats;
-- (the wrapper's stamp is best-effort and survives the table's absence).

CREATE TABLE IF NOT EXISTS public.cron_heartbeats (
  name text PRIMARY KEY CHECK (length(name) BETWEEN 1 AND 64),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 200),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.cron_heartbeats ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.cron_heartbeats IS
  'P0-012 cron heartbeat stamps: one row per scheduled job (last success / failure). Service-role only; read by /api/health.';
