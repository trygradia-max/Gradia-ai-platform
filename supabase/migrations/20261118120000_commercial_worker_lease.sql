BEGIN;

-- Commercial Billing PR F2 (sandbox/test mode only): a lease for the billing worker.
--
-- Adds objects only. No existing table, function, row, trigger or ACL is altered. Nothing
-- here calls a provider or touches a settlement, line, adjustment, subscription or account.
--
-- The worker (pending settlement dispatch, unknown-delivery reconciliation, approved
-- adjustment application) is already effect-safe per item: every line / adjustment is
-- claimed with a write-once token, a live claim is never handed out twice, and `unknown`
-- is never resent. The lease is NOT that safety. It stops two overlapping cron invocations
-- from doing the same bounded sweep at once (duplicate provider reads, duplicate
-- reconciliation evidence rows, wasted API spend). It carries no tenant data: one row per
-- worker kind, a holder token, an expiry and a fencing generation.
--
--  * commercial_worker_leases           one mutable pointer row per worker kind (fixed set)
--  * commercial_worker_lease_acquire    take the lease if free or expired (service role)
--  * commercial_worker_lease_renew      extend it, only for the current unexpired holder
--  * commercial_worker_lease_release    hand it back with a finite outcome (current holder only)
--  * commercial_worker_lease_read       operator view (service role)

DO $$
BEGIN
  IF to_regprocedure('public.commercial_billing_require_service()') IS NULL
     OR to_regclass('public.commercial_settlement_lines') IS NULL THEN
    RAISE EXCEPTION 'PR C and PR D billing objects are required' USING ERRCODE='23514';
  END IF;
END $$;

