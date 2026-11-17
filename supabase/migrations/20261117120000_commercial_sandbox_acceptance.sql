BEGIN;

-- Commercial Billing PR F1 (sandbox/test mode only): dispatch sweep, delivery
-- reconciliation evidence, and the reviewed application path for approved adjustments.
--
-- Adds objects only. No existing table, function, row, trigger or ACL is altered:
-- settlements, lines, events, adjustments, reviews, receipts, periods and facts are
-- untouched, and the settlement line status guard (forward only) is unchanged.
-- Nothing here calls a provider, and no function here can create a settlement, an
-- adjustment, a review, a refund, a cancellation or a subscription state.
--
--  * commercial_settlement_delivery_pending / _unresolved
--        service-role worklists for the dispatcher and the reconciler (read only).
--  * commercial_delivery_reconciliations (+ _record, _read)
--        append-only evidence of what the provider reported for an `unknown` delivery.
--        The line itself stays `unknown` (never rewritten); a confirmed reconciliation is
--        the evidence that lets the effective status read as delivered. Nothing resends.
--  * commercial_adjustment_applications (+ _events, _claim, _record, _pending, _read)
--        an outbox that carries ONLY human-APPROVED signed adjustments (either sign) to the
--        provider as one pending invoice item each. No review, no application.

DO $$
BEGIN
  IF to_regclass('public.commercial_settlement_adjustments') IS NULL
     OR to_regclass('public.commercial_adjustment_reviews') IS NULL
     OR to_regclass('public.commercial_settlement_lines') IS NULL THEN
    RAISE EXCEPTION 'PR D and PR E1 billing tables are required' USING ERRCODE='23514';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Worklists (service role, read only)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.commercial_settlement_delivery_pending(p_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM public.commercial_billing_require_service();
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object(
      'shop_id', w.shop_id, 'settlement_id', w.settlement_id, 'line_id', w.id,
      'delivery_status', w.delivery_status) ORDER BY w.created_at, w.component), '[]'::jsonb)
    FROM (
      SELECT l.shop_id, l.settlement_id, l.id, l.delivery_status, l.component, s.created_at
        FROM public.commercial_settlement_lines l
        JOIN public.commercial_settlements s ON s.shop_id = l.shop_id AND s.id = l.settlement_id
       WHERE l.delivery_status IN ('pending', 'in_flight')
       ORDER BY s.created_at, l.component
       LIMIT greatest(1, least(coalesce(p_limit, 50), 200))
    ) w);
END $$;

-- ---------------------------------------------------------------------------
-- Delivery reconciliation evidence (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE public.commercial_delivery_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  settlement_id uuid NOT NULL,
  line_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('confirmed_delivered', 'not_confirmed', 'mismatch')),
  -- What the ledger says was sent, and what the provider reported for that minute.
  expected_value bigint NOT NULL CHECK (expected_value > 0),
  observed_value bigint NOT NULL CHECK (observed_value >= 0),
  -- The provider summary window: exactly one minute-aligned minute containing the event.
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  line_failure_code text NOT NULL CHECK (line_failure_code ~ '^[a-z][a-z0-9_]{2,63}$'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (window_end = window_start + interval '60 seconds'),
  CHECK ((outcome = 'confirmed_delivered') = (observed_value = expected_value)),
  CHECK ((outcome = 'not_confirmed') = (observed_value < expected_value)),
  FOREIGN KEY (shop_id, settlement_id, line_id)
    REFERENCES public.commercial_settlement_lines(shop_id, settlement_id, id) ON DELETE CASCADE
);
CREATE INDEX commercial_delivery_reconciliations_line_idx
  ON public.commercial_delivery_reconciliations (shop_id, line_id, recorded_at);
-- A confirmed reconciliation is final and exists at most once per line.
CREATE UNIQUE INDEX commercial_delivery_reconciliations_confirmed_uniq
  ON public.commercial_delivery_reconciliations (line_id) WHERE outcome = 'confirmed_delivered';
CREATE TRIGGER commercial_delivery_reconciliations_append_only
  BEFORE UPDATE OR DELETE ON public.commercial_delivery_reconciliations
  FOR EACH ROW EXECUTE FUNCTION public.commercial_usage_append_only();
CREATE TRIGGER commercial_delivery_reconciliations_no_truncate
  BEFORE TRUNCATE ON public.commercial_delivery_reconciliations
  FOR EACH STATEMENT EXECUTE FUNCTION public.commercial_usage_append_only();

