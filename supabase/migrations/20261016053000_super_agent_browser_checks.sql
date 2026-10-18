-- Explicit cloud-browser checks. The only stored outcome is unavailable.
-- No session, credential, cookie, or provider secret belongs in this table.
CREATE TABLE public.super_agent_browser_checks (
  id uuid PRIMARY KEY,
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  draft_id uuid NOT NULL REFERENCES public.super_agent_employee_drafts(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status = 'unavailable'),
  provider text NOT NULL CHECK (provider = 'none'),
  detail jsonb NOT NULL CHECK (
    jsonb_typeof(detail) = 'object'
    AND octet_length(detail::text) <= 4000
    AND detail->>'version' = '1'
    AND detail->>'provider' = 'none'
    AND detail->>'session_started' = 'false'
    AND detail->>'credentials_stored' = 'false'
    AND detail->>'local_machine_used' = 'false'
  ),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.super_agent_browser_checks ENABLE ROW LEVEL SECURITY;
CREATE INDEX super_agent_browser_checks_shop ON public.super_agent_browser_checks(shop_id, created_at DESC);
CREATE INDEX super_agent_browser_checks_draft ON public.super_agent_browser_checks(draft_id, created_at DESC);
REVOKE ALL ON public.super_agent_browser_checks FROM anon, authenticated;
GRANT SELECT, INSERT ON public.super_agent_browser_checks TO authenticated;
GRANT ALL ON public.super_agent_browser_checks TO service_role;

CREATE POLICY browser_checks_owner_read ON public.super_agent_browser_checks FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.shops s WHERE s.id = shop_id AND s.owner_id = (SELECT auth.uid())));
CREATE POLICY browser_checks_owner_create ON public.super_agent_browser_checks FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.shops s WHERE s.id = shop_id AND s.owner_id = (SELECT auth.uid())));

DO $$ BEGIN
  IF to_regprocedure('gradia_release_guard.reject_application_writes()') IS NOT NULL THEN
    EXECUTE 'CREATE TRIGGER gradia_release_freeze BEFORE INSERT OR UPDATE OR DELETE ON public.super_agent_browser_checks FOR EACH STATEMENT EXECUTE FUNCTION gradia_release_guard.reject_application_writes()';
    ALTER TABLE public.super_agent_browser_checks ENABLE ALWAYS TRIGGER gradia_release_freeze;
  END IF;
END $$;
