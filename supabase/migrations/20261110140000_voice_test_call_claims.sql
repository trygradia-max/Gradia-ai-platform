BEGIN;
-- Security audit run-1, finding #6: requestVoiceTestCall could place outbound Vapi calls to any +1
-- number with no entitlement, budget, rate or destination-ownership proof.
--
-- This migration adds ONLY the durable, atomic rate / concurrency claim that the application guard
-- (src/lib/voice-test-call.ts) takes immediately before the provider call. Entitlement, readiness,
-- budget and the verified destination are rechecked in application code around it; the entitlement
-- is ALSO rechecked here under the shop row lock so a cancellation that lands between the
-- application check and the claim cannot be missed.
--
--   * One in-flight attempt per shop (claimed and younger than p_inflight_seconds).
--   * A minimum interval between attempts.
--   * A per-hour and a per-day ceiling. Every attempt counts, including failed and aborted ones,
--     so a provider outage or a scripted retry loop cannot widen the ceiling.
--
-- The table holds no phone number (only the last four digits, for support) and is service-role
-- only: RLS is on with no policy, and every grant to anon/authenticated is revoked.
CREATE TABLE public.voice_test_call_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
 user_id uuid NOT NULL,
 destination_last4 text NOT NULL CHECK (destination_last4 ~ '^[0-9]{4}$'),
 status text NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed','dispatched','failed','aborted')),
 created_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz
);
CREATE INDEX voice_test_call_attempts_shop_created_idx ON public.voice_test_call_attempts (shop_id, created_at DESC);
ALTER TABLE public.voice_test_call_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.voice_test_call_attempts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.voice_test_call_attempts TO service_role;

CREATE FUNCTION public.voice_test_call_claim(
 p_shop_id uuid,
 p_user_id uuid,
 p_destination_last4 text,
 p_min_interval_seconds integer,
 p_inflight_seconds integer,
 p_hour_limit integer,
 p_day_limit integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 v_shop public.shops%ROWTYPE;
 v_now timestamptz := clock_timestamp();
 v_last timestamptz;
 v_id uuid;
BEGIN
 IF p_min_interval_seconds < 0 OR p_inflight_seconds < 1 OR p_hour_limit < 1 OR p_day_limit < 1 THEN
  RAISE EXCEPTION 'invalid limits' USING ERRCODE='22023';
 END IF;

 -- The row lock serializes every concurrent claim for this shop (and a plan change in flight).
 SELECT * INTO v_shop FROM public.shops WHERE id = p_shop_id AND owner_id = p_user_id FOR UPDATE;
 IF NOT FOUND THEN
  RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
 END IF;
 IF v_shop.plan IS DISTINCT FROM 'active' OR v_shop.voice_addon IS DISTINCT FROM true THEN
  RETURN jsonb_build_object('ok', false, 'reason', 'not_entitled');
 END IF;

 IF EXISTS (
  SELECT 1 FROM public.voice_test_call_attempts
  WHERE shop_id = p_shop_id AND status = 'claimed' AND created_at > v_now - make_interval(secs => p_inflight_seconds)
 ) THEN
  RETURN jsonb_build_object('ok', false, 'reason', 'in_progress', 'retry_after_seconds', p_inflight_seconds);
 END IF;

 SELECT max(created_at) INTO v_last FROM public.voice_test_call_attempts WHERE shop_id = p_shop_id;
 IF v_last IS NOT NULL AND v_last > v_now - make_interval(secs => p_min_interval_seconds) THEN
  RETURN jsonb_build_object('ok', false, 'reason', 'too_soon',
   'retry_after_seconds', ceil(extract(epoch FROM (v_last + make_interval(secs => p_min_interval_seconds) - v_now)))::int);
 END IF;

 IF (SELECT count(*) FROM public.voice_test_call_attempts WHERE shop_id = p_shop_id AND created_at > v_now - interval '1 hour') >= p_hour_limit
  OR (SELECT count(*) FROM public.voice_test_call_attempts WHERE shop_id = p_shop_id AND created_at > v_now - interval '1 day') >= p_day_limit THEN
  RETURN jsonb_build_object('ok', false, 'reason', 'rate_limited');
 END IF;

 INSERT INTO public.voice_test_call_attempts (shop_id, user_id, destination_last4, created_at)
 VALUES (p_shop_id, p_user_id, p_destination_last4, v_now)
 RETURNING id INTO v_id;
 RETURN jsonb_build_object('ok', true, 'attempt_id', v_id);
END $$;
REVOKE ALL ON FUNCTION public.voice_test_call_claim(uuid, uuid, text, integer, integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.voice_test_call_claim(uuid, uuid, text, integer, integer, integer, integer) TO service_role;
COMMIT;