CREATE TABLE public.commercial_worker_leases (
  worker text PRIMARY KEY CHECK (worker IN ('settlement_dispatch', 'delivery_reconcile', 'adjustment_apply')),
  holder_token uuid,
  lease_until timestamptz,
  -- Advances on every acquisition: a fencing counter, so a stale holder is detectable.
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_outcome text CHECK (last_outcome IS NULL OR last_outcome IN
    ('completed', 'partial', 'failed', 'sandbox_not_ready', 'worker_misconfigured')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((holder_token IS NULL) = (lease_until IS NULL))
);

INSERT INTO public.commercial_worker_leases (worker)
VALUES ('settlement_dispatch'), ('delivery_reconcile'), ('adjustment_apply');

-- The fixed worker set is the whole table: rows are never deleted or renamed.
CREATE FUNCTION public.commercial_worker_leases_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'Worker leases cannot be deleted' USING ERRCODE='42501';
  END IF;
  IF NEW.worker IS DISTINCT FROM OLD.worker THEN
    RAISE EXCEPTION 'Worker lease identity is immutable' USING ERRCODE='42501';
  END IF;
  IF NEW.generation < OLD.generation THEN
    RAISE EXCEPTION 'Worker lease generation only moves forward' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commercial_worker_leases_guard
  BEFORE UPDATE OR DELETE ON public.commercial_worker_leases
  FOR EACH ROW EXECUTE FUNCTION public.commercial_worker_leases_guard();
CREATE TRIGGER commercial_worker_leases_no_truncate
  BEFORE TRUNCATE ON public.commercial_worker_leases
  FOR EACH STATEMENT EXECUTE FUNCTION public.commercial_worker_leases_guard();

CREATE FUNCTION public.commercial_worker_lease_acquire(p_worker text, p_ttl_seconds integer DEFAULT 300) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  l public.commercial_worker_leases%ROWTYPE;
  v_ttl integer := greatest(30, least(coalesce(p_ttl_seconds, 300), 900));
  v_now timestamptz := clock_timestamp();
  v_token uuid;
BEGIN
  PERFORM public.commercial_billing_require_service();
  SELECT * INTO l FROM public.commercial_worker_leases WHERE worker = p_worker FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown worker' USING ERRCODE='22023';
  END IF;
  IF l.holder_token IS NOT NULL AND l.lease_until > v_now THEN
    RETURN jsonb_build_object('acquired', false, 'reason', 'lease_held',
      'retry_after_seconds', greatest(1, ceil(extract(epoch FROM (l.lease_until - v_now)))::integer));
  END IF;
  v_token := gen_random_uuid();
  UPDATE public.commercial_worker_leases
     SET holder_token = v_token, lease_until = v_now + make_interval(secs => v_ttl),
         generation = generation + 1, last_started_at = v_now, updated_at = v_now
   WHERE worker = p_worker;
  RETURN jsonb_build_object('acquired', true, 'token', v_token, 'generation', l.generation + 1,
    'expired_prior_holder', l.holder_token IS NOT NULL);
END $$;

CREATE FUNCTION public.commercial_worker_lease_renew(p_worker text, p_token uuid, p_ttl_seconds integer DEFAULT 300) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  l public.commercial_worker_leases%ROWTYPE;
  v_ttl integer := greatest(30, least(coalesce(p_ttl_seconds, 300), 900));
  v_now timestamptz := clock_timestamp();
BEGIN
  PERFORM public.commercial_billing_require_service();
  SELECT * INTO l FROM public.commercial_worker_leases WHERE worker = p_worker FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown worker' USING ERRCODE='22023';
  END IF;
  -- Only the current holder, and only while the lease is still valid: an expired holder must stop.
  IF p_token IS NULL OR l.holder_token IS DISTINCT FROM p_token OR l.lease_until <= v_now THEN
    RETURN jsonb_build_object('renewed', false);
  END IF;
  UPDATE public.commercial_worker_leases SET lease_until = v_now + make_interval(secs => v_ttl), updated_at = v_now
   WHERE worker = p_worker;
  RETURN jsonb_build_object('renewed', true);
END $$;

CREATE FUNCTION public.commercial_worker_lease_release(p_worker text, p_token uuid, p_outcome text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  l public.commercial_worker_leases%ROWTYPE;
  v_now timestamptz := clock_timestamp();
BEGIN
  PERFORM public.commercial_billing_require_service();
  IF p_outcome IS NULL OR p_outcome NOT IN ('completed', 'partial', 'failed', 'sandbox_not_ready', 'worker_misconfigured') THEN
    RAISE EXCEPTION 'Invalid worker outcome' USING ERRCODE='22023';
  END IF;
  SELECT * INTO l FROM public.commercial_worker_leases WHERE worker = p_worker FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown worker' USING ERRCODE='22023';
  END IF;
  -- A holder whose lease was taken over (or who never held it) changes nothing.
  IF p_token IS NULL OR l.holder_token IS DISTINCT FROM p_token THEN
    RETURN jsonb_build_object('released', false);
  END IF;
  UPDATE public.commercial_worker_leases
     SET holder_token = NULL, lease_until = NULL, last_finished_at = v_now, last_outcome = p_outcome, updated_at = v_now
   WHERE worker = p_worker;
  RETURN jsonb_build_object('released', true);
END $$;

CREATE FUNCTION public.commercial_worker_lease_read() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM public.commercial_billing_require_service();
  -- The holder token is a bearer secret for the lease: it is never returned.
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object(
      'worker', worker, 'held', holder_token IS NOT NULL AND lease_until > clock_timestamp(),
      'generation', generation, 'last_started_at', last_started_at, 'last_finished_at', last_finished_at,
      'last_outcome', last_outcome) ORDER BY worker), '[]'::jsonb)
    FROM public.commercial_worker_leases);
END $$;

ALTER TABLE public.commercial_worker_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.commercial_worker_leases FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.commercial_worker_leases TO service_role;

REVOKE ALL ON FUNCTION
  public.commercial_worker_leases_guard(),
  public.commercial_worker_lease_acquire(text, integer),
  public.commercial_worker_lease_renew(text, uuid, integer),
  public.commercial_worker_lease_release(text, uuid, text),
  public.commercial_worker_lease_read()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.commercial_worker_lease_acquire(text, integer),
  public.commercial_worker_lease_renew(text, uuid, integer),
  public.commercial_worker_lease_release(text, uuid, text),
  public.commercial_worker_lease_read()
  TO service_role;

COMMIT;
