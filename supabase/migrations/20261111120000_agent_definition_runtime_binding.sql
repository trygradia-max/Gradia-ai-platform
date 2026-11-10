BEGIN;
-- Build 3: durable runtime binding for governed Agent definitions.
--
-- A governed agent's scheduled run is now bound, in the database and inside the claim
-- transaction, to the EXACT active definition revision, its definition hash, the active
-- policy revision, the pinned reviewed-memory revisions and the newest passing exact-revision
-- evaluation. A claim is refused (no row, typed reasons) when the definition is paused,
-- blocked, pointer-changed, stale (policy / knowledge / memory moved since activation),
-- tampered with, unevaluated, over its own limits, or when a run is already in flight.
--
--  * Legacy agents (no definition state row) keep EXACTLY their existing claim behavior.
--  * No table is rewritten or backfilled. Existing runs keep NULL binding columns.
--  * Binding columns are write-once: they can only be set by the INSERT inside the claim
--    function and can never be changed or retro-fitted onto another row.
--  * `assert_governed_run_current` lets the executor re-verify the binding before each
--    effect; `finish_scheduled_agent_run` records whether the binding was still current when
--    the run finished, so a definition that moved mid-run is visible, never silently
--    "succeeded under the old pointer".
-- The evaluation evidence seam (`agent_definition_record_evaluation`) is unchanged.

-- ---------------------------------------------------------------------------
-- Evidence the run is bound to. Composite foreign keys make a run unable to reference
-- another shop's, agent's, revision's or hash's evidence.
-- ---------------------------------------------------------------------------
ALTER TABLE public.agent_definition_evaluations
  ADD CONSTRAINT agent_definition_evaluations_binding_key
  UNIQUE (id, shop_id, agent_id, revision, definition_hash);

ALTER TABLE public.custom_agent_runs
  ADD COLUMN definition_revision integer,
  ADD COLUMN evaluation_id uuid,
  ADD COLUMN memory_pins jsonb,
  ADD COLUMN state_version integer,
  ADD COLUMN activation_event_seq integer,
  ADD COLUMN binding_at_finish text;

ALTER TABLE public.custom_agent_runs
  ADD CONSTRAINT custom_agent_runs_governed_binding_check
    CHECK (
      definition_revision IS NULL
      OR (
        definition_revision > 0
        AND trigger_source = 'schedule'
        AND evaluation_id IS NOT NULL
        AND memory_pins IS NOT NULL AND jsonb_typeof(memory_pins) = 'array'
        AND state_version IS NOT NULL AND state_version > 0
        AND activation_event_seq IS NOT NULL AND activation_event_seq > 0
        AND definition_hash IS NOT NULL
        AND policy_revision IS NOT NULL
        AND knowledge_revision IS NOT NULL
      )
    ),
  ADD CONSTRAINT custom_agent_runs_binding_none_when_legacy_check
    CHECK (
      definition_revision IS NOT NULL
      OR (evaluation_id IS NULL AND memory_pins IS NULL AND state_version IS NULL
          AND activation_event_seq IS NULL AND binding_at_finish IS NULL)
    ),
  ADD CONSTRAINT custom_agent_runs_binding_at_finish_check
    CHECK (binding_at_finish IS NULL OR length(binding_at_finish) BETWEEN 1 AND 300),
  ADD CONSTRAINT custom_agent_runs_revision_binding_fkey
    FOREIGN KEY (shop_id, agent_id, definition_revision, definition_hash)
    REFERENCES public.agent_definition_revisions(shop_id, agent_id, revision, definition_hash)
    ON DELETE CASCADE,
  ADD CONSTRAINT custom_agent_runs_evaluation_binding_fkey
    FOREIGN KEY (evaluation_id, shop_id, agent_id, definition_revision, definition_hash)
    REFERENCES public.agent_definition_evaluations(id, shop_id, agent_id, revision, definition_hash)
    ON DELETE CASCADE;

