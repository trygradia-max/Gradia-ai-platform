BEGIN;

-- Membership billing history (Commercial Billing PR B, backend only).
--
-- Daily extra-operator seat proration needs to know, for every UTC day, which
-- distinct users were billable operators. `shop_memberships` is mutable current
-- state: role/active are updated in place and `revoked_at` is not even cleared on
-- reactivation, so history can NOT be reconstructed from it. This migration adds
-- the smallest append-only record that can answer the question going forward.
--
--  * A row trigger on shop_memberships captures every billing-relevant change
--    (insert, role/active update, delete) in the SAME transaction as the
--    mutation, whichever path made it: the owner/manager RPCs, invitation
--    acceptance, the shop bootstrap trigger, or a direct trusted write. If the
--    capture fails the membership change rolls back; a failed membership change
--    leaves no billing evidence.
--  * Coverage is explicit. Existing shops are covered FROM THIS MIGRATION'S
--    INSTANT with a snapshot of their current memberships; shops created later
--    are covered from their creation. Nothing before `covered_from` is claimed
--    and no history is invented from created_at, revoked_at or current role.
--  * Events and coverage are append-only (even for the table owner). Corrections
--    are explicit compensating events; prior history is never rewritten.
--  * Browser roles have no table or writer access. Owners read through a
--    live-authority function; the service role may also read and record
--    corrections. No existing shop_memberships or commercial usage row is
--    modified by this migration.

-- Block membership writes while the snapshot and the capture trigger are installed,
-- so no change can fall between "snapshotted" and "captured".
LOCK TABLE public.shop_memberships IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE public.commercial_membership_coverage (
  shop_id uuid PRIMARY KEY REFERENCES public.shops(id) ON DELETE CASCADE,
  covered_from timestamptz NOT NULL,
  basis text NOT NULL CHECK (basis IN ('migration_snapshot', 'shop_created')),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.commercial_membership_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  -- Gapless per-shop order, assigned under a per-shop lock. Breaks timestamp ties.
  shop_seq bigint NOT NULL CHECK (shop_seq > 0),
  -- Identity is preserved as plain ids: a user or membership may later be deleted.
  user_id uuid NOT NULL,
  member_id uuid,
  kind text NOT NULL CHECK (kind IN ('snapshot', 'change', 'correction')),
  previous_role text,
  previous_active boolean,
  -- Billing-timeline state of this user immediately before the event. NULL only for snapshots.
  previous_billable boolean,
  new_role text,
  new_active boolean,
  new_billable boolean NOT NULL,
  effective_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  source_operation text NOT NULL CHECK (source_operation IN (
    'migration_snapshot', 'membership_insert', 'membership_update', 'membership_delete', 'billing_correction')),
  actor_id uuid,
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'service_role', 'system')),
  db_transaction_id bigint,
  corrects_event_id uuid,
  reason text CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 500),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_.:-]{16,200}$'),
  UNIQUE (shop_id, shop_seq),
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, idempotency_key),
  FOREIGN KEY (shop_id, corrects_event_id) REFERENCES public.commercial_membership_events(shop_id, id),
  CHECK ((kind = 'correction') = (corrects_event_id IS NOT NULL AND reason IS NOT NULL)),
  CHECK (kind <> 'correction' OR (new_role IS NULL AND new_active IS NULL)),
  CHECK (kind = 'correction' OR (new_role IS NULL) = (new_active IS NULL)),
  -- Billable is exactly: active AND an approved operator role. Deleted (no role) is not billable.
  CHECK (kind = 'correction'
    OR new_billable = (coalesce(new_active, false) AND coalesce(new_role IN ('owner', 'manager', 'staff'), false))),
  CHECK ((kind = 'snapshot') = (previous_billable IS NULL)),
  CHECK (kind <> 'snapshot' OR (previous_role IS NULL AND previous_active IS NULL AND source_operation = 'migration_snapshot'))
);
CREATE INDEX commercial_membership_events_user_idx
  ON public.commercial_membership_events (shop_id, user_id, effective_at, shop_seq);
CREATE INDEX commercial_membership_events_time_idx
  ON public.commercial_membership_events (shop_id, effective_at, shop_seq);

