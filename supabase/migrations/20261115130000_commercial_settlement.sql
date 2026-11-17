BEGIN;

-- Commercial settlement (Commercial Billing PR D, sandbox/test mode only).
--
-- Deterministic settlement of ONE closed commercial period from the existing
-- append-only evidence (PR A usage recognitions, PR B membership history) and an
-- outbox of provider deliveries. This migration only ADDS objects: no shops,
-- memberships, usage, recognition, membership, billing account, attempt or
-- subscription-evidence row is read for rewriting, altered or backfilled.
--
--  * commercial_settlements          immutable header: tenant, exact half-open UTC
--                                    window, fixed evidence instant (as_of), evidence
--                                    digest, document digest and the settled totals.
--  * commercial_settlement_lines     one row per reviewed component. Settled amounts and
--                                    the delivery identity are immutable; only a
--                                    forward-only delivery status may advance.
--  * commercial_settlement_events    append-only evidence of every delivery transition.
--
-- Gradia's database is the billing authority. Settlement never marks an invoice
-- paid and never touches subscription or checkout state: it records what the
-- ledger settled and what was handed to the provider. A provider outcome that
-- cannot be proven is `unknown` and is never retried automatically.
--
-- Authority: every writer is service-role only. The settlement request names an
-- actor whom the database re-verifies as a LIVE, ACTIVE OWNER of that exact shop;
-- delivery claim/record are system operations bound to (shop, settlement, line).
-- Browser roles have no table or writer access; owners read through an
-- authority-checked function.

-- The approved catalog this binds to must already be registered by PR A.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.commercial_catalog_versions WHERE version = '2026-11-03.v1') THEN
    RAISE EXCEPTION 'Approved catalog 2026-11-03.v1 is not registered' USING ERRCODE='23514';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Immutable settlement header
-- ---------------------------------------------------------------------------
CREATE TABLE public.commercial_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  catalog_version text NOT NULL REFERENCES public.commercial_catalog_versions(version),
  plan_key text NOT NULL CHECK (plan_key = 'founder-pilot'),
  provider_mode text NOT NULL DEFAULT 'test' CHECK (provider_mode = 'test'),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  -- The fixed evidence instant. Only facts recorded at or before it were settled.
  as_of timestamptz NOT NULL,
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  document_digest text NOT NULL CHECK (document_digest ~ '^[0-9a-f]{64}$'),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object' AND length(document::text) <= 20000),
  base_cents integer NOT NULL CHECK (base_cents >= 0),
  seat_cents integer NOT NULL CHECK (seat_cents >= 0),
  usage_cents integer NOT NULL CHECK (usage_cents >= 0),
  usage_cap_cents integer NOT NULL CHECK (usage_cap_cents BETWEEN 0 AND 50000),
  total_cents integer NOT NULL CHECK (total_cents = base_cents + seat_cents + usage_cents),
  CHECK (usage_cents <= usage_cap_cents),
  mapping_version text NOT NULL CHECK (mapping_version ~ '^[A-Za-z0-9_.:-]{3,80}$'),
  stripe_customer_id text NOT NULL CHECK (stripe_customer_id ~ '^cus_[A-Za-z0-9_]{4,120}$'),
  account_version bigint NOT NULL CHECK (account_version > 0),
  requested_by uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_.:-]{16,200}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (window_end > window_start AND as_of >= window_end),
  -- One settlement per exact window and per identity: an exact replay finds it,
  -- a changed replay conflicts.
  UNIQUE (shop_id, window_start, window_end),
  UNIQUE (shop_id, idempotency_key),
  UNIQUE (shop_id, id)
);

