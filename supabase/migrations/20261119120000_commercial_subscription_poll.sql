BEGIN;

-- Commercial Billing PR F3 (sandbox/test mode only): polling reconciliation of subscription state for the case
-- where signed Stripe webhooks stop arriving.
--
-- Postgres stays the billing authority and Stripe stays evidence. This migration adds a bounded, claim-based way for the
-- (service-role) billing worker to COMPARE what Stripe reports for a subscription the SERVER already binds to a shop with
-- what the database holds, and to feed any material difference through the ONE subscription writer
-- (`commercial_subscription_apply_evidence`), under a new evidence source `provider_poll`.
--
-- What it adds
--  * commercial_subscription_poll_schedule      one mutable pointer row per shop: when the shop is next due, the live claim, and a
--                                               failure counter that backs the interval off. It is the rate limit AND the mutex.
--  * commercial_subscription_poll_observations  APPEND-ONLY. One row per claim, ever (UNIQUE claim token): what was observed and what
--                                               the database did about it. The replay claim and the audit trail. No payload is stored.
--  * commercial_subscription_poll_claim         hands out ONE due shop at a time (service role). The tenant, the platform customer, the
--                                               known subscription and the Checkout attempt all come from SERVER-HELD rows.
--  * commercial_subscription_poll_record        records one observation against a live claim, exactly once (replay returns the stored
--                                               result; different content is CB409), and applies it through the single writer.
--  * commercial_subscription_poll_overview      operator read (counts only; never returns a claim token).
--  * commercial_worker_leases                   gains the fixed `subscription_poll` worker row (lease = optimization, claims = safety).
--  * commercial_execution_gate                  REPLACED IN PLACE: accepts the `provider_poll` source (with a verified period) beside the
--                                               two it already trusted; nothing else changes.
--  * commercial_subscription_apply_evidence     REPLACED IN PLACE: identical except it accepts the `provider_poll` source and refuses it
--                                               unless a verified period is required. Sticky integrity blocks still clear ONLY through a
--                                               `reviewed_reconciliation` source: polling can never clear one.
--
-- What it deliberately does NOT do
--  * It never calls a provider, never mutates Stripe, never issues a refund, credit, cancellation, retry or payment, and never
--    resends or re-reads a delivery. Unknown meter/adjustment deliveries are still reconciled by their own workers.
--  * It never lets provider metadata choose the tenant: the shop, customer and Checkout attempt come from server rows; a metadata
--    `shop_id` is only a cross-check, and a disagreement blocks the CUSTOMER'S OWN shop (never the shop the metadata names).
--  * It never marks an account `active` from ambiguous or unverified evidence (no verified period, an elapsed period, an
--    incomplete or unexpected provider answer, a subscription the server did not bind).
--  * It never rewrites a settled period, a settlement line, an adjustment, an evidence row or a webhook receipt.
-- No row of any existing table is rewritten or backfilled.

DO $$
BEGIN
  IF to_regprocedure('public.commercial_subscription_apply_evidence(uuid,text,text,text,text,text,text,text,text,timestamptz,boolean,uuid,timestamptz,timestamptz,timestamptz,boolean,timestamptz,boolean)') IS NULL
     OR to_regclass('public.commercial_worker_leases') IS NULL
     OR to_regclass('public.commercial_webhook_receipts') IS NULL
     OR to_regprocedure('public.commercial_usage_append_only()') IS NULL THEN
    RAISE EXCEPTION 'PR E1 and PR F2 billing objects are required' USING ERRCODE='23514';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Widen three closed sets (no row is touched; existing rows already satisfy the wider checks)
-- ---------------------------------------------------------------------------
ALTER TABLE public.commercial_subscription_evidence DROP CONSTRAINT commercial_subscription_evidence_evidence_source_check;
ALTER TABLE public.commercial_subscription_evidence ADD CONSTRAINT commercial_subscription_evidence_evidence_source_check
  CHECK (evidence_source IN ('signed_webhook', 'reviewed_reconciliation', 'provider_poll'));