-- Append-only: reuse the PR A guard (UPDATE/DELETE/TRUNCATE refused; only the shop
-- deletion cascade may remove rows).
CREATE TRIGGER commercial_membership_events_append_only
  BEFORE UPDATE OR DELETE ON public.commercial_membership_events
  FOR EACH ROW EXECUTE FUNCTION public.commercial_usage_append_only();
CREATE TRIGGER commercial_membership_coverage_append_only
  BEFORE UPDATE OR DELETE ON public.commercial_membership_coverage
  FOR EACH ROW EXECUTE FUNCTION public.commercial_usage_append_only();
CREATE TRIGGER commercial_membership_events_no_truncate
  BEFORE TRUNCATE ON public.commercial_membership_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.commercial_usage_append_only();
CREATE TRIGGER commercial_membership_coverage_no_truncate
  BEFORE TRUNCATE ON public.commercial_membership_coverage
  FOR EACH STATEMENT EXECUTE FUNCTION public.commercial_usage_append_only();

ALTER TABLE public.commercial_membership_coverage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commercial_membership_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.commercial_membership_coverage, public.commercial_membership_events
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.commercial_membership_coverage, public.commercial_membership_events TO service_role;

-- ---------------------------------------------------------------------------
-- Interval integrity: a per-shop gapless sequence, non-decreasing effective time
-- for captured changes, and per-user state continuity. This makes an impossible
-- interval unrepresentable even for a future writer.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.commercial_membership_events_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  last_seq bigint;
  last_effective timestamptz;
  timeline boolean;
  covered timestamptz;
BEGIN
  SELECT coalesce(max(shop_seq), 0), max(effective_at) INTO last_seq, last_effective
    FROM public.commercial_membership_events WHERE shop_id = NEW.shop_id;
  IF NEW.shop_seq <> last_seq + 1 THEN
    RAISE EXCEPTION 'Membership billing sequence must be gapless' USING ERRCODE='23514';
  END IF;

  IF NEW.kind = 'correction' THEN
    SELECT covered_from INTO covered FROM public.commercial_membership_coverage WHERE shop_id = NEW.shop_id;
    IF covered IS NULL OR NEW.effective_at < covered THEN
      RAISE EXCEPTION 'A correction cannot reach before explicit coverage' USING ERRCODE='23514';
    END IF;
    -- Billing-timeline state of the user at the corrected instant (later-recorded wins ties).
    SELECT e.new_billable INTO timeline FROM public.commercial_membership_events e
      WHERE e.shop_id = NEW.shop_id AND e.user_id = NEW.user_id AND e.effective_at <= NEW.effective_at
      ORDER BY e.effective_at DESC, e.shop_seq DESC LIMIT 1;
    IF NEW.previous_billable IS DISTINCT FROM coalesce(timeline, false) THEN
      RAISE EXCEPTION 'Correction does not continue the recorded interval' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  IF last_effective IS NOT NULL AND NEW.effective_at < last_effective THEN
    RAISE EXCEPTION 'Membership billing time cannot move backwards' USING ERRCODE='23514';
  END IF;
  SELECT e.new_billable INTO timeline FROM public.commercial_membership_events e
    WHERE e.shop_id = NEW.shop_id AND e.user_id = NEW.user_id
    ORDER BY e.effective_at DESC, e.shop_seq DESC LIMIT 1;
  IF NEW.kind = 'snapshot' THEN
    IF FOUND THEN RAISE EXCEPTION 'A snapshot cannot follow earlier history' USING ERRCODE='23514'; END IF;
  ELSIF NEW.previous_billable IS DISTINCT FROM coalesce(timeline, false) THEN
    RAISE EXCEPTION 'Change does not continue the recorded interval' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commercial_membership_events_guard
  BEFORE INSERT ON public.commercial_membership_events
  FOR EACH ROW EXECUTE FUNCTION public.commercial_membership_events_guard();

-- ---------------------------------------------------------------------------
-- Explicit coverage start and initial snapshot for every existing shop. One
-- instant for the whole migration; nothing before it is claimed.
-- ---------------------------------------------------------------------------
-- The instant is taken ONCE, after the lock above is held, so no membership change can fall
-- before it unrecorded. (A volatile subquery in FROM could be re-evaluated per row.)
CREATE TEMP TABLE commercial_membership_migration_instant ON COMMIT DROP AS
  SELECT clock_timestamp() AS ts;

