-- Experimental public-page research results. A saved run is not a connected
-- account, a schedule, or permission to change anything. Owner insert/read only.
CREATE TABLE public.super_agent_research_runs (
  id uuid PRIMARY KEY,
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  draft_id uuid NOT NULL REFERENCES public.super_agent_employee_drafts(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('completed', 'cancelled', 'timed_out', 'budget_exhausted', 'failed')),
  report jsonb NOT NULL CHECK (jsonb_typeof(report) = 'object' AND octet_length(report::text) <= 80000),
  credits integer NOT NULL DEFAULT 0 CHECK (credits >= 0 AND credits <= 100),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.super_agent_research_cancels (
  run_id uuid PRIMARY KEY,
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.super_agent_research_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.super_agent_research_cancels ENABLE ROW LEVEL SECURITY;
CREATE INDEX super_agent_research_runs_shop ON public.super_agent_research_runs(shop_id, created_at DESC);
CREATE INDEX super_agent_research_runs_draft ON public.super_agent_research_runs(draft_id, created_at DESC);
CREATE INDEX super_agent_research_cancels_shop ON public.super_agent_research_cancels(shop_id);
REVOKE ALL ON public.super_agent_research_runs, public.super_agent_research_cancels FROM anon, authenticated;
GRANT SELECT, INSERT ON public.super_agent_research_runs, public.super_agent_research_cancels TO authenticated;
GRANT ALL ON public.super_agent_research_runs, public.super_agent_research_cancels TO service_role;

CREATE POLICY research_runs_owner_read ON public.super_agent_research_runs FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.shops s WHERE s.id = shop_id AND s.owner_id = (SELECT auth.uid())));
CREATE POLICY research_runs_owner_create ON public.super_agent_research_runs FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.shops s WHERE s.id = shop_id AND s.owner_id = (SELECT auth.uid())));
CREATE POLICY research_cancels_owner_read ON public.super_agent_research_cancels FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.shops s WHERE s.id = shop_id AND s.owner_id = (SELECT auth.uid())));
CREATE POLICY research_cancels_owner_create ON public.super_agent_research_cancels FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.shops s WHERE s.id = shop_id AND s.owner_id = (SELECT auth.uid())));

DO $$ BEGIN
  IF to_regprocedure('gradia_release_guard.reject_application_writes()') IS NOT NULL THEN
    EXECUTE 'CREATE TRIGGER gradia_release_freeze BEFORE INSERT OR UPDATE OR DELETE ON public.super_agent_research_runs FOR EACH STATEMENT EXECUTE FUNCTION gradia_release_guard.reject_application_writes()';
    EXECUTE 'CREATE TRIGGER gradia_release_freeze BEFORE INSERT OR UPDATE OR DELETE ON public.super_agent_research_cancels FOR EACH STATEMENT EXECUTE FUNCTION gradia_release_guard.reject_application_writes()';
    ALTER TABLE public.super_agent_research_runs ENABLE ALWAYS TRIGGER gradia_release_freeze;
    ALTER TABLE public.super_agent_research_cancels ENABLE ALWAYS TRIGGER gradia_release_freeze;
  END IF;
END $$;
