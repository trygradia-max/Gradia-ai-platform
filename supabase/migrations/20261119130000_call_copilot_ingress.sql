BEGIN;

-- Call Copilot PR D (NEXT_BUILD_ORDER_2026-11-04): durable, tenant-isolated, append-only ingress
-- and all-party disclosure / consent / pause / stop evidence for human-first INBOUND calls that
-- traverse a Gradia-controlled path.
--
-- Adds objects only. No existing table, column, trigger, policy, grant or function is changed, and
-- no row is rewritten or backfilled. In particular `call_records` (the receptionist call artifact)
-- is untouched: a Call Copilot call is a separate evidence ledger that a later PR links to it.
--
--  * call_copilot_calls      — one immutable identity row per provider call (globally unique
--                              provider call id, so no shop can adopt another shop's call).
--  * call_copilot_events     — append-only, CONTENT-FREE evidence: opened, disclosure delivered,
--                              consent granted/declined, pause, resume, stop, end, unknown outcome,
--                              extra participant. Keyed by a provider event id AND a per-call
--                              sequence; replays are decided by a digest computed in the database.
--  * call_copilot_conflicts  — append-only record that a provider replayed an event id (or reused a
--                              sequence) with DIFFERENT content. Any conflict fails the call closed.
--  * call_copilot_record_event  — the only writer (service role only); atomic and serialised per call.
--  * call_copilot_capture_state — a pure fold over the CONTIGUOUS sequence prefix. Order of arrival
--                              cannot change the result; a missing sequence fails closed.
--  * call_copilot_assert_capture — the deny-by-default gate every future recording, transcription,
--                              model use, summarization, extraction and CRM-mutation path must pass.
--
-- Nothing here stores audio, transcript, speech text, a phone number or a name; the closed column
-- vocabulary cannot carry call content. No disclosure wording is stored or approved: the disclosure
-- version is an opaque reference. Nothing here calls a provider.

DO $$
BEGIN
  IF to_regclass('public.call_records') IS NULL OR to_regclass('public.shops') IS NULL THEN
    RAISE EXCEPTION 'call_records and shops are required' USING ERRCODE = '23514';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Append-only guard (a shop delete may still cascade its own evidence away)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.call_copilot_append_only() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'Call Copilot evidence cannot be truncated' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Call Copilot evidence is immutable; record a new event' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.shops WHERE id = OLD.shop_id) THEN
    RAISE EXCEPTION 'Call Copilot evidence cannot be deleted' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END $$;

-- ---------------------------------------------------------------------------
-- Calls
-- ---------------------------------------------------------------------------
CREATE TABLE public.call_copilot_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('twilio')),
  provider_call_id text NOT NULL CHECK (provider_call_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  direction text NOT NULL DEFAULT 'inbound' CHECK (direction = 'inbound'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (provider, provider_call_id),
  UNIQUE (shop_id, id)
);

-- ---------------------------------------------------------------------------
-- Events (append-only, content-free)
-- ---------------------------------------------------------------------------
CREATE TABLE public.call_copilot_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  arrival_seq bigint GENERATED ALWAYS AS IDENTITY,
  shop_id uuid NOT NULL,
  call_id uuid NOT NULL,
  -- Logical order assigned by the Gradia-controlled path, independent of arrival order.
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 5000),
  provider_event_id text NOT NULL CHECK (provider_event_id ~ '^[A-Za-z0-9:_.-]{1,128}$'),
  kind text NOT NULL CHECK (kind IN (
    'call_opened', 'disclosure_delivered', 'consent_granted', 'consent_declined',
    'capture_paused', 'capture_resumed', 'capture_stopped', 'call_ended',
    'provider_outcome_unknown', 'participant_added')),
  party text CHECK (party IN ('operator', 'caller')),
  -- Opaque reference to the disclosure the party heard. No wording is stored or approved here.
  disclosure_version text CHECK (disclosure_version ~ '^[A-Za-z0-9._-]{1,64}$'),
  responds_to_sequence integer CHECK (responds_to_sequence >= 1),
  route_kind text CHECK (route_kind IN ('gradia_controlled_number', 'approved_forwarding_bridge')),
  operator_region text CHECK (operator_region ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$'),
  caller_region text CHECK (caller_region ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$'),
  reason text CHECK (reason ~ '^[a-z][a-z0-9_]{2,63}$'),
  occurred_at timestamptz NOT NULL CHECK (occurred_at >= timestamptz '2020-01-01 00:00:00+00'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (shop_id, call_id, sequence),
  UNIQUE (shop_id, call_id, provider_event_id),
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, call_id) REFERENCES public.call_copilot_calls(shop_id, id) ON DELETE CASCADE,
  CONSTRAINT call_copilot_events_shape CHECK (coalesce(
    ((kind = 'call_opened') = (sequence = 1))
    AND ((route_kind IS NOT NULL) = (kind = 'call_opened'))
    AND ((operator_region IS NULL AND caller_region IS NULL) OR kind = 'call_opened')
    AND CASE kind
      WHEN 'call_opened' THEN
        party IS NULL AND disclosure_version IS NULL AND responds_to_sequence IS NULL AND reason IS NULL
      WHEN 'disclosure_delivered' THEN
        party IS NOT NULL AND disclosure_version IS NOT NULL AND responds_to_sequence IS NULL AND reason IS NULL
      WHEN 'consent_granted' THEN
        party IS NOT NULL AND disclosure_version IS NOT NULL
        AND responds_to_sequence IS NOT NULL AND responds_to_sequence < sequence AND reason IS NULL
      WHEN 'consent_declined' THEN
        party IS NOT NULL AND disclosure_version IS NOT NULL
        AND (responds_to_sequence IS NULL OR responds_to_sequence < sequence) AND reason IS NULL
      WHEN 'capture_paused' THEN
        party IS NULL AND disclosure_version IS NULL AND responds_to_sequence IS NULL
      WHEN 'capture_resumed' THEN
        party IS NULL AND disclosure_version IS NULL AND responds_to_sequence IS NULL
      WHEN 'capture_stopped' THEN
        party IS NULL AND disclosure_version IS NULL AND responds_to_sequence IS NULL
      WHEN 'call_ended' THEN
        party IS NULL AND disclosure_version IS NULL AND responds_to_sequence IS NULL AND reason IS NULL
      WHEN 'provider_outcome_unknown' THEN
        party IS NULL AND disclosure_version IS NULL AND responds_to_sequence IS NULL AND reason IS NOT NULL
      WHEN 'participant_added' THEN
        party IS NULL AND disclosure_version IS NULL AND responds_to_sequence IS NULL
      ELSE false END, false))
);
CREATE INDEX call_copilot_events_call_idx ON public.call_copilot_events (shop_id, call_id, sequence);

-- ---------------------------------------------------------------------------
-- Conflicts: a provider changed what it said about an event id, or reused a sequence.
-- ---------------------------------------------------------------------------
CREATE TABLE public.call_copilot_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  call_id uuid NOT NULL,
  conflict_kind text NOT NULL CHECK (conflict_kind IN ('event_id_changed', 'sequence_reused')),
  provider_event_id text NOT NULL CHECK (provider_event_id ~ '^[A-Za-z0-9:_.-]{1,128}$'),
  attempted_sequence integer NOT NULL CHECK (attempted_sequence BETWEEN 1 AND 5000),
  attempted_digest text NOT NULL CHECK (attempted_digest ~ '^[0-9a-f]{64}$'),
  existing_event_id uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (shop_id, call_id, conflict_kind, provider_event_id, attempted_digest),
  FOREIGN KEY (shop_id, call_id) REFERENCES public.call_copilot_calls(shop_id, id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, existing_event_id) REFERENCES public.call_copilot_events(shop_id, id) ON DELETE CASCADE
);
CREATE INDEX call_copilot_conflicts_call_idx ON public.call_copilot_conflicts (shop_id, call_id);

