BEGIN;

-- Onboarding baseline assessment (PR A, backend only).
--
-- A baseline is business-measurement evidence. It is NOT memory, NOT a tool or
-- connector grant, and NOT an autonomy or customer-contact permission.
--
--  * The question catalog is a finite, versioned, immutable table. Validation
--    is enforced here, in the database, because the RPC is the write authority.
--  * Submitted assessment revisions are immutable and tenant-bound. One pointer
--    per shop advances atomically; earlier revisions and the pointer's history
--    are never rewritten.
--  * Answers only ever carry owner estimates or an explicit `unknown`. Stronger
--    evidence (connected, Gradia-observed, derived) arrives as separately
--    recorded measurements with a window, source and formula version. Only the
--    service role can record them; no model, owner or manager path can.
--  * `unknown` is a first-class state and never coerced to zero.
--  * Authority is derived from live membership inside the database. Owners
--    submit/supersede; a manager holding the explicit `baseline.draft` grant
--    may read and draft; staff, revoked, anonymous and cross-shop callers are
--    refused. Tables are not directly readable by browser roles.

-- ---------------------------------------------------------------------------
-- Explicit manager grant. Membership alone grants nothing.
-- ---------------------------------------------------------------------------
DO $$
DECLARE target text; found integer;
BEGIN
 FOREACH target IN ARRAY ARRAY['shop_memberships','shop_invitations'] LOOP
  SELECT count(*) INTO found FROM pg_catalog.pg_constraint
  WHERE conrelid=('public.'||target)::regclass AND contype='c' AND conname=target||'_capabilities_known';
  -- Refuse rather than guess when the reviewed constraint is not exactly as expected.
  IF found<>1 THEN RAISE EXCEPTION 'Unexpected capability constraints on %',target; END IF;
  EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',target,target||'_capabilities_known');
  EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (capabilities <@ ARRAY[''crm.read'',''notes.write'',''jobs.progress'',''assignments.manage'',''delivery.reconcile'',''approvals.messages'',''leads.qualify'',''baseline.draft'']::text[])',target,target||'_capabilities_known');
 END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Immutable catalog
