-- P0-005 — Webhook event idempotency foundation (ADR-001, D-023).
--
-- ONE durable mechanism for provider-event idempotency, DB-enforced:
--
--   1. usage_events: partial unique on (shop_id, kind, vendor_ref) — a
--      retried provider webhook (Vapi end-of-call, Twilio callback) can
--      never double-meter. `outreach_draft` is excluded: the recovery
--      extraction pipeline historically wrote MANY legitimate rows per
--      job under one vendor_ref = jobId; those financial rows are
--      immutable (D-024) so they cannot be rewritten to satisfy a unique.
--      New extraction writes use per-row refs (jobId:rowId) — a follow-up
--      extends coverage once only per-row refs remain.
--
--   2. automation_runs: partial unique on (automation_id, trigger_ref) —
--      kills the check-then-insert double-fire race under overlapping
--      crons. automation_id is already tenant-scoped (automations is
--      UNIQUE (shop_id, catalog_key)), so tenants cannot collide.
--      'failed' rows are excluded so a failed attempt never blocks a
--      later retry (previously a failure left no row at all — same
--      semantics, now with a durable failure record). Writers claim the
--      run row FIRST (status 'staged'), then stage/send, then transition
--      that same row — see src/lib/automations.ts.
--
--   3. provider_events: the central claim table for multi-table inbound
--      webhook events (one inbound SMS/email/call fans out into
--      interactions + pending_actions + consent + LLM spend — no single
--      natural row to hang a unique on). Handlers claim
--      (provider, event_id) BEFORE any side effect; duplicates and
--      concurrent deliveries lose the claim and exit clean. Consumed by
--      P0-006 (Twilio) / P0-007 (Vapi); no route is wired here.
--
--      event_id contract: globally unique within its provider namespace.
--      Twilio MessageSid / Vapi call.id qualify as-is; per-account ids
--      (Aurinko) MUST be prefixed by the caller ("<accountId>:<id>").
--
--      Service-role only: RLS enabled with NO policies (rate_limits
--      pattern) and EXECUTE revoked from anon/authenticated, so an
--      unauthenticated or session caller can never insert/claim — a
--      forged request cannot poison a legitimate event id.
--
-- Idempotent; additive only. Duplicate audit ran before index creation
-- (see P0-005 completion report). Rollback: supabase/rollbacks/
-- 20260812_p0_005_down.sql (kept unapplied).

-- 1. usage_events metering idempotency ---------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS usage_events_vendor_ref_unique
  ON public.usage_events (shop_id, kind, vendor_ref)
  WHERE vendor_ref IS NOT NULL AND kind <> 'outreach_draft';

-- 2. automation_runs double-fire guard ---------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS automation_runs_trigger_ref_unique
  ON public.automation_runs (automation_id, trigger_ref)
  WHERE trigger_ref IS NOT NULL AND status <> 'failed';

-- 3. provider_events claim table ---------------------------------------
CREATE TABLE IF NOT EXISTS public.provider_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  event_id text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 512),
  -- Nullable: a valid event whose tenant cannot be resolved yet still
  -- claims (the retry would hit the same resolution failure). ON DELETE
  -- CASCADE matches every other shop-scoped table.
  shop_id uuid REFERENCES public.shops (id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  failed_at timestamptz,
  -- Sanitized + truncated by the claiming code. NEVER raw payloads,
  -- headers, tokens, or signatures.
  last_error text,
  metadata jsonb NOT NULL DEFAULT '{}',
  UNIQUE (provider, event_id)
);

-- Lookup patterns: the unique carries (provider, event_id); shop-scoped
-- debugging/pruning reads use these.
CREATE INDEX IF NOT EXISTS provider_events_shop_idx
  ON public.provider_events (shop_id, first_seen_at DESC)
  WHERE shop_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS provider_events_status_idx
  ON public.provider_events (status, last_attempt_at)
  WHERE status <> 'completed';

-- Deny-all RLS: service-role only, like rate_limits. No policies on
-- purpose — anon/authenticated can neither read nor write claims.
ALTER TABLE public.provider_events ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.provider_events IS
  'P0-005 webhook idempotency claims (ADR-001). One row per (provider, event_id); claim-before-process; service-role only.';