-- ---------------------------------------------------------------------------
-- Lines: immutable settled amounts + the delivery outbox (forward-only status)
-- ---------------------------------------------------------------------------
CREATE TABLE public.commercial_settlement_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id uuid NOT NULL,
  shop_id uuid NOT NULL,
  component text NOT NULL CHECK (component IN (
    'standard_digital_outcome', 'qualified_lead', 'confirmed_appointment',
    'inbound_voice_agent_minute', 'sms_segment', 'extra_operator_seat_proration')),
  included_quantity text,
  recognized_quantity text,
  billed_quantity text NOT NULL CHECK (billed_quantity ~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$'),
  charge_cents integer NOT NULL CHECK (charge_cents >= 0),
  -- Delivery identity (immutable). NULL only when nothing is to be delivered.
  value_basis text CHECK (value_basis IN ('billed_quantity', 'charge_cents')),
  event_name text CHECK (event_name ~ '^[a-z][a-z0-9_]{2,99}$'),
  event_value bigint CHECK (event_value > 0),
  provider_identifier text CHECK (provider_identifier ~ '^[A-Za-z0-9_.:-]{16,100}$'),
  event_timestamp timestamptz,
  delivery_status text NOT NULL CHECK (delivery_status IN (
    'not_required', 'pending', 'in_flight', 'delivered', 'rejected', 'unknown')),
  claim_token uuid,
  claimed_at timestamptz,
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z][a-z0-9_]{2,63}$'),
  status_changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (settlement_id, component),
  UNIQUE (shop_id, settlement_id, id),
  FOREIGN KEY (shop_id, settlement_id) REFERENCES public.commercial_settlements(shop_id, id) ON DELETE CASCADE,
  CHECK ((delivery_status = 'not_required') = (event_value IS NULL)),
  CHECK ((delivery_status = 'not_required') = (provider_identifier IS NULL)),
  CHECK (event_value IS NULL OR (value_basis IS NOT NULL AND event_name IS NOT NULL AND event_timestamp IS NOT NULL)),
  CHECK ((delivery_status IN ('not_required', 'pending')) = (claim_token IS NULL)),
  CHECK ((delivery_status IN ('rejected', 'unknown')) = (failure_code IS NOT NULL))
);
-- A provider identifier is a deterministic function of the line, and never shared.
CREATE UNIQUE INDEX commercial_settlement_lines_identifier_uniq
  ON public.commercial_settlement_lines (provider_identifier) WHERE provider_identifier IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Append-only evidence of delivery transitions
-- ---------------------------------------------------------------------------
CREATE TABLE public.commercial_settlement_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  shop_seq bigint NOT NULL CHECK (shop_seq > 0),
  settlement_id uuid NOT NULL,
  line_id uuid,
  kind text NOT NULL CHECK (kind IN (
    'settlement_created', 'delivery_claimed', 'delivery_delivered', 'delivery_rejected',
    'delivery_unknown', 'delivery_stale_marked_unknown')),
  actor_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(details) = 'object' AND length(details::text) <= 2000
           AND details::text !~* '(https?:|sk_(live|test)|rk_(live|test)|whsec_|client_secret)'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (shop_id, shop_seq),
  FOREIGN KEY (shop_id, settlement_id) REFERENCES public.commercial_settlements(shop_id, id) ON DELETE CASCADE
);
CREATE INDEX commercial_settlement_events_settlement_idx
  ON public.commercial_settlement_events (shop_id, settlement_id, shop_seq);

-- ---------------------------------------------------------------------------
-- Immutability guards
-- ---------------------------------------------------------------------------
CREATE TRIGGER commercial_settlements_append_only
  BEFORE UPDATE OR DELETE ON public.commercial_settlements
  FOR EACH ROW EXECUTE FUNCTION public.commercial_usage_append_only();
CREATE TRIGGER commercial_settlement_events_append_only
  BEFORE UPDATE OR DELETE ON public.commercial_settlement_events
  FOR EACH ROW EXECUTE FUNCTION public.commercial_usage_append_only();
CREATE TRIGGER commercial_settlements_no_truncate
  BEFORE TRUNCATE ON public.commercial_settlements
  FOR EACH STATEMENT EXECUTE FUNCTION public.commercial_usage_append_only();
CREATE TRIGGER commercial_settlement_lines_no_truncate
  BEFORE TRUNCATE ON public.commercial_settlement_lines
  FOR EACH STATEMENT EXECUTE FUNCTION public.commercial_usage_append_only();
CREATE TRIGGER commercial_settlement_events_no_truncate
  BEFORE TRUNCATE ON public.commercial_settlement_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.commercial_usage_append_only();