ALTER TABLE public.commercial_billing_events DROP CONSTRAINT commercial_billing_events_kind_check;
ALTER TABLE public.commercial_billing_events ADD CONSTRAINT commercial_billing_events_kind_check CHECK (kind IN (
  'account_opened', 'checkout_attempt_started', 'customer_bound', 'session_created',
  'session_observed_open', 'session_completed_unverified', 'session_expired',
  'attempt_rejected', 'provider_outcome_unknown', 'stale_attempt_marked_unknown',
  'subscription_evidence_applied', 'subscription_evidence_not_current',
  'reconciliation_required',
  'checkout_completion_observed', 'checkout_expiry_observed', 'provider_fact_recorded',
  'subscription_period_recorded', 'portal_session_requested', 'webhook_conflict',
  'adjustment_proposed', 'adjustment_reviewed', 'subscription_poll_conflict'));

ALTER TABLE public.commercial_worker_leases DROP CONSTRAINT commercial_worker_leases_worker_check;
ALTER TABLE public.commercial_worker_leases ADD CONSTRAINT commercial_worker_leases_worker_check
  CHECK (worker IN ('settlement_dispatch', 'delivery_reconcile', 'adjustment_apply', 'subscription_poll'));
INSERT INTO public.commercial_worker_leases (worker) VALUES ('subscription_poll');

-- ---------------------------------------------------------------------------
-- Poll schedule: the rate limit and the per-shop mutex (mutable pointer, one row per shop)
-- ---------------------------------------------------------------------------
CREATE TABLE public.commercial_subscription_poll_schedule (
  shop_id uuid PRIMARY KEY REFERENCES public.shops(id) ON DELETE CASCADE,
  next_due_at timestamptz NOT NULL,
  -- The live claim (all four are set together, cleared together). A claim is a write-once bearer token.
  claim_token uuid,
  claim_started_at timestamptz,
  claim_until timestamptz,
  -- The instant used to ORDER the resulting evidence against signed webhooks: claim time minus a clock-skew margin.
  claim_observed_at timestamptz,
  -- The server-held Checkout attempt (with a recorded session) used to discover a never-seen subscription. Never from Stripe.
  claim_attempt_id uuid,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  polls_total bigint NOT NULL DEFAULT 0 CHECK (polls_total >= 0),
  last_observed_at timestamptz,
  last_outcome text CHECK (last_outcome IS NULL OR last_outcome IN
    ('applied', 'not_current', 'unchanged', 'no_subscription', 'session_pending', 'ambiguous', 'unreadable', 'refused')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((claim_token IS NULL) = (claim_until IS NULL)),
  CHECK ((claim_token IS NULL) = (claim_started_at IS NULL)),
  CHECK ((claim_token IS NULL) = (claim_observed_at IS NULL)),
  CHECK (claim_attempt_id IS NULL OR claim_token IS NOT NULL),
  FOREIGN KEY (shop_id, claim_attempt_id) REFERENCES public.commercial_checkout_attempts(shop_id, id)
);
CREATE INDEX commercial_subscription_poll_schedule_due_idx ON public.commercial_subscription_poll_schedule (next_due_at);

CREATE FUNCTION public.commercial_subscription_poll_schedule_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'The poll schedule cannot be truncated' USING ERRCODE='42501';
  END IF;
  IF TG_OP = 'DELETE' THEN
    -- Only the shop-deletion cascade may remove a row.
    IF EXISTS (SELECT 1 FROM public.shops WHERE id = OLD.shop_id) THEN
      RAISE EXCEPTION 'The poll schedule cannot be deleted' USING ERRCODE='42501';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.shop_id IS DISTINCT FROM OLD.shop_id THEN
    RAISE EXCEPTION 'Poll schedule identity is immutable' USING ERRCODE='42501';
  END IF;
  IF NEW.polls_total < OLD.polls_total THEN
    RAISE EXCEPTION 'The poll counter only moves forward' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commercial_subscription_poll_schedule_guard
  BEFORE UPDATE OR DELETE ON public.commercial_subscription_poll_schedule
  FOR EACH ROW EXECUTE FUNCTION public.commercial_subscription_poll_schedule_guard();
CREATE TRIGGER commercial_subscription_poll_schedule_no_truncate
  BEFORE TRUNCATE ON public.commercial_subscription_poll_schedule
  FOR EACH STATEMENT EXECUTE FUNCTION public.commercial_subscription_poll_schedule_guard();

-- ---------------------------------------------------------------------------
-- Poll observations (append-only): the replay claim and the audit trail. No payload, URL or secret is stored.
-- ---------------------------------------------------------------------------
CREATE TABLE public.commercial_subscription_poll_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  claim_token uuid NOT NULL UNIQUE,
  requested_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  provider_customer_id text NOT NULL CHECK (provider_customer_id ~ '^cus_[A-Za-z0-9_]{4,120}$'),
  provider_subscription_id text CHECK (provider_subscription_id IS NULL OR provider_subscription_id ~ '^sub_[A-Za-z0-9_]{4,120}$'),
  provider_status text CHECK (provider_status IS NULL OR provider_status IN (
    'incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused')),
  outcome text NOT NULL CHECK (outcome IN
    ('applied', 'not_current', 'unchanged', 'no_subscription', 'session_pending', 'ambiguous', 'unreadable', 'refused')),
  reason text CHECK (reason IS NULL OR reason ~ '^[a-z][a-z0-9_]{2,63}$'),
  evidence_id uuid,
  observation_digest text NOT NULL CHECK (observation_digest ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, evidence_id) REFERENCES public.commercial_subscription_evidence(shop_id, id)
);
CREATE INDEX commercial_subscription_poll_observations_shop_idx
  ON public.commercial_subscription_poll_observations (shop_id, recorded_at);
