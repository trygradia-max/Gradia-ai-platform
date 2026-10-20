BEGIN;
-- A2P registration: single-flight claim and atomic status writes.
-- (Twilio review of October 19, findings R1 and R2.)
--
-- claim_token / claimed_until
--   A lease taken with a compare-and-swap before ANY provider call. Only the
--   holder may checkpoint or change status, so a double submit or two
--   concurrent status checks make one set of Twilio resources, not two.
--   The lease outlives the longest server function run, so a crashed holder
--   only delays the next attempt; it never lets two run at once.
-- a2p_finish_registration
--   Writes a2p_registrations.status and shops.a2p_status in one transaction
--   and releases the claim, so the two can no longer disagree after a crash.
-- Additive; no data rewritten. Server-only: execute is granted to
-- service_role alone.

ALTER TABLE public.a2p_registrations
  ADD COLUMN claim_token uuid,
  ADD COLUMN claimed_until timestamptz;

-- Takes the claim if the row is in one of p_statuses and nobody holds a live
-- lease. Returns the new token, or NULL when the claim was not taken.
CREATE OR REPLACE FUNCTION public.a2p_claim_registration(
  p_shop_id uuid,
  p_statuses text[],
  p_lease_seconds integer
) RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_token uuid := gen_random_uuid();
BEGIN
  UPDATE public.a2p_registrations
     SET claim_token = v_token,
         claimed_until = now() + make_interval(secs => p_lease_seconds)
   WHERE shop_id = p_shop_id
     AND status = ANY (p_statuses)
     AND (claim_token IS NULL OR claimed_until < now());
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN v_token;
END;
$$;

-- Releases the claim held by p_token and, in the same transaction, applies
-- the listed fields of p_patch, the registration status (NULL keeps it) and
-- the shop's gate status (NULL keeps it). Returns false, changing nothing,
-- when p_token no longer holds the claim.
CREATE OR REPLACE FUNCTION public.a2p_finish_registration(
  p_shop_id uuid,
  p_token uuid,
  p_status text DEFAULT NULL,
  p_shop_status text DEFAULT NULL,
  p_patch jsonb DEFAULT '{}'::jsonb
) RETURNS boolean
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  UPDATE public.a2p_registrations r
     SET status = coalesce(p_status, r.status),
         failure_reason = CASE WHEN p_patch ? 'failure_reason' THEN p_patch->>'failure_reason' ELSE r.failure_reason END,
         failed_step = CASE WHEN p_patch ? 'failed_step' THEN p_patch->>'failed_step' ELSE r.failed_step END,
         retryable = CASE WHEN p_patch ? 'retryable' THEN (p_patch->>'retryable')::boolean ELSE r.retryable END,
         campaign_sid = CASE WHEN p_patch ? 'campaign_sid' THEN p_patch->>'campaign_sid' ELSE r.campaign_sid END,
         claim_token = NULL,
         claimed_until = NULL,
         updated_at = now()
   WHERE r.shop_id = p_shop_id
     AND r.claim_token = p_token;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF p_shop_status IS NOT NULL THEN
    UPDATE public.shops SET a2p_status = p_shop_status WHERE id = p_shop_id;
  END IF;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.a2p_claim_registration(uuid, text[], integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.a2p_finish_registration(uuid, uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.a2p_claim_registration(uuid, text[], integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.a2p_finish_registration(uuid, uuid, text, text, jsonb) TO service_role;
COMMIT;
