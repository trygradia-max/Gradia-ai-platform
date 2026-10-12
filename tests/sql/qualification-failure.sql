-- Disposable test fixture only, never an application migration.
CREATE OR REPLACE FUNCTION public.test_qualification_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.fields->'vehicle_condition'->>'text'='INJECT_QUALIFICATION_FAILURE' THEN RAISE EXCEPTION 'Injected qualification audit failure'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS test_qualification_failure ON public.lead_qualification_revisions;
CREATE TRIGGER test_qualification_failure BEFORE INSERT ON public.lead_qualification_revisions FOR EACH ROW EXECUTE FUNCTION public.test_qualification_failure();
