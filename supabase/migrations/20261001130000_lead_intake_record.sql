BEGIN;
-- Durable lead intake, first half of MVP sequence step 3.
--
-- One envelope and one workflow transition commit in this transaction.
-- The provider event id is the dedupe key inside its provider namespace.
-- The shop argument is the only tenant. It is never read from the payload.
-- This writer does not resolve a person, record consent, create a lead,
-- or stage an approval. A saved row stays pending handoff; nothing in this
-- migration sends, imports, or opens a review card.
--
-- Rollback is forward-only: drop the three tables and the three functions
-- in a later migration if this slice is reverted before release.

CREATE FUNCTION public.normalize_lead_intake_payload(p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  v_key text;
  v_value jsonb;
  v_text text;
  v_result jsonb := '{}'::jsonb;
  v_limit integer;
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Intake payload must be an object' USING ERRCODE = '22023';
  END IF;
  FOR v_key, v_value IN SELECT key, value FROM jsonb_each(p_payload) LOOP
    IF v_key NOT IN ('display_name', 'phone', 'email', 'message', 'vehicle_text', 'service_text') THEN
      RAISE EXCEPTION 'Intake payload field is not accepted' USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_value) IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'Intake payload fields must be text' USING ERRCODE = '22023';
    END IF;
    v_text := v_value #>> '{}';
    v_limit := CASE WHEN v_key = 'message' THEN 4000 ELSE 200 END;
    IF length(v_text) > v_limit OR length(btrim(v_text)) = 0 OR length(btrim(v_text)) > v_limit THEN
      RAISE EXCEPTION 'Intake payload field is not accepted' USING ERRCODE = '22023';
    END IF;
    v_result := v_result || jsonb_build_object(v_key, btrim(v_text));
  END LOOP;
  RETURN v_result;
END $$;

CREATE TABLE public.lead_workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops (id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('sms', 'website_form', 'meta', 'synthetic')),
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  thread_key text CHECK (thread_key IS NULL OR length(thread_key) BETWEEN 1 AND 256),
  state text NOT NULL CHECK (state = 'identity_review'),
  revision integer NOT NULL CHECK (revision > 0),
  last_envelope_id uuid NOT NULL,
  last_received_at timestamptz NOT NULL,
  handoff_reason text NOT NULL CHECK (handoff_reason = 'identity_unresolved'),
  handoff_pending boolean NOT NULL DEFAULT true CHECK (handoff_pending IS TRUE),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id)
);

-- Events that share an explicit thread key share one workflow. A missing
-- thread key never falls back to a phone, email, or name match.
CREATE UNIQUE INDEX lead_workflows_thread_key_unique
  ON public.lead_workflows (shop_id, channel, provider, thread_key)
  WHERE thread_key IS NOT NULL;

CREATE TABLE public.lead_intake_envelopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops (id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('sms', 'website_form', 'meta', 'synthetic')),
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  provider_event_id text NOT NULL CHECK (length(provider_event_id) BETWEEN 1 AND 512),
  received_at timestamptz NOT NULL,
  evidence_ref text CHECK (evidence_ref IS NULL OR length(evidence_ref) BETWEEN 1 AND 512),
  thread_key text CHECK (thread_key IS NULL OR length(thread_key) BETWEEN 1 AND 256),
  payload jsonb NOT NULL,
  workflow_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  UNIQUE (provider, provider_event_id),
  FOREIGN KEY (shop_id, workflow_id)
    REFERENCES public.lead_workflows (shop_id, id) ON DELETE CASCADE
);

CREATE INDEX lead_intake_envelopes_shop_received_idx
  ON public.lead_intake_envelopes (shop_id, received_at DESC);

CREATE TABLE public.lead_workflow_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops (id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL,
  envelope_id uuid NOT NULL,
  from_state text CHECK (from_state IS NULL OR from_state = 'identity_review'),
  to_state text NOT NULL CHECK (to_state = 'identity_review'),
  revision integer NOT NULL CHECK (revision > 0),
  reason text NOT NULL CHECK (reason IN ('identity_unresolved', 'additional_evidence')),
  received_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (envelope_id),
  UNIQUE (workflow_id, revision),
  FOREIGN KEY (shop_id, workflow_id)
    REFERENCES public.lead_workflows (shop_id, id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, envelope_id)
    REFERENCES public.lead_intake_envelopes (shop_id, id) ON DELETE CASCADE
);

