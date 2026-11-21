BEGIN;

-- Call Copilot PR F: the smallest owner / authorized-manager READ boundary for the post-call review surface.
--
-- Adds objects only. No table, column, row, policy, trigger, existing function or existing grant is changed, and
-- NO role gains access to any table: call_copilot_* tables stay RLS-on with no browser grant. The browser-facing
-- surface is exactly two read-only SECURITY DEFINER functions, granted to `authenticated` and nobody else:
--
--   call_copilot_review_list(shop, limit, cursor)   bounded, keyset-paginated calls with capture / evidence /
--                                                   proposal counts. No transcript text, no provider ids.
--   call_copilot_review_detail(shop, call, revision) one call: capture / consent state, evidence coverage and gaps,
--                                                   extraction runs, source-cited proposals with FRESH denial reasons,
--                                                   and only the cited snippets, and only while the gate permits.
--
-- Authority is derived INSIDE the database from auth.uid() (never from an argument): an active owner of the shop, or an
-- active manager holding crm.read, of exactly the shop named. Anyone else gets 42501; another shop's call is
-- indistinguishable from a missing one. The service role has no auth.uid() and is refused on purpose: this is the
-- human review boundary, not a service reader.
--
-- Transcript text is never returned wholesale. A citation's snippet is the exact cited span only, re-verified against the
-- stored quote digest, returned only when (a) the PR D gate permits crm_mutation use of the call now, (b) the proposal's
-- sealed evidence revision is still exactly current, (c) the cited segment lies inside a consented captured interval, and
-- (d) the span is not card-like. Otherwise the snippet is withheld with a reason code, never a guess.
--
-- Freshness is computed by the same checks the approval claim makes (payload unedited, requester, expiry, consent for CRM
-- mutation, evidence current, definition, CRM identity) in the same order, WITHOUT the claim's call-row lock, so a review
-- read can never block a capture writer or an approval. The integration tests assert parity with call_copilot_recheck.
--
-- Deploy order: apply this migration BEFORE (or with) the application build. The app fails closed (an error state, no
-- action offered) if these functions do not exist yet.

