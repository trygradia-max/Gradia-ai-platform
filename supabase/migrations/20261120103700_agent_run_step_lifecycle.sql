BEGIN;
-- PR C: complete the governed (selected-playbook) durable run lifecycle.
--
-- This EXTENDS the merged scheduled-run claim (`claim_scheduled_agent_run`,
-- `finish_scheduled_agent_run`, `custom_agent_runs`). It adds no scheduler and no second executor:
-- a run is still claimed once per (agent, window) and a worker still owns it through the same
-- (worker_id, attempt, lease) compare-and-set. New here, all in the database:
--
--   * steps, stable commands and attempts (`agent_run_steps`, `agent_run_commands`,
--     `agent_run_attempts`) with write-ahead attempt evidence: an attempt is durable BEFORE the
--     provider is called, so a crashed worker leaves a `started` attempt that recovery turns into
--     `unknown` (never into a retry);
--   * heartbeats and stale-lease recovery that classify a dead worker by its evidence;
--   * explicit pause / cancel / kill REQUEST and ACKNOWLEDGEMENT, distinct from each other and
--     from provider-level cancellation;
--   * one open wait per run (`agent_run_waits`) with reason, due time, owner, escalation and
--     typed links, including the reconciliation wait for an unknown outcome;
--   * a pre-effect gate (`begin_agent_command_attempt`) that re-verifies binding, grants, budget,
--     approval and recorded policy/consent/readiness evidence in the same transaction that
--     starts the attempt;
--   * an append-only event ledger (`agent_run_events`).
--
-- Compatibility: legacy runs (no definition binding) keep EXACTLY their claim / finish / unknown
-- behavior. No existing row is rewritten (only nullable columns are added); historical runs have no
-- steps, commands, attempts, waits or events.
--
-- Truthfulness: `unknown` = at least one external attempt has no confirmed outcome (needs a human
-- reconciliation); `failed` = stopped with a known state; `cancelled` / `killed` = a stop request was
-- acknowledged. An expired lease is never proof that the provider stopped, and an unknown outcome is
-- never retried automatically.

-- ---------------------------------------------------------------------------
-- 1. The run row
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX custom_agent_runs_id_shop_unique ON public.custom_agent_runs (id, shop_id);

ALTER TABLE public.custom_agent_runs
  ADD COLUMN last_heartbeat_at timestamptz,
  ADD COLUMN lease_started_at timestamptz,
  ADD COLUMN control_request text,
  ADD COLUMN control_requested_at timestamptz,
  ADD COLUMN control_requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN control_reason text,
  ADD COLUMN control_acked_at timestamptz,
  ADD COLUMN control_acked_by text;

ALTER TABLE public.custom_agent_runs DROP CONSTRAINT custom_agent_runs_state_check;
ALTER TABLE public.custom_agent_runs
  ADD CONSTRAINT custom_agent_runs_state_check
    CHECK (state IN ('running', 'waiting', 'paused', 'succeeded', 'skipped', 'failed', 'unknown', 'cancelled', 'killed')),
  ADD CONSTRAINT custom_agent_runs_control_request_check
    CHECK (control_request IS NULL OR control_request IN ('pause', 'cancel', 'kill')),
  ADD CONSTRAINT custom_agent_runs_control_acked_by_check
    CHECK (control_acked_by IS NULL OR control_acked_by IN ('worker', 'recovery', 'database', 'reconciliation')),
  ADD CONSTRAINT custom_agent_runs_control_reason_check
    CHECK (control_reason IS NULL OR length(control_reason) BETWEEN 1 AND 200),
  ADD CONSTRAINT custom_agent_runs_control_shape_check
    CHECK (
      (control_request IS NULL AND control_requested_at IS NULL AND control_acked_at IS NULL AND control_acked_by IS NULL)
      OR (control_request IS NOT NULL AND control_requested_at IS NOT NULL
          AND (control_acked_at IS NULL) = (control_acked_by IS NULL))
    ),
  -- Only a governed (bound) run can wait, pause, be cancelled or be killed; legacy rows never do.
  ADD CONSTRAINT custom_agent_runs_governed_states_check
    CHECK (state NOT IN ('waiting', 'paused', 'cancelled', 'killed') OR definition_revision IS NOT NULL),
  ADD CONSTRAINT custom_agent_runs_open_shape_check
    CHECK (state NOT IN ('waiting', 'paused') OR (lease_expires_at IS NULL AND finished_at IS NULL)),
  ADD CONSTRAINT custom_agent_runs_stopped_shape_check
    CHECK (state NOT IN ('cancelled', 'killed') OR (lease_expires_at IS NULL AND finished_at IS NOT NULL
           AND control_request IS NOT NULL AND control_acked_at IS NOT NULL));

CREATE INDEX custom_agent_runs_open_governed_idx
  ON public.custom_agent_runs (agent_id, started_at)
  WHERE state IN ('waiting', 'paused');

-- ---------------------------------------------------------------------------
-- 2. Steps, commands, attempts, waits, events
-- ---------------------------------------------------------------------------
CREATE TABLE public.agent_run_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  run_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  step_key text NOT NULL CHECK (step_key ~ '^[a-z][a-z0-9_.:-]{0,79}$'),
  kind text NOT NULL CHECK (kind IN ('read', 'effect', 'wait', 'decision')),
  state text NOT NULL CHECK (state IN ('running', 'waiting', 'succeeded', 'failed', 'skipped', 'abandoned')),
  run_attempt integer NOT NULL CHECK (run_attempt > 0),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  outcome_code text CHECK (outcome_code IS NULL OR length(outcome_code) BETWEEN 1 AND 80),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(evidence) = 'object' AND octet_length(evidence::text) <= 4096),
  UNIQUE (run_id, step_key),
  UNIQUE (run_id, ordinal),
  UNIQUE (id, shop_id),
  FOREIGN KEY (run_id, shop_id) REFERENCES public.custom_agent_runs (id, shop_id) ON DELETE CASCADE
);

CREATE TABLE public.agent_run_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  run_id uuid NOT NULL,
  step_id uuid NOT NULL,
  command_key text NOT NULL CHECK (command_key ~ '^[a-z0-9][a-z0-9_.:/-]{0,119}$'),
  operation text NOT NULL CHECK (length(operation) BETWEEN 3 AND 60),
  intent text NOT NULL CHECK (intent IN ('stage', 'execute')),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  -- Derived once, never accepted from the caller: the same value is handed to the provider on every
  -- attempt so provider-side de-duplication applies to a retry after a confirmed non-effect.
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  dedupe_key text CHECK (dedupe_key IS NULL OR length(dedupe_key) BETWEEN 1 AND 160),
  credits_estimate integer NOT NULL DEFAULT 0 CHECK (credits_estimate >= 0),
  approval_required boolean NOT NULL DEFAULT false,
  pending_action_id uuid,
  approval_payload_hash text CHECK (approval_payload_hash IS NULL OR approval_payload_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'in_flight', 'succeeded', 'failed_before_effect', 'unknown', 'cancelled')),
  attempts_started integer NOT NULL DEFAULT 0 CHECK (attempts_started >= 0),
  provider_ref text CHECK (provider_ref IS NULL OR length(provider_ref) BETWEEN 1 AND 200),
  resolution text CHECK (resolution IS NULL OR resolution IN ('effect_confirmed', 'no_effect_confirmed', 'cannot_determine')),
  resolved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  CHECK (NOT approval_required OR intent = 'execute'),
  CHECK (NOT approval_required OR approval_payload_hash IS NOT NULL OR pending_action_id IS NULL),
  UNIQUE (run_id, command_key),
  UNIQUE (id, shop_id),
  FOREIGN KEY (run_id, shop_id) REFERENCES public.custom_agent_runs (id, shop_id) ON DELETE CASCADE,
  FOREIGN KEY (step_id, shop_id) REFERENCES public.agent_run_steps (id, shop_id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, agent_id) REFERENCES public.custom_agents (shop_id, id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, pending_action_id) REFERENCES public.pending_actions (shop_id, id)
    ON DELETE SET NULL (pending_action_id)
);

-- One live command per business-object key per agent across runs: a second run (or a replayed window)
-- cannot schedule the same effect while the first is pending, in flight, done or unknown.
CREATE UNIQUE INDEX agent_run_commands_dedupe_unique
  ON public.agent_run_commands (shop_id, agent_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND state IN ('pending', 'in_flight', 'succeeded', 'unknown');

CREATE TABLE public.agent_run_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  run_id uuid NOT NULL,
  command_id uuid NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  run_attempt integer NOT NULL CHECK (run_attempt > 0),
  worker_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('refused', 'started', 'succeeded', 'rejected', 'unknown', 'confirmed_effect', 'confirmed_no_effect')),
  -- Pre-effect recheck evidence exactly as it was when the attempt was admitted or refused.
  checks jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(checks) = 'array' AND octet_length(checks::text) <= 4096),
  refusal_reasons text[] NOT NULL DEFAULT ARRAY[]::text[],
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  provider_ref text CHECK (provider_ref IS NULL OR length(provider_ref) BETWEEN 1 AND 200),
  provider_status text CHECK (provider_status IS NULL OR length(provider_status) BETWEEN 1 AND 80),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(evidence) = 'object' AND octet_length(evidence::text) <= 4096),
  -- Requested cancellation is not confirmed provider cancellation.
  cancel_state text NOT NULL DEFAULT 'none'
    CHECK (cancel_state IN ('none', 'requested', 'confirmed_cancelled', 'not_cancellable', 'unknown')),
  cancel_requested_at timestamptz,
  UNIQUE (command_id, attempt_number),
  UNIQUE (id, shop_id),
  FOREIGN KEY (run_id, shop_id) REFERENCES public.custom_agent_runs (id, shop_id) ON DELETE CASCADE,
  FOREIGN KEY (command_id, shop_id) REFERENCES public.agent_run_commands (id, shop_id) ON DELETE CASCADE
);
-- The last-resort concurrency fence: at most one in-flight attempt per command, regardless of callers.
CREATE UNIQUE INDEX agent_run_attempts_one_started_unique
  ON public.agent_run_attempts (command_id) WHERE state = 'started';
CREATE INDEX agent_run_attempts_run_idx ON public.agent_run_attempts (run_id, started_at);

CREATE TABLE public.agent_run_waits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  run_id uuid NOT NULL,
  step_id uuid,
  command_id uuid,
  kind text NOT NULL
    CHECK (kind IN ('approval', 'customer_reply', 'time_window', 'connector', 'dependency', 'reconciliation', 'restart_recovery')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 160),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'satisfied', 'expired', 'cancelled')),
  due_at timestamptz,
  owner_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  escalate_at timestamptz,
  escalate_to text CHECK (escalate_to IS NULL OR escalate_to IN ('owner', 'manager')),
  escalated_at timestamptz,
  ref_kind text NOT NULL DEFAULT 'none' CHECK (ref_kind IN ('none', 'pending_action', 'customer', 'command')),
  ref_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resolution text CHECK (resolution IS NULL OR length(resolution) BETWEEN 1 AND 80),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(evidence) = 'object' AND octet_length(evidence::text) <= 4096),
  CHECK ((ref_kind = 'none') = (ref_id IS NULL)),
  CHECK ((state = 'open') = (resolved_at IS NULL)),
  UNIQUE (id, shop_id),
  FOREIGN KEY (run_id, shop_id) REFERENCES public.custom_agent_runs (id, shop_id) ON DELETE CASCADE,
  FOREIGN KEY (step_id, shop_id) REFERENCES public.agent_run_steps (id, shop_id) ON DELETE CASCADE,
  FOREIGN KEY (command_id, shop_id) REFERENCES public.agent_run_commands (id, shop_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX agent_run_waits_one_open_unique ON public.agent_run_waits (run_id) WHERE state = 'open';
CREATE INDEX agent_run_waits_open_due_idx ON public.agent_run_waits (due_at) WHERE state = 'open';

CREATE TABLE public.agent_run_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id uuid NOT NULL,
  run_id uuid NOT NULL,
  kind text NOT NULL CHECK (length(kind) BETWEEN 1 AND 60),
  actor_kind text NOT NULL CHECK (actor_kind IN ('worker', 'human', 'system', 'recovery', 'database')),
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 4096),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (run_id, shop_id) REFERENCES public.custom_agent_runs (id, shop_id) ON DELETE CASCADE
);
CREATE INDEX agent_run_events_run_idx ON public.agent_run_events (run_id, id);

