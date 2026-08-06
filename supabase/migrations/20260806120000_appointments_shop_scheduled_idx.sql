-- 2026-08-06 P0-004 — conflict enforcement across booking paths.
--
-- The P0-003 availability service range-queries appointments by
-- (shop_id, scheduled_at) and P0-004 puts that query on EVERY booking,
-- reschedule, quote-accept, voice, drag, and block-time path. The P0-003
-- completion report recommended this composite once the check went hot;
-- the single-column indexes it supersedes stay in place. Additive and
-- idempotent — safe to re-run.

CREATE INDEX IF NOT EXISTS appointments_shop_scheduled_idx
  ON public.appointments (shop_id, scheduled_at);
