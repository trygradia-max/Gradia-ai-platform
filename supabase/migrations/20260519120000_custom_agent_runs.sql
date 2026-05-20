-- Per-fire history for custom agents — what triggered, when, what
-- the outcome was, and the per-recipe stats. RLS scoped per shop.
--
-- We deliberately don't log cron ticks that just decide "not yet"
-- (cadence not open / fired recently) — that's millions of noise
-- rows per year. Only meaningful outcomes: fired runs, errors,
-- and skips that need operator action (e.g., "Twilio not connected").
-- Idempotent.

CREATE TABLE IF NOT EXISTS public.custom_agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES public.custom_agents (id) ON DELETE CASCADE,
  shop_id uuid NOT NULL REFERENCES public.shops (id) ON DELETE CASCADE,
  trigger_source text NOT NULL,
  fired boolean NOT NULL,
  reason text,
  stats jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS custom_agent_runs_agent_id_idx
  ON public.custom_agent_runs (agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS custom_agent_runs_shop_id_idx
  ON public.custom_agent_runs (shop_id, created_at DESC);

ALTER TABLE public.custom_agent_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS custom_agent_runs_tenant_isolation ON public.custom_agent_runs;
CREATE POLICY custom_agent_runs_tenant_isolation ON public.custom_agent_runs
  FOR ALL USING (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  )
  WITH CHECK (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  );
