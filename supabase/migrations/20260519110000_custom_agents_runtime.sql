-- Runtime support for custom agents. `last_fired_at` is the
-- idempotency anchor: before firing on a cron tick, the runtime
-- checks that enough time has passed since the previous fire for
-- the agent's cadence. Hourly agents need >= 50 min, daily >= 23h,
-- weekly >= 6 days. Misses on a single tick are fine — the next
-- one catches up.
-- Idempotent.

ALTER TABLE public.custom_agents
  ADD COLUMN IF NOT EXISTS last_fired_at timestamptz;

CREATE INDEX IF NOT EXISTS custom_agents_runtime_idx
  ON public.custom_agents (enabled, last_fired_at)
  WHERE enabled = true;
