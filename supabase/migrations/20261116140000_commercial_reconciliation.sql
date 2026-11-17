BEGIN;

-- Commercial Billing PR E1 (sandbox/test mode only): signed PLATFORM webhook
-- reconciliation, subscription lifecycle evidence, safe lapse gate, exact
-- subscription-period binding, owner Customer Portal authority, provider facts
-- (payment failure / cancellation / refund / credit) and the append-only signed
-- adjustment CONTRACT.
--
-- Adds objects and replaces functions in place. No shop, membership, usage,
-- settlement or PR C row is rewritten or backfilled, and no billing state is invented
-- for existing shops. Nothing here calls a provider, issues a refund or credit,
-- cancels, retries or marks anything paid.
--
--  * commercial_webhook_receipts   — the durable replay claim: one row per verified
--                                    Stripe event id (+ payload digest). Written in the
--                                    SAME transaction as the effect, so a crash leaves
--                                    neither a half effect nor a stuck claim.
--  * commercial_provider_facts     — append-only provider-reported payment failure,
--                                    cancellation, refund and credit-note evidence.
--  * commercial_subscription_periods — verified Stripe subscription periods (settlement
--                                    binds to these, never to a calendar placeholder).
--  * commercial_subscription_apply_evidence is EXTENDED IN PLACE (still the single
--    subscription truth) with period fields, deterministic ordering and sticky
--    integrity reconciliation.
--  * commercial_webhook_ingest     — resolves the tenant ONLY from server-held bindings
--                                    and applies evidence through the function above.
--  * commercial_execution_gate     — the lapse check for new paid execution.
--  * commercial_portal_authorize   — owner-only Customer Portal authority.
--  * commercial_settlement_adjustments / _reviews — append-only signed adjustments and
--                                    one human decision each. There is NO applied state.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.commercial_catalog_versions WHERE version = '2026-11-03.v1') THEN
    RAISE EXCEPTION 'Approved catalog 2026-11-03.v1 is not registered' USING ERRCODE='23514';
  END IF;
  IF to_regprocedure('public.commercial_settlement_begin(uuid,uuid,text,text,timestamptz,timestamptz,timestamptz,text,jsonb,text,text,jsonb,text)') IS NULL THEN
    RAISE EXCEPTION 'PR D settlement functions are required' USING ERRCODE='23514';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Audit event kinds
-- ---------------------------------------------------------------------------
ALTER TABLE public.commercial_billing_events DROP CONSTRAINT commercial_billing_events_kind_check;
ALTER TABLE public.commercial_billing_events ADD CONSTRAINT commercial_billing_events_kind_check CHECK (kind IN (
  'account_opened', 'checkout_attempt_started', 'customer_bound', 'session_created',
  'session_observed_open', 'session_completed_unverified', 'session_expired',
  'attempt_rejected', 'provider_outcome_unknown', 'stale_attempt_marked_unknown',
  'subscription_evidence_applied', 'subscription_evidence_not_current',
  'reconciliation_required',
  'checkout_completion_observed', 'checkout_expiry_observed', 'provider_fact_recorded',
  'subscription_period_recorded', 'portal_session_requested', 'webhook_conflict',
  'adjustment_proposed', 'adjustment_reviewed'));

-- ---------------------------------------------------------------------------
-- Evidence: period + lifecycle columns (additive; existing rows keep NULLs)
-- ---------------------------------------------------------------------------
ALTER TABLE public.commercial_subscription_evidence
  ADD COLUMN subscription_started_at timestamptz,
  ADD COLUMN period_start timestamptz,
  ADD COLUMN period_end timestamptz,
  ADD COLUMN cancel_at_period_end boolean,
  ADD COLUMN canceled_at timestamptz,
  ADD COLUMN derived_reason text CHECK (derived_reason IS NULL OR derived_reason ~ '^[a-z][a-z0-9_]{2,63}$');
ALTER TABLE public.commercial_subscription_evidence
  ADD CONSTRAINT commercial_subscription_evidence_period_check CHECK (
    (period_start IS NULL) = (period_end IS NULL)
    AND (period_start IS NULL OR (
      period_end > period_start
      AND period_end - period_start <= interval '40 days'
      AND subscription_started_at IS NOT NULL
      AND subscription_started_at <= period_start)));

-- ---------------------------------------------------------------------------
-- Verified subscription periods (append-only). Settlement binds to these.
-- ---------------------------------------------------------------------------
CREATE TABLE public.commercial_subscription_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  provider_subscription_id text NOT NULL CHECK (provider_subscription_id ~ '^sub_[A-Za-z0-9_]{4,120}$'),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  -- The subscription's own start (first activation boundary). The FIRST period starts here.
  subscription_started_at timestamptz NOT NULL,
  evidence_id uuid NOT NULL,
  source_event_id text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (period_end > period_start AND period_end - period_start <= interval '40 days'),
  CHECK (subscription_started_at <= period_start),
  UNIQUE (shop_id, period_start, period_end),
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, evidence_id) REFERENCES public.commercial_subscription_evidence(shop_id, id)
);
CREATE INDEX commercial_subscription_periods_chain_idx
  ON public.commercial_subscription_periods (shop_id, provider_subscription_id, period_end);

CREATE FUNCTION public.commercial_subscription_periods_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.commercial_subscription_periods p
              WHERE p.shop_id = NEW.shop_id AND p.period_start < NEW.period_end AND p.period_end > NEW.period_start) THEN
    RAISE EXCEPTION 'Subscription periods cannot overlap' USING ERRCODE='CB409';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commercial_subscription_periods_no_overlap
  BEFORE INSERT ON public.commercial_subscription_periods
  FOR EACH ROW EXECUTE FUNCTION public.commercial_subscription_periods_guard();
CREATE TRIGGER commercial_subscription_periods_append_only
  BEFORE UPDATE OR DELETE ON public.commercial_subscription_periods
  FOR EACH ROW EXECUTE FUNCTION public.commercial_usage_append_only();
CREATE TRIGGER commercial_subscription_periods_no_truncate
  BEFORE TRUNCATE ON public.commercial_subscription_periods
  FOR EACH STATEMENT EXECUTE FUNCTION public.commercial_usage_append_only();

-- ---------------------------------------------------------------------------
-- Webhook receipts: the durable replay claim (no raw payload is stored)
-- ---------------------------------------------------------------------------
CREATE TABLE public.commercial_webhook_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id text NOT NULL UNIQUE CHECK (event_id ~ '^evt_[A-Za-z0-9_]{6,120}$'),
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.]{2,80}$'),
  event_created_at timestamptz NOT NULL,
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  livemode boolean NOT NULL CHECK (livemode = false),
  shop_id uuid REFERENCES public.shops(id) ON DELETE CASCADE,
  outcome text NOT NULL CHECK (outcome IN (
    'applied', 'not_current', 'recorded_fact', 'observed', 'unresolved', 'refused')),
  reason text CHECK (reason IS NULL OR reason ~ '^[a-z][a-z0-9_]{2,63}$'),
  evidence_id uuid,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (shop_id, id)
);
CREATE INDEX commercial_webhook_receipts_shop_idx ON public.commercial_webhook_receipts (shop_id, received_at);
CREATE TRIGGER commercial_webhook_receipts_append_only
  BEFORE UPDATE OR DELETE ON public.commercial_webhook_receipts
  FOR EACH ROW EXECUTE FUNCTION public.commercial_usage_append_only();
CREATE TRIGGER commercial_webhook_receipts_no_truncate
  BEFORE TRUNCATE ON public.commercial_webhook_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION public.commercial_usage_append_only();

-- ---------------------------------------------------------------------------
-- Provider facts: what Stripe REPORTED. Recording never acts on it.
-- ---------------------------------------------------------------------------
CREATE TABLE public.commercial_provider_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  receipt_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'payment_failed', 'payment_succeeded', 'cancellation', 'cancellation_scheduled', 'refund', 'credit_note')),
  provider_subscription_id text CHECK (provider_subscription_id IS NULL OR provider_subscription_id ~ '^sub_[A-Za-z0-9_]{4,120}$'),
  provider_invoice_id text CHECK (provider_invoice_id IS NULL OR provider_invoice_id ~ '^in_[A-Za-z0-9_]{4,120}$'),
  provider_object_id text NOT NULL CHECK (provider_object_id ~ '^[a-z]{2,3}_[A-Za-z0-9_]{4,120}$'),
  -- Provider-reported magnitude, never a decision. Sign is not carried: a refund/credit is a magnitude.
  amount_cents bigint CHECK (amount_cents IS NULL OR amount_cents BETWEEN 0 AND 100000000),
  currency text CHECK (currency IS NULL OR currency ~ '^[a-z]{3}$'),
  attempt_count integer CHECK (attempt_count IS NULL OR attempt_count BETWEEN 0 AND 1000),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (shop_id, receipt_id),
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, receipt_id) REFERENCES public.commercial_webhook_receipts(shop_id, id)
);
CREATE INDEX commercial_provider_facts_shop_idx ON public.commercial_provider_facts (shop_id, kind, occurred_at);
CREATE TRIGGER commercial_provider_facts_append_only
  BEFORE UPDATE OR DELETE ON public.commercial_provider_facts
  FOR EACH ROW EXECUTE FUNCTION public.commercial_usage_append_only();
