BEGIN;

-- L1: make the existing scheduled custom-agent executor claim a durable run
-- before it performs recipe work. This extends custom_agent_runs; it does not
-- add another scheduler or action executor. An expired lease becomes unknown
-- and requires reconciliation because the previous worker may already have
-- staged pending_actions.

ALTER TABLE public.custom_agent_runs
  ADD COLUMN trigger_key text,
  ADD COLUMN state text,
  ADD COLUMN attempt integer,
  ADD COLUMN worker_id uuid,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN started_at timestamptz,
  ADD COLUMN finished_at timestamptz,
  ADD COLUMN definition_snapshot jsonb,
  ADD COLUMN definition_hash text,
  ADD COLUMN policy_revision integer,
  ADD COLUMN knowledge_revision integer,
  ADD COLUMN wait_reason text,
  ADD COLUMN error_code text;

UPDATE public.custom_agent_runs
SET state = CASE WHEN fired THEN 'succeeded' ELSE 'skipped' END,
    attempt = 1,
    started_at = created_at,
    finished_at = created_at;

ALTER TABLE public.custom_agent_runs
  ALTER COLUMN state SET NOT NULL,
  ALTER COLUMN state SET DEFAULT 'skipped',
  ALTER COLUMN attempt SET NOT NULL,
  ALTER COLUMN attempt SET DEFAULT 1,
  ADD CONSTRAINT custom_agent_runs_state_check
    CHECK (state IN ('running', 'succeeded', 'skipped', 'failed', 'unknown')),
  ADD CONSTRAINT custom_agent_runs_attempt_check CHECK (attempt > 0),
  ADD CONSTRAINT custom_agent_runs_trigger_key_check
    CHECK (trigger_key IS NULL OR length(trigger_key) BETWEEN 1 AND 160),
  ADD CONSTRAINT custom_agent_runs_definition_hash_check
    CHECK (definition_hash IS NULL OR definition_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT custom_agent_runs_policy_revision_check
    CHECK (policy_revision IS NULL OR policy_revision > 0),
  ADD CONSTRAINT custom_agent_runs_knowledge_revision_check
    CHECK (knowledge_revision IS NULL OR knowledge_revision > 0),
  ADD CONSTRAINT custom_agent_runs_error_code_check
    CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 80),
  ADD CONSTRAINT custom_agent_runs_wait_reason_check
    CHECK (wait_reason IS NULL OR length(wait_reason) BETWEEN 1 AND 160),
  ADD CONSTRAINT custom_agent_runs_running_shape_check
    CHECK (
      state <> 'running'
      OR (
        trigger_source = 'schedule'
        AND trigger_key IS NOT NULL
        AND worker_id IS NOT NULL
        AND lease_expires_at IS NOT NULL
        AND started_at IS NOT NULL
        AND finished_at IS NULL
        AND definition_snapshot IS NOT NULL
        AND definition_hash IS NOT NULL
      )
    );

CREATE UNIQUE INDEX custom_agent_runs_schedule_window_unique
  ON public.custom_agent_runs (agent_id, trigger_source, trigger_key)
  WHERE trigger_source = 'schedule' AND trigger_key IS NOT NULL;

CREATE INDEX custom_agent_runs_running_lease_idx
  ON public.custom_agent_runs (lease_expires_at, id)
  WHERE state = 'running';

-- Owners retain read access and the existing manual/event history insert path,
-- but cannot forge scheduled claims or mutate durable outcomes. Service clients
-- still bypass RLS; scheduled execution must use the RPCs below.
DROP POLICY IF EXISTS custom_agent_runs_tenant_isolation ON public.custom_agent_runs;
CREATE POLICY custom_agent_runs_owner_read ON public.custom_agent_runs
  FOR SELECT TO authenticated
  USING (
    shop_id IN (
      SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid())
    )
  );
CREATE POLICY custom_agent_runs_owner_history_insert ON public.custom_agent_runs
  FOR INSERT TO authenticated
  WITH CHECK (
    shop_id IN (
      SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid())
    )
    AND trigger_source <> 'schedule'
    AND trigger_key IS NULL
    AND state IN ('succeeded', 'skipped', 'failed')
    AND attempt = 1
    AND worker_id IS NULL
    AND lease_expires_at IS NULL
  );

REVOKE ALL ON public.custom_agent_runs FROM anon;
REVOKE UPDATE, DELETE, TRUNCATE ON public.custom_agent_runs FROM authenticated;
GRANT SELECT, INSERT ON public.custom_agent_runs TO authenticated;

CREATE FUNCTION public.claim_scheduled_agent_run(
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

CREATE FUNCTION public.finish_scheduled_agent_run(
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

  UPDATE public.custom_agent_runs
  SET state = p_state,
      fired = p_fired,
      reason = p_reason,
      stats = p_stats,
      pending_action_ids = p_pending_action_ids,
      error_code = p_error_code,
      wait_reason = NULL,
      lease_expires_at = NULL,
      finished_at = clock_timestamp()
  WHERE id = v_run.id;
  RETURN true;
END $$;

CREATE FUNCTION public.mark_scheduled_agent_run_unknown(
  p_run uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Scheduled agent worker unavailable' USING ERRCODE = '42501';
  END IF;
  UPDATE public.custom_agent_runs
  SET state = 'unknown',
      fired = false,
      reason = 'Scheduled worker lease expired; reconcile before retrying.',
      wait_reason = 'reconciliation_required',
      error_code = 'lease_expired',
      finished_at = clock_timestamp(),
      lease_expires_at = NULL
  WHERE id = p_run
    AND trigger_source = 'schedule'
    AND state = 'running'
    AND lease_expires_at <= clock_timestamp()
  RETURNING id INTO v_id;
  RETURN v_id IS NOT NULL;
END $$;

REVOKE ALL ON FUNCTION public.claim_scheduled_agent_run(uuid, text, uuid, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_scheduled_agent_run(uuid, uuid, integer, text, boolean, text, jsonb, uuid[], text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_scheduled_agent_run_unknown(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_scheduled_agent_run(uuid, text, uuid, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_scheduled_agent_run(uuid, uuid, integer, text, boolean, text, jsonb, uuid[], text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_scheduled_agent_run_unknown(uuid)
  TO service_role;

COMMIT;
