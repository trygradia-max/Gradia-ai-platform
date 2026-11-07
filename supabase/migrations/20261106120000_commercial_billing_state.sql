BEGIN;

-- Commercial billing state (Commercial Billing PR C, sandbox/test mode only).
--
-- Tenant-bound PLATFORM billing state for the founder-approved Founder Pilot,
-- separate from every shop's Stripe Connect account. This migration only ADDS
-- objects: no shops, memberships, usage, commercial usage or membership billing
-- row is read for rewriting, altered or backfilled.
--
--  * commercial_billing_accounts — ONE mutable current-pointer row per shop
--    (platform customer, state, current attempt, current subscription evidence).
--    It may advance atomically; history lives in the append-only tables below.
--  * commercial_checkout_attempts — one row per Checkout request. Identity and
--    request fingerprint are immutable; only a forward-only status and a
--    write-once provider session id may advance. At most ONE attempt per shop
--    may be in flight (partial unique index), so concurrent requests cannot
--    create two local authorities.
--  * commercial_billing_events — append-only audit trail of every transition.
--    Details are bounded and refuse URLs and secret-shaped text.
--  * commercial_subscription_evidence — append-only provider subscription
--    evidence. Only a signed-webhook (PR E) or reviewed reconciliation source is
--    representable; a browser redirect or client assertion is not.
--  * Live mode is unrepresentable: provider_mode and livemode are CHECKed to test.
--  * Browser roles have no table or function access. The service role may read
--    and may call the writer functions, which re-derive LIVE OWNER authority for
--    the named actor inside the database. Owners read their own state through an
--    authority-checked function; managers, staff, revoked, anonymous and
--    cross-shop callers are refused.

-- The approved catalog version this state is bound to must already be registered
-- by PR A (commercial_catalog_versions is immutable).
-- Fail loudly rather than silently registering a catalog here.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.commercial_catalog_versions WHERE version = '2026-11-03.v1') THEN
    RAISE EXCEPTION 'Approved catalog 2026-11-03.v1 is not registered' USING ERRCODE='23514';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Current pointer (mutable, atomic)
-- ---------------------------------------------------------------------------
CREATE TABLE public.commercial_billing_accounts (
  shop_id uuid PRIMARY KEY REFERENCES public.shops(id) ON DELETE CASCADE,
  catalog_version text NOT NULL REFERENCES public.commercial_catalog_versions(version),
  plan_key text NOT NULL CHECK (plan_key = 'founder-pilot'),
  provider_mode text NOT NULL DEFAULT 'test' CHECK (provider_mode = 'test'),
  -- PLATFORM customer only. A Connect account id (acct_) can never be stored here.
  platform_customer_id text UNIQUE CHECK (platform_customer_id ~ '^cus_[A-Za-z0-9_]{4,120}$'),
  state text NOT NULL CHECK (state IN (
    'unconfigured', 'checkout_required', 'checkout_pending', 'active', 'past_due',
    'canceled', 'incomplete', 'unknown', 'reconciliation_required')),
  state_reason text CHECK (state_reason IS NULL OR state_reason ~ '^[a-z][a-z0-9_]{2,63}$'),
  current_attempt_id uuid,
  current_evidence_id uuid,
  last_event_ref text,
  last_event_created_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- ---------------------------------------------------------------------------
-- Checkout attempts (immutable identity; forward-only status)
-- ---------------------------------------------------------------------------
CREATE TABLE public.commercial_checkout_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  catalog_version text NOT NULL REFERENCES public.commercial_catalog_versions(version),
  plan_key text NOT NULL CHECK (plan_key = 'founder-pilot'),
  price_lookup_key text NOT NULL CHECK (price_lookup_key = 'gradia_founder_pilot_2026_11_monthly'),
  return_target text NOT NULL CHECK (return_target IN ('agents', 'billing')),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  requested_by uuid NOT NULL,
  status text NOT NULL DEFAULT 'started' CHECK (status IN (
    'started', 'session_open', 'completed_unverified', 'expired', 'rejected', 'unknown')),
  provider_session_id text CHECK (provider_session_id ~ '^cs_test_[A-Za-z0-9_]{4,200}$'),
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z][a-z0-9_]{2,63}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  status_changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (shop_id, attempt_no),
  UNIQUE (shop_id, id),
  CHECK ((status IN ('session_open', 'completed_unverified')) = (provider_session_id IS NOT NULL)
         OR status IN ('expired', 'unknown')),
  CHECK ((status IN ('rejected', 'unknown')) = (failure_code IS NOT NULL))
);
-- At most one in-flight attempt per shop: concurrent requests cannot both create
-- a local authority or a duplicate Checkout Session.
CREATE UNIQUE INDEX commercial_checkout_attempts_one_open
  ON public.commercial_checkout_attempts (shop_id)
  WHERE status IN ('started', 'session_open');
CREATE UNIQUE INDEX commercial_checkout_attempts_session_uniq
  ON public.commercial_checkout_attempts (provider_session_id)
  WHERE provider_session_id IS NOT NULL;

ALTER TABLE public.commercial_billing_accounts
  ADD FOREIGN KEY (shop_id, current_attempt_id) REFERENCES public.commercial_checkout_attempts(shop_id, id);

