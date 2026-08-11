-- P0-004A — appointment booking atomicity and concurrency (issue #13).
--
-- 1. appointments.pending_action_id: durable idempotency link between an
--    approved action and the appointment it produced. A replayed/re-driven
--    approval finds the existing row instead of inserting a second one.
--    Partial UNIQUE enforces "one appointment per approved action" at the
--    database level (D-023 pattern: durable identifiers + DB uniques, never
--    check-then-insert alone).
-- 2. write_appointment_serialized(): the ONE serialized write path for
--    appointment time ranges. In a single transaction it takes a per-shop
--    advisory lock, re-verifies busy overlap under that lock, and performs
--    the INSERT (booking / block-time) or UPDATE (reschedule). This closes
--    the check→insert TOCTOU race across all application instances.
--
--    Scope note: the in-lock overlap check is the TRANSACTIONAL INVARIANT
--    only — it mirrors the blocking-appointment semantics of the central
--    TS service (src/lib/availability.ts: non-'closed' status = busy,
--    half-open [start, end), ends_at when valid else duration else 90m).
--    It is NOT a second scheduling engine: hours/capacity/calendar policy,
--    labels, and D-015/D-016 stay in the TS service, which remains the
--    single application-level conflict algorithm.
--
--    p_covered_ids: appointment ids a validated D-016 override covers.
--    Rows in this list do not block the write (deliberate double-booking
--    stays possible — capacity > 1 is preserved); any OTHER overlapping
--    row that raced in still refuses, so an override never absorbs a
--    conflict its author did not see.
--
--    Locking: pg_advisory_xact_lock on a per-shop key — tenant-scoped
--    (shop A never blocks shop B), transaction-bounded release (no stuck
--    locks on failure), Postgres-backed (works across Vercel instances,
--    no process memory). SECURITY INVOKER: session callers stay under
--    RLS; every statement is additionally shop-scoped explicitly.
--
-- Idempotent; additive only. Rollback: DROP FUNCTION, DROP INDEX, then
-- ALTER TABLE ... DROP COLUMN pending_action_id (stamped ids are inert if
-- the column is left in place).

ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS pending_action_id uuid
    REFERENCES public.pending_actions (id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS appointments_pending_action_id_unique
  ON public.appointments (pending_action_id)
  WHERE pending_action_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.write_appointment_serialized(
  p_shop_id uuid,
  p_start timestamptz,
  p_end timestamptz,
  p_covered_ids uuid[] DEFAULT '{}',
  p_appointment_id uuid DEFAULT NULL,   -- non-null → UPDATE (reschedule) mode
  p_pending_action_id uuid DEFAULT NULL, -- idempotency key (INSERT mode)
  p_lead_id uuid DEFAULT NULL,
  p_customer_id uuid DEFAULT NULL,
  p_duration_minutes integer DEFAULT NULL,
  p_service_name text DEFAULT NULL,
  p_timezone text DEFAULT NULL,
  p_internal_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_existing uuid;
  v_conflicts uuid[];
  v_id uuid;
BEGIN
  IF p_shop_id IS NULL OR p_start IS NULL OR p_end IS NULL OR p_end <= p_start THEN
    RAISE EXCEPTION 'write_appointment_serialized: invalid range (shop %, % .. %)',
      p_shop_id, p_start, p_end;
  END IF;

  -- Tenant-scoped serialization point. Same shop → serialized; different
  -- shops → independent keys, no cross-tenant blocking.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('gradia:appointments:' || p_shop_id::text, 0)
  );

  -- Idempotent replay: this approved action already produced its row.
  IF p_pending_action_id IS NOT NULL THEN
    SELECT a.id INTO v_existing
      FROM public.appointments a
     WHERE a.shop_id = p_shop_id
       AND a.pending_action_id = p_pending_action_id
     LIMIT 1;
    IF v_existing IS NOT NULL THEN
      RETURN jsonb_build_object('status', 'exists', 'id', v_existing);
    END IF;
  END IF;

  -- In-lock busy-overlap verification (transactional invariant; semantics
  -- mirror the TS service's blocking check exactly — see header).
  SELECT array_agg(a.id) INTO v_conflicts
    FROM public.appointments a
   WHERE a.shop_id = p_shop_id
     AND (p_appointment_id IS NULL OR a.id <> p_appointment_id)
     AND COALESCE(a.status::text, 'busy') <> 'closed'
     AND a.scheduled_at < p_end
     AND (CASE
            WHEN a.ends_at IS NOT NULL AND a.ends_at > a.scheduled_at THEN a.ends_at
            ELSE a.scheduled_at
                 + make_interval(mins => CASE
                     WHEN a.duration_minutes IS NULL OR a.duration_minutes <= 0 THEN 90
                     ELSE a.duration_minutes
                   END)
          END) > p_start
     AND NOT (a.id = ANY (COALESCE(p_covered_ids, '{}')));

  IF v_conflicts IS NOT NULL AND array_length(v_conflicts, 1) > 0 THEN
    RETURN jsonb_build_object(
      'status', 'conflict',
      'conflict_ids', to_jsonb(v_conflicts)
    );
  END IF;

  IF p_appointment_id IS NOT NULL THEN
    UPDATE public.appointments
       SET scheduled_at = p_start,
           ends_at = p_end,
           updated_at = now()
     WHERE id = p_appointment_id
       AND shop_id = p_shop_id
     RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      RETURN jsonb_build_object('status', 'not_found');
    END IF;
    RETURN jsonb_build_object('status', 'updated', 'id', v_id);
  END IF;

  INSERT INTO public.appointments
    (shop_id, scheduled_at, ends_at, pending_action_id, lead_id, customer_id,
     duration_minutes, service_name, timezone, internal_note)
  VALUES
    (p_shop_id, p_start, p_end, p_pending_action_id, p_lead_id, p_customer_id,
     p_duration_minutes, p_service_name, p_timezone, p_internal_note)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('status', 'inserted', 'id', v_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.write_appointment_serialized(
  uuid, timestamptz, timestamptz, uuid[], uuid, uuid, uuid, uuid, integer, text, text, text
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.write_appointment_serialized(
  uuid, timestamptz, timestamptz, uuid[], uuid, uuid, uuid, uuid, integer, text, text, text
) TO service_role;
