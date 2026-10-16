-- Research reports for a saved employee brief. A report is evidence for
-- review. It does not publish, send, or grant a later action.
CREATE TABLE public.super_agent_research_runs (
  id uuid PRIMARY KEY,
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  draft_id uuid NOT NULL REFERENCES public.super_agent_employee_drafts(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('blocked', 'ready')),
  report jsonb NOT NULL CHECK (jsonb_typeof(report) = 'object' AND octet_length(report::text) <= 20000),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.super_agent_research_runs ENABLE ROW LEVEL SECURITY;
CREATE INDEX super_agent_research_runs_shop ON public.super_agent_research_runs(shop_id, created_at DESC);
REVOKE ALL ON public.super_agent_research_runs FROM anon, authenticated;
GRANT SELECT, INSERT ON public.super_agent_research_runs TO authenticated;
GRANT ALL ON public.super_agent_research_runs TO service_role;
CREATE POLICY research_runs_owner_read ON public.super_agent_research_runs FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.shops s WHERE s.id = shop_id AND s.owner_id = (SELECT auth.uid())));
CREATE POLICY research_runs_owner_create ON public.super_agent_research_runs FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.shops s WHERE s.id = shop_id AND s.owner_id = (SELECT auth.uid()))
    AND EXISTS (
      SELECT 1 FROM public.super_agent_employee_drafts d
      WHERE d.id = draft_id AND d.shop_id = shop_id
    )
  );
DO $$ BEGIN
  IF to_regprocedure('gradia_release_guard.reject_application_writes()') IS NOT NULL THEN
    EXECUTE 'CREATE TRIGGER gradia_release_freeze BEFORE INSERT OR UPDATE OR DELETE ON public.super_agent_research_runs FOR EACH STATEMENT EXECUTE FUNCTION gradia_release_guard.reject_application_writes()';
    ALTER TABLE public.super_agent_research_runs ENABLE ALWAYS TRIGGER gradia_release_freeze;
  END IF;
END $$;
