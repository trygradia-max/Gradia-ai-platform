BEGIN;
-- Build 1: immutable Gradia Agent definition revisions + one atomic active pointer
-- per existing `custom_agents` identity.
--
--  * `custom_agents` stays the agent identity/runtime spine. Nothing here creates a
--    second agent/employee schema, executor, policy engine, memory store or billing gate.
--  * agent_definition_revisions    immutable; every save is a new revision with lineage.
--  * agent_definition_memory_pins  immutable; the exact reviewed memory revisions a
--                                  revision was authored against.
--  * agent_definition_evaluations  append-only exact-revision evaluation evidence
--                                  written ONLY by the trusted-evaluator seam.
--  * agent_definition_events       append-only pointer / lifecycle history.
--  * agent_definition_state        the ONE mutable row per agent: lifecycle + pointer.
--
-- Authority: every writer is service-role-only, names the actor, and re-verifies a
-- LIVE OWNER of that exact shop in the database. Browser roles have no table privilege
-- and no function privilege. Activation composes the merged `commercial_agent_activate`
-- (catalog, owner, Founder Pilot evidence, two-active-agent cap) inside ONE transaction.
--
-- This migration adds objects, re-declares two existing guard/claim functions, and adds
-- two triggers. It does not rewrite, backfill or alter any existing row: legacy agents
-- have no state row and are reported `legacy_unversioned`.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE public.agent_definition_state (
  agent_id uuid PRIMARY KEY,
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  lifecycle text NOT NULL DEFAULT 'draft' CHECK (lifecycle IN ('draft', 'active', 'paused', 'blocked')),
  active_revision integer,
  latest_revision integer NOT NULL DEFAULT 0 CHECK (latest_revision >= 0),
  lifecycle_reason text CHECK (lifecycle_reason IS NULL OR length(lifecycle_reason) BETWEEN 1 AND 200),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (shop_id, agent_id),
  FOREIGN KEY (shop_id, agent_id) REFERENCES public.custom_agents(shop_id, id) ON DELETE CASCADE,
  CHECK ((lifecycle = 'draft') = (active_revision IS NULL)),
  CHECK (active_revision IS NULL OR active_revision <= latest_revision)
);

CREATE TABLE public.agent_definition_revisions (
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  parent_revision integer,
  schema_version integer NOT NULL CHECK (schema_version = 1),
  definition jsonb NOT NULL,
  definition_hash text NOT NULL CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
  request_id uuid NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  authored_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (agent_id, revision),
  UNIQUE (shop_id, agent_id, revision),
  UNIQUE (shop_id, agent_id, revision, definition_hash),
  UNIQUE (agent_id, request_id),
  FOREIGN KEY (shop_id, agent_id) REFERENCES public.custom_agents(shop_id, id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id, parent_revision) REFERENCES public.agent_definition_revisions(agent_id, revision),
  CHECK (parent_revision IS NULL OR parent_revision < revision),
  CHECK (jsonb_typeof(definition) = 'object' AND octet_length(definition::text) <= 32768),
  CHECK (definition -> 'schemaVersion' = to_jsonb(schema_version)),
  CHECK (definition -> 'revision' = to_jsonb(revision)),
  -- A stored revision is never "active": activation is a pointer, not an edit.
  CHECK (definition ->> 'lifecycle' = 'draft')
);

ALTER TABLE public.agent_definition_state
  ADD CONSTRAINT agent_definition_state_active_revision_fkey
  FOREIGN KEY (shop_id, agent_id, active_revision)
  REFERENCES public.agent_definition_revisions(shop_id, agent_id, revision);

CREATE TABLE public.agent_definition_memory_pins (
  shop_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  revision integer NOT NULL,
  source_id uuid NOT NULL,
  memory_revision integer NOT NULL CHECK (memory_revision > 0),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  pinned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (agent_id, revision, source_id),
  -- Cascade is only ever reachable through tenant deletion: the append-only trigger
  -- refuses every other DELETE.
  FOREIGN KEY (shop_id, agent_id, revision)
    REFERENCES public.agent_definition_revisions(shop_id, agent_id, revision) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, source_id, memory_revision)
    REFERENCES public.reviewed_memory_revisions(shop_id, source_id, revision)
);