CREATE TRIGGER call_copilot_calls_append_only
  BEFORE UPDATE OR DELETE ON public.call_copilot_calls
  FOR EACH ROW EXECUTE FUNCTION public.call_copilot_append_only();
CREATE TRIGGER call_copilot_events_append_only
  BEFORE UPDATE OR DELETE ON public.call_copilot_events
  FOR EACH ROW EXECUTE FUNCTION public.call_copilot_append_only();
CREATE TRIGGER call_copilot_conflicts_append_only
  BEFORE UPDATE OR DELETE ON public.call_copilot_conflicts
  FOR EACH ROW EXECUTE FUNCTION public.call_copilot_append_only();
CREATE TRIGGER call_copilot_calls_no_truncate
  BEFORE TRUNCATE ON public.call_copilot_calls
  FOR EACH STATEMENT EXECUTE FUNCTION public.call_copilot_append_only();
CREATE TRIGGER call_copilot_events_no_truncate
  BEFORE TRUNCATE ON public.call_copilot_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.call_copilot_append_only();
CREATE TRIGGER call_copilot_conflicts_no_truncate
  BEFORE TRUNCATE ON public.call_copilot_conflicts
  FOR EACH STATEMENT EXECUTE FUNCTION public.call_copilot_append_only();

-- Tenant isolation: RLS on, no browser-role access at all (there is no user-facing surface in this
-- PR), service role may read. Every write goes through call_copilot_record_event.
ALTER TABLE public.call_copilot_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.call_copilot_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.call_copilot_conflicts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.call_copilot_calls, public.call_copilot_events, public.call_copilot_conflicts
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.call_copilot_calls, public.call_copilot_events, public.call_copilot_conflicts
  TO service_role;

