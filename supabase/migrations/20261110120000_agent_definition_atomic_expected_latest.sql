-- Make the builder's expected-latest check atomic with revision creation.
-- The application used to read latest_revision before calling the RPC, so two simultaneous saves
-- from the same view could both pass and create N+1 and N+2. The comparison now happens inside
-- the RPC while the agent row and state row are locked. Replay semantics are unchanged: a
-- recorded request id replays (or conflicts when changed) before the expected-latest check.
-- p_expected_latest: NULL = not enforced (Build 1 behavior), 0 = editor saw no revision.
-- New blocked code: stale_latest (+ latest_revision). No table, trigger or data change.

BEGIN;

DROP FUNCTION public.agent_definition_create_revision(uuid, uuid, uuid, uuid, jsonb, integer);

CREATE FUNCTION public.agent_definition_create_revision(
  p_shop uuid, p_actor uuid, p_agent uuid, p_request_id uuid, p_definition jsonb, p_parent integer DEFAULT NULL,
  p_expected_latest integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_enabled boolean;
  st public.agent_definition_state;
  ex public.agent_definition_revisions;
  v_fp text;
  v_next integer;
  v_parent integer;
  v_doc jsonb;
  v_hash text;
  k text;
  v_src text;
  v_rev integer;
  v_chash text;
  v_pins jsonb := '[]'::jsonb;
  v_missing jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.agent_definition_require_service();
  IF p_shop IS NULL OR p_actor IS NULL OR p_agent IS NULL OR p_request_id IS NULL OR p_definition IS NULL THEN
    RAISE EXCEPTION 'shop, actor, agent, request id and definition are required' USING ERRCODE='22023';
  END IF;
  IF public.agent_definition_actor_role(p_shop, p_actor) IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Live owner of this workspace required' USING ERRCODE='42501';
  END IF;

  -- Defense in depth for the stored shape; the application validates the full schema first.
  IF jsonb_typeof(p_definition) <> 'object' OR octet_length(p_definition::text) > 30000 THEN
    RAISE EXCEPTION 'Definition must be a bounded object' USING ERRCODE='22023';
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_definition) LOOP
    IF k NOT IN ('schemaVersion', 'key', 'job', 'knowledge', 'tools', 'schedule', 'limits', 'routing') THEN
      RAISE EXCEPTION 'Unsupported definition field' USING ERRCODE='22023';
    END IF;
  END LOOP;
  IF NOT (p_definition ?& ARRAY['schemaVersion', 'key', 'job', 'knowledge', 'tools', 'schedule', 'limits', 'routing'])
     OR p_definition -> 'schemaVersion' <> '1'::jsonb
     OR jsonb_typeof(p_definition #> '{knowledge,sourceIds}') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_definition -> 'tools') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Definition is incomplete or unsupported' USING ERRCODE='22023';
  END IF;
  FOR v_src IN SELECT jsonb_array_elements_text(p_definition #> '{knowledge,sourceIds}') LOOP
    IF v_src !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'Knowledge sources must be ids' USING ERRCODE='22023';
    END IF;
  END LOOP;
  v_fp := encode(sha256(convert_to(p_definition::text || '|' || coalesce(p_parent::text, ''), 'UTF8')), 'hex');

  -- Agent row first (tenant-bound), then the state row: one lock order everywhere.
  SELECT a.enabled INTO v_enabled FROM public.custom_agents a
   WHERE a.id = p_agent AND a.shop_id = p_shop FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'blocked', 'code', 'agent_not_found');
  END IF;

  SELECT * INTO st FROM public.agent_definition_state WHERE agent_id = p_agent FOR UPDATE;
  IF FOUND THEN
    SELECT * INTO ex FROM public.agent_definition_revisions WHERE agent_id = p_agent AND request_id = p_request_id;
    IF FOUND THEN
      IF ex.request_fingerprint <> v_fp THEN
        RAISE EXCEPTION 'Request id was already used for a different definition' USING ERRCODE='AD409';
      END IF;
      RETURN jsonb_build_object('outcome', 'replayed', 'revision', ex.revision,
        'definition_hash', ex.definition_hash, 'parent_revision', ex.parent_revision);
    END IF;
  ELSE
    -- No state yet: the editor can only have been looking at 'nothing saved' (0).
    IF p_expected_latest IS NOT NULL AND p_expected_latest <> 0 THEN
      RETURN jsonb_build_object('outcome', 'blocked', 'code', 'stale_latest', 'latest_revision', 0);
    END IF;
    -- A legacy enabled agent keeps running under its legacy path; it is converted
    -- only after the owner turns it off. Governed => (enabled <=> lifecycle active).
    IF v_enabled THEN
      RETURN jsonb_build_object('outcome', 'blocked', 'code', 'legacy_agent_enabled');
    END IF;
    INSERT INTO public.agent_definition_state (agent_id, shop_id) VALUES (p_agent, p_shop);
    SELECT * INTO st FROM public.agent_definition_state WHERE agent_id = p_agent FOR UPDATE;
  END IF;

  -- Optimistic concurrency, decided under the same agent + state locks that allocate the number.
  -- NULL = not enforced; 0 = the editor saw no revision. A recorded request id replayed above first.
  IF p_expected_latest IS NOT NULL AND p_expected_latest <> st.latest_revision THEN
    RETURN jsonb_build_object('outcome', 'blocked', 'code', 'stale_latest', 'latest_revision', st.latest_revision);
  END IF;

  IF p_parent IS NOT NULL AND (p_parent < 1 OR p_parent > st.latest_revision) THEN
    RETURN jsonb_build_object('outcome', 'blocked', 'code', 'parent_not_found');
  END IF;
  v_parent := coalesce(p_parent, nullif(st.latest_revision, 0));

  -- Pin the exact reviewed memory revision for every selected source.
  FOR v_src IN SELECT DISTINCT jsonb_array_elements_text(p_definition #> '{knowledge,sourceIds}') LOOP
    SELECT a.revision, r.content_hash INTO v_rev, v_chash
      FROM public.reviewed_memory_active a
      JOIN public.reviewed_memory_revisions r
        ON r.shop_id = a.shop_id AND r.source_id = a.source_id AND r.revision = a.revision
     WHERE a.shop_id = p_shop AND a.source_id = v_src::uuid
       AND r.state = 'published'
       AND r.valid_from <= clock_timestamp()
       AND (r.valid_until IS NULL OR r.valid_until > clock_timestamp())
       AND (r.retention_until IS NULL OR r.retention_until > clock_timestamp());
    IF NOT FOUND THEN
      v_missing := v_missing || to_jsonb(v_src);
    ELSE
      v_pins := v_pins || jsonb_build_object('source_id', v_src, 'memory_revision', v_rev, 'content_hash', v_chash);
    END IF;
  END LOOP;
  IF jsonb_array_length(v_missing) > 0 THEN
    RETURN jsonb_build_object('outcome', 'blocked', 'code', 'memory_not_selectable', 'source_ids', v_missing);
  END IF;

  v_next := st.latest_revision + 1;
  v_doc := p_definition || jsonb_build_object('revision', v_next, 'lifecycle', 'draft');
  v_hash := encode(sha256(convert_to(v_doc::text, 'UTF8')), 'hex');

  INSERT INTO public.agent_definition_revisions
    (shop_id, agent_id, revision, parent_revision, schema_version, definition, definition_hash,
     request_id, request_fingerprint, authored_by)
  VALUES (p_shop, p_agent, v_next, v_parent, 1, v_doc, v_hash, p_request_id, v_fp, p_actor);

  INSERT INTO public.agent_definition_memory_pins (shop_id, agent_id, revision, source_id, memory_revision, content_hash)
  SELECT p_shop, p_agent, v_next, (e ->> 'source_id')::uuid, (e ->> 'memory_revision')::integer, e ->> 'content_hash'
    FROM jsonb_array_elements(v_pins) AS e;

  PERFORM public.agent_definition_open_write();
  UPDATE public.agent_definition_state
     SET latest_revision = v_next, version = version + 1, updated_at = clock_timestamp()
   WHERE agent_id = p_agent;
  PERFORM public.agent_definition_close_write();

  PERFORM public.agent_definition_emit(p_shop, p_agent, 'revision_created', v_next, v_parent, p_actor,
    jsonb_build_object('definition_hash', v_hash, 'memory_pins', v_pins));

  RETURN jsonb_build_object('outcome', 'created', 'revision', v_next,
    'definition_hash', v_hash, 'parent_revision', v_parent);
END $$;

REVOKE ALL ON FUNCTION public.agent_definition_create_revision(uuid, uuid, uuid, uuid, jsonb, integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.agent_definition_create_revision(uuid, uuid, uuid, uuid, jsonb, integer, integer)
  TO service_role;

COMMIT;
