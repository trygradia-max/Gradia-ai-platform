BEGIN;
-- Meta Lead Ads page binding.
--
-- A page_id writes only when it is already bound to exactly one shop.
-- The webhook body is not the tenant. This is not the dormant messaging
-- page column on shops, and it does not connect a Meta app or a Page token.
-- Tests insert a binding with the service role. There is no owner UI here.
--
-- The intake payload may also carry the four event identifiers. They are
-- not a person, a thread, or consent. Lead field retrieval from Graph is
-- not part of this migration.

CREATE TABLE public.meta_lead_page_bindings (
  page_id text PRIMARY KEY,
  shop_id uuid NOT NULL REFERENCES public.shops (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meta_lead_page_bindings_page_id_check
    CHECK (page_id ~ '^[A-Za-z0-9_-]{1,64}$')
);

CREATE INDEX meta_lead_page_bindings_shop_idx
  ON public.meta_lead_page_bindings (shop_id);

ALTER TABLE public.meta_lead_page_bindings ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.meta_lead_page_bindings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.meta_lead_page_bindings TO service_role;

COMMENT ON TABLE public.meta_lead_page_bindings IS
  'Meta Lead Ads page bound to one shop. page_id is unique. Not a messaging connection.';

CREATE OR REPLACE FUNCTION public.normalize_lead_intake_payload(p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  v_key text;
  v_value jsonb;
  v_text text;
  v_result jsonb := '{}'::jsonb;
  v_limit integer;
  v_trimmed text;
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Intake payload must be an object' USING ERRCODE = '22023';
  END IF;
  FOR v_key, v_value IN SELECT key, value FROM jsonb_each(p_payload) LOOP
    IF v_key NOT IN (
      'display_name', 'phone', 'email', 'message', 'vehicle_text', 'service_text',
      'page_id', 'form_id', 'leadgen_id', 'created_time'
    ) THEN
      RAISE EXCEPTION 'Intake payload field is not accepted' USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_value) IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'Intake payload fields must be text' USING ERRCODE = '22023';
    END IF;
    v_text := v_value #>> '{}';
    v_limit := CASE
      WHEN v_key = 'message' THEN 4000
      WHEN v_key IN ('page_id', 'form_id', 'leadgen_id', 'created_time') THEN 64
      ELSE 200
    END;
    v_trimmed := btrim(v_text);
    IF length(v_text) > v_limit OR length(v_trimmed) = 0 OR length(v_trimmed) > v_limit THEN
      RAISE EXCEPTION 'Intake payload field is not accepted' USING ERRCODE = '22023';
    END IF;
    IF v_key IN ('page_id', 'form_id', 'leadgen_id')
       AND v_trimmed !~ '^[A-Za-z0-9_-]{1,64}$' THEN
      RAISE EXCEPTION 'Intake payload field is not accepted' USING ERRCODE = '22023';
    END IF;
    IF v_key = 'created_time'
       AND v_trimmed !~ '^[0-9]{1,16}$'
       AND v_trimmed !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN
      RAISE EXCEPTION 'Intake payload field is not accepted' USING ERRCODE = '22023';
    END IF;
    v_result := v_result || jsonb_build_object(v_key, v_trimmed);
  END LOOP;
  RETURN v_result;
END $$;

COMMIT;