-- ---------------------------------------------------------------------------
CREATE TABLE public.baseline_catalog_versions (
  version text PRIMARY KEY CHECK (version ~ '^baseline\.v[0-9]+$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.baseline_catalog_questions (
  version text NOT NULL REFERENCES public.baseline_catalog_versions(version),
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{2,60}$'),
  section text NOT NULL CHECK (section IN (
    'team_capacity','lead_flow','phone','response','conversion','work_value',
    'follow_up','scheduling','admin_load','readiness','pilot_goal')),
  ordinal integer NOT NULL CHECK (ordinal > 0),
  kind text NOT NULL CHECK (kind IN ('number','choice','choices','mix','note')),
  optional boolean NOT NULL,
  allows_unknown boolean NOT NULL,
  allows_range boolean NOT NULL DEFAULT false,
  -- number kinds: {"<unit>": {"min": n, "max": n, "integer": bool}}
  units jsonb,
  -- choice / choices / mix kinds: the closed set of allowed values
  choices text[],
  max_selected integer,
  max_length integer,
  PRIMARY KEY (version, key),
  UNIQUE (version, ordinal),
  CHECK ((kind = 'number') = (units IS NOT NULL)),
  CHECK (units IS NULL OR jsonb_typeof(units) = 'object'),
  CHECK ((kind IN ('choice','choices','mix')) = (choices IS NOT NULL)),
  CHECK ((kind = 'choices') = (max_selected IS NOT NULL)),
  CHECK ((kind = 'note') = (max_length IS NOT NULL)),
  CHECK (allows_range = false OR kind = 'number')
);

CREATE FUNCTION public.baseline_catalog_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  RAISE EXCEPTION 'Baseline catalog versions are immutable; publish a new version' USING ERRCODE='42501';
END $$;
CREATE TRIGGER baseline_catalog_versions_immutable
  BEFORE UPDATE OR DELETE ON public.baseline_catalog_versions
  FOR EACH ROW EXECUTE FUNCTION public.baseline_catalog_immutable();
CREATE TRIGGER baseline_catalog_questions_immutable
  BEFORE UPDATE OR DELETE ON public.baseline_catalog_questions
  FOR EACH ROW EXECUTE FUNCTION public.baseline_catalog_immutable();

INSERT INTO public.baseline_catalog_versions(version) VALUES ('baseline.v1');

INSERT INTO public.baseline_catalog_questions
  (version, key, section, ordinal, kind, optional, allows_unknown, allows_range, units, choices, max_selected, max_length)
VALUES
 ('baseline.v1','active_operators','team_capacity',1,'number',false,true,false,'{"count":{"min":0,"max":500,"integer":true}}',NULL,NULL,NULL),
 ('baseline.v1','service_bays','team_capacity',2,'number',false,true,false,'{"count":{"min":0,"max":200,"integer":true}}',NULL,NULL,NULL),
 ('baseline.v1','operating_days','team_capacity',3,'number',false,true,false,'{"days_per_week":{"min":1,"max":7,"integer":true}}',NULL,NULL,NULL),
 ('baseline.v1','inquiries_per_month','lead_flow',4,'number',false,true,true,'{"count_per_month":{"min":0,"max":100000,"integer":true}}',NULL,NULL,NULL),
 ('baseline.v1','inquiry_source_mix','lead_flow',5,'mix',false,true,false,NULL,ARRAY['website','sms','phone','meta','email','referral','other'],NULL,NULL),
 ('baseline.v1','calls_per_week','phone',6,'number',false,true,false,'{"count_per_week":{"min":0,"max":10000,"integer":true}}',NULL,NULL,NULL),
 ('baseline.v1','missed_calls_per_week','phone',7,'number',false,true,false,'{"count_per_week":{"min":0,"max":10000,"integer":true}}',NULL,NULL,NULL),
 ('baseline.v1','missed_calls_returned_per_week','phone',8,'number',false,true,false,'{"count_per_week":{"min":0,"max":10000,"integer":true}}',NULL,NULL,NULL),
 ('baseline.v1','first_response_minutes','response',9,'number',false,true,true,'{"minutes":{"min":0,"max":43200,"integer":true}}',NULL,NULL,NULL),
 ('baseline.v1','confirmed_bookings','conversion',10,'number',false,true,false,'{"count_per_month":{"min":0,"max":100000,"integer":true},"percent":{"min":0,"max":100,"integer":false}}',NULL,NULL,NULL),
 ('baseline.v1','avg_booked_value_usd','work_value',11,'number',true,true,true,'{"usd":{"min":0,"max":100000,"integer":false}}',NULL,NULL,NULL),
 ('baseline.v1','followed_up_within_two_days','follow_up',12,'number',false,true,false,'{"count_per_month":{"min":0,"max":100000,"integer":true},"percent":{"min":0,"max":100,"integer":false}}',NULL,NULL,NULL),
 ('baseline.v1','cancellations_no_shows_per_month','scheduling',13,'number',false,true,false,'{"count_per_month":{"min":0,"max":10000,"integer":true}}',NULL,NULL,NULL),
 ('baseline.v1','scheduling_conflicts_per_month','scheduling',14,'number',false,true,false,'{"count_per_month":{"min":0,"max":10000,"integer":true}}',NULL,NULL,NULL),
 ('baseline.v1','admin_hours_calls','admin_load',15,'number',false,true,false,'{"hours_per_week":{"min":0,"max":168,"integer":false}}',NULL,NULL,NULL),
 ('baseline.v1','admin_hours_follow_up','admin_load',16,'number',false,true,false,'{"hours_per_week":{"min":0,"max":168,"integer":false}}',NULL,NULL,NULL),
 ('baseline.v1','admin_hours_crm','admin_load',17,'number',false,true,false,'{"hours_per_week":{"min":0,"max":168,"integer":false}}',NULL,NULL,NULL),
 ('baseline.v1','admin_hours_scheduling','admin_load',18,'number',false,true,false,'{"hours_per_week":{"min":0,"max":168,"integer":false}}',NULL,NULL,NULL),
 ('baseline.v1','records_system','readiness',19,'choice',false,true,false,NULL,ARRAY['crm','spreadsheet','paper','none'],NULL,NULL),
 ('baseline.v1','calendar_system','readiness',20,'choice',false,true,false,NULL,ARRAY['google','microsoft','other','none'],NULL,NULL),
 ('baseline.v1','active_channels','readiness',21,'choices',false,true,false,NULL,ARRAY['phone','sms','email','website_form','meta','other'],6,NULL),
 ('baseline.v1','pilot_primary_outcome','pilot_goal',22,'choice',false,false,false,NULL,ARRAY['answer_more_calls','respond_faster','book_more','follow_up_more','fewer_no_shows','less_admin'],NULL,NULL),
 ('baseline.v1','pilot_secondary_outcome','pilot_goal',23,'choice',true,false,false,NULL,ARRAY['answer_more_calls','respond_faster','book_more','follow_up_more','fewer_no_shows','less_admin'],NULL,NULL),
 ('baseline.v1','pilot_goal_note','pilot_goal',24,'note',true,false,false,NULL,NULL,NULL,280);

-- Metric definitions. `window_sensitive` metrics are totals that only compare
-- across windows of identical length; rates and durations do not scale with it.
CREATE TABLE public.baseline_metric_definitions (
  metric_key text NOT NULL CHECK (metric_key ~ '^[a-z][a-z0-9_]{2,60}$'),
  definition_version text NOT NULL CHECK (definition_version ~ '^v[0-9]+$'),
  section text NOT NULL CHECK (section IN ('response','booking','follow_up','operating_load')),
  unit text NOT NULL CHECK (unit IN ('count','percent','minutes','hours_per_week')),
  window_sensitive boolean NOT NULL,
  PRIMARY KEY (metric_key, definition_version)
);
CREATE TRIGGER baseline_metric_definitions_immutable
  BEFORE UPDATE OR DELETE ON public.baseline_metric_definitions
  FOR EACH ROW EXECUTE FUNCTION public.baseline_catalog_immutable();
INSERT INTO public.baseline_metric_definitions(metric_key, definition_version, section, unit, window_sensitive) VALUES
 ('inquiry_volume','v1','response','count',true),
 ('missed_call_rate','v1','response','percent',false),
 ('first_response_minutes','v1','response','minutes',false),
 ('booking_rate','v1','booking','percent',false),
 ('cancellations_no_shows','v1','booking','count',true),
 ('followup_coverage','v1','follow_up','percent',false),
 ('unresolved_leads','v1','follow_up','count',false),
 ('admin_hours','v1','operating_load','hours_per_week',false);

-- ---------------------------------------------------------------------------
-- Tenant data
-- ---------------------------------------------------------------------------
CREATE TABLE public.baseline_drafts (
  shop_id uuid PRIMARY KEY REFERENCES public.shops(id) ON DELETE CASCADE,
  catalog_version text NOT NULL REFERENCES public.baseline_catalog_versions(version),
  answers jsonb NOT NULL CHECK (jsonb_typeof(answers) = 'object'),
  draft_version integer NOT NULL CHECK (draft_version > 0),
  updated_by uuid NOT NULL REFERENCES auth.users(id),
  updated_by_role text NOT NULL CHECK (updated_by_role IN ('owner','manager')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.baseline_measurements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  metric_key text NOT NULL,
  definition_version text NOT NULL,
  evidence_class text NOT NULL CHECK (evidence_class IN ('connected_evidence','gradia_observed','derived','unknown')),
  value numeric,
  unit text NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  source_system text CHECK (source_system IS NULL OR length(btrim(source_system)) BETWEEN 1 AND 80),
  source_ref text CHECK (source_ref IS NULL OR length(btrim(source_ref)) BETWEEN 1 AND 200),
  formula_version text CHECK (formula_version IS NULL OR formula_version ~ '^[a-z][a-z0-9_]{2,60}\.v[0-9]+$'),
  inputs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(inputs) = 'array'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (shop_id, id),
  FOREIGN KEY (metric_key, definition_version)
    REFERENCES public.baseline_metric_definitions(metric_key, definition_version),
  CHECK (window_end > window_start),
  CHECK (window_end - window_start <= interval '400 days'),
  -- unknown is never zero: a value exists exactly when the class is not unknown.
  CHECK ((evidence_class = 'unknown') = (value IS NULL)),
  CHECK (value IS NULL OR value >= 0),
  CHECK (unit <> 'percent' OR value IS NULL OR value <= 100),
  CHECK (evidence_class <> 'connected_evidence' OR source_system IS NOT NULL),
  CHECK (evidence_class <> 'gradia_observed' OR source_ref IS NOT NULL),
  CHECK (evidence_class <> 'derived'
    OR (formula_version IS NOT NULL AND jsonb_array_length(inputs) BETWEEN 1 AND 20)),
  CHECK (evidence_class = 'derived' OR (formula_version IS NULL AND jsonb_array_length(inputs) = 0))
);
CREATE UNIQUE INDEX baseline_measurements_window_uniq
  ON public.baseline_measurements (shop_id, metric_key, definition_version, window_start, window_end,
    evidence_class, coalesce(source_system, ''), coalesce(source_ref, ''));
CREATE INDEX baseline_measurements_lookup_idx
  ON public.baseline_measurements (shop_id, metric_key, window_start, window_end);

CREATE TABLE public.baseline_assessment_revisions (
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  catalog_version text NOT NULL REFERENCES public.baseline_catalog_versions(version),
  answers jsonb NOT NULL CHECK (jsonb_typeof(answers) = 'object'),
  answers_hash text NOT NULL CHECK (answers_hash ~ '^[0-9a-f]{64}$'),
  reporting_period_start date NOT NULL,
  reporting_period_end date NOT NULL,
  evidence_measurement_ids uuid[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(evidence_measurement_ids) <= 50 AND array_position(evidence_measurement_ids, NULL) IS NULL),
  supersedes_revision integer,
  submitted_by uuid NOT NULL REFERENCES auth.users(id),
  submitted_by_role text NOT NULL CHECK (submitted_by_role = 'owner'),
  drafted_by uuid REFERENCES auth.users(id),
  drafted_by_role text CHECK (drafted_by_role IN ('owner','manager')),
  created_at timestamptz NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (shop_id, revision),
  FOREIGN KEY (shop_id, supersedes_revision)
    REFERENCES public.baseline_assessment_revisions(shop_id, revision),
  CHECK (reporting_period_end >= reporting_period_start
    AND reporting_period_end - reporting_period_start <= 400),
  CHECK (supersedes_revision IS NULL OR supersedes_revision < revision),
  CHECK ((drafted_by IS NULL) = (drafted_by_role IS NULL))
);

CREATE TABLE public.baseline_pointer (
  shop_id uuid PRIMARY KEY REFERENCES public.shops(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  advanced_by uuid NOT NULL REFERENCES auth.users(id),
  advanced_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (shop_id, revision)
    REFERENCES public.baseline_assessment_revisions(shop_id, revision)
);

CREATE TABLE public.baseline_pointer_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('submitted','superseded')),
  from_revision integer,
  to_revision integer NOT NULL,
  actor_id uuid NOT NULL REFERENCES auth.users(id),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (shop_id, to_revision)
    REFERENCES public.baseline_assessment_revisions(shop_id, revision),
  CHECK ((kind = 'submitted') = (from_revision IS NULL))
);

-- Revisions, measurements and pointer history are append-only. A direct delete is
-- refused; only the cascade from deleting the whole shop may remove rows (the
-- parent row is already gone when the cascade fires).
CREATE FUNCTION public.baseline_append_only() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Baseline evidence is immutable; record a new revision' USING ERRCODE='42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.shops WHERE id = OLD.shop_id) THEN
    RAISE EXCEPTION 'Baseline evidence cannot be deleted' USING ERRCODE='42501';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER baseline_revisions_append_only
  BEFORE UPDATE OR DELETE ON public.baseline_assessment_revisions
  FOR EACH ROW EXECUTE FUNCTION public.baseline_append_only();