-- 4. Claim lifecycle RPCs ----------------------------------------------
-- claim_provider_event: the atomic insert-first claim.
--   Outcomes (jsonb {outcome, id, attempts}):
--     'claimed'              — first delivery; caller must process.
--     'reclaimed_failed'     — prior attempt failed; caller retries.
--     'reclaimed_stale'      — prior claim crashed (processing longer than
--                              p_stale_after_seconds); caller retries.
--     'duplicate_completed'  — already fully processed; caller exits.
--     'duplicate_processing' — another instance is actively processing;
--                              caller exits (that instance owns it).
--   Concurrency proof: INSERT .. ON CONFLICT DO NOTHING means exactly one
--   concurrent caller inserts; every loser row-locks the winner's row
--   (SELECT .. FOR UPDATE) and sees status 'processing' with a fresh
--   last_attempt_at → 'duplicate_processing'. Two stale/failed reclaims
--   serialize on the same row lock; the second sees the first's fresh
--   last_attempt_at and returns 'duplicate_processing'. Locks are
--   transaction-bounded (RPC = one transaction) — released on any error.
--   Callers keep provider/network work OUTSIDE this function.
CREATE OR REPLACE FUNCTION public.claim_provider_event(
  p_provider text,
  p_event_id text,
  p_shop_id uuid DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}',
  p_stale_after_seconds integer DEFAULT 300,
  p_retry_failed boolean DEFAULT true
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_row public.provider_events%ROWTYPE;
BEGIN
  IF p_provider IS NULL OR length(trim(p_provider)) = 0
     OR p_event_id IS NULL OR length(trim(p_event_id)) = 0 THEN
    RAISE EXCEPTION 'claim_provider_event: provider and event_id are required';
  END IF;

  INSERT INTO public.provider_events (provider, event_id, shop_id, metadata)
  VALUES (p_provider, p_event_id, p_shop_id, COALESCE(p_metadata, '{}'::jsonb))
  ON CONFLICT (provider, event_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'claimed', 'id', v_id, 'attempts', 1);
  END IF;

  -- Duplicate delivery: serialize on the existing row and decide.
  SELECT * INTO v_row
    FROM public.provider_events
   WHERE provider = p_provider AND event_id = p_event_id
   FOR UPDATE;

  IF NOT FOUND THEN
    -- Vanishingly rare (row deleted between conflict and lock, e.g. shop
    -- cascade). Treat as a fresh claim.
    INSERT INTO public.provider_events (provider, event_id, shop_id, metadata)
    VALUES (p_provider, p_event_id, p_shop_id, COALESCE(p_metadata, '{}'::jsonb))
    ON CONFLICT (provider, event_id) DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NOT NULL THEN
      RETURN jsonb_build_object('outcome', 'claimed', 'id', v_id, 'attempts', 1);
    END IF;
    RETURN jsonb_build_object('outcome', 'duplicate_processing', 'id', NULL, 'attempts', 0);
  END IF;

  IF v_row.status = 'completed' THEN
    RETURN jsonb_build_object(
      'outcome', 'duplicate_completed', 'id', v_row.id, 'attempts', v_row.attempts);
  END IF;

  IF v_row.status = 'failed' AND p_retry_failed THEN
    UPDATE public.provider_events
       SET status = 'processing',
           attempts = attempts + 1,
           last_attempt_at = now(),
           failed_at = NULL,
           shop_id = COALESCE(shop_id, p_shop_id)
     WHERE id = v_row.id;
    RETURN jsonb_build_object(
      'outcome', 'reclaimed_failed', 'id', v_row.id, 'attempts', v_row.attempts + 1);
  END IF;

  IF v_row.status = 'processing'
     AND v_row.last_attempt_at < now() - make_interval(secs => GREATEST(p_stale_after_seconds, 1)) THEN
    -- The claiming instance crashed without completing or failing — the
    -- provider's retry takes the claim over so no event is stranded.
    UPDATE public.provider_events
       SET attempts = attempts + 1,
           last_attempt_at = now(),
           shop_id = COALESCE(shop_id, p_shop_id)
     WHERE id = v_row.id;
    RETURN jsonb_build_object(
      'outcome', 'reclaimed_stale', 'id', v_row.id, 'attempts', v_row.attempts + 1);
  END IF;

  -- Actively processing (or failed with retries disabled): not ours.
  RETURN jsonb_build_object(
    'outcome',
    CASE WHEN v_row.status = 'failed' THEN 'duplicate_failed' ELSE 'duplicate_processing' END,
    'id', v_row.id, 'attempts', v_row.attempts);
END;
$$;

-- complete_provider_event: terminal success. Returns true when a
-- processing row was marked; false when no processing row matched (never
-- silently converts a completed/failed row).
CREATE OR REPLACE FUNCTION public.complete_provider_event(
  p_provider text,
  p_event_id text
) RETURNS boolean
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  UPDATE public.provider_events
     SET status = 'completed', completed_at = now(), last_error = NULL
   WHERE provider = p_provider AND event_id = p_event_id
     AND status = 'processing'
  RETURNING id INTO v_id;
  RETURN v_id IS NOT NULL;
END;
$$;

-- fail_provider_event: terminal (retryable) failure. The error text must
-- arrive sanitized; truncated defensively here so oversized messages can
-- never bloat the row. Never flips a completed row back.
CREATE OR REPLACE FUNCTION public.fail_provider_event(
  p_provider text,
  p_event_id text,
  p_error text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  UPDATE public.provider_events
     SET status = 'failed', failed_at = now(), last_error = left(p_error, 500)
   WHERE provider = p_provider AND event_id = p_event_id
     AND status = 'processing'
  RETURNING id INTO v_id;
  RETURN v_id IS NOT NULL;
END;
$$;

-- Service-role only: webhooks run with the service client; sessions and
-- anonymous callers must never be able to claim (poison) an event id.
REVOKE ALL ON FUNCTION public.claim_provider_event(text, text, uuid, jsonb, integer, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_provider_event(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_provider_event(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_provider_event(text, text, uuid, jsonb, integer, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_provider_event(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_provider_event(text, text, text) TO service_role;