CREATE FUNCTION public.commercial_settlement_delivery_unresolved(p_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM public.commercial_billing_require_service();
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object(
      'shop_id', w.shop_id, 'settlement_id', w.settlement_id, 'line_id', w.id,
      'event_name', w.event_name, 'event_value', w.event_value::text,
      'event_timestamp', w.event_timestamp, 'stripe_customer_id', w.stripe_customer_id,
      'failure_code', w.failure_code) ORDER BY w.created_at, w.component), '[]'::jsonb)
    FROM (
      SELECT l.shop_id, l.settlement_id, l.id, l.component, l.event_name, l.event_value, l.event_timestamp,
             l.failure_code, s.stripe_customer_id, s.created_at
        FROM public.commercial_settlement_lines l
        JOIN public.commercial_settlements s ON s.shop_id = l.shop_id AND s.id = l.settlement_id
       WHERE l.delivery_status = 'unknown'
         AND NOT EXISTS (SELECT 1 FROM public.commercial_delivery_reconciliations r
                          WHERE r.line_id = l.id AND r.outcome = 'confirmed_delivered')
       ORDER BY s.created_at, l.component
       LIMIT greatest(1, least(coalesce(p_limit, 50), 200))
    ) w);
END $$;

-- Records what the provider reported for ONE `unknown` line. Service role only. The
-- database (not the caller) decides the outcome by comparing the observed total with the
-- immutable event value. It never changes the line, never resends, never confirms a line
-- that is not `unknown`, and a confirmed result is final (a repeat is a replay).
CREATE FUNCTION public.commercial_delivery_reconcile_record(
  p_shop uuid, p_settlement uuid, p_line uuid, p_observed bigint, p_window_start timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  l public.commercial_settlement_lines;
  prior public.commercial_delivery_reconciliations;
  v_outcome text;
BEGIN
  PERFORM public.commercial_billing_require_service();
  IF p_observed IS NULL OR p_observed < 0 OR p_window_start IS NULL THEN
    RAISE EXCEPTION 'Invalid observation' USING ERRCODE='22023';
  END IF;
  SELECT * INTO l FROM public.commercial_settlement_lines
    WHERE shop_id = p_shop AND settlement_id = p_settlement AND id = p_line FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Settlement line not found' USING ERRCODE='CB409';
  END IF;
  IF l.delivery_status <> 'unknown' THEN
    RAISE EXCEPTION 'Only an unknown delivery is reconciled' USING ERRCODE='CB409';
  END IF;
  SELECT * INTO prior FROM public.commercial_delivery_reconciliations
    WHERE line_id = l.id AND outcome = 'confirmed_delivered';
  IF FOUND THEN
    RETURN jsonb_build_object('outcome', 'confirmed_delivered', 'replayed', true);
  END IF;
  -- The window must be one minute-aligned minute that contains the event (the provider's grain).
  IF date_trunc('minute', p_window_start) <> p_window_start
     OR l.event_timestamp < p_window_start OR l.event_timestamp >= p_window_start + interval '60 seconds' THEN
    RAISE EXCEPTION 'Observation window does not contain the event' USING ERRCODE='22023';
  END IF;
  v_outcome := CASE WHEN p_observed = l.event_value THEN 'confirmed_delivered'
                    WHEN p_observed < l.event_value THEN 'not_confirmed'
                    ELSE 'mismatch' END;
  INSERT INTO public.commercial_delivery_reconciliations (
    shop_id, settlement_id, line_id, outcome, expected_value, observed_value, window_start, window_end, line_failure_code)
  VALUES (p_shop, p_settlement, l.id, v_outcome, l.event_value, p_observed, p_window_start,
    p_window_start + interval '60 seconds', l.failure_code);
  RETURN jsonb_build_object('outcome', v_outcome, 'replayed', false);
END $$;

-- Reconciliation evidence for one settlement. Live owner of that shop or service role.
CREATE FUNCTION public.commercial_delivery_reconciliation_read(p_shop uuid, p_settlement uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NOT (coalesce(auth.role(), '') = 'service_role' OR public.commercial_is_active_owner(p_shop)) THEN
    RAISE EXCEPTION 'Owner authority required' USING ERRCODE='42501';
  END IF;
  RETURN jsonb_build_object('shop_id', p_shop, 'settlement_id', p_settlement, 'reconciliations',
    (SELECT coalesce(jsonb_agg(jsonb_build_object(
        'line_id', r.line_id, 'outcome', r.outcome, 'expected_value', r.expected_value::text,
        'observed_value', r.observed_value::text, 'recorded_at', r.recorded_at) ORDER BY r.recorded_at, r.id), '[]'::jsonb)
       FROM public.commercial_delivery_reconciliations r
      WHERE r.shop_id = p_shop AND r.settlement_id = p_settlement));
END $$;

-- ---------------------------------------------------------------------------
-- Adjustment applications (outbox). One row per APPROVED adjustment, ever.
-- ---------------------------------------------------------------------------
CREATE TABLE public.commercial_adjustment_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  adjustment_id uuid NOT NULL,
  -- Copied from the adjustment at claim time and immutable (negative = credit to the customer).
  signed_amount_cents bigint NOT NULL CHECK (signed_amount_cents <> 0 AND abs(signed_amount_cents) <= 100000000),
  currency text NOT NULL DEFAULT 'usd' CHECK (currency = 'usd'),
  stripe_customer_id text NOT NULL CHECK (stripe_customer_id ~ '^cus_[A-Za-z0-9_]{4,120}$'),
  provider_identifier text NOT NULL CHECK (provider_identifier ~ '^[A-Za-z0-9_.:-]{16,100}$'),
  status text NOT NULL CHECK (status IN ('in_flight', 'applied', 'rejected', 'unknown')),
  claim_token uuid NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z][a-z0-9_]{2,63}$'),
  status_changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status IN ('rejected', 'unknown')) = (failure_code IS NOT NULL)),
  UNIQUE (adjustment_id),
  UNIQUE (provider_identifier),
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, adjustment_id) REFERENCES public.commercial_settlement_adjustments(shop_id, id)
);
CREATE TABLE public.commercial_adjustment_application_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  application_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('claimed', 'applied', 'rejected', 'unknown', 'stale_marked_unknown')),
  code text CHECK (code IS NULL OR code ~ '^[a-z][a-z0-9_]{2,63}$'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (shop_id, application_id) REFERENCES public.commercial_adjustment_applications(shop_id, id) ON DELETE CASCADE
);
CREATE INDEX commercial_adjustment_application_events_idx
  ON public.commercial_adjustment_application_events (shop_id, application_id, recorded_at);