DO $$
BEGIN
  IF to_regclass('public.call_copilot_proposals') IS NULL OR to_regprocedure('public.call_copilot_recheck(uuid,uuid,jsonb)') IS NULL
     OR to_regprocedure('public.call_copilot_capture_state(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Call Copilot PR D and PR E are required' USING ERRCODE = '23514';
  END IF;
END $$;

-- Bounded pagination for the call list (adds an index only).
CREATE INDEX IF NOT EXISTS call_copilot_calls_shop_created_idx
  ON public.call_copilot_calls (shop_id, created_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- Who may review: the shop's active owner, or an active manager holding crm.read. Derived from auth.uid().
-- Returns 'owner' | 'manager' | NULL.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.call_copilot_review_viewer(p_shop uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN m.role = 'owner' THEN 'owner' ELSE 'manager' END
    FROM public.shop_memberships m JOIN public.shops s ON s.id = m.shop_id
   WHERE p_shop IS NOT NULL AND auth.uid() IS NOT NULL
     AND m.shop_id = p_shop AND m.user_id = auth.uid() AND m.active
     AND ((m.role = 'owner' AND s.owner_id = m.user_id)
       OR (m.role = 'manager' AND 'crm.read' = ANY (m.capabilities)))
   LIMIT 1
$$;

-- ---------------------------------------------------------------------------
-- Ambiguity, projected to what a reviewer needs. Candidate ids are reduced to counts (the review needs "several
-- customers match", not their identifiers); only the closed set of keys below ever leaves the database.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.call_copilot_review_ambiguity(a jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN a IS NULL OR jsonb_typeof(a) <> 'object' THEN NULL ELSE jsonb_strip_nulls(jsonb_build_object(
    'candidate_customers', CASE WHEN jsonb_typeof(a -> 'candidate_customer_ids') = 'array' THEN jsonb_array_length(a -> 'candidate_customer_ids') END,
    'candidate_vehicles',  CASE WHEN jsonb_typeof(a -> 'candidate_vehicle_ids') = 'array' THEN jsonb_array_length(a -> 'candidate_vehicle_ids') END,
    'existing_vehicles',   CASE WHEN jsonb_typeof(a -> 'existing_vehicle_ids') = 'array' THEN jsonb_array_length(a -> 'existing_vehicle_ids') END,
    'conflicts', CASE WHEN jsonb_typeof(a -> 'conflicts') = 'object' THEN (
        SELECT jsonb_agg(jsonb_build_object('field', k, 'crm', left(coalesce(v ->> 'crm', ''), 120), 'heard', left(coalesce(v ->> 'heard', ''), 120)) ORDER BY k)
          FROM jsonb_each(a -> 'conflicts') AS e(k, v) WHERE jsonb_typeof(v) = 'object' AND k ~ '^[a-z_]{1,32}$') END,
    'ungrounded_fields', CASE WHEN jsonb_typeof(a -> 'ungrounded_fields') = 'array' THEN (
        SELECT jsonb_agg(x) FROM jsonb_array_elements_text(a -> 'ungrounded_fields') x WHERE x ~ '^[a-z_]{1,32}$') END,
    'invalid_fields', CASE WHEN jsonb_typeof(a -> 'invalid_fields') = 'array' THEN (
        SELECT jsonb_agg(x) FROM jsonb_array_elements_text(a -> 'invalid_fields') x WHERE x ~ '^[a-z_]{1,32}$') END,
    'invalid_payload', CASE WHEN a -> 'invalid_payload' = 'true'::jsonb THEN true END,
    'note', CASE WHEN jsonb_typeof(a -> 'note') = 'string' THEN left(a ->> 'note', 200) END)) END
$$;

-- ---------------------------------------------------------------------------
-- Freshness: why a proposal could NOT be acted on right now, or NULL when nothing in the evidence, consent, authority or
-- CRM state has changed. Mirrors call_copilot_recheck (same checks, same order) minus its row lock, so a read can
-- never block a writer. For a review-only proposal nothing is staged, so the edit check does not apply.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.call_copilot_review_freshness(
  p_shop uuid, p_proposal uuid, p_payload jsonb, p_consent_ok boolean DEFAULT NULL, p_evidence_current boolean DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE prop public.call_copilot_proposals; cur jsonb; now_binding jsonb; v_consent boolean; v_current boolean;
BEGIN
  SELECT * INTO prop FROM public.call_copilot_proposals WHERE shop_id = p_shop AND id = p_proposal;
  IF NOT FOUND THEN RETURN 'call_proposal_unknown'; END IF;
  IF prop.route = 'pending_action' AND
     (p_payload - ARRAY['availability', 'conflict_override', 'calendar_sync', 'reconciliation', 'reconciliation_quote'])
       IS DISTINCT FROM prop.staged_payload THEN
    RETURN 'call_proposal_edited';
  END IF;
  IF NOT public.call_copilot_actor_ok(p_shop, prop.created_by) THEN RETURN 'call_requester_revoked'; END IF;
  IF prop.action_type = 'book_appointment' AND (
       prop.staged_payload ->> 'iso_start_time' IS NULL OR (prop.staged_payload ->> 'iso_start_time')::timestamptz <= clock_timestamp()) THEN
    RETURN 'call_proposal_expired';
  END IF;
  -- The detail reader asks the two expensive questions ONCE per call and passes the answers in; a standalone caller
  -- (the parity tests) lets them be computed here.
  v_consent := p_consent_ok;
  IF v_consent IS NULL THEN
    BEGIN
      PERFORM public.call_copilot_assert_capture(p_shop, prop.call_id, 'crm_mutation', NULL);
      v_consent := true;
    EXCEPTION WHEN OTHERS THEN
      v_consent := false;
    END;
  END IF;
  IF NOT v_consent THEN RETURN 'call_consent_unavailable'; END IF;
  v_current := p_evidence_current;
  IF v_current IS NULL THEN
    cur := public.call_copilot_evidence_is_current(p_shop, prop.evidence_revision_id);
    v_current := coalesce((cur ->> 'current')::boolean, false);
  END IF;
  IF NOT v_current THEN RETURN 'call_evidence_changed'; END IF;
  IF prop.definition_agent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.agent_definition_state d
     WHERE d.shop_id = p_shop AND d.agent_id = prop.definition_agent_id AND d.lifecycle = 'active'
       AND d.active_revision = prop.definition_revision) THEN
    RETURN 'call_definition_inactive';
  END IF;
  IF prop.crm_binding IS NOT NULL THEN
    now_binding := public.call_copilot_customer_binding(p_shop, prop.customer_id,
      ARRAY(SELECT k FROM jsonb_object_keys(prop.crm_binding) k WHERE k <> 'customer_id'));
    IF now_binding IS DISTINCT FROM prop.crm_binding THEN RETURN 'call_crm_state_changed'; END IF;
  END IF;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- One cited span, or a reason it is withheld. Never returns more than the cited span (capped for display), and only
-- when the span's own digest matches what was stored at extraction time.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.call_copilot_review_snippet(
  p_shop uuid, p_call uuid, p_segment uuid, p_start integer, p_end integer, p_digest text, p_state jsonb
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE seg record; q text;
BEGIN
  IF p_start IS NULL OR p_end IS NULL OR p_start < 0 OR p_end <= p_start THEN RETURN jsonb_build_object('state', 'unavailable'); END IF;
  SELECT speaker, started_at, ended_at, text INTO seg
    FROM public.call_copilot_transcript_segments WHERE shop_id = p_shop AND call_id = p_call AND id = p_segment;
  IF NOT FOUND OR p_end > length(seg.text) THEN RETURN jsonb_build_object('state', 'unavailable'); END IF;
  -- The cited segment must lie inside ONE consented captured interval (a span across a gap is never shown).
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_state -> 'intervals') iv
     WHERE (iv ->> 'started_at')::timestamptz <= seg.started_at
       AND (iv ->> 'ended_at' IS NULL OR seg.ended_at <= (iv ->> 'ended_at')::timestamptz)) THEN
    RETURN jsonb_build_object('state', 'span_not_captured');
  END IF;
  q := substr(seg.text, p_start + 1, p_end - p_start);
  IF encode(sha256(convert_to(q, 'UTF8')), 'hex') IS DISTINCT FROM p_digest THEN RETURN jsonb_build_object('state', 'mismatch'); END IF;
  IF public.call_copilot_has_card_number(q) THEN RETURN jsonb_build_object('state', 'redacted'); END IF;
  RETURN jsonb_build_object('state', 'shown', 'snippet', CASE WHEN length(q) > 280 THEN left(q, 279) || '…' ELSE q END);