CREATE INDEX custom_agent_runs_governed_window_idx
  ON public.custom_agent_runs (agent_id, started_at DESC)
  WHERE definition_revision IS NOT NULL;

-- Binding columns are write-once. The only writer of a governed row is the claim function;
-- `binding_at_finish` may be set once, when the run finishes.
CREATE FUNCTION public.custom_agent_runs_binding_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF (OLD.definition_revision, OLD.definition_hash, OLD.evaluation_id, OLD.memory_pins,
      OLD.state_version, OLD.activation_event_seq, OLD.policy_revision, OLD.knowledge_revision,
      OLD.definition_snapshot, OLD.agent_id, OLD.shop_id)
     IS DISTINCT FROM
     (NEW.definition_revision, NEW.definition_hash, NEW.evaluation_id, NEW.memory_pins,
      NEW.state_version, NEW.activation_event_seq, NEW.policy_revision, NEW.knowledge_revision,
      NEW.definition_snapshot, NEW.agent_id, NEW.shop_id)
     AND (OLD.definition_revision IS NOT NULL OR NEW.definition_revision IS NOT NULL) THEN
    RAISE EXCEPTION 'A run''s definition binding is immutable' USING ERRCODE='42501';
  END IF;
  IF OLD.binding_at_finish IS NOT NULL AND NEW.binding_at_finish IS DISTINCT FROM OLD.binding_at_finish THEN
    RAISE EXCEPTION 'A run''s finish binding is write-once' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER custom_agent_runs_binding_guard
  BEFORE UPDATE ON public.custom_agent_runs
  FOR EACH ROW EXECUTE FUNCTION public.custom_agent_runs_binding_guard();

-- ---------------------------------------------------------------------------
-- The one place every binding question is answered (claim, assert, finish).
-- Returns the DISTINCT sorted reasons the governed definition of `p_agent` is NOT currently
-- runnable; an empty array means current. Optional expectations let a running run detect that
-- its own pointer moved: `p_expected_revision` (the revision it was bound to) and
-- `p_expected_event_seq` (the exact activation it was bound to; a re-activation changes it).
-- Reads only; takes no lock (callers decide).
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.agent_definition_binding_reasons(
  p_agent uuid, p_expected_revision integer, p_expected_event_seq integer
) RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  c_pass constant numeric := 0.95;
  st public.agent_definition_state;
  rev public.agent_definition_revisions;
  ev public.agent_definition_events;
  ev_eval public.agent_definition_evaluations;
  v_reasons text[] := ARRAY[]::text[];
  v_policy integer;
  v_head integer;
  pin record;
  cur record;