-- ---------------------------------------------------------------------------
-- Append-only audit events
-- ---------------------------------------------------------------------------
CREATE TABLE public.commercial_billing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  shop_seq bigint NOT NULL CHECK (shop_seq > 0),
  kind text NOT NULL CHECK (kind IN (
    'account_opened', 'checkout_attempt_started', 'customer_bound', 'session_created',
    'session_observed_open', 'session_completed_unverified', 'session_expired',
    'attempt_rejected', 'provider_outcome_unknown', 'stale_attempt_marked_unknown',
    'subscription_evidence_applied', 'subscription_evidence_not_current',
    'reconciliation_required')),
  attempt_id uuid,
  actor_id uuid,
  state_after text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(details) = 'object' AND length(details::text) <= 2000
           -- No URL (Checkout links are bearer-like), no key-shaped text, no payload dumps.
           AND details::text !~* '(https?:|sk_(live|test)|rk_(live|test)|whsec_|client_secret)'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (shop_id, shop_seq),
  FOREIGN KEY (shop_id, attempt_id) REFERENCES public.commercial_checkout_attempts(shop_id, id)
);
CREATE INDEX commercial_billing_events_attempt_idx
  ON public.commercial_billing_events (shop_id, attempt_id, shop_seq);

-- ---------------------------------------------------------------------------
-- Append-only provider subscription evidence
-- ---------------------------------------------------------------------------
CREATE TABLE public.commercial_subscription_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  provider_subscription_id text NOT NULL CHECK (provider_subscription_id ~ '^sub_[A-Za-z0-9_]{4,120}$'),
  provider_customer_id text NOT NULL CHECK (provider_customer_id ~ '^cus_[A-Za-z0-9_]{4,120}$'),
  provider_status text NOT NULL CHECK (provider_status IN (
    'incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused')),
  -- Finite state this evidence implies. Anything unrecognized is 'unknown', never 'active'.
  derived_state text NOT NULL CHECK (derived_state IN (
    'active', 'past_due', 'canceled', 'incomplete', 'unknown', 'reconciliation_required')),
  catalog_version text NOT NULL,
  plan_key text NOT NULL,
  price_lookup_key text NOT NULL,
  evidence_source text NOT NULL CHECK (evidence_source IN ('signed_webhook', 'reviewed_reconciliation')),
  source_event_id text NOT NULL CHECK (source_event_id ~ '^[A-Za-z0-9_.:-]{8,200}$'),
  source_event_created_at timestamptz NOT NULL,
  livemode boolean NOT NULL CHECK (livemode = false),
  attempt_id uuid,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (shop_id, source_event_id),
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, attempt_id) REFERENCES public.commercial_checkout_attempts(shop_id, id),
  -- Active evidence can only exist for provider status 'active'.
  CHECK (derived_state <> 'active' OR provider_status = 'active')
);
CREATE INDEX commercial_subscription_evidence_sub_idx
  ON public.commercial_subscription_evidence (shop_id, provider_subscription_id, source_event_created_at);

ALTER TABLE public.commercial_billing_accounts
  ADD FOREIGN KEY (shop_id, current_evidence_id) REFERENCES public.commercial_subscription_evidence(shop_id, id);

-- ---------------------------------------------------------------------------
-- Immutability guards
-- ---------------------------------------------------------------------------
CREATE TRIGGER commercial_billing_events_append_only
  BEFORE UPDATE OR DELETE ON public.commercial_billing_events
  FOR EACH ROW EXECUTE FUNCTION public.commercial_usage_append_only();
CREATE TRIGGER commercial_subscription_evidence_append_only
  BEFORE UPDATE OR DELETE ON public.commercial_subscription_evidence
  FOR EACH ROW EXECUTE FUNCTION public.commercial_usage_append_only();
CREATE TRIGGER commercial_billing_events_no_truncate
  BEFORE TRUNCATE ON public.commercial_billing_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.commercial_usage_append_only();
CREATE TRIGGER commercial_subscription_evidence_no_truncate
  BEFORE TRUNCATE ON public.commercial_subscription_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION public.commercial_usage_append_only();
CREATE TRIGGER commercial_checkout_attempts_no_truncate
  BEFORE TRUNCATE ON public.commercial_checkout_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION public.commercial_usage_append_only();
CREATE TRIGGER commercial_billing_accounts_no_truncate
  BEFORE TRUNCATE ON public.commercial_billing_accounts
  FOR EACH STATEMENT EXECUTE FUNCTION public.commercial_usage_append_only();