CREATE INDEX commercial_subscription_poll_observations_recent_idx
  ON public.commercial_subscription_poll_observations (recorded_at);
CREATE TRIGGER commercial_subscription_poll_observations_append_only
  BEFORE UPDATE OR DELETE ON public.commercial_subscription_poll_observations
  FOR EACH ROW EXECUTE FUNCTION public.commercial_usage_append_only();
CREATE TRIGGER commercial_subscription_poll_observations_no_truncate
  BEFORE TRUNCATE ON public.commercial_subscription_poll_observations
  FOR EACH STATEMENT EXECUTE FUNCTION public.commercial_usage_append_only();

ALTER TABLE public.commercial_subscription_poll_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commercial_subscription_poll_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.commercial_subscription_poll_schedule, public.commercial_subscription_poll_observations
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.commercial_subscription_poll_schedule, public.commercial_subscription_poll_observations TO service_role;

-- ---------------------------------------------------------------------------
-- The single subscription writer, replaced in place. The ONLY changes against the PR E1 text:
--   * the evidence source set also accepts 'provider_poll';
--   * 'provider_poll' is refused unless the caller requires a verified period (an 'active' without one is never active).
-- Everything else (ordering, severity ties, terminal cancel, duplicate subscription, sticky integrity reasons that only a
-- 'reviewed_reconciliation' source can clear, period integrity) is byte-identical.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.commercial_subscription_apply_evidence(
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
  IF p_source NOT IN ('signed_webhook', 'reviewed_reconciliation', 'provider_poll') THEN
    RAISE EXCEPTION 'Evidence source is not reviewed' USING ERRCODE='22023';
  END IF;
  -- PR F3: polled evidence is never trusted for an 'active' without a verified period (it must say so explicitly).
  IF p_source = 'provider_poll' AND p_require_period IS NOT TRUE THEN
    RAISE EXCEPTION 'Polled evidence must require a verified period' USING ERRCODE='22023';
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
        IF v_derived IN ('active', 'past_due', 'incomplete', 'reconciliation_required') THEN
          -- A second live (or integrity-flagged) subscription for the same workspace: possible
          -- duplicate charge. This blocks regardless of arrival order: it is a different
          -- subscription, so it is not 'older evidence' about the current one.
          v_derived := 'reconciliation_required'; v_reason := 'duplicate_subscription';
        ELSE
          v_advance := false; v_nc := 'other_subscription';
        END IF;
      END IF;
    ELSIF prior.derived_state = 'canceled' AND v_derived <> 'canceled' THEN
      v_advance := false; v_nc := 'subscription_terminal';
    END IF;
    IF v_advance AND v_reason IS DISTINCT FROM 'duplicate_subscription'
       AND p_event_created_at < prior.source_event_created_at THEN
      v_advance := false; v_nc := 'out_of_order';
    END IF;
    IF v_advance AND v_reason IS DISTINCT FROM 'duplicate_subscription'
       AND p_event_created_at = prior.source_event_created_at AND prior.derived_state <> v_derived THEN
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
-- The lapse gate, replaced in place. The ONLY changes against the PR E1 text: reviewed evidence sources also include
-- 'provider_poll', and polled evidence opens the gate only with a verified period. Every other rule (state, catalog, plan,
-- price key, test mode, elapsed period, legacy accounts) is byte-identical, and a poll can never turn a blocked state active
-- on its own: it still has to pass the single evidence writer.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.commercial_execution_gate(p_shop uuid) RETURNS jsonb
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
     OR ev.evidence_source NOT IN ('signed_webhook', 'reviewed_reconciliation', 'provider_poll')
     -- PR F3: polled evidence only ever opens the gate with a VERIFIED period (the writer already requires one).
     OR (ev.evidence_source = 'provider_poll' AND (ev.period_start IS NULL OR ev.period_end IS NULL))
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
-- Claim: hand out ONE due shop. Service role only.
--
-- Eligible = a test-mode account with a bound platform customer in a state the poll may legitimately move
-- (checkout_pending, active, past_due, incomplete, unknown) AND something server-held to compare against (a recorded subscription
-- evidence row, or a Checkout attempt with a recorded session). `canceled` is terminal and `reconciliation_required` is a sticky
-- integrity block that only a human review clears, so neither is polled.
--
-- Rate limit: a shop is due only when `next_due_at` has passed and no live claim exists. The account row is the mutex
-- (FOR UPDATE SKIP LOCKED, so a shop that is mid-write is simply skipped), and the schedule row is re-read UNDER that lock
-- with a fresh statement, so two concurrent claimers can never both claim one shop.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.commercial_subscription_poll_claim(p_shop uuid DEFAULT NULL, p_ttl_seconds integer DEFAULT 120) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  cand record;
  acct public.commercial_billing_accounts;
  sched public.commercial_subscription_poll_schedule;
  att public.commercial_checkout_attempts;
  v_now timestamptz := clock_timestamp();
  v_ttl integer := greatest(30, least(coalesce(p_ttl_seconds, 120), 300));
  v_token uuid;
  v_known text;
  v_observed timestamptz;
  v_failures integer;
BEGIN
  PERFORM public.commercial_billing_require_service();
  FOR cand IN
    SELECT a.shop_id
      FROM public.commercial_billing_accounts a
      LEFT JOIN public.commercial_subscription_poll_schedule s ON s.shop_id = a.shop_id
     WHERE a.provider_mode = 'test'
       AND a.platform_customer_id IS NOT NULL
       AND a.state IN ('checkout_pending', 'active', 'past_due', 'incomplete', 'unknown')
       AND (p_shop IS NULL OR a.shop_id = p_shop)
       AND (s.shop_id IS NULL OR (s.next_due_at <= v_now AND (s.claim_until IS NULL OR s.claim_until <= v_now)))
       AND (a.current_evidence_id IS NOT NULL OR EXISTS (
              SELECT 1 FROM public.commercial_checkout_attempts t
               WHERE t.shop_id = a.shop_id AND t.provider_session_id IS NOT NULL
                 AND t.status IN ('session_open', 'completed_unverified')))
     ORDER BY coalesce(s.next_due_at, '-infinity'::timestamptz), a.shop_id
     LIMIT 5
  LOOP
    SELECT * INTO acct FROM public.commercial_billing_accounts WHERE shop_id = cand.shop_id FOR UPDATE SKIP LOCKED;
    CONTINUE WHEN NOT FOUND;
    -- Fresh read under the mutex: another claimer may have committed between the candidate scan and this lock.
    SELECT * INTO sched FROM public.commercial_subscription_poll_schedule WHERE shop_id = cand.shop_id FOR UPDATE;
    IF FOUND AND (sched.next_due_at > v_now OR (sched.claim_until IS NOT NULL AND sched.claim_until > v_now)) THEN
      CONTINUE;
    END IF;
    IF acct.platform_customer_id IS NULL OR acct.provider_mode <> 'test'
       OR acct.state NOT IN ('checkout_pending', 'active', 'past_due', 'incomplete', 'unknown') THEN
      CONTINUE;
    END IF;

    v_known := NULL;
    IF acct.current_evidence_id IS NOT NULL THEN
      SELECT e.provider_subscription_id INTO v_known FROM public.commercial_subscription_evidence e
       WHERE e.shop_id = acct.shop_id AND e.id = acct.current_evidence_id;
    END IF;
    att := NULL;
    IF v_known IS NULL THEN
      SELECT * INTO att FROM public.commercial_checkout_attempts t
       WHERE t.shop_id = acct.shop_id AND t.provider_session_id IS NOT NULL
         AND t.status IN ('session_open', 'completed_unverified')
       ORDER BY t.attempt_no DESC LIMIT 1;
      -- Nothing server-held to compare against: not claimable.
      IF NOT FOUND THEN CONTINUE; END IF;
    END IF;

    v_token := gen_random_uuid();
    -- Clock-skew margin: the evidence is ordered at claim time minus the webhook signature tolerance (5 minutes), so a signed
    -- webhook created in that window always wins over a poll. The poll never overrides fresher signed evidence.
    v_observed := v_now - interval '5 minutes';
    -- A previous claim that expired without a record counts as a failed poll (backs the interval off).
    v_failures := 0;
    IF sched.shop_id IS NOT NULL THEN
      v_failures := sched.consecutive_failures + CASE WHEN sched.claim_token IS NOT NULL THEN 1 ELSE 0 END;
    END IF;
    INSERT INTO public.commercial_subscription_poll_schedule AS s
      (shop_id, next_due_at, claim_token, claim_started_at, claim_until, claim_observed_at, claim_attempt_id, consecutive_failures)
    VALUES (acct.shop_id, v_now, v_token, v_now, v_now + make_interval(secs => v_ttl), v_observed, att.id, v_failures)
    ON CONFLICT (shop_id) DO UPDATE
      SET claim_token = EXCLUDED.claim_token, claim_started_at = EXCLUDED.claim_started_at, claim_until = EXCLUDED.claim_until,
          claim_observed_at = EXCLUDED.claim_observed_at, claim_attempt_id = EXCLUDED.claim_attempt_id,
          consecutive_failures = EXCLUDED.consecutive_failures, updated_at = v_now;

    RETURN jsonb_build_object(
      'claimed', true, 'claim_token', v_token, 'shop_id', acct.shop_id, 'customer_id', acct.platform_customer_id,
      'state', acct.state, 'known_subscription_id', v_known,
      'attempt_id', att.id, 'session_id', att.provider_session_id,
      'requested_at', v_now, 'observed_at', v_observed, 'ttl_seconds', v_ttl);
  END LOOP;
  RETURN jsonb_build_object('claimed', false, 'reason', 'nothing_due');
END $$;

-- ---------------------------------------------------------------------------
-- Record: one observation against a live claim, exactly once. Service role only.
--
-- p_observation (all closed, all validated; nothing is a payload):
--   kind                       'subscription' | 'none' | 'unreadable'
--   digest                     sha256 hex of the canonical observation (the replay fingerprint)
--   customer_id                the customer the reader asked about (must equal the server-held binding)
--   class / code               for kind 'none': 'no_subscription' | 'session_pending' | 'ambiguous' and a finite reason code
--   session_subscription_id    the subscription the server-held Checkout session reported (never-seen subscriptions only)
--   facts                      the normalized subscription facts (same normalizer as the signed webhook)
--
-- A replay of the same claim returns the stored result; the same claim with different content is CB409; a claim that is not
-- the live one (superseded, expired, wrong shop) is CB409 and changes nothing.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.commercial_subscription_poll_record(p_shop uuid, p_claim_token uuid, p_observation jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  acct public.commercial_billing_accounts;
  sched public.commercial_subscription_poll_schedule;
  obs public.commercial_subscription_poll_observations;
  prior public.commercial_subscription_evidence;
  cur public.commercial_subscription_evidence;
  v_now timestamptz := clock_timestamp();
  v_kind text;
  v_digest text;
  v_customer text;
  v_facts jsonb;
  v_sub text;
  v_status text;
  v_outcome text;
  v_reason text;
  v_evidence uuid;
  v_applied jsonb;
  v_attempt uuid;
  v_known boolean;
  v_period_end timestamptz;
  v_failures integer;
  v_wait interval;
BEGIN
  PERFORM public.commercial_billing_require_service();
  IF p_shop IS NULL OR p_claim_token IS NULL OR p_observation IS NULL OR jsonb_typeof(p_observation) <> 'object' THEN
    RAISE EXCEPTION 'Invalid poll observation' USING ERRCODE='22023';
  END IF;
  v_kind := p_observation ->> 'kind';
  v_digest := p_observation ->> 'digest';
  v_customer := p_observation ->> 'customer_id';
  IF v_kind IS NULL OR v_kind NOT IN ('subscription', 'none', 'unreadable')
     OR coalesce(v_digest, '') !~ '^[0-9a-f]{64}$'
     OR coalesce(v_customer, '') !~ '^cus_[A-Za-z0-9_]{4,120}$' THEN
    RAISE EXCEPTION 'Invalid poll observation' USING ERRCODE='22023';
  END IF;

  -- The account row is the mutex (same order as the claim: account, then schedule).
  SELECT * INTO acct FROM public.commercial_billing_accounts WHERE shop_id = p_shop FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No billing account for this shop' USING ERRCODE='22023';
  END IF;

  -- Replay: one observation per claim, ever.
  SELECT * INTO obs FROM public.commercial_subscription_poll_observations WHERE claim_token = p_claim_token;
  IF FOUND THEN
    IF obs.shop_id <> p_shop OR obs.observation_digest <> v_digest THEN
      RAISE EXCEPTION 'Poll claim was replayed with different content' USING ERRCODE='CB409';
    END IF;
    RETURN jsonb_build_object('outcome', obs.outcome, 'reason', obs.reason, 'evidence_id', obs.evidence_id, 'replayed', true);
  END IF;

  SELECT * INTO sched FROM public.commercial_subscription_poll_schedule WHERE shop_id = p_shop FOR UPDATE;
  IF NOT FOUND OR sched.claim_token IS DISTINCT FROM p_claim_token OR sched.claim_until <= v_now THEN
    RAISE EXCEPTION 'Poll claim is not held' USING ERRCODE='CB409';
  END IF;

  v_outcome := NULL; v_reason := NULL; v_evidence := NULL; v_sub := NULL; v_status := NULL;

  IF v_customer IS DISTINCT FROM acct.platform_customer_id THEN
    -- The reader answered about some other customer: refuse, change nothing.
    v_outcome := 'refused'; v_reason := 'customer_mismatch';

  ELSIF v_kind = 'unreadable' THEN
    v_outcome := 'unreadable'; v_reason := coalesce(nullif(p_observation ->> 'code', ''), 'provider_unreadable');

  ELSIF v_kind = 'none' THEN
    v_outcome := p_observation ->> 'class';
    IF v_outcome IS NULL OR v_outcome NOT IN ('no_subscription', 'session_pending', 'ambiguous') THEN
      RAISE EXCEPTION 'Invalid poll observation class' USING ERRCODE='22023';
    END IF;
    v_reason := p_observation ->> 'code';

  ELSE
    v_facts := p_observation -> 'facts';
    IF v_facts IS NULL OR jsonb_typeof(v_facts) <> 'object' OR v_facts ->> 'object' <> 'subscription' THEN
      RAISE EXCEPTION 'Invalid poll subscription facts' USING ERRCODE='22023';
    END IF;
    v_sub := v_facts ->> 'subscription_id';
    v_status := v_facts ->> 'status';
    IF coalesce(v_sub, '') !~ '^sub_[A-Za-z0-9_]{4,120}$'
       OR v_status IS NULL OR v_status NOT IN ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused')
       OR v_facts ->> 'customer_id' IS DISTINCT FROM v_customer THEN
      RAISE EXCEPTION 'Invalid poll subscription facts' USING ERRCODE='22023';
    END IF;

    IF v_facts ->> 'metadata_shop_id' IS NOT NULL AND v_facts ->> 'metadata_shop_id' <> p_shop::text THEN
      -- Metadata NEVER chooses the tenant. A disagreement is an integrity conflict that blocks the customer's OWN shop
      -- (the one the server-held binding names) and never touches the shop the metadata named.
      PERFORM public.commercial_billing_advance(p_shop, 'reconciliation_required', 'tenant_conflict', NULL);
      PERFORM public.commercial_billing_emit(p_shop, 'subscription_poll_conflict', NULL, NULL, 'reconciliation_required',
        jsonb_build_object('reason', 'tenant_conflict'));
      v_outcome := 'refused'; v_reason := 'tenant_conflict';
    ELSE
      SELECT * INTO prior FROM public.commercial_subscription_evidence
       WHERE shop_id = p_shop AND provider_subscription_id = v_sub
       ORDER BY source_event_created_at DESC, recorded_at DESC LIMIT 1;
      v_known := FOUND;
      v_attempt := NULL;
      IF NOT v_known THEN
        -- A subscription this shop has never recorded is acceptable ONLY if the server-held, session-bound Checkout attempt
        -- chosen at claim time is still open/completed and the (server-fetched) session reported exactly this subscription.
        IF sched.claim_attempt_id IS NULL OR p_observation ->> 'session_subscription_id' IS DISTINCT FROM v_sub
           OR NOT EXISTS (SELECT 1 FROM public.commercial_checkout_attempts t
                           WHERE t.shop_id = p_shop AND t.id = sched.claim_attempt_id AND t.provider_session_id IS NOT NULL
                             AND t.status IN ('session_open', 'completed_unverified')) THEN
          v_outcome := 'ambiguous'; v_reason := 'subscription_unbound';
        ELSE
          v_attempt := sched.claim_attempt_id;
        END IF;
      END IF;

      IF v_outcome IS NULL AND v_status = 'active' THEN
        -- Never active from an unverified or already-elapsed period.
        IF v_facts ->> 'period_start' IS NULL OR v_facts ->> 'period_end' IS NULL OR v_facts ->> 'started_at' IS NULL THEN
          v_outcome := 'ambiguous'; v_reason := 'period_not_verified';
        ELSIF (v_facts ->> 'period_end')::timestamptz <= v_now THEN
          v_outcome := 'ambiguous'; v_reason := 'period_elapsed';
        END IF;
      END IF;

      IF v_outcome IS NULL AND v_known AND acct.current_evidence_id = prior.id
         AND prior.provider_status = v_status
         AND prior.period_start IS NOT DISTINCT FROM (v_facts ->> 'period_start')::timestamptz
         AND prior.period_end IS NOT DISTINCT FROM (v_facts ->> 'period_end')::timestamptz
         AND prior.cancel_at_period_end IS NOT DISTINCT FROM (v_facts ->> 'cancel_at_period_end')::boolean
         AND prior.canceled_at IS NOT DISTINCT FROM (v_facts ->> 'canceled_at')::timestamptz
         AND prior.price_lookup_key = coalesce(v_facts ->> 'price_lookup_key', '')
         AND prior.derived_state <> 'reconciliation_required' THEN
        -- Provider and database agree. Nothing to write but the observation.
        v_outcome := 'unchanged'; v_evidence := prior.id;
      END IF;

      IF v_outcome IS NULL THEN
        v_applied := public.commercial_subscription_apply_evidence(
          p_shop, v_sub, acct.platform_customer_id, v_status,
          coalesce(v_facts ->> 'catalog_version', ''), coalesce(v_facts ->> 'plan_key', ''),
          coalesce(v_facts ->> 'price_lookup_key', ''),
          'provider_poll', 'poll_' || replace(p_claim_token::text, '-', ''), sched.claim_observed_at, false, v_attempt,
          (v_facts ->> 'period_start')::timestamptz, (v_facts ->> 'period_end')::timestamptz,
          (v_facts ->> 'started_at')::timestamptz,
          (v_facts ->> 'cancel_at_period_end')::boolean, (v_facts ->> 'canceled_at')::timestamptz, true);
        v_evidence := (v_applied ->> 'id')::uuid;
        v_outcome := CASE WHEN (v_applied ->> 'advanced')::boolean THEN 'applied' ELSE 'not_current' END;
        v_reason := v_applied ->> 'reason';
      END IF;
    END IF;
  END IF;

  INSERT INTO public.commercial_subscription_poll_observations (
    shop_id, claim_token, requested_at, observed_at, provider_customer_id, provider_subscription_id, provider_status,
    outcome, reason, evidence_id, observation_digest)
  VALUES (p_shop, p_claim_token, sched.claim_started_at, sched.claim_observed_at, v_customer, v_sub, v_status,
    v_outcome, v_reason, v_evidence, v_digest);

  -- Rate limit: the next due time depends on how this poll went and on the account's (possibly new) state.
  --   healthy (no failure streak):  active with more than 2 h left in the verified period -> 6 h, anything else -> 15 min
  --   failure streak (ambiguous / unreadable / refused): 15 min doubling each time, capped at 6 h
  SELECT * INTO acct FROM public.commercial_billing_accounts WHERE shop_id = p_shop;
  v_failures := CASE WHEN v_outcome IN ('ambiguous', 'unreadable', 'refused') THEN sched.consecutive_failures + 1 ELSE 0 END;
  v_period_end := NULL;
  IF acct.current_evidence_id IS NOT NULL THEN
    SELECT * INTO cur FROM public.commercial_subscription_evidence WHERE shop_id = p_shop AND id = acct.current_evidence_id;
    v_period_end := cur.period_end;
  END IF;
  IF v_failures > 0 THEN
    v_wait := least(interval '6 hours', interval '15 minutes' * (2 ^ least(v_failures - 1, 5))::integer);
  ELSIF acct.state = 'active' AND v_period_end IS NOT NULL AND v_period_end > v_now + interval '2 hours' THEN
    v_wait := interval '6 hours';
  ELSE
    v_wait := interval '15 minutes';
  END IF;
  UPDATE public.commercial_subscription_poll_schedule
     SET claim_token = NULL, claim_started_at = NULL, claim_until = NULL, claim_observed_at = NULL, claim_attempt_id = NULL,
         next_due_at = v_now + v_wait, consecutive_failures = v_failures, polls_total = polls_total + 1,
         last_observed_at = v_now, last_outcome = v_outcome, updated_at = v_now
   WHERE shop_id = p_shop;

  RETURN jsonb_build_object('outcome', v_outcome, 'reason', v_reason, 'evidence_id', v_evidence, 'replayed', false,
    'state', acct.state, 'next_due_in_seconds', ceil(extract(epoch FROM v_wait))::integer);
END $$;

-- ---------------------------------------------------------------------------
-- Operator read: counts only. Never returns a claim token, a customer, a subscription or a shop id.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.commercial_subscription_poll_overview() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
BEGIN
  PERFORM public.commercial_billing_require_service();
  RETURN (
    WITH eligible AS (
      SELECT a.shop_id, s.next_due_at, s.claim_until, s.last_observed_at, s.consecutive_failures
        FROM public.commercial_billing_accounts a
        LEFT JOIN public.commercial_subscription_poll_schedule s ON s.shop_id = a.shop_id
       WHERE a.provider_mode = 'test' AND a.platform_customer_id IS NOT NULL
         AND a.state IN ('checkout_pending', 'active', 'past_due', 'incomplete', 'unknown')
         AND (a.current_evidence_id IS NOT NULL OR EXISTS (
                SELECT 1 FROM public.commercial_checkout_attempts t
                 WHERE t.shop_id = a.shop_id AND t.provider_session_id IS NOT NULL
                   AND t.status IN ('session_open', 'completed_unverified')))
    ), recent AS (
      SELECT outcome, count(*) AS n FROM public.commercial_subscription_poll_observations
       WHERE recorded_at > v_now - interval '24 hours' GROUP BY outcome
    )
    SELECT jsonb_build_object(
      'eligible', (SELECT count(*) FROM eligible),
      'due', (SELECT count(*) FROM eligible e WHERE e.next_due_at IS NULL OR (e.next_due_at <= v_now AND (e.claim_until IS NULL OR e.claim_until <= v_now))),
      'claimed', (SELECT count(*) FROM eligible e WHERE e.claim_until IS NOT NULL AND e.claim_until > v_now),
      'never_polled', (SELECT count(*) FROM eligible e WHERE e.last_observed_at IS NULL),
      'failing', (SELECT count(*) FROM eligible e WHERE e.consecutive_failures > 0),
      'overdue', (SELECT count(*) FROM eligible e WHERE e.next_due_at IS NOT NULL AND e.next_due_at < v_now - interval '1 hour'
                    AND (e.claim_until IS NULL OR e.claim_until <= v_now)),
      'oldest_last_observed_at', (SELECT min(e.last_observed_at) FROM eligible e),
      'outcomes_24h', coalesce((SELECT jsonb_object_agg(outcome, n) FROM recent), '{}'::jsonb))
  );
END $$;

REVOKE ALL ON FUNCTION
  public.commercial_subscription_poll_schedule_guard(),
  public.commercial_subscription_poll_claim(uuid, integer),
  public.commercial_subscription_poll_record(uuid, uuid, jsonb),
  public.commercial_subscription_poll_overview()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.commercial_subscription_poll_claim(uuid, integer),
  public.commercial_subscription_poll_record(uuid, uuid, jsonb),
  public.commercial_subscription_poll_overview()
  TO service_role;

COMMIT;
