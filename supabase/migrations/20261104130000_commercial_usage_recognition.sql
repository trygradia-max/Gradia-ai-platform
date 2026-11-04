BEGIN;

-- Commercial usage recognition (Commercial Billing PR A, backend only).
--
-- Gradia's database is the pricing and billing authority; Stripe is a later
-- collection/reconciliation adapter. This migration adds the smallest immutable
-- contract that can say, per tenant, "this exact approved metric was incurred,
-- here is the evidence", without touching the historical operational ledger:
--
--  * public.usage_events (provider/credit cost ledger) is NOT modified. The only
--    change that touches it is a plain unique index on (shop_id, id) so a
--    recognition can carry a tenant-exact foreign key to the ledger row it is
--    evidence for. No usage_events row is rewritten and none is reclassified.
--  * Recognitions and their corrections are append-only. A correction is a
--    separate compensating row linked to the original; recognized facts are
--    never UPDATEd or DELETEd (only the cascade from deleting the whole shop,
--    which is the existing tenant-deletion contract, may remove them).
--  * Only the service role may write, and only through the functions below.
--    Browser roles have no table grant and no function grant for writes. Owners
--    read through an authority-checked function that re-derives live owner
--    membership; staff, managers, revoked, anonymous and cross-shop callers are
--    refused.
--  * Digital outcomes require explicit confirmed-outcome evidence. Drafts,
--    proposals, escalations, failures, unknown results and human-completed
--    work are refused at the boundary, never stored.
--  * Wholesale evidence is nullable and paired with its basis. Unknown is
--    stored as NULL and is never coerced to zero.

-- ---------------------------------------------------------------------------
-- Tenant-exact evidence reference into the existing ledger (no row is touched)
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS usage_events_shop_id_id_unique
  ON public.usage_events (shop_id, id);

-- ---------------------------------------------------------------------------
-- Immutable registry of approved commercial catalog versions
-- ---------------------------------------------------------------------------
CREATE TABLE public.commercial_catalog_versions (
  version text PRIMARY KEY CHECK (version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}\.v[0-9]+$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION public.commercial_catalog_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  RAISE EXCEPTION 'Commercial catalog versions are immutable; publish a new version' USING ERRCODE='42501';
END $$;
CREATE TRIGGER commercial_catalog_versions_immutable
  BEFORE UPDATE OR DELETE ON public.commercial_catalog_versions
  FOR EACH ROW EXECUTE FUNCTION public.commercial_catalog_immutable();

-- Must equal APPROVED_COMMERCIAL_CATALOG_VERSION in src/lib/approved-commercial-catalog.ts
-- (asserted by the integration suite).
INSERT INTO public.commercial_catalog_versions(version) VALUES ('2026-11-03.v1');

-- ---------------------------------------------------------------------------
-- Recognized usage facts
-- ---------------------------------------------------------------------------
CREATE TABLE public.commercial_usage_recognitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  catalog_version text NOT NULL REFERENCES public.commercial_catalog_versions(version),
  metric text NOT NULL CHECK (metric IN (
    'standard_digital_outcome', 'qualified_lead', 'confirmed_appointment',
    'inbound_voice_agent_minute', 'sms_segment')),
  quantity numeric(18,6) NOT NULL CHECK (quantity > 0 AND quantity <= 1000000),
  -- Where the fact comes from. Provider usage must trace to the existing ledger
  -- row (tenant-exact FK); a digital outcome traces to a workflow identity.
  source_kind text NOT NULL CHECK (source_kind IN ('usage_event', 'workflow_outcome')),
  source_ref text NOT NULL CHECK (length(btrim(source_ref)) BETWEEN 1 AND 200),
  source_usage_event_id uuid,
  workflow_key text CHECK (workflow_key IS NULL OR length(btrim(workflow_key)) BETWEEN 1 AND 200),
  -- Wholesale unit cost in cents per unit; NULL means UNKNOWN, never zero.
  wholesale_unit_cost_cents numeric(18,6) CHECK (wholesale_unit_cost_cents IS NULL OR wholesale_unit_cost_cents >= 0),
  wholesale_basis text CHECK (wholesale_basis IS NULL OR wholesale_basis IN ('provider_reported', 'provider_rate_card')),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(evidence) = 'object' AND length(evidence::text) <= 4000),
  recognized_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_.:-]{16,200}$'),
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, idempotency_key),
  FOREIGN KEY (shop_id, source_usage_event_id) REFERENCES public.usage_events(shop_id, id),
  CHECK ((wholesale_unit_cost_cents IS NULL) = (wholesale_basis IS NULL)),
  CHECK ((source_kind = 'usage_event') = (source_usage_event_id IS NOT NULL)),
  CHECK ((metric IN ('standard_digital_outcome', 'qualified_lead', 'confirmed_appointment'))
         = (source_kind = 'workflow_outcome')),
  CHECK ((source_kind = 'workflow_outcome') = (workflow_key IS NOT NULL)),
  CHECK (source_kind = 'usage_event' OR quantity = 1),
  CHECK (source_kind = 'usage_event' OR wholesale_unit_cost_cents IS NULL)
);
-- One ledger row can be recognized at most once, whatever idempotency key is used.
CREATE UNIQUE INDEX commercial_usage_recognitions_source_uniq
  ON public.commercial_usage_recognitions (shop_id, source_usage_event_id)
  WHERE source_usage_event_id IS NOT NULL;