CREATE TRIGGER commercial_provider_facts_no_truncate
  BEFORE TRUNCATE ON public.commercial_provider_facts
  FOR EACH STATEMENT EXECUTE FUNCTION public.commercial_usage_append_only();

-- ---------------------------------------------------------------------------
-- Signed adjustments (CONTRACT ONLY). A settled period is never rewritten; late
-- evidence becomes a signed adjustment for the NEXT invoice and needs one human
-- decision. Nothing here applies, credits, refunds or retries anything, and no
-- 'applied' state exists to be reached.
-- ---------------------------------------------------------------------------
CREATE TABLE public.commercial_settlement_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  settlement_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('late_usage_evidence', 'provider_refund_evidence', 'provider_credit_evidence', 'correction')),
  -- Negative = credit TOWARD the customer; positive = additional charge. Never zero.
  signed_amount_cents bigint NOT NULL CHECK (signed_amount_cents <> 0 AND abs(signed_amount_cents) <= 100000000),
  currency text NOT NULL DEFAULT 'usd' CHECK (currency = 'usd'),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{2,63}$'),
  evidence_fact_id uuid,
  -- The next invoice period this adjustment would apply to (= the settled window's end).
  target_period_start timestamptz NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_.:-]{16,200}$'),
  proposed_by text NOT NULL CHECK (proposed_by IN ('system_reconciliation', 'reviewed_operator')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (shop_id, idempotency_key),
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, settlement_id) REFERENCES public.commercial_settlements(shop_id, id),
  FOREIGN KEY (shop_id, evidence_fact_id) REFERENCES public.commercial_provider_facts(shop_id, id)
);
CREATE TABLE public.commercial_adjustment_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  adjustment_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  -- An identified human reviewer reference. Never an email or other personal detail.
  reviewer_ref text NOT NULL CHECK (reviewer_ref ~ '^reviewer:[A-Za-z0-9_-]{8,64}$'),
  note text CHECK (note IS NULL OR (length(note) <= 500 AND note !~* '(https?:|sk_(live|test)|rk_(live|test)|whsec_)')),
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- ONE decision per adjustment: a decision is never overwritten or repeated.
  UNIQUE (adjustment_id),
  FOREIGN KEY (shop_id, adjustment_id) REFERENCES public.commercial_settlement_adjustments(shop_id, id)
);
CREATE TRIGGER commercial_settlement_adjustments_append_only
  BEFORE UPDATE OR DELETE ON public.commercial_settlement_adjustments
  FOR EACH ROW EXECUTE FUNCTION public.commercial_usage_append_only();
CREATE TRIGGER commercial_adjustment_reviews_append_only
  BEFORE UPDATE OR DELETE ON public.commercial_adjustment_reviews
  FOR EACH ROW EXECUTE FUNCTION public.commercial_usage_append_only();
CREATE TRIGGER commercial_settlement_adjustments_no_truncate
  BEFORE TRUNCATE ON public.commercial_settlement_adjustments
  FOR EACH STATEMENT EXECUTE FUNCTION public.commercial_usage_append_only();
CREATE TRIGGER commercial_adjustment_reviews_no_truncate
  BEFORE TRUNCATE ON public.commercial_adjustment_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION public.commercial_usage_append_only();

-- ---------------------------------------------------------------------------
-- Table privileges: RLS on, no browser role access, service role reads only.
-- ---------------------------------------------------------------------------
ALTER TABLE public.commercial_subscription_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commercial_webhook_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commercial_provider_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commercial_settlement_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commercial_adjustment_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.commercial_subscription_periods, public.commercial_webhook_receipts,
  public.commercial_provider_facts, public.commercial_settlement_adjustments,
  public.commercial_adjustment_reviews FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.commercial_subscription_periods, public.commercial_webhook_receipts,
  public.commercial_provider_facts, public.commercial_settlement_adjustments,
  public.commercial_adjustment_reviews TO service_role;

-- ---------------------------------------------------------------------------
-- Subscription evidence: the single truth, extended in place.
--
-- Deterministic ordering (never regresses newer evidence):
--   * an event older than the current pointer is recorded, never advances it;
--   * a same-instant event advances only if strictly more severe (canceled >
--     reconciliation_required > past_due > incomplete > unknown > active), so both
--     arrival orders converge on the same state;
--   * canceled is terminal for its subscription;
--   * an event about a NON-current subscription cannot move the account;
--   * integrity reconciliation (duplicate/catalog/customer/tenant/period/session
--     binding) is sticky: only a reviewed_reconciliation source clears it.
-- A signed-webhook 'active' must carry a verified period or it is not active.
-- Verified active periods are recorded in commercial_subscription_periods.
-- ---------------------------------------------------------------------------
DROP FUNCTION public.commercial_subscription_apply_evidence(uuid, text, text, text, text, text, text, text, text, timestamptz, boolean, uuid);

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
  p_attempt uuid DEFAULT NULL,
  p_period_start timestamptz DEFAULT NULL,
  p_period_end timestamptz DEFAULT NULL,
  p_started_at timestamptz DEFAULT NULL,
  p_cancel_at_period_end boolean DEFAULT NULL,
  p_canceled_at timestamptz DEFAULT NULL,
  -- The signed-webhook path sets this: an 'active' without a verified period is NOT active.
  -- Reviewed/legacy callers keep their existing behavior (no period required).
  p_require_period boolean DEFAULT false
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
  v_nc text;
  v_sticky boolean;
  v_record_period boolean := false;
  v_rank_new integer;
  v_rank_prior integer;