END $$;

-- ---------------------------------------------------------------------------
-- Review list: bounded, keyset-paginated. Content-free (no transcript, no provider ids, no caller numbers).
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.call_copilot_review_list(
  p_shop uuid, p_limit integer DEFAULT 20, p_before_created timestamptz DEFAULT NULL, p_before_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text; v_limit integer; r record; items jsonb := '[]'::jsonb; n integer := 0; more boolean := false;
  st jsonb; rev record; have_counts boolean; c_total bigint; c_awaiting bigint; c_review_only bigint; c_decided bigint; last_created timestamptz; last_id uuid;
BEGIN
  v_role := public.call_copilot_review_viewer(p_shop);
  IF v_role IS NULL THEN RAISE EXCEPTION 'Call review access unavailable' USING ERRCODE = '42501'; END IF;
  IF (p_before_created IS NULL) <> (p_before_id IS NULL) THEN RAISE EXCEPTION 'Invalid cursor' USING ERRCODE = '22023'; END IF;
  v_limit := least(greatest(coalesce(p_limit, 20), 1), 25);

  FOR r IN
    SELECT c.id, c.created_at FROM public.call_copilot_calls c
     WHERE c.shop_id = p_shop AND (p_before_created IS NULL OR (c.created_at, c.id) < (p_before_created, p_before_id))
     ORDER BY c.created_at DESC, c.id DESC LIMIT v_limit + 1
  LOOP
    n := n + 1;
    IF n > v_limit THEN more := true; EXIT; END IF;
    st := public.call_copilot_capture_state(p_shop, r.id);
    SELECT id, revision, coverage_status INTO rev FROM public.call_copilot_evidence_revisions
     WHERE shop_id = p_shop AND call_id = r.id ORDER BY revision DESC LIMIT 1;
    have_counts := false;
    IF rev.id IS NOT NULL THEN
      SELECT count(*) FILTER (WHERE p.route = 'review_only'),
             count(*) FILTER (WHERE p.route = 'pending_action' AND a.status IN ('pending', 'edit_requested')),
             count(*) FILTER (WHERE p.route = 'pending_action' AND a.status IN ('approved', 'rejected')),
             count(*)
        INTO c_review_only, c_awaiting, c_decided, c_total
        FROM public.call_copilot_proposals p LEFT JOIN public.pending_actions a ON a.shop_id = p.shop_id AND a.id = p.pending_action_id
       WHERE p.shop_id = p_shop AND p.call_id = r.id AND p.evidence_revision_id = rev.id;
      have_counts := true;
    END IF;
    items := items || jsonb_build_array(jsonb_build_object(
      'call_id', r.id, 'created_at', public.call_copilot_ts(r.created_at),
      'capture_status', st ->> 'status', 'capture_reason', st ->> 'reason',
      'call_ended', (st ->> 'call_ended')::boolean, 'outcome_unknown', (st ->> 'outcome_unknown')::boolean,
      'unresolved_gap', (st ->> 'unresolved_gap')::boolean,
      'latest_revision', rev.revision, 'coverage_status', rev.coverage_status,
      'proposals', CASE WHEN NOT have_counts THEN NULL ELSE jsonb_build_object(
        'total', c_total, 'awaiting', c_awaiting, 'review_only', c_review_only, 'decided', c_decided) END));
    last_created := r.created_at; last_id := r.id;
  END LOOP;

  RETURN jsonb_build_object(
    'viewer_role', v_role, 'can_approve', v_role = 'owner', 'items', items,
    'next_cursor', CASE WHEN more THEN jsonb_build_object('created_at', public.call_copilot_ts(last_created), 'id', last_id) END);
END $$;

-- ---------------------------------------------------------------------------
-- Review detail for ONE call (optionally one evidence revision; default the newest). Read-only.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.call_copilot_review_detail(p_shop uuid, p_call uuid, p_revision integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text; v_call public.call_copilot_calls; st jsonb; gate_ok boolean := false; gate_reason text;
  revs jsonb; latest_id uuid; sel public.call_copilot_evidence_revisions; sel_current boolean := false; sel_current_reason text;
  runs jsonb; props jsonb := '[]'::jsonb; p record; a public.pending_actions; fresh text; f jsonb; c jsonb; fields jsonb; cites jsonb;
  snip jsonb; budget integer := 300; can_show boolean; tconf integer; total_props integer; token text; cust_name text;
  seg_count integer;
BEGIN
  v_role := public.call_copilot_review_viewer(p_shop);
  IF v_role IS NULL THEN RAISE EXCEPTION 'Call review access unavailable' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_call FROM public.call_copilot_calls WHERE shop_id = p_shop AND id = p_call;
  IF NOT FOUND THEN RETURN jsonb_build_object('found', false); END IF;

  st := public.call_copilot_capture_state(p_shop, p_call);
  BEGIN
    PERFORM public.call_copilot_assert_capture(p_shop, p_call, 'crm_mutation', NULL);
    gate_ok := true;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS gate_reason = PG_EXCEPTION_DETAIL;
    gate_ok := false; gate_reason := coalesce(nullif(gate_reason, ''), 'capture_not_permitted');
  END;
  SELECT count(*) INTO tconf FROM public.call_copilot_transcript_conflicts WHERE shop_id = p_shop AND call_id = p_call;
  SELECT count(*) INTO seg_count FROM public.call_copilot_transcript_segments WHERE shop_id = p_shop AND call_id = p_call;

  SELECT id INTO latest_id FROM public.call_copilot_evidence_revisions WHERE shop_id = p_shop AND call_id = p_call ORDER BY revision DESC LIMIT 1;
  SELECT * INTO sel FROM public.call_copilot_evidence_revisions
   WHERE shop_id = p_shop AND call_id = p_call AND (p_revision IS NULL OR revision = p_revision)
   ORDER BY revision DESC LIMIT 1;
  IF FOUND THEN
    -- Only the newest revision can still match the call's present evidence: digests are unique per call.
    IF sel.id = latest_id THEN
      f := public.call_copilot_evidence_is_current(p_shop, sel.id);
      sel_current := coalesce((f ->> 'current')::boolean, false);
      sel_current_reason := CASE WHEN sel_current THEN NULL ELSE coalesce(f ->> 'reason', 'evidence_changed') END;
    ELSE
      sel_current_reason := 'evidence_superseded';
    END IF;
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'revision', r.revision, 'created_at', public.call_copilot_ts(r.created_at), 'coverage_status', r.coverage_status,
      'coverage_reasons', to_jsonb(r.coverage_reasons), 'segment_count', r.segment_count, 'declared_final', r.declared_final,
      'expected_segment_count', r.expected_segment_count, 'call_ended', r.call_ended, 'outcome_unknown', r.outcome_unknown,
      'is_latest', r.id = latest_id) ORDER BY r.revision DESC), '[]'::jsonb) INTO revs
    FROM (SELECT * FROM public.call_copilot_evidence_revisions WHERE shop_id = p_shop AND call_id = p_call ORDER BY revision DESC LIMIT 10) r;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'status', x.status, 'failure_code', x.failure_code, 'refused_count', x.refused_count, 'proposal_count', x.proposal_count,
      'extractor', x.extractor_id || '@' || x.extractor_version, 'revision', x.rev_no, 'created_at', public.call_copilot_ts(x.created_at),
      'requested_by_me', x.requested_by = auth.uid(), 'definition_bound', x.definition_agent_id IS NOT NULL) ORDER BY x.created_at DESC, x.id DESC), '[]'::jsonb)
    INTO runs
    FROM (SELECT er.*, ev.revision AS rev_no FROM public.call_copilot_extraction_runs er
            JOIN public.call_copilot_evidence_revisions ev ON ev.shop_id = er.shop_id AND ev.id = er.evidence_revision_id
           WHERE er.shop_id = p_shop AND er.call_id = p_call ORDER BY er.created_at DESC, er.id DESC LIMIT 10) x;

  IF sel.id IS NOT NULL THEN
    SELECT count(*) INTO total_props FROM public.call_copilot_proposals WHERE shop_id = p_shop AND evidence_revision_id = sel.id;
    can_show := gate_ok AND sel_current;
    FOR p IN
      SELECT * FROM public.call_copilot_proposals WHERE shop_id = p_shop AND call_id = p_call AND evidence_revision_id = sel.id
       ORDER BY created_at, id LIMIT 60
    LOOP
      a := NULL;
      IF p.pending_action_id IS NOT NULL THEN
        SELECT * INTO a FROM public.pending_actions WHERE shop_id = p_shop AND id = p.pending_action_id;
      END IF;
      fresh := public.call_copilot_review_freshness(p_shop, p.id, a.payload, gate_ok, sel_current);
      fields := '[]'::jsonb;
      FOR f IN SELECT * FROM jsonb_array_elements(p.fields) LOOP
        cites := '[]'::jsonb;
        FOR c IN SELECT * FROM jsonb_array_elements(f -> 'citations') LOOP
          IF NOT can_show THEN
            snip := jsonb_build_object('state', 'withheld');
          ELSIF budget <= 0 THEN
            snip := jsonb_build_object('state', 'not_loaded');
          ELSE
            budget := budget - 1;
            snip := public.call_copilot_review_snippet(p_shop, p_call, (c ->> 'segment_id')::uuid, (c ->> 'start')::integer,
                                                       (c ->> 'end')::integer, c ->> 'quote_digest', st);
          END IF;
          cites := cites || jsonb_build_array(jsonb_build_object(
            'speaker', c ->> 'speaker', 'at', c ->> 'started_at', 'segment_index', c -> 'segment_index') || snip);
        END LOOP;
        fields := fields || jsonb_build_array(jsonb_build_object(
          'name', f ->> 'name', 'value', f -> 'value', 'confidence', f ->> 'confidence', 'citations', cites));
      END LOOP;
      cust_name := NULL;
      IF p.customer_id IS NOT NULL THEN
        SELECT name INTO cust_name FROM public.customers WHERE shop_id = p_shop AND id = p.customer_id;
      END IF;
      token := encode(sha256(convert_to(concat_ws('|', p.id, coalesce(a.status::text, '-'), coalesce(a.payload::text, '-'),
        coalesce(p.staged_payload::text, '-'), sel.evidence_digest, coalesce(fresh, '-'), (a.result_id IS NOT NULL)::text), 'UTF8')), 'hex');
      props := props || jsonb_build_array(jsonb_build_object(
        'id', p.id, 'kind', p.kind, 'route', p.route, 'action_type', p.action_type, 'action_id', p.pending_action_id, 'review_reason', p.review_reason,
        'confidence', p.confidence, 'ambiguity', public.call_copilot_review_ambiguity(p.ambiguity),
        'created_at', public.call_copilot_ts(p.created_at),
        'set_id', encode(sha256(convert_to(p.evidence_revision_id::text || '|' || p.created_by::text, 'UTF8')), 'hex'),
        'requested_by_me', p.created_by = auth.uid(), 'definition_bound', p.definition_agent_id IS NOT NULL,
        'customer', CASE WHEN p.customer_id IS NULL THEN NULL ELSE jsonb_build_object('id', p.customer_id, 'name', cust_name) END,
        'staged', p.staged_payload,
        'status', CASE WHEN p.route = 'review_only' THEN NULL ELSE a.status::text END,
        'executed', CASE WHEN p.route = 'review_only' THEN NULL ELSE a.result_id IS NOT NULL END,
        'decided_at', CASE WHEN a.id IS NULL THEN NULL ELSE public.call_copilot_ts(a.decided_at) END,
        'freshness', fresh, 'fields', fields, 'review_token', token));
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'found', true, 'viewer_role', v_role, 'can_approve', v_role = 'owner',
    'call', jsonb_build_object('id', v_call.id, 'created_at', public.call_copilot_ts(v_call.created_at)),
    'capture', jsonb_build_object(
      'status', st ->> 'status', 'reason', st ->> 'reason', 'capture_permitted_now', (st ->> 'capture_permitted_now')::boolean,
      'derivation_permitted', (st ->> 'derivation_permitted')::boolean, 'call_ended', (st ->> 'call_ended')::boolean,
      'outcome_unknown', (st ->> 'outcome_unknown')::boolean, 'unresolved_gap', (st ->> 'unresolved_gap')::boolean,
      'conflict_count', (st ->> 'conflict_count')::integer, 'transcript_conflicts', tconf, 'segments_stored', seg_count,
      'intervals', (SELECT coalesce(jsonb_agg(jsonb_build_object('started_at', i ->> 'started_at', 'ended_at', i ->> 'ended_at',
                                                                 'end_reason', i ->> 'end_reason')), '[]'::jsonb)
                      FROM jsonb_array_elements(st -> 'intervals') i),
      'gaps', (SELECT coalesce(jsonb_agg(jsonb_build_object('started_at', g ->> 'started_at', 'ended_at', g ->> 'ended_at',
                                                            'reason', g ->> 'reason')), '[]'::jsonb)
                 FROM jsonb_array_elements(st -> 'gaps') g),
      'review_permitted', gate_ok, 'review_denied_reason', CASE WHEN gate_ok THEN NULL ELSE gate_reason END),
    'evidence', jsonb_build_object(
      'revisions', revs,
      'selected', CASE WHEN sel.id IS NULL THEN NULL ELSE jsonb_build_object(
        'revision', sel.revision, 'is_latest', sel.id = latest_id, 'current', sel_current, 'not_current_reason', sel_current_reason,
        'coverage_status', sel.coverage_status, 'coverage_reasons', to_jsonb(sel.coverage_reasons),
        'segment_count', sel.segment_count, 'declared_final', sel.declared_final,
        'expected_segment_count', sel.expected_segment_count, 'gaps', sel.gaps) END),
    'runs', runs,
    'proposals', props,
    'proposals_total', coalesce(total_props, 0),
    'proposals_truncated', coalesce(total_props, 0) > 60,
    'snippets_withheld', NOT (gate_ok AND sel_current));
END $$;

-- ---------------------------------------------------------------------------
-- ACLs: helpers are callable by no API role; the two readers by `authenticated` only (authority is derived from auth.uid()
-- inside). No table grant of any kind is added.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  public.call_copilot_review_viewer(uuid),
  public.call_copilot_review_ambiguity(jsonb),
  public.call_copilot_review_freshness(uuid, uuid, jsonb, boolean, boolean),
  public.call_copilot_review_snippet(uuid, uuid, uuid, integer, integer, text, jsonb),
  public.call_copilot_review_list(uuid, integer, timestamptz, uuid),
  public.call_copilot_review_detail(uuid, uuid, integer)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.call_copilot_review_list(uuid, integer, timestamptz, uuid),
  public.call_copilot_review_detail(uuid, uuid, integer)
  TO authenticated;

COMMIT;