-- Lines: amounts and identity are immutable, the status moves forward only, the
-- claim token is write-once. Rows are never deleted (only the shop cascade).
CREATE FUNCTION public.commercial_settlement_lines_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.shops WHERE id = OLD.shop_id) THEN
      RAISE EXCEPTION 'Settlement lines cannot be deleted' USING ERRCODE='42501';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.id, NEW.settlement_id, NEW.shop_id, NEW.component, NEW.included_quantity, NEW.recognized_quantity,
      NEW.billed_quantity, NEW.charge_cents, NEW.value_basis, NEW.event_name, NEW.event_value,
      NEW.provider_identifier, NEW.event_timestamp)
     IS DISTINCT FROM
     (OLD.id, OLD.settlement_id, OLD.shop_id, OLD.component, OLD.included_quantity, OLD.recognized_quantity,
      OLD.billed_quantity, OLD.charge_cents, OLD.value_basis, OLD.event_name, OLD.event_value,
      OLD.provider_identifier, OLD.event_timestamp) THEN
    RAISE EXCEPTION 'Settlement line is immutable' USING ERRCODE='42501';
  END IF;
  IF OLD.claim_token IS NOT NULL AND NEW.claim_token IS DISTINCT FROM OLD.claim_token THEN
    RAISE EXCEPTION 'Claim token is write-once' USING ERRCODE='42501';
  END IF;
  IF NEW.delivery_status IS DISTINCT FROM OLD.delivery_status AND NOT (
       (OLD.delivery_status = 'pending' AND NEW.delivery_status = 'in_flight')
    OR (OLD.delivery_status = 'in_flight' AND NEW.delivery_status IN ('delivered', 'rejected', 'unknown'))) THEN
    RAISE EXCEPTION 'Delivery status only moves forward' USING ERRCODE='42501';
  END IF;
  IF NEW.delivery_status = OLD.delivery_status AND
     (NEW.claim_token, NEW.claimed_at, NEW.failure_code) IS DISTINCT FROM (OLD.claim_token, OLD.claimed_at, OLD.failure_code) THEN
    RAISE EXCEPTION 'Delivery evidence is immutable within a status' USING ERRCODE='42501';
  END IF;
  NEW.status_changed_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER commercial_settlement_lines_guard
  BEFORE UPDATE OR DELETE ON public.commercial_settlement_lines
  FOR EACH ROW EXECUTE FUNCTION public.commercial_settlement_lines_guard();

-- ---------------------------------------------------------------------------
-- Table privileges: RLS on, no browser role access, service role reads only.
-- ---------------------------------------------------------------------------
ALTER TABLE public.commercial_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commercial_settlement_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commercial_settlement_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.commercial_settlements, public.commercial_settlement_lines,
  public.commercial_settlement_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.commercial_settlements, public.commercial_settlement_lines,
  public.commercial_settlement_events TO service_role;

-- ---------------------------------------------------------------------------
-- Evidence digest: one canonical value over exactly the immutable evidence that a
-- settlement consumes (usage facts, corrections, prior workflow metrics, membership
-- coverage and events) at a fixed instant. as_of itself is excluded, so a replay at a
-- later instant over unchanged evidence has the same digest and late evidence does not.
-- Both underlying readers re-check authority themselves.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.commercial_settlement_evidence_digest(
  p_usage jsonb, p_membership jsonb
) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT encode(sha256(convert_to(jsonb_build_object(
    'facts', p_usage -> 'facts',
    'corrections', p_usage -> 'corrections',
    'prior_workflow_metrics', p_usage -> 'prior_workflow_metrics',
    'coverage', p_membership -> 'coverage',
    'events', p_membership -> 'events')::text, 'UTF8')), 'hex');
$$;

