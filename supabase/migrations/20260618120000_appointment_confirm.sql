-- No-show ladder (NEXT-2): confirm-by-text tracking on appointments. The
-- confirm step stages a text ~48h out (HITL, like the 24h reminder); the
-- customer's "YES" reply sets confirmed_at; an unconfirmed appointment inside
-- the cutoff surfaces a backfill nudge to the owner.
alter table public.appointments
  add column if not exists confirmed_at timestamptz,
  -- Idempotency for the confirm cron, mirroring reminder_pending_action_id.
  add column if not exists confirm_pending_action_id uuid;

-- The confirm cron scans upcoming appointments not yet asked to confirm.
create index if not exists appointments_confirm_pending_idx
  on public.appointments (scheduled_at)
  where confirm_pending_action_id is null;
