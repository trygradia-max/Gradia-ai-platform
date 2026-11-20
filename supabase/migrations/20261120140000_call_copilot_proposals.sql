BEGIN;

-- Call Copilot PR E (NEXT_BUILD_ORDER_2026-11-04): consented transcript evidence, source-cited
-- extraction runs and APPROVAL-REQUIRED CRM proposals for human-first inbound calls.
--
-- Builds on PR D (call_copilot_calls / events / conflicts and the capture gate). Reuses the existing
-- pending_actions + control_claim execution boundary: there is NO second executor, NO parallel CRM
-- and NO second memory store. New objects:
--
--  * call_copilot_transcript_segments   append-only, tenant-bound, speaker + captured-time cited text.
--                                       No role can read or write it directly; every write and read
--                                       passes the PR D capture gate for the segment's exact time.
--  * call_copilot_transcript_conflicts  a provider replayed a segment id / index with DIFFERENT text.
--  * call_copilot_evidence_revisions    stable, digest-identified snapshots of what was captured, with
--                                       truthful coverage (complete only when provider-attested AND
--                                       every observable check passes; otherwise partial with reasons).
--  * call_copilot_extraction_runs       one terminal run per (evidence, extractor, CRM context).
--  * call_copilot_proposals             append-only proposals: exact transcript-span citations per field,
--                                       confidence, ambiguity, CRM snapshot, route. Executable ones are
--                                       staged as ordinary APPROVAL-REQUIRED pending_actions; the rest
--                                       are review-only. Creating a proposal grants no execution.
--  * call_copilot_memory_submissions    an owner-session hand-off of a customer-specific memory proposal
--                                       to the EXISTING reviewed-memory candidate lifecycle (inert).
--
-- Existing behaviour changes in exactly one place: control_claim gains a pre-effect recheck that only
-- ever DENIES, and only for pending actions that are linked to a Call Copilot proposal. Every other
-- action takes the identical path as before. No existing table, column, row or grant is altered.