-- ---------------------------------------------------------------------------
-- Small pure helpers
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.call_copilot_ts(p_at timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;

-- The replay digest is computed HERE, from the typed columns, never trusted from a caller. Every
-- field is vocabulary-constrained (no '|'), so the encoding is unambiguous.
CREATE FUNCTION public.call_copilot_event_digest(
  p_provider_event_id text, p_sequence integer, p_kind text, p_party text, p_disclosure_version text,
  p_responds_to_sequence integer, p_route_kind text, p_operator_region text, p_caller_region text,
  p_reason text, p_occurred_at timestamptz
) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT encode(sha256(convert_to(
    'v1|' || coalesce(p_provider_event_id, '-') || '|' || p_sequence::text || '|' || coalesce(p_kind, '-')
    || '|' || coalesce(p_party, '-') || '|' || coalesce(p_disclosure_version, '-')
    || '|' || coalesce(p_responds_to_sequence::text, '-') || '|' || coalesce(p_route_kind, '-')
    || '|' || coalesce(p_operator_region, '-') || '|' || coalesce(p_caller_region, '-')
    || '|' || coalesce(p_reason, '-') || '|' || public.call_copilot_ts(p_occurred_at), 'UTF8')), 'hex')
$$;

CREATE FUNCTION public.call_copilot_close_interval(
  p_intervals jsonb, p_sequence integer, p_at timestamptz, p_reason text
) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT jsonb_set(
    p_intervals,
    ARRAY[(jsonb_array_length(p_intervals) - 1)::text],
    (p_intervals -> -1) || jsonb_build_object(
      'ended_sequence', p_sequence, 'ended_at', public.call_copilot_ts(p_at), 'end_reason', p_reason))
$$;

-- ---------------------------------------------------------------------------
-- The consent state machine: a pure, order-independent fold.
--
--   * Only the CONTIGUOUS sequence prefix 1..k is folded. A missing sequence is "unresolved": the
--     call fails closed (uncertain) until it arrives, so a later "granted" can never be honoured
--     while an earlier decline or pause may still be in flight, whatever the arrival order.
--   * Capture needs BOTH parties (operator and caller) to have been disclosed to and to have
--     granted for exactly that disclosure (same party, same version, earlier sequence, after any
--     pause). The customer staying on the line is never consent.
--   * A decline is honoured even without a valid disclosure reference and is final for the call.
--   * A pause closes the interval and explicitly records the gap; it voids all consent. Resuming
--     needs fresh disclosure + both consents first; the uncaptured span is never backfilled.
--   * Stop, end, an unknown provider outcome, an extra participant, a clock regression or any
--     replay conflict end or deny capture. Nothing ever re-enables a closed call.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.call_copilot_capture_state(p_shop_id uuid, p_call_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  e record;
  expected integer := 1;
  contiguous integer := 0;
  highest integer;
  n_conflicts integer;
  unresolved boolean;
  v_status text;
  v_reason text;
  closed boolean := false;
  ended boolean := false;
  ended_at_ts timestamptz;
  outcome_unknown boolean := false;
  integrity text := NULL;
  paused boolean := false;
  last_pause integer := 0;
  disc jsonb := '{}'::jsonb;
  consent_operator boolean := false;
  consent_caller boolean := false;
  active boolean := false;
  intervals jsonb := '[]'::jsonb;
  gaps jsonb := '[]'::jsonb;
  ignored jsonb := '[]'::jsonb;
  gap_open boolean := false;
  gap_from timestamptz;
  gap_from_seq integer;
  gap_why text;
  prev_at timestamptz;
  d jsonb;
  blocked boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.call_copilot_calls WHERE id = p_call_id AND shop_id = p_shop_id) THEN
    RETURN jsonb_build_object(
      'status', 'unknown_call', 'reason', 'call_not_found',
      'capture_permitted_now', false, 'derivation_permitted', false,
      'call_ended', false, 'outcome_unknown', false,
      'contiguous_through', 0, 'highest_sequence', 0, 'unresolved_gap', false, 'conflict_count', 0,
      'intervals', '[]'::jsonb, 'gaps', '[]'::jsonb, 'ignored', '[]'::jsonb);
  END IF;

  SELECT coalesce(max(sequence), 0) INTO highest
    FROM public.call_copilot_events WHERE shop_id = p_shop_id AND call_id = p_call_id;
  SELECT count(*) INTO n_conflicts
    FROM public.call_copilot_conflicts WHERE shop_id = p_shop_id AND call_id = p_call_id;

  FOR e IN
    SELECT sequence, kind, party, disclosure_version, responds_to_sequence, reason, occurred_at
      FROM public.call_copilot_events
     WHERE shop_id = p_shop_id AND call_id = p_call_id
     ORDER BY sequence
  LOOP
    IF e.sequence <> expected THEN
      EXIT;
    END IF;
    contiguous := e.sequence;
    expected := expected + 1;

    IF e.kind = 'call_ended' AND NOT ended THEN
      ended := true;
      ended_at_ts := e.occurred_at;
    END IF;
    IF closed THEN
      CONTINUE;
    END IF;

    IF prev_at IS NOT NULL AND e.occurred_at < prev_at THEN
      IF active THEN
        intervals := public.call_copilot_close_interval(intervals, e.sequence, prev_at, 'time_regression');
        active := false;
        gap_open := true; gap_from := prev_at; gap_from_seq := e.sequence; gap_why := 'time_regression';
      END IF;
      closed := true; integrity := 'time_regression'; v_status := 'uncertain'; v_reason := 'time_regression';
      CONTINUE;
    END IF;
    prev_at := e.occurred_at;

    IF e.kind = 'call_opened' THEN
      gap_open := true; gap_from := e.occurred_at; gap_from_seq := e.sequence; gap_why := 'before_consent';

    ELSIF e.kind = 'disclosure_delivered' THEN
      disc := disc || jsonb_build_object(
        e.sequence::text, jsonb_build_object('party', e.party, 'version', e.disclosure_version));

    ELSIF e.kind = 'consent_granted' THEN
      d := disc -> e.responds_to_sequence::text;
      IF d IS NOT NULL AND d ->> 'party' = e.party AND d ->> 'version' = e.disclosure_version
         AND e.responds_to_sequence > last_pause THEN
        IF e.party = 'operator' THEN consent_operator := true; ELSE consent_caller := true; END IF;
        IF NOT paused AND NOT active AND consent_operator AND consent_caller THEN
          IF gap_open THEN
            gaps := gaps || jsonb_build_array(jsonb_build_object(
              'started_sequence', gap_from_seq, 'started_at', public.call_copilot_ts(gap_from),
              'ended_sequence', e.sequence, 'ended_at', public.call_copilot_ts(e.occurred_at), 'reason', gap_why));
            gap_open := false;
          END IF;
          intervals := intervals || jsonb_build_array(jsonb_build_object(
            'started_sequence', e.sequence, 'started_at', public.call_copilot_ts(e.occurred_at),
            'ended_sequence', NULL, 'ended_at', NULL, 'end_reason', NULL));
          active := true;
        END IF;
      ELSE
        ignored := ignored || jsonb_build_array(jsonb_build_object(
          'sequence', e.sequence, 'reason', 'consent_without_valid_disclosure'));
      END IF;

    ELSIF e.kind = 'consent_declined' THEN
      IF active THEN
        intervals := public.call_copilot_close_interval(intervals, e.sequence, e.occurred_at, 'consent_declined');
        active := false;
        gap_open := true; gap_from := e.occurred_at; gap_from_seq := e.sequence; gap_why := 'consent_declined';
      END IF;
      closed := true; integrity := 'consent_declined'; v_status := 'declined'; v_reason := 'consent_declined';

    ELSIF e.kind = 'capture_paused' THEN
      IF active THEN
        intervals := public.call_copilot_close_interval(intervals, e.sequence, e.occurred_at, 'paused');
        active := false;
        gap_open := true; gap_from := e.occurred_at; gap_from_seq := e.sequence; gap_why := 'paused';
      END IF;
      paused := true; last_pause := e.sequence;
      consent_operator := false; consent_caller := false;

    ELSIF e.kind = 'capture_resumed' THEN
      IF paused AND consent_operator AND consent_caller THEN
        IF gap_open THEN
          gaps := gaps || jsonb_build_array(jsonb_build_object(
            'started_sequence', gap_from_seq, 'started_at', public.call_copilot_ts(gap_from),
            'ended_sequence', e.sequence, 'ended_at', public.call_copilot_ts(e.occurred_at), 'reason', gap_why));
          gap_open := false;
        END IF;
        intervals := intervals || jsonb_build_array(jsonb_build_object(
          'started_sequence', e.sequence, 'started_at', public.call_copilot_ts(e.occurred_at),
          'ended_sequence', NULL, 'ended_at', NULL, 'end_reason', NULL));
        active := true; paused := false;
      ELSE
        ignored := ignored || jsonb_build_array(jsonb_build_object(
          'sequence', e.sequence,
          'reason', CASE WHEN paused THEN 'resume_without_fresh_consent' ELSE 'resume_without_pause' END));
      END IF;

    ELSIF e.kind = 'capture_stopped' THEN
      IF active THEN
        intervals := public.call_copilot_close_interval(intervals, e.sequence, e.occurred_at, 'stopped');
        active := false;
        gap_open := true; gap_from := e.occurred_at; gap_from_seq := e.sequence; gap_why := 'stopped';
      END IF;
      closed := true; v_status := 'stopped'; v_reason := coalesce(e.reason, 'capture_stopped');

    ELSIF e.kind = 'call_ended' THEN
      IF active THEN
        intervals := public.call_copilot_close_interval(intervals, e.sequence, e.occurred_at, 'call_ended');
        active := false;
      END IF;
      closed := true; v_status := 'ended'; v_reason := 'call_ended';

    ELSIF e.kind = 'provider_outcome_unknown' THEN
      IF active THEN
        intervals := public.call_copilot_close_interval(intervals, e.sequence, e.occurred_at, 'provider_outcome_unknown');
        active := false;
        gap_open := true; gap_from := e.occurred_at; gap_from_seq := e.sequence; gap_why := 'provider_outcome_unknown';
      END IF;
      closed := true; outcome_unknown := true; v_status := 'unknown_outcome'; v_reason := e.reason;

    ELSIF e.kind = 'participant_added' THEN
      IF active THEN
        intervals := public.call_copilot_close_interval(intervals, e.sequence, e.occurred_at, 'participant_added');
        active := false;
        gap_open := true; gap_from := e.occurred_at; gap_from_seq := e.sequence; gap_why := 'participant_added';
      END IF;
      closed := true; v_status := 'uncertain'; v_reason := 'unconsented_participant';
    END IF;
  END LOOP;

  IF gap_open THEN
    gaps := gaps || jsonb_build_array(jsonb_build_object(
      'started_sequence', gap_from_seq, 'started_at', public.call_copilot_ts(gap_from),
      'ended_sequence', NULL,
      'ended_at', CASE WHEN ended THEN public.call_copilot_ts(ended_at_ts) END,
      'reason', gap_why));
  END IF;

  unresolved := highest > contiguous;

  IF NOT closed THEN
    IF active THEN
      v_status := 'active'; v_reason := 'capture_active';
    ELSIF paused THEN
      v_status := 'paused'; v_reason := 'paused';
    ELSE
      v_status := 'awaiting_consent';
      v_reason := CASE WHEN contiguous = 0 THEN 'call_not_opened' ELSE 'consent_not_established' END;
    END IF;
  END IF;

  -- Integrity failures deny everything. A decline stays the more specific (and equally denying) status.
  IF v_status <> 'declined' THEN
    IF n_conflicts > 0 THEN
      v_status := 'uncertain'; v_reason := 'conflicting_replay';
    ELSIF unresolved THEN
      v_status := 'uncertain'; v_reason := 'sequence_gap';
    END IF;
  END IF;

  blocked := integrity IS NOT NULL OR n_conflicts > 0 OR unresolved;

  RETURN jsonb_build_object(
    'status', v_status,
    'reason', v_reason,
    'capture_permitted_now', (active AND NOT blocked),
    'derivation_permitted', (NOT blocked AND jsonb_array_length(intervals) > 0),
    'call_ended', ended,
    'outcome_unknown', outcome_unknown,
    'contiguous_through', contiguous,
    'highest_sequence', highest,
    'unresolved_gap', unresolved,
    'conflict_count', n_conflicts,
    'intervals', intervals,
    'gaps', gaps,
    'ignored', ignored);
END $$;

-- ---------------------------------------------------------------------------
-- The deny-by-default gate. Every future recording, transcription, model use, summarization,
-- extraction and CRM-mutation path must call this first (via the typed adapter). It never grants
-- more than the consent evidence supports; it is a NECESSARY condition only. Control Center policy,
-- approval and CRM authority are separate checks a later PR must AND with this one.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.call_copilot_assert_capture(
  p_shop_id uuid, p_call_id uuid, p_purpose text, p_at timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  s jsonb;
  ok boolean := false;
  why text;
  at_ts timestamptz;
  iv jsonb;
BEGIN
  IF p_purpose IS NULL OR p_purpose NOT IN (
    'recording', 'transcription', 'model_use', 'summarization', 'extraction', 'crm_mutation') THEN
    RAISE EXCEPTION 'Unknown Call Copilot capture purpose' USING ERRCODE = '22023';
  END IF;

  s := public.call_copilot_capture_state(p_shop_id, p_call_id);

  IF p_purpose IN ('recording', 'transcription') THEN
    -- Live capture: only while capture is active now, and never for a moment before the current
    -- consented interval began (no backfill of uncaptured audio).
    at_ts := coalesce(p_at, clock_timestamp());
    IF (s ->> 'capture_permitted_now')::boolean THEN
      ok := at_ts >= ((s -> 'intervals' -> -1 ->> 'started_at')::timestamptz);
      why := 'before_capture_interval';
    ELSE
      why := s ->> 'reason';
    END IF;
  ELSE
    -- Work on already-captured content: consented evidence must exist and be intact, and a stated
    -- moment must lie inside a captured interval (never inside a gap).
    IF (s ->> 'derivation_permitted')::boolean THEN
      IF p_at IS NULL THEN
        ok := true;
      ELSE
        FOR iv IN SELECT * FROM jsonb_array_elements(s -> 'intervals') LOOP
          IF (iv ->> 'started_at')::timestamptz <= p_at
             AND (iv ->> 'ended_at' IS NULL OR p_at < (iv ->> 'ended_at')::timestamptz) THEN
            ok := true;
          END IF;
        END LOOP;
        why := 'outside_captured_interval';
      END IF;
    ELSIF jsonb_array_length(s -> 'intervals') = 0
          AND s ->> 'status' IN ('awaiting_consent', 'paused', 'stopped', 'ended', 'unknown_outcome') THEN
      why := 'no_consented_capture';
    ELSE
      why := s ->> 'reason';
    END IF;
  END IF;

  IF NOT coalesce(ok, false) THEN
    RAISE EXCEPTION 'Call Copilot capture is not permitted'
      USING ERRCODE = 'CC403', DETAIL = coalesce(why, 'capture_not_permitted');
  END IF;
  RETURN s;
END $$;

-- ---------------------------------------------------------------------------
-- The only writer. Atomic, serialised per call, idempotent and replay-checked.
--   recorded     — a new event was appended
--   duplicate    — the same event id with an identical digest (a harmless provider retry)
--   conflict     — the same event id with different content, or a reused sequence; recorded as a
--                  conflict and the call fails closed
--   foreign_call — the provider call id already belongs to another shop; nothing is written
-- A structurally invalid event raises 23514 / 22023 and writes nothing, not even a call row.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.call_copilot_record_event(
  p_shop_id uuid, p_provider text, p_provider_call_id text, p_provider_event_id text,
  p_sequence integer, p_kind text, p_party text, p_disclosure_version text,
  p_responds_to_sequence integer, p_route_kind text, p_operator_region text, p_caller_region text,
  p_reason text, p_occurred_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_call_id uuid;
  v_call_shop uuid;
  v_digest text;
  v_existing record;
  v_event_id uuid;
  v_state jsonb;
BEGIN
  IF p_shop_id IS NULL OR p_occurred_at IS NULL OR p_sequence IS NULL OR p_kind IS NULL THEN
    RAISE EXCEPTION 'Call Copilot event is incomplete' USING ERRCODE = '22023';
  END IF;
  IF p_occurred_at > clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'Call Copilot event time is in the future' USING ERRCODE = '22023';
  END IF;

  SELECT id, shop_id INTO v_call_id, v_call_shop
    FROM public.call_copilot_calls WHERE provider = p_provider AND provider_call_id = p_provider_call_id;
  IF NOT FOUND THEN
    INSERT INTO public.call_copilot_calls (shop_id, provider, provider_call_id)
    VALUES (p_shop_id, p_provider, p_provider_call_id)
    ON CONFLICT (provider, provider_call_id) DO NOTHING;
    SELECT id, shop_id INTO v_call_id, v_call_shop
      FROM public.call_copilot_calls WHERE provider = p_provider AND provider_call_id = p_provider_call_id;
  END IF;
  IF v_call_shop <> p_shop_id THEN
    RETURN jsonb_build_object('outcome', 'foreign_call');
  END IF;

  -- Serialise writers for this call: replay and sequence decisions below are race-free.
  PERFORM 1 FROM public.call_copilot_calls WHERE id = v_call_id FOR UPDATE;

  v_digest := public.call_copilot_event_digest(
    p_provider_event_id, p_sequence, p_kind, p_party, p_disclosure_version, p_responds_to_sequence,
    p_route_kind, p_operator_region, p_caller_region, p_reason, p_occurred_at);

  SELECT id, payload_digest INTO v_existing
    FROM public.call_copilot_events
   WHERE shop_id = p_shop_id AND call_id = v_call_id AND provider_event_id = p_provider_event_id;
  IF FOUND THEN
    IF v_existing.payload_digest = v_digest THEN
      RETURN jsonb_build_object('outcome', 'duplicate', 'event_id', v_existing.id, 'digest', v_digest);
    END IF;
    INSERT INTO public.call_copilot_conflicts
      (shop_id, call_id, conflict_kind, provider_event_id, attempted_sequence, attempted_digest, existing_event_id)
    VALUES (p_shop_id, v_call_id, 'event_id_changed', p_provider_event_id, p_sequence, v_digest, v_existing.id)
    ON CONFLICT DO NOTHING;
    RETURN jsonb_build_object('outcome', 'conflict', 'conflict_kind', 'event_id_changed', 'digest', v_digest);
  END IF;

  SELECT id INTO v_existing
    FROM public.call_copilot_events
   WHERE shop_id = p_shop_id AND call_id = v_call_id AND sequence = p_sequence;
  IF FOUND THEN
    INSERT INTO public.call_copilot_conflicts
      (shop_id, call_id, conflict_kind, provider_event_id, attempted_sequence, attempted_digest, existing_event_id)
    VALUES (p_shop_id, v_call_id, 'sequence_reused', p_provider_event_id, p_sequence, v_digest, v_existing.id)
    ON CONFLICT DO NOTHING;
    RETURN jsonb_build_object('outcome', 'conflict', 'conflict_kind', 'sequence_reused', 'digest', v_digest);
  END IF;

  INSERT INTO public.call_copilot_events (
    shop_id, call_id, sequence, provider_event_id, kind, party, disclosure_version,
    responds_to_sequence, route_kind, operator_region, caller_region, reason, occurred_at, payload_digest)
  VALUES (
    p_shop_id, v_call_id, p_sequence, p_provider_event_id, p_kind, p_party, p_disclosure_version,
    p_responds_to_sequence, p_route_kind, p_operator_region, p_caller_region, p_reason, p_occurred_at, v_digest)
  RETURNING id INTO v_event_id;

  v_state := public.call_copilot_capture_state(p_shop_id, v_call_id);
  RETURN jsonb_build_object(
    'outcome', 'recorded', 'event_id', v_event_id, 'call_id', v_call_id, 'digest', v_digest,
    'status', v_state ->> 'status', 'reason', v_state ->> 'reason',
    'capture_permitted_now', (v_state ->> 'capture_permitted_now')::boolean);
END $$;

-- ---------------------------------------------------------------------------
-- Function ACLs: browser roles get nothing; the service role gets the three entry points.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  public.call_copilot_append_only(),
  public.call_copilot_ts(timestamptz),
  public.call_copilot_event_digest(text, integer, text, text, text, integer, text, text, text, text, timestamptz),
  public.call_copilot_close_interval(jsonb, integer, timestamptz, text),
  public.call_copilot_capture_state(uuid, uuid),
  public.call_copilot_assert_capture(uuid, uuid, text, timestamptz),
  public.call_copilot_record_event(uuid, text, text, text, integer, text, text, text, integer, text, text, text, text, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.call_copilot_capture_state(uuid, uuid),
  public.call_copilot_assert_capture(uuid, uuid, text, timestamptz),
  public.call_copilot_record_event(uuid, text, text, text, integer, text, text, text, integer, text, text, text, text, timestamptz)
  TO service_role;

COMMIT;