CREATE TRIGGER commercial_adjustment_application_events_append_only
  BEFORE UPDATE OR DELETE ON public.commercial_adjustment_application_events
  FOR EACH ROW EXECUTE FUNCTION public.commercial_usage_append_only();
CREATE TRIGGER commercial_adjustment_application_events_no_truncate
  BEFORE TRUNCATE ON public.commercial_adjustment_application_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.commercial_usage_append_only();
CREATE TRIGGER commercial_adjustment_applications_no_truncate
  BEFORE TRUNCATE ON public.commercial_adjustment_applications
  FOR EACH STATEMENT EXECUTE FUNCTION public.commercial_usage_append_only();

-- Identity and amount are immutable, the status moves forward only, the claim token is write-once.
CREATE FUNCTION public.commercial_adjustment_applications_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.shops WHERE id = OLD.shop_id) THEN
      RAISE EXCEPTION 'Adjustment applications cannot be deleted' USING ERRCODE='42501';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.id, NEW.shop_id, NEW.adjustment_id, NEW.signed_amount_cents, NEW.currency, NEW.stripe_customer_id,
      NEW.provider_identifier, NEW.claim_token, NEW.claimed_at)
     IS DISTINCT FROM
     (OLD.id, OLD.shop_id, OLD.adjustment_id, OLD.signed_amount_cents, OLD.currency, OLD.stripe_customer_id,
      OLD.provider_identifier, OLD.claim_token, OLD.claimed_at) THEN
    RAISE EXCEPTION 'Adjustment application is immutable' USING ERRCODE='42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT
     (OLD.status = 'in_flight' AND NEW.status IN ('applied', 'rejected', 'unknown')) THEN
    RAISE EXCEPTION 'Application status only moves forward' USING ERRCODE='42501';
  END IF;
  IF NEW.status = OLD.status AND NEW.failure_code IS DISTINCT FROM OLD.failure_code THEN
    RAISE EXCEPTION 'Application evidence is immutable within a status' USING ERRCODE='42501';
  END IF;
  NEW.status_changed_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER commercial_adjustment_applications_guard
  BEFORE UPDATE OR DELETE ON public.commercial_adjustment_applications
  FOR EACH ROW EXECUTE FUNCTION public.commercial_adjustment_applications_guard();