DO $$
BEGIN
  IF to_regclass('public.call_copilot_calls') IS NULL OR to_regclass('public.pending_actions') IS NULL
     OR to_regclass('public.reviewed_memory_revisions') IS NULL OR to_regprocedure('public.control_claim(uuid,uuid,uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION 'PR D ledger, pending_actions, reviewed memory and control_claim are required' USING ERRCODE = '23514';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Small internal helpers
-- ---------------------------------------------------------------------------
-- The only humans who may request extraction: the shop owner, or a manager explicitly granted crm.read.
CREATE FUNCTION public.call_copilot_actor_ok(p_shop uuid, p_actor uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p_shop IS NOT NULL AND p_actor IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.shop_memberships m JOIN public.shops s ON s.id = m.shop_id
     WHERE m.shop_id = p_shop AND m.user_id = p_actor AND m.active
       AND ((m.role = 'owner' AND s.owner_id = m.user_id)
         OR (m.role = 'manager' AND 'crm.read' = ANY (m.capabilities))))
$$;

CREATE FUNCTION public.call_copilot_luhn(p_digits text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE d text := regexp_replace(coalesce(p_digits, ''), '\D', '', 'g'); i integer; total integer := 0; n integer; alt boolean := false;
BEGIN
  IF length(d) NOT BETWEEN 13 AND 19 THEN RETURN false; END IF;
  FOR i IN REVERSE length(d)..1 LOOP
    n := substr(d, i, 1)::integer;
    IF alt THEN n := n * 2; IF n > 9 THEN n := n - 9; END IF; END IF;
    total := total + n; alt := NOT alt;
  END LOOP;
  RETURN total % 10 = 0;
END $$;

-- Defence in depth: the application redacts payment-card numbers before storage; the database refuses any
-- Luhn-valid number laid out like a card (13-19 contiguous digits, 4-4-4-x, or the 4-6-5 American Express layout,
-- spaces or dashes between groups). The layouts are deliberately structural so identifiers that merely contain
-- digits (UUIDs 8-4-4-4-12, ISO timestamps) can never be mistaken for a card, whatever their Luhn sum.
CREATE FUNCTION public.call_copilot_has_card_number(p_text text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE m text[];
BEGIN
  FOR m IN SELECT regexp_matches(coalesce(p_text, ''),
      '(?<![0-9A-Fa-f])(\d{13,19}|\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,7}|\d{4}[ -]\d{6}[ -]\d{4,5})(?![0-9A-Fa-f])', 'g') LOOP
    IF public.call_copilot_luhn(m[1]) THEN RETURN true; END IF;
  END LOOP;
  RETURN false;
END $$;

CREATE FUNCTION public.call_copilot_segment_digest(
  p_index integer, p_provider_segment_id text, p_speaker text, p_started_at timestamptz, p_ended_at timestamptz, p_text text
) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT encode(sha256(convert_to(
    'v1|' || p_index::text || '|' || p_provider_segment_id || '|' || p_speaker || '|'
    || public.call_copilot_ts(p_started_at) || '|' || public.call_copilot_ts(p_ended_at) || '|' || p_text, 'UTF8')), 'hex')
$$;

-- ---------------------------------------------------------------------------
-- Transcript segments (append-only; no direct access for ANY role)
-- ---------------------------------------------------------------------------
CREATE TABLE public.call_copilot_transcript_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  arrival_seq bigint GENERATED ALWAYS AS IDENTITY,
  shop_id uuid NOT NULL,
  call_id uuid NOT NULL,
  segment_index integer NOT NULL CHECK (segment_index BETWEEN 0 AND 4999),
  provider_segment_id text NOT NULL CHECK (provider_segment_id ~ '^[A-Za-z0-9:_.-]{1,128}$'),
  speaker text NOT NULL CHECK (speaker IN ('operator', 'caller', 'unknown')),
  started_at timestamptz NOT NULL CHECK (started_at >= timestamptz '2020-01-01 00:00:00+00'),
  ended_at timestamptz NOT NULL,
  text text NOT NULL CHECK (length(btrim(text)) BETWEEN 1 AND 2000),
  redactions text[] NOT NULL DEFAULT '{}' CHECK (redactions <@ ARRAY['payment_card','national_id','bank_account','credential']::text[]),
  content_digest text NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (ended_at > started_at),
  CHECK (NOT public.call_copilot_has_card_number(text)),
  UNIQUE (shop_id, call_id, segment_index),
  UNIQUE (shop_id, call_id, provider_segment_id),
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, call_id) REFERENCES public.call_copilot_calls(shop_id, id) ON DELETE CASCADE
);

CREATE TABLE public.call_copilot_transcript_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  call_id uuid NOT NULL,
  conflict_kind text NOT NULL CHECK (conflict_kind IN ('segment_id_changed', 'index_reused')),
  provider_segment_id text NOT NULL CHECK (provider_segment_id ~ '^[A-Za-z0-9:_.-]{1,128}$'),
  attempted_index integer NOT NULL CHECK (attempted_index BETWEEN 0 AND 4999),
  attempted_digest text NOT NULL CHECK (attempted_digest ~ '^[0-9a-f]{64}$'),
  existing_segment_id uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (shop_id, call_id, conflict_kind, provider_segment_id, attempted_digest),
  FOREIGN KEY (shop_id, call_id) REFERENCES public.call_copilot_calls(shop_id, id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, existing_segment_id) REFERENCES public.call_copilot_transcript_segments(shop_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- Evidence revisions: stable identity of exactly what was captured, plus truthful coverage.
-- ---------------------------------------------------------------------------
CREATE TABLE public.call_copilot_evidence_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  call_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  -- 'complete' is never inferred: it needs a provider attestation AND every observable check below.
  coverage_status text NOT NULL CHECK (coverage_status IN ('complete', 'partial')),
  coverage_reasons text[] NOT NULL,
  declared_final boolean NOT NULL,
  expected_segment_count integer CHECK (expected_segment_count IS NULL OR expected_segment_count BETWEEN 0 AND 5000),
  segment_count integer NOT NULL CHECK (segment_count >= 1),
  capture_status text NOT NULL,
  capture_reason text NOT NULL,
  call_ended boolean NOT NULL,
  outcome_unknown boolean NOT NULL,
  intervals jsonb NOT NULL,
  gaps jsonb NOT NULL,
  sealed_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((coverage_status = 'complete') = (cardinality(coverage_reasons) = 0)),
  UNIQUE (shop_id, call_id, revision),
  UNIQUE (shop_id, call_id, evidence_digest),
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, call_id) REFERENCES public.call_copilot_calls(shop_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- Extraction runs. A completed or unknown-outcome run is terminal for its key and is never retried
-- automatically; a run that failed before any effect only records that it failed.
-- ---------------------------------------------------------------------------
CREATE TABLE public.call_copilot_extraction_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  call_id uuid NOT NULL,
  evidence_revision_id uuid NOT NULL,
  run_key text NOT NULL CHECK (run_key ~ '^[0-9a-f]{64}$'),
  extractor_id text NOT NULL CHECK (extractor_id ~ '^[a-z][a-z0-9._-]{1,63}$'),
  extractor_version text NOT NULL CHECK (extractor_version ~ '^[A-Za-z0-9._-]{1,64}$'),
  schema_version integer NOT NULL CHECK (schema_version >= 1),
  crm_context_digest text NOT NULL CHECK (crm_context_digest ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('completed', 'unknown_outcome', 'failed_before_effect')),
  failure_code text CHECK (failure_code ~ '^[a-z][a-z0-9_]{2,63}$'),
  refused_count integer NOT NULL DEFAULT 0 CHECK (refused_count BETWEEN 0 AND 1000),
  proposal_count integer NOT NULL DEFAULT 0 CHECK (proposal_count BETWEEN 0 AND 100),
  definition_agent_id uuid,
  definition_revision integer,
  requested_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (status <> 'completed' OR failure_code IS NULL),
  CHECK (status <> 'failed_before_effect' OR failure_code IS NOT NULL),
  CHECK (status = 'completed' OR proposal_count = 0),
  CHECK ((definition_agent_id IS NULL) = (definition_revision IS NULL)),
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, call_id) REFERENCES public.call_copilot_calls(shop_id, id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, evidence_revision_id) REFERENCES public.call_copilot_evidence_revisions(shop_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX call_copilot_runs_terminal_key
  ON public.call_copilot_extraction_runs (shop_id, call_id, run_key) WHERE status IN ('completed', 'unknown_outcome');

-- ---------------------------------------------------------------------------
-- Proposals. Every one starts APPROVAL REQUIRED; creating one grants no execution.
-- ---------------------------------------------------------------------------
CREATE TABLE public.call_copilot_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  call_id uuid NOT NULL,
  run_id uuid NOT NULL,
  evidence_revision_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'customer', 'vehicle', 'service_request', 'timing', 'lead', 'quote_draft',
    'appointment_draft', 'followup_task', 'message_draft', 'memory_candidate')),
  -- Stable identity within an evidence revision, computed here from the staged content.
  proposal_key text NOT NULL CHECK (proposal_key ~ '^[0-9a-f]{64}$'),
  initial_mode text NOT NULL DEFAULT 'approval_required' CHECK (initial_mode = 'approval_required'),
  route text NOT NULL CHECK (route IN ('pending_action', 'review_only')),
  action_type text CHECK (action_type IN (
    'resolve_customer', 'update_customer', 'record_interaction', 'create_quote', 'book_appointment', 'send_sms')),
  pending_action_id uuid,
  -- The exact operative payload that was staged; claim-time recheck compares the live one to it.
  staged_payload jsonb,
  review_reason text CHECK (review_reason ~ '^[a-z][a-z0-9_]{2,63}$'),
  confidence text NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  fields jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'array' AND jsonb_array_length(fields) BETWEEN 1 AND 20),
  ambiguity jsonb,
  -- Identity fields of the CRM row the proposal was built against, read by the database itself.
  crm_binding jsonb,
  customer_id uuid,
  definition_agent_id uuid,
  definition_revision integer,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((route = 'pending_action') = (pending_action_id IS NOT NULL)),
  CHECK ((route = 'pending_action') = (action_type IS NOT NULL AND staged_payload IS NOT NULL)),
  CHECK ((route = 'review_only') = (review_reason IS NOT NULL)),
  CHECK ((definition_agent_id IS NULL) = (definition_revision IS NULL)),
  UNIQUE (shop_id, evidence_revision_id, proposal_key),
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, call_id) REFERENCES public.call_copilot_calls(shop_id, id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, run_id) REFERENCES public.call_copilot_extraction_runs(shop_id, id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, evidence_revision_id) REFERENCES public.call_copilot_evidence_revisions(shop_id, id) ON DELETE CASCADE,
  -- Deferred so a shop delete (which cascades both tables) is judged after all cascades; a lone delete of a
  -- linked pending action still fails at commit.
  FOREIGN KEY (shop_id, pending_action_id) REFERENCES public.pending_actions(shop_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX call_copilot_proposals_action_unique ON public.call_copilot_proposals (shop_id, pending_action_id)
  WHERE pending_action_id IS NOT NULL;
CREATE INDEX call_copilot_proposals_call_idx ON public.call_copilot_proposals (shop_id, call_id, created_at);

CREATE TABLE public.call_copilot_memory_submissions (
  proposal_id uuid PRIMARY KEY,
  shop_id uuid NOT NULL,
  source_id uuid NOT NULL,
  revision integer NOT NULL,
  submitted_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (shop_id, proposal_id) REFERENCES public.call_copilot_proposals(shop_id, id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, source_id, revision) REFERENCES public.reviewed_memory_revisions(shop_id, source_id, revision) ON DELETE CASCADE
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['call_copilot_transcript_segments', 'call_copilot_transcript_conflicts',
    'call_copilot_evidence_revisions', 'call_copilot_extraction_runs', 'call_copilot_proposals',
    'call_copilot_memory_submissions'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.call_copilot_append_only()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.call_copilot_append_only()', t || '_no_truncate', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated, service_role', t);
  END LOOP;
END $$;
-- Transcript text and conflict evidence: reachable ONLY through the gated functions below.
-- The derived tables are readable by the service role (the future owner UI adds its own RLS read policy).
GRANT SELECT ON public.call_copilot_evidence_revisions, public.call_copilot_extraction_runs,
  public.call_copilot_proposals, public.call_copilot_memory_submissions TO service_role;

-- ---------------------------------------------------------------------------
-- Gate for a transcript span: PR D's derived gate at the span START, plus the whole span must lie
-- inside ONE consented captured interval (a span that straddles a gap is refused).
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.call_copilot_assert_span(
  p_shop uuid, p_call uuid, p_start timestamptz, p_end timestamptz, p_purpose text
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE s jsonb; iv jsonb; ok boolean := false;
BEGIN
  IF p_start IS NULL OR p_end IS NULL OR p_end <= p_start THEN
    RAISE EXCEPTION 'Invalid transcript span' USING ERRCODE = '22023';
  END IF;
  s := public.call_copilot_assert_capture(p_shop, p_call, p_purpose, p_start);
  FOR iv IN SELECT * FROM jsonb_array_elements(s -> 'intervals') LOOP
    IF (iv ->> 'started_at')::timestamptz <= p_start
       AND (iv ->> 'ended_at' IS NULL OR p_end <= (iv ->> 'ended_at')::timestamptz) THEN
      ok := true;
    END IF;
  END LOOP;
  IF NOT ok THEN
    RAISE EXCEPTION 'Call Copilot capture is not permitted' USING ERRCODE = 'CC403', DETAIL = 'segment_outside_captured_interval';
  END IF;
  RETURN s;
END $$;

-- ---------------------------------------------------------------------------
-- Segment writer. The gate runs BEFORE anything is stored: declined, missing, unknown, paused-gap,
-- stopped or conflicting consent raises CC403 and no text is persisted.
--   recorded | duplicate (same id, same digest) | conflict (same id/index, different content)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.call_copilot_record_segment(
  p_shop uuid, p_call uuid, p_index integer, p_provider_segment_id text, p_speaker text,
  p_started_at timestamptz, p_ended_at timestamptz, p_text text, p_redactions text[]
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_digest text; v_existing record; v_id uuid;
BEGIN
  IF p_shop IS NULL OR p_call IS NULL OR p_index IS NULL OR p_provider_segment_id IS NULL OR p_speaker IS NULL
     OR p_started_at IS NULL OR p_ended_at IS NULL OR p_text IS NULL OR p_redactions IS NULL THEN
    RAISE EXCEPTION 'Transcript segment is incomplete' USING ERRCODE = '22023';
  END IF;
  IF p_ended_at > clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'Transcript segment time is in the future' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.call_copilot_calls WHERE id = p_call AND shop_id = p_shop FOR UPDATE;
  -- Gate first. An unknown call or another shop's call id is indistinguishable here (CC403).
  PERFORM public.call_copilot_assert_span(p_shop, p_call, p_started_at, p_ended_at, 'extraction');

  IF public.call_copilot_has_card_number(p_text) THEN
    RAISE EXCEPTION 'Payment-card data must be redacted before storage' USING ERRCODE = '22023';
  END IF;
  v_digest := public.call_copilot_segment_digest(p_index, p_provider_segment_id, p_speaker, p_started_at, p_ended_at, p_text);

  SELECT id, content_digest INTO v_existing FROM public.call_copilot_transcript_segments
   WHERE shop_id = p_shop AND call_id = p_call AND provider_segment_id = p_provider_segment_id;
  IF FOUND THEN
    IF v_existing.content_digest = v_digest THEN
      RETURN jsonb_build_object('outcome', 'duplicate', 'segment_id', v_existing.id, 'digest', v_digest);
    END IF;
    INSERT INTO public.call_copilot_transcript_conflicts
      (shop_id, call_id, conflict_kind, provider_segment_id, attempted_index, attempted_digest, existing_segment_id)
    VALUES (p_shop, p_call, 'segment_id_changed', p_provider_segment_id, p_index, v_digest, v_existing.id)
    ON CONFLICT DO NOTHING;
    RETURN jsonb_build_object('outcome', 'conflict', 'conflict_kind', 'segment_id_changed', 'digest', v_digest);
  END IF;
  SELECT id INTO v_existing FROM public.call_copilot_transcript_segments
   WHERE shop_id = p_shop AND call_id = p_call AND segment_index = p_index;
  IF FOUND THEN
    INSERT INTO public.call_copilot_transcript_conflicts
      (shop_id, call_id, conflict_kind, provider_segment_id, attempted_index, attempted_digest, existing_segment_id)
    VALUES (p_shop, p_call, 'index_reused', p_provider_segment_id, p_index, v_digest, v_existing.id)
    ON CONFLICT DO NOTHING;
    RETURN jsonb_build_object('outcome', 'conflict', 'conflict_kind', 'index_reused', 'digest', v_digest);
  END IF;

  INSERT INTO public.call_copilot_transcript_segments
    (shop_id, call_id, segment_index, provider_segment_id, speaker, started_at, ended_at, text, redactions, content_digest)
  VALUES (p_shop, p_call, p_index, p_provider_segment_id, p_speaker, p_started_at, p_ended_at, p_text, p_redactions, v_digest)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('outcome', 'recorded', 'segment_id', v_id, 'digest', v_digest);
END $$;

-- ---------------------------------------------------------------------------
-- Evidence snapshot: everything about "what was captured" folded into one digest, with coverage.
-- Coverage is TRUTHFUL: 'complete' requires provider attestation (declared_final + expected count)
-- AND call ended AND no unknown outcome AND no mid-call capture gap AND contiguous segment indexes
-- AND a matching count. Anything else is 'partial' and lists why. Unknown completion is partial.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.call_copilot_evidence_snapshot(
  p_shop uuid, p_call uuid, p_declared_final boolean, p_expected integer
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  st jsonb; n integer; first_idx integer; last_idx integer; seg_hash text; tconf integer; outside integer;
  reasons text[] := '{}'; g jsonb; mid_gap boolean := false; ok boolean; v_digest text;
BEGIN
  st := public.call_copilot_capture_state(p_shop, p_call);
  SELECT count(*), min(segment_index), max(segment_index),
         encode(sha256(convert_to(coalesce(string_agg(
           segment_index::text || ':' || provider_segment_id || ':' || content_digest || ':' || speaker || ':'
           || public.call_copilot_ts(started_at) || ':' || public.call_copilot_ts(ended_at), '|' ORDER BY segment_index), ''), 'UTF8')), 'hex')
    INTO n, first_idx, last_idx, seg_hash
    FROM public.call_copilot_transcript_segments WHERE shop_id = p_shop AND call_id = p_call;
  SELECT count(*) INTO tconf FROM public.call_copilot_transcript_conflicts WHERE shop_id = p_shop AND call_id = p_call;
  SELECT count(*) INTO outside FROM public.call_copilot_transcript_segments s
   WHERE s.shop_id = p_shop AND s.call_id = p_call AND NOT EXISTS (
     SELECT 1 FROM jsonb_array_elements(st -> 'intervals') iv
      WHERE (iv ->> 'started_at')::timestamptz <= s.started_at
        AND (iv ->> 'ended_at' IS NULL OR s.ended_at <= (iv ->> 'ended_at')::timestamptz));

  IF NOT coalesce(p_declared_final, false) THEN reasons := array_append(reasons, 'completion_not_attested'); END IF;
  IF NOT (st ->> 'call_ended')::boolean THEN reasons := array_append(reasons, 'call_not_ended'); END IF;
  IF (st ->> 'outcome_unknown')::boolean THEN reasons := array_append(reasons, 'provider_outcome_unknown'); END IF;
  FOR g IN SELECT * FROM jsonb_array_elements(st -> 'gaps') LOOP
    IF g ->> 'reason' <> 'before_consent' THEN mid_gap := true; END IF;
  END LOOP;
  IF mid_gap THEN reasons := array_append(reasons, 'capture_gap'); END IF;
  IF n = 0 OR first_idx <> 0 OR last_idx <> n - 1 THEN reasons := array_append(reasons, 'segment_holes'); END IF;
  IF p_expected IS NULL THEN reasons := array_append(reasons, 'segment_count_unconfirmed');
  ELSIF p_expected <> n THEN reasons := array_append(reasons, 'segment_count_mismatch'); END IF;

  ok := (st ->> 'derivation_permitted')::boolean AND tconf = 0 AND outside = 0;
  v_digest := encode(sha256(convert_to(
    'v1|' || seg_hash || '|' || coalesce(p_declared_final, false)::text || '|' || coalesce(p_expected::text, '-')
    || '|' || (st ->> 'status') || '|' || (st ->> 'reason') || '|' || (st ->> 'call_ended') || '|' || (st ->> 'outcome_unknown')
    || '|' || (st -> 'intervals')::text || '|' || (st -> 'gaps')::text || '|' || (st ->> 'conflict_count') || '|' || tconf::text, 'UTF8')), 'hex');

  RETURN jsonb_build_object(
    'ok', ok,
    'integrity', CASE WHEN NOT (st ->> 'derivation_permitted')::boolean THEN st ->> 'reason'
                      WHEN tconf > 0 THEN 'transcript_conflict'
                      WHEN outside > 0 THEN 'segment_outside_captured_interval' END,
    'digest', v_digest,
    'coverage_status', CASE WHEN cardinality(reasons) = 0 THEN 'complete' ELSE 'partial' END,
    'coverage_reasons', to_jsonb(reasons),
    'segment_count', n,
    'capture_status', st ->> 'status', 'capture_reason', st ->> 'reason',
    'call_ended', (st ->> 'call_ended')::boolean, 'outcome_unknown', (st ->> 'outcome_unknown')::boolean,
    'intervals', st -> 'intervals', 'gaps', st -> 'gaps');
END $$;

-- Seal: record the current evidence as a stable revision (or return the identical existing one).
CREATE FUNCTION public.call_copilot_seal_evidence(
  p_shop uuid, p_actor uuid, p_call uuid, p_declared_final boolean, p_expected integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE snap jsonb; rev public.call_copilot_evidence_revisions; next_rev integer; v_reasons text[];
BEGIN
  IF NOT public.call_copilot_actor_ok(p_shop, p_actor) THEN
    RAISE EXCEPTION 'Evidence actor unavailable' USING ERRCODE = '42501';
  END IF;
  IF p_declared_final IS NULL OR (p_expected IS NOT NULL AND p_expected NOT BETWEEN 0 AND 5000) THEN
    RAISE EXCEPTION 'Invalid evidence declaration' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.call_copilot_calls WHERE id = p_call AND shop_id = p_shop FOR UPDATE;
  PERFORM public.call_copilot_assert_capture(p_shop, p_call, 'extraction', NULL);
  snap := public.call_copilot_evidence_snapshot(p_shop, p_call, p_declared_final, p_expected);
  IF NOT (snap ->> 'ok')::boolean THEN
    RAISE EXCEPTION 'Call Copilot capture is not permitted' USING ERRCODE = 'CC403', DETAIL = coalesce(snap ->> 'integrity', 'evidence_integrity');
  END IF;
  IF (snap ->> 'segment_count')::integer = 0 THEN
    RETURN jsonb_build_object('outcome', 'empty');
  END IF;
  SELECT * INTO rev FROM public.call_copilot_evidence_revisions
   WHERE shop_id = p_shop AND call_id = p_call AND evidence_digest = snap ->> 'digest';
  IF FOUND THEN
    RETURN jsonb_build_object('outcome', 'unchanged', 'evidence_revision_id', rev.id, 'revision', rev.revision,
      'coverage_status', rev.coverage_status, 'coverage_reasons', to_jsonb(rev.coverage_reasons), 'digest', rev.evidence_digest);
  END IF;
  SELECT coalesce(max(revision), 0) + 1 INTO next_rev FROM public.call_copilot_evidence_revisions WHERE shop_id = p_shop AND call_id = p_call;
  SELECT coalesce(array_agg(x), '{}') INTO v_reasons FROM jsonb_array_elements_text(snap -> 'coverage_reasons') x;
  INSERT INTO public.call_copilot_evidence_revisions (
    shop_id, call_id, revision, evidence_digest, coverage_status, coverage_reasons, declared_final, expected_segment_count,
    segment_count, capture_status, capture_reason, call_ended, outcome_unknown, intervals, gaps, sealed_by)
  VALUES (p_shop, p_call, next_rev, snap ->> 'digest', snap ->> 'coverage_status', v_reasons, p_declared_final, p_expected,
    (snap ->> 'segment_count')::integer, snap ->> 'capture_status', snap ->> 'capture_reason',
    (snap ->> 'call_ended')::boolean, (snap ->> 'outcome_unknown')::boolean, snap -> 'intervals', snap -> 'gaps', p_actor)
  RETURNING * INTO rev;
  RETURN jsonb_build_object('outcome', 'sealed', 'evidence_revision_id', rev.id, 'revision', rev.revision,
    'coverage_status', rev.coverage_status, 'coverage_reasons', to_jsonb(rev.coverage_reasons), 'digest', rev.evidence_digest);
END $$;

-- Is a sealed revision still exactly what the call's evidence is now? (live consent + content)
CREATE FUNCTION public.call_copilot_evidence_is_current(p_shop uuid, p_revision uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE rev public.call_copilot_evidence_revisions; snap jsonb;
BEGIN
  SELECT * INTO rev FROM public.call_copilot_evidence_revisions WHERE shop_id = p_shop AND id = p_revision;
  IF NOT FOUND THEN RETURN jsonb_build_object('current', false, 'reason', 'evidence_revision_unknown'); END IF;
  snap := public.call_copilot_evidence_snapshot(p_shop, rev.call_id, rev.declared_final, rev.expected_segment_count);
  IF NOT (snap ->> 'ok')::boolean THEN
    RETURN jsonb_build_object('current', false, 'reason', coalesce(snap ->> 'integrity', 'evidence_integrity'), 'call_id', rev.call_id);
  END IF;
  IF snap ->> 'digest' <> rev.evidence_digest THEN
    RETURN jsonb_build_object('current', false, 'reason', 'evidence_changed', 'call_id', rev.call_id);
  END IF;
  RETURN jsonb_build_object('current', true, 'call_id', rev.call_id, 'revision', rev.revision);
END $$;

-- Gated transcript read for a model/extractor. Bounded; refuses a stale or unconsented revision.
CREATE FUNCTION public.call_copilot_read_transcript(p_shop uuid, p_actor uuid, p_call uuid, p_revision uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE rev public.call_copilot_evidence_revisions; cur jsonb; total integer; segs jsonb;
BEGIN
  IF NOT public.call_copilot_actor_ok(p_shop, p_actor) THEN
    RAISE EXCEPTION 'Evidence actor unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM public.call_copilot_assert_capture(p_shop, p_call, 'model_use', NULL);
  cur := public.call_copilot_evidence_is_current(p_shop, p_revision);
  SELECT * INTO rev FROM public.call_copilot_evidence_revisions WHERE shop_id = p_shop AND id = p_revision AND call_id = p_call;
  IF NOT FOUND OR NOT (cur ->> 'current')::boolean THEN
    -- A changed or unknown revision is stale (PT409); a consent / integrity failure is a denial (CC403).
    IF coalesce(cur ->> 'reason', 'evidence_revision_unknown') IN ('evidence_changed', 'evidence_revision_unknown') THEN
      RAISE EXCEPTION 'Evidence revision is not current' USING ERRCODE = 'PT409', DETAIL = coalesce(cur ->> 'reason', 'evidence_revision_unknown');
    END IF;
    RAISE EXCEPTION 'Call Copilot capture is not permitted' USING ERRCODE = 'CC403', DETAIL = cur ->> 'reason';
  END IF;
  SELECT coalesce(sum(length(text)), 0) INTO total FROM public.call_copilot_transcript_segments WHERE shop_id = p_shop AND call_id = p_call;
  IF rev.segment_count > 600 OR total > 120000 THEN
    RAISE EXCEPTION 'Transcript exceeds the bounded extraction size' USING ERRCODE = '22023', DETAIL = 'transcript_too_large';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'segment_id', id, 'index', segment_index, 'speaker', speaker, 'text', text,
      'started_at', public.call_copilot_ts(started_at), 'ended_at', public.call_copilot_ts(ended_at), 'redactions', to_jsonb(redactions))
    ORDER BY segment_index), '[]'::jsonb) INTO segs
    FROM public.call_copilot_transcript_segments WHERE shop_id = p_shop AND call_id = p_call;
  RETURN jsonb_build_object(
    'evidence_revision_id', rev.id, 'revision', rev.revision, 'digest', rev.evidence_digest,
    'coverage_status', rev.coverage_status, 'coverage_reasons', to_jsonb(rev.coverage_reasons),
    'segment_count', rev.segment_count, 'capture_status', rev.capture_status, 'capture_reason', rev.capture_reason,
    'call_ended', rev.call_ended, 'outcome_unknown', rev.outcome_unknown, 'gaps', rev.gaps,
    'segments', segs);
END $$;

-- Resolve and verify every citation against the stored transcript; the database recomputes the quote
-- digest and the speaker / captured time, so none of them is trusted from the caller.
CREATE FUNCTION public.call_copilot_resolve_fields(p_shop uuid, p_call uuid, p_fields jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE f jsonb; c jsonb; seg record; out_fields jsonb := '[]'::jsonb; out_cites jsonb; s integer; e integer; q text;
BEGIN
  IF p_fields IS NULL OR jsonb_typeof(p_fields) <> 'array' OR jsonb_array_length(p_fields) NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'Invalid proposal fields' USING ERRCODE = '22023';
  END IF;
  FOR f IN SELECT * FROM jsonb_array_elements(p_fields) LOOP
    IF jsonb_typeof(f) <> 'object' OR coalesce(f ->> 'name', '') !~ '^[a-z][a-z0-9_]{1,63}$'
       OR coalesce(f ->> 'confidence', '') NOT IN ('low', 'medium', 'high')
       OR NOT (f ? 'value') OR jsonb_typeof(f -> 'citations') IS DISTINCT FROM 'array'
       OR jsonb_array_length(f -> 'citations') NOT BETWEEN 1 AND 5 OR length((f -> 'value')::text) > 2000
       OR public.call_copilot_has_card_number((f -> 'value')::text) THEN
      RAISE EXCEPTION 'Invalid proposal field' USING ERRCODE = '22023';
    END IF;
    out_cites := '[]'::jsonb;
    FOR c IN SELECT * FROM jsonb_array_elements(f -> 'citations') LOOP
      IF jsonb_typeof(c) <> 'object' OR jsonb_typeof(c -> 'segment_index') IS DISTINCT FROM 'number'
         OR jsonb_typeof(c -> 'start') IS DISTINCT FROM 'number' OR jsonb_typeof(c -> 'end') IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'Invalid citation' USING ERRCODE = '22023';
      END IF;
      SELECT id, segment_index, speaker, started_at, ended_at, text INTO seg
        FROM public.call_copilot_transcript_segments
       WHERE shop_id = p_shop AND call_id = p_call AND segment_index = (c ->> 'segment_index')::integer;
      s := (c ->> 'start')::integer; e := (c ->> 'end')::integer;
      IF NOT FOUND OR s < 0 OR e <= s OR e > length(seg.text) THEN
        RAISE EXCEPTION 'Citation does not match the transcript' USING ERRCODE = '22023';
      END IF;
      q := substr(seg.text, s + 1, e - s);
      out_cites := out_cites || jsonb_build_array(jsonb_build_object(
        'segment_id', seg.id, 'segment_index', seg.segment_index, 'speaker', seg.speaker,
        'started_at', public.call_copilot_ts(seg.started_at), 'ended_at', public.call_copilot_ts(seg.ended_at),
        'start', s, 'end', e, 'quote_digest', encode(sha256(convert_to(q, 'UTF8')), 'hex')));
    END LOOP;
    out_fields := out_fields || jsonb_build_array(jsonb_build_object(
      'name', f ->> 'name', 'value', f -> 'value', 'confidence', f ->> 'confidence', 'citations', out_cites));
  END LOOP;
  RETURN out_fields;
END $$;

-- The CRM customer a proposal was built against, read by the database (never supplied by the caller): the row's
-- existence plus ONLY the identity fields the proposal actually used. Binding to unrelated fields would make
-- approving one proposal (say, filling an e-mail) needlessly invalidate its siblings.
CREATE FUNCTION public.call_copilot_customer_binding(p_shop uuid, p_customer uuid, p_fields text[]) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('customer_id', c.id)
    || CASE WHEN 'name'  = ANY (p_fields) THEN jsonb_build_object('name', c.name) ELSE '{}'::jsonb END
    || CASE WHEN 'phone' = ANY (p_fields) THEN jsonb_build_object('phone', c.phone_canonical) ELSE '{}'::jsonb END
    || CASE WHEN 'email' = ANY (p_fields) THEN jsonb_build_object('email', c.email_canonical) ELSE '{}'::jsonb END
    FROM public.customers c WHERE c.shop_id = p_shop AND c.id = p_customer
$$;

-- ---------------------------------------------------------------------------
-- Extraction recorder. ONE atomic call: run + proposals + staging of executable proposals as ordinary
-- pending_actions (APPROVAL REQUIRED). No proposal executes; no CRM, quote, booking, task or message
-- row is created here. Replays return the existing run; identical proposals dedupe.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.call_copilot_record_extraction(
  p_shop uuid, p_actor uuid, p_call uuid, p_revision uuid, p_run jsonb, p_proposals jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  cur jsonb; rev public.call_copilot_evidence_revisions; run_row public.call_copilot_extraction_runs;
  v_run_key text; v_status text; v_def_agent uuid; v_def_rev integer; p jsonb;
  v_fields jsonb; v_route text; v_atype text; v_payload jsonb; v_reason text; v_cust uuid; v_binding jsonb;
  v_key text; v_cmd uuid; v_prop_id uuid; v_conf text; v_existing uuid; v_ids jsonb := '[]'::jsonb; v_count integer := 0;
  v_vehicle uuid; v_skipped integer := 0; v_bind text[];
BEGIN
  IF NOT public.call_copilot_actor_ok(p_shop, p_actor) THEN
    RAISE EXCEPTION 'Extraction actor unavailable' USING ERRCODE = '42501';
  END IF;
  IF p_run IS NULL OR jsonb_typeof(p_run) <> 'object' OR p_proposals IS NULL OR jsonb_typeof(p_proposals) <> 'array'
     OR jsonb_array_length(p_proposals) > 100 THEN
    RAISE EXCEPTION 'Invalid extraction record' USING ERRCODE = '22023';
  END IF;
  v_status := p_run ->> 'status';
  IF v_status NOT IN ('completed', 'unknown_outcome', 'failed_before_effect')
     OR (v_status <> 'completed' AND jsonb_array_length(p_proposals) > 0) THEN
    RAISE EXCEPTION 'Invalid extraction status' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.shops WHERE id = p_shop FOR UPDATE;
  PERFORM 1 FROM public.call_copilot_calls WHERE id = p_call AND shop_id = p_shop FOR UPDATE;
  PERFORM public.call_copilot_assert_capture(p_shop, p_call, 'extraction', NULL);
  cur := public.call_copilot_evidence_is_current(p_shop, p_revision);
  SELECT * INTO rev FROM public.call_copilot_evidence_revisions WHERE shop_id = p_shop AND id = p_revision AND call_id = p_call;
  IF NOT FOUND OR NOT (cur ->> 'current')::boolean THEN
    IF coalesce(cur ->> 'reason', 'evidence_revision_unknown') IN ('evidence_changed', 'evidence_revision_unknown') THEN
      RAISE EXCEPTION 'Evidence revision is not current' USING ERRCODE = 'PT409', DETAIL = coalesce(cur ->> 'reason', 'evidence_revision_unknown');
    END IF;
    RAISE EXCEPTION 'Call Copilot capture is not permitted' USING ERRCODE = 'CC403', DETAIL = cur ->> 'reason';
  END IF;

  v_def_agent := nullif(p_run ->> 'definition_agent_id', '')::uuid;
  v_def_rev := nullif(p_run ->> 'definition_revision', '')::integer;
  IF (v_def_agent IS NULL) <> (v_def_rev IS NULL) THEN RAISE EXCEPTION 'Invalid definition binding' USING ERRCODE = '22023'; END IF;
  IF v_def_agent IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.agent_definition_state d
     WHERE d.shop_id = p_shop AND d.agent_id = v_def_agent AND d.lifecycle = 'active' AND d.active_revision = v_def_rev) THEN
    RAISE EXCEPTION 'Agent definition revision is not active' USING ERRCODE = 'PT409', DETAIL = 'call_definition_inactive';
  END IF;

  v_run_key := encode(sha256(convert_to(
    'v1|' || rev.evidence_digest || '|' || (p_run ->> 'extractor_id') || '|' || (p_run ->> 'extractor_version')
    || '|' || (p_run ->> 'schema_version') || '|' || (p_run ->> 'crm_context_digest'), 'UTF8')), 'hex');

  IF v_status IN ('completed', 'unknown_outcome') THEN
    SELECT * INTO run_row FROM public.call_copilot_extraction_runs
     WHERE shop_id = p_shop AND call_id = p_call AND run_key = v_run_key AND status IN ('completed', 'unknown_outcome');
    IF FOUND THEN
      RETURN jsonb_build_object('outcome', 'replayed', 'run_id', run_row.id, 'status', run_row.status,
        'proposal_ids', coalesce((SELECT jsonb_agg(id ORDER BY created_at, id) FROM public.call_copilot_proposals
                                   WHERE shop_id = p_shop AND run_id = run_row.id), '[]'::jsonb));
    END IF;
  END IF;

  INSERT INTO public.call_copilot_extraction_runs (
    shop_id, call_id, evidence_revision_id, run_key, extractor_id, extractor_version, schema_version, crm_context_digest,
    status, failure_code, refused_count, proposal_count, definition_agent_id, definition_revision, requested_by)
  VALUES (p_shop, p_call, p_revision, v_run_key, p_run ->> 'extractor_id', p_run ->> 'extractor_version',
    (p_run ->> 'schema_version')::integer, p_run ->> 'crm_context_digest', v_status, nullif(p_run ->> 'failure_code', ''),
    coalesce((p_run ->> 'refused_count')::integer, 0), jsonb_array_length(p_proposals), v_def_agent, v_def_rev, p_actor)
  RETURNING * INTO run_row;

  FOR p IN SELECT * FROM jsonb_array_elements(p_proposals) LOOP
    IF jsonb_typeof(p) <> 'object' THEN RAISE EXCEPTION 'Invalid proposal' USING ERRCODE = '22023'; END IF;
    v_fields := public.call_copilot_resolve_fields(p_shop, p_call, p -> 'fields');
    v_route := p ->> 'route';
    v_atype := nullif(p ->> 'action_type', '');
    v_payload := p -> 'payload';
    v_reason := nullif(p ->> 'review_reason', '');
    v_cust := nullif(p ->> 'customer_id', '')::uuid;
    v_vehicle := nullif(p ->> 'vehicle_id', '')::uuid;
    v_conf := p ->> 'confidence';
    IF coalesce(p ->> 'kind', '') NOT IN ('customer', 'vehicle', 'service_request', 'timing', 'lead', 'quote_draft',
         'appointment_draft', 'followup_task', 'message_draft', 'memory_candidate')
       OR v_route NOT IN ('pending_action', 'review_only') OR v_conf NOT IN ('low', 'medium', 'high')
       OR (v_route = 'pending_action' AND (v_atype IS NULL OR v_payload IS NULL OR jsonb_typeof(v_payload) <> 'object'
            OR v_atype NOT IN ('resolve_customer', 'update_customer', 'record_interaction', 'create_quote', 'book_appointment', 'send_sms')))
       OR (v_route = 'review_only' AND (v_reason IS NULL OR v_atype IS NOT NULL OR v_payload IS NOT NULL)) THEN
      RAISE EXCEPTION 'Invalid proposal shape' USING ERRCODE = '22023';
    END IF;
    IF v_payload IS NOT NULL AND public.call_copilot_has_card_number(v_payload::text) THEN
      RAISE EXCEPTION 'Payment-card data cannot be proposed' USING ERRCODE = '22023';
    END IF;
    -- The database reads the CRM row itself; a forged or cross-shop id fails here.
    v_binding := NULL;
    IF p -> 'bind' IS NOT NULL AND jsonb_typeof(p -> 'bind') <> 'array' THEN RAISE EXCEPTION 'Invalid binding' USING ERRCODE = '22023'; END IF;
    v_bind := ARRAY(SELECT jsonb_array_elements_text(coalesce(p -> 'bind', '[]'::jsonb)));
    IF EXISTS (SELECT 1 FROM unnest(v_bind) b WHERE b NOT IN ('name', 'phone', 'email')) THEN RAISE EXCEPTION 'Invalid binding' USING ERRCODE = '22023'; END IF;
    IF v_cust IS NOT NULL THEN
      v_binding := public.call_copilot_customer_binding(p_shop, v_cust, v_bind);
      IF v_binding IS NULL THEN RAISE EXCEPTION 'Customer unavailable' USING ERRCODE = '42501'; END IF;
    END IF;
    IF v_vehicle IS NOT NULL AND (v_cust IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.vehicles WHERE shop_id = p_shop AND customer_id = v_cust AND id = v_vehicle)) THEN
      RAISE EXCEPTION 'Vehicle unavailable' USING ERRCODE = '42501';
    END IF;

    v_key := encode(sha256(convert_to(
      'v1|' || (p ->> 'kind') || '|' || v_route || '|' || coalesce(v_atype, '-') || '|' || coalesce(v_payload::text, '-')
      || '|' || v_fields::text || '|' || coalesce(v_reason, '-'), 'UTF8')), 'hex');
    SELECT id INTO v_existing FROM public.call_copilot_proposals
     WHERE shop_id = p_shop AND evidence_revision_id = p_revision AND proposal_key = v_key;
    IF FOUND THEN v_skipped := v_skipped + 1; CONTINUE; END IF;

    v_cmd := NULL;
    IF v_route = 'pending_action' THEN
      -- Stable command id: the same content on the same evidence always maps to the same action.
      v_cmd := encode(substring(sha256(convert_to(p_shop::text || '|' || p_call::text || '|' || p_revision::text || '|' || v_key, 'UTF8')) from 1 for 16), 'hex')::uuid;
      BEGIN
        INSERT INTO public.pending_actions (id, shop_id, requested_by, action_type, payload)
        VALUES (v_cmd, p_shop, p_actor, v_atype::public.pending_action_type, v_payload);
      EXCEPTION WHEN insufficient_privilege THEN
        -- The active Control Center policy does not permit executable staging for this action:
        -- keep it as a private, review-only suggestion. Nothing is queued.
        v_route := 'review_only'; v_atype := NULL; v_payload := NULL; v_cmd := NULL; v_reason := 'policy_does_not_permit_staging';
      END;
    END IF;

    INSERT INTO public.call_copilot_proposals (
      shop_id, call_id, run_id, evidence_revision_id, kind, proposal_key, route, action_type, pending_action_id,
      staged_payload, review_reason, confidence, fields, ambiguity, crm_binding, customer_id,
      definition_agent_id, definition_revision, created_by)
    VALUES (p_shop, p_call, run_row.id, p_revision, p ->> 'kind', v_key, v_route, v_atype, v_cmd,
      v_payload, v_reason, v_conf, v_fields, p -> 'ambiguity', v_binding, v_cust, v_def_agent, v_def_rev, p_actor)
    RETURNING id INTO v_prop_id;
    v_ids := v_ids || to_jsonb(v_prop_id);
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('outcome', 'recorded', 'run_id', run_row.id, 'status', v_status,
    'proposal_ids', v_ids, 'created', v_count, 'deduplicated', v_skipped);
END $$;

-- An unknown-outcome extraction (the seam may or may not have processed the transcript) is terminal for its
-- extractor identity on this evidence: the orchestrator asks BEFORE calling the extractor and never calls it again.
CREATE FUNCTION public.call_copilot_find_unknown_run(
  p_shop uuid, p_actor uuid, p_call uuid, p_revision uuid, p_extractor_id text, p_extractor_version text, p_schema_version integer
) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT r.id FROM public.call_copilot_extraction_runs r
   WHERE public.call_copilot_actor_ok(p_shop, p_actor)
     AND r.shop_id = p_shop AND r.call_id = p_call AND r.evidence_revision_id = p_revision
     AND r.extractor_id = p_extractor_id AND r.extractor_version = p_extractor_version
     AND r.schema_version = p_schema_version AND r.status = 'unknown_outcome'
   ORDER BY r.created_at LIMIT 1
$$;

-- ---------------------------------------------------------------------------
-- The pre-effect recheck, called by control_claim for EVERY claim. It returns NULL for any pending
-- action that is not a Call Copilot proposal, so unrelated actions take the unchanged path. For a
-- proposal it can only DENY. It re-verifies, at the moment of approval: the staged payload is
-- unedited, the requester is still an authorized member, the call's consent/capture evidence still
-- permits CRM mutation, the sealed evidence is unchanged, the agent definition (if bound) is still
-- active, and the CRM customer the proposal was built against still has the same identity.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.call_copilot_claim_recheck(p_shop uuid, p_action uuid, p_payload jsonb, p_context text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE prop public.call_copilot_proposals; cur jsonb; now_binding jsonb;
BEGIN
  SELECT * INTO prop FROM public.call_copilot_proposals WHERE shop_id = p_shop AND pending_action_id = p_action;
  IF NOT FOUND THEN RETURN NULL; END IF;
  -- Call Copilot proposals are approval-first until an explicit per-operation opt-in exists, and transcript text can never
  -- raise that authority: only a human decision (hitl) may claim one. No autonomy setting changes this.
  IF p_context IS DISTINCT FROM 'hitl' THEN RETURN 'call_human_approval_required'; END IF;
  -- Serialise against event / segment writers for this call: for record commands the effect is applied inside
  -- this same claim transaction, so consent cannot change between this check and the write. Lock order is
  -- shop -> call everywhere (the claim already holds the shop lock).
  PERFORM 1 FROM public.call_copilot_calls WHERE id = prop.call_id AND shop_id = p_shop FOR SHARE;

  -- An edit of any operative field invalidates the proof. System annotations written by the executor
  -- (availability summary, conflict override, post-effect reconciliation notes) are not operative.
  IF (p_payload - ARRAY['availability', 'conflict_override', 'calendar_sync', 'reconciliation', 'reconciliation_quote'])
       IS DISTINCT FROM prop.staged_payload THEN
    RETURN 'call_proposal_edited';
  END IF;
  IF NOT public.call_copilot_actor_ok(p_shop, prop.created_by) THEN RETURN 'call_requester_revoked'; END IF;
  BEGIN
    PERFORM public.call_copilot_assert_capture(p_shop, prop.call_id, 'crm_mutation', NULL);
  EXCEPTION WHEN OTHERS THEN
    RETURN 'call_consent_unavailable';
  END;
  cur := public.call_copilot_evidence_is_current(p_shop, prop.evidence_revision_id);
  IF NOT coalesce((cur ->> 'current')::boolean, false) THEN RETURN 'call_evidence_changed'; END IF;
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
-- Hand-off of a customer-specific memory proposal to the EXISTING reviewed-memory candidate lifecycle.
-- Owner SESSION only (the existing create function re-checks auth.uid()). The text is the proposal's
-- stored, cited value; the caller supplies nothing but the proposal id. The candidate stays inert:
-- it still needs the existing owner review and publication before anything can retrieve it.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.call_copilot_submit_memory_candidate(p_shop uuid, p_proposal uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  prop public.call_copilot_proposals; sub public.call_copilot_memory_submissions; cur jsonb; text_value text;
  res jsonb; rev_no integer; content text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.team_is_owner(p_shop) THEN
    RAISE EXCEPTION 'Owner review is required' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('call_copilot_memory:' || p_proposal::text, 0));
  SELECT * INTO prop FROM public.call_copilot_proposals WHERE shop_id = p_shop AND id = p_proposal;
  IF NOT FOUND OR prop.kind <> 'memory_candidate' OR prop.customer_id IS NULL OR prop.review_reason IS DISTINCT FROM 'memory_requires_review' THEN
    RAISE EXCEPTION 'Not a submittable memory proposal' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO sub FROM public.call_copilot_memory_submissions WHERE proposal_id = p_proposal;
  IF FOUND THEN
    RETURN jsonb_build_object('outcome', 'already_submitted', 'source_id', sub.source_id, 'revision', sub.revision);
  END IF;
  IF NOT public.call_copilot_actor_ok(p_shop, prop.created_by) THEN
    RAISE EXCEPTION 'Requester is no longer authorized' USING ERRCODE = '42501', DETAIL = 'call_requester_revoked';
  END IF;
  PERFORM public.call_copilot_assert_capture(p_shop, prop.call_id, 'extraction', NULL);
  cur := public.call_copilot_evidence_is_current(p_shop, prop.evidence_revision_id);
  IF NOT coalesce((cur ->> 'current')::boolean, false) THEN
    RAISE EXCEPTION 'Evidence revision is not current' USING ERRCODE = 'PT409', DETAIL = 'call_evidence_changed';
  END IF;
  IF public.call_copilot_customer_binding(p_shop, prop.customer_id,
       ARRAY(SELECT k FROM jsonb_object_keys(prop.crm_binding) k WHERE k <> 'customer_id')) IS DISTINCT FROM prop.crm_binding THEN
    RAISE EXCEPTION 'Customer changed since the proposal' USING ERRCODE = 'PT409', DETAIL = 'call_crm_state_changed';
  END IF;
  SELECT f ->> 'value' INTO text_value FROM jsonb_array_elements(prop.fields) f WHERE f ->> 'name' = 'preference' LIMIT 1;
  text_value := coalesce(text_value, '');
  IF length(btrim(text_value)) NOT BETWEEN 1 AND 600 THEN
    RAISE EXCEPTION 'Memory proposal has no preference text' USING ERRCODE = '22023';
  END IF;
  SELECT revision INTO rev_no FROM public.call_copilot_evidence_revisions WHERE shop_id = p_shop AND id = prop.evidence_revision_id;
  content := 'Customer-specific preference (customer ' || prop.customer_id::text || ', call evidence revision ' || rev_no::text
             || '): ' || text_value;
  res := public.create_reviewed_memory_candidate(
    p_shop, 'call-copilot:customer:' || prop.customer_id::text, content, jsonb_build_array(jsonb_build_object('content', content)));
  INSERT INTO public.call_copilot_memory_submissions (proposal_id, shop_id, source_id, revision, submitted_by)
  VALUES (p_proposal, p_shop, (res ->> 'source_id')::uuid, (res ->> 'revision')::integer, auth.uid());
  RETURN jsonb_build_object('outcome', 'submitted', 'source_id', res ->> 'source_id', 'revision', (res ->> 'revision')::integer,
    'state', res ->> 'state', 'safety_status', res ->> 'safety_status');
END $$;

-- ---------------------------------------------------------------------------
-- control_claim: IDENTICAL to 20261008160000 except for the three marked Call Copilot lines
-- (declaration, the recheck call, and one leading WHEN in the reason chain). CREATE OR REPLACE keeps
-- the existing ownership and ACL (no API role can call it directly).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.control_claim(p_shop uuid,p_action uuid,p_actor uuid,p_context text,p_expected text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE shop public.shops; action public.pending_actions; revision integer; definition jsonb; location uuid;
 record_id uuid; effective text:='approval'; reason text; allowed boolean:=false; actor_role text; ceiling text;
 modes text[]:=ARRAY['off','read','suggest','approval','autonomous']; call_reason text;
BEGIN
 IF p_context NOT IN ('hitl','automatic') OR p_context IS NULL THEN RETURN jsonb_build_object('denied','invalid_context'); END IF;
 SELECT * INTO shop FROM public.shops WHERE id=p_shop FOR UPDATE;
 IF shop.id IS NULL OR p_actor IS NULL THEN RETURN jsonb_build_object('denied','actor_not_authorized'); END IF;
 IF p_actor=shop.owner_id
  AND EXISTS(SELECT 1 FROM public.shop_memberships WHERE shop_id=p_shop AND user_id=p_actor AND active AND role='owner')
  AND (auth.role() IS NOT DISTINCT FROM 'service_role' OR (auth.uid() IS NOT DISTINCT FROM p_actor AND p_context='hitl')) THEN
  actor_role:='owner';
 -- A manager is authorized only by their own live session and both explicit grants.
 -- A service caller can never act as a manager, and a manager is never automatic.
 ELSIF p_expected IS NOT NULL AND auth.role() IS DISTINCT FROM 'service_role' AND auth.uid() IS NOT DISTINCT FROM p_actor AND p_context='hitl'
  AND EXISTS(SELECT 1 FROM public.shop_memberships WHERE shop_id=p_shop AND user_id=p_actor AND active AND role='manager'
   AND capabilities @> ARRAY['crm.read','approvals.messages']::text[]) THEN
  actor_role:='manager';
 ELSE
  RETURN jsonb_build_object('denied','actor_not_authorized');
 END IF;
 SELECT id INTO location FROM public.shop_locations WHERE shop_id=p_shop;
 IF location IS NULL THEN RETURN jsonb_build_object('denied','location_unavailable'); END IF;
 SELECT * INTO action FROM public.pending_actions WHERE id=p_action AND shop_id=p_shop FOR UPDATE;
 IF action.id IS NULL THEN RETURN jsonb_build_object('already_decided',true); END IF;
 IF action.status::text NOT IN ('pending','edit_requested') THEN RETURN jsonb_build_object('already_decided',true); END IF;
 -- A delegated approval is bound to the exact message reviewed. An owner edit in
 -- progress, or any change since the review, requires a fresh review. Actions a
 -- manager can never approve skip this and reach the audited refusal below.
 IF NOT (actor_role='manager' AND action.action_type::text NOT IN ('send_sms','send_email'))
  AND ((actor_role='manager' AND action.status::text<>'pending')
   OR (p_expected IS NOT NULL AND p_expected IS DISTINCT FROM public.control_review_hash(action.payload))) THEN
  RETURN jsonb_build_object('denied','review_changed');
 END IF;
 -- Token permission is required again at approval, including old queued MCP work.
 IF action.payload->>'source'='mcp' AND NOT EXISTS(SELECT 1 FROM public.mcp_tokens
  WHERE id=(action.payload->>'mcp_token_id')::uuid AND shop_id=p_shop AND revoked_at IS NULL
  AND public.mcp_proposal_capability(action.action_type::text)=ANY(capabilities) FOR SHARE) THEN
  RETURN jsonb_build_object('denied','mcp_capability_unavailable');
 END IF;
 -- Call Copilot proposals only: re-verify consent, evidence revision, payload, requester, agent definition
 -- and CRM identity at the moment of approval. NULL for every other action (unchanged path).
 call_reason:=public.call_copilot_claim_recheck(p_shop,p_action,action.payload,p_context);
 SELECT a.revision,h.definition INTO revision,definition FROM public.control_policy_active a
 JOIN public.control_policy_history h ON h.shop_id=a.shop_id AND h.revision=a.revision WHERE a.shop_id=p_shop;
 IF revision IS NOT NULL THEN effective:=public.control_pending_mode(definition,action.action_type::text); END IF;
 -- The activated policy's manager ceiling can only tighten a delegated approval.
 IF actor_role='manager' AND revision IS NOT NULL THEN
  ceiling:=definition->'roleCeilings'->>'manager';
  IF ceiling IS NOT NULL THEN effective:=coalesce(modes[least(array_position(modes,effective),array_position(modes,ceiling))],'off'); END IF;
 END IF;
 -- Unknown actions fail closed even before activation.
 IF action.action_type::text NOT IN ('create_lead','add_note','send_sms','send_email','book_appointment','reschedule_appointment','cancel_appointment','create_quote','update_customer','resolve_customer','record_interaction') THEN effective:='off'; END IF;
 reason:=CASE
  WHEN call_reason IS NOT NULL THEN call_reason
  WHEN actor_role='manager' AND action.action_type::text NOT IN ('send_sms','send_email') THEN 'owner_approval_required'
  WHEN effective IN ('off','read','suggest') THEN 'execution_not_permitted'
  WHEN p_context='automatic' AND revision IS NULL THEN 'explicit_activation_required'
  WHEN p_context='automatic' AND effective<>'autonomous' THEN 'human_approval_required'
  WHEN p_context='automatic' AND (shop.plan::text IS DISTINCT FROM 'active' OR shop.voice_addon IS DISTINCT FROM true) THEN 'autonomy_entitlement_required'
  ELSE 'current_policy_authorized' END;
 allowed:=reason='current_policy_authorized';
 INSERT INTO public.control_execution_decisions(shop_id,action_id,actor_id,actor_role,location_id,action_type,policy_revision,staged_revision,payload_hash,context,mode,allowed,reason)
 VALUES(p_shop,p_action,p_actor,actor_role,location,action.action_type::text,revision,action.control_staged_revision,encode(sha256(convert_to(jsonb_build_object('shop',p_shop,'location',location,'action',p_action,'type',action.action_type,'payload',action.payload)::text,'UTF8')),'hex'),p_context,effective,allowed,reason);
 IF NOT allowed THEN RETURN jsonb_build_object('denied',reason); END IF;
 IF action.action_type::text IN ('update_customer','resolve_customer','record_interaction') THEN
  record_id:=public.control_apply_record(p_shop,p_action,p_actor,action.action_type::text,action.payload);
 END IF;
 UPDATE public.pending_actions SET result_id=coalesce(record_id,result_id),status='approved',decided_at=now(),decided_by_user=p_actor WHERE id=p_action AND shop_id=p_shop;
 RETURN jsonb_build_object('id',action.id,'shop_id',action.shop_id,'action_type',action.action_type,'payload',action.payload,'result_id',record_id);
END $$;


-- ---------------------------------------------------------------------------
-- Function ACLs. Only the service role runs the writers/readers; only an authenticated owner session
-- can submit a memory candidate. Internal helpers are not directly callable by any API role.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  public.call_copilot_actor_ok(uuid, uuid), public.call_copilot_luhn(text), public.call_copilot_has_card_number(text),
  public.call_copilot_segment_digest(integer, text, text, timestamptz, timestamptz, text),
  public.call_copilot_assert_span(uuid, uuid, timestamptz, timestamptz, text),
  public.call_copilot_record_segment(uuid, uuid, integer, text, text, timestamptz, timestamptz, text, text[]),
  public.call_copilot_evidence_snapshot(uuid, uuid, boolean, integer),
  public.call_copilot_seal_evidence(uuid, uuid, uuid, boolean, integer),
  public.call_copilot_evidence_is_current(uuid, uuid),
  public.call_copilot_read_transcript(uuid, uuid, uuid, uuid),
  public.call_copilot_resolve_fields(uuid, uuid, jsonb),
  public.call_copilot_customer_binding(uuid, uuid, text[]),
  public.call_copilot_record_extraction(uuid, uuid, uuid, uuid, jsonb, jsonb),
  public.call_copilot_find_unknown_run(uuid, uuid, uuid, uuid, text, text, integer),
  public.call_copilot_claim_recheck(uuid, uuid, jsonb, text),
  public.call_copilot_submit_memory_candidate(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.call_copilot_record_segment(uuid, uuid, integer, text, text, timestamptz, timestamptz, text, text[]),
  public.call_copilot_seal_evidence(uuid, uuid, uuid, boolean, integer),
  public.call_copilot_read_transcript(uuid, uuid, uuid, uuid),
  public.call_copilot_record_extraction(uuid, uuid, uuid, uuid, jsonb, jsonb),
  public.call_copilot_find_unknown_run(uuid, uuid, uuid, uuid, text, text, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.call_copilot_submit_memory_candidate(uuid, uuid) TO authenticated;

COMMIT;