CREATE TRIGGER baseline_measurements_append_only
  BEFORE UPDATE OR DELETE ON public.baseline_measurements
  FOR EACH ROW EXECUTE FUNCTION public.baseline_append_only();
CREATE TRIGGER baseline_pointer_events_append_only
  BEFORE UPDATE OR DELETE ON public.baseline_pointer_events
  FOR EACH ROW EXECUTE FUNCTION public.baseline_append_only();

-- Pointer may only move forward to a newer revision of the same shop.
CREATE FUNCTION public.baseline_pointer_forward_only() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF NEW.shop_id <> OLD.shop_id OR NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'Baseline pointer can only advance' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER baseline_pointer_forward_only
  BEFORE UPDATE ON public.baseline_pointer
  FOR EACH ROW EXECUTE FUNCTION public.baseline_pointer_forward_only();

ALTER TABLE public.baseline_catalog_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.baseline_catalog_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.baseline_metric_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.baseline_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.baseline_measurements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.baseline_assessment_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.baseline_pointer ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.baseline_pointer_events ENABLE ROW LEVEL SECURITY;

-- No browser-role policy and no browser-role grant: every read and write goes
-- through the authority-checking functions below.
REVOKE ALL ON public.baseline_catalog_versions, public.baseline_catalog_questions,
  public.baseline_metric_definitions, public.baseline_drafts,
  public.baseline_measurements, public.baseline_assessment_revisions,
  public.baseline_pointer, public.baseline_pointer_events
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.baseline_pointer_events_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.baseline_catalog_versions, public.baseline_catalog_questions,
  public.baseline_metric_definitions, public.baseline_drafts,
  public.baseline_measurements, public.baseline_assessment_revisions,
  public.baseline_pointer, public.baseline_pointer_events
  TO service_role;

