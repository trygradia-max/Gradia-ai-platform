-- Experimental job briefs only. No execution grants, scheduled jobs or memory publication.
CREATE TABLE public.super_agent_employee_drafts (
  id uuid PRIMARY KEY,
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  brief jsonb NOT NULL CHECK (jsonb_typeof(brief) = 'object' AND octet_length(brief::text) <= 20000),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.super_agent_employee_drafts ENABLE ROW LEVEL SECURITY;
CREATE INDEX super_agent_employee_drafts_shop ON public.super_agent_employee_drafts(shop_id, created_at DESC);
REVOKE ALL ON public.super_agent_employee_drafts FROM anon, authenticated;
GRANT SELECT, INSERT ON public.super_agent_employee_drafts TO authenticated;
GRANT ALL ON public.super_agent_employee_drafts TO service_role;
CREATE POLICY employee_drafts_owner_read ON public.super_agent_employee_drafts FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.shops s WHERE s.id = shop_id AND s.owner_id = (SELECT auth.uid())));
CREATE POLICY employee_drafts_owner_create ON public.super_agent_employee_drafts FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.shops s WHERE s.id = shop_id AND s.owner_id = (SELECT auth.uid())));
-- Preserve the existing release hold if this migration is later applied to a frozen database.
DO $$ BEGIN
  IF to_regprocedure('gradia_release_guard.reject_application_writes()') IS NOT NULL THEN
    EXECUTE 'CREATE TRIGGER gradia_release_freeze BEFORE INSERT OR UPDATE OR DELETE ON public.super_agent_employee_drafts FOR EACH STATEMENT EXECUTE FUNCTION gradia_release_guard.reject_application_writes()';
    ALTER TABLE public.super_agent_employee_drafts ENABLE ALWAYS TRIGGER gradia_release_freeze;
  END IF;
END $$;
