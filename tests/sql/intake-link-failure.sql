-- Test-only fixture, installed only by disposable bootstrap. Never a migration.
CREATE OR REPLACE FUNCTION public.test_intake_link_failure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.thread_key='INTAKE_INJECT_LINK_FAILURE' AND NEW.state='identity_linked' THEN
  RAISE EXCEPTION 'Injected intake link failure';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS test_intake_link_failure ON public.lead_workflows;
CREATE TRIGGER test_intake_link_failure BEFORE UPDATE ON public.lead_workflows FOR EACH ROW EXECUTE FUNCTION public.test_intake_link_failure();