CREATE INDEX commercial_usage_recognitions_window_idx
  ON public.commercial_usage_recognitions (shop_id, recognized_at, id);
CREATE INDEX commercial_usage_recognitions_workflow_idx
  ON public.commercial_usage_recognitions (shop_id, workflow_key)
  WHERE workflow_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Compensating corrections (reduce a recognized quantity; never edit the fact)
-- ---------------------------------------------------------------------------
CREATE TABLE public.commercial_usage_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  recognition_id uuid NOT NULL,
  quantity numeric(18,6) NOT NULL CHECK (quantity > 0 AND quantity <= 1000000),
  reason text NOT NULL CHECK (reason IN (
    'recognized_in_error', 'duplicate', 'not_confirmed', 'human_completed', 'provider_adjustment')),
  note text CHECK (note IS NULL OR length(note) <= 500),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_.:-]{16,200}$'),
  UNIQUE (shop_id, idempotency_key),
  FOREIGN KEY (shop_id, recognition_id) REFERENCES public.commercial_usage_recognitions(shop_id, id)
);
CREATE INDEX commercial_usage_corrections_recognition_idx
  ON public.commercial_usage_corrections (shop_id, recognition_id);

-- Append-only. A direct delete is refused; only the cascade from deleting the
-- whole shop may remove rows (the parent row is already gone when it fires).
CREATE FUNCTION public.commercial_usage_append_only() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'Commercial usage evidence cannot be truncated' USING ERRCODE='42501';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Commercial usage evidence is immutable; record a compensating correction' USING ERRCODE='42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.shops WHERE id = OLD.shop_id) THEN
    RAISE EXCEPTION 'Commercial usage evidence cannot be deleted' USING ERRCODE='42501';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER commercial_usage_recognitions_append_only
  BEFORE UPDATE OR DELETE ON public.commercial_usage_recognitions
  FOR EACH ROW EXECUTE FUNCTION public.commercial_usage_append_only();
CREATE TRIGGER commercial_usage_corrections_append_only
  BEFORE UPDATE OR DELETE ON public.commercial_usage_corrections
  FOR EACH ROW EXECUTE FUNCTION public.commercial_usage_append_only();
CREATE TRIGGER commercial_usage_recognitions_no_truncate
  BEFORE TRUNCATE ON public.commercial_usage_recognitions
  FOR EACH STATEMENT EXECUTE FUNCTION public.commercial_usage_append_only();
CREATE TRIGGER commercial_usage_corrections_no_truncate
  BEFORE TRUNCATE ON public.commercial_usage_corrections
  FOR EACH STATEMENT EXECUTE FUNCTION public.commercial_usage_append_only();