CREATE TABLE public.agent_definition_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  revision integer NOT NULL,
  definition_hash text NOT NULL,
  evaluation_key text NOT NULL CHECK (length(evaluation_key) BETWEEN 1 AND 120),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  suite_version text NOT NULL CHECK (length(suite_version) BETWEEN 1 AND 80),
  fixture_set_id text NOT NULL CHECK (length(fixture_set_id) BETWEEN 1 AND 120),
  fixture_hash text NOT NULL CHECK (fixture_hash ~ '^[0-9a-f]{64}$'),
  pass_rate numeric(5, 4) NOT NULL CHECK (pass_rate BETWEEN 0 AND 1),
  safety_passed boolean NOT NULL,
  estimated_credits integer NOT NULL CHECK (estimated_credits >= 0),
  cost_evidence jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(cost_evidence) = 'object' AND octet_length(cost_evidence::text) <= 4096),
  completed_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source = 'trusted_evaluator'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (agent_id, revision, evaluation_key),
  FOREIGN KEY (shop_id, agent_id, revision, definition_hash)
    REFERENCES public.agent_definition_revisions(shop_id, agent_id, revision, definition_hash) ON DELETE CASCADE,
  CHECK (completed_at <= recorded_at + interval '5 minutes')
);

CREATE TABLE public.agent_definition_events (
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  seq integer NOT NULL CHECK (seq > 0),
  kind text NOT NULL CHECK (kind IN ('revision_created', 'activated', 'superseded', 'paused', 'blocked')),
  revision integer,
  from_revision integer,
  actor_id uuid REFERENCES auth.users(id),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(evidence) = 'object' AND octet_length(evidence::text) <= 16384),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (agent_id, seq),
  FOREIGN KEY (shop_id, agent_id) REFERENCES public.custom_agents(shop_id, id) ON DELETE CASCADE
);

CREATE INDEX agent_definition_revisions_shop_idx
  ON public.agent_definition_revisions (shop_id, agent_id, revision DESC);
CREATE INDEX agent_definition_evaluations_latest_idx
  ON public.agent_definition_evaluations (agent_id, revision, completed_at DESC);

-- ---------------------------------------------------------------------------
-- Privileges: RLS on, no browser access of any kind, service role reads only.
-- ---------------------------------------------------------------------------
ALTER TABLE public.agent_definition_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_definition_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_definition_memory_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_definition_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_definition_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.agent_definition_state, public.agent_definition_revisions,
  public.agent_definition_memory_pins, public.agent_definition_evaluations,
  public.agent_definition_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.agent_definition_state, public.agent_definition_revisions,
  public.agent_definition_memory_pins, public.agent_definition_evaluations,
  public.agent_definition_events TO service_role;

-- ---------------------------------------------------------------------------
-- Guards: append-only history; the state row is a guarded mutable pointer.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.agent_definition_append_only() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'Agent definition history cannot be truncated' USING ERRCODE='42501';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Agent definition history is immutable; save a new revision' USING ERRCODE='42501';
  END IF;
  -- Only the tenant-deletion cascade may remove history.
  IF EXISTS (SELECT 1 FROM public.shops WHERE id = OLD.shop_id) THEN
    RAISE EXCEPTION 'Agent definition history cannot be deleted' USING ERRCODE='42501';
  END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER agent_definition_revisions_append_only BEFORE UPDATE OR DELETE ON public.agent_definition_revisions
  FOR EACH ROW EXECUTE FUNCTION public.agent_definition_append_only();
CREATE TRIGGER agent_definition_memory_pins_append_only BEFORE UPDATE OR DELETE ON public.agent_definition_memory_pins
  FOR EACH ROW EXECUTE FUNCTION public.agent_definition_append_only();
CREATE TRIGGER agent_definition_evaluations_append_only BEFORE UPDATE OR DELETE ON public.agent_definition_evaluations
  FOR EACH ROW EXECUTE FUNCTION public.agent_definition_append_only();
CREATE TRIGGER agent_definition_events_append_only BEFORE UPDATE OR DELETE ON public.agent_definition_events
  FOR EACH ROW EXECUTE FUNCTION public.agent_definition_append_only();
CREATE TRIGGER agent_definition_revisions_no_truncate BEFORE TRUNCATE ON public.agent_definition_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION public.agent_definition_append_only();
CREATE TRIGGER agent_definition_memory_pins_no_truncate BEFORE TRUNCATE ON public.agent_definition_memory_pins
  FOR EACH STATEMENT EXECUTE FUNCTION public.agent_definition_append_only();
CREATE TRIGGER agent_definition_evaluations_no_truncate BEFORE TRUNCATE ON public.agent_definition_evaluations
  FOR EACH STATEMENT EXECUTE FUNCTION public.agent_definition_append_only();