BEGIN
  SELECT * INTO st FROM public.agent_definition_state WHERE agent_id = p_agent;
  IF NOT FOUND THEN RETURN ARRAY['definition_not_found']; END IF;
  IF st.lifecycle = 'paused' THEN RETURN ARRAY['paused']; END IF;
  IF st.lifecycle = 'blocked' THEN RETURN ARRAY['blocked']; END IF;
  IF st.lifecycle <> 'active' OR st.active_revision IS NULL THEN RETURN ARRAY['not_active']; END IF;
  IF p_expected_revision IS NOT NULL AND st.active_revision <> p_expected_revision THEN
    RETURN ARRAY['pointer_changed'];
  END IF;

  SELECT * INTO rev FROM public.agent_definition_revisions
   WHERE agent_id = p_agent AND revision = st.active_revision;
  IF NOT FOUND THEN RETURN ARRAY['revision_not_found']; END IF;
  IF rev.schema_version <> 1 THEN RETURN ARRAY['unsupported_schema']; END IF;
  -- The stored document must still hash to the stored hash (defense in depth; the table is
  -- append-only, so a mismatch means out-of-band tampering).
  IF encode(sha256(convert_to(rev.definition::text, 'UTF8')), 'hex') <> rev.definition_hash THEN
    RETURN ARRAY['definition_tampered'];
  END IF;

  -- The exact activation the pointer currently rests on.
  SELECT * INTO ev FROM public.agent_definition_events
   WHERE agent_id = p_agent AND kind = 'activated' AND revision = st.active_revision
   ORDER BY seq DESC LIMIT 1;
  IF NOT FOUND THEN RETURN ARRAY['activation_evidence_missing']; END IF;
  IF p_expected_event_seq IS NOT NULL AND ev.seq <> p_expected_event_seq THEN
    RETURN ARRAY['pointer_changed'];
  END IF;

  -- Policy: must still be the active revision the activation was evaluated under.
  SELECT revision INTO v_policy FROM public.control_policy_active WHERE shop_id = st.shop_id;
  IF v_policy IS NULL THEN v_reasons := array_append(v_reasons, 'policy_unavailable');
  ELSIF v_policy IS DISTINCT FROM (ev.evidence ->> 'policy_revision')::integer THEN
    v_reasons := array_append(v_reasons, 'policy_changed');
  END IF;

  -- Knowledge head must be what the activation compiled against.
  SELECT revision INTO v_head FROM public.reviewed_memory_heads WHERE shop_id = st.shop_id;
  IF coalesce(v_head, 1) IS DISTINCT FROM (ev.evidence ->> 'knowledge_revision')::integer THEN
    v_reasons := array_append(v_reasons, 'knowledge_changed');
  END IF;

  -- Every pinned memory revision must still be the active, published, current one.
  FOR pin IN SELECT * FROM public.agent_definition_memory_pins WHERE agent_id = p_agent AND revision = st.active_revision LOOP
    SELECT a.revision AS active_revision, r.state, r.content_hash, r.valid_from, r.valid_until, r.retention_until
      INTO cur
      FROM public.reviewed_memory_revisions r
      LEFT JOIN public.reviewed_memory_active a
        ON a.shop_id = r.shop_id AND a.source_id = r.source_id
     WHERE r.shop_id = st.shop_id AND r.source_id = pin.source_id AND r.revision = pin.memory_revision;
    IF NOT FOUND OR cur.state IN ('revoked', 'deleted') THEN
      v_reasons := array_append(v_reasons, 'memory_revoked');
    ELSIF cur.state <> 'published' OR cur.content_hash <> pin.content_hash THEN
      v_reasons := array_append(v_reasons, 'memory_changed');
    ELSIF cur.active_revision IS DISTINCT FROM pin.memory_revision THEN
      v_reasons := array_append(v_reasons, 'memory_stale');
    ELSIF cur.valid_from > clock_timestamp()
       OR (cur.valid_until IS NOT NULL AND cur.valid_until <= clock_timestamp())
       OR (cur.retention_until IS NOT NULL AND cur.retention_until <= clock_timestamp()) THEN
      v_reasons := array_append(v_reasons, 'memory_expired');
    END IF;
  END LOOP;

  -- The newest exact-revision evaluation must exist and still pass.
  SELECT * INTO ev_eval FROM public.agent_definition_evaluations
   WHERE agent_id = p_agent AND revision = st.active_revision
   ORDER BY completed_at DESC, recorded_at DESC LIMIT 1;
  IF NOT FOUND THEN v_reasons := array_append(v_reasons, 'evaluation_required');
  ELSE
    IF NOT ev_eval.safety_passed THEN v_reasons := array_append(v_reasons, 'safety_evaluation_failed'); END IF;
    IF ev_eval.pass_rate < c_pass THEN v_reasons := array_append(v_reasons, 'quality_evaluation_failed'); END IF;
  END IF;

  RETURN ARRAY(SELECT DISTINCT r FROM unnest(v_reasons) AS r ORDER BY r);
END $$;