INSERT INTO public.commercial_membership_coverage (shop_id, covered_from, basis)
SELECT s.id, (SELECT i.ts FROM commercial_membership_migration_instant i), 'migration_snapshot'
FROM public.shops s;

INSERT INTO public.commercial_membership_events (
  shop_id, shop_seq, user_id, member_id, kind, previous_role, previous_active, previous_billable,
  new_role, new_active, new_billable, effective_at, source_operation, actor_id, actor_kind,
  db_transaction_id, idempotency_key)
SELECT
  m.shop_id,
  row_number() OVER (PARTITION BY m.shop_id ORDER BY m.created_at, m.id),
  m.user_id, m.id, 'snapshot', NULL, NULL, NULL,
  m.role, m.active,
  (m.active AND m.role IN ('owner', 'manager', 'staff')),
  c.covered_from, 'migration_snapshot', NULL, 'system', txid_current(),
  'snap.v1.' || m.shop_id::text || '.' || m.user_id::text
FROM public.shop_memberships m
JOIN public.commercial_membership_coverage c ON c.shop_id = m.shop_id
ORDER BY m.shop_id, m.created_at, m.id;

-- ---------------------------------------------------------------------------
-- Capture. Runs inside the membership mutation's own transaction.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.commercial_membership_emit(
  p_shop uuid, p_user uuid, p_member uuid,
  p_prev_role text, p_prev_active boolean, p_new_role text, p_new_active boolean, p_operation text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_id uuid := gen_random_uuid();
  v_seq bigint;
  v_effective timestamptz;
  v_prev boolean;
  v_new boolean;
  v_actor_kind text;
BEGIN
  -- Serializes capture per shop (membership row locks already serialize one member).
  PERFORM pg_advisory_xact_lock(hashtextextended('gradia.membership_billing.' || p_shop::text, 0));
  v_effective := greatest(
    clock_timestamp(),
    coalesce((SELECT max(effective_at) FROM public.commercial_membership_events WHERE shop_id = p_shop), '-infinity'::timestamptz));
  SELECT coalesce(max(shop_seq), 0) + 1 INTO v_seq FROM public.commercial_membership_events WHERE shop_id = p_shop;

  -- A shop that has no coverage yet was created after this migration: covered from creation.
  INSERT INTO public.commercial_membership_coverage (shop_id, covered_from, basis)
  VALUES (p_shop, v_effective, 'shop_created') ON CONFLICT (shop_id) DO NOTHING;

  SELECT e.new_billable INTO v_prev FROM public.commercial_membership_events e
    WHERE e.shop_id = p_shop AND e.user_id = p_user ORDER BY e.effective_at DESC, e.shop_seq DESC LIMIT 1;
  v_new := coalesce(coalesce(p_new_active, false) AND p_new_role IN ('owner', 'manager', 'staff'), false);
  v_actor_kind := CASE WHEN auth.uid() IS NOT NULL THEN 'user'
                       WHEN coalesce(auth.role(), '') = 'service_role' THEN 'service_role'
                       ELSE 'system' END;

  INSERT INTO public.commercial_membership_events (
    id, shop_id, shop_seq, user_id, member_id, kind, previous_role, previous_active, previous_billable,
    new_role, new_active, new_billable, effective_at, source_operation, actor_id, actor_kind,
    db_transaction_id, idempotency_key)
  VALUES (
    v_id, p_shop, v_seq, p_user, p_member, 'change', p_prev_role, p_prev_active, coalesce(v_prev, false),
    p_new_role, p_new_active, v_new, v_effective, p_operation, auth.uid(), v_actor_kind,
    txid_current(), 'auto.v1.' || v_id::text);
END $$;