CREATE TRIGGER agent_definition_events_no_truncate BEFORE TRUNCATE ON public.agent_definition_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.agent_definition_append_only();
CREATE TRIGGER agent_definition_state_no_truncate BEFORE TRUNCATE ON public.agent_definition_state
  FOR EACH STATEMENT EXECUTE FUNCTION public.agent_definition_append_only();

-- The pointer row: identity is fixed, the version advances by exactly one, the
-- revision counter never moves backwards, and the pointer/lifecycle only change
-- inside this migration's writers (transaction-local flag).
CREATE FUNCTION public.agent_definition_state_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.shops WHERE id = OLD.shop_id) THEN
      RAISE EXCEPTION 'Agent definition state cannot be deleted' USING ERRCODE='42501';
    END IF;
    RETURN OLD;
  END IF;
  IF coalesce(current_setting('gradia.agent_definition_write', true), '') <> 'on' THEN
    RAISE EXCEPTION 'Agent definition state changes only through its commands' USING ERRCODE='42501';
  END IF;
  IF (NEW.agent_id, NEW.shop_id, NEW.created_at) IS DISTINCT FROM (OLD.agent_id, OLD.shop_id, OLD.created_at) THEN
    RAISE EXCEPTION 'Agent definition identity is immutable' USING ERRCODE='42501';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Agent definition state version must advance by exactly one' USING ERRCODE='42501';
  END IF;
  IF NEW.latest_revision < OLD.latest_revision THEN
    RAISE EXCEPTION 'Agent definition revision counter cannot move backwards' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_definition_state_guard BEFORE UPDATE OR DELETE ON public.agent_definition_state
  FOR EACH ROW EXECUTE FUNCTION public.agent_definition_state_guard();

-- ---------------------------------------------------------------------------
-- Authority helpers
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.agent_definition_require_service() RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE='42501';
  END IF;
END $$;