ALTER TABLE public.lead_workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_intake_envelopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_workflow_transitions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.lead_workflows, public.lead_intake_envelopes, public.lead_workflow_transitions
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.lead_workflows, public.lead_intake_envelopes, public.lead_workflow_transitions
  TO service_role;

COMMENT ON TABLE public.lead_intake_envelopes IS
  'Normalized intake evidence. One row per provider event id. First payload wins. No person resolution.';
COMMENT ON TABLE public.lead_workflows IS
  'Lead workflow opened by intake. This slice only records identity_review and leaves handoff pending.';
COMMENT ON TABLE public.lead_workflow_transitions IS
  'One committed transition per intake envelope, written in the same transaction as that envelope.';

CREATE FUNCTION public.lead_intake_result(p_envelope uuid, p_status text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'envelope_id', e.id,
    'workflow_id', w.id,
    'transition_id', t.id,
    'revision', w.revision,
    'state', w.state
  ) || jsonb_build_object('status', p_status)
  FROM public.lead_intake_envelopes e
  JOIN public.lead_workflows w
    ON w.shop_id = e.shop_id AND w.id = e.workflow_id
  JOIN public.lead_workflow_transitions t
    ON t.shop_id = e.shop_id AND t.envelope_id = e.id
  WHERE e.id = p_envelope
    AND p_status IN ('recorded', 'already_recorded');
$$;