CREATE FUNCTION public.commercial_membership_capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.commercial_membership_emit(NEW.shop_id, NEW.user_id, NEW.id, NULL, NULL, NEW.role, NEW.active, 'membership_insert');
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.shop_id IS DISTINCT FROM OLD.shop_id THEN
      -- Not a supported operation, but never lose billing evidence if it happens.
      PERFORM public.commercial_membership_emit(OLD.shop_id, OLD.user_id, OLD.id, OLD.role, OLD.active, NULL, NULL, 'membership_delete');
      PERFORM public.commercial_membership_emit(NEW.shop_id, NEW.user_id, NEW.id, NULL, NULL, NEW.role, NEW.active, 'membership_insert');
    ELSIF NEW.role IS DISTINCT FROM OLD.role OR NEW.active IS DISTINCT FROM OLD.active THEN
      PERFORM public.commercial_membership_emit(NEW.shop_id, NEW.user_id, NEW.id, OLD.role, OLD.active, NEW.role, NEW.active, 'membership_update');
    END IF;
    -- capabilities / display_name / revoked_at only: no billing effect.
  ELSE
    -- The cascade from deleting a whole shop removes the evidence with it (the shop is already gone).
    IF EXISTS (SELECT 1 FROM public.shops WHERE id = OLD.shop_id) THEN
      PERFORM public.commercial_membership_emit(OLD.shop_id, OLD.user_id, OLD.id, OLD.role, OLD.active, NULL, NULL, 'membership_delete');
    END IF;
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commercial_membership_capture
  AFTER INSERT OR UPDATE OR DELETE ON public.shop_memberships
  FOR EACH ROW EXECUTE FUNCTION public.commercial_membership_capture();

-- ---------------------------------------------------------------------------
-- Correction (service role only): an explicit compensating event that sets one
-- user's billable state from a recorded instant until the next recorded event.
-- ---------------------------------------------------------------------------
-- Failure codes: 42501 authority, 22023 invalid input, CB409 conflict.
CREATE FUNCTION public.commercial_membership_correct(
  p_shop uuid,
  p_user_id uuid,
  p_effective_at timestamptz,
  p_billable boolean,
  p_corrects_event_id uuid,
  p_reason text,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  target public.commercial_membership_events;
  existing public.commercial_membership_events;
  covered timestamptz;
  v_prev boolean;
  v_seq bigint;
  v_id uuid := gen_random_uuid();
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Membership billing correction is a server-only command' USING ERRCODE='42501';
  END IF;
  IF p_shop IS NULL OR p_user_id IS NULL OR p_effective_at IS NULL OR p_billable IS NULL
     OR p_corrects_event_id IS NULL OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500
     OR p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9_.:-]{16,200}$' THEN
    RAISE EXCEPTION 'Invalid correction' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.shops WHERE id = p_shop) THEN
    RAISE EXCEPTION 'Unknown shop' USING ERRCODE='22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('gradia.membership_billing.' || p_shop::text, 0));

  SELECT * INTO existing FROM public.commercial_membership_events
    WHERE shop_id = p_shop AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF existing.kind <> 'correction' OR existing.user_id IS DISTINCT FROM p_user_id
       OR existing.effective_at IS DISTINCT FROM p_effective_at
       OR existing.new_billable IS DISTINCT FROM p_billable
       OR existing.corrects_event_id IS DISTINCT FROM p_corrects_event_id
       OR existing.reason IS DISTINCT FROM p_reason THEN
      RAISE EXCEPTION 'Idempotency identity already holds a different correction' USING ERRCODE='CB409';
    END IF;
    RETURN jsonb_build_object('id', existing.id, 'replayed', true);
  END IF;

  SELECT * INTO target FROM public.commercial_membership_events
    WHERE shop_id = p_shop AND id = p_corrects_event_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Corrected event not found for this shop and user' USING ERRCODE='22023';
  END IF;
  SELECT covered_from INTO covered FROM public.commercial_membership_coverage WHERE shop_id = p_shop;
  IF covered IS NULL OR p_effective_at < covered OR p_effective_at > clock_timestamp() THEN
    RAISE EXCEPTION 'Correction time must be inside explicit coverage and not in the future' USING ERRCODE='22023';
  END IF;

  SELECT e.new_billable INTO v_prev FROM public.commercial_membership_events e
    WHERE e.shop_id = p_shop AND e.user_id = p_user_id AND e.effective_at <= p_effective_at
    ORDER BY e.effective_at DESC, e.shop_seq DESC LIMIT 1;
  SELECT coalesce(max(shop_seq), 0) + 1 INTO v_seq FROM public.commercial_membership_events WHERE shop_id = p_shop;

  INSERT INTO public.commercial_membership_events (
    id, shop_id, shop_seq, user_id, member_id, kind, previous_billable, new_billable, effective_at,
    source_operation, actor_id, actor_kind, db_transaction_id, corrects_event_id, reason, idempotency_key)
  VALUES (
    v_id, p_shop, v_seq, p_user_id, target.member_id, 'correction', coalesce(v_prev, false), p_billable, p_effective_at,
    'billing_correction', auth.uid(), 'service_role', txid_current(), p_corrects_event_id, p_reason, p_idempotency_key);
  RETURN jsonb_build_object('id', v_id, 'replayed', false);