BEGIN
  PERFORM public.commercial_billing_require_service();
  IF p_livemode IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Live-mode evidence is refused' USING ERRCODE='22023';
  END IF;
  IF p_source NOT IN ('signed_webhook', 'reviewed_reconciliation') THEN
    RAISE EXCEPTION 'Evidence source is not reviewed' USING ERRCODE='22023';
  END IF;
  IF (p_period_start IS NULL) <> (p_period_end IS NULL) THEN
    RAISE EXCEPTION 'A period needs both ends' USING ERRCODE='22023';
  END IF;

  SELECT * INTO existing FROM public.commercial_subscription_evidence
    WHERE shop_id = p_shop AND source_event_id = p_event_id;
  IF FOUND THEN
    IF (existing.provider_subscription_id, existing.provider_status, existing.catalog_version)
       IS DISTINCT FROM (p_subscription, p_status, p_catalog_version) THEN
      RAISE EXCEPTION 'Event id already holds different evidence' USING ERRCODE='CB409';
    END IF;
    RETURN jsonb_build_object('id', existing.id, 'replayed', true, 'advanced', false,
      'derived_state', existing.derived_state, 'reason', existing.derived_reason);
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

  -- On the signed-webhook path an 'active' is only active with a verified period (the settlement boundary).
  IF v_derived = 'active' AND p_require_period
     AND (p_period_start IS NULL OR p_started_at IS NULL) THEN
    v_derived := 'reconciliation_required'; v_reason := 'period_unverified';
  END IF;

  -- Period integrity: never overlap another period or change a subscription's start.
  IF v_derived = 'active' AND p_period_start IS NOT NULL THEN
    IF p_started_at IS NULL OR p_started_at > p_period_start
       OR p_period_end - p_period_start > interval '40 days' THEN
      v_derived := 'reconciliation_required'; v_reason := 'period_conflict';
    ELSIF EXISTS (SELECT 1 FROM public.commercial_subscription_periods p
                   WHERE p.shop_id = p_shop AND p.provider_subscription_id = p_subscription
                     AND p.subscription_started_at <> p_started_at)
       OR EXISTS (SELECT 1 FROM public.commercial_subscription_periods p
                   WHERE p.shop_id = p_shop AND p.period_start < p_period_end AND p.period_end > p_period_start
                     AND NOT (p.provider_subscription_id = p_subscription
                              AND p.period_start = p_period_start AND p.period_end = p_period_end)) THEN
      v_derived := 'reconciliation_required'; v_reason := 'period_conflict';
    END IF;
  END IF;

  v_sticky := acct.state = 'reconciliation_required'
    AND acct.state_reason IN ('duplicate_subscription', 'catalog_mismatch', 'customer_mismatch',
                              'tenant_conflict', 'period_conflict', 'period_unverified', 'session_binding_mismatch');

  IF acct.current_evidence_id IS NOT NULL THEN
    SELECT * INTO prior FROM public.commercial_subscription_evidence
      WHERE shop_id = p_shop AND id = acct.current_evidence_id;
  END IF;

  IF prior.id IS NOT NULL THEN
    IF prior.provider_subscription_id <> p_subscription THEN
      IF prior.derived_state IN ('active', 'past_due', 'incomplete') THEN
        IF v_derived IN ('active', 'past_due', 'incomplete') THEN
          -- A second live subscription for the same workspace: possible duplicate charge.
          v_derived := 'reconciliation_required'; v_reason := 'duplicate_subscription';
        ELSE
          v_advance := false; v_nc := 'other_subscription';
        END IF;
      END IF;
    ELSIF prior.derived_state = 'canceled' AND v_derived <> 'canceled' THEN
      v_advance := false; v_nc := 'subscription_terminal';
    END IF;
    IF v_advance AND p_event_created_at < prior.source_event_created_at THEN
      v_advance := false; v_nc := 'out_of_order';
    END IF;
    IF v_advance AND p_event_created_at = prior.source_event_created_at AND prior.derived_state <> v_derived THEN
      v_rank_new := CASE v_derived WHEN 'canceled' THEN 6 WHEN 'reconciliation_required' THEN 5 WHEN 'past_due' THEN 4
                                   WHEN 'incomplete' THEN 3 WHEN 'unknown' THEN 2 ELSE 1 END;
      v_rank_prior := CASE prior.derived_state WHEN 'canceled' THEN 6 WHEN 'reconciliation_required' THEN 5 WHEN 'past_due' THEN 4
                                   WHEN 'incomplete' THEN 3 WHEN 'unknown' THEN 2 ELSE 1 END;
      IF v_rank_new <= v_rank_prior THEN
        v_advance := false; v_nc := 'same_instant_tie';
      END IF;
    END IF;
  END IF;

  IF v_sticky AND p_source <> 'reviewed_reconciliation' THEN
    v_advance := false; v_nc := 'blocked_pending_review';
  END IF;

  INSERT INTO public.commercial_subscription_evidence (
    shop_id, provider_subscription_id, provider_customer_id, provider_status, derived_state,
    catalog_version, plan_key, price_lookup_key, evidence_source, source_event_id,
    source_event_created_at, livemode, attempt_id, subscription_started_at, period_start, period_end,
    cancel_at_period_end, canceled_at, derived_reason)
  VALUES (p_shop, p_subscription, p_customer, p_status, v_derived, p_catalog_version, p_plan_key,
    p_lookup_key, p_source, p_event_id, p_event_created_at, false, p_attempt, p_started_at,
    p_period_start, p_period_end, p_cancel_at_period_end, p_canceled_at, coalesce(v_reason, v_nc))
  RETURNING id INTO v_id;

  -- Record the verified period for ANY clean active evidence (even out of order: a period
  -- that was verified active stays verified). Never while an integrity block is in force.
  v_record_period := v_derived = 'active' AND p_period_start IS NOT NULL
    AND NOT (v_sticky AND p_source <> 'reviewed_reconciliation')
    AND v_nc IS DISTINCT FROM 'other_subscription';
  IF v_record_period AND NOT EXISTS (
       SELECT 1 FROM public.commercial_subscription_periods p
        WHERE p.shop_id = p_shop AND p.provider_subscription_id = p_subscription
          AND p.period_start = p_period_start AND p.period_end = p_period_end) THEN
    INSERT INTO public.commercial_subscription_periods (
      shop_id, provider_subscription_id, period_start, period_end, subscription_started_at, evidence_id, source_event_id)
    VALUES (p_shop, p_subscription, p_period_start, p_period_end, p_started_at, v_id, p_event_id);
    PERFORM public.commercial_billing_emit(p_shop, 'subscription_period_recorded', NULL, NULL, acct.state,
      jsonb_build_object('first_period', p_period_start = p_started_at));
  END IF;

  IF NOT v_advance THEN
    PERFORM public.commercial_billing_emit(p_shop, 'subscription_evidence_not_current', NULL, NULL, acct.state,
      jsonb_build_object('derived_state', v_derived, 'reason', v_nc));
    RETURN jsonb_build_object('id', v_id, 'replayed', false, 'advanced', false,
      'derived_state', v_derived, 'reason', v_nc);
  END IF;

  v_state := v_derived;
  UPDATE public.commercial_billing_accounts
     SET state = v_state, state_reason = v_reason, current_evidence_id = v_id,
         last_event_ref = p_event_id, last_event_created_at = p_event_created_at,
         version = version + 1
   WHERE shop_id = p_shop;
  PERFORM public.commercial_billing_emit(p_shop, 'subscription_evidence_applied', NULL, NULL, v_state,
    jsonb_build_object('derived_state', v_derived, 'source', p_source));
  RETURN jsonb_build_object('id', v_id, 'replayed', false, 'advanced', true, 'state', v_state,
    'derived_state', v_derived, 'reason', v_reason);
END $$;

-- ---------------------------------------------------------------------------
-- Verified-period lookup for settlement. Exact window match + complete chain back
-- to the subscription's own start (first activation). Facts only.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.commercial_subscription_period_status(
  p_shop uuid, p_start timestamptz, p_end timestamptz
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE
  cur public.commercial_subscription_periods;
  prev public.commercial_subscription_periods;
  v_first timestamptz;
  v_n integer := 0;
BEGIN
  SELECT * INTO cur FROM public.commercial_subscription_periods
    WHERE shop_id = p_shop AND period_start = p_start AND period_end = p_end;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('verified', false, 'chain_complete', false, 'reason', 'no_verified_period');
  END IF;
  v_first := cur.subscription_started_at;
  LOOP
    EXIT WHEN cur.period_start = cur.subscription_started_at;
    v_n := v_n + 1;
    IF v_n > 120 THEN
      RETURN jsonb_build_object('verified', true, 'chain_complete', false, 'period_id', NULL, 'reason', 'chain_too_long');
    END IF;
    SELECT * INTO prev FROM public.commercial_subscription_periods p
      WHERE p.shop_id = p_shop AND p.provider_subscription_id = cur.provider_subscription_id
        AND p.period_end = cur.period_start;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('verified', true, 'chain_complete', false, 'reason', 'chain_gap',
        'subscription_started_at', v_first);
    END IF;
    cur := prev;
  END LOOP;
  SELECT * INTO cur FROM public.commercial_subscription_periods
    WHERE shop_id = p_shop AND period_start = p_start AND period_end = p_end;
  RETURN jsonb_build_object('verified', true, 'chain_complete', true, 'period_id', cur.id,
    'provider_subscription_id', cur.provider_subscription_id, 'subscription_started_at', v_first,
    'reason', NULL);
END $$;

