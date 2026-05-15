-- Idempotency + timezone for the 24h SMS reminder cron.
-- - reminder_pending_action_id: NULL means no reminder staged yet.
--   The cron's WHERE clause excludes rows where it's set.
-- - timezone: captured from the booking proposal at create time so
--   the reminder formatter can say "Sat 2pm" in the shop's clock,
--   not UTC. Nullable because pre-existing rows don't have one.
-- Idempotent.

ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS reminder_pending_action_id uuid,
  ADD COLUMN IF NOT EXISTS timezone text;

CREATE INDEX IF NOT EXISTS appointments_reminder_window_idx
  ON public.appointments (scheduled_at)
  WHERE reminder_pending_action_id IS NULL;