CREATE FUNCTION public.commercial_adjustment_application_pending(p_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM public.commercial_billing_require_service();
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('shop_id', w.shop_id, 'adjustment_id', w.id)
      ORDER BY w.created_at, w.id), '[]'::jsonb)
    FROM (
      SELECT a.shop_id, a.id, a.created_at
        FROM public.commercial_settlement_adjustments a
        JOIN public.commercial_adjustment_reviews r ON r.adjustment_id = a.id AND r.decision = 'approved'
        LEFT JOIN public.commercial_adjustment_applications ap ON ap.adjustment_id = a.id
       WHERE ap.id IS NULL OR ap.status = 'in_flight'
       ORDER BY a.created_at, a.id
       LIMIT greatest(1, least(coalesce(p_limit, 50), 200))
    ) w);
END $$;

-- Claims the application of ONE adjustment. Service role only. A review is required: no
-- review, or a rejection, is refused (CB409) whatever the sign or size. Returns
--   claimed (with the exact provider payload) | in_progress | applied | blocked (rejected/unknown:
--   never retried automatically).
CREATE FUNCTION public.commercial_adjustment_application_claim(p_shop uuid, p_adjustment uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  adj public.commercial_settlement_adjustments;
  rev public.commercial_adjustment_reviews;
  st public.commercial_settlements;
  acct public.commercial_billing_accounts;
  ap public.commercial_adjustment_applications;
  v_token uuid := gen_random_uuid();
  v_ident text;
BEGIN
  PERFORM public.commercial_billing_require_service();
  -- One decision point per adjustment, serialized.
  PERFORM pg_advisory_xact_lock(hashtextextended('commercial_adjustment_application:' || p_adjustment::text, 0));
  SELECT * INTO adj FROM public.commercial_settlement_adjustments WHERE shop_id = p_shop AND id = p_adjustment;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Adjustment not found' USING ERRCODE='CB409';
  END IF;
  SELECT * INTO rev FROM public.commercial_adjustment_reviews WHERE shop_id = p_shop AND adjustment_id = p_adjustment;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Adjustment has no human review' USING ERRCODE='CB409';
  END IF;
  IF rev.decision <> 'approved' THEN
    RAISE EXCEPTION 'Adjustment was not approved' USING ERRCODE='CB409';
  END IF;
  SELECT * INTO st FROM public.commercial_settlements WHERE shop_id = p_shop AND id = adj.settlement_id;
  SELECT * INTO acct FROM public.commercial_billing_accounts WHERE shop_id = p_shop;
  IF NOT FOUND OR acct.platform_customer_id IS DISTINCT FROM st.stripe_customer_id THEN
    RAISE EXCEPTION 'Adjustment customer is not the bound platform customer' USING ERRCODE='CB409';
  END IF;

  SELECT * INTO ap FROM public.commercial_adjustment_applications WHERE adjustment_id = p_adjustment FOR UPDATE;
  IF FOUND THEN
    IF ap.status = 'applied' THEN
      RETURN jsonb_build_object('action', 'applied');
    ELSIF ap.status IN ('rejected', 'unknown') THEN
      RETURN jsonb_build_object('action', 'blocked', 'status', ap.status, 'failure_code', ap.failure_code);
    ELSIF ap.claimed_at < clock_timestamp() - interval '120 seconds' THEN
      -- It MAY have reached the provider: unknown, never resent.
      UPDATE public.commercial_adjustment_applications SET status = 'unknown', failure_code = 'stale_in_flight' WHERE id = ap.id;
      INSERT INTO public.commercial_adjustment_application_events (shop_id, application_id, kind, code)
        VALUES (p_shop, ap.id, 'stale_marked_unknown', 'stale_in_flight');
      RETURN jsonb_build_object('action', 'blocked', 'status', 'unknown', 'failure_code', 'stale_in_flight');
    END IF;
    RETURN jsonb_build_object('action', 'in_progress');
  END IF;

  v_ident := 'gradia-cb-adjust-' || substr(encode(sha256(convert_to(p_shop::text || ':' || p_adjustment::text, 'utf8')), 'hex'), 1, 40);
  INSERT INTO public.commercial_adjustment_applications (
    shop_id, adjustment_id, signed_amount_cents, currency, stripe_customer_id, provider_identifier, status, claim_token)
  VALUES (p_shop, p_adjustment, adj.signed_amount_cents, adj.currency, st.stripe_customer_id, v_ident, 'in_flight', v_token)
  RETURNING * INTO ap;
  INSERT INTO public.commercial_adjustment_application_events (shop_id, application_id, kind) VALUES (p_shop, ap.id, 'claimed');
  RETURN jsonb_build_object('action', 'claimed', 'claim_token', v_token, 'adjustment_id', p_adjustment,
    'signed_amount_cents', adj.signed_amount_cents, 'currency', adj.currency,
    'stripe_customer_id', st.stripe_customer_id, 'provider_identifier', v_ident);
END $$;

CREATE FUNCTION public.commercial_adjustment_application_record(
  p_shop uuid, p_adjustment uuid, p_claim_token uuid, p_outcome text, p_code text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  ap public.commercial_adjustment_applications;
BEGIN
  PERFORM public.commercial_billing_require_service();
  IF p_outcome NOT IN ('applied', 'rejected', 'unknown')
     OR (p_outcome = 'applied') <> (p_code IS NULL)
     OR (p_code IS NOT NULL AND p_code !~ '^[a-z][a-z0-9_]{2,63}$') THEN
    RAISE EXCEPTION 'Invalid outcome' USING ERRCODE='22023';
  END IF;
  SELECT * INTO ap FROM public.commercial_adjustment_applications
    WHERE shop_id = p_shop AND adjustment_id = p_adjustment FOR UPDATE;
  IF NOT FOUND OR ap.status <> 'in_flight' OR ap.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION 'Application is not claimed by this caller' USING ERRCODE='CB409';
  END IF;
  UPDATE public.commercial_adjustment_applications SET status = p_outcome, failure_code = p_code WHERE id = ap.id;
  INSERT INTO public.commercial_adjustment_application_events (shop_id, application_id, kind, code)
    VALUES (p_shop, ap.id, p_outcome, p_code);
  RETURN jsonb_build_object('status', p_outcome);
END $$;

-- Application facts for the owner / service. Never the provider customer id or claim token.
CREATE FUNCTION public.commercial_adjustment_application_read(p_shop uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NOT (coalesce(auth.role(), '') = 'service_role' OR public.commercial_is_active_owner(p_shop)) THEN
    RAISE EXCEPTION 'Owner authority required' USING ERRCODE='42501';
  END IF;
  RETURN jsonb_build_object('shop_id', p_shop, 'applications',
    (SELECT coalesce(jsonb_agg(jsonb_build_object(
        'adjustment_id', ap.adjustment_id, 'signed_amount_cents', ap.signed_amount_cents,
        'status', ap.status, 'failure_code', ap.failure_code, 'claimed_at', ap.claimed_at)
        ORDER BY ap.claimed_at, ap.id), '[]'::jsonb)
       FROM public.commercial_adjustment_applications ap WHERE ap.shop_id = p_shop));
END $$;

-- ---------------------------------------------------------------------------
-- Table privileges: RLS on, no browser role access, service role reads only.
-- ---------------------------------------------------------------------------
ALTER TABLE public.commercial_delivery_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commercial_adjustment_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commercial_adjustment_application_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.commercial_delivery_reconciliations, public.commercial_adjustment_applications,
  public.commercial_adjustment_application_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.commercial_delivery_reconciliations, public.commercial_adjustment_applications,
  public.commercial_adjustment_application_events TO service_role;

-- ---------------------------------------------------------------------------
-- Function ACLs. Browser roles get nothing; the owner may READ evidence of own shop.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  public.commercial_settlement_delivery_pending(integer),
  public.commercial_settlement_delivery_unresolved(integer),
  public.commercial_delivery_reconcile_record(uuid, uuid, uuid, bigint, timestamptz),
  public.commercial_delivery_reconciliation_read(uuid, uuid),
  public.commercial_adjustment_applications_guard(),
  public.commercial_adjustment_application_pending(integer),
  public.commercial_adjustment_application_claim(uuid, uuid),
  public.commercial_adjustment_application_record(uuid, uuid, uuid, text, text),
  public.commercial_adjustment_application_read(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.commercial_settlement_delivery_pending(integer),
  public.commercial_settlement_delivery_unresolved(integer),
  public.commercial_delivery_reconcile_record(uuid, uuid, uuid, bigint, timestamptz),
  public.commercial_adjustment_application_pending(integer),
  public.commercial_adjustment_application_claim(uuid, uuid),
  public.commercial_adjustment_application_record(uuid, uuid, uuid, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION
  public.commercial_delivery_reconciliation_read(uuid, uuid),
  public.commercial_adjustment_application_read(uuid)
  TO authenticated, service_role;

COMMIT;
