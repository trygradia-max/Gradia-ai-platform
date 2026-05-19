-- Custom Co-pilot agents — the operator describes a workflow in
-- natural language, Claude plans it, the plan is saved here. The
-- runtime that actually executes these (cron + condition engine +
-- action dispatcher) is a follow-up chunk; for now we just persist
-- the design so it surfaces alongside the built-in agents.
--
-- `config` holds the structured plan (see AgentConfig in
-- src/lib/types/database.ts). `enabled` is the eventual on/off
-- switch — defaults to false until the runtime exists.
-- Idempotent.

CREATE TABLE IF NOT EXISTS public.custom_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops (id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  problem_text text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS custom_agents_shop_id_idx
  ON public.custom_agents (shop_id, updated_at DESC);

ALTER TABLE public.custom_agents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS custom_agents_tenant_isolation ON public.custom_agents;
CREATE POLICY custom_agents_tenant_isolation ON public.custom_agents
  FOR ALL USING (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  )
  WITH CHECK (
    shop_id IN (SELECT id FROM public.shops WHERE owner_id = (SELECT auth.uid()))
  );