-- Live role of a NAMED actor in an exact shop; NULL for anyone not currently active.
CREATE FUNCTION public.agent_definition_actor_role(p_shop uuid, p_actor uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT m.role FROM public.shop_memberships m
   WHERE p_shop IS NOT NULL AND p_actor IS NOT NULL
     AND m.shop_id = p_shop AND m.user_id = p_actor AND m.active;
$$;

CREATE FUNCTION public.agent_definition_open_write() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  SELECT set_config('gradia.agent_definition_write', 'on', true);
$$;
CREATE FUNCTION public.agent_definition_close_write() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  SELECT set_config('gradia.agent_definition_write', 'off', true);
$$;

-- Append one history row. Caller holds the agent row lock, so max+1 is serial.
CREATE FUNCTION public.agent_definition_emit(
  p_shop uuid, p_agent uuid, p_kind text, p_revision integer, p_from integer, p_actor uuid, p_evidence jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  INSERT INTO public.agent_definition_events (shop_id, agent_id, seq, kind, revision, from_revision, actor_id, evidence)
  VALUES (p_shop, p_agent,
    (SELECT coalesce(max(seq), 0) + 1 FROM public.agent_definition_events WHERE agent_id = p_agent),
    p_kind, p_revision, p_from, p_actor, coalesce(p_evidence, '{}'::jsonb));
END $$;

-- ---------------------------------------------------------------------------
-- Save an immutable revision.
-- Result: {outcome: created | replayed | blocked, code?, revision, definition_hash, parent_revision}
--   blocked codes: agent_not_found | legacy_agent_enabled | parent_not_found | memory_not_selectable
-- Failure codes: 42501 authority, 22023 invalid input, AD409 request id reused for a different save.
-- The input carries NO revision/lifecycle: the database assigns the number and stores
-- lifecycle 'draft'. Memory sources must currently be published, valid and unexpired for
-- this shop; the exact reviewed revision is pinned.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.agent_definition_create_revision(
  p_shop uuid, p_actor uuid, p_agent uuid, p_request_id uuid, p_definition jsonb, p_parent integer DEFAULT NULL
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
    -- A legacy enabled agent keeps running under its legacy path; it is converted
    -- only after the owner turns it off. Governed => (enabled <=> lifecycle active).
    IF v_enabled THEN
      RETURN jsonb_build_object('outcome', 'blocked', 'code', 'legacy_agent_enabled');
    END IF;
    INSERT INTO public.agent_definition_state (agent_id, shop_id) VALUES (p_agent, p_shop);
    SELECT * INTO st FROM public.agent_definition_state WHERE agent_id = p_agent FOR UPDATE;
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

-- ---------------------------------------------------------------------------
-- Record exact-revision evaluation evidence (trusted evaluator seam only).
-- Service role only; there is no actor because an evaluator is not a person. The
-- activation command never accepts evaluation facts as input: it reads this table.
-- Result: {outcome: recorded | replayed | blocked, code?, evaluation_id}
-- Failure codes: 42501 authority, 22023 invalid input, AD409 key reused for different evidence.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.agent_definition_record_evaluation(
  p_shop uuid, p_agent uuid, p_revision integer, p_definition_hash text, p_evaluation_key text,
  p_suite_version text, p_fixture_set_id text, p_fixture_hash text, p_pass_rate numeric,
  p_safety_passed boolean, p_estimated_credits integer, p_cost_evidence jsonb,
  p_completed_at timestamptz, p_source text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  rev public.agent_definition_revisions;
  ex public.agent_definition_evaluations;
  v_fp text;
  v_id uuid;
BEGIN
  PERFORM public.agent_definition_require_service();
  IF p_shop IS NULL OR p_agent IS NULL OR p_revision IS NULL OR p_definition_hash IS NULL
     OR p_evaluation_key IS NULL OR p_suite_version IS NULL OR p_fixture_set_id IS NULL
     OR p_fixture_hash IS NULL OR p_pass_rate IS NULL OR p_safety_passed IS NULL
     OR p_estimated_credits IS NULL OR p_completed_at IS NULL OR p_source IS DISTINCT FROM 'trusted_evaluator' THEN
    RAISE EXCEPTION 'Complete trusted evaluation evidence is required' USING ERRCODE='22023';
  END IF;

  PERFORM 1 FROM public.custom_agents a WHERE a.id = p_agent AND a.shop_id = p_shop FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'blocked', 'code', 'agent_not_found');
  END IF;
  SELECT * INTO rev FROM public.agent_definition_revisions
   WHERE shop_id = p_shop AND agent_id = p_agent AND revision = p_revision;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'blocked', 'code', 'revision_not_found');
  END IF;
  IF rev.definition_hash <> p_definition_hash THEN
    RETURN jsonb_build_object('outcome', 'blocked', 'code', 'definition_hash_mismatch');
  END IF;

  -- Session-timezone and numeric-scale independent, so an exact replay always matches.
  v_fp := encode(sha256(convert_to(jsonb_build_array(p_suite_version, p_fixture_set_id, p_fixture_hash,
    round(p_pass_rate, 4)::text, p_safety_passed, p_estimated_credits, coalesce(p_cost_evidence, '{}'::jsonb),
    extract(epoch from p_completed_at)::text)::text, 'UTF8')), 'hex');
  SELECT * INTO ex FROM public.agent_definition_evaluations
   WHERE agent_id = p_agent AND revision = p_revision AND evaluation_key = p_evaluation_key;
  IF FOUND THEN
    IF ex.request_fingerprint <> v_fp THEN
      RAISE EXCEPTION 'Evaluation key was already used for different evidence' USING ERRCODE='AD409';
    END IF;
    RETURN jsonb_build_object('outcome', 'replayed', 'evaluation_id', ex.id);
  END IF;

  INSERT INTO public.agent_definition_evaluations
    (shop_id, agent_id, revision, definition_hash, evaluation_key, request_fingerprint, suite_version,
     fixture_set_id, fixture_hash, pass_rate, safety_passed, estimated_credits, cost_evidence,
     completed_at, source)
  VALUES (p_shop, p_agent, p_revision, p_definition_hash, p_evaluation_key, v_fp, p_suite_version,
     p_fixture_set_id, p_fixture_hash, p_pass_rate, p_safety_passed, p_estimated_credits,
     coalesce(p_cost_evidence, '{}'::jsonb), p_completed_at, p_source)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('outcome', 'recorded', 'evaluation_id', v_id);
END $$;

-- ---------------------------------------------------------------------------
-- Activate an exact revision.
--
-- Everything the browser could influence (revision, hash, expected pointer) is only an
-- optimistic binding to what the owner saw. Policy / knowledge / readiness values come
-- from the application's server-side loaders; the database RE-VERIFIES, under the agent
-- lock, everything it can see itself: live owner, exact revision + hash, supported schema,
-- the still-current active Control Center policy revision, every pinned memory revision
-- (published, current, unexpired, unrevoked, same content hash), the memory head, tool
-- readiness for every grant, limits, and the newest exact-revision evaluation.
--
-- Then, in the SAME transaction, it calls the merged `commercial_agent_activate`
-- (catalog, owner, Founder Pilot evidence, two-active-agent cap, and the only write of
-- custom_agents.enabled), and only if that succeeds advances the pointer. Any failure
-- after the enabling write (including an injected pointer failure) rolls both back.
--
-- Result: {outcome: activated | already_active | blocked, reasons: text[], code?, revision}
-- Failure codes: 42501 authority, 22023 invalid input.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.agent_definition_activate(
  p_shop uuid, p_actor uuid, p_agent uuid, p_revision integer, p_expected_hash text,
  p_expected_pointer integer, p_policy_revision integer, p_knowledge_revision integer,
  p_ready_operations text[]
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  c_pass constant numeric := 0.95;
  v_enabled boolean;
  st public.agent_definition_state;
  rev public.agent_definition_revisions;
  ev public.agent_definition_evaluations;
  v_reasons text[] := ARRAY[]::text[];
  v_policy integer;
  v_head integer;
  v_op text;
  pin record;
  cur record;
  v_pins jsonb := '[]'::jsonb;
  v_commercial jsonb;
  v_billing_evidence uuid;
  v_ready text[];
BEGIN
  PERFORM public.agent_definition_require_service();
  IF p_shop IS NULL OR p_actor IS NULL OR p_agent IS NULL OR p_revision IS NULL OR p_expected_hash IS NULL
     OR p_policy_revision IS NULL OR p_knowledge_revision IS NULL OR p_ready_operations IS NULL THEN
    RAISE EXCEPTION 'Complete activation input is required' USING ERRCODE='22023';
  END IF;
  IF public.agent_definition_actor_role(p_shop, p_actor) IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Live owner of this workspace required' USING ERRCODE='42501';
  END IF;

  SELECT a.enabled INTO v_enabled FROM public.custom_agents a
   WHERE a.id = p_agent AND a.shop_id = p_shop FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'blocked', 'code', 'agent_not_found', 'reasons', jsonb_build_array('agent_not_found'));
  END IF;
  SELECT * INTO st FROM public.agent_definition_state WHERE agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'blocked', 'code', 'definition_not_found', 'reasons', jsonb_build_array('definition_not_found'));
  END IF;
  SELECT * INTO rev FROM public.agent_definition_revisions
   WHERE shop_id = p_shop AND agent_id = p_agent AND revision = p_revision;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'blocked', 'code', 'revision_not_found', 'reasons', jsonb_build_array('revision_not_found'));
  END IF;
  IF rev.definition_hash <> p_expected_hash THEN
    RETURN jsonb_build_object('outcome', 'blocked', 'code', 'definition_hash_mismatch', 'reasons', jsonb_build_array('definition_hash_mismatch'));
  END IF;
  IF rev.schema_version <> 1 THEN
    RETURN jsonb_build_object('outcome', 'blocked', 'code', 'unsupported_schema', 'reasons', jsonb_build_array('unsupported_schema'));
  END IF;
  IF st.active_revision IS DISTINCT FROM p_expected_pointer THEN
    RETURN jsonb_build_object('outcome', 'blocked', 'code', 'pointer_changed', 'reasons', jsonb_build_array('pointer_changed'));
  END IF;
  IF st.lifecycle = 'active' AND st.active_revision = p_revision AND v_enabled THEN
    RETURN jsonb_build_object('outcome', 'already_active', 'reasons', '[]'::jsonb, 'revision', p_revision);
  END IF;

  -- Active Control Center policy: must exist and still be the revision the application evaluated.
  SELECT revision INTO v_policy FROM public.control_policy_active WHERE shop_id = p_shop;
  IF v_policy IS NULL THEN v_reasons := array_append(v_reasons, 'policy_unavailable'::text);
  ELSIF v_policy <> p_policy_revision THEN v_reasons := array_append(v_reasons, 'policy_stale'::text);
  END IF;

  -- Tool readiness for every requested operation (post-MVP tools are never activatable).
  v_ready := p_ready_operations;
  FOR v_op IN SELECT e ->> 'operation' FROM jsonb_array_elements(rev.definition -> 'tools') AS e LOOP
    IF v_op IN ('voice.outbound', 'campaign.send') THEN v_reasons := array_append(v_reasons, 'post_mvp_tool_disabled'::text); END IF;
    IF NOT (v_op = ANY (v_ready)) THEN v_reasons := array_append(v_reasons, 'tool_not_ready'::text); END IF;
  END LOOP;

  -- Pinned memory: each pin must still be the active, published, current revision.
  FOR pin IN SELECT * FROM public.agent_definition_memory_pins WHERE agent_id = p_agent AND revision = p_revision LOOP
    SELECT a.revision AS active_revision, r.state, r.content_hash, r.valid_from, r.valid_until, r.retention_until
      INTO cur
      FROM public.reviewed_memory_revisions r
      LEFT JOIN public.reviewed_memory_active a
        ON a.shop_id = r.shop_id AND a.source_id = r.source_id
     WHERE r.shop_id = p_shop AND r.source_id = pin.source_id AND r.revision = pin.memory_revision;
    IF NOT FOUND OR cur.state IN ('revoked', 'deleted') THEN
      v_reasons := array_append(v_reasons, 'memory_revoked'::text);
    ELSIF cur.state <> 'published' OR cur.content_hash <> pin.content_hash THEN
      v_reasons := array_append(v_reasons, 'memory_changed'::text);
    ELSIF cur.active_revision IS DISTINCT FROM pin.memory_revision THEN
      v_reasons := array_append(v_reasons, 'memory_stale'::text);
    ELSIF cur.valid_from > clock_timestamp()
       OR (cur.valid_until IS NOT NULL AND cur.valid_until <= clock_timestamp())
       OR (cur.retention_until IS NOT NULL AND cur.retention_until <= clock_timestamp()) THEN
      v_reasons := array_append(v_reasons, 'memory_expired'::text);
    END IF;
    v_pins := v_pins || jsonb_build_object('source_id', pin.source_id, 'memory_revision', pin.memory_revision,
      'content_hash', pin.content_hash);
  END LOOP;

  -- Knowledge head the application compiled against (baseline 1 when nothing is published yet).
  SELECT revision INTO v_head FROM public.reviewed_memory_heads WHERE shop_id = p_shop;
  IF p_knowledge_revision <> coalesce(v_head, 1) THEN v_reasons := array_append(v_reasons, 'knowledge_stale'::text); END IF;

  -- Budgets / limits (re-checked; the application also validated them at save).
  IF NOT (
    (rev.definition #>> '{limits,maximumStepsPerRun}')::int BETWEEN 1 AND 30
    AND (rev.definition #>> '{limits,maximumRuntimeSeconds}')::int BETWEEN 5 AND 900
    AND (rev.definition #>> '{limits,maximumCreditsPerRun}')::int BETWEEN 0 AND 100000
    AND (rev.definition #>> '{limits,maximumRunsPerDay}')::int BETWEEN 1 AND 1440
    AND rev.definition #>> '{limits,maximumConcurrentRuns}' = '1'
  ) THEN v_reasons := array_append(v_reasons, 'limits_invalid'::text); END IF;

  -- Newest exact-revision evaluation (bound to this definition hash by FK).
  SELECT * INTO ev FROM public.agent_definition_evaluations
   WHERE agent_id = p_agent AND revision = p_revision
   ORDER BY completed_at DESC, recorded_at DESC LIMIT 1;
  IF NOT FOUND THEN v_reasons := array_append(v_reasons, 'evaluation_required'::text);
  ELSE
    IF NOT ev.safety_passed THEN v_reasons := array_append(v_reasons, 'safety_evaluation_failed'::text); END IF;
    IF ev.pass_rate < c_pass THEN v_reasons := array_append(v_reasons, 'quality_evaluation_failed'::text); END IF;
  END IF;

  IF cardinality(v_reasons) > 0 THEN
    RETURN jsonb_build_object('outcome', 'blocked', 'code', 'evidence_blocked',
      'reasons', to_jsonb(ARRAY(SELECT DISTINCT r FROM unnest(v_reasons) AS r ORDER BY r)));
  END IF;

  -- Composition with the merged commercial activation (entitlement + cap + enabling write).
  PERFORM set_config('gradia.agent_definition_activation', 'on', true);
  v_commercial := public.commercial_agent_activate(p_shop, p_actor, p_agent);
  PERFORM set_config('gradia.agent_definition_activation', 'off', true);
  IF v_commercial ->> 'outcome' = 'blocked' THEN
    RETURN jsonb_build_object('outcome', 'blocked', 'code', coalesce(v_commercial ->> 'code', 'billing_not_active'),
      'reasons', jsonb_build_array(coalesce(v_commercial ->> 'code', 'billing_not_active')));
  END IF;

  SELECT current_evidence_id INTO v_billing_evidence
    FROM public.commercial_billing_accounts WHERE shop_id = p_shop;

  PERFORM public.agent_definition_open_write();
  UPDATE public.agent_definition_state
     SET lifecycle = 'active', active_revision = p_revision, lifecycle_reason = NULL,
         version = version + 1, updated_at = clock_timestamp()
   WHERE agent_id = p_agent;
  PERFORM public.agent_definition_close_write();

  IF st.active_revision IS NOT NULL AND st.active_revision <> p_revision THEN
    PERFORM public.agent_definition_emit(p_shop, p_agent, 'superseded', st.active_revision, NULL, p_actor,
      jsonb_build_object('superseded_by', p_revision));
  END IF;
  PERFORM public.agent_definition_emit(p_shop, p_agent, 'activated', p_revision, st.active_revision, p_actor,
    jsonb_build_object(
      'definition_hash', rev.definition_hash,
      'schema_version', rev.schema_version,
      'policy_revision', v_policy,
      'knowledge_revision', coalesce(v_head, 1),
      'memory_pins', v_pins,
      'ready_operations', to_jsonb(p_ready_operations),
      'evaluation_id', ev.id,
      'evaluation_suite_version', ev.suite_version,
      'evaluation_pass_rate', ev.pass_rate,
      'billing_evidence_id', v_billing_evidence,
      'commercial_outcome', v_commercial ->> 'outcome',
      'previous_lifecycle', st.lifecycle));

  RETURN jsonb_build_object('outcome', 'activated', 'reasons', '[]'::jsonb, 'revision', p_revision,
    'active_count', v_commercial -> 'active_count');
END $$;

-- ---------------------------------------------------------------------------
-- Pause / block the active definition (owner only). Resuming is a fresh activation
-- with fresh evidence; there is no shortcut back to active.
-- Result: {outcome: changed | unchanged | blocked, code?}
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.agent_definition_set_lifecycle(
  p_shop uuid, p_actor uuid, p_agent uuid, p_lifecycle text, p_reason text, p_expected_pointer integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_enabled boolean;
  st public.agent_definition_state;
BEGIN
  PERFORM public.agent_definition_require_service();
  IF p_shop IS NULL OR p_actor IS NULL OR p_agent IS NULL OR p_lifecycle NOT IN ('paused', 'blocked')
     OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Invalid lifecycle change' USING ERRCODE='22023';
  END IF;
  IF public.agent_definition_actor_role(p_shop, p_actor) IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Live owner of this workspace required' USING ERRCODE='42501';
  END IF;
  SELECT a.enabled INTO v_enabled FROM public.custom_agents a
   WHERE a.id = p_agent AND a.shop_id = p_shop FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'blocked', 'code', 'agent_not_found');
  END IF;
  SELECT * INTO st FROM public.agent_definition_state WHERE agent_id = p_agent FOR UPDATE;
  IF NOT FOUND OR st.active_revision IS NULL THEN
    RETURN jsonb_build_object('outcome', 'blocked', 'code', 'no_active_definition');
  END IF;
  IF st.active_revision IS DISTINCT FROM p_expected_pointer THEN
    RETURN jsonb_build_object('outcome', 'blocked', 'code', 'pointer_changed');
  END IF;
  IF st.lifecycle = p_lifecycle THEN
    RETURN jsonb_build_object('outcome', 'unchanged');
  END IF;
  IF st.lifecycle = 'blocked' THEN
    RETURN jsonb_build_object('outcome', 'blocked', 'code', 'invalid_transition');
  END IF;

  PERFORM public.agent_definition_open_write();
  UPDATE public.agent_definition_state
     SET lifecycle = p_lifecycle, lifecycle_reason = btrim(p_reason),
         version = version + 1, updated_at = clock_timestamp()
   WHERE agent_id = p_agent;
  PERFORM public.agent_definition_close_write();
  PERFORM public.agent_definition_emit(p_shop, p_agent, p_lifecycle, st.active_revision, NULL, p_actor,
    jsonb_build_object('reason', btrim(p_reason), 'previous_lifecycle', st.lifecycle));
  -- Disabling never needs billing and frees an entitlement slot.
  IF v_enabled THEN
    UPDATE public.custom_agents SET enabled = false WHERE id = p_agent AND shop_id = p_shop;
  END IF;
  RETURN jsonb_build_object('outcome', 'changed');
END $$;

-- ---------------------------------------------------------------------------
-- Keep `enabled` and the pointer consistent for governed agents.
-- ---------------------------------------------------------------------------
-- 1) A governed agent can only be turned ON through definition activation. The guard
--    from 20261106130000 is only STRENGTHENED (same refusal for everyone else); it is
--    now SECURITY DEFINER so it can see the state table.
CREATE OR REPLACE FUNCTION public.custom_agents_activation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NEW.enabled IS TRUE
     AND (TG_OP = 'INSERT' OR OLD.enabled IS DISTINCT FROM TRUE)
  THEN
    IF coalesce(auth.role(), '') <> 'service_role'
       AND coalesce(current_setting('gradia.agent_activation', true), '') <> 'on' THEN
      RAISE EXCEPTION 'Agents are turned on through the activation boundary only' USING ERRCODE='42501';
    END IF;
    IF TG_OP = 'UPDATE'
       AND EXISTS (SELECT 1 FROM public.agent_definition_state s WHERE s.agent_id = NEW.id)
       AND coalesce(current_setting('gradia.agent_definition_activation', true), '') <> 'on' THEN
      RAISE EXCEPTION 'Governed agents are turned on through definition activation only' USING ERRCODE='42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- 2) Turning a governed active agent off by any path pauses its pointer (never active+disabled).
CREATE FUNCTION public.custom_agents_governed_disable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_revision integer;
BEGIN
  PERFORM public.agent_definition_open_write();
  UPDATE public.agent_definition_state
     SET lifecycle = 'paused', lifecycle_reason = 'disabled_directly',
         version = version + 1, updated_at = clock_timestamp()
   WHERE agent_id = NEW.id AND lifecycle = 'active'
  RETURNING active_revision INTO v_revision;
  PERFORM public.agent_definition_close_write();
  IF v_revision IS NOT NULL THEN
    PERFORM public.agent_definition_emit(NEW.shop_id, NEW.id, 'paused', v_revision, NULL, NULL,
      jsonb_build_object('reason', 'disabled_directly', 'previous_lifecycle', 'active'));
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER custom_agents_governed_disable
  AFTER UPDATE OF enabled ON public.custom_agents
  FOR EACH ROW WHEN (OLD.enabled IS TRUE AND NEW.enabled IS NOT TRUE)
  EXECUTE FUNCTION public.custom_agents_governed_disable();

-- 3) New scheduled run claims require an ACTIVE definition for governed agents.
--    Re-declared from 20261029120000 with exactly one added check; legacy agents
--    (no state row) keep their existing behavior unchanged.
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
  -- blocked or pointer-less definitions never create a new claim.
  IF EXISTS (
    SELECT 1 FROM public.agent_definition_state s
    WHERE s.agent_id = v_agent.id
      AND (s.lifecycle <> 'active' OR s.active_revision IS NULL)
  ) THEN
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

-- ---------------------------------------------------------------------------
-- Function privileges: service role only; browser roles get nothing.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  public.agent_definition_append_only(), public.agent_definition_state_guard(),
  public.agent_definition_require_service(), public.agent_definition_actor_role(uuid, uuid),
  public.agent_definition_open_write(), public.agent_definition_close_write(),
  public.agent_definition_emit(uuid, uuid, text, integer, integer, uuid, jsonb),
  public.agent_definition_create_revision(uuid, uuid, uuid, uuid, jsonb, integer),
  public.agent_definition_record_evaluation(uuid, uuid, integer, text, text, text, text, text, numeric, boolean, integer, jsonb, timestamptz, text),
  public.agent_definition_activate(uuid, uuid, uuid, integer, text, integer, integer, integer, text[]),
  public.agent_definition_set_lifecycle(uuid, uuid, uuid, text, text, integer),
  public.custom_agents_governed_disable()
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.agent_definition_actor_role(uuid, uuid),
  public.agent_definition_create_revision(uuid, uuid, uuid, uuid, jsonb, integer),
  public.agent_definition_record_evaluation(uuid, uuid, integer, text, text, text, text, text, numeric, boolean, integer, jsonb, timestamptz, text),
  public.agent_definition_activate(uuid, uuid, uuid, integer, text, integer, integer, integer, text[]),
  public.agent_definition_set_lifecycle(uuid, uuid, uuid, text, text, integer)
  TO service_role;

COMMIT;