-- Read the evidence and every eligibility fact for one explicit window at a fixed
-- instant. Live owner or service role only. Returns facts only; the settlement
-- arithmetic is performed by the reviewed preview code that the document is built from.
CREATE FUNCTION public.commercial_settlement_evidence(
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

-- ---------------------------------------------------------------------------
-- Append one event. Serialized per shop so the sequence is gapless.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.commercial_settlement_emit(
  p_shop uuid, p_settlement uuid, p_line uuid, p_kind text, p_actor uuid, p_details jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('commercial_settlement_events:' || p_shop::text, 0));
  INSERT INTO public.commercial_settlement_events (shop_id, shop_seq, settlement_id, line_id, kind, actor_id, details)
  VALUES (p_shop,
    (SELECT coalesce(max(shop_seq), 0) + 1 FROM public.commercial_settlement_events WHERE shop_id = p_shop),
    p_settlement, p_line, p_kind, p_actor, coalesce(p_details, '{}'::jsonb));
END $$;

-- ---------------------------------------------------------------------------
-- Begin (or replay) the settlement of one closed window.
-- Service role + live owner actor only. Failure codes:
--   42501 authority · 22023 invalid input · CB422 not settleable (reason in message)
--   CB409 conflict (changed replay, evidence changed, overlapping window)
-- Returns {action: created | replay, settlement_id, lines: [...]}
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.commercial_settlement_begin(
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

  -- Exact, closed, day-aligned, month-length window. Never an open or partial period.
  IF (p_window_start AT TIME ZONE 'UTC')::time <> time '00:00' OR (p_window_end AT TIME ZONE 'UTC')::time <> time '00:00' THEN
    RAISE EXCEPTION 'Window is not UTC-day aligned' USING ERRCODE='CB422';
  END IF;
  IF p_window_end - p_window_start NOT BETWEEN interval '28 days' AND interval '31 days' THEN
    RAISE EXCEPTION 'Window is not a billing month' USING ERRCODE='CB422';
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
-- Claim one pending delivery. Service role only; bound to (shop, settlement, line).
-- Returns {action, ...}: claimed (with the provider payload) | in_progress | delivered |
--   blocked (rejected/unknown: never retried automatically) | not_required.
-- A claim that has been in flight for more than 120 s without an outcome is marked
-- unknown — it MAY have reached the provider — and is never retried.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.commercial_settlement_delivery_claim(
  p_shop uuid, p_settlement uuid, p_line uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  l public.commercial_settlement_lines;
  s public.commercial_settlements;
  token uuid := gen_random_uuid();
BEGIN
  PERFORM public.commercial_billing_require_service();
  SELECT * INTO s FROM public.commercial_settlements WHERE shop_id = p_shop AND id = p_settlement;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Settlement not found' USING ERRCODE='CB409';
  END IF;
  SELECT * INTO l FROM public.commercial_settlement_lines
    WHERE shop_id = p_shop AND settlement_id = p_settlement AND id = p_line FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Settlement line not found' USING ERRCODE='CB409';
  END IF;
  IF l.delivery_status = 'not_required' THEN
    RETURN jsonb_build_object('action', 'not_required');
  ELSIF l.delivery_status = 'delivered' THEN
    RETURN jsonb_build_object('action', 'delivered');
  ELSIF l.delivery_status IN ('rejected', 'unknown') THEN
    RETURN jsonb_build_object('action', 'blocked', 'status', l.delivery_status, 'failure_code', l.failure_code);
  ELSIF l.delivery_status = 'in_flight' THEN
    IF l.claimed_at < clock_timestamp() - interval '120 seconds' THEN
      UPDATE public.commercial_settlement_lines
         SET delivery_status = 'unknown', failure_code = 'stale_in_flight'
       WHERE id = l.id;
      PERFORM public.commercial_settlement_emit(p_shop, p_settlement, l.id, 'delivery_stale_marked_unknown', NULL,
        jsonb_build_object('component', l.component));
      RETURN jsonb_build_object('action', 'blocked', 'status', 'unknown', 'failure_code', 'stale_in_flight');
    END IF;
    RETURN jsonb_build_object('action', 'in_progress');
  END IF;
  UPDATE public.commercial_settlement_lines
     SET delivery_status = 'in_flight', claim_token = token, claimed_at = clock_timestamp()
   WHERE id = l.id;
  PERFORM public.commercial_settlement_emit(p_shop, p_settlement, l.id, 'delivery_claimed', NULL,
    jsonb_build_object('component', l.component));
  RETURN jsonb_build_object('action', 'claimed', 'claim_token', token, 'component', l.component,
    'event_name', l.event_name, 'event_value', l.event_value::text, 'provider_identifier', l.provider_identifier,
    'event_timestamp', l.event_timestamp, 'stripe_customer_id', s.stripe_customer_id,
    'value_basis', l.value_basis);
END $$;

-- ---------------------------------------------------------------------------
-- Record the provider outcome of a claimed delivery. Service role only. The claim
-- token proves this caller holds THE claim; anything else (never claimed, wrong
-- token, already resolved) is an out-of-order attempt and conflicts.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.commercial_settlement_delivery_record(
  p_shop uuid, p_settlement uuid, p_line uuid, p_claim_token uuid, p_outcome text, p_code text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  l public.commercial_settlement_lines;
BEGIN
  PERFORM public.commercial_billing_require_service();
  IF p_outcome NOT IN ('delivered', 'rejected', 'unknown')
     OR (p_outcome = 'delivered') <> (p_code IS NULL)
     OR (p_code IS NOT NULL AND p_code !~ '^[a-z][a-z0-9_]{2,63}$') THEN
    RAISE EXCEPTION 'Invalid outcome' USING ERRCODE='22023';
  END IF;
  SELECT * INTO l FROM public.commercial_settlement_lines
    WHERE shop_id = p_shop AND settlement_id = p_settlement AND id = p_line FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Settlement line not found' USING ERRCODE='CB409';
  END IF;
  IF l.delivery_status <> 'in_flight' OR l.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION 'Delivery is not claimed by this caller' USING ERRCODE='CB409';
  END IF;
  UPDATE public.commercial_settlement_lines
     SET delivery_status = p_outcome, failure_code = p_code
   WHERE id = l.id;
  PERFORM public.commercial_settlement_emit(p_shop, p_settlement, l.id, 'delivery_' || p_outcome, NULL,
    jsonb_build_object('component', l.component) || CASE WHEN p_code IS NULL THEN '{}'::jsonb
      ELSE jsonb_build_object('code', p_code) END);
  RETURN jsonb_build_object('status', p_outcome);
END $$;

-- ---------------------------------------------------------------------------
-- Read a settlement (header, lines, delivery statuses). Live owner or service role.
-- Never exposes the provider customer id or claim tokens.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.commercial_settlement_read(
  p_shop uuid, p_window_start timestamptz, p_window_end timestamptz
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE
  s public.commercial_settlements;
BEGIN
  IF NOT (coalesce(auth.role(), '') = 'service_role' OR public.commercial_is_active_owner(p_shop)) THEN
    RAISE EXCEPTION 'Owner authority required' USING ERRCODE='42501';
  END IF;
  SELECT * INTO s FROM public.commercial_settlements
    WHERE shop_id = p_shop AND window_start = p_window_start AND window_end = p_window_end;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('shop_id', p_shop, 'settlement', NULL);
  END IF;
  RETURN jsonb_build_object('shop_id', p_shop, 'settlement', jsonb_build_object(
    'id', s.id, 'catalog_version', s.catalog_version, 'plan_key', s.plan_key,
    'window_start', s.window_start, 'window_end', s.window_end, 'as_of', s.as_of,
    'evidence_digest', s.evidence_digest, 'document_digest', s.document_digest,
    'base_cents', s.base_cents, 'seat_cents', s.seat_cents, 'usage_cents', s.usage_cents,
    'usage_cap_cents', s.usage_cap_cents, 'total_cents', s.total_cents,
    'mapping_version', s.mapping_version, 'created_at', s.created_at,
    'lines', (SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', l.id, 'component', l.component, 'billed_quantity', l.billed_quantity,
        'charge_cents', l.charge_cents, 'value_basis', l.value_basis, 'event_value', l.event_value::text,
        'delivery_status', l.delivery_status, 'failure_code', l.failure_code) ORDER BY l.component), '[]'::jsonb)
        FROM public.commercial_settlement_lines l WHERE l.settlement_id = s.id)));
END $$;

-- ---------------------------------------------------------------------------
-- Function ACLs
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  public.commercial_settlement_lines_guard(),
  public.commercial_settlement_evidence_digest(jsonb, jsonb),
  public.commercial_settlement_evidence(uuid, timestamptz, timestamptz, timestamptz),
  public.commercial_settlement_emit(uuid, uuid, uuid, text, uuid, jsonb),
  public.commercial_settlement_begin(uuid, uuid, text, text, timestamptz, timestamptz, timestamptz, text, jsonb, text, text, jsonb, text),
  public.commercial_settlement_delivery_claim(uuid, uuid, uuid),
  public.commercial_settlement_delivery_record(uuid, uuid, uuid, uuid, text, text),
  public.commercial_settlement_read(uuid, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.commercial_settlement_begin(uuid, uuid, text, text, timestamptz, timestamptz, timestamptz, text, jsonb, text, text, jsonb, text),
  public.commercial_settlement_delivery_claim(uuid, uuid, uuid),
  public.commercial_settlement_delivery_record(uuid, uuid, uuid, uuid, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION
  public.commercial_settlement_evidence(uuid, timestamptz, timestamptz, timestamptz),
  public.commercial_settlement_read(uuid, timestamptz, timestamptz)
  TO authenticated, service_role;

COMMIT;