CREATE FUNCTION public.record_lead_intake(
  p_shop uuid,
  p_channel text,
  p_provider text,
  p_event_id text,
  p_received_at timestamptz,
  p_evidence_ref text,
  p_thread_key text,
  p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_provider text;
  v_event text;
  v_thread text;
  v_evidence text;
  v_payload jsonb;
  v_existing public.lead_intake_envelopes%ROWTYPE;
  v_workflow_id uuid := NULL;
  v_workflow_state text;
  v_workflow_revision integer;
  v_envelope_id uuid;
  v_transition_id uuid;
  v_revision integer;
  v_from text;
  v_reason text;
  v_result jsonb;
BEGIN
  IF p_shop IS NULL OR NOT EXISTS (SELECT 1 FROM public.shops WHERE id = p_shop) THEN
    RAISE EXCEPTION 'Intake shop is unavailable' USING ERRCODE = '42501';
  END IF;
  IF p_channel IS NULL OR p_channel NOT IN ('sms', 'website_form', 'meta', 'synthetic') THEN
    RAISE EXCEPTION 'Intake channel is not accepted' USING ERRCODE = '22023';
  END IF;
  IF p_provider IS NULL OR p_event_id IS NULL OR p_received_at IS NULL THEN
    RAISE EXCEPTION 'Intake provider, event id, and received time are required' USING ERRCODE = '22023';
  END IF;

  v_provider := btrim(p_provider);
  v_event := btrim(p_event_id);
  IF length(v_provider) NOT BETWEEN 1 AND 64 OR length(p_provider) > 64
     OR length(v_event) NOT BETWEEN 1 AND 512 OR length(p_event_id) > 512 THEN
    RAISE EXCEPTION 'Intake provider event id is not accepted' USING ERRCODE = '22023';
  END IF;

  IF p_evidence_ref IS NULL THEN
    v_evidence := NULL;
  ELSE
    v_evidence := btrim(p_evidence_ref);
    IF length(v_evidence) NOT BETWEEN 1 AND 512 OR length(p_evidence_ref) > 512 THEN
      RAISE EXCEPTION 'Intake evidence reference is not accepted' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_thread_key IS NULL THEN
    v_thread := NULL;
  ELSE
    v_thread := btrim(p_thread_key);
    IF length(v_thread) NOT BETWEEN 1 AND 256 OR length(p_thread_key) > 256 THEN
      RAISE EXCEPTION 'Intake thread key is not accepted' USING ERRCODE = '22023';
    END IF;
  END IF;

  v_payload := public.normalize_lead_intake_payload(p_payload);

  -- Serialize the provider event before any insert. The unique constraint
  -- remains the durable dedupe if two sessions ever pass this lock.
  PERFORM pg_catalog.pg_advisory_xact_lock(48101, pg_catalog.hashtext(v_provider || chr(31) || v_event));

  SELECT * INTO v_existing
    FROM public.lead_intake_envelopes
   WHERE provider = v_provider AND provider_event_id = v_event
   FOR UPDATE;

  IF FOUND THEN
    IF v_existing.shop_id IS DISTINCT FROM p_shop THEN
      RAISE EXCEPTION 'Intake event belongs to another shop' USING ERRCODE = '42501';
    END IF;
    v_result := public.lead_intake_result(v_existing.id, 'already_recorded');
    IF v_result IS NULL THEN
      RAISE EXCEPTION 'Intake record could not be reread' USING ERRCODE = '55000';
    END IF;
    RETURN v_result;
  END IF;

  IF v_thread IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      48102,
      pg_catalog.hashtext(p_shop::text || chr(31) || p_channel || chr(31) || v_provider || chr(31) || v_thread)
    );
    SELECT id, state, revision
      INTO v_workflow_id, v_workflow_state, v_workflow_revision
      FROM public.lead_workflows
     WHERE shop_id = p_shop
       AND channel = p_channel
       AND provider = v_provider
       AND thread_key = v_thread
     FOR UPDATE;
  END IF;

  BEGIN
    v_envelope_id := pg_catalog.gen_random_uuid();
    v_transition_id := pg_catalog.gen_random_uuid();
    IF v_workflow_id IS NULL THEN
      v_revision := 1;
      v_from := NULL;
      v_reason := 'identity_unresolved';
      INSERT INTO public.lead_workflows (
        shop_id, channel, provider, thread_key, state, revision,
        last_envelope_id, last_received_at, handoff_reason, handoff_pending
      ) VALUES (
        p_shop, p_channel, v_provider, v_thread, 'identity_review', 1,
        v_envelope_id, p_received_at, 'identity_unresolved', true
      ) RETURNING id INTO v_workflow_id;
    ELSE
      v_revision := v_workflow_revision + 1;
      v_from := v_workflow_state;
      v_reason := 'additional_evidence';
    END IF;

    INSERT INTO public.lead_intake_envelopes (
      id, shop_id, channel, provider, provider_event_id, received_at,
      evidence_ref, thread_key, payload, workflow_id
    ) VALUES (
      v_envelope_id, p_shop, p_channel, v_provider, v_event, p_received_at,
      v_evidence, v_thread, v_payload, v_workflow_id
    );

    INSERT INTO public.lead_workflow_transitions (
      id, shop_id, workflow_id, envelope_id, from_state, to_state,
      revision, reason, received_at
    ) VALUES (
      v_transition_id, p_shop, v_workflow_id, v_envelope_id, v_from, 'identity_review',
      v_revision, v_reason, p_received_at
    );

    IF v_reason = 'additional_evidence' THEN
      UPDATE public.lead_workflows
         SET revision = v_revision,
             last_envelope_id = CASE
               WHEN p_received_at > last_received_at THEN v_envelope_id
               ELSE last_envelope_id
             END,
             last_received_at = CASE
               WHEN p_received_at > last_received_at THEN p_received_at
               ELSE last_received_at
             END,
             updated_at = pg_catalog.clock_timestamp()
       WHERE shop_id = p_shop AND id = v_workflow_id;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_existing
      FROM public.lead_intake_envelopes
     WHERE provider = v_provider AND provider_event_id = v_event;
    IF NOT FOUND THEN
      RAISE;
    END IF;
    IF v_existing.shop_id IS DISTINCT FROM p_shop THEN
      RAISE EXCEPTION 'Intake event belongs to another shop' USING ERRCODE = '42501';
    END IF;
    v_result := public.lead_intake_result(v_existing.id, 'already_recorded');
    IF v_result IS NULL THEN
      RAISE EXCEPTION 'Intake record could not be reread' USING ERRCODE = '55000';
    END IF;
    RETURN v_result;
  END;

  v_result := public.lead_intake_result(v_envelope_id, 'recorded');
  IF v_result IS NULL THEN
    RAISE EXCEPTION 'Intake record could not be reread' USING ERRCODE = '55000';
  END IF;
  RETURN v_result;
END $$;

REVOKE ALL ON FUNCTION public.normalize_lead_intake_payload(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.lead_intake_result(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_lead_intake(uuid, text, text, text, timestamptz, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_lead_intake(uuid, text, text, text, timestamptz, text, text, jsonb)
  TO service_role;

COMMIT;