ALTER TABLE public.agent_run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_run_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_run_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_run_waits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_run_events ENABLE ROW LEVEL SECURITY;
-- No browser access of any kind; the service role reads. Every write goes through a function below.
REVOKE ALL ON public.agent_run_steps, public.agent_run_commands, public.agent_run_attempts,
  public.agent_run_waits, public.agent_run_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.agent_run_steps, public.agent_run_commands, public.agent_run_attempts,
  public.agent_run_waits, public.agent_run_events TO service_role;

CREATE FUNCTION public.agent_run_events_append_only() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'Agent run history cannot be truncated' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Agent run history is immutable' USING ERRCODE = '42501';
  END IF;
  -- Only a tenant deletion cascade may remove history.
  IF EXISTS (SELECT 1 FROM public.shops WHERE id = OLD.shop_id) THEN
    RAISE EXCEPTION 'Agent run history cannot be deleted' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER agent_run_events_append_only BEFORE UPDATE OR DELETE ON public.agent_run_events
  FOR EACH ROW EXECUTE FUNCTION public.agent_run_events_append_only();
CREATE TRIGGER agent_run_events_no_truncate BEFORE TRUNCATE ON public.agent_run_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.agent_run_events_append_only();

-- A command's identity (what it is, for which payload) never changes after it is registered.
CREATE FUNCTION public.agent_run_commands_identity_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF (OLD.id, OLD.shop_id, OLD.agent_id, OLD.run_id, OLD.step_id, OLD.command_key, OLD.operation, OLD.intent,
      OLD.payload_hash, OLD.idempotency_key, OLD.dedupe_key, OLD.credits_estimate, OLD.approval_required,
      OLD.approval_payload_hash)
     IS DISTINCT FROM
     (NEW.id, NEW.shop_id, NEW.agent_id, NEW.run_id, NEW.step_id, NEW.command_key, NEW.operation, NEW.intent,
      NEW.payload_hash, NEW.idempotency_key, NEW.dedupe_key, NEW.credits_estimate, NEW.approval_required,
      NEW.approval_payload_hash) THEN
    RAISE EXCEPTION 'A command''s identity is immutable' USING ERRCODE = '42501';
  END IF;
  -- A confirmed effect, or a cancellation, is final. (failed_before_effect may take a fresh admitted attempt;
  -- unknown only moves through human reconciliation.)
  IF OLD.state IN ('succeeded', 'cancelled') AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'A final command state cannot change' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_run_commands_identity_guard BEFORE UPDATE ON public.agent_run_commands
  FOR EACH ROW EXECUTE FUNCTION public.agent_run_commands_identity_guard();

-- ---------------------------------------------------------------------------
-- 3. Internal helpers (no grants: callable only from the functions below)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.agent_run_require_service() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Scheduled agent worker unavailable' USING ERRCODE = '42501';
  END IF;
END $$;