END $$;

-- ---------------------------------------------------------------------------
-- Read the membership evidence for one explicit half-open UTC window.
-- Live owner or service role only. Returns raw immutable facts; the
-- deterministic seat arithmetic is performed by reviewed application code.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.commercial_membership_read(
  p_shop uuid,
  p_window_start timestamptz,
  p_window_end timestamptz,
  p_as_of timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE
  as_of timestamptz := coalesce(p_as_of, clock_timestamp());
  coverage jsonb;
  events jsonb;
BEGIN
  IF NOT (coalesce(auth.role(), '') = 'service_role' OR public.commercial_is_active_owner(p_shop)) THEN
    RAISE EXCEPTION 'Owner authority required' USING ERRCODE='42501';
  END IF;
  IF p_window_start IS NULL OR p_window_end IS NULL OR p_window_end <= p_window_start
     OR p_window_end - p_window_start > interval '40 days' THEN
    RAISE EXCEPTION 'Invalid window' USING ERRCODE='22023';
  END IF;

  SELECT jsonb_build_object('covered_from', c.covered_from, 'basis', c.basis, 'recorded_at', c.recorded_at)
    INTO coverage FROM public.commercial_membership_coverage c
    WHERE c.shop_id = p_shop AND c.recorded_at <= as_of;

  -- For every user: the state in force at the window start (last event at or before it)
  -- plus every event inside the window. Events recorded after as_of do not exist yet.
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', e.id, 'shop_seq', e.shop_seq, 'user_id', e.user_id, 'member_id', e.member_id,
      'kind', e.kind, 'previous_billable', e.previous_billable, 'new_role', e.new_role,
      'new_active', e.new_active, 'new_billable', e.new_billable, 'effective_at', e.effective_at,
      'recorded_at', e.recorded_at, 'source_operation', e.source_operation,
      'corrects_event_id', e.corrects_event_id) ORDER BY e.effective_at, e.shop_seq), '[]'::jsonb)
    INTO events
    FROM public.commercial_membership_events e
    WHERE e.shop_id = p_shop AND e.recorded_at <= as_of AND e.effective_at < p_window_end
      AND (e.effective_at > p_window_start OR e.id IN (
        SELECT DISTINCT ON (b.user_id) b.id FROM public.commercial_membership_events b
        WHERE b.shop_id = p_shop AND b.recorded_at <= as_of AND b.effective_at <= p_window_start
        ORDER BY b.user_id, b.effective_at DESC, b.shop_seq DESC));

  RETURN jsonb_build_object(
    'shop_id', p_shop, 'window_start', p_window_start, 'window_end', p_window_end,
    'as_of', as_of, 'coverage', coverage, 'events', events);
END $$;

-- ---------------------------------------------------------------------------
-- Function ACLs
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  public.commercial_membership_events_guard(),
  public.commercial_membership_emit(uuid, uuid, uuid, text, boolean, text, boolean, text),
  public.commercial_membership_capture(),
  public.commercial_membership_correct(uuid, uuid, timestamptz, boolean, uuid, text, text),
  public.commercial_membership_read(uuid, timestamptz, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.commercial_membership_correct(uuid, uuid, timestamptz, boolean, uuid, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION
  public.commercial_membership_read(uuid, timestamptz, timestamptz, timestamptz)
  TO authenticated, service_role;

COMMIT;