ALTER TABLE public.commercial_catalog_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commercial_usage_recognitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commercial_usage_corrections ENABLE ROW LEVEL SECURITY;

-- No browser-role policy and no browser-role grant. The service role may read
-- but has no direct write privilege: the functions below are the only writer.
REVOKE ALL ON public.commercial_catalog_versions, public.commercial_usage_recognitions,
  public.commercial_usage_corrections FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.commercial_catalog_versions, public.commercial_usage_recognitions,
  public.commercial_usage_corrections TO service_role;

-- ---------------------------------------------------------------------------
-- Authority
-- ---------------------------------------------------------------------------
-- Live owner authority, re-derived from the database on every call. Membership
-- of any other role, a revoked/inactive membership, or no session all fail.
CREATE FUNCTION public.commercial_is_active_owner(p_shop uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT auth.uid() IS NOT NULL
    AND public.team_is_owner(p_shop)
    AND EXISTS (SELECT 1 FROM public.shop_memberships m
      WHERE m.shop_id = p_shop AND m.user_id = auth.uid() AND m.role = 'owner' AND m.active);
$$;

-- ---------------------------------------------------------------------------
-- Recognize one usage fact (service role only). Atomic and idempotent.
-- ---------------------------------------------------------------------------
-- Failure codes: 42501 authority, 22023 invalid input, CB422 not billable,
-- CB409 conflict with an existing immutable fact.
CREATE FUNCTION public.commercial_recognize_usage(
  p_shop uuid,
  p_catalog_version text,
  p_metric text,
  p_quantity numeric,
  p_source_kind text,
  p_source_ref text,
  p_source_usage_event_id uuid,
  p_workflow_key text,
  p_wholesale_unit_cost_cents numeric,
  p_wholesale_basis text,
  p_evidence jsonb,
  p_recognized_at timestamptz,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  is_outcome boolean;
  ledger public.usage_events;
  existing public.commercial_usage_recognitions;
  new_id uuid;
  evidence jsonb := coalesce(p_evidence, '{}'::jsonb);
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Commercial usage recognition is a server-only command' USING ERRCODE='42501';
  END IF;
  IF p_shop IS NULL OR NOT EXISTS (SELECT 1 FROM public.shops WHERE id = p_shop) THEN
    RAISE EXCEPTION 'Unknown shop' USING ERRCODE='22023';
  END IF;
  IF p_catalog_version IS NULL OR NOT EXISTS
     (SELECT 1 FROM public.commercial_catalog_versions WHERE version = p_catalog_version) THEN
    RAISE EXCEPTION 'Unknown commercial catalog version' USING ERRCODE='22023';
  END IF;
  IF p_metric IS NULL OR p_metric NOT IN (
      'standard_digital_outcome', 'qualified_lead', 'confirmed_appointment',
      'inbound_voice_agent_minute', 'sms_segment') THEN
    RAISE EXCEPTION 'Unknown commercial metric' USING ERRCODE='22023';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 OR p_quantity > 1000000 THEN
    RAISE EXCEPTION 'Quantity must be positive' USING ERRCODE='22023';
  END IF;
  IF jsonb_typeof(evidence) <> 'object' OR length(evidence::text) > 4000 THEN
    RAISE EXCEPTION 'Evidence must be a small object' USING ERRCODE='22023';
  END IF;
  IF p_recognized_at IS NULL OR p_recognized_at > clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'Recognition time is missing or in the future' USING ERRCODE='22023';
  END IF;
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9_.:-]{16,200}$' THEN
    RAISE EXCEPTION 'Invalid idempotency key' USING ERRCODE='22023';
  END IF;
  IF (p_wholesale_unit_cost_cents IS NULL) <> (p_wholesale_basis IS NULL) THEN
    RAISE EXCEPTION 'Wholesale cost and its basis must be supplied together' USING ERRCODE='22023';
  END IF;

  is_outcome := p_metric IN ('standard_digital_outcome', 'qualified_lead', 'confirmed_appointment');

  IF is_outcome THEN
    IF p_source_kind IS DISTINCT FROM 'workflow_outcome' OR p_source_usage_event_id IS NOT NULL
       OR p_workflow_key IS NULL OR p_quantity <> 1 OR p_wholesale_unit_cost_cents IS NOT NULL THEN
      RAISE EXCEPTION 'A digital outcome needs a workflow identity, quantity 1 and no provider cost' USING ERRCODE='22023';
    END IF;
    -- Fail closed: only an explicitly confirmed, not-human-completed outcome is billable.
    IF evidence->>'outcome_state' IS DISTINCT FROM 'confirmed'
       OR evidence->'human_completed' IS DISTINCT FROM 'false'::jsonb THEN
      RAISE EXCEPTION 'Not a billable outcome: %',
        coalesce(evidence->>'outcome_state', 'no outcome evidence') USING ERRCODE='CB422';
    END IF;
  ELSE
    IF p_source_kind IS DISTINCT FROM 'usage_event' OR p_source_usage_event_id IS NULL OR p_workflow_key IS NOT NULL THEN
      RAISE EXCEPTION 'Provider usage must reference its usage ledger row' USING ERRCODE='22023';
    END IF;
    SELECT * INTO ledger FROM public.usage_events
      WHERE id = p_source_usage_event_id AND shop_id = p_shop;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Usage ledger evidence not found for this shop' USING ERRCODE='22023';
    END IF;
    IF ledger.kind IS DISTINCT FROM (CASE p_metric
         WHEN 'inbound_voice_agent_minute' THEN 'voice_minute' ELSE 'sms_segment' END)
       OR ledger.quantity::numeric <> p_quantity THEN
      RAISE EXCEPTION 'Usage ledger evidence does not match the recognized metric and quantity' USING ERRCODE='22023';
    END IF;
    -- The historical ledger does not record call direction; it must be supplied.
    IF p_metric = 'inbound_voice_agent_minute' AND evidence->>'direction' IS DISTINCT FROM 'inbound' THEN
      RAISE EXCEPTION 'Inbound direction evidence is required for voice minutes' USING ERRCODE='22023';
    END IF;
  END IF;

  INSERT INTO public.commercial_usage_recognitions(
    shop_id, catalog_version, metric, quantity, source_kind, source_ref, source_usage_event_id,
    workflow_key, wholesale_unit_cost_cents, wholesale_basis, evidence, recognized_at, idempotency_key)
  VALUES (p_shop, p_catalog_version, p_metric, p_quantity, p_source_kind, p_source_ref,
    p_source_usage_event_id, p_workflow_key, p_wholesale_unit_cost_cents, p_wholesale_basis,
    evidence, p_recognized_at, p_idempotency_key)
  ON CONFLICT DO NOTHING
  RETURNING id INTO new_id;

  IF new_id IS NOT NULL THEN
    RETURN jsonb_build_object('id', new_id, 'replayed', false);
  END IF;

  -- Some unique rule fired. Either this identity already holds the fact (replay)
  -- or another identity already recognized the same ledger row (conflict).
  SELECT * INTO existing FROM public.commercial_usage_recognitions
    WHERE shop_id = p_shop AND idempotency_key = p_idempotency_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Source evidence is already recognized under a different identity' USING ERRCODE='CB409';
  END IF;
  IF existing.catalog_version IS DISTINCT FROM p_catalog_version
     OR existing.metric IS DISTINCT FROM p_metric
     OR existing.quantity IS DISTINCT FROM p_quantity
     OR existing.source_kind IS DISTINCT FROM p_source_kind
     OR existing.source_ref IS DISTINCT FROM p_source_ref
     OR existing.source_usage_event_id IS DISTINCT FROM p_source_usage_event_id
     OR existing.workflow_key IS DISTINCT FROM p_workflow_key
     OR existing.wholesale_unit_cost_cents IS DISTINCT FROM p_wholesale_unit_cost_cents
     OR existing.wholesale_basis IS DISTINCT FROM p_wholesale_basis
     OR existing.evidence IS DISTINCT FROM evidence
     OR existing.recognized_at IS DISTINCT FROM p_recognized_at THEN
    RAISE EXCEPTION 'Idempotency identity already holds a different immutable fact' USING ERRCODE='CB409';
  END IF;
  RETURN jsonb_build_object('id', existing.id, 'replayed', true);
END $$;

-- ---------------------------------------------------------------------------
-- Compensating correction (service role only). Cannot over-correct.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.commercial_correct_usage(
  p_shop uuid,
  p_recognition_id uuid,
  p_quantity numeric,
  p_reason text,
  p_note text,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  target public.commercial_usage_recognitions;
  existing public.commercial_usage_corrections;
  already numeric;
  new_id uuid;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Commercial usage correction is a server-only command' USING ERRCODE='42501';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 OR p_quantity > 1000000
     OR p_reason IS NULL OR p_reason NOT IN (
       'recognized_in_error', 'duplicate', 'not_confirmed', 'human_completed', 'provider_adjustment')
     OR (p_note IS NOT NULL AND length(p_note) > 500)
     OR p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9_.:-]{16,200}$' THEN
    RAISE EXCEPTION 'Invalid correction' USING ERRCODE='22023';
  END IF;

  -- The row lock serializes concurrent corrections of one recognition; a lock is
  -- not an UPDATE, so the append-only trigger is not involved.
  SELECT * INTO target FROM public.commercial_usage_recognitions
    WHERE id = p_recognition_id AND shop_id = p_shop FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Recognition not found for this shop' USING ERRCODE='22023';
  END IF;

  SELECT * INTO existing FROM public.commercial_usage_corrections
    WHERE shop_id = p_shop AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF existing.recognition_id IS DISTINCT FROM p_recognition_id
       OR existing.quantity IS DISTINCT FROM p_quantity
       OR existing.reason IS DISTINCT FROM p_reason
       OR existing.note IS DISTINCT FROM p_note THEN
      RAISE EXCEPTION 'Idempotency identity already holds a different correction' USING ERRCODE='CB409';
    END IF;
    RETURN jsonb_build_object('id', existing.id, 'replayed', true);
  END IF;

  SELECT coalesce(sum(quantity), 0) INTO already FROM public.commercial_usage_corrections
    WHERE shop_id = p_shop AND recognition_id = p_recognition_id;
  IF already + p_quantity > target.quantity THEN
    RAISE EXCEPTION 'Correction exceeds the remaining recognized quantity' USING ERRCODE='CB409';
  END IF;

  INSERT INTO public.commercial_usage_corrections(
    shop_id, recognition_id, quantity, reason, note, idempotency_key)
  VALUES (p_shop, p_recognition_id, p_quantity, p_reason, p_note, p_idempotency_key)
  RETURNING id INTO new_id;
  RETURN jsonb_build_object('id', new_id, 'replayed', false);
END $$;

-- ---------------------------------------------------------------------------
-- Read the evidence for one explicit half-open UTC window [start, end).
-- Owners (live, active) and the service role only. Returns raw immutable facts;
-- the deterministic preview arithmetic is performed by reviewed application code.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.commercial_usage_read(
  p_shop uuid,
  p_window_start timestamptz,
  p_window_end timestamptz,
  p_as_of timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE
  as_of timestamptz := coalesce(p_as_of, clock_timestamp());
  facts jsonb;
  corrections jsonb;
  prior jsonb;
BEGIN
  IF NOT (coalesce(auth.role(), '') = 'service_role' OR public.commercial_is_active_owner(p_shop)) THEN
    RAISE EXCEPTION 'Owner authority required' USING ERRCODE='42501';
  END IF;
  IF p_window_start IS NULL OR p_window_end IS NULL OR p_window_end <= p_window_start
     OR p_window_end - p_window_start > interval '40 days' THEN
    RAISE EXCEPTION 'Invalid window' USING ERRCODE='22023';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'catalog_version', r.catalog_version, 'metric', r.metric,
      'quantity', r.quantity::text, 'source_kind', r.source_kind, 'source_ref', r.source_ref,
      'source_usage_event_id', r.source_usage_event_id, 'workflow_key', r.workflow_key,
      'wholesale_unit_cost_cents', r.wholesale_unit_cost_cents::text,
      'wholesale_basis', r.wholesale_basis, 'recognized_at', r.recognized_at,
      'recorded_at', r.recorded_at) ORDER BY r.recognized_at, r.id), '[]'::jsonb)
    INTO facts
    FROM public.commercial_usage_recognitions r
    WHERE r.shop_id = p_shop AND r.recognized_at >= p_window_start AND r.recognized_at < p_window_end
      AND r.recorded_at <= as_of;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'recognition_id', c.recognition_id, 'quantity', c.quantity::text,
      'reason', c.reason, 'recorded_at', c.recorded_at) ORDER BY c.recorded_at, c.id), '[]'::jsonb)
    INTO corrections
    FROM public.commercial_usage_corrections c
    JOIN public.commercial_usage_recognitions r ON r.shop_id = c.shop_id AND r.id = c.recognition_id
    WHERE c.shop_id = p_shop AND r.recognized_at >= p_window_start AND r.recognized_at < p_window_end
      AND r.recorded_at <= as_of AND c.recorded_at <= as_of;

  -- For workflows seen in the window: the highest outcome that survived
  -- corrections in an EARLIER window, so one workflow is never charged twice.
  SELECT coalesce(jsonb_object_agg(workflow_key, metric), '{}'::jsonb) INTO prior FROM (
    SELECT DISTINCT ON (e.workflow_key) e.workflow_key, e.metric FROM (
      SELECT r.workflow_key, r.metric,
        CASE r.metric WHEN 'confirmed_appointment' THEN 3 WHEN 'qualified_lead' THEN 2 ELSE 1 END AS rank
      FROM public.commercial_usage_recognitions r
      WHERE r.shop_id = p_shop AND r.workflow_key IS NOT NULL
        AND r.recognized_at < p_window_start AND r.recorded_at <= as_of
        AND r.quantity > coalesce((SELECT sum(c.quantity) FROM public.commercial_usage_corrections c
              WHERE c.shop_id = r.shop_id AND c.recognition_id = r.id AND c.recorded_at <= as_of), 0)
        AND r.workflow_key IN (
          SELECT w.workflow_key FROM public.commercial_usage_recognitions w
          WHERE w.shop_id = p_shop AND w.workflow_key IS NOT NULL
            AND w.recognized_at >= p_window_start AND w.recognized_at < p_window_end
            AND w.recorded_at <= as_of)
    ) e ORDER BY e.workflow_key, e.rank DESC
  ) best;

  RETURN jsonb_build_object(
    'shop_id', p_shop, 'window_start', p_window_start, 'window_end', p_window_end,
    'as_of', as_of, 'facts', facts, 'corrections', corrections, 'prior_workflow_metrics', prior);
END $$;

-- ---------------------------------------------------------------------------
-- Function ACLs
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  public.commercial_catalog_immutable(), public.commercial_usage_append_only(),
  public.commercial_is_active_owner(uuid),
  public.commercial_recognize_usage(uuid, text, text, numeric, text, text, uuid, text, numeric, text, jsonb, timestamptz, text),
  public.commercial_correct_usage(uuid, uuid, numeric, text, text, text),
  public.commercial_usage_read(uuid, timestamptz, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.commercial_recognize_usage(uuid, text, text, numeric, text, text, uuid, text, numeric, text, jsonb, timestamptz, text),
  public.commercial_correct_usage(uuid, uuid, numeric, text, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION
  public.commercial_usage_read(uuid, timestamptz, timestamptz, timestamptz)
  TO authenticated, service_role;

COMMIT;
