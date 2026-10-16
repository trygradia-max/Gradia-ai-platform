-- Explicit reads of notes the business already saved. A row is not a published lesson.
CREATE TABLE public.super_agent_memory_reads (
  id uuid PRIMARY KEY,
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  draft_id uuid NOT NULL REFERENCES public.super_agent_employee_drafts(id) ON DELETE CASCADE,
  detail jsonb NOT NULL CHECK (
    jsonb_typeof(detail) = 'object'
    AND octet_length(detail::text) <= 8000
    AND detail->>'version' = '1'
    AND detail->>'published' = 'false'
    AND detail->>'lesson_created' = 'false'
    AND detail->>'research_included' = 'false'
  ),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.super_agent_memory_reads ENABLE ROW LEVEL SECURITY;
CREATE INDEX super_agent_memory_reads_shop ON public.super_agent_memory_reads(shop_id, created_at DESC);
CREATE INDEX super_agent_memory_reads_draft ON public.super_agent_memory_reads(draft_id, created_at DESC);
REVOKE ALL ON public.super_agent_memory_reads FROM anon, authenticated;
GRANT SELECT, INSERT ON public.super_agent_memory_reads TO authenticated;
GRANT ALL ON public.super_agent_memory_reads TO service_role;

CREATE POLICY memory_reads_owner_read ON public.super_agent_memory_reads FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.shops s WHERE s.id = shop_id AND s.owner_id = (SELECT auth.uid())));
CREATE POLICY memory_reads_owner_create ON public.super_agent_memory_reads FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.shops s WHERE s.id = shop_id AND s.owner_id = (SELECT auth.uid())));

DO $$ BEGIN
  IF to_regprocedure('gradia_release_guard.reject_application_writes()') IS NOT NULL THEN
    EXECUTE 'CREATE TRIGGER gradia_release_freeze BEFORE INSERT OR UPDATE OR DELETE ON public.super_agent_memory_reads FOR EACH STATEMENT EXECUTE FUNCTION gradia_release_guard.reject_application_writes()';
    ALTER TABLE public.super_agent_memory_reads ENABLE ALWAYS TRIGGER gradia_release_freeze;
  END IF;
END $$;