CREATE FUNCTION public.agent_run_emit(
  p_shop uuid, p_run uuid, p_kind text, p_actor_kind text, p_actor uuid, p_detail jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.agent_run_events (shop_id, run_id, kind, actor_kind, actor_id, detail)
  VALUES (p_shop, p_run, p_kind, p_actor_kind, p_actor, coalesce(p_detail, '{}'::jsonb));
END $$;

-- The one ownership test: locks the run and answers a NULL row unless this worker holds a live lease
-- for this attempt. Lock order everywhere: agent -> run -> command -> attempt / step / wait.
CREATE FUNCTION public.agent_run_owned(p_run uuid, p_worker uuid, p_attempt integer)
RETURNS public.custom_agent_runs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.custom_agent_runs;
BEGIN
  SELECT * INTO r FROM public.custom_agent_runs WHERE id = p_run FOR UPDATE;
  IF NOT FOUND
     OR r.trigger_source <> 'schedule'
     OR r.state <> 'running'
     OR r.worker_id IS DISTINCT FROM p_worker
     OR r.attempt IS DISTINCT FROM p_attempt
     OR r.lease_expires_at IS NULL
     OR r.lease_expires_at <= clock_timestamp() THEN
    RETURN NULL;
  END IF;
  RETURN r;
END $$;

-- Why a governed run's binding is no longer runnable (empty = current). Reads only; takes no lock.
CREATE FUNCTION public.agent_run_binding_reasons(r public.custom_agent_runs) RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_enabled boolean;
BEGIN
  SELECT enabled INTO v_enabled FROM public.custom_agents WHERE id = r.agent_id AND shop_id = r.shop_id;
  IF NOT FOUND OR v_enabled IS DISTINCT FROM true THEN RETURN ARRAY['agent_disabled']; END IF;
  RETURN public.agent_definition_binding_reasons(r.agent_id, r.definition_revision, r.activation_event_seq);
END $$;

-- Terminal / stopping bookkeeping: nothing that never started will start, open steps are abandoned,
-- the open wait is cancelled. Never touches an attempt (those are classified by the caller).
CREATE FUNCTION public.agent_run_close_open(p_run uuid, p_resolution text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.agent_run_commands
     SET state = 'cancelled', updated_at = clock_timestamp(), finished_at = clock_timestamp()
   WHERE run_id = p_run AND state = 'pending';
  UPDATE public.agent_run_steps
     SET state = 'abandoned', finished_at = clock_timestamp()
   WHERE run_id = p_run AND state IN ('running', 'waiting');
  UPDATE public.agent_run_waits
     SET state = 'cancelled', resolved_at = clock_timestamp(), resolution = left(p_resolution, 80)
   WHERE run_id = p_run AND state = 'open' AND kind <> 'reconciliation';
END $$;

-- Every attempt with no recorded outcome becomes UNKNOWN (never failed, never retried) and the run
-- is handed to a human through one reconciliation wait. Returns how many attempts were affected.
CREATE FUNCTION public.agent_run_mark_inflight_unknown(p_run uuid, p_reason text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a record; v_n integer := 0; v_first uuid; v_shop uuid;
BEGIN
  FOR a IN
    SELECT t.id, t.command_id, t.shop_id FROM public.agent_run_attempts t
     WHERE t.run_id = p_run AND t.state = 'started' ORDER BY t.started_at FOR UPDATE
  LOOP
    UPDATE public.agent_run_attempts
       SET state = 'unknown', finished_at = clock_timestamp(),
           cancel_state = CASE WHEN cancel_state = 'requested' THEN 'unknown' ELSE cancel_state END,
           evidence = jsonb_build_object('classified_by', left(p_reason, 80))
     WHERE id = a.id;
    UPDATE public.agent_run_commands
       SET state = 'unknown', updated_at = clock_timestamp()
     WHERE id = a.command_id AND state = 'in_flight';
    v_n := v_n + 1;
    v_first := coalesce(v_first, a.command_id);
    v_shop := a.shop_id;
  END LOOP;
  IF v_n > 0 THEN
    UPDATE public.agent_run_waits
       SET state = 'cancelled', resolved_at = clock_timestamp(), resolution = 'superseded_by_reconciliation'
     WHERE run_id = p_run AND state = 'open' AND kind <> 'reconciliation';
    INSERT INTO public.agent_run_waits (shop_id, run_id, command_id, kind, reason, ref_kind, ref_id)
    VALUES (v_shop, p_run, v_first, 'reconciliation', 'reconciliation_required', 'command', v_first)
    ON CONFLICT (run_id) WHERE state = 'open' DO NOTHING;
  END IF;
  RETURN v_n;
END $$;

-- Hands a dead-lease governed run to the right place from its EVIDENCE alone. The caller holds the
-- run lock. Outcomes: unknown | cancelled | paused | recoverable. Never retries anything.
CREATE FUNCTION public.agent_run_recover_one(r public.custom_agent_runs, p_actor_kind text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_unknown integer; v_pending boolean;
BEGIN
  v_unknown := public.agent_run_mark_inflight_unknown(r.id, 'lease_expired');
  v_pending := r.control_request IS NOT NULL AND r.control_acked_at IS NULL;
  IF v_unknown > 0 OR EXISTS (
       SELECT 1 FROM public.agent_run_commands WHERE run_id = r.id AND state = 'unknown') THEN
    UPDATE public.agent_run_steps SET state = 'waiting' WHERE run_id = r.id AND state = 'running';
    UPDATE public.custom_agent_runs
       SET state = 'unknown', fired = false,
           reason = 'Scheduled worker lease expired; reconcile before retrying.',
           wait_reason = 'reconciliation_required', error_code = 'lease_expired',
           finished_at = clock_timestamp(), lease_expires_at = NULL
     WHERE id = r.id;
    PERFORM public.agent_run_emit(r.shop_id, r.id, 'lease_expired_unknown', p_actor_kind, NULL,
      jsonb_build_object('attempts_made_unknown', v_unknown, 'run_attempt', r.attempt));
    RETURN 'unknown';
  END IF;
  IF v_pending AND r.control_request = 'cancel' THEN
    PERFORM public.agent_run_close_open(r.id, 'run_cancelled');
    UPDATE public.custom_agent_runs
       SET state = 'cancelled', fired = false, reason = 'Cancelled at a safe boundary after the worker stopped.',
           wait_reason = NULL, error_code = NULL, finished_at = clock_timestamp(), lease_expires_at = NULL,
           control_acked_at = clock_timestamp(), control_acked_by = p_actor_kind
     WHERE id = r.id;
    PERFORM public.agent_run_emit(r.shop_id, r.id, 'cancel_acknowledged', p_actor_kind, NULL, '{}'::jsonb);
    RETURN 'cancelled';
  END IF;
  -- Recoverable (and paused): no effect is in flight, so resuming cannot duplicate one. Succeeded
  -- commands replay as already done; failed-before-effect commands may take a fresh admitted attempt.
  UPDATE public.agent_run_steps SET state = 'abandoned', finished_at = clock_timestamp()
   WHERE run_id = r.id AND state = 'running';
  IF NOT EXISTS (SELECT 1 FROM public.agent_run_waits WHERE run_id = r.id AND state = 'open') THEN
    INSERT INTO public.agent_run_waits (shop_id, run_id, kind, reason, due_at)
    VALUES (r.shop_id, r.id, 'restart_recovery', 'restart_recovery', clock_timestamp());
  END IF;
  IF v_pending AND r.control_request = 'pause' THEN
    UPDATE public.custom_agent_runs
       SET state = 'paused', wait_reason = 'paused', lease_expires_at = NULL,
           control_acked_at = clock_timestamp(), control_acked_by = p_actor_kind
     WHERE id = r.id;
    PERFORM public.agent_run_emit(r.shop_id, r.id, 'pause_acknowledged', p_actor_kind, NULL, '{}'::jsonb);
    RETURN 'paused';
  END IF;
  UPDATE public.custom_agent_runs
     SET state = 'waiting', wait_reason = 'restart_recovery', lease_expires_at = NULL
   WHERE id = r.id;
  PERFORM public.agent_run_emit(r.shop_id, r.id, 'stale_lease_recovered', p_actor_kind, NULL,
    jsonb_build_object('run_attempt', r.attempt));
  RETURN 'recoverable';
END $$;

-- A wait is ready to resume when it is due, when its linked approval has been decided, or when it is a
-- restart-recovery marker. Reconciliation waits are never ready: only a person resolves them.
CREATE FUNCTION public.agent_run_wait_ready(w public.agent_run_waits) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT w.state = 'open' AND w.kind <> 'reconciliation' AND (
    w.kind = 'restart_recovery'
    OR (w.due_at IS NOT NULL AND w.due_at <= clock_timestamp())
    OR (w.ref_kind = 'pending_action' AND EXISTS (
          SELECT 1 FROM public.pending_actions p
           WHERE p.id = w.ref_id AND p.shop_id = w.shop_id AND p.status::text IN ('approved', 'rejected')))
  );
$$;

-- ---------------------------------------------------------------------------
-- 4. Claim / finish / unknown: re-declared from 20261111120000. Legacy paths are unchanged.
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
  v_outcome text;
  v_stale public.custom_agent_runs;
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
      IF v_run.definition_revision IS NOT NULL THEN
        -- A governed run is classified from its evidence (in-flight attempts become unknown; a run
        -- with none becomes recoverable), never blindly marked unknown and never retried here.
        v_outcome := public.agent_run_recover_one(v_run, 'database');
        IF v_outcome = 'unknown' THEN
          RETURN jsonb_build_object('outcome', 'unknown', 'run_id', v_run.id, 'attempt', v_run.attempt);
        END IF;
        RETURN jsonb_build_object('outcome', 'open_duplicate', 'run_id', v_run.id, 'attempt', v_run.attempt,
          'state', CASE v_outcome WHEN 'recoverable' THEN 'waiting' ELSE v_outcome END);
      END IF;
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
    IF v_run.state IN ('waiting', 'paused') THEN
      -- Open, resumable work for this window. It continues through the resume claim, never here.
      RETURN jsonb_build_object(
        'outcome', 'open_duplicate',
        'run_id', v_run.id,
        'attempt', v_run.attempt,
        'state', v_run.state
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
      -- A previous attempt whose lease expired is classified from its evidence, never a free slot
      -- and never an automatic retry.
      FOR v_stale IN
        SELECT * FROM public.custom_agent_runs
         WHERE agent_id = v_agent.id AND state = 'running' AND lease_expires_at <= clock_timestamp()
         ORDER BY started_at FOR UPDATE
      LOOP
        IF v_stale.definition_revision IS NOT NULL THEN
          PERFORM public.agent_run_recover_one(v_stale, 'database');
        ELSE
          UPDATE public.custom_agent_runs
             SET state = 'unknown', fired = false,
                 reason = 'Scheduled worker lease expired; reconcile before retrying.',
                 wait_reason = 'reconciliation_required', error_code = 'lease_expired',
                 finished_at = clock_timestamp(), lease_expires_at = NULL
           WHERE id = v_stale.id;
        END IF;
      END LOOP;
      SELECT count(*)::integer INTO v_in_flight FROM public.custom_agent_runs
       WHERE agent_id = v_agent.id AND state = 'running';
      IF v_in_flight >= (rev.definition #>> '{limits,maximumConcurrentRuns}')::integer THEN
        v_reasons := array_append(v_reasons, 'concurrent_run_active');
      END IF;
      SELECT count(*)::integer INTO v_today FROM public.custom_agent_runs
       WHERE agent_id = v_agent.id AND definition_revision IS NOT NULL
         AND state IN ('running', 'waiting', 'paused', 'succeeded', 'failed', 'unknown', 'cancelled', 'killed')
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
      lease_expires_at, started_at, lease_started_at, last_heartbeat_at, definition_snapshot,
      definition_hash, policy_revision, knowledge_revision, definition_revision, evaluation_id,
      memory_pins, state_version, activation_event_seq
    ) VALUES (
      v_agent.id, v_agent.shop_id, 'schedule', p_trigger_key, false, 'running', 1, p_worker,
      clock_timestamp() + make_interval(secs => p_lease_seconds), clock_timestamp(), clock_timestamp(),
      clock_timestamp(), rev.definition, rev.definition_hash, v_policy_revision,
      coalesce(v_head, 1), rev.revision, ev_eval.id, v_pins, st.version, ev.seq
    )
    RETURNING * INTO v_run;

    PERFORM public.agent_run_emit(v_run.shop_id, v_run.id, 'claimed', 'worker', NULL,
      jsonb_build_object('run_attempt', 1, 'definition_revision', v_run.definition_revision));

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

  IF v_run.definition_revision IS NOT NULL THEN
    -- A governed run cannot be declared finished while an external attempt has no recorded outcome,
    -- and cannot be declared successful while any command's outcome is unconfirmed. The worker must
    -- record the attempt result (or let recovery classify it as unknown) first.
    IF EXISTS (SELECT 1 FROM public.agent_run_attempts WHERE run_id = v_run.id AND state = 'started')
       OR (p_state = 'succeeded' AND EXISTS (
             SELECT 1 FROM public.agent_run_commands WHERE run_id = v_run.id AND state IN ('in_flight', 'unknown'))) THEN
      RETURN false;
    END IF;
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
    PERFORM public.agent_run_close_open(v_run.id, 'run_finished');
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

  IF v_run.definition_revision IS NOT NULL THEN
    PERFORM public.agent_run_emit(v_run.shop_id, v_run.id, 'finished', 'worker', NULL,
      jsonb_build_object('state', p_state, 'error_code', p_error_code, 'binding', left(v_binding, 200)));
  END IF;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.mark_scheduled_agent_run_unknown(
  p_run uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
  r public.custom_agent_runs;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Scheduled agent worker unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO r FROM public.custom_agent_runs
   WHERE id = p_run AND trigger_source = 'schedule' AND state = 'running'
     AND lease_expires_at <= clock_timestamp()
   FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF r.definition_revision IS NOT NULL THEN
    -- Governed: classify by evidence. True only if the result really is `unknown`.
    RETURN public.agent_run_recover_one(r, 'database') = 'unknown';
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
  RETURNING id INTO v_id;
  RETURN v_id IS NOT NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Heartbeat
-- ---------------------------------------------------------------------------
-- Extends a LIVE lease only (an expired lease is never resurrected) and answers whether the worker
-- must stop: a pending pause / cancel request, the definition's own runtime ceiling, or loss of
-- ownership. {alive:false} means do nothing further.
CREATE FUNCTION public.heartbeat_agent_run(
  p_run uuid, p_worker uuid, p_attempt integer, p_lease_seconds integer DEFAULT 120
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.custom_agent_runs; v_runtime integer; v_control text;
BEGIN
  PERFORM public.agent_run_require_service();
  IF p_run IS NULL OR p_worker IS NULL OR p_attempt IS NULL OR p_attempt < 1
     OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 900 THEN
    RAISE EXCEPTION 'Invalid heartbeat' USING ERRCODE = '22023';
  END IF;
  r := public.agent_run_owned(p_run, p_worker, p_attempt);
  IF r.id IS NULL THEN
    RETURN jsonb_build_object('alive', false, 'reason', 'run_not_owned');
  END IF;
  v_control := CASE WHEN r.control_request IS NOT NULL AND r.control_acked_at IS NULL THEN r.control_request END;
  IF r.definition_revision IS NOT NULL THEN
    v_runtime := (r.definition_snapshot #>> '{limits,maximumRuntimeSeconds}')::integer;
    IF v_runtime IS NOT NULL AND coalesce(r.lease_started_at, r.started_at) + make_interval(secs => v_runtime) <= clock_timestamp() THEN
      RETURN jsonb_build_object('alive', false, 'reason', 'runtime_limit_reached', 'control', v_control);
    END IF;
  END IF;
  UPDATE public.custom_agent_runs
     SET lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
         last_heartbeat_at = clock_timestamp()
   WHERE id = r.id;
  RETURN jsonb_build_object('alive', true, 'control', v_control);
END $$;

-- ---------------------------------------------------------------------------
-- 6. Steps
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.begin_agent_run_step(
  p_run uuid, p_worker uuid, p_attempt integer, p_step_key text, p_kind text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r public.custom_agent_runs; s public.agent_run_steps; v_reasons text[]; v_runtime integer; v_max integer; v_n integer;
BEGIN
  PERFORM public.agent_run_require_service();
  IF p_run IS NULL OR p_worker IS NULL OR p_attempt IS NULL OR p_attempt < 1
     OR p_step_key IS NULL OR p_step_key !~ '^[a-z][a-z0-9_.:-]{0,79}$'
     OR p_kind IS NULL OR p_kind NOT IN ('read', 'effect', 'wait', 'decision') THEN
    RAISE EXCEPTION 'Invalid step' USING ERRCODE = '22023';
  END IF;
  r := public.agent_run_owned(p_run, p_worker, p_attempt);
  IF r.id IS NULL THEN RETURN jsonb_build_object('outcome', 'refused', 'reasons', jsonb_build_array('run_not_owned')); END IF;
  IF r.definition_revision IS NULL THEN RETURN jsonb_build_object('outcome', 'refused', 'reasons', jsonb_build_array('run_not_governed')); END IF;
  IF r.control_request IS NOT NULL AND r.control_acked_at IS NULL THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reasons', jsonb_build_array(r.control_request || '_requested'));
  END IF;
  v_runtime := (r.definition_snapshot #>> '{limits,maximumRuntimeSeconds}')::integer;
  IF coalesce(r.lease_started_at, r.started_at) + make_interval(secs => v_runtime) <= clock_timestamp() THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reasons', jsonb_build_array('runtime_limit_reached'));
  END IF;
  v_reasons := public.agent_run_binding_reasons(r);
  IF cardinality(v_reasons) > 0 THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reasons', to_jsonb(v_reasons));
  END IF;

  SELECT * INTO s FROM public.agent_run_steps WHERE run_id = r.id AND step_key = p_step_key FOR UPDATE;
  IF FOUND THEN
    IF s.state = 'succeeded' OR s.state = 'skipped' THEN
      RETURN jsonb_build_object('outcome', 'replay_done', 'step_id', s.id, 'ordinal', s.ordinal, 'state', s.state);
    END IF;
    IF s.state = 'failed' THEN
      RETURN jsonb_build_object('outcome', 'refused', 'reasons', jsonb_build_array('step_failed'), 'step_id', s.id);
    END IF;
    IF s.kind <> p_kind THEN
      RETURN jsonb_build_object('outcome', 'refused', 'reasons', jsonb_build_array('step_kind_changed'), 'step_id', s.id);
    END IF;
    IF s.state = 'running' AND s.run_attempt = r.attempt THEN
      RETURN jsonb_build_object('outcome', 'already_running', 'step_id', s.id, 'ordinal', s.ordinal);
    END IF;
    -- running under an older lease (cannot happen after recovery) or abandoned / waiting: resume it.
    UPDATE public.agent_run_steps SET state = 'running', run_attempt = r.attempt, finished_at = NULL, outcome_code = NULL
     WHERE id = s.id;
    RETURN jsonb_build_object('outcome', 'resumed', 'step_id', s.id, 'ordinal', s.ordinal);
  END IF;

  SELECT count(*)::integer INTO v_n FROM public.agent_run_steps WHERE run_id = r.id;
  v_max := (r.definition_snapshot #>> '{limits,maximumStepsPerRun}')::integer;
  IF v_n >= v_max THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reasons', jsonb_build_array('step_limit_reached'));
  END IF;
  INSERT INTO public.agent_run_steps (shop_id, run_id, ordinal, step_key, kind, state, run_attempt)
  VALUES (r.shop_id, r.id, v_n + 1, p_step_key, p_kind, 'running', r.attempt)
  RETURNING * INTO s;
  RETURN jsonb_build_object('outcome', 'started', 'step_id', s.id, 'ordinal', s.ordinal);
END $$;

CREATE FUNCTION public.finish_agent_run_step(
  p_run uuid, p_worker uuid, p_attempt integer, p_step_key text, p_state text,
  p_outcome_code text DEFAULT NULL, p_evidence jsonb DEFAULT '{}'::jsonb
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.custom_agent_runs; s public.agent_run_steps;
BEGIN
  PERFORM public.agent_run_require_service();
  IF p_run IS NULL OR p_worker IS NULL OR p_attempt IS NULL OR p_step_key IS NULL
     OR p_state IS NULL OR p_state NOT IN ('succeeded', 'failed', 'skipped')
     OR (p_outcome_code IS NOT NULL AND length(p_outcome_code) NOT BETWEEN 1 AND 80)
     OR p_evidence IS NULL OR jsonb_typeof(p_evidence) <> 'object' OR octet_length(p_evidence::text) > 4096 THEN
    RAISE EXCEPTION 'Invalid step result' USING ERRCODE = '22023';
  END IF;
  r := public.agent_run_owned(p_run, p_worker, p_attempt);
  IF r.id IS NULL THEN RETURN false; END IF;
  SELECT * INTO s FROM public.agent_run_steps WHERE run_id = r.id AND step_key = p_step_key FOR UPDATE;
  IF NOT FOUND OR s.state <> 'running' THEN RETURN false; END IF;
  -- A step that still owns an unconfirmed external attempt or an unresolved command cannot be closed.
  IF EXISTS (SELECT 1 FROM public.agent_run_commands c WHERE c.step_id = s.id AND c.state IN ('in_flight', 'unknown')) THEN
    RETURN false;
  END IF;
  UPDATE public.agent_run_steps
     SET state = p_state, finished_at = clock_timestamp(), outcome_code = p_outcome_code, evidence = p_evidence
   WHERE id = s.id;
  RETURN true;
END $$;

-- ---------------------------------------------------------------------------
-- 7. Commands: stable identity, then the gated attempt
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.register_agent_command(
  p_run uuid, p_worker uuid, p_attempt integer, p_step_key text, p_command_key text,
  p_operation text, p_intent text, p_payload_hash text, p_credits integer DEFAULT 0,
  p_pending_action uuid DEFAULT NULL, p_approval_required boolean DEFAULT false, p_dedupe_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r public.custom_agent_runs; s public.agent_run_steps; c public.agent_run_commands;
  v_key text; v_approval_hash text; v_other uuid;
BEGIN
  PERFORM public.agent_run_require_service();
  IF p_run IS NULL OR p_worker IS NULL OR p_attempt IS NULL OR p_attempt < 1 OR p_step_key IS NULL
     OR p_command_key IS NULL OR p_command_key !~ '^[a-z0-9][a-z0-9_.:/-]{0,119}$'
     OR p_operation IS NULL OR length(p_operation) NOT BETWEEN 3 AND 60
     OR p_intent IS NULL OR p_intent NOT IN ('stage', 'execute')
     OR p_payload_hash IS NULL OR p_payload_hash !~ '^[0-9a-f]{64}$'
     OR p_credits IS NULL OR p_credits < 0 OR p_credits > 100000
     OR p_approval_required IS NULL
     OR (p_approval_required AND (p_intent <> 'execute' OR p_pending_action IS NULL))
     OR (p_dedupe_key IS NOT NULL AND length(p_dedupe_key) NOT BETWEEN 1 AND 160) THEN
    RAISE EXCEPTION 'Invalid command' USING ERRCODE = '22023';
  END IF;
  r := public.agent_run_owned(p_run, p_worker, p_attempt);
  IF r.id IS NULL THEN RETURN jsonb_build_object('outcome', 'refused', 'reasons', jsonb_build_array('run_not_owned')); END IF;
  IF r.definition_revision IS NULL THEN RETURN jsonb_build_object('outcome', 'refused', 'reasons', jsonb_build_array('run_not_governed')); END IF;
  -- Grants come from the IMMUTABLE bound snapshot; a changed grant is a new revision and moves the pointer.
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r.definition_snapshot -> 'tools') t WHERE t ->> 'operation' = p_operation) THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reasons', jsonb_build_array('tool_not_granted'));
  END IF;
  IF p_operation IN ('voice.outbound', 'campaign.send') THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reasons', jsonb_build_array('post_mvp_tool_disabled'));
  END IF;
  SELECT * INTO s FROM public.agent_run_steps WHERE run_id = r.id AND step_key = p_step_key;
  IF NOT FOUND OR s.state <> 'running' THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reasons', jsonb_build_array('step_not_running'));
  END IF;

  SELECT * INTO c FROM public.agent_run_commands WHERE run_id = r.id AND command_key = p_command_key FOR UPDATE;
  IF FOUND THEN
    IF c.payload_hash <> p_payload_hash OR c.operation <> p_operation OR c.intent <> p_intent
       OR c.step_id <> s.id OR c.dedupe_key IS DISTINCT FROM p_dedupe_key THEN
      -- The same stable identity with different content: an edit invalidates the old command.
      RETURN jsonb_build_object('outcome', 'refused', 'reasons', jsonb_build_array('command_changed'),
        'command_id', c.id, 'state', c.state);
    END IF;
    RETURN jsonb_build_object('outcome', 'existing', 'command_id', c.id, 'state', c.state,
      'idempotency_key', c.idempotency_key, 'provider_ref', c.provider_ref);
  END IF;

  IF p_approval_required THEN
    SELECT encode(sha256(convert_to(p.payload::text, 'UTF8')), 'hex') INTO v_approval_hash
      FROM public.pending_actions p WHERE p.id = p_pending_action AND p.shop_id = r.shop_id;
    IF v_approval_hash IS NULL THEN
      RETURN jsonb_build_object('outcome', 'refused', 'reasons', jsonb_build_array('approval_missing'));
    END IF;
  END IF;
  IF p_dedupe_key IS NOT NULL THEN
    SELECT id INTO v_other FROM public.agent_run_commands
     WHERE shop_id = r.shop_id AND agent_id = r.agent_id AND dedupe_key = p_dedupe_key
       AND state IN ('pending', 'in_flight', 'succeeded', 'unknown');
    IF v_other IS NOT NULL THEN
      RETURN jsonb_build_object('outcome', 'duplicate_dedupe', 'reasons', jsonb_build_array('dedupe_key_in_use'),
        'command_id', v_other);
    END IF;
  END IF;

  v_key := encode(sha256(convert_to(
    r.shop_id::text || '|' || r.id::text || '|' || p_command_key || '|' || p_operation || '|' || p_payload_hash, 'UTF8')), 'hex');
  BEGIN
    INSERT INTO public.agent_run_commands (
      shop_id, agent_id, run_id, step_id, command_key, operation, intent, payload_hash, idempotency_key,
      dedupe_key, credits_estimate, approval_required, pending_action_id, approval_payload_hash
    ) VALUES (
      r.shop_id, r.agent_id, r.id, s.id, p_command_key, p_operation, p_intent, p_payload_hash, v_key,
      p_dedupe_key, p_credits, p_approval_required, p_pending_action, v_approval_hash
    ) RETURNING * INTO c;
  EXCEPTION WHEN unique_violation THEN
    -- Two runs registered the same business-object key at once; exactly one wins.
    RETURN jsonb_build_object('outcome', 'duplicate_dedupe', 'reasons', jsonb_build_array('dedupe_key_in_use'));
  END;
  PERFORM public.agent_run_emit(r.shop_id, r.id, 'command_registered', 'worker', NULL,
    jsonb_build_object('command_id', c.id, 'operation', p_operation, 'intent', p_intent));
  RETURN jsonb_build_object('outcome', 'registered', 'command_id', c.id, 'state', c.state, 'idempotency_key', c.idempotency_key);
END $$;

-- The pre-effect gate. Within ONE transaction it re-verifies, immediately before a provider call
-- could be made: ownership, control requests, runtime / attempt ceilings, the exact definition binding
-- (active pointer, policy revision, memory, evaluation, agent enabled), the immutable tool grant, the
-- credit budget and (for an execute command) the linked approval's CURRENT status and payload hash.
-- The application's policy / consent / readiness / approval / budget / grants checks arrive as evidence
-- and are required to be present and passing; they are stored with the attempt either way.
-- On success the attempt row exists (`started`) before the caller does anything external.
CREATE FUNCTION public.begin_agent_command_attempt(
  p_run uuid, p_worker uuid, p_attempt integer, p_command uuid, p_checks jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  c_required constant text[] := ARRAY['policy', 'consent', 'readiness', 'approval', 'budget', 'grants'];
  r public.custom_agent_runs; c public.agent_run_commands; a public.agent_run_attempts;
  v_reasons text[] := ARRAY[]::text[];
  v_name text; v_status text; v_count integer; v_spent integer; v_budget integer; v_runtime integer;
  v_status_row record; v_hash text; v_number integer; v_refused integer;
BEGIN
  PERFORM public.agent_run_require_service();
  IF p_run IS NULL OR p_worker IS NULL OR p_attempt IS NULL OR p_attempt < 1 OR p_command IS NULL
     OR p_checks IS NULL OR jsonb_typeof(p_checks) <> 'array' OR octet_length(p_checks::text) > 4000 THEN
    RAISE EXCEPTION 'Invalid attempt request' USING ERRCODE = '22023';
  END IF;
  r := public.agent_run_owned(p_run, p_worker, p_attempt);
  IF r.id IS NULL THEN RETURN jsonb_build_object('outcome', 'refused', 'reasons', jsonb_build_array('run_not_owned')); END IF;
  IF r.definition_revision IS NULL THEN RETURN jsonb_build_object('outcome', 'refused', 'reasons', jsonb_build_array('run_not_governed')); END IF;

  SELECT * INTO c FROM public.agent_run_commands WHERE id = p_command AND run_id = r.id AND shop_id = r.shop_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'refused', 'reasons', jsonb_build_array('command_not_found')); END IF;

  IF c.state = 'succeeded' THEN
    RETURN jsonb_build_object('outcome', 'replay_succeeded', 'command_id', c.id, 'provider_ref', c.provider_ref);
  END IF;
  IF c.state = 'unknown' THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reasons', jsonb_build_array('outcome_unknown_requires_reconciliation'), 'command_id', c.id);
  END IF;
  IF c.state = 'in_flight' THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reasons', jsonb_build_array('attempt_in_flight'), 'command_id', c.id);
  END IF;
  IF c.state = 'cancelled' THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reasons', jsonb_build_array('command_cancelled'), 'command_id', c.id);
  END IF;
  IF r.control_request IS NOT NULL AND r.control_acked_at IS NULL THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reasons', jsonb_build_array(r.control_request || '_requested'), 'command_id', c.id);
  END IF;
  v_runtime := (r.definition_snapshot #>> '{limits,maximumRuntimeSeconds}')::integer;
  IF coalesce(r.lease_started_at, r.started_at) + make_interval(secs => v_runtime) <= clock_timestamp() THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reasons', jsonb_build_array('runtime_limit_reached'), 'command_id', c.id);
  END IF;
  IF c.attempts_started >= 5 THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reasons', jsonb_build_array('attempt_limit_reached'), 'command_id', c.id);
  END IF;

  -- Database-verified facts.
  v_reasons := public.agent_run_binding_reasons(r);
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r.definition_snapshot -> 'tools') t WHERE t ->> 'operation' = c.operation)
     OR c.operation IN ('voice.outbound', 'campaign.send') THEN
    v_reasons := array_append(v_reasons, 'tool_not_granted');
  END IF;
  SELECT coalesce(sum(credits_estimate), 0)::integer INTO v_spent FROM public.agent_run_commands
   WHERE run_id = r.id AND id <> c.id AND state IN ('in_flight', 'succeeded', 'unknown');
  v_budget := (r.definition_snapshot #>> '{limits,maximumCreditsPerRun}')::integer;
  IF v_spent + c.credits_estimate > v_budget THEN v_reasons := array_append(v_reasons, 'budget_exceeded'); END IF;
  IF c.approval_required THEN
    SELECT p.status::text AS status, p.result_id, encode(sha256(convert_to(p.payload::text, 'UTF8')), 'hex') AS h
      INTO v_status_row FROM public.pending_actions p WHERE p.id = c.pending_action_id AND p.shop_id = c.shop_id;
    IF NOT FOUND THEN v_reasons := array_append(v_reasons, 'approval_missing');
    ELSIF v_status_row.status <> 'approved' THEN v_reasons := array_append(v_reasons, 'approval_not_current');
    ELSIF v_status_row.result_id IS NOT NULL THEN v_reasons := array_append(v_reasons, 'approval_consumed');
    ELSIF v_status_row.h IS DISTINCT FROM c.approval_payload_hash THEN v_reasons := array_append(v_reasons, 'approval_payload_changed');
    END IF;
  END IF;

  -- Application-evaluated evidence: every required check present once and passing.
  FOREACH v_name IN ARRAY c_required LOOP
    SELECT count(*)::integer INTO v_count FROM jsonb_array_elements(p_checks) e
     WHERE jsonb_typeof(e) = 'object' AND e ->> 'name' = v_name;
    IF v_count = 0 THEN
      v_reasons := array_append(v_reasons, 'check_missing_' || v_name);
    ELSIF v_count > 1 THEN
      v_reasons := array_append(v_reasons, 'check_duplicate_' || v_name);
    ELSE
      SELECT e ->> 'status' INTO v_status FROM jsonb_array_elements(p_checks) e WHERE e ->> 'name' = v_name;
      IF NOT (v_status = 'pass'
              OR (v_status = 'not_applicable' AND v_name = 'consent')
              OR (v_status = 'not_applicable' AND v_name = 'approval' AND NOT c.approval_required)) THEN
        v_reasons := array_append(v_reasons, 'check_failed_' || v_name);
      END IF;
    END IF;
  END LOOP;

  SELECT coalesce(max(attempt_number), 0) + 1, count(*) FILTER (WHERE state = 'refused')
    INTO v_number, v_refused FROM public.agent_run_attempts WHERE command_id = c.id;

  IF cardinality(v_reasons) > 0 THEN
    v_reasons := ARRAY(SELECT DISTINCT x FROM unnest(v_reasons) AS x ORDER BY x);
    IF v_refused < 20 THEN
      INSERT INTO public.agent_run_attempts (shop_id, run_id, command_id, attempt_number, run_attempt, worker_id, state,
                                             checks, refusal_reasons, finished_at)
      VALUES (r.shop_id, r.id, c.id, v_number, r.attempt, p_worker, 'refused', p_checks, v_reasons, clock_timestamp());
    END IF;
    PERFORM public.agent_run_emit(r.shop_id, r.id, 'attempt_refused', 'worker', NULL,
      jsonb_build_object('command_id', c.id, 'reasons', to_jsonb(v_reasons)));
    RETURN jsonb_build_object('outcome', 'refused', 'reasons', to_jsonb(v_reasons), 'command_id', c.id);
  END IF;

  BEGIN
    UPDATE public.agent_run_commands
       SET state = 'in_flight', attempts_started = attempts_started + 1, updated_at = clock_timestamp()
     WHERE id = c.id;
  EXCEPTION WHEN unique_violation THEN
    -- Another live command already owns this business-object key (a retry after a confirmed non-effect
    -- raced a newer registration): this attempt must not start.
    RETURN jsonb_build_object('outcome', 'refused', 'reasons', jsonb_build_array('dedupe_key_in_use'), 'command_id', c.id);
  END;
  INSERT INTO public.agent_run_attempts (shop_id, run_id, command_id, attempt_number, run_attempt, worker_id, state, checks)
  VALUES (r.shop_id, r.id, c.id, v_number, r.attempt, p_worker, 'started', p_checks)
  RETURNING * INTO a;
  PERFORM public.agent_run_emit(r.shop_id, r.id, 'attempt_started', 'worker', NULL,
    jsonb_build_object('command_id', c.id, 'attempt_id', a.id, 'attempt_number', v_number));
  RETURN jsonb_build_object('outcome', 'started', 'command_id', c.id, 'attempt_id', a.id,
    'attempt_number', v_number, 'idempotency_key', c.idempotency_key);
END $$;

-- Records what the worker observed. Only the live lease holder can record a result; a result that
-- arrives after the lease was lost is kept as evidence for the human reconciler and changes nothing.
-- `rejected` means the provider DEFINITIVELY refused before any effect; anything ambiguous is `unknown`.
CREATE FUNCTION public.record_agent_attempt_result(
  p_run uuid, p_worker uuid, p_attempt integer, p_attempt_id uuid, p_result text,
  p_provider_ref text DEFAULT NULL, p_provider_status text DEFAULT NULL,
  p_evidence jsonb DEFAULT '{}'::jsonb, p_cancel_state text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r public.custom_agent_runs; a public.agent_run_attempts; c public.agent_run_commands; v_owned boolean;
BEGIN
  PERFORM public.agent_run_require_service();
  IF p_run IS NULL OR p_worker IS NULL OR p_attempt IS NULL OR p_attempt < 1 OR p_attempt_id IS NULL
     OR p_result IS NULL OR p_result NOT IN ('succeeded', 'rejected', 'unknown')
     OR (p_provider_ref IS NOT NULL AND length(p_provider_ref) NOT BETWEEN 1 AND 200)
     OR (p_provider_status IS NOT NULL AND length(p_provider_status) NOT BETWEEN 1 AND 80)
     OR p_evidence IS NULL OR jsonb_typeof(p_evidence) <> 'object' OR octet_length(p_evidence::text) > 4096
     OR (p_cancel_state IS NOT NULL AND p_cancel_state NOT IN ('confirmed_cancelled', 'not_cancellable', 'unknown'))
     OR (p_result = 'succeeded' AND p_provider_ref IS NULL) THEN
    RAISE EXCEPTION 'Invalid attempt result' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO r FROM public.custom_agent_runs WHERE id = p_run FOR UPDATE;
  IF NOT FOUND OR r.definition_revision IS NULL THEN RETURN jsonb_build_object('outcome', 'not_recorded', 'reason', 'run_not_governed'); END IF;
  SELECT * INTO a FROM public.agent_run_attempts WHERE id = p_attempt_id AND run_id = r.id AND shop_id = r.shop_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_recorded', 'reason', 'attempt_not_found'); END IF;
  SELECT * INTO c FROM public.agent_run_commands WHERE id = a.command_id FOR UPDATE;
  SELECT * INTO a FROM public.agent_run_attempts WHERE id = a.id FOR UPDATE;

  IF a.state <> 'started' THEN
    -- Already classified (lease expiry, kill, reconciliation). A late claim is evidence, not truth.
    PERFORM public.agent_run_emit(r.shop_id, r.id, 'late_result_reported', 'worker', NULL,
      jsonb_build_object('attempt_id', a.id, 'recorded_state', a.state, 'claimed', p_result, 'provider_ref', left(p_provider_ref, 200)));
    RETURN jsonb_build_object('outcome', 'not_recorded', 'reason', 'attempt_already_' || a.state, 'state', a.state);
  END IF;

  v_owned := r.state = 'running' AND r.worker_id = p_worker AND r.attempt = p_attempt
             AND r.lease_expires_at IS NOT NULL AND r.lease_expires_at > clock_timestamp()
             AND a.worker_id = p_worker AND a.run_attempt = p_attempt;
  IF NOT v_owned THEN
    PERFORM public.agent_run_emit(r.shop_id, r.id, 'late_result_reported', 'worker', NULL,
      jsonb_build_object('attempt_id', a.id, 'recorded_state', a.state, 'claimed', p_result, 'provider_ref', left(p_provider_ref, 200)));
    IF r.state = 'running' AND r.lease_expires_at <= clock_timestamp() THEN
      PERFORM public.agent_run_recover_one(r, 'database');
    END IF;
    RETURN jsonb_build_object('outcome', 'not_recorded', 'reason', 'run_not_owned');
  END IF;

  UPDATE public.agent_run_attempts
     SET state = p_result, finished_at = clock_timestamp(), provider_ref = p_provider_ref,
         provider_status = p_provider_status, evidence = p_evidence,
         cancel_state = CASE
           WHEN p_cancel_state IS NOT NULL THEN p_cancel_state
           WHEN cancel_state = 'requested' AND p_result = 'unknown' THEN 'unknown'
           ELSE cancel_state END
   WHERE id = a.id;
  IF p_result = 'succeeded' THEN
    UPDATE public.agent_run_commands SET state = 'succeeded', provider_ref = p_provider_ref,
           updated_at = clock_timestamp(), finished_at = clock_timestamp() WHERE id = c.id;
  ELSIF p_result = 'rejected' THEN
    UPDATE public.agent_run_commands SET state = 'failed_before_effect', updated_at = clock_timestamp(),
           finished_at = clock_timestamp() WHERE id = c.id;
  ELSE
    -- Unknown: nothing is retried. The run stops here and a person reconciles.
    UPDATE public.agent_run_commands SET state = 'unknown', updated_at = clock_timestamp() WHERE id = c.id;
    UPDATE public.agent_run_steps SET state = 'waiting' WHERE id = c.step_id AND state = 'running';
    UPDATE public.agent_run_waits SET state = 'cancelled', resolved_at = clock_timestamp(), resolution = 'superseded_by_reconciliation'
     WHERE run_id = r.id AND state = 'open';
    INSERT INTO public.agent_run_waits (shop_id, run_id, step_id, command_id, kind, reason, ref_kind, ref_id)
    VALUES (r.shop_id, r.id, c.step_id, c.id, 'reconciliation', 'reconciliation_required', 'command', c.id)
    ON CONFLICT (run_id) WHERE state = 'open' DO NOTHING;
    UPDATE public.custom_agent_runs
       SET state = 'unknown', fired = false, reason = 'An external attempt has no confirmed outcome; reconcile before continuing.',
           wait_reason = 'reconciliation_required', error_code = 'attempt_outcome_unknown',
           finished_at = clock_timestamp(), lease_expires_at = NULL
     WHERE id = r.id;
  END IF;
  PERFORM public.agent_run_emit(r.shop_id, r.id, 'attempt_result', 'worker', NULL,
    jsonb_build_object('command_id', c.id, 'attempt_id', a.id, 'result', p_result, 'provider_status', p_provider_status));
  RETURN jsonb_build_object('outcome', 'recorded', 'state', p_result, 'command_id', c.id,
    'run_state', CASE WHEN p_result = 'unknown' THEN 'unknown' ELSE 'running' END);
END $$;

-- ---------------------------------------------------------------------------
-- 8. Pause / cancel / kill: REQUEST and ACKNOWLEDGEMENT
-- ---------------------------------------------------------------------------
-- Pause and cancel are requests a live worker acknowledges at a safe boundary (never inside an attempt).
-- Kill is acknowledged by the database at once: the lease is revoked, nothing further can start, an
-- in-flight attempt becomes UNKNOWN. A run with no live worker (waiting, paused) is acknowledged at once.
-- Requests only escalate: pause < cancel < kill.
CREATE FUNCTION public.request_agent_run_control(
  p_shop uuid, p_actor uuid, p_run uuid, p_kind text, p_reason text, p_system boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r public.custom_agent_runs; v_role text; v_rank integer; v_cur integer; v_unknown integer; v_state text;
BEGIN
  PERFORM public.agent_run_require_service();
  IF p_shop IS NULL OR p_run IS NULL OR p_kind IS NULL OR p_kind NOT IN ('pause', 'cancel', 'kill')
     OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 200
     OR p_system IS NULL OR (p_system AND (p_actor IS NOT NULL OR p_kind = 'cancel'))
     OR (NOT p_system AND p_actor IS NULL) THEN
    RAISE EXCEPTION 'Invalid control request' USING ERRCODE = '22023';
  END IF;
  IF NOT p_system THEN
    v_role := public.agent_definition_actor_role(p_shop, p_actor);
    IF v_role IS NULL OR (p_kind = 'pause' AND v_role NOT IN ('owner', 'manager')) OR (p_kind <> 'pause' AND v_role <> 'owner') THEN
      RAISE EXCEPTION 'Not authorized to control this run' USING ERRCODE = '42501';
    END IF;
  END IF;
  SELECT * INTO r FROM public.custom_agent_runs WHERE id = p_run AND shop_id = p_shop FOR UPDATE;
  IF NOT FOUND OR r.definition_revision IS NULL THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  IF r.state IN ('succeeded', 'skipped', 'failed', 'cancelled', 'killed') THEN
    RETURN jsonb_build_object('outcome', 'already_terminal', 'state', r.state);
  END IF;
  v_rank := CASE p_kind WHEN 'pause' THEN 1 WHEN 'cancel' THEN 2 ELSE 3 END;
  v_cur := CASE r.control_request WHEN 'pause' THEN 1 WHEN 'cancel' THEN 2 WHEN 'kill' THEN 3 ELSE 0 END;
  IF r.control_request IS NOT NULL AND v_cur >= v_rank THEN
    RETURN jsonb_build_object('outcome', 'unchanged', 'state', r.state, 'control', r.control_request,
                              'acknowledged', r.control_acked_at IS NOT NULL);
  END IF;

  UPDATE public.custom_agent_runs
     SET control_request = p_kind, control_requested_at = clock_timestamp(),
         control_requested_by = p_actor, control_reason = btrim(p_reason),
         control_acked_at = NULL, control_acked_by = NULL
   WHERE id = r.id;
  PERFORM public.agent_run_emit(r.shop_id, r.id, p_kind || '_requested',
    CASE WHEN p_system THEN 'system' ELSE 'human' END, p_actor, jsonb_build_object('reason', left(btrim(p_reason), 200)));

  -- Tell any in-flight attempt that stopping was asked for (requested is not confirmed).
  UPDATE public.agent_run_attempts SET cancel_state = 'requested', cancel_requested_at = clock_timestamp()
   WHERE run_id = r.id AND state = 'started' AND p_kind IN ('cancel', 'kill') AND cancel_state = 'none';

  IF p_kind = 'kill' THEN
    v_unknown := public.agent_run_mark_inflight_unknown(r.id, 'kill_requested');
    PERFORM public.agent_run_close_open(r.id, 'run_killed');
    IF v_unknown > 0 OR EXISTS (SELECT 1 FROM public.agent_run_commands WHERE run_id = r.id AND state = 'unknown') THEN
      -- Nothing more can start, but a provider outcome is unconfirmed: the truthful state is unknown.
      -- The kill is recorded and acknowledged; reconciliation later finalizes the run as killed.
      UPDATE public.custom_agent_runs
         SET state = 'unknown', fired = false, reason = 'Killed while an external attempt was in flight; its outcome is unconfirmed.',
             wait_reason = 'reconciliation_required', error_code = 'killed_in_flight',
             finished_at = clock_timestamp(), lease_expires_at = NULL,
             control_acked_at = clock_timestamp(), control_acked_by = 'database'
       WHERE id = r.id;
      v_state := 'unknown';
    ELSE
      UPDATE public.custom_agent_runs
         SET state = 'killed', fired = false, reason = 'Killed by request.', wait_reason = NULL, error_code = NULL,
             finished_at = clock_timestamp(), lease_expires_at = NULL,
             control_acked_at = clock_timestamp(), control_acked_by = 'database'
       WHERE id = r.id;
      v_state := 'killed';
    END IF;
    PERFORM public.agent_run_emit(r.shop_id, r.id, 'kill_acknowledged', 'database', NULL, jsonb_build_object('run_state', v_state));
    RETURN jsonb_build_object('outcome', 'acknowledged', 'control', 'kill', 'state', v_state, 'attempts_made_unknown', v_unknown);
  END IF;

  IF r.state IN ('waiting', 'paused') THEN
    -- No live worker holds this run: the database acknowledges now.
    IF p_kind = 'cancel' THEN
      PERFORM public.agent_run_close_open(r.id, 'run_cancelled');
      UPDATE public.custom_agent_runs
         SET state = 'cancelled', fired = false, reason = 'Cancelled by request.', wait_reason = NULL, error_code = NULL,
             finished_at = clock_timestamp(), lease_expires_at = NULL,
             control_acked_at = clock_timestamp(), control_acked_by = 'database'
       WHERE id = r.id;
      PERFORM public.agent_run_emit(r.shop_id, r.id, 'cancel_acknowledged', 'database', NULL, '{}'::jsonb);
      RETURN jsonb_build_object('outcome', 'acknowledged', 'control', 'cancel', 'state', 'cancelled');
    END IF;
    UPDATE public.custom_agent_runs
       SET state = 'paused', wait_reason = 'paused', control_acked_at = clock_timestamp(), control_acked_by = 'database'
     WHERE id = r.id;
    PERFORM public.agent_run_emit(r.shop_id, r.id, 'pause_acknowledged', 'database', NULL, '{}'::jsonb);
    RETURN jsonb_build_object('outcome', 'acknowledged', 'control', 'pause', 'state', 'paused');
  END IF;

  -- running or unknown: a live worker acknowledges at a boundary; an unknown run applies it on reconciliation.
  RETURN jsonb_build_object('outcome', 'requested', 'control', p_kind, 'state', r.state);
END $$;

-- A live worker acknowledges a pending pause or cancel at a safe boundary. It cannot do so while an
-- attempt is still in flight (the attempt's outcome must be recorded first).
CREATE FUNCTION public.acknowledge_agent_run_control(
  p_run uuid, p_worker uuid, p_attempt integer, p_ack text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.custom_agent_runs;
BEGIN
  PERFORM public.agent_run_require_service();
  IF p_run IS NULL OR p_worker IS NULL OR p_attempt IS NULL OR p_attempt < 1 OR p_ack IS NULL OR p_ack NOT IN ('pause', 'cancel') THEN
    RAISE EXCEPTION 'Invalid acknowledgement' USING ERRCODE = '22023';
  END IF;
  r := public.agent_run_owned(p_run, p_worker, p_attempt);
  IF r.id IS NULL THEN RETURN jsonb_build_object('outcome', 'refused', 'reason', 'run_not_owned'); END IF;
  IF r.control_request IS DISTINCT FROM p_ack OR r.control_acked_at IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reason', 'no_matching_request');
  END IF;
  IF EXISTS (SELECT 1 FROM public.agent_run_attempts WHERE run_id = r.id AND state = 'started') THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reason', 'attempt_in_flight');
  END IF;
  IF p_ack = 'cancel' THEN
    PERFORM public.agent_run_close_open(r.id, 'run_cancelled');
    UPDATE public.custom_agent_runs
       SET state = 'cancelled', fired = false, reason = 'Cancelled by request.', wait_reason = NULL, error_code = NULL,
           finished_at = clock_timestamp(), lease_expires_at = NULL,
           control_acked_at = clock_timestamp(), control_acked_by = 'worker'
     WHERE id = r.id;
    PERFORM public.agent_run_emit(r.shop_id, r.id, 'cancel_acknowledged', 'worker', NULL, '{}'::jsonb);
    RETURN jsonb_build_object('outcome', 'acknowledged', 'state', 'cancelled');
  END IF;
  UPDATE public.agent_run_steps SET state = 'abandoned', finished_at = clock_timestamp() WHERE run_id = r.id AND state = 'running';
  IF NOT EXISTS (SELECT 1 FROM public.agent_run_waits WHERE run_id = r.id AND state = 'open') THEN
    INSERT INTO public.agent_run_waits (shop_id, run_id, kind, reason, due_at)
    VALUES (r.shop_id, r.id, 'restart_recovery', 'restart_recovery', clock_timestamp());
  END IF;
  UPDATE public.custom_agent_runs
     SET state = 'paused', wait_reason = 'paused', lease_expires_at = NULL,
         control_acked_at = clock_timestamp(), control_acked_by = 'worker'
   WHERE id = r.id;
  PERFORM public.agent_run_emit(r.shop_id, r.id, 'pause_acknowledged', 'worker', NULL, '{}'::jsonb);
  RETURN jsonb_build_object('outcome', 'acknowledged', 'state', 'paused');
END $$;

-- A person lets a paused run continue. It becomes waiting; the resume claim picks it up.
CREATE FUNCTION public.resume_paused_agent_run(p_shop uuid, p_actor uuid, p_run uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.custom_agent_runs;
BEGIN
  PERFORM public.agent_run_require_service();
  IF p_shop IS NULL OR p_actor IS NULL OR p_run IS NULL THEN RAISE EXCEPTION 'Invalid resume' USING ERRCODE = '22023'; END IF;
  IF public.agent_definition_actor_role(p_shop, p_actor) NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'Not authorized to control this run' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO r FROM public.custom_agent_runs WHERE id = p_run AND shop_id = p_shop FOR UPDATE;
  IF NOT FOUND OR r.definition_revision IS NULL THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
  IF r.state <> 'paused' THEN RETURN jsonb_build_object('outcome', 'not_paused', 'state', r.state); END IF;
  -- A paused run keeps whatever it was waiting for; with nothing open it resumes from its evidence.
  IF NOT EXISTS (SELECT 1 FROM public.agent_run_waits WHERE run_id = r.id AND state = 'open') THEN
    INSERT INTO public.agent_run_waits (shop_id, run_id, kind, reason, due_at)
    VALUES (r.shop_id, r.id, 'restart_recovery', 'restart_recovery', clock_timestamp());
  END IF;
  UPDATE public.custom_agent_runs
     SET state = 'waiting', wait_reason = 'resume_requested', control_request = NULL, control_requested_at = NULL,
         control_requested_by = NULL, control_reason = NULL, control_acked_at = NULL, control_acked_by = NULL
   WHERE id = r.id;
  PERFORM public.agent_run_emit(r.shop_id, r.id, 'resumed_by_request', 'human', p_actor, '{}'::jsonb);
  RETURN jsonb_build_object('outcome', 'resumed', 'state', 'waiting');
END $$;

-- ---------------------------------------------------------------------------
-- 9. Waits and resume
-- ---------------------------------------------------------------------------
-- The worker hands the run back until something it names happens. Releases the lease (no worker holds
-- a waiting run). Refused while an attempt is in flight or a stop request is pending.
CREATE FUNCTION public.park_agent_run_wait(
  p_run uuid, p_worker uuid, p_attempt integer, p_step_key text, p_kind text, p_reason text,
  p_due_at timestamptz DEFAULT NULL, p_owner uuid DEFAULT NULL, p_escalate_at timestamptz DEFAULT NULL,
  p_escalate_to text DEFAULT NULL, p_ref_kind text DEFAULT 'none', p_ref_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.custom_agent_runs; s public.agent_run_steps; w public.agent_run_waits;
BEGIN
  PERFORM public.agent_run_require_service();
  IF p_run IS NULL OR p_worker IS NULL OR p_attempt IS NULL OR p_attempt < 1 OR p_step_key IS NULL
     OR p_kind IS NULL OR p_kind NOT IN ('approval', 'customer_reply', 'time_window', 'connector', 'dependency')
     OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 160
     OR p_ref_kind IS NULL OR p_ref_kind NOT IN ('none', 'pending_action', 'customer')
     OR (p_ref_kind = 'none') <> (p_ref_id IS NULL)
     OR (p_escalate_to IS NOT NULL AND p_escalate_to NOT IN ('owner', 'manager'))
     OR (p_escalate_at IS NOT NULL AND p_escalate_to IS NULL)
     OR (p_due_at IS NOT NULL AND (p_due_at <= clock_timestamp() - interval '1 minute' OR p_due_at > clock_timestamp() + interval '90 days'))
     OR (p_escalate_at IS NOT NULL AND (p_escalate_at <= clock_timestamp() - interval '1 minute' OR p_escalate_at > clock_timestamp() + interval '90 days'))
     OR (p_kind IN ('approval') AND p_ref_kind <> 'pending_action')
     OR (p_kind IN ('time_window') AND p_due_at IS NULL)
     OR (p_due_at IS NULL AND p_ref_kind = 'none' AND p_kind NOT IN ('customer_reply', 'connector', 'dependency')) THEN
    RAISE EXCEPTION 'Invalid wait' USING ERRCODE = '22023';
  END IF;
  r := public.agent_run_owned(p_run, p_worker, p_attempt);
  IF r.id IS NULL THEN RETURN jsonb_build_object('outcome', 'refused', 'reasons', jsonb_build_array('run_not_owned')); END IF;
  IF r.definition_revision IS NULL THEN RETURN jsonb_build_object('outcome', 'refused', 'reasons', jsonb_build_array('run_not_governed')); END IF;
  IF r.control_request IS NOT NULL AND r.control_acked_at IS NULL THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reasons', jsonb_build_array(r.control_request || '_requested'));
  END IF;
  IF EXISTS (SELECT 1 FROM public.agent_run_attempts WHERE run_id = r.id AND state = 'started')
     OR EXISTS (SELECT 1 FROM public.agent_run_commands WHERE run_id = r.id AND state IN ('in_flight', 'unknown')) THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reasons', jsonb_build_array('attempt_in_flight'));
  END IF;
  SELECT * INTO s FROM public.agent_run_steps WHERE run_id = r.id AND step_key = p_step_key FOR UPDATE;
  IF NOT FOUND OR s.state <> 'running' THEN RETURN jsonb_build_object('outcome', 'refused', 'reasons', jsonb_build_array('step_not_running')); END IF;
  -- Typed links are tenant-checked here: a wait can only point at this workspace's own records.
  IF p_ref_kind = 'pending_action' AND NOT EXISTS (SELECT 1 FROM public.pending_actions WHERE id = p_ref_id AND shop_id = r.shop_id) THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reasons', jsonb_build_array('ref_not_found'));
  END IF;
  IF p_ref_kind = 'customer' AND NOT EXISTS (SELECT 1 FROM public.customers WHERE id = p_ref_id AND shop_id = r.shop_id) THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reasons', jsonb_build_array('ref_not_found'));
  END IF;
  IF p_owner IS NOT NULL AND public.agent_definition_actor_role(r.shop_id, p_owner) IS NULL THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reasons', jsonb_build_array('owner_not_a_member'));
  END IF;
  IF EXISTS (SELECT 1 FROM public.agent_run_waits WHERE run_id = r.id AND state = 'open') THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reasons', jsonb_build_array('wait_already_open'));
  END IF;
  INSERT INTO public.agent_run_waits (shop_id, run_id, step_id, kind, reason, due_at, owner_user_id, escalate_at,
                                      escalate_to, ref_kind, ref_id)
  VALUES (r.shop_id, r.id, s.id, p_kind, btrim(p_reason), p_due_at, p_owner, p_escalate_at, p_escalate_to,
          p_ref_kind, p_ref_id)
  RETURNING * INTO w;
  UPDATE public.agent_run_steps SET state = 'waiting' WHERE id = s.id;
  UPDATE public.custom_agent_runs SET state = 'waiting', wait_reason = left(btrim(p_reason), 160), lease_expires_at = NULL
   WHERE id = r.id;
  PERFORM public.agent_run_emit(r.shop_id, r.id, 'waiting', 'worker', NULL,
    jsonb_build_object('wait_id', w.id, 'kind', p_kind, 'due_at', p_due_at));
  RETURN jsonb_build_object('outcome', 'waiting', 'wait_id', w.id);
END $$;

-- An external event satisfies a (non-reconciliation) wait, e.g. the customer replied.
CREATE FUNCTION public.resolve_agent_run_wait(p_wait uuid, p_resolution text, p_evidence jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE w public.agent_run_waits; r public.custom_agent_runs;
BEGIN
  PERFORM public.agent_run_require_service();
  IF p_wait IS NULL OR p_resolution IS NULL OR p_resolution NOT IN ('satisfied', 'expired')
     OR p_evidence IS NULL OR jsonb_typeof(p_evidence) <> 'object' OR octet_length(p_evidence::text) > 4096 THEN
    RAISE EXCEPTION 'Invalid wait resolution' USING ERRCODE = '22023';
  END IF;
  SELECT run_id INTO w.run_id FROM public.agent_run_waits WHERE id = p_wait;
  IF w.run_id IS NULL THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
  SELECT * INTO r FROM public.custom_agent_runs WHERE id = w.run_id FOR UPDATE;
  SELECT * INTO w FROM public.agent_run_waits WHERE id = p_wait FOR UPDATE;
  IF w.kind = 'reconciliation' THEN RETURN jsonb_build_object('outcome', 'refused', 'reason', 'reconciliation_is_human'); END IF;
  IF w.state <> 'open' THEN RETURN jsonb_build_object('outcome', 'unchanged', 'state', w.state); END IF;
  UPDATE public.agent_run_waits SET state = p_resolution, resolved_at = clock_timestamp(), resolution = 'external_event', evidence = p_evidence
   WHERE id = w.id;
  -- Satisfied: the run is resumable now (due immediately) via a restart marker only if it is waiting.
  IF r.state = 'waiting' THEN
    INSERT INTO public.agent_run_waits (shop_id, run_id, kind, reason, due_at)
    VALUES (r.shop_id, r.id, 'restart_recovery', 'resume_after_' || w.kind, clock_timestamp());
  END IF;
  PERFORM public.agent_run_emit(r.shop_id, r.id, 'wait_' || p_resolution, 'system', NULL, jsonb_build_object('wait_id', w.id, 'kind', w.kind));
  RETURN jsonb_build_object('outcome', 'resolved');
END $$;

-- The resume claim: the SAME lease / attempt compare-and-set as the window claim, for a run that is
-- waiting (approval decided, due time reached, restart recovery, resumed by a person). It re-validates
-- the exact binding, honours the definition's concurrency ceiling and bumps `attempt`, which fences out
-- any zombie holder of an older lease. A run whose binding broke while it waited FAILS (known state),
-- it does not silently run under another revision.
CREATE FUNCTION public.claim_resumable_agent_run(
  p_worker uuid, p_lease_seconds integer DEFAULT 120, p_agent uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  cand record; v_agent public.custom_agents; r public.custom_agent_runs; w public.agent_run_waits;
  v_reasons text[]; v_running integer; v_resolution text;
BEGIN
  PERFORM public.agent_run_require_service();
  IF p_worker IS NULL OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 900 THEN
    RAISE EXCEPTION 'Invalid resume claim' USING ERRCODE = '22023';
  END IF;
  FOR cand IN
    SELECT x.id AS run_id, x.agent_id FROM public.custom_agent_runs x
     WHERE x.state = 'waiting' AND x.definition_revision IS NOT NULL AND (p_agent IS NULL OR x.agent_id = p_agent)
       AND EXISTS (SELECT 1 FROM public.agent_run_waits ww WHERE ww.run_id = x.id AND public.agent_run_wait_ready(ww))
     ORDER BY x.started_at, x.id LIMIT 25
  LOOP
    SELECT * INTO v_agent FROM public.custom_agents WHERE id = cand.agent_id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN CONTINUE; END IF;
    SELECT * INTO r FROM public.custom_agent_runs WHERE id = cand.run_id AND state = 'waiting' FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN CONTINUE; END IF;
    SELECT * INTO w FROM public.agent_run_waits ww WHERE ww.run_id = r.id AND ww.state = 'open' FOR UPDATE;
    IF NOT FOUND OR NOT public.agent_run_wait_ready(w) THEN CONTINUE; END IF;

    v_reasons := public.agent_run_binding_reasons(r);
    IF cardinality(v_reasons) > 0 THEN
      -- Known, final, and never executed under a different binding.
      PERFORM public.agent_run_close_open(r.id, 'binding_not_current');
      UPDATE public.custom_agent_runs
         SET state = 'failed', fired = false, reason = left('The bound definition is no longer current: ' || array_to_string(v_reasons, ', '), 1000),
             error_code = 'binding_not_current', wait_reason = NULL, finished_at = clock_timestamp(),
             lease_expires_at = NULL, binding_at_finish = left(array_to_string(v_reasons, ','), 300)
       WHERE id = r.id;
      PERFORM public.agent_run_emit(r.shop_id, r.id, 'resume_refused', 'database', NULL, jsonb_build_object('reasons', to_jsonb(v_reasons)));
      CONTINUE;
    END IF;
    SELECT count(*)::integer INTO v_running FROM public.custom_agent_runs WHERE agent_id = r.agent_id AND state = 'running';
    IF v_running >= (r.definition_snapshot #>> '{limits,maximumConcurrentRuns}')::integer THEN CONTINUE; END IF;

    v_resolution := CASE WHEN w.kind = 'restart_recovery' THEN 'resumed'
                         WHEN w.ref_kind = 'pending_action' AND EXISTS (
                           SELECT 1 FROM public.pending_actions pa WHERE pa.id = w.ref_id AND pa.shop_id = w.shop_id
                              AND pa.status::text IN ('approved', 'rejected')) THEN 'satisfied'
                         ELSE 'expired' END;
    UPDATE public.agent_run_waits
       SET state = CASE WHEN v_resolution = 'expired' THEN 'expired' ELSE 'satisfied' END,
           resolved_at = clock_timestamp(), resolution = v_resolution
     WHERE id = w.id;
    UPDATE public.custom_agent_runs
       SET state = 'running', attempt = attempt + 1, worker_id = p_worker,
           lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
           lease_started_at = clock_timestamp(), last_heartbeat_at = clock_timestamp(), finished_at = NULL,
           wait_reason = NULL, error_code = NULL,
           control_request = CASE WHEN control_request = 'pause' THEN NULL ELSE control_request END,
           control_requested_at = CASE WHEN control_request = 'pause' THEN NULL ELSE control_requested_at END,
           control_requested_by = CASE WHEN control_request = 'pause' THEN NULL ELSE control_requested_by END,
           control_reason = CASE WHEN control_request = 'pause' THEN NULL ELSE control_reason END,
           control_acked_at = CASE WHEN control_request = 'pause' THEN NULL ELSE control_acked_at END,
           control_acked_by = CASE WHEN control_request = 'pause' THEN NULL ELSE control_acked_by END
     WHERE id = r.id
     RETURNING * INTO r;
    PERFORM public.agent_run_emit(r.shop_id, r.id, 'resumed', 'worker', NULL,
      jsonb_build_object('run_attempt', r.attempt, 'wait_kind', w.kind, 'resolution', v_resolution));
    RETURN jsonb_build_object(
      'outcome', 'claimed', 'resumed', true, 'run_id', r.id, 'attempt', r.attempt, 'shop_id', r.shop_id,
      'agent_id', r.agent_id, 'definition_snapshot', r.definition_snapshot, 'definition_hash', r.definition_hash,
      'policy_revision', r.policy_revision, 'knowledge_revision', r.knowledge_revision, 'governed', true,
      'definition_revision', r.definition_revision, 'evaluation_id', r.evaluation_id, 'memory_pins', r.memory_pins,
      'activation_event_seq', r.activation_event_seq, 'wait_kind', w.kind, 'wait_resolution', v_resolution,
      'wait_ref_kind', w.ref_kind, 'wait_ref_id', w.ref_id);
  END LOOP;
  RETURN jsonb_build_object('outcome', 'none');
END $$;

-- ---------------------------------------------------------------------------
-- 10. Stale-lease recovery sweep (restart recovery) and wait escalation
-- ---------------------------------------------------------------------------
-- For every governed run whose lease expired: classify by evidence (see agent_run_recover_one). Also
-- marks overdue escalations once. Idempotent and safe to run from any number of instances.
CREATE FUNCTION public.recover_stale_agent_runs(p_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.custom_agent_runs; v_out text; v_counts jsonb := '{}'::jsonb; v_escalated integer := 0; w record;
BEGIN
  PERFORM public.agent_run_require_service();
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Invalid limit' USING ERRCODE = '22023'; END IF;
  FOR r IN
    SELECT * FROM public.custom_agent_runs
     WHERE state = 'running' AND definition_revision IS NOT NULL AND lease_expires_at <= clock_timestamp()
     ORDER BY lease_expires_at, id LIMIT p_limit FOR UPDATE SKIP LOCKED
  LOOP
    v_out := public.agent_run_recover_one(r, 'recovery');
    v_counts := jsonb_set(v_counts, ARRAY[v_out], to_jsonb(coalesce((v_counts ->> v_out)::integer, 0) + 1));
  END LOOP;
  FOR w IN
    SELECT id, shop_id, run_id, kind FROM public.agent_run_waits
     WHERE state = 'open' AND escalate_at IS NOT NULL AND escalate_at <= clock_timestamp() AND escalated_at IS NULL
     ORDER BY escalate_at LIMIT p_limit FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.agent_run_waits SET escalated_at = clock_timestamp() WHERE id = w.id;
    PERFORM public.agent_run_emit(w.shop_id, w.run_id, 'wait_escalated', 'recovery', NULL, jsonb_build_object('wait_id', w.id, 'kind', w.kind));
    v_escalated := v_escalated + 1;
  END LOOP;
  RETURN jsonb_build_object('recovered', v_counts, 'escalated', v_escalated);
END $$;

-- ---------------------------------------------------------------------------
-- 11. Human reconciliation of an unknown outcome
-- ---------------------------------------------------------------------------
-- Only an owner or manager. `effect_confirmed` and `no_effect_confirmed` both need a written evidence
-- note; only a confirmed non-effect makes the command eligible for a NEW admitted attempt. When no
-- unknown command remains the run becomes resumable (or finishes the stop that was requested).
CREATE FUNCTION public.resolve_agent_command_reconciliation(
  p_shop uuid, p_actor uuid, p_command uuid, p_resolution text,
  p_provider_ref text DEFAULT NULL, p_evidence jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  c public.agent_run_commands; r public.custom_agent_runs; a public.agent_run_attempts; v_role text; v_left integer;
BEGIN
  PERFORM public.agent_run_require_service();
  IF p_shop IS NULL OR p_actor IS NULL OR p_command IS NULL
     OR p_resolution IS NULL OR p_resolution NOT IN ('effect_confirmed', 'no_effect_confirmed', 'cannot_determine')
     OR (p_provider_ref IS NOT NULL AND length(p_provider_ref) NOT BETWEEN 1 AND 200)
     OR p_evidence IS NULL OR jsonb_typeof(p_evidence) <> 'object' OR octet_length(p_evidence::text) > 4096
     OR length(coalesce(p_evidence ->> 'note', '')) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'Invalid reconciliation' USING ERRCODE = '22023';
  END IF;
  v_role := public.agent_definition_actor_role(p_shop, p_actor);
  IF v_role IS NULL OR v_role NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'Not authorized to reconcile this command' USING ERRCODE = '42501';
  END IF;
  SELECT run_id INTO c.run_id FROM public.agent_run_commands WHERE id = p_command AND shop_id = p_shop;
  IF c.run_id IS NULL THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
  SELECT * INTO r FROM public.custom_agent_runs WHERE id = c.run_id AND shop_id = p_shop FOR UPDATE;
  SELECT * INTO c FROM public.agent_run_commands WHERE id = p_command FOR UPDATE;
  IF c.state <> 'unknown' THEN RETURN jsonb_build_object('outcome', 'not_unknown', 'state', c.state); END IF;
  SELECT * INTO a FROM public.agent_run_attempts WHERE command_id = c.id AND state = 'unknown' ORDER BY attempt_number DESC LIMIT 1 FOR UPDATE;

  IF p_resolution = 'cannot_determine' THEN
    PERFORM public.agent_run_emit(r.shop_id, r.id, 'reconciliation_inconclusive', 'human', p_actor,
      jsonb_build_object('command_id', c.id, 'note', left(p_evidence ->> 'note', 300)));
    RETURN jsonb_build_object('outcome', 'recorded_unresolved');
  END IF;
  IF p_resolution = 'effect_confirmed' THEN
    UPDATE public.agent_run_attempts SET state = 'confirmed_effect', evidence = evidence || jsonb_build_object('reconciled', true),
           provider_ref = coalesce(p_provider_ref, provider_ref) WHERE id = a.id;
    UPDATE public.agent_run_commands SET state = 'succeeded', provider_ref = coalesce(p_provider_ref, provider_ref),
           resolution = p_resolution, resolved_by = p_actor, resolved_at = clock_timestamp(),
           updated_at = clock_timestamp(), finished_at = clock_timestamp() WHERE id = c.id;
  ELSE
    UPDATE public.agent_run_attempts SET state = 'confirmed_no_effect', evidence = evidence || jsonb_build_object('reconciled', true) WHERE id = a.id;
    UPDATE public.agent_run_commands SET state = 'failed_before_effect', resolution = p_resolution, resolved_by = p_actor,
           resolved_at = clock_timestamp(), updated_at = clock_timestamp(), finished_at = clock_timestamp() WHERE id = c.id;
  END IF;
  PERFORM public.agent_run_emit(r.shop_id, r.id, 'reconciled', 'human', p_actor,
    jsonb_build_object('command_id', c.id, 'resolution', p_resolution, 'note', left(p_evidence ->> 'note', 300)));

  SELECT count(*)::integer INTO v_left FROM public.agent_run_commands WHERE run_id = r.id AND state = 'unknown';
  IF v_left > 0 THEN
    RETURN jsonb_build_object('outcome', 'resolved', 'remaining_unknown', v_left);
  END IF;
  UPDATE public.agent_run_waits SET state = 'satisfied', resolved_at = clock_timestamp(), resolved_by = p_actor, resolution = p_resolution
   WHERE run_id = r.id AND state = 'open' AND kind = 'reconciliation';
  IF r.state <> 'unknown' THEN RETURN jsonb_build_object('outcome', 'resolved', 'remaining_unknown', 0, 'run_state', r.state); END IF;

  IF r.control_request IN ('cancel', 'kill') THEN
    PERFORM public.agent_run_close_open(r.id, 'run_stopped');
    UPDATE public.custom_agent_runs
       SET state = CASE WHEN r.control_request = 'kill' THEN 'killed' ELSE 'cancelled' END, fired = false,
           reason = 'Stopped by request; the in-flight outcome was reconciled.', wait_reason = NULL, error_code = NULL,
           finished_at = clock_timestamp(), lease_expires_at = NULL,
           control_acked_at = coalesce(control_acked_at, clock_timestamp()),
           control_acked_by = coalesce(control_acked_by, 'reconciliation')
     WHERE id = r.id;
    RETURN jsonb_build_object('outcome', 'resolved', 'remaining_unknown', 0, 'run_state',
      CASE WHEN r.control_request = 'kill' THEN 'killed' ELSE 'cancelled' END);
  END IF;
  INSERT INTO public.agent_run_waits (shop_id, run_id, kind, reason, due_at)
  VALUES (r.shop_id, r.id, 'restart_recovery', 'restart_recovery', clock_timestamp());
  IF r.control_request = 'pause' THEN
    UPDATE public.custom_agent_runs SET state = 'paused', wait_reason = 'paused', error_code = NULL, finished_at = NULL,
           control_acked_at = clock_timestamp(), control_acked_by = 'reconciliation' WHERE id = r.id;
    RETURN jsonb_build_object('outcome', 'resolved', 'remaining_unknown', 0, 'run_state', 'paused');
  END IF;
  UPDATE public.custom_agent_runs SET state = 'waiting', wait_reason = 'restart_recovery', error_code = NULL, finished_at = NULL
   WHERE id = r.id;
  RETURN jsonb_build_object('outcome', 'resolved', 'remaining_unknown', 0, 'run_state', 'waiting');
END $$;

-- ---------------------------------------------------------------------------
-- 12. Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  public.agent_run_events_append_only(),
  public.agent_run_commands_identity_guard(),
  public.agent_run_require_service(),
  public.agent_run_emit(uuid, uuid, text, text, uuid, jsonb),
  public.agent_run_owned(uuid, uuid, integer),
  public.agent_run_binding_reasons(public.custom_agent_runs),
  public.agent_run_close_open(uuid, text),
  public.agent_run_mark_inflight_unknown(uuid, text),
  public.agent_run_recover_one(public.custom_agent_runs, text),
  public.agent_run_wait_ready(public.agent_run_waits)
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION
  public.heartbeat_agent_run(uuid, uuid, integer, integer),
  public.begin_agent_run_step(uuid, uuid, integer, text, text),
  public.finish_agent_run_step(uuid, uuid, integer, text, text, text, jsonb),
  public.register_agent_command(uuid, uuid, integer, text, text, text, text, text, integer, uuid, boolean, text),
  public.begin_agent_command_attempt(uuid, uuid, integer, uuid, jsonb),
  public.record_agent_attempt_result(uuid, uuid, integer, uuid, text, text, text, jsonb, text),
  public.request_agent_run_control(uuid, uuid, uuid, text, text, boolean),
  public.acknowledge_agent_run_control(uuid, uuid, integer, text),
  public.resume_paused_agent_run(uuid, uuid, uuid),
  public.park_agent_run_wait(uuid, uuid, integer, text, text, text, timestamptz, uuid, timestamptz, text, text, uuid),
  public.resolve_agent_run_wait(uuid, text, jsonb),
  public.claim_resumable_agent_run(uuid, integer, uuid),
  public.recover_stale_agent_runs(integer),
  public.resolve_agent_command_reconciliation(uuid, uuid, uuid, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.heartbeat_agent_run(uuid, uuid, integer, integer),
  public.begin_agent_run_step(uuid, uuid, integer, text, text),
  public.finish_agent_run_step(uuid, uuid, integer, text, text, text, jsonb),
  public.register_agent_command(uuid, uuid, integer, text, text, text, text, text, integer, uuid, boolean, text),
  public.begin_agent_command_attempt(uuid, uuid, integer, uuid, jsonb),
  public.record_agent_attempt_result(uuid, uuid, integer, uuid, text, text, text, jsonb, text),
  public.request_agent_run_control(uuid, uuid, uuid, text, text, boolean),
  public.acknowledge_agent_run_control(uuid, uuid, integer, text),
  public.resume_paused_agent_run(uuid, uuid, uuid),
  public.park_agent_run_wait(uuid, uuid, integer, text, text, text, timestamptz, uuid, timestamptz, text, text, uuid),
  public.resolve_agent_run_wait(uuid, text, jsonb),
  public.claim_resumable_agent_run(uuid, integer, uuid),
  public.recover_stale_agent_runs(integer),
  public.resolve_agent_command_reconciliation(uuid, uuid, uuid, text, text, jsonb)
  TO service_role;

-- Re-declared functions keep their existing grants; restate the end state explicitly.
REVOKE ALL ON FUNCTION public.claim_scheduled_agent_run(uuid, text, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_scheduled_agent_run(uuid, uuid, integer, text, boolean, text, jsonb, uuid[], text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_scheduled_agent_run_unknown(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_scheduled_agent_run(uuid, text, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_scheduled_agent_run(uuid, uuid, integer, text, boolean, text, jsonb, uuid[], text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_scheduled_agent_run_unknown(uuid) TO service_role;

COMMIT;