-- Attempts: identity is immutable; status moves forward only; the provider session
-- id is write-once; rows are never deleted (only the shop-deletion cascade).
CREATE FUNCTION public.commercial_checkout_attempts_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.shops WHERE id = OLD.shop_id) THEN
      RAISE EXCEPTION 'Checkout attempts cannot be deleted' USING ERRCODE='42501';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.id, NEW.shop_id, NEW.attempt_no, NEW.catalog_version, NEW.plan_key, NEW.price_lookup_key,
      NEW.return_target, NEW.request_fingerprint, NEW.requested_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.shop_id, OLD.attempt_no, OLD.catalog_version, OLD.plan_key, OLD.price_lookup_key,
      OLD.return_target, OLD.request_fingerprint, OLD.requested_by, OLD.created_at) THEN
    RAISE EXCEPTION 'Checkout attempt identity is immutable' USING ERRCODE='42501';
  END IF;
  IF OLD.provider_session_id IS NOT NULL AND NEW.provider_session_id IS DISTINCT FROM OLD.provider_session_id THEN
    RAISE EXCEPTION 'Provider session id is write-once' USING ERRCODE='42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'started' AND NEW.status IN ('session_open', 'rejected', 'unknown'))
    OR (OLD.status = 'session_open' AND NEW.status IN ('completed_unverified', 'expired', 'unknown'))
    OR (OLD.status = 'completed_unverified' AND NEW.status = 'unknown')) THEN
    RAISE EXCEPTION 'Checkout attempt status only moves forward' USING ERRCODE='42501';
  END IF;
  IF NEW.status = OLD.status AND (NEW.provider_session_id, NEW.failure_code) IS DISTINCT FROM (OLD.provider_session_id, OLD.failure_code) THEN
    RAISE EXCEPTION 'Checkout attempt evidence is immutable within a status' USING ERRCODE='42501';
  END IF;
  NEW.status_changed_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER commercial_checkout_attempts_guard
  BEFORE UPDATE OR DELETE ON public.commercial_checkout_attempts
  FOR EACH ROW EXECUTE FUNCTION public.commercial_checkout_attempts_guard();

-- The account row is the only mutable pointer. Its tenant, catalog and plan
-- binding is fixed; the platform customer id binds once; version only increases.
CREATE FUNCTION public.commercial_billing_accounts_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.shops WHERE id = OLD.shop_id) THEN
      RAISE EXCEPTION 'Commercial billing accounts cannot be deleted' USING ERRCODE='42501';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.shop_id, NEW.catalog_version, NEW.plan_key, NEW.provider_mode, NEW.created_at)
     IS DISTINCT FROM (OLD.shop_id, OLD.catalog_version, OLD.plan_key, OLD.provider_mode, OLD.created_at) THEN
    RAISE EXCEPTION 'Commercial billing account binding is immutable' USING ERRCODE='42501';
  END IF;
  IF OLD.platform_customer_id IS NOT NULL AND NEW.platform_customer_id IS DISTINCT FROM OLD.platform_customer_id THEN
    RAISE EXCEPTION 'Platform customer binding is write-once' USING ERRCODE='42501';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Account version must advance by exactly one' USING ERRCODE='42501';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER commercial_billing_accounts_guard
  BEFORE UPDATE OR DELETE ON public.commercial_billing_accounts
  FOR EACH ROW EXECUTE FUNCTION public.commercial_billing_accounts_guard();

-- ---------------------------------------------------------------------------
-- Table privileges: RLS on, no browser role access, service role reads only.
-- ---------------------------------------------------------------------------
ALTER TABLE public.commercial_billing_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commercial_checkout_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commercial_billing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commercial_subscription_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.commercial_billing_accounts, public.commercial_checkout_attempts,
  public.commercial_billing_events, public.commercial_subscription_evidence
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.commercial_billing_accounts, public.commercial_checkout_attempts,
  public.commercial_billing_events, public.commercial_subscription_evidence TO service_role;

-- ---------------------------------------------------------------------------
-- Authority helpers
-- ---------------------------------------------------------------------------
-- Live owner authority for a NAMED actor (service-role writers pass a
-- server-derived actor; the database still re-verifies membership each call).
CREATE FUNCTION public.commercial_billing_actor_is_owner(p_shop uuid, p_actor uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT p_shop IS NOT NULL AND p_actor IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.shop_memberships m
    WHERE m.shop_id = p_shop AND m.user_id = p_actor AND m.role = 'owner' AND m.active);
$$;

CREATE FUNCTION public.commercial_billing_require_service() RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE='42501';
  END IF;
END $$;