-- ---------------------------------------------------------------------------
-- Validation (database is authoritative; the TypeScript schema mirrors it)
-- ---------------------------------------------------------------------------
-- Plain value of a number answer in a given unit; NULL for unknown/range/absent.
CREATE FUNCTION public.baseline_plain(p_answers jsonb, p_key text, p_unit text) RETURNS numeric
LANGUAGE sql IMMUTABLE SET search_path='' AS $$
  SELECT CASE WHEN p_answers->p_key->>'state' = 'value' AND p_answers->p_key->>'unit' = p_unit
    THEN (p_answers->p_key->>'value')::numeric END;
$$;

CREATE FUNCTION public.baseline_validate_answers(p_version text, p_answers jsonb, p_complete boolean)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE
  q public.baseline_catalog_questions;
  a jsonb;
  k text;
  st text;
  u text;
  spec jsonb;
  lo numeric;
  hi numeric;
  v numeric;
  total numeric := 0;
  item jsonb;
  seen text[];
  keys text[];
  hours numeric;
BEGIN
  IF p_answers IS NULL OR jsonb_typeof(p_answers) <> 'object' THEN
    RAISE EXCEPTION 'Answers must be an object' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.baseline_catalog_versions WHERE version = p_version) THEN
    RAISE EXCEPTION 'Unknown baseline catalog version' USING ERRCODE='22023';
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_answers) LOOP
    IF NOT EXISTS (SELECT 1 FROM public.baseline_catalog_questions WHERE version = p_version AND key = k) THEN
      RAISE EXCEPTION 'Unknown question: %', k USING ERRCODE='22023';
    END IF;
  END LOOP;

  FOR q IN SELECT * FROM public.baseline_catalog_questions WHERE version = p_version ORDER BY ordinal LOOP
    a := p_answers->q.key;
    IF a IS NULL THEN
      IF p_complete AND NOT q.optional THEN
        RAISE EXCEPTION 'Answer required: %', q.key USING ERRCODE='22023';
      END IF;
      CONTINUE;
    END IF;
    IF jsonb_typeof(a) <> 'object' OR jsonb_typeof(a->'state') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'Invalid answer shape: %', q.key USING ERRCODE='22023';
    END IF;
    keys := ARRAY(SELECT jsonb_object_keys(a) ORDER BY 1);
    st := a->>'state';

    IF st = 'unknown' THEN
      IF NOT q.allows_unknown OR keys <> ARRAY['state'] THEN
        RAISE EXCEPTION 'Unknown is not allowed here: %', q.key USING ERRCODE='22023';
      END IF;
      CONTINUE;
    END IF;

    IF q.kind = 'number' THEN
      IF st NOT IN ('value','range') OR jsonb_typeof(a->'unit') IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'Invalid number answer: %', q.key USING ERRCODE='22023';
      END IF;
      u := a->>'unit';
      spec := q.units->u;
      IF spec IS NULL THEN
        RAISE EXCEPTION 'Unit not allowed for %: %', q.key, u USING ERRCODE='22023';
      END IF;
      lo := (spec->>'min')::numeric;
      hi := (spec->>'max')::numeric;
      IF st = 'value' THEN
        IF keys <> ARRAY['state','unit','value'] OR jsonb_typeof(a->'value') <> 'number' THEN
          RAISE EXCEPTION 'Invalid number answer: %', q.key USING ERRCODE='22023';
        END IF;
        v := (a->>'value')::numeric;
        IF v < lo OR v > hi
           OR ((spec->>'integer')::boolean AND v <> trunc(v))
           OR v <> round(v, 2) THEN
          RAISE EXCEPTION 'Value out of range for %', q.key USING ERRCODE='22023';
        END IF;
      ELSE
        IF NOT q.allows_range OR keys <> ARRAY['max','min','state','unit']
           OR jsonb_typeof(a->'min') <> 'number' OR jsonb_typeof(a->'max') <> 'number' THEN
          RAISE EXCEPTION 'Range is not allowed here: %', q.key USING ERRCODE='22023';
        END IF;
        v := (a->>'min')::numeric;
        total := (a->>'max')::numeric;
        IF v < lo OR total > hi OR v >= total
           OR ((spec->>'integer')::boolean AND (v <> trunc(v) OR total <> trunc(total)))
           OR v <> round(v, 2) OR total <> round(total, 2) THEN
          RAISE EXCEPTION 'Range out of bounds for %', q.key USING ERRCODE='22023';
        END IF;
        total := 0;
      END IF;

    ELSIF q.kind = 'choice' THEN
      IF st <> 'value' OR keys <> ARRAY['state','value']
         OR jsonb_typeof(a->'value') <> 'string' OR NOT ((a->>'value') = ANY(q.choices)) THEN
        RAISE EXCEPTION 'Invalid choice: %', q.key USING ERRCODE='22023';
      END IF;

    ELSIF q.kind = 'choices' THEN
      IF st <> 'value' OR keys <> ARRAY['state','value'] OR jsonb_typeof(a->'value') <> 'array'
         OR jsonb_array_length(a->'value') NOT BETWEEN 1 AND q.max_selected THEN
        RAISE EXCEPTION 'Invalid selection: %', q.key USING ERRCODE='22023';
      END IF;
      seen := '{}';
      FOR item IN SELECT value FROM jsonb_array_elements(a->'value') LOOP
        IF jsonb_typeof(item) <> 'string' OR NOT ((item #>> '{}') = ANY(q.choices))
           OR (item #>> '{}') = ANY(seen) THEN
          RAISE EXCEPTION 'Invalid selection: %', q.key USING ERRCODE='22023';
        END IF;
        seen := seen || (item #>> '{}');
      END LOOP;

    ELSIF q.kind = 'mix' THEN
      IF st <> 'value' OR keys <> ARRAY['state','unit','value'] OR a->>'unit' IS DISTINCT FROM 'percent'
         OR jsonb_typeof(a->'value') <> 'object' OR a->'value' = '{}'::jsonb THEN
        RAISE EXCEPTION 'Invalid mix: %', q.key USING ERRCODE='22023';
      END IF;
      total := 0;
      FOR k, item IN SELECT key, value FROM jsonb_each(a->'value') LOOP
        IF NOT (k = ANY(q.choices)) OR jsonb_typeof(item) <> 'number' THEN
          RAISE EXCEPTION 'Invalid mix: %', q.key USING ERRCODE='22023';
        END IF;
        v := (item #>> '{}')::numeric;
        IF v < 0 OR v > 100 OR v <> round(v, 2) THEN
          RAISE EXCEPTION 'Invalid mix share: %', q.key USING ERRCODE='22023';
        END IF;
        total := total + v;
      END LOOP;
      IF total <> 100 THEN
        RAISE EXCEPTION 'Mix must total 100 percent: %', q.key USING ERRCODE='22023';
      END IF;
      total := 0;

    ELSIF q.kind = 'note' THEN
      IF st <> 'value' OR keys <> ARRAY['state','value'] OR jsonb_typeof(a->'value') <> 'string'
         OR length(btrim(a->>'value')) NOT BETWEEN 1 AND q.max_length THEN
        RAISE EXCEPTION 'Invalid note: %', q.key USING ERRCODE='22023';
      END IF;
    END IF;
  END LOOP;

  -- Cross-field consistency, applied only when both sides are plain values in
  -- the same unit. Ranges and unknowns never trigger a false rejection.
  IF public.baseline_plain(p_answers,'missed_calls_per_week','count_per_week')
       > public.baseline_plain(p_answers,'calls_per_week','count_per_week') THEN
    RAISE EXCEPTION 'Missed calls cannot exceed calls' USING ERRCODE='22023';
  END IF;
  IF public.baseline_plain(p_answers,'missed_calls_returned_per_week','count_per_week')
       > public.baseline_plain(p_answers,'missed_calls_per_week','count_per_week') THEN
    RAISE EXCEPTION 'Returned calls cannot exceed missed calls' USING ERRCODE='22023';
  END IF;
  IF public.baseline_plain(p_answers,'confirmed_bookings','count_per_month')
       > public.baseline_plain(p_answers,'inquiries_per_month','count_per_month') THEN
    RAISE EXCEPTION 'Bookings cannot exceed inquiries' USING ERRCODE='22023';
  END IF;
  IF public.baseline_plain(p_answers,'followed_up_within_two_days','count_per_month')
       > public.baseline_plain(p_answers,'inquiries_per_month','count_per_month') THEN
    RAISE EXCEPTION 'Follow-ups cannot exceed inquiries' USING ERRCODE='22023';
  END IF;
  hours := coalesce(public.baseline_plain(p_answers,'admin_hours_calls','hours_per_week'),0)
    + coalesce(public.baseline_plain(p_answers,'admin_hours_follow_up','hours_per_week'),0)
    + coalesce(public.baseline_plain(p_answers,'admin_hours_crm','hours_per_week'),0)
    + coalesce(public.baseline_plain(p_answers,'admin_hours_scheduling','hours_per_week'),0);
  IF hours > 168 THEN
    RAISE EXCEPTION 'Admin hours cannot exceed a week' USING ERRCODE='22023';
  END IF;
  IF p_answers->'pilot_secondary_outcome'->>'state' = 'value'
     AND p_answers->'pilot_secondary_outcome'->>'value' = p_answers->'pilot_primary_outcome'->>'value' THEN
    RAISE EXCEPTION 'Secondary outcome must differ from the primary outcome' USING ERRCODE='22023';
  END IF;
END $$;

-- Live authority. NULL means "no baseline authority at all".
CREATE FUNCTION public.baseline_actor_role(p_shop uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT CASE
    WHEN auth.uid() IS NULL THEN NULL
    WHEN public.team_is_owner(p_shop) THEN 'owner'
    WHEN EXISTS (SELECT 1 FROM public.shop_memberships m
      WHERE m.shop_id = p_shop AND m.user_id = auth.uid() AND m.active
        AND m.role = 'manager' AND 'baseline.draft' = ANY(m.capabilities)) THEN 'manager'
  END;
$$;

-- ---------------------------------------------------------------------------
-- Owner / delegated-manager commands (session only)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.baseline_save_draft(
  p_shop uuid,
  p_answers jsonb,
  p_expected_draft_version integer DEFAULT NULL,
  p_catalog_version text DEFAULT 'baseline.v1'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor text; current_draft public.baseline_drafts; next_version integer;
BEGIN
  -- Locks the shop, then re-checks live membership, so a concurrent revocation
  -- serializes with this write instead of authorizing on a stale grant.
  PERFORM public.team_lock(p_shop);
  actor := public.baseline_actor_role(p_shop);
  IF actor IS NULL THEN
    RAISE EXCEPTION 'Baseline authority required' USING ERRCODE='42501';
  END IF;
  PERFORM public.baseline_validate_answers(p_catalog_version, p_answers, false);
  SELECT * INTO current_draft FROM public.baseline_drafts WHERE shop_id = p_shop FOR UPDATE;
  IF current_draft.shop_id IS NULL THEN
    IF p_expected_draft_version IS NOT NULL THEN
      RAISE EXCEPTION 'Draft changed; reload' USING ERRCODE='PT409';
    END IF;
    INSERT INTO public.baseline_drafts(shop_id, catalog_version, answers, draft_version, updated_by, updated_by_role)
    VALUES (p_shop, p_catalog_version, p_answers, 1, auth.uid(), actor);
    next_version := 1;
  ELSE
    IF p_expected_draft_version IS DISTINCT FROM current_draft.draft_version THEN
      RAISE EXCEPTION 'Draft changed; reload' USING ERRCODE='PT409';
    END IF;
    next_version := current_draft.draft_version + 1;
    UPDATE public.baseline_drafts
      SET catalog_version = p_catalog_version, answers = p_answers, draft_version = next_version,
          updated_by = auth.uid(), updated_by_role = actor, updated_at = clock_timestamp()
      WHERE shop_id = p_shop;
  END IF;
  RETURN jsonb_build_object('draft_version', next_version);
END $$;

CREATE FUNCTION public.baseline_submit(
  p_shop uuid,
  p_answers jsonb,
  p_period_start date,
  p_period_end date,
  p_expected_baseline integer DEFAULT NULL,
  p_expected_draft_version integer DEFAULT NULL,
  p_evidence uuid[] DEFAULT '{}',
  p_catalog_version text DEFAULT 'baseline.v1'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  current_pointer public.baseline_pointer;
  current_draft public.baseline_drafts;
  next_revision integer;
  matched integer;
  distinct_metrics integer;
  evidence uuid[] := coalesce(p_evidence, '{}');
  created timestamptz := clock_timestamp();
BEGIN
  PERFORM public.team_lock(p_shop);
  IF public.baseline_actor_role(p_shop) IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Only the owner can submit the baseline' USING ERRCODE='42501';
  END IF;
  PERFORM public.baseline_validate_answers(p_catalog_version, p_answers, true);
  IF p_period_start IS NULL OR p_period_end IS NULL OR p_period_end < p_period_start
     OR p_period_end - p_period_start > 400 OR p_period_end > current_date THEN
    RAISE EXCEPTION 'Invalid reporting period' USING ERRCODE='22023';
  END IF;

  SELECT * INTO current_pointer FROM public.baseline_pointer WHERE shop_id = p_shop FOR UPDATE;
  IF p_expected_baseline IS DISTINCT FROM current_pointer.revision THEN
    RAISE EXCEPTION 'Baseline changed; reload' USING ERRCODE='PT409';
  END IF;

  SELECT * INTO current_draft FROM public.baseline_drafts WHERE shop_id = p_shop FOR UPDATE;
  IF p_expected_draft_version IS DISTINCT FROM current_draft.draft_version THEN
    -- Never silently discard a newer draft (for example a manager's edits).
    RAISE EXCEPTION 'Draft changed; reload' USING ERRCODE='PT409';
  END IF;
  IF current_draft.shop_id IS NOT NULL THEN created := current_draft.created_at; END IF;

  IF cardinality(evidence) > 50 OR array_position(evidence, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Invalid evidence list' USING ERRCODE='22023';
  END IF;
  IF cardinality(evidence) > 0 THEN
    SELECT count(*), count(DISTINCT metric_key) INTO matched, distinct_metrics
    FROM public.baseline_measurements WHERE shop_id = p_shop AND id = ANY(evidence);
    IF matched <> (SELECT count(DISTINCT e) FROM unnest(evidence) e)
       OR matched <> cardinality(evidence) OR distinct_metrics <> matched THEN
      RAISE EXCEPTION 'Evidence must be this shop''s measurements, one per metric' USING ERRCODE='22023';
    END IF;
  END IF;

  SELECT coalesce(max(revision), 0) + 1 INTO next_revision
  FROM public.baseline_assessment_revisions WHERE shop_id = p_shop;

  INSERT INTO public.baseline_assessment_revisions(
    shop_id, revision, catalog_version, answers, answers_hash, reporting_period_start,
    reporting_period_end, evidence_measurement_ids, supersedes_revision, submitted_by,
    submitted_by_role, drafted_by, drafted_by_role, created_at)
  VALUES (
    p_shop, next_revision, p_catalog_version, p_answers,
    encode(sha256(convert_to(p_answers::text, 'UTF8')), 'hex'),
    p_period_start, p_period_end, evidence, current_pointer.revision, auth.uid(), 'owner',
    current_draft.updated_by, current_draft.updated_by_role, created);

  INSERT INTO public.baseline_pointer(shop_id, revision, advanced_by)
  VALUES (p_shop, next_revision, auth.uid())
  ON CONFLICT (shop_id) DO UPDATE
    SET revision = EXCLUDED.revision, advanced_by = EXCLUDED.advanced_by,
        advanced_at = clock_timestamp();

  INSERT INTO public.baseline_pointer_events(shop_id, kind, from_revision, to_revision, actor_id)
  VALUES (p_shop,
    CASE WHEN current_pointer.revision IS NULL THEN 'submitted' ELSE 'superseded' END,
    current_pointer.revision, next_revision, auth.uid());

  DELETE FROM public.baseline_drafts WHERE shop_id = p_shop;

  RETURN jsonb_build_object(
    'revision', next_revision,
    'kind', CASE WHEN current_pointer.revision IS NULL THEN 'submitted' ELSE 'superseded' END,
    'supersedes_revision', current_pointer.revision);
END $$;

-- ---------------------------------------------------------------------------
-- Reads (owner or delegated manager; live authority at call time)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.baseline_read(p_shop uuid, p_revision integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE
  actor text := public.baseline_actor_role(p_shop);
  pointer public.baseline_pointer;
  rev public.baseline_assessment_revisions;
  draft public.baseline_drafts;
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'Baseline authority required' USING ERRCODE='42501';
  END IF;
  SELECT * INTO pointer FROM public.baseline_pointer WHERE shop_id = p_shop;
  SELECT * INTO rev FROM public.baseline_assessment_revisions
    WHERE shop_id = p_shop AND revision = coalesce(p_revision, pointer.revision);
  SELECT * INTO draft FROM public.baseline_drafts WHERE shop_id = p_shop;
  RETURN jsonb_build_object(
    'role', actor,
    'pointer', CASE WHEN pointer.shop_id IS NULL THEN NULL
      ELSE jsonb_build_object('revision', pointer.revision, 'advanced_at', pointer.advanced_at) END,
    'revision', CASE WHEN rev.shop_id IS NULL THEN NULL ELSE jsonb_build_object(
      'revision', rev.revision, 'catalog_version', rev.catalog_version, 'answers', rev.answers,
      'answers_hash', rev.answers_hash, 'reporting_period_start', rev.reporting_period_start,
      'reporting_period_end', rev.reporting_period_end, 'supersedes_revision', rev.supersedes_revision,
      'submitted_by_role', rev.submitted_by_role, 'drafted_by_role', rev.drafted_by_role,
      'created_at', rev.created_at, 'submitted_at', rev.submitted_at) END,
    'measurements', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', m.id, 'metric_key', m.metric_key, 'definition_version', m.definition_version,
        'evidence_class', m.evidence_class, 'value', m.value, 'unit', m.unit,
        'window_start', m.window_start, 'window_end', m.window_end,
        'source_system', m.source_system, 'source_ref', m.source_ref,
        'formula_version', m.formula_version, 'inputs', m.inputs) ORDER BY m.metric_key)
      FROM public.baseline_measurements m
      WHERE rev.shop_id IS NOT NULL AND m.shop_id = p_shop AND m.id = ANY(rev.evidence_measurement_ids)),
      '[]'::jsonb),
    'revisions', coalesce((
      SELECT jsonb_agg(jsonb_build_object('revision', r.revision, 'submitted_at', r.submitted_at)
        ORDER BY r.revision DESC)
      FROM (SELECT revision, submitted_at FROM public.baseline_assessment_revisions
        WHERE shop_id = p_shop ORDER BY revision DESC LIMIT 20) r), '[]'::jsonb),
    'draft', CASE WHEN draft.shop_id IS NULL THEN NULL ELSE jsonb_build_object(
      'draft_version', draft.draft_version, 'catalog_version', draft.catalog_version,
      'answers', draft.answers, 'updated_by_role', draft.updated_by_role,
      'updated_at', draft.updated_at) END);
END $$;

-- Measurements whose window is EXACTLY the requested window. Never stitched,
-- never inferred: a metric without such a row is simply "not measured".
CREATE FUNCTION public.baseline_read_window(
  p_shop uuid,
  p_window_start timestamptz,
  p_window_end timestamptz
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF public.baseline_actor_role(p_shop) IS NULL THEN
    RAISE EXCEPTION 'Baseline authority required' USING ERRCODE='42501';
  END IF;
  IF p_window_start IS NULL OR p_window_end IS NULL OR p_window_end <= p_window_start THEN
    RAISE EXCEPTION 'Invalid window' USING ERRCODE='22023';
  END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'id', m.id, 'metric_key', m.metric_key, 'definition_version', m.definition_version,
      'evidence_class', m.evidence_class, 'value', m.value, 'unit', m.unit,
      'window_start', m.window_start, 'window_end', m.window_end,
      'source_system', m.source_system, 'source_ref', m.source_ref,
      'formula_version', m.formula_version, 'inputs', m.inputs)
      ORDER BY m.metric_key, m.recorded_at)
    FROM public.baseline_measurements m
    WHERE m.shop_id = p_shop AND m.window_start = p_window_start AND m.window_end = p_window_end),
    '[]'::jsonb);
END $$;

-- ---------------------------------------------------------------------------
-- Evidence recording (service role only; deterministic server code, never a model)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.baseline_record_measurement(
  p_shop uuid,
  p_metric_key text,
  p_definition_version text,
  p_evidence_class text,
  p_value numeric,
  p_unit text,
  p_window_start timestamptz,
  p_window_end timestamptz,
  p_source_system text DEFAULT NULL,
  p_source_ref text DEFAULT NULL,
  p_formula_version text DEFAULT NULL,
  p_inputs jsonb DEFAULT '[]'::jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  def public.baseline_metric_definitions;
  existing public.baseline_measurements;
  input jsonb;
  input_row public.baseline_measurements;
  new_id uuid;
BEGIN
  PERFORM 1 FROM public.shops WHERE id = p_shop FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shop not found' USING ERRCODE='P0002';
  END IF;
  SELECT * INTO def FROM public.baseline_metric_definitions
    WHERE metric_key = p_metric_key AND definition_version = p_definition_version;
  IF def.metric_key IS NULL OR def.unit IS DISTINCT FROM p_unit THEN
    RAISE EXCEPTION 'Unknown metric definition or unit' USING ERRCODE='22023';
  END IF;
  IF p_evidence_class NOT IN ('connected_evidence','gradia_observed','derived','unknown')
     OR p_inputs IS NULL OR jsonb_typeof(p_inputs) <> 'array'
     OR (p_evidence_class = 'derived' AND (p_formula_version IS NULL OR jsonb_array_length(p_inputs) = 0))
     OR (p_evidence_class <> 'derived' AND (p_formula_version IS NOT NULL OR jsonb_array_length(p_inputs) <> 0)) THEN
    RAISE EXCEPTION 'Evidence class, formula version and inputs are inconsistent' USING ERRCODE='22023';
  END IF;
  IF p_evidence_class = 'derived' THEN
    IF p_inputs IS NULL OR jsonb_typeof(p_inputs) <> 'array' THEN
      RAISE EXCEPTION 'Derived evidence must cite its inputs' USING ERRCODE='22023';
    END IF;
    FOR input IN SELECT value FROM jsonb_array_elements(p_inputs) LOOP
      IF jsonb_typeof(input) <> 'object' OR ARRAY(SELECT jsonb_object_keys(input) ORDER BY 1) <> ARRAY['measurement_id']
         OR jsonb_typeof(input->'measurement_id') <> 'string'
         OR (input->>'measurement_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION 'Invalid derived input' USING ERRCODE='22023';
      END IF;
      SELECT * INTO input_row FROM public.baseline_measurements
        WHERE shop_id = p_shop AND id = (input->>'measurement_id')::uuid;
      -- A derived value is only meaningful over the same window as its inputs.
      IF input_row.id IS NULL OR input_row.window_start <> p_window_start OR input_row.window_end <> p_window_end THEN
        RAISE EXCEPTION 'Derived inputs must be this shop''s measurements over the same window' USING ERRCODE='22023';
      END IF;
    END LOOP;
  END IF;

  -- Atomic insert-or-observe on the identity index (the shop lock above also
  -- serializes writers). A replay returns the original id only when the complete
  -- immutable fact matches: value, formula version and ordered input lineage.
  -- Identity already fixes shop, metric, definition, window, class and source.
  INSERT INTO public.baseline_measurements(
    shop_id, metric_key, definition_version, evidence_class, value, unit, window_start,
    window_end, source_system, source_ref, formula_version, inputs)
  VALUES (p_shop, p_metric_key, p_definition_version, p_evidence_class, p_value, p_unit,
    p_window_start, p_window_end, p_source_system, p_source_ref, p_formula_version,
    coalesce(p_inputs, '[]'::jsonb))
  ON CONFLICT (shop_id, metric_key, definition_version, window_start, window_end,
    evidence_class, coalesce(source_system, ''), coalesce(source_ref, '')) DO NOTHING
  RETURNING id INTO new_id;
  IF new_id IS NOT NULL THEN RETURN new_id; END IF;

  SELECT * INTO existing FROM public.baseline_measurements
  WHERE shop_id = p_shop AND metric_key = p_metric_key AND definition_version = p_definition_version
    AND window_start = p_window_start AND window_end = p_window_end
    AND evidence_class = p_evidence_class
    AND coalesce(source_system,'') = coalesce(p_source_system,'')
    AND coalesce(source_ref,'') = coalesce(p_source_ref,'');
  IF existing.id IS NOT NULL
     AND existing.value IS NOT DISTINCT FROM p_value
     AND existing.unit = p_unit
     AND existing.formula_version IS NOT DISTINCT FROM p_formula_version
     AND existing.inputs = coalesce(p_inputs, '[]'::jsonb) THEN
    RETURN existing.id;
  END IF;
  RAISE EXCEPTION 'A different measurement already exists for this window' USING ERRCODE='PT409';
  RETURN new_id;
END $$;

-- ---------------------------------------------------------------------------
-- Function ACLs
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  public.baseline_catalog_immutable(), public.baseline_append_only(),
  public.baseline_pointer_forward_only(), public.baseline_plain(jsonb, text, text),
  public.baseline_validate_answers(text, jsonb, boolean), public.baseline_actor_role(uuid),
  public.baseline_save_draft(uuid, jsonb, integer, text),
  public.baseline_submit(uuid, jsonb, date, date, integer, integer, uuid[], text),
  public.baseline_read(uuid, integer), public.baseline_read_window(uuid, timestamptz, timestamptz),
  public.baseline_record_measurement(uuid, text, text, text, numeric, text, timestamptz, timestamptz, text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.baseline_save_draft(uuid, jsonb, integer, text),
  public.baseline_submit(uuid, jsonb, date, date, integer, integer, uuid[], text),
  public.baseline_read(uuid, integer),
  public.baseline_read_window(uuid, timestamptz, timestamptz)
  TO authenticated;
GRANT EXECUTE ON FUNCTION
  public.baseline_record_measurement(uuid, text, text, text, numeric, text, timestamptz, timestamptz, text, text, text, jsonb)
  TO service_role;

COMMIT;