-- ---------------------------------------------------------------------------
-- Lapse gate for NEW paid execution. Service role only. Facts + a decision:
--   no commercial account row  -> allowed (explicit legacy mode; PR C invented no state)
--   account present            -> allowed only for reviewed ACTIVE evidence whose verified
--                                 period has not elapsed. Everything else is blocked.
-- Nothing is deleted, disabled or revoked by blocking: definitions, evidence and approvals stay.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.commercial_execution_gate(p_shop uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE
  acct public.commercial_billing_accounts;
  ev public.commercial_subscription_evidence;
BEGIN
  PERFORM public.commercial_billing_require_service();
  IF p_shop IS NULL THEN
    RAISE EXCEPTION 'shop is required' USING ERRCODE='22023';
  END IF;
  SELECT * INTO acct FROM public.commercial_billing_accounts WHERE shop_id = p_shop;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('allowed', true, 'mode', 'legacy_no_commercial_account', 'state', NULL, 'reason', NULL);
  END IF;
  IF acct.state <> 'active' THEN
    RETURN jsonb_build_object('allowed', false, 'mode', 'commercial', 'state', acct.state, 'reason',
      CASE acct.state
        WHEN 'past_due' THEN 'subscription_past_due'
        WHEN 'canceled' THEN 'subscription_canceled'
        WHEN 'incomplete' THEN 'subscription_incomplete'
        WHEN 'checkout_required' THEN 'checkout_required'
        WHEN 'checkout_pending' THEN 'checkout_in_progress'
        WHEN 'reconciliation_required' THEN coalesce(acct.state_reason, 'reconciliation_required')
        ELSE 'subscription_unknown' END);
  END IF;
  SELECT * INTO ev FROM public.commercial_subscription_evidence
    WHERE shop_id = p_shop AND id = acct.current_evidence_id;
  IF acct.current_evidence_id IS NULL OR NOT FOUND
     OR ev.derived_state <> 'active' OR ev.provider_status <> 'active' OR ev.livemode IS NOT FALSE
     OR ev.catalog_version <> '2026-11-03.v1' OR ev.plan_key <> 'founder-pilot'
     OR ev.price_lookup_key <> 'gradia_founder_pilot_2026_11_monthly'
     OR ev.evidence_source NOT IN ('signed_webhook', 'reviewed_reconciliation')
     OR acct.provider_mode <> 'test' OR acct.catalog_version <> '2026-11-03.v1' OR acct.plan_key <> 'founder-pilot' THEN
    RETURN jsonb_build_object('allowed', false, 'mode', 'commercial', 'state', acct.state, 'reason', 'reconciliation_required');
  END IF;
  IF ev.period_end IS NOT NULL AND ev.period_end <= clock_timestamp() THEN
    -- The verified period ended and no newer evidence has arrived: uncertain, so blocked.
    RETURN jsonb_build_object('allowed', false, 'mode', 'commercial', 'state', acct.state, 'reason', 'subscription_period_elapsed');
  END IF;
  RETURN jsonb_build_object('allowed', true, 'mode', 'commercial', 'state', acct.state, 'reason', NULL);
END $$;

-- ---------------------------------------------------------------------------
-- Customer Portal authority. Service role + LIVE OWNER of that exact shop only.
-- Returns the exact bound PLATFORM customer; never a client-supplied one.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.commercial_portal_authorize(p_shop uuid, p_actor uuid, p_return_target text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  acct public.commercial_billing_accounts;
BEGIN
  PERFORM public.commercial_billing_require_service();
  IF NOT public.commercial_billing_actor_is_owner(p_shop, p_actor) THEN
    RAISE EXCEPTION 'Live owner authority required' USING ERRCODE='42501';
  END IF;
  IF p_return_target IS NULL OR p_return_target NOT IN ('agents', 'billing') THEN
    RAISE EXCEPTION 'Invalid return target' USING ERRCODE='22023';
  END IF;
  SELECT * INTO acct FROM public.commercial_billing_accounts WHERE shop_id = p_shop FOR UPDATE;
  IF NOT FOUND OR acct.platform_customer_id IS NULL OR acct.provider_mode <> 'test' THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'no_platform_customer');
  END IF;
  PERFORM public.commercial_billing_emit(p_shop, 'portal_session_requested', NULL, p_actor, acct.state,
    jsonb_build_object('return_target', p_return_target));
  RETURN jsonb_build_object('authorized', true, 'customer_id', acct.platform_customer_id, 'state', acct.state);
END $$;

-- ---------------------------------------------------------------------------
-- Webhook ingest. Service role only; the application has ALREADY verified the raw-body
-- signature, rejected Connect envelopes and live-mode objects, and normalized the
-- event into `p_facts`. This function:
--   1. takes the durable replay claim (advisory lock + unique receipt) — an identical
--      replay returns the original outcome, changed content under the same id is CB409;
--   2. resolves the tenant ONLY from server-held bindings (bound platform customer,
--      known subscription, checkout session/attempt, approved catalog/plan/price). A
--      metadata shop id is only cross-checked, never trusted to select a tenant;
--   3. applies subscription evidence through commercial_subscription_apply_evidence;
--   4. records provider facts (never acting on them);
--   5. writes the receipt LAST, in the same transaction as the effect.
-- Checkout completion is never 'active'.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.commercial_webhook_ingest(
  p_event_id text,
  p_event_type text,
  p_event_created timestamptz,
  p_payload_digest text,
  p_livemode boolean,
  p_facts jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  rec public.commercial_webhook_receipts;
  acct public.commercial_billing_accounts;
  att public.commercial_checkout_attempts;
  prior public.commercial_subscription_evidence;
  v_obj text;
  v_shop uuid;
  v_customer text;
  v_sub text;
  v_attempt uuid;
  v_applied jsonb;
  v_outcome text;
  v_reason text;
  v_receipt uuid;
  v_evidence uuid;
  v_kind text;
  v_amount bigint;
  v_known boolean;
  v_status text;
BEGIN
  PERFORM public.commercial_billing_require_service();
  IF p_livemode IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Live-mode events are refused' USING ERRCODE='22023';
  END IF;
  IF p_event_id IS NULL OR p_event_id !~ '^evt_[A-Za-z0-9_]{6,120}$' OR p_event_type IS NULL
     OR p_event_created IS NULL OR p_payload_digest IS NULL OR p_payload_digest !~ '^[0-9a-f]{64}$'
     OR p_facts IS NULL OR jsonb_typeof(p_facts) <> 'object' THEN
    RAISE EXCEPTION 'Invalid webhook event' USING ERRCODE='22023';
  END IF;

  -- 1. The replay claim. Serialized per event id; the receipt is written last.
  PERFORM pg_advisory_xact_lock(hashtextextended('commercial_webhook_receipt:' || p_event_id, 0));
  SELECT * INTO rec FROM public.commercial_webhook_receipts WHERE event_id = p_event_id;
  IF FOUND THEN
    IF rec.payload_digest <> p_payload_digest OR rec.event_type <> p_event_type THEN
      RAISE EXCEPTION 'Event id was replayed with different content' USING ERRCODE='CB409';
    END IF;
    RETURN jsonb_build_object('outcome', rec.outcome, 'reason', rec.reason, 'shop_id', rec.shop_id,
      'replayed', true);
  END IF;

  v_obj := p_facts ->> 'object';
  v_customer := p_facts ->> 'customer_id';
  v_sub := p_facts ->> 'subscription_id';
  IF v_customer IS NOT NULL AND v_customer !~ '^cus_[A-Za-z0-9_]{4,120}$' THEN
    RAISE EXCEPTION 'Invalid customer id' USING ERRCODE='22023';
  END IF;
  IF v_sub IS NOT NULL AND v_sub !~ '^sub_[A-Za-z0-9_]{4,120}$' THEN
    RAISE EXCEPTION 'Invalid subscription id' USING ERRCODE='22023';
  END IF;

  -- 2. Tenant resolution from SERVER-HELD bindings only.
  IF v_obj = 'checkout_session' THEN
    IF coalesce(p_facts ->> 'session_id', '') !~ '^cs_test_[A-Za-z0-9_]{4,200}$' THEN
      RAISE EXCEPTION 'Invalid session id' USING ERRCODE='22023';
    END IF;
    SELECT * INTO att FROM public.commercial_checkout_attempts WHERE provider_session_id = p_facts ->> 'session_id';
    IF FOUND THEN v_shop := att.shop_id; END IF;
  ELSIF v_obj IN ('subscription', 'invoice', 'charge', 'credit_note') THEN
    IF v_customer IS NOT NULL THEN
      SELECT a.shop_id INTO v_shop FROM public.commercial_billing_accounts a WHERE a.platform_customer_id = v_customer;
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported event object' USING ERRCODE='22023';
  END IF;

  IF v_shop IS NULL THEN
    INSERT INTO public.commercial_webhook_receipts (event_id, event_type, event_created_at, payload_digest, livemode, shop_id, outcome, reason)
    VALUES (p_event_id, p_event_type, p_event_created, p_payload_digest, false, NULL, 'unresolved',
            CASE WHEN v_obj = 'checkout_session' THEN 'session_unbound' ELSE 'customer_unbound' END);
    RETURN jsonb_build_object('outcome', 'unresolved',
      'reason', CASE WHEN v_obj = 'checkout_session' THEN 'session_unbound' ELSE 'customer_unbound' END,
      'shop_id', NULL, 'replayed', false);
  END IF;

  SELECT * INTO acct FROM public.commercial_billing_accounts WHERE shop_id = v_shop FOR UPDATE;
  IF acct.provider_mode <> 'test' THEN
    RAISE EXCEPTION 'Account is not a test-mode account' USING ERRCODE='22023';
  END IF;

  -- Tenant cross-check: a metadata shop id that disagrees is an integrity conflict.
  IF p_facts ->> 'metadata_shop_id' IS NOT NULL AND p_facts ->> 'metadata_shop_id' <> v_shop::text THEN
    PERFORM public.commercial_billing_advance(v_shop, 'reconciliation_required', 'tenant_conflict', NULL);
    PERFORM public.commercial_billing_emit(v_shop, 'webhook_conflict', NULL, NULL, 'reconciliation_required',
      jsonb_build_object('reason', 'tenant_conflict'));
    INSERT INTO public.commercial_webhook_receipts (event_id, event_type, event_created_at, payload_digest, livemode, shop_id, outcome, reason)
    VALUES (p_event_id, p_event_type, p_event_created, p_payload_digest, false, v_shop, 'refused', 'tenant_conflict');
    RETURN jsonb_build_object('outcome', 'refused', 'reason', 'tenant_conflict', 'shop_id', v_shop, 'replayed', false);
  END IF;

  -- 3a. Checkout session observations: never 'active'.
  IF v_obj = 'checkout_session' THEN
    IF v_customer IS NOT NULL AND acct.platform_customer_id IS DISTINCT FROM v_customer THEN
      PERFORM public.commercial_billing_advance(v_shop, 'reconciliation_required', 'session_binding_mismatch', att.id);
      PERFORM public.commercial_billing_emit(v_shop, 'webhook_conflict', att.id, NULL, 'reconciliation_required',
        jsonb_build_object('reason', 'session_binding_mismatch'));
      INSERT INTO public.commercial_webhook_receipts (event_id, event_type, event_created_at, payload_digest, livemode, shop_id, outcome, reason)
      VALUES (p_event_id, p_event_type, p_event_created, p_payload_digest, false, v_shop, 'refused', 'session_binding_mismatch');
      RETURN jsonb_build_object('outcome', 'refused', 'reason', 'session_binding_mismatch', 'shop_id', v_shop, 'replayed', false);
    END IF;
    v_outcome := 'observed'; v_reason := NULL;
    IF p_facts ->> 'outcome' = 'completed' THEN
      IF att.status = 'session_open' THEN
        UPDATE public.commercial_checkout_attempts SET status = 'completed_unverified' WHERE id = att.id;
        IF acct.state = 'checkout_pending' THEN
          PERFORM public.commercial_billing_advance(v_shop, 'checkout_pending', 'checkout_completed_awaiting_evidence', att.id);
        END IF;
      END IF;
      PERFORM public.commercial_billing_emit(v_shop, 'checkout_completion_observed', att.id, NULL, acct.state,
        jsonb_build_object('attempt_no', att.attempt_no, 'attempt_status', att.status));
      v_reason := 'completion_is_not_active';
    ELSIF p_facts ->> 'outcome' = 'expired' THEN
      IF att.status = 'session_open' THEN
        UPDATE public.commercial_checkout_attempts SET status = 'expired' WHERE id = att.id;
        IF acct.state = 'checkout_pending' AND acct.current_attempt_id = att.id THEN
          PERFORM public.commercial_billing_advance(v_shop, 'checkout_required', 'checkout_expired', att.id);
        END IF;
      END IF;
      PERFORM public.commercial_billing_emit(v_shop, 'checkout_expiry_observed', att.id, NULL, acct.state,
        jsonb_build_object('attempt_no', att.attempt_no));
    ELSE
      RAISE EXCEPTION 'Unsupported checkout observation' USING ERRCODE='22023';
    END IF;
    INSERT INTO public.commercial_webhook_receipts (event_id, event_type, event_created_at, payload_digest, livemode, shop_id, outcome, reason)
    VALUES (p_event_id, p_event_type, p_event_created, p_payload_digest, false, v_shop, v_outcome, v_reason);
    RETURN jsonb_build_object('outcome', v_outcome, 'reason', v_reason, 'shop_id', v_shop, 'replayed', false);
  END IF;

  -- 3b. Subscription evidence.
  IF v_obj = 'subscription' THEN
    IF v_sub IS NULL OR v_customer IS NULL THEN
      RAISE EXCEPTION 'A subscription event needs subscription and customer ids' USING ERRCODE='22023';
    END IF;
    v_status := p_facts ->> 'status';
    SELECT * INTO prior FROM public.commercial_subscription_evidence
      WHERE shop_id = v_shop AND provider_subscription_id = v_sub
      ORDER BY source_event_created_at DESC, recorded_at DESC LIMIT 1;
    v_known := prior.id IS NOT NULL;
    IF NOT v_known THEN
      -- A subscription we have never seen must come from a Checkout WE created for this shop.
      BEGIN
        SELECT a.id INTO v_attempt FROM public.commercial_checkout_attempts a
         WHERE a.shop_id = v_shop AND a.id = (p_facts ->> 'checkout_attempt_id')::uuid
           AND a.provider_session_id IS NOT NULL AND a.status IN ('session_open', 'completed_unverified');
      EXCEPTION WHEN invalid_text_representation THEN
        v_attempt := NULL;
      END;
      IF v_attempt IS NULL THEN
        INSERT INTO public.commercial_webhook_receipts (event_id, event_type, event_created_at, payload_digest, livemode, shop_id, outcome, reason)
        VALUES (p_event_id, p_event_type, p_event_created, p_payload_digest, false, v_shop, 'unresolved', 'subscription_unbound');
        RETURN jsonb_build_object('outcome', 'unresolved', 'reason', 'subscription_unbound', 'shop_id', v_shop, 'replayed', false);
      END IF;
    END IF;

    v_applied := public.commercial_subscription_apply_evidence(
      v_shop, v_sub, v_customer, v_status,
      coalesce(p_facts ->> 'catalog_version', ''), coalesce(p_facts ->> 'plan_key', ''),
      coalesce(p_facts ->> 'price_lookup_key', ''),
      'signed_webhook', p_event_id, p_event_created, false, v_attempt,
      (p_facts ->> 'period_start')::timestamptz, (p_facts ->> 'period_end')::timestamptz,
      (p_facts ->> 'started_at')::timestamptz,
      (p_facts ->> 'cancel_at_period_end')::boolean, (p_facts ->> 'canceled_at')::timestamptz, true);
    v_evidence := (v_applied ->> 'id')::uuid;
    v_outcome := CASE WHEN (v_applied ->> 'advanced')::boolean THEN 'applied' ELSE 'not_current' END;
    v_reason := v_applied ->> 'reason';

    INSERT INTO public.commercial_webhook_receipts (event_id, event_type, event_created_at, payload_digest, livemode, shop_id, outcome, reason, evidence_id)
    VALUES (p_event_id, p_event_type, p_event_created, p_payload_digest, false, v_shop, v_outcome, v_reason, v_evidence)
    RETURNING id INTO v_receipt;

    -- Provider-reported lifecycle facts (never acted on).
    IF v_status = 'canceled' THEN
      INSERT INTO public.commercial_provider_facts (shop_id, receipt_id, kind, provider_subscription_id, provider_object_id, occurred_at)
      VALUES (v_shop, v_receipt, 'cancellation', v_sub, v_sub,
              coalesce((p_facts ->> 'canceled_at')::timestamptz, p_event_created));
    ELSIF coalesce((p_facts ->> 'cancel_at_period_end')::boolean, false)
          AND coalesce(prior.cancel_at_period_end, false) = false THEN
      INSERT INTO public.commercial_provider_facts (shop_id, receipt_id, kind, provider_subscription_id, provider_object_id, occurred_at)
      VALUES (v_shop, v_receipt, 'cancellation_scheduled', v_sub, v_sub, p_event_created);
    END IF;
    RETURN jsonb_build_object('outcome', v_outcome, 'reason', v_reason, 'shop_id', v_shop, 'replayed', false,
      'state', (SELECT state FROM public.commercial_billing_accounts WHERE shop_id = v_shop));
  END IF;

  -- 3c. Provider facts: invoice / refund / credit note. Recorded, never acted on.
  IF v_obj = 'invoice' THEN
    v_kind := CASE p_facts ->> 'outcome' WHEN 'payment_failed' THEN 'payment_failed'
                                         WHEN 'payment_succeeded' THEN 'payment_succeeded' ELSE NULL END;
    IF v_kind IS NULL OR coalesce(p_facts ->> 'invoice_id', '') !~ '^in_[A-Za-z0-9_]{4,120}$' THEN
      RAISE EXCEPTION 'Invalid invoice event' USING ERRCODE='22023';
    END IF;
    IF v_sub IS NULL OR NOT EXISTS (SELECT 1 FROM public.commercial_subscription_evidence e
                                     WHERE e.shop_id = v_shop AND e.provider_subscription_id = v_sub) THEN
      INSERT INTO public.commercial_webhook_receipts (event_id, event_type, event_created_at, payload_digest, livemode, shop_id, outcome, reason)
      VALUES (p_event_id, p_event_type, p_event_created, p_payload_digest, false, v_shop, 'unresolved', 'subscription_unbound');
      RETURN jsonb_build_object('outcome', 'unresolved', 'reason', 'subscription_unbound', 'shop_id', v_shop, 'replayed', false);
    END IF;
    v_amount := (p_facts ->> 'amount_cents')::bigint;
    INSERT INTO public.commercial_webhook_receipts (event_id, event_type, event_created_at, payload_digest, livemode, shop_id, outcome, reason)
    VALUES (p_event_id, p_event_type, p_event_created, p_payload_digest, false, v_shop, 'recorded_fact', v_kind)
    RETURNING id INTO v_receipt;
    INSERT INTO public.commercial_provider_facts (shop_id, receipt_id, kind, provider_subscription_id, provider_invoice_id,
      provider_object_id, amount_cents, currency, attempt_count, occurred_at)
    VALUES (v_shop, v_receipt, v_kind, v_sub, p_facts ->> 'invoice_id', p_facts ->> 'invoice_id', v_amount,
      lower(p_facts ->> 'currency'), (p_facts ->> 'attempt_count')::integer, p_event_created);
  ELSIF v_obj IN ('charge', 'credit_note') THEN
    v_kind := CASE v_obj WHEN 'charge' THEN 'refund' ELSE 'credit_note' END;
    IF coalesce(p_facts ->> 'object_id', '') !~ '^[a-z]{2,3}_[A-Za-z0-9_]{4,120}$' THEN
      RAISE EXCEPTION 'Invalid refund or credit event' USING ERRCODE='22023';
    END IF;
    v_amount := (p_facts ->> 'amount_cents')::bigint;
    INSERT INTO public.commercial_webhook_receipts (event_id, event_type, event_created_at, payload_digest, livemode, shop_id, outcome, reason)
    VALUES (p_event_id, p_event_type, p_event_created, p_payload_digest, false, v_shop, 'recorded_fact', v_kind)
    RETURNING id INTO v_receipt;
    INSERT INTO public.commercial_provider_facts (shop_id, receipt_id, kind, provider_subscription_id, provider_invoice_id,
      provider_object_id, amount_cents, currency, occurred_at)
    VALUES (v_shop, v_receipt, v_kind, v_sub, p_facts ->> 'invoice_id', p_facts ->> 'object_id', v_amount,
      lower(p_facts ->> 'currency'), p_event_created);
  END IF;
  PERFORM public.commercial_billing_emit(v_shop, 'provider_fact_recorded', NULL, NULL, acct.state,
    jsonb_build_object('kind', v_kind));
  RETURN jsonb_build_object('outcome', 'recorded_fact', 'reason', v_kind, 'shop_id', v_shop, 'replayed', false);
END $$;

-- ---------------------------------------------------------------------------
-- Adjustment contract. Service role only. No caller exists in this PR's application
-- code; nothing applies an adjustment, credits, refunds or retries anything.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.commercial_adjustment_propose(
  p_shop uuid,
  p_settlement uuid,
  p_kind text,
  p_signed_amount_cents bigint,
  p_reason_code text,
  p_evidence_fact uuid,
  p_idempotency_key text,
  p_proposed_by text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  st public.commercial_settlements;
  existing public.commercial_settlement_adjustments;
  adj public.commercial_settlement_adjustments;
BEGIN
  PERFORM public.commercial_billing_require_service();
  IF p_shop IS NULL OR p_settlement IS NULL OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'Invalid adjustment request' USING ERRCODE='22023';
  END IF;
  -- Serialize with settlement writes for this shop (the account row is the single shop lock).
  PERFORM 1 FROM public.commercial_billing_accounts WHERE shop_id = p_shop FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No billing account' USING ERRCODE='22023';
  END IF;
  SELECT * INTO st FROM public.commercial_settlements WHERE shop_id = p_shop AND id = p_settlement;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only a settled period can be adjusted' USING ERRCODE='CB422';
  END IF;
  IF p_evidence_fact IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.commercial_provider_facts f WHERE f.shop_id = p_shop AND f.id = p_evidence_fact) THEN
    RAISE EXCEPTION 'Evidence fact belongs to another workspace or does not exist' USING ERRCODE='22023';
  END IF;
  SELECT * INTO existing FROM public.commercial_settlement_adjustments
    WHERE shop_id = p_shop AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF (existing.settlement_id, existing.kind, existing.signed_amount_cents, existing.reason_code, existing.evidence_fact_id, existing.proposed_by)
       IS NOT DISTINCT FROM (p_settlement, p_kind, p_signed_amount_cents, p_reason_code, p_evidence_fact, p_proposed_by) THEN
      RETURN jsonb_build_object('action', 'replay', 'adjustment_id', existing.id);
    END IF;
    RAISE EXCEPTION 'A different adjustment already uses this identity' USING ERRCODE='CB409';
  END IF;
  INSERT INTO public.commercial_settlement_adjustments (
    shop_id, settlement_id, kind, signed_amount_cents, reason_code, evidence_fact_id,
    target_period_start, idempotency_key, proposed_by)
  VALUES (p_shop, p_settlement, p_kind, p_signed_amount_cents, p_reason_code, p_evidence_fact,
    st.window_end, p_idempotency_key, p_proposed_by)
  RETURNING * INTO adj;
  PERFORM public.commercial_billing_emit(p_shop, 'adjustment_proposed', NULL, NULL,
    (SELECT state FROM public.commercial_billing_accounts WHERE shop_id = p_shop),
    jsonb_build_object('kind', p_kind, 'negative', p_signed_amount_cents < 0));
  RETURN jsonb_build_object('action', 'created', 'adjustment_id', adj.id, 'status', 'pending_review');
END $$;

CREATE FUNCTION public.commercial_adjustment_review(
  p_shop uuid,
  p_adjustment uuid,
  p_decision text,
  p_reviewer_ref text,
  p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  existing public.commercial_adjustment_reviews;
BEGIN
  PERFORM public.commercial_billing_require_service();
  IF p_decision IS NULL OR p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Invalid decision' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM public.commercial_billing_accounts WHERE shop_id = p_shop FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM public.commercial_settlement_adjustments a WHERE a.shop_id = p_shop AND a.id = p_adjustment) THEN
    RAISE EXCEPTION 'Unknown adjustment' USING ERRCODE='22023';
  END IF;
  SELECT * INTO existing FROM public.commercial_adjustment_reviews WHERE adjustment_id = p_adjustment;
  IF FOUND THEN
    IF existing.decision = p_decision AND existing.reviewer_ref = p_reviewer_ref THEN
      RETURN jsonb_build_object('action', 'replay', 'decision', existing.decision);
    END IF;
    RAISE EXCEPTION 'This adjustment already has a decision' USING ERRCODE='CB409';
  END IF;
  INSERT INTO public.commercial_adjustment_reviews (shop_id, adjustment_id, decision, reviewer_ref, note)
  VALUES (p_shop, p_adjustment, p_decision, p_reviewer_ref, p_note);
  PERFORM public.commercial_billing_emit(p_shop, 'adjustment_reviewed', NULL, NULL,
    (SELECT state FROM public.commercial_billing_accounts WHERE shop_id = p_shop),
    jsonb_build_object('decision', p_decision));
  RETURN jsonb_build_object('action', 'recorded', 'decision', p_decision);
END $$;

-- Facts for the owner / service: pending, approved or rejected. Never 'applied'.
CREATE FUNCTION public.commercial_adjustment_read(p_shop uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NOT (coalesce(auth.role(), '') = 'service_role' OR public.commercial_is_active_owner(p_shop)) THEN
    RAISE EXCEPTION 'Owner authority required' USING ERRCODE='42501';
  END IF;
  RETURN jsonb_build_object('shop_id', p_shop, 'adjustments',
    (SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', a.id, 'settlement_id', a.settlement_id, 'kind', a.kind,
        'signed_amount_cents', a.signed_amount_cents, 'target_period_start', a.target_period_start,
        'status', CASE r.decision WHEN 'approved' THEN 'approved' WHEN 'rejected' THEN 'rejected' ELSE 'pending_review' END,
        'created_at', a.created_at) ORDER BY a.created_at), '[]'::jsonb)
       FROM public.commercial_settlement_adjustments a
       LEFT JOIN public.commercial_adjustment_reviews r ON r.adjustment_id = a.id
      WHERE a.shop_id = p_shop));
END $$;

-- ---------------------------------------------------------------------------
-- Settlement binds to the EXACT verified Stripe subscription period (founder decision
-- 2026-11-16). The UTC-midnight / 28-31-day placeholder no longer authorizes settlement.
-- CREATE OR REPLACE keeps the PR D ACLs; only the window rule changes.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.commercial_settlement_evidence(
  p_shop uuid,
  p_window_start timestamptz,
  p_window_end timestamptz,
  p_as_of timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE
  -- The database clock fixes the instant when the caller does not, so application
  -- clock skew can never put the evidence instant in the future.
  as_of timestamptz := coalesce(p_as_of, clock_timestamp());
  usage jsonb;
  membership jsonb;
  acct public.commercial_billing_accounts;
  existing public.commercial_settlements;
BEGIN
  IF NOT (coalesce(auth.role(), '') = 'service_role' OR public.commercial_is_active_owner(p_shop)) THEN
    RAISE EXCEPTION 'Owner authority required' USING ERRCODE='42501';
  END IF;
  IF p_window_start IS NULL OR p_window_end IS NULL OR p_window_end <= p_window_start
     OR p_window_end - p_window_start > interval '40 days' THEN
    RAISE EXCEPTION 'Invalid window' USING ERRCODE='22023';
  END IF;
  usage := public.commercial_usage_read(p_shop, p_window_start, p_window_end, as_of);
  membership := public.commercial_membership_read(p_shop, p_window_start, p_window_end, as_of);
  SELECT * INTO acct FROM public.commercial_billing_accounts WHERE shop_id = p_shop;
  SELECT * INTO existing FROM public.commercial_settlements
    WHERE shop_id = p_shop AND window_start = p_window_start AND window_end = p_window_end;
  RETURN jsonb_build_object(
    'shop_id', p_shop, 'window_start', p_window_start, 'window_end', p_window_end, 'as_of', as_of,
    'usage', usage, 'membership', membership,
    'evidence_digest', public.commercial_settlement_evidence_digest(usage, membership),
    'eligibility', jsonb_build_object(
      'window_closed', p_window_end <= as_of AND as_of <= clock_timestamp(),
      'utc_day_aligned', (p_window_start AT TIME ZONE 'UTC')::time = time '00:00'
                         AND (p_window_end AT TIME ZONE 'UTC')::time = time '00:00',
      'window_days', round(extract(epoch FROM (p_window_end - p_window_start)) / 86400)::int,
      -- The settlement boundary: the exact verified Stripe subscription period (PR E1).
      'subscription_period', public.commercial_subscription_period_status(p_shop, p_window_start, p_window_end),
      'account_present', acct.shop_id IS NOT NULL,
      'catalog_version', acct.catalog_version, 'plan_key', acct.plan_key,
      'has_platform_customer', acct.platform_customer_id IS NOT NULL,
      'account_state', acct.state,
      'account_version', acct.version,
      'overlapping_settlement_id', (SELECT s.id FROM public.commercial_settlements s
         WHERE s.shop_id = p_shop AND s.window_start < p_window_end AND s.window_end > p_window_start
           AND NOT (s.window_start = p_window_start AND s.window_end = p_window_end) LIMIT 1),
      'existing_settlement_id', existing.id,
      'existing_document_digest', existing.document_digest,
      'existing_evidence_digest', existing.evidence_digest));
END $$;

CREATE OR REPLACE FUNCTION public.commercial_settlement_begin(
  p_shop uuid,
  p_actor uuid,
  p_catalog_version text,
  p_plan_key text,
  p_window_start timestamptz,
  p_window_end timestamptz,
  p_as_of timestamptz,
  p_evidence_digest text,
  p_document jsonb,
  p_document_digest text,
  p_mapping_version text,
  p_deliveries jsonb,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  acct public.commercial_billing_accounts;
  existing public.commercial_settlements;
  hdr public.commercial_settlements;
  usage jsonb;
  membership jsonb;
  computed text;
  comp jsonb;
  dlv jsonb;
  cov_from timestamptz;
  base_c integer; seat_c integer; usage_c integer; cap_c integer; total_c integer;
  sum_usage bigint := 0;
  seat_found boolean := false;
  comp_count integer := 0;
  seen text[] := ARRAY[]::text[];
  basis text; ev_value bigint; line_id uuid;
  dlv_by_component jsonb := '{}'::jsonb;
  period_status jsonb;
BEGIN
  PERFORM public.commercial_billing_require_service();
  IF NOT public.commercial_billing_actor_is_owner(p_shop, p_actor) THEN
    RAISE EXCEPTION 'Owner authority required' USING ERRCODE='42501';
  END IF;
  IF p_catalog_version IS DISTINCT FROM '2026-11-03.v1' OR p_plan_key IS DISTINCT FROM 'founder-pilot' THEN
    RAISE EXCEPTION 'Unapproved catalog or plan' USING ERRCODE='22023';
  END IF;
  IF p_window_start IS NULL OR p_window_end IS NULL OR p_as_of IS NULL
     OR p_evidence_digest !~ '^[0-9a-f]{64}$' OR p_document_digest !~ '^[0-9a-f]{64}$'
     OR p_document IS NULL OR jsonb_typeof(p_document) <> 'object'
     OR p_deliveries IS NULL OR jsonb_typeof(p_deliveries) <> 'array'
     OR p_mapping_version IS NULL OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'Invalid settlement request' USING ERRCODE='22023';
  END IF;

  -- Exact and closed. The window must equal a VERIFIED Stripe subscription period (below);
  -- calendar/UTC alignment and month length are no longer what authorizes a settlement.
  IF p_window_end <= p_window_start OR p_window_end - p_window_start > interval '40 days' THEN
    RAISE EXCEPTION 'Window is not a subscription period' USING ERRCODE='CB422';
  END IF;
  IF p_window_end > p_as_of OR p_as_of > clock_timestamp() THEN
    RAISE EXCEPTION 'Window is not closed at the evidence instant' USING ERRCODE='CB422';
  END IF;

  -- Serialize every settlement and activation-adjacent write for this shop on the
  -- account row (same lock order as PR C: the account row is the single shop lock).
  SELECT * INTO acct FROM public.commercial_billing_accounts WHERE shop_id = p_shop FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No billing account' USING ERRCODE='CB422';
  END IF;
  IF acct.catalog_version <> p_catalog_version OR acct.plan_key <> p_plan_key THEN
    RAISE EXCEPTION 'Account is bound to a different catalog or plan' USING ERRCODE='CB409';
  END IF;
  IF acct.platform_customer_id IS NULL THEN
    RAISE EXCEPTION 'No platform customer' USING ERRCODE='CB422';
  END IF;
  -- An integrity block (duplicate subscription, period conflict, ...) means the ledger and
  -- the provider disagree: nothing is settled until a reviewed reconciliation clears it.
  IF acct.state = 'reconciliation_required' THEN
    RAISE EXCEPTION 'Account requires reconciliation' USING ERRCODE='CB422';
  END IF;
  -- Exact verified Stripe subscription period, chained back to the subscription's own start.
  period_status := public.commercial_subscription_period_status(p_shop, p_window_start, p_window_end);
  IF (period_status ->> 'verified')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'Window is not a verified subscription period' USING ERRCODE='CB422';
  END IF;
  IF (period_status ->> 'chain_complete')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'Subscription period history is incomplete' USING ERRCODE='CB422';
  END IF;

  -- Complete membership coverage of the whole window (never reconstructed).
  SELECT c.covered_from INTO cov_from FROM public.commercial_membership_coverage c
    WHERE c.shop_id = p_shop AND c.recorded_at <= p_as_of;
  IF cov_from IS NULL OR cov_from > p_window_start THEN
    RAISE EXCEPTION 'Membership coverage is incomplete' USING ERRCODE='CB422';
  END IF;

  -- The evidence the document was built from must still be exactly this evidence.
  usage := public.commercial_usage_read(p_shop, p_window_start, p_window_end, p_as_of);
  membership := public.commercial_membership_read(p_shop, p_window_start, p_window_end, p_as_of);
  computed := public.commercial_settlement_evidence_digest(usage, membership);

  SELECT * INTO existing FROM public.commercial_settlements
    WHERE shop_id = p_shop AND window_start = p_window_start AND window_end = p_window_end;
  IF FOUND THEN
    IF existing.catalog_version = p_catalog_version AND existing.plan_key = p_plan_key
       AND existing.document_digest = p_document_digest AND existing.evidence_digest = p_evidence_digest
       AND existing.idempotency_key = p_idempotency_key AND existing.mapping_version = p_mapping_version
       AND computed = existing.evidence_digest THEN
      RETURN jsonb_build_object('action', 'replay', 'settlement_id', existing.id,
        'lines', (SELECT coalesce(jsonb_agg(jsonb_build_object('line_id', l.id, 'component', l.component,
           'delivery_status', l.delivery_status) ORDER BY l.component), '[]'::jsonb)
           FROM public.commercial_settlement_lines l WHERE l.settlement_id = existing.id));
    END IF;
    RAISE EXCEPTION 'A different settlement already exists for this window' USING ERRCODE='CB409';
  END IF;
  IF computed <> p_evidence_digest THEN
    RAISE EXCEPTION 'Evidence changed since it was read' USING ERRCODE='CB409';
  END IF;
  IF EXISTS (SELECT 1 FROM public.commercial_settlements s
              WHERE s.shop_id = p_shop AND s.window_start < p_window_end AND s.window_end > p_window_start) THEN
    RAISE EXCEPTION 'Window overlaps an existing settlement' USING ERRCODE='CB409';
  END IF;

  -- Document invariants (arithmetic only; pricing stays in the reviewed preview code).
  IF p_document ->> 'state' IS DISTINCT FROM 'ok'
     OR p_document ->> 'catalog_version' IS DISTINCT FROM p_catalog_version
     OR p_document ->> 'plan_key' IS DISTINCT FROM p_plan_key
     OR jsonb_typeof(p_document -> 'components') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Document is not a settleable preview' USING ERRCODE='22023';
  END IF;
  BEGIN
    base_c := (p_document ->> 'base_cents')::int;
    seat_c := (p_document ->> 'seat_cents')::int;
    usage_c := (p_document ->> 'usage_cents')::int;
    cap_c := (p_document ->> 'usage_cap_cents')::int;
    total_c := (p_document ->> 'total_cents')::int;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'Document totals are malformed' USING ERRCODE='22023';
  END;
  IF base_c < 0 OR seat_c < 0 OR usage_c < 0 OR cap_c < 0 OR total_c <> base_c + seat_c + usage_c OR usage_c > cap_c THEN
    RAISE EXCEPTION 'Document totals are inconsistent or exceed the cap' USING ERRCODE='22023';
  END IF;

  FOR dlv IN SELECT * FROM jsonb_array_elements(p_deliveries) LOOP
    IF jsonb_typeof(dlv) <> 'object' OR dlv ->> 'component' IS NULL OR dlv_by_component ? (dlv ->> 'component') THEN
      RAISE EXCEPTION 'Malformed or duplicate delivery' USING ERRCODE='22023';
    END IF;
    dlv_by_component := dlv_by_component || jsonb_build_object(dlv ->> 'component', dlv);
  END LOOP;

  FOR comp IN SELECT * FROM jsonb_array_elements(p_document -> 'components') LOOP
    comp_count := comp_count + 1;
    IF comp ->> 'component' IS NULL OR comp ->> 'component' = ANY (seen)
       OR comp ->> 'component' NOT IN ('standard_digital_outcome', 'qualified_lead', 'confirmed_appointment',
          'inbound_voice_agent_minute', 'sms_segment', 'extra_operator_seat_proration') THEN
      RAISE EXCEPTION 'Unknown or duplicate component' USING ERRCODE='22023';
    END IF;
    seen := seen || (comp ->> 'component');
    IF comp ->> 'component' = 'extra_operator_seat_proration' THEN
      seat_found := true;
      IF (comp ->> 'charge_cents')::int <> seat_c THEN
        RAISE EXCEPTION 'Seat component does not match the document total' USING ERRCODE='22023';
      END IF;
    ELSE
      sum_usage := sum_usage + (comp ->> 'charge_cents')::int;
    END IF;
  END LOOP;
  IF comp_count <> 6 OR NOT seat_found OR sum_usage <> usage_c THEN
    RAISE EXCEPTION 'Components do not match the document totals' USING ERRCODE='22023';
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(dlv_by_component)) > 6 THEN
    RAISE EXCEPTION 'Too many deliveries' USING ERRCODE='22023';
  END IF;

  INSERT INTO public.commercial_settlements (
    shop_id, catalog_version, plan_key, window_start, window_end, as_of, evidence_digest, document_digest,
    document, base_cents, seat_cents, usage_cents, usage_cap_cents, total_cents, mapping_version,
    stripe_customer_id, account_version, requested_by, idempotency_key)
  VALUES (p_shop, p_catalog_version, p_plan_key, p_window_start, p_window_end, p_as_of, p_evidence_digest,
    p_document_digest, p_document, base_c, seat_c, usage_c, cap_c, total_c, p_mapping_version,
    acct.platform_customer_id, acct.version, p_actor, p_idempotency_key)
  RETURNING * INTO hdr;

  FOR comp IN SELECT * FROM jsonb_array_elements(p_document -> 'components') LOOP
    dlv := dlv_by_component -> (comp ->> 'component');
    IF dlv IS NULL THEN
      -- Nothing to deliver: the component must settle to zero in BOTH measures.
      IF (comp ->> 'charge_cents')::int <> 0 THEN
        RAISE EXCEPTION 'A charged component has no delivery' USING ERRCODE='22023';
      END IF;
      INSERT INTO public.commercial_settlement_lines (settlement_id, shop_id, component, included_quantity,
        recognized_quantity, billed_quantity, charge_cents, delivery_status)
      VALUES (hdr.id, p_shop, comp ->> 'component', comp ->> 'included_quantity', comp ->> 'recognized_quantity',
        comp ->> 'billed_quantity', 0, 'not_required');
    ELSE
      basis := dlv ->> 'value_basis';
      ev_value := (dlv ->> 'event_value')::bigint;
      IF basis = 'charge_cents' THEN
        IF ev_value <> (comp ->> 'charge_cents')::int THEN
          RAISE EXCEPTION 'Delivery value does not equal the settled charge' USING ERRCODE='22023';
        END IF;
      ELSIF basis = 'billed_quantity' THEN
        IF (comp ->> 'billed_quantity') !~ '^[0-9]+$' OR ev_value <> (comp ->> 'billed_quantity')::bigint THEN
          RAISE EXCEPTION 'Delivery value does not equal the settled quantity' USING ERRCODE='22023';
        END IF;
      ELSE
        RAISE EXCEPTION 'Unknown delivery value basis' USING ERRCODE='22023';
      END IF;
      IF ev_value <= 0 THEN
        RAISE EXCEPTION 'A delivery must carry a positive value' USING ERRCODE='22023';
      END IF;
      INSERT INTO public.commercial_settlement_lines (settlement_id, shop_id, component, included_quantity,
        recognized_quantity, billed_quantity, charge_cents, value_basis, event_name, event_value,
        provider_identifier, event_timestamp, delivery_status)
      VALUES (hdr.id, p_shop, comp ->> 'component', comp ->> 'included_quantity', comp ->> 'recognized_quantity',
        comp ->> 'billed_quantity', (comp ->> 'charge_cents')::int, basis, dlv ->> 'event_name', ev_value,
        dlv ->> 'provider_identifier', (dlv ->> 'event_timestamp')::timestamptz, 'pending');
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(dlv_by_component) k
              WHERE NOT (k = ANY (seen))) THEN
    RAISE EXCEPTION 'Delivery for an unknown component' USING ERRCODE='22023';
  END IF;

  PERFORM public.commercial_settlement_emit(p_shop, hdr.id, NULL, 'settlement_created', p_actor,
    jsonb_build_object('total_cents', total_c, 'usage_cents', usage_c, 'seat_cents', seat_c,
      'deliveries', (SELECT count(*) FROM public.commercial_settlement_lines WHERE settlement_id = hdr.id AND delivery_status = 'pending')));

  RETURN jsonb_build_object('action', 'created', 'settlement_id', hdr.id,
    'lines', (SELECT coalesce(jsonb_agg(jsonb_build_object('line_id', l.id, 'component', l.component,
       'delivery_status', l.delivery_status) ORDER BY l.component), '[]'::jsonb)
       FROM public.commercial_settlement_lines l WHERE l.settlement_id = hdr.id));
END $$;

-- ---------------------------------------------------------------------------
-- Function ACLs. Browser roles get nothing. The owner may READ adjustment facts.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  public.commercial_subscription_periods_guard(),
  public.commercial_subscription_apply_evidence(uuid, text, text, text, text, text, text, text, text, timestamptz, boolean, uuid, timestamptz, timestamptz, timestamptz, boolean, timestamptz, boolean),
  public.commercial_subscription_period_status(uuid, timestamptz, timestamptz),
  public.commercial_execution_gate(uuid),
  public.commercial_portal_authorize(uuid, uuid, text),
  public.commercial_webhook_ingest(text, text, timestamptz, text, boolean, jsonb),
  public.commercial_adjustment_propose(uuid, uuid, text, bigint, text, uuid, text, text),
  public.commercial_adjustment_review(uuid, uuid, text, text, text),
  public.commercial_adjustment_read(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.commercial_subscription_apply_evidence(uuid, text, text, text, text, text, text, text, text, timestamptz, boolean, uuid, timestamptz, timestamptz, timestamptz, boolean, timestamptz, boolean),
  public.commercial_subscription_period_status(uuid, timestamptz, timestamptz),
  public.commercial_execution_gate(uuid),
  public.commercial_portal_authorize(uuid, uuid, text),
  public.commercial_webhook_ingest(text, text, timestamptz, text, boolean, jsonb),
  public.commercial_adjustment_propose(uuid, uuid, text, bigint, text, uuid, text, text),
  public.commercial_adjustment_review(uuid, uuid, text, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.commercial_adjustment_read(uuid) TO authenticated, service_role;

COMMIT;