-- ---------------------------------------------------------------------------
-- Claim: re-declared from 20261107120000 with the governed binding added.
-- The legacy path (no state row) is byte-for-byte the previous behavior.
-- New outcome for governed agents: {outcome:'refused', reasons:[...]} (no row is written, so a
-- window refused today can still be claimed after the owner fixes the cause).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_scheduled_agent_run(
  p_agent uuid,
  p_trigger_key text,
  p_worker uuid,
  p_lease_seconds integer DEFAULT 120
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_agent public.custom_agents;
  v_run public.custom_agent_runs;
  v_policy_revision integer;
  v_hash text;
  st public.agent_definition_state;
  rev public.agent_definition_revisions;
  ev public.agent_definition_events;
  ev_eval public.agent_definition_evaluations;
  v_reasons text[];
  v_head integer;
  v_pins jsonb;
  v_governed boolean;
  v_in_flight integer;
  v_today integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Scheduled agent worker unavailable' USING ERRCODE = '42501';
  END IF;
  IF p_agent IS NULL OR p_worker IS NULL OR p_trigger_key IS NULL
     OR length(btrim(p_trigger_key)) NOT BETWEEN 1 AND 160
     OR p_trigger_key IS DISTINCT FROM btrim(p_trigger_key)
     OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 900 THEN
    RAISE EXCEPTION 'Invalid scheduled agent claim' USING ERRCODE = '22023';
  END IF;

  -- Serialize claims with agent edits/enabled changes for this short transaction.
  SELECT * INTO v_agent
  FROM public.custom_agents
  WHERE id = p_agent
  FOR UPDATE;

  IF v_agent.id IS NULL OR v_agent.enabled IS DISTINCT FROM true THEN
    RETURN jsonb_build_object('outcome', 'agent_unavailable');
  END IF;

  -- Governed agents run only while their definition pointer is active. Paused,
  -- blocked or pointer-less definitions never create a new claim. Lock order everywhere
  -- is agent row, then state row.
  SELECT * INTO st FROM public.agent_definition_state WHERE agent_id = v_agent.id FOR SHARE;
  v_governed := FOUND;
  IF v_governed AND (st.lifecycle <> 'active' OR st.active_revision IS NULL) THEN
    RETURN jsonb_build_object('outcome', 'agent_unavailable');
  END IF;

  SELECT * INTO v_run
  FROM public.custom_agent_runs
  WHERE agent_id = v_agent.id
    AND trigger_source = 'schedule'
    AND trigger_key = p_trigger_key
  FOR UPDATE;

  IF v_run.id IS NOT NULL THEN
    IF v_run.state = 'running' AND v_run.lease_expires_at <= clock_timestamp() THEN
      UPDATE public.custom_agent_runs
      SET state = 'unknown',
          fired = false,
          reason = 'Scheduled worker lease expired; reconcile before retrying.',
          wait_reason = 'reconciliation_required',
          error_code = 'lease_expired',
          finished_at = clock_timestamp(),
          lease_expires_at = NULL
      WHERE id = v_run.id;
      RETURN jsonb_build_object(
        'outcome', 'unknown',
        'run_id', v_run.id,
        'attempt', v_run.attempt
      );
    END IF;
    IF v_run.state = 'running' THEN
      RETURN jsonb_build_object(
        'outcome', 'active_duplicate',
        'run_id', v_run.id,
        'attempt', v_run.attempt
      );
    END IF;
    RETURN jsonb_build_object(
      'outcome', 'terminal_duplicate',
      'run_id', v_run.id,
      'attempt', v_run.attempt,
      'state', v_run.state
    );
  END IF;

  IF v_governed THEN
    -- Everything the run will be bound to is decided HERE, under the agent lock.
    v_reasons := public.agent_definition_binding_reasons(v_agent.id, NULL, NULL);
    SELECT * INTO rev FROM public.agent_definition_revisions
     WHERE agent_id = v_agent.id AND revision = st.active_revision;
    IF cardinality(v_reasons) = 0 AND (rev.definition #>> '{schedule,kind}') IS DISTINCT FROM 'interval' THEN
      v_reasons := array_append(v_reasons, 'schedule_not_interval');
    END IF;

    IF cardinality(v_reasons) = 0 THEN
      -- A previous attempt whose lease expired is an unknown outcome, never a free slot.
      UPDATE public.custom_agent_runs
         SET state = 'unknown', fired = false,
             reason = 'Scheduled worker lease expired; reconcile before retrying.',
             wait_reason = 'reconciliation_required', error_code = 'lease_expired',
             finished_at = clock_timestamp(), lease_expires_at = NULL
       WHERE agent_id = v_agent.id AND state = 'running' AND lease_expires_at <= clock_timestamp();
      SELECT count(*)::integer INTO v_in_flight FROM public.custom_agent_runs
       WHERE agent_id = v_agent.id AND state = 'running';
      IF v_in_flight >= (rev.definition #>> '{limits,maximumConcurrentRuns}')::integer THEN
        v_reasons := array_append(v_reasons, 'concurrent_run_active');
      END IF;
      SELECT count(*)::integer INTO v_today FROM public.custom_agent_runs
       WHERE agent_id = v_agent.id AND definition_revision IS NOT NULL
         AND state IN ('running', 'succeeded', 'failed', 'unknown')
         AND started_at > clock_timestamp() - interval '24 hours';
      IF v_today >= (rev.definition #>> '{limits,maximumRunsPerDay}')::integer THEN
        v_reasons := array_append(v_reasons, 'daily_limit_reached');
      END IF;
    END IF;

    IF cardinality(v_reasons) > 0 THEN
      RETURN jsonb_build_object('outcome', 'refused', 'reasons', to_jsonb(v_reasons));
    END IF;

    SELECT * INTO ev FROM public.agent_definition_events
     WHERE agent_id = v_agent.id AND kind = 'activated' AND revision = st.active_revision
     ORDER BY seq DESC LIMIT 1;
    SELECT * INTO ev_eval FROM public.agent_definition_evaluations
     WHERE agent_id = v_agent.id AND revision = st.active_revision
     ORDER BY completed_at DESC, recorded_at DESC LIMIT 1;
    SELECT revision INTO v_policy_revision FROM public.control_policy_active WHERE shop_id = v_agent.shop_id;
    SELECT revision INTO v_head FROM public.reviewed_memory_heads WHERE shop_id = v_agent.shop_id;
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'source_id', p.source_id, 'memory_revision', p.memory_revision, 'content_hash', p.content_hash)
             ORDER BY p.source_id), '[]'::jsonb)
      INTO v_pins
      FROM public.agent_definition_memory_pins p
     WHERE p.agent_id = v_agent.id AND p.revision = st.active_revision;

    INSERT INTO public.custom_agent_runs (
      agent_id, shop_id, trigger_source, trigger_key, fired, state, attempt, worker_id,
      lease_expires_at, started_at, definition_snapshot, definition_hash, policy_revision,
      knowledge_revision, definition_revision, evaluation_id, memory_pins, state_version,
      activation_event_seq
    ) VALUES (
      v_agent.id, v_agent.shop_id, 'schedule', p_trigger_key, false, 'running', 1, p_worker,
      clock_timestamp() + make_interval(secs => p_lease_seconds), clock_timestamp(),
      rev.definition, rev.definition_hash, v_policy_revision,
      coalesce(v_head, 1), rev.revision, ev_eval.id, v_pins, st.version, ev.seq
    )
    RETURNING * INTO v_run;

    RETURN jsonb_build_object(
      'outcome', 'claimed',
      'run_id', v_run.id,
      'attempt', v_run.attempt,
      'shop_id', v_run.shop_id,
      'definition_snapshot', v_run.definition_snapshot,
      'definition_hash', v_run.definition_hash,
      'policy_revision', v_run.policy_revision,
      'knowledge_revision', v_run.knowledge_revision,
      'governed', true,
      'definition_revision', v_run.definition_revision,
      'evaluation_id', v_run.evaluation_id,
      'memory_pins', v_run.memory_pins,
      'activation_event_seq', v_run.activation_event_seq
    );
  END IF;

  SELECT revision INTO v_policy_revision
  FROM public.control_policy_active
  WHERE shop_id = v_agent.shop_id;

  v_hash := encode(
    sha256(convert_to(v_agent.config::text, 'UTF8')),
    'hex'
  );

  INSERT INTO public.custom_agent_runs (
    agent_id,
    shop_id,
    trigger_source,
    trigger_key,
    fired,
    state,
    attempt,
    worker_id,
    lease_expires_at,
    started_at,
    definition_snapshot,
    definition_hash,
    policy_revision
  ) VALUES (
    v_agent.id,
    v_agent.shop_id,
    'schedule',
    p_trigger_key,
    false,
    'running',
    1,
    p_worker,
    clock_timestamp() + make_interval(secs => p_lease_seconds),
    clock_timestamp(),
    v_agent.config,
    v_hash,
    v_policy_revision
  )
  RETURNING * INTO v_run;

  RETURN jsonb_build_object(
    'outcome', 'claimed',
    'run_id', v_run.id,
    'attempt', v_run.attempt,
    'shop_id', v_run.shop_id,
    'definition_snapshot', v_run.definition_snapshot,
    'definition_hash', v_run.definition_hash,
    'policy_revision', v_run.policy_revision,
    'knowledge_revision', v_run.knowledge_revision
  );
END $$;

-- ---------------------------------------------------------------------------
-- Re-verify a running governed run's binding before an effect.
-- Result: {current: boolean, reasons: text[]}. `current` is true only for a RUNNING run of
-- this worker and attempt whose lease is unexpired and whose binding still holds. Legacy runs
-- (no binding) are reported {current:true, reasons:[], governed:false} so the executor can call
-- it unconditionally. Takes the agent row FOR SHARE (waits for an in-flight pause / block /
-- activation commit, never blocks other checks) and no run lock, so it cannot invert the
-- agent -> run lock order used by claim and activation.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.assert_governed_run_current(
  p_run uuid, p_worker uuid, p_attempt integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_run public.custom_agent_runs;
  v_enabled boolean;
  v_reasons text[];
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Scheduled agent worker unavailable' USING ERRCODE = '42501';
  END IF;
  IF p_run IS NULL OR p_worker IS NULL OR p_attempt IS NULL OR p_attempt < 1 THEN
    RAISE EXCEPTION 'Invalid governed run check' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_run FROM public.custom_agent_runs WHERE id = p_run;
  IF NOT FOUND OR v_run.trigger_source <> 'schedule' THEN
    RETURN jsonb_build_object('current', false, 'governed', false, 'reasons', jsonb_build_array('run_not_found'));
  END IF;
  IF v_run.definition_revision IS NULL THEN
    RETURN jsonb_build_object('current', true, 'governed', false, 'reasons', '[]'::jsonb);
  END IF;
  IF v_run.state <> 'running' OR v_run.worker_id IS DISTINCT FROM p_worker
     OR v_run.attempt IS DISTINCT FROM p_attempt OR v_run.lease_expires_at <= clock_timestamp() THEN
    RETURN jsonb_build_object('current', false, 'governed', true, 'reasons', jsonb_build_array('run_not_owned'));
  END IF;
  SELECT enabled INTO v_enabled FROM public.custom_agents
   WHERE id = v_run.agent_id AND shop_id = v_run.shop_id FOR SHARE;
  IF NOT FOUND OR v_enabled IS DISTINCT FROM true THEN
    RETURN jsonb_build_object('current', false, 'governed', true, 'reasons', jsonb_build_array('agent_disabled'));
  END IF;
  v_reasons := public.agent_definition_binding_reasons(v_run.agent_id, v_run.definition_revision, v_run.activation_event_seq);
  RETURN jsonb_build_object('current', cardinality(v_reasons) = 0, 'governed', true, 'reasons', to_jsonb(v_reasons));
END $$;

-- ---------------------------------------------------------------------------
-- Finish: re-declared from 20261029120000 with one addition. For a governed run the
-- result is recorded exactly as reported (an effect may already have been staged), and the
-- binding's state at that moment is written once to `binding_at_finish`
-- ('current' or the comma-joined reasons). It takes no agent lock (run -> agent would invert
-- the claim's agent -> run order).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finish_scheduled_agent_run(
  p_run uuid,
  p_worker uuid,
  p_attempt integer,
  p_state text,
  p_fired boolean,
  p_reason text DEFAULT NULL,
  p_stats jsonb DEFAULT NULL,
  p_pending_action_ids uuid[] DEFAULT ARRAY[]::uuid[],
  p_error_code text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_run public.custom_agent_runs;
  v_pending_count integer;
  v_binding text;
  v_enabled boolean;
  v_reasons text[];
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Scheduled agent worker unavailable' USING ERRCODE = '42501';
  END IF;
  IF p_run IS NULL OR p_worker IS NULL OR p_attempt IS NULL OR p_attempt < 1
     OR p_state IS NULL OR p_state NOT IN ('succeeded', 'skipped', 'failed')
     OR p_fired IS NULL
     OR (p_state = 'succeeded' AND p_fired IS DISTINCT FROM true)
     OR (p_state <> 'succeeded' AND p_fired IS DISTINCT FROM false)
     OR (p_reason IS NOT NULL AND length(p_reason) > 1000)
     OR (p_error_code IS NOT NULL AND length(p_error_code) NOT BETWEEN 1 AND 80)
     OR p_pending_action_ids IS NULL THEN
    RAISE EXCEPTION 'Invalid scheduled agent result' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_run
  FROM public.custom_agent_runs
  WHERE id = p_run
  FOR UPDATE;

  IF v_run.id IS NULL
     OR v_run.trigger_source <> 'schedule'
     OR v_run.state <> 'running'
     OR v_run.worker_id IS DISTINCT FROM p_worker
     OR v_run.attempt IS DISTINCT FROM p_attempt
     OR v_run.lease_expires_at <= clock_timestamp() THEN
    RETURN false;
  END IF;

  SELECT count(*)::integer INTO v_pending_count
  FROM public.pending_actions
  WHERE shop_id = v_run.shop_id
    AND id = ANY(p_pending_action_ids);
  IF v_pending_count IS DISTINCT FROM cardinality(p_pending_action_ids) THEN
    RAISE EXCEPTION 'Scheduled agent result references unavailable actions'
      USING ERRCODE = '42501';
  END IF;

  IF v_run.definition_revision IS NOT NULL THEN
    SELECT enabled INTO v_enabled FROM public.custom_agents WHERE id = v_run.agent_id AND shop_id = v_run.shop_id;
    IF v_enabled IS DISTINCT FROM true THEN
      v_binding := 'agent_disabled';
    ELSE
      v_reasons := public.agent_definition_binding_reasons(v_run.agent_id, v_run.definition_revision, v_run.activation_event_seq);
      v_binding := CASE WHEN cardinality(v_reasons) = 0 THEN 'current' ELSE array_to_string(v_reasons, ',') END;
    END IF;
  END IF;

  UPDATE public.custom_agent_runs
  SET state = p_state,
      fired = p_fired,
      reason = p_reason,
      stats = p_stats,
      pending_action_ids = p_pending_action_ids,
      error_code = p_error_code,
      wait_reason = NULL,
      lease_expires_at = NULL,
      finished_at = clock_timestamp(),
      binding_at_finish = left(v_binding, 300)
  WHERE id = v_run.id;
  RETURN true;
END $$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  public.custom_agent_runs_binding_guard(),
  public.agent_definition_binding_reasons(uuid, integer, integer),
  public.assert_governed_run_current(uuid, uuid, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assert_governed_run_current(uuid, uuid, integer) TO service_role;
-- Re-declaration keeps the existing grants; restate them so the end state is explicit.
REVOKE ALL ON FUNCTION public.claim_scheduled_agent_run(uuid, text, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_scheduled_agent_run(uuid, uuid, integer, text, boolean, text, jsonb, uuid[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_scheduled_agent_run(uuid, text, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_scheduled_agent_run(uuid, uuid, integer, text, boolean, text, jsonb, uuid[], text) TO service_role;

COMMIT;
