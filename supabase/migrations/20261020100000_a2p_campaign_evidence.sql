BEGIN;
-- A2P campaign evidence and check history (October 20 evidence policy).
--
-- Evidence is a successful provider read of the campaign that returned
-- VERIFIED. The send gate opens a Gradia number only while
-- shops.a2p_status = 'approved' AND shops.a2p_verified_at is younger than the
-- maximum age (src/lib/a2p-evidence.ts: 72 hours by default, never more than
-- 7 days). A failed check never renews it.
--
-- a2p_registrations
--   last_checked_at          last successful provider read, whatever it said
--   last_verified_at         last read that returned VERIFIED
--   last_check_failed_at     last check the provider didn't answer usably
--   last_check_failure_kind  'provider_unreachable' (timeout, network, 5xx,
--                            429) or 'provider_error' (any other refusal).
--                            Never a carrier state: SUSPENDED and FAILED are
--                            statuses, not check failures.
-- shops.a2p_verified_at      the gate's copy of last_verified_at, written in
--                            the same transaction; cleared when the shop
--                            leaves 'approved'.
--
-- EXISTING DATA: no backfill. Every currently approved shop gets NULL
-- evidence, which is stale, so its texts are held until its first successful
-- status check. Count the affected shops first with
-- scripts/preflight-a2p-evidence.sql. The release lane may choose a grace
-- backfill instead; this migration does not make that choice.
--
-- Only a2p_finish_registration (the registration's claim holder) writes these
-- columns. A check that lost the claim renews nothing.
--
-- Also closes an existing bypass: the shops row policy let an owner set
-- a2p_status = 'approved' directly. Owners (authenticated, anon) may now only
-- reset it to 'unregistered' (number release) and clear a2p_verified_at.
--
-- Freshness is enforced at send time by smsGateForShop and every caller of it.
-- stage_qualification_question's SQL mirror still checks only
-- a2p_status = 'approved': staging queues an approval, it sends nothing, and
-- the executor rechecks the full gate at send.

ALTER TABLE public.a2p_registrations
  ADD COLUMN last_checked_at timestamptz,
  ADD COLUMN last_verified_at timestamptz,
  ADD COLUMN last_check_failed_at timestamptz,
  ADD COLUMN last_check_failure_kind text
    CHECK (last_check_failure_kind IN ('provider_unreachable', 'provider_error'));

ALTER TABLE public.shops ADD COLUMN a2p_verified_at timestamptz;

CREATE FUNCTION public.shops_a2p_guard() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF current_user IN ('authenticated','anon') AND (
  (TG_OP='INSERT' AND (NEW.a2p_status IS DISTINCT FROM 'unregistered' OR NEW.a2p_verified_at IS NOT NULL)) OR
  (TG_OP='UPDATE' AND (
    (NEW.a2p_status IS DISTINCT FROM OLD.a2p_status AND NEW.a2p_status IS DISTINCT FROM 'unregistered') OR
    (NEW.a2p_verified_at IS DISTINCT FROM OLD.a2p_verified_at AND NEW.a2p_verified_at IS NOT NULL)))) THEN
  RAISE EXCEPTION 'Carrier approval is server-written' USING ERRCODE='42501',DETAIL='a2p_server_written';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER shops_a2p_guard BEFORE INSERT OR UPDATE OF a2p_status, a2p_verified_at ON public.shops
 FOR EACH ROW EXECUTE FUNCTION public.shops_a2p_guard();
REVOKE ALL ON FUNCTION public.shops_a2p_guard() FROM PUBLIC, anon, authenticated;

-- Same contract as before, plus the check outcome:
--   p_check         NULL: no provider read to record (e.g. a release)
--                   'checked': a successful read that wasn't VERIFIED
--                   'verified': a successful read that returned VERIFIED;
--                               only valid when the registration ends 'approved'
--                   'failed': the provider didn't answer usably (p_failure_kind)
DROP FUNCTION public.a2p_finish_registration(uuid, uuid, text, text, jsonb);
CREATE FUNCTION public.a2p_finish_registration(
  p_shop_id uuid,
  p_token uuid,
  p_status text DEFAULT NULL,
  p_shop_status text DEFAULT NULL,
  p_patch jsonb DEFAULT '{}'::jsonb,
  p_check text DEFAULT NULL,
  p_failure_kind text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_status text;
BEGIN
  IF p_check IS NOT NULL AND p_check NOT IN ('checked', 'verified', 'failed') THEN
    RAISE EXCEPTION 'Invalid check outcome' USING ERRCODE = '22023';
  END IF;
  IF (p_check = 'failed') IS DISTINCT FROM (p_failure_kind IS NOT NULL) THEN
    RAISE EXCEPTION 'A failed check needs its kind, and only a failed check has one' USING ERRCODE = '22023';
  END IF;

  UPDATE public.a2p_registrations r
     SET status = coalesce(p_status, r.status),
         failure_reason = CASE WHEN p_patch ? 'failure_reason' THEN p_patch->>'failure_reason' ELSE r.failure_reason END,
         failed_step = CASE WHEN p_patch ? 'failed_step' THEN p_patch->>'failed_step' ELSE r.failed_step END,
         retryable = CASE WHEN p_patch ? 'retryable' THEN (p_patch->>'retryable')::boolean ELSE r.retryable END,
         campaign_sid = CASE WHEN p_patch ? 'campaign_sid' THEN p_patch->>'campaign_sid' ELSE r.campaign_sid END,
         last_checked_at = CASE WHEN p_check IN ('checked', 'verified') THEN now() ELSE r.last_checked_at END,
         last_verified_at = CASE WHEN p_check = 'verified' THEN now() ELSE r.last_verified_at END,
         last_check_failed_at = CASE WHEN p_check = 'failed' THEN now() ELSE r.last_check_failed_at END,
         last_check_failure_kind = CASE WHEN p_check = 'failed' THEN p_failure_kind ELSE r.last_check_failure_kind END,
         claim_token = NULL,
         claimed_until = NULL,
         updated_at = now()
   WHERE r.shop_id = p_shop_id
     AND r.claim_token = p_token
  RETURNING r.status INTO v_status;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF p_check = 'verified' AND v_status IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'Only an approved registration can record VERIFIED evidence' USING ERRCODE = '22023';
  END IF;

  IF p_shop_status IS NOT NULL OR p_check = 'verified' THEN
    UPDATE public.shops s
       SET a2p_status = coalesce(p_shop_status, s.a2p_status),
           a2p_verified_at = CASE
             WHEN p_check = 'verified' THEN now()
             WHEN coalesce(p_shop_status, s.a2p_status) <> 'approved' THEN NULL
             ELSE s.a2p_verified_at END
     WHERE s.id = p_shop_id;
  END IF;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.a2p_finish_registration(uuid, uuid, text, text, jsonb, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.a2p_finish_registration(uuid, uuid, text, text, jsonb, text, text) TO service_role;
COMMIT;
