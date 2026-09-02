-- P0-005A — provider_events retention and pruning (ADR-001 condition C2
-- follow-up; ADR-001 addendum 2026-09-01).
--
-- The claim table created by 20260812120000_webhook_idempotency.sql is
-- append-per-event by design. This migration bounds its growth with ONE
-- service-role-only RPC that deletes expired terminal receipts in small,
-- lock-skipping batches, plus one partial index so the delete never has to
-- scan live rows. Nothing about claim/complete/fail semantics or the
-- (provider, event_id) key changes.
--
-- Retention policy (documented in the P0-005A ticket + ADR-001 addendum):
--   completed  → default 30 days   (floor 7 days, enforced here)
--   failed     → default 90 days   (floor 7 days, enforced here) — the
--                observability trail until P0-012 metrics land
--   processing → NEVER pruned by age; stale-reclaim semantics own them
-- Floor rationale: the longest provider retry horizon in the stack is
-- Stripe's (~3 days of webhook retries); Twilio, Vapi and Aurinko retry
-- for minutes-to-hours. 7 days ≥ 2× the longest horizon; the 30-day
-- default is 10×. A receipt that outlives its provider's retry window can
-- no longer be "re-delivered" by that provider, so pruning it cannot
-- reopen a duplicate — the accepted retention tradeoff.
--
-- Idempotent + additive: IF NOT EXISTS / CREATE OR REPLACE; re-runnable.
-- Rollback:
--   DROP FUNCTION IF EXISTS public.prune_provider_events(integer, integer, integer);
--   DROP INDEX IF EXISTS public.provider_events_completed_prune_idx;
-- (Deleted receipts are not recoverable — which is why the floor exists.)

-- 1. Prune index: completed rows are the bulk of the table and the existing
--    status index deliberately excludes them (WHERE status <> 'completed').
CREATE INDEX IF NOT EXISTS provider_events_completed_prune_idx
  ON public.provider_events (completed_at)
  WHERE status = 'completed';

-- 2. Batched, overlap-safe prune.
--    Each call deletes at most p_batch_size expired 'completed' rows and at
--    most p_batch_size expired 'failed' rows, in two single statements.
--    FOR UPDATE SKIP LOCKED means two concurrent runs take DISJOINT rows —
--    neither errors, neither double-counts. Stable ordering (oldest first)
--    means partial progress is always the oldest receipts.
--    Returns a jsonb report the cron logs (info) — P0-012 will count it.
CREATE OR REPLACE FUNCTION public.prune_provider_events(
  p_completed_retention_days integer DEFAULT 30,
  p_failed_retention_days integer DEFAULT 90,
  p_batch_size integer DEFAULT 5000
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  -- Hard floors: no caller (typo, bad constant, hostile RPC) can prune
  -- inside a provider's retry horizon. Batch bounded so a run can never
  -- monopolize the database.
  v_completed_days integer := GREATEST(COALESCE(p_completed_retention_days, 30), 7);
  v_failed_days integer := GREATEST(COALESCE(p_failed_retention_days, 90), 7);
  v_batch integer := LEAST(GREATEST(COALESCE(p_batch_size, 5000), 1), 50000);
  v_completed_cutoff timestamptz := now() - make_interval(days => GREATEST(COALESCE(p_completed_retention_days, 30), 7));
  v_failed_cutoff timestamptz := now() - make_interval(days => GREATEST(COALESCE(p_failed_retention_days, 90), 7));
  v_completed_pruned integer := 0;
  v_failed_pruned integer := 0;
  v_completed_expired_remaining bigint := 0;
  v_failed_expired_remaining bigint := 0;
  v_oldest_completed_at timestamptz;
  v_oldest_failed_at timestamptz;
  v_processing_rows bigint := 0;
  v_attempts_over_cap bigint := 0;
  v_oversized_metadata bigint := 0;
BEGIN
  -- Expired completed receipts (oldest first). Rows with a NULL
  -- completed_at cannot exist via complete_provider_event; if one ever
  -- does, it is never age-pruned (safe direction).
  WITH victims AS (
    SELECT id
      FROM public.provider_events
     WHERE status = 'completed'
       AND completed_at < v_completed_cutoff
     ORDER BY completed_at
     LIMIT v_batch
     FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.provider_events pe
   USING victims
   WHERE pe.id = victims.id
     AND pe.status = 'completed';
  GET DIAGNOSTICS v_completed_pruned = ROW_COUNT;

  -- Expired failed receipts (longer window; oldest first).
  WITH victims AS (
    SELECT id
      FROM public.provider_events
     WHERE status = 'failed'
       AND failed_at < v_failed_cutoff
     ORDER BY failed_at
     LIMIT v_batch
     FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.provider_events pe
   USING victims
   WHERE pe.id = victims.id
     AND pe.status = 'failed';
  GET DIAGNOSTICS v_failed_pruned = ROW_COUNT;

  -- Observability for the run log: what is still expired (backlog the next
  -- run will take), the oldest surviving terminal receipts, and the two
  -- hardening warnings from the P0-005 close (attempt runaway, metadata
  -- bloat). Counts only — never row contents.
  SELECT min(completed_at) INTO v_oldest_completed_at
    FROM public.provider_events WHERE status = 'completed';
  SELECT count(*) INTO v_completed_expired_remaining
    FROM public.provider_events
   WHERE status = 'completed' AND completed_at < v_completed_cutoff;

  SELECT min(failed_at) INTO v_oldest_failed_at
    FROM public.provider_events WHERE status = 'failed';
  SELECT count(*) INTO v_failed_expired_remaining
    FROM public.provider_events
   WHERE status = 'failed' AND failed_at < v_failed_cutoff;

  SELECT count(*) FILTER (WHERE status = 'processing'),
         count(*) FILTER (WHERE attempts > 25),
         count(*) FILTER (WHERE pg_column_size(metadata) > 4096)
    INTO v_processing_rows, v_attempts_over_cap, v_oversized_metadata
    FROM public.provider_events;

  RETURN jsonb_build_object(
    'completed_pruned', v_completed_pruned,
    'failed_pruned', v_failed_pruned,
    'completed_expired_remaining', v_completed_expired_remaining,
    'failed_expired_remaining', v_failed_expired_remaining,
    'oldest_completed_at', v_oldest_completed_at,
    'oldest_failed_at', v_oldest_failed_at,
    'processing_rows', v_processing_rows,
    'attempts_over_cap', v_attempts_over_cap,
    'oversized_metadata', v_oversized_metadata,
    'completed_retention_days', v_completed_days,
    'failed_retention_days', v_failed_days,
    'batch_size', v_batch
  );
END;
$$;

-- Service-role only, exactly like the claim lifecycle RPCs: a session or
-- anonymous caller must never be able to erase idempotency receipts.
REVOKE ALL ON FUNCTION public.prune_provider_events(integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_provider_events(integer, integer, integer) TO service_role;

COMMENT ON FUNCTION public.prune_provider_events(integer, integer, integer) IS
  'P0-005A: batched, SKIP LOCKED prune of expired completed/failed provider_events receipts (floors 7d; processing never age-pruned). Service-role only.';