-- Append one audit event under the account row lock (caller holds it).
CREATE FUNCTION public.commercial_billing_emit(
  p_shop uuid, p_kind text, p_attempt uuid, p_actor uuid, p_state text, p_details jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  INSERT INTO public.commercial_billing_events (shop_id, shop_seq, kind, attempt_id, actor_id, state_after, details)
  VALUES (p_shop,
    (SELECT coalesce(max(shop_seq), 0) + 1 FROM public.commercial_billing_events WHERE shop_id = p_shop),
    p_kind, p_attempt, p_actor, p_state, coalesce(p_details, '{}'::jsonb));
END $$;

-- Advance the current pointer atomically.
CREATE FUNCTION public.commercial_billing_advance(
  p_shop uuid, p_state text, p_reason text, p_attempt uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  UPDATE public.commercial_billing_accounts
     SET state = p_state, state_reason = p_reason,
         current_attempt_id = coalesce(p_attempt, current_attempt_id),
         version = version + 1
   WHERE shop_id = p_shop;
END $$;

-- Opens (idempotently) and locks the one account row for a shop.
CREATE FUNCTION public.commercial_billing_lock(
  p_shop uuid, p_actor uuid, p_catalog text, p_plan text
) RETURNS public.commercial_billing_accounts
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  acct public.commercial_billing_accounts;
BEGIN
  INSERT INTO public.commercial_billing_accounts (shop_id, catalog_version, plan_key, state, state_reason)
  VALUES (p_shop, p_catalog, p_plan, 'checkout_required', NULL)
  ON CONFLICT (shop_id) DO NOTHING;
  IF FOUND THEN
    -- Serialize with concurrent first callers: only the inserter reaches here.
    PERFORM public.commercial_billing_emit(p_shop, 'account_opened', NULL, p_actor, 'checkout_required',
      jsonb_build_object('catalog_version', p_catalog, 'plan_key', p_plan));
  END IF;
  SELECT * INTO acct FROM public.commercial_billing_accounts WHERE shop_id = p_shop FOR UPDATE;
  IF acct.catalog_version <> p_catalog OR acct.plan_key <> p_plan THEN
    RAISE EXCEPTION 'Account is bound to a different catalog or plan' USING ERRCODE='CB409';
  END IF;
  RETURN acct;
END $$;

-- ---------------------------------------------------------------------------
-- Begin (or replay) a Checkout request. Service role + live owner actor only.
-- Failure codes: 42501 authority, 22023 invalid input, CB409 conflict.
-- Returns {action, state, reason, attempt_id, attempt_no, session_id, customer_id}
--   action: create | replay | in_progress | blocked | active
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.commercial_checkout_begin(
  p_shop uuid,
  p_actor uuid,
  p_catalog_version text,
  p_plan_key text,
  p_lookup_key text,
  p_return_target text,
  p_fingerprint text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  acct public.commercial_billing_accounts;
  att public.commercial_checkout_attempts;
  v_id uuid;
  v_no integer;
BEGIN
  PERFORM public.commercial_billing_require_service();
  IF NOT public.commercial_billing_actor_is_owner(p_shop, p_actor) THEN
    RAISE EXCEPTION 'Live owner authority required' USING ERRCODE='42501';
  END IF;
  IF p_catalog_version IS NULL OR p_plan_key IS NULL OR p_lookup_key IS NULL OR p_return_target IS NULL
     OR p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid checkout request' USING ERRCODE='22023';
  END IF;

  acct := public.commercial_billing_lock(p_shop, p_actor, p_catalog_version, p_plan_key);

  -- Anything but "no subscription yet" never creates a second Checkout Session.
  IF acct.state = 'active' THEN
    RETURN jsonb_build_object('action', 'active', 'state', acct.state, 'reason', acct.state_reason,
      'customer_id', acct.platform_customer_id);
  END IF;
  IF acct.state IN ('past_due', 'canceled', 'incomplete', 'unknown', 'reconciliation_required') THEN
    RETURN jsonb_build_object('action', 'blocked', 'state', acct.state, 'reason', acct.state_reason,
      'customer_id', acct.platform_customer_id);
  END IF;

  IF acct.current_attempt_id IS NOT NULL THEN
    SELECT * INTO att FROM public.commercial_checkout_attempts
      WHERE shop_id = p_shop AND id = acct.current_attempt_id;
    IF att.status IN ('started', 'session_open') AND att.request_fingerprint <> p_fingerprint THEN
      RAISE EXCEPTION 'A different checkout request is already in flight' USING ERRCODE='CB409';
    END IF;
    IF att.status = 'started' THEN
      -- A request that started but never recorded an outcome is ambiguous once stale:
      -- it may or may not have reached the provider. Never retry it blindly.
      IF att.created_at < clock_timestamp() - interval '120 seconds' THEN
        UPDATE public.commercial_checkout_attempts
           SET status = 'unknown', failure_code = 'stale_in_flight' WHERE id = att.id;
        PERFORM public.commercial_billing_advance(p_shop, 'reconciliation_required', 'stale_in_flight', att.id);
        PERFORM public.commercial_billing_emit(p_shop, 'stale_attempt_marked_unknown', att.id, p_actor,
          'reconciliation_required', jsonb_build_object('attempt_no', att.attempt_no));
        RETURN jsonb_build_object('action', 'blocked', 'state', 'reconciliation_required',
          'reason', 'stale_in_flight', 'attempt_id', att.id, 'customer_id', acct.platform_customer_id);
      END IF;
      RETURN jsonb_build_object('action', 'in_progress', 'state', 'checkout_pending',
        'reason', 'checkout_in_progress', 'attempt_id', att.id, 'attempt_no', att.attempt_no,
        'customer_id', acct.platform_customer_id);
    END IF;
    IF att.status = 'session_open' THEN
      RETURN jsonb_build_object('action', 'replay', 'state', 'checkout_pending', 'reason', NULL,
        'attempt_id', att.id, 'attempt_no', att.attempt_no, 'session_id', att.provider_session_id,
        'customer_id', acct.platform_customer_id);
    END IF;
    IF att.status = 'completed_unverified' THEN
      -- A redirect is not payment proof, and a completed session must not be repeated.
      RETURN jsonb_build_object('action', 'blocked', 'state', 'checkout_pending',
        'reason', 'checkout_completed_awaiting_evidence', 'attempt_id', att.id,
        'customer_id', acct.platform_customer_id);
    END IF;
    IF att.status = 'unknown' THEN
      RETURN jsonb_build_object('action', 'blocked', 'state', 'reconciliation_required',
        'reason', coalesce(att.failure_code, 'provider_outcome_unknown'), 'attempt_id', att.id,
        'customer_id', acct.platform_customer_id);
    END IF;
    -- expired / rejected: a new attempt is safe (nothing remains open at the provider).
  END IF;

  SELECT coalesce(max(attempt_no), 0) + 1 INTO v_no
    FROM public.commercial_checkout_attempts WHERE shop_id = p_shop;
  INSERT INTO public.commercial_checkout_attempts (
    shop_id, attempt_no, catalog_version, plan_key, price_lookup_key, return_target,
    request_fingerprint, requested_by)
  VALUES (p_shop, v_no, p_catalog_version, p_plan_key, p_lookup_key, p_return_target, p_fingerprint, p_actor)
  RETURNING id INTO v_id;
  PERFORM public.commercial_billing_advance(p_shop, 'checkout_pending', 'checkout_in_progress', v_id);
  PERFORM public.commercial_billing_emit(p_shop, 'checkout_attempt_started', v_id, p_actor, 'checkout_pending',
    jsonb_build_object('attempt_no', v_no, 'catalog_version', p_catalog_version, 'plan_key', p_plan_key));
  RETURN jsonb_build_object('action', 'create', 'state', 'checkout_pending', 'reason', 'checkout_in_progress',
    'attempt_id', v_id, 'attempt_no', v_no, 'customer_id', acct.platform_customer_id);
END $$;

-- Bind the ONE platform customer for the shop (write-once; changed value conflicts).
CREATE FUNCTION public.commercial_checkout_bind_customer(
  p_shop uuid, p_actor uuid, p_attempt uuid, p_customer text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  acct public.commercial_billing_accounts;
BEGIN
  PERFORM public.commercial_billing_require_service();
  IF NOT public.commercial_billing_actor_is_owner(p_shop, p_actor) THEN
    RAISE EXCEPTION 'Live owner authority required' USING ERRCODE='42501';
  END IF;
  IF p_customer IS NULL OR p_customer !~ '^cus_[A-Za-z0-9_]{4,120}$' THEN
    RAISE EXCEPTION 'A platform customer id is required (never a connected account)' USING ERRCODE='22023';
  END IF;
  SELECT * INTO acct FROM public.commercial_billing_accounts WHERE shop_id = p_shop FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No billing account' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.commercial_checkout_attempts
                 WHERE shop_id = p_shop AND id = p_attempt AND status = 'started') THEN
    RAISE EXCEPTION 'Attempt is not in flight' USING ERRCODE='22023';
  END IF;
  IF acct.platform_customer_id IS NOT NULL THEN
    IF acct.platform_customer_id <> p_customer THEN
      RAISE EXCEPTION 'Shop is already bound to a different platform customer' USING ERRCODE='CB409';
    END IF;
    RETURN jsonb_build_object('customer_id', p_customer, 'replayed', true);
  END IF;
  UPDATE public.commercial_billing_accounts
     SET platform_customer_id = p_customer, version = version + 1 WHERE shop_id = p_shop;
  PERFORM public.commercial_billing_emit(p_shop, 'customer_bound', p_attempt, p_actor, acct.state,
    jsonb_build_object('customer_bound', true));
  RETURN jsonb_build_object('customer_id', p_customer, 'replayed', false);
END $$;

-- Record that the provider created the Checkout Session for an in-flight attempt.
CREATE FUNCTION public.commercial_checkout_record_session(
  p_shop uuid, p_actor uuid, p_attempt uuid, p_session text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  att public.commercial_checkout_attempts;
BEGIN
  PERFORM public.commercial_billing_require_service();
  IF NOT public.commercial_billing_actor_is_owner(p_shop, p_actor) THEN
    RAISE EXCEPTION 'Live owner authority required' USING ERRCODE='42501';
  END IF;
  IF p_session IS NULL OR p_session !~ '^cs_test_[A-Za-z0-9_]{4,200}$' THEN
    RAISE EXCEPTION 'A test-mode Checkout Session id is required' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM public.commercial_billing_accounts WHERE shop_id = p_shop FOR UPDATE;
  SELECT * INTO att FROM public.commercial_checkout_attempts WHERE shop_id = p_shop AND id = p_attempt;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown attempt' USING ERRCODE='22023';
  END IF;
  IF att.status = 'session_open' THEN
    IF att.provider_session_id <> p_session THEN
      RAISE EXCEPTION 'Attempt already holds a different Checkout Session' USING ERRCODE='CB409';
    END IF;
    RETURN jsonb_build_object('attempt_id', att.id, 'replayed', true);
  END IF;
  IF att.status <> 'started' THEN
    RAISE EXCEPTION 'Attempt is not in flight' USING ERRCODE='22023';
  END IF;
  UPDATE public.commercial_checkout_attempts
     SET status = 'session_open', provider_session_id = p_session WHERE id = att.id;
  PERFORM public.commercial_billing_advance(p_shop, 'checkout_pending', NULL, att.id);
  PERFORM public.commercial_billing_emit(p_shop, 'session_created', att.id, p_actor, 'checkout_pending',
    jsonb_build_object('attempt_no', att.attempt_no));
  RETURN jsonb_build_object('attempt_id', att.id, 'replayed', false);
END $$;

-- Close an attempt the provider definitively rejected (no remote object exists).
-- The next request may safely start a new attempt.
CREATE FUNCTION public.commercial_checkout_reject(
  p_shop uuid, p_actor uuid, p_attempt uuid, p_code text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  att public.commercial_checkout_attempts;
BEGIN
  PERFORM public.commercial_billing_require_service();
  IF NOT public.commercial_billing_actor_is_owner(p_shop, p_actor) THEN
    RAISE EXCEPTION 'Live owner authority required' USING ERRCODE='42501';
  END IF;
  IF p_code IS NULL OR p_code !~ '^[a-z][a-z0-9_]{2,63}$' THEN
    RAISE EXCEPTION 'Invalid failure code' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM public.commercial_billing_accounts WHERE shop_id = p_shop FOR UPDATE;
  SELECT * INTO att FROM public.commercial_checkout_attempts WHERE shop_id = p_shop AND id = p_attempt;
  IF NOT FOUND OR att.status <> 'started' THEN
    RAISE EXCEPTION 'Attempt is not in flight' USING ERRCODE='22023';
  END IF;
  UPDATE public.commercial_checkout_attempts SET status = 'rejected', failure_code = p_code WHERE id = att.id;
  PERFORM public.commercial_billing_advance(p_shop, 'checkout_required', p_code, att.id);
  PERFORM public.commercial_billing_emit(p_shop, 'attempt_rejected', att.id, p_actor, 'checkout_required',
    jsonb_build_object('code', p_code));
  RETURN jsonb_build_object('attempt_id', att.id, 'state', 'checkout_required');
END $$;

-- Mark an attempt whose provider outcome is ambiguous (timeout, 5xx, transport
-- failure, unparseable reply). The shop is then blocked until reconciled; the
-- request is never retried blindly.
CREATE FUNCTION public.commercial_checkout_mark_unknown(
  p_shop uuid, p_actor uuid, p_attempt uuid, p_code text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  att public.commercial_checkout_attempts;
BEGIN
  PERFORM public.commercial_billing_require_service();
  IF NOT public.commercial_billing_actor_is_owner(p_shop, p_actor) THEN
    RAISE EXCEPTION 'Live owner authority required' USING ERRCODE='42501';
  END IF;
  IF p_code IS NULL OR p_code !~ '^[a-z][a-z0-9_]{2,63}$' THEN
    RAISE EXCEPTION 'Invalid failure code' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM public.commercial_billing_accounts WHERE shop_id = p_shop FOR UPDATE;
  SELECT * INTO att FROM public.commercial_checkout_attempts WHERE shop_id = p_shop AND id = p_attempt;
  IF NOT FOUND OR att.status NOT IN ('started', 'session_open', 'completed_unverified') THEN
    RAISE EXCEPTION 'Attempt cannot become unknown' USING ERRCODE='22023';
  END IF;
  UPDATE public.commercial_checkout_attempts SET status = 'unknown', failure_code = p_code WHERE id = att.id;
  PERFORM public.commercial_billing_advance(p_shop, 'reconciliation_required', p_code, att.id);
  PERFORM public.commercial_billing_emit(p_shop, 'provider_outcome_unknown', att.id, p_actor,
    'reconciliation_required', jsonb_build_object('code', p_code));
  RETURN jsonb_build_object('attempt_id', att.id, 'state', 'reconciliation_required');
END $$;

-- Record what the provider says about an open session (read-only observation).
--   open      -> evidence only (state unchanged)
--   complete  -> completed_unverified: STILL NOT PAYMENT PROOF, state stays pending
--   expired   -> attempt closed; a new attempt may start
CREATE FUNCTION public.commercial_checkout_observe(
  p_shop uuid, p_actor uuid, p_attempt uuid, p_observed text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  att public.commercial_checkout_attempts;
BEGIN
  PERFORM public.commercial_billing_require_service();
  IF NOT public.commercial_billing_actor_is_owner(p_shop, p_actor) THEN
    RAISE EXCEPTION 'Live owner authority required' USING ERRCODE='42501';
  END IF;
  IF p_observed IS NULL OR p_observed NOT IN ('open', 'complete', 'expired') THEN
    RAISE EXCEPTION 'Invalid observation' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM public.commercial_billing_accounts WHERE shop_id = p_shop FOR UPDATE;
  SELECT * INTO att FROM public.commercial_checkout_attempts WHERE shop_id = p_shop AND id = p_attempt;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown attempt' USING ERRCODE='22023';
  END IF;
  IF p_observed = 'open' THEN
    IF att.status <> 'session_open' THEN
      RETURN jsonb_build_object('attempt_id', att.id, 'status', att.status);
    END IF;
    PERFORM public.commercial_billing_emit(p_shop, 'session_observed_open', att.id, p_actor, 'checkout_pending',
      jsonb_build_object('attempt_no', att.attempt_no));
    RETURN jsonb_build_object('attempt_id', att.id, 'status', att.status);
  END IF;
  IF att.status <> 'session_open' THEN
    RETURN jsonb_build_object('attempt_id', att.id, 'status', att.status);
  END IF;
  IF p_observed = 'complete' THEN
    UPDATE public.commercial_checkout_attempts SET status = 'completed_unverified' WHERE id = att.id;
    PERFORM public.commercial_billing_advance(p_shop, 'checkout_pending', 'checkout_completed_awaiting_evidence', att.id);
    PERFORM public.commercial_billing_emit(p_shop, 'session_completed_unverified', att.id, p_actor, 'checkout_pending',
      jsonb_build_object('attempt_no', att.attempt_no));
    RETURN jsonb_build_object('attempt_id', att.id, 'status', 'completed_unverified');
  END IF;
  UPDATE public.commercial_checkout_attempts SET status = 'expired' WHERE id = att.id;
  PERFORM public.commercial_billing_advance(p_shop, 'checkout_required', 'checkout_expired', att.id);
  PERFORM public.commercial_billing_emit(p_shop, 'session_expired', att.id, p_actor, 'checkout_required',
    jsonb_build_object('attempt_no', att.attempt_no));
  RETURN jsonb_build_object('attempt_id', att.id, 'status', 'expired');
END $$;

-- ---------------------------------------------------------------------------
-- Apply REVIEWED subscription evidence (service role only).
--
-- Nothing in this PR's application code calls this function: the signed webhook
-- reconciliation that will (PR E) does not exist yet. A browser redirect, client
-- assertion or Checkout creation can never reach it. It is the only writer that
-- can make an account 'active'. Stale (older than the current pointer) evidence is
-- recorded but does not move the pointer; a second, different subscription for a
-- shop that already has a live one forces reconciliation_required.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.commercial_subscription_apply_evidence(
  p_shop uuid,
  p_subscription text,
  p_customer text,
  p_status text,
  p_catalog_version text,
  p_plan_key text,
  p_lookup_key text,
  p_source text,
  p_event_id text,
  p_event_created_at timestamptz,
  p_livemode boolean,
  p_attempt uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  acct public.commercial_billing_accounts;
  prior public.commercial_subscription_evidence;
  existing public.commercial_subscription_evidence;
  v_derived text;
  v_state text;
  v_reason text;
  v_id uuid;
  v_advance boolean := true;
BEGIN
  PERFORM public.commercial_billing_require_service();
  IF p_livemode IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Live-mode evidence is refused' USING ERRCODE='22023';
  END IF;
  IF p_source NOT IN ('signed_webhook', 'reviewed_reconciliation') THEN
    RAISE EXCEPTION 'Evidence source is not reviewed' USING ERRCODE='22023';
  END IF;

  SELECT * INTO existing FROM public.commercial_subscription_evidence
    WHERE shop_id = p_shop AND source_event_id = p_event_id;
  IF FOUND THEN
    IF (existing.provider_subscription_id, existing.provider_status, existing.catalog_version)
       IS DISTINCT FROM (p_subscription, p_status, p_catalog_version) THEN
      RAISE EXCEPTION 'Event id already holds different evidence' USING ERRCODE='CB409';
    END IF;
    RETURN jsonb_build_object('id', existing.id, 'replayed', true, 'advanced', false);
  END IF;

  SELECT * INTO acct FROM public.commercial_billing_accounts WHERE shop_id = p_shop FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No billing account for this shop' USING ERRCODE='22023';
  END IF;

  v_derived := CASE p_status
    WHEN 'active' THEN 'active'
    WHEN 'past_due' THEN 'past_due'
    WHEN 'canceled' THEN 'canceled'
    WHEN 'incomplete' THEN 'incomplete'
    WHEN 'incomplete_expired' THEN 'incomplete'
    ELSE 'unknown' END;

  -- Evidence must match the account's approved binding and platform customer.
  IF p_catalog_version <> acct.catalog_version OR p_plan_key <> acct.plan_key
     OR p_lookup_key <> 'gradia_founder_pilot_2026_11_monthly' THEN
    v_derived := 'reconciliation_required'; v_reason := 'catalog_mismatch';
  ELSIF acct.platform_customer_id IS NULL OR acct.platform_customer_id <> p_customer THEN
    v_derived := 'reconciliation_required'; v_reason := 'customer_mismatch';
  END IF;

  IF acct.current_evidence_id IS NOT NULL THEN
    SELECT * INTO prior FROM public.commercial_subscription_evidence
      WHERE shop_id = p_shop AND id = acct.current_evidence_id;
    IF prior.provider_subscription_id <> p_subscription
       AND prior.derived_state IN ('active', 'past_due', 'incomplete') THEN
      -- A different live subscription for the same workspace: possible duplicate.
      v_derived := 'reconciliation_required'; v_reason := 'duplicate_subscription';
    ELSIF p_event_created_at < prior.source_event_created_at THEN
      v_advance := false; -- out-of-order: keep as evidence, do not move the pointer
    END IF;
  END IF;

  INSERT INTO public.commercial_subscription_evidence (
    shop_id, provider_subscription_id, provider_customer_id, provider_status, derived_state,
    catalog_version, plan_key, price_lookup_key, evidence_source, source_event_id,
    source_event_created_at, livemode, attempt_id)
  VALUES (p_shop, p_subscription, p_customer, p_status, v_derived, p_catalog_version, p_plan_key,
    p_lookup_key, p_source, p_event_id, p_event_created_at, false, p_attempt)
  RETURNING id INTO v_id;

  IF NOT v_advance THEN
    PERFORM public.commercial_billing_emit(p_shop, 'subscription_evidence_not_current', NULL, NULL, acct.state,
      jsonb_build_object('derived_state', v_derived));
    RETURN jsonb_build_object('id', v_id, 'replayed', false, 'advanced', false);
  END IF;

  v_state := v_derived;
  UPDATE public.commercial_billing_accounts
     SET state = v_state, state_reason = v_reason, current_evidence_id = v_id,
         last_event_ref = p_event_id, last_event_created_at = p_event_created_at,
         version = version + 1
   WHERE shop_id = p_shop;
  PERFORM public.commercial_billing_emit(p_shop, 'subscription_evidence_applied', NULL, NULL, v_state,
    jsonb_build_object('derived_state', v_derived, 'source', p_source));
  RETURN jsonb_build_object('id', v_id, 'replayed', false, 'advanced', true, 'state', v_state);
END $$;

-- ---------------------------------------------------------------------------
-- Read the current state. Live owner (session) or service role only.
-- Returns facts only; the activation decision is made by reviewed app code.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.commercial_billing_read(p_shop uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE
  acct public.commercial_billing_accounts;
  att public.commercial_checkout_attempts;
  ev public.commercial_subscription_evidence;
BEGIN
  IF NOT (coalesce(auth.role(), '') = 'service_role' OR public.commercial_is_active_owner(p_shop)) THEN
    RAISE EXCEPTION 'Owner authority required' USING ERRCODE='42501';
  END IF;
  SELECT * INTO acct FROM public.commercial_billing_accounts WHERE shop_id = p_shop;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('shop_id', p_shop, 'account', NULL);
  END IF;
  IF acct.current_attempt_id IS NOT NULL THEN
    SELECT * INTO att FROM public.commercial_checkout_attempts WHERE shop_id = p_shop AND id = acct.current_attempt_id;
  END IF;
  IF acct.current_evidence_id IS NOT NULL THEN
    SELECT * INTO ev FROM public.commercial_subscription_evidence WHERE shop_id = p_shop AND id = acct.current_evidence_id;
  END IF;
  RETURN jsonb_build_object(
    'shop_id', p_shop,
    'account', jsonb_build_object(
      'state', acct.state, 'state_reason', acct.state_reason, 'catalog_version', acct.catalog_version,
      'plan_key', acct.plan_key, 'provider_mode', acct.provider_mode,
      'has_platform_customer', acct.platform_customer_id IS NOT NULL,
      'version', acct.version, 'updated_at', acct.updated_at,
      'last_event_ref', acct.last_event_ref, 'last_event_created_at', acct.last_event_created_at),
    'attempt', CASE WHEN att.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', att.id, 'attempt_no', att.attempt_no, 'status', att.status,
      'failure_code', att.failure_code, 'session_id', att.provider_session_id,
      'created_at', att.created_at, 'status_changed_at', att.status_changed_at) END,
    'evidence', CASE WHEN ev.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', ev.id, 'derived_state', ev.derived_state, 'provider_status', ev.provider_status,
      'catalog_version', ev.catalog_version, 'plan_key', ev.plan_key,
      'price_lookup_key', ev.price_lookup_key, 'evidence_source', ev.evidence_source,
      'livemode', ev.livemode, 'source_event_created_at', ev.source_event_created_at,
      'recorded_at', ev.recorded_at) END);
END $$;

-- ---------------------------------------------------------------------------
-- Function ACLs
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  public.commercial_checkout_attempts_guard(),
  public.commercial_billing_accounts_guard(),
  public.commercial_billing_actor_is_owner(uuid, uuid),
  public.commercial_billing_require_service(),
  public.commercial_billing_emit(uuid, text, uuid, uuid, text, jsonb),
  public.commercial_billing_advance(uuid, text, text, uuid),
  public.commercial_billing_lock(uuid, uuid, text, text),
  public.commercial_checkout_begin(uuid, uuid, text, text, text, text, text),
  public.commercial_checkout_bind_customer(uuid, uuid, uuid, text),
  public.commercial_checkout_record_session(uuid, uuid, uuid, text),
  public.commercial_checkout_reject(uuid, uuid, uuid, text),
  public.commercial_checkout_mark_unknown(uuid, uuid, uuid, text),
  public.commercial_checkout_observe(uuid, uuid, uuid, text),
  public.commercial_subscription_apply_evidence(uuid, text, text, text, text, text, text, text, text, timestamptz, boolean, uuid),
  public.commercial_billing_read(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.commercial_checkout_begin(uuid, uuid, text, text, text, text, text),
  public.commercial_checkout_bind_customer(uuid, uuid, uuid, text),
  public.commercial_checkout_record_session(uuid, uuid, uuid, text),
  public.commercial_checkout_reject(uuid, uuid, uuid, text),
  public.commercial_checkout_mark_unknown(uuid, uuid, uuid, text),
  public.commercial_checkout_observe(uuid, uuid, uuid, text),
  public.commercial_subscription_apply_evidence(uuid, text, text, text, text, text, text, text, text, timestamptz, boolean, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.commercial_billing_read(uuid) TO authenticated, service_role;

COMMIT;
