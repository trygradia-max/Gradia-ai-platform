-- Test-only trigger. Never part of application migrations; disposable bootstrap only.
CREATE OR REPLACE FUNCTION public.p0_inject_merge_failure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.name='P0_INJECT_MERGE_FAILURE' THEN RAISE EXCEPTION 'Injected mid-merge failure'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS p0_inject_merge_failure ON public.customers;
CREATE TRIGGER p0_inject_merge_failure BEFORE UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION public.p0_inject_merge_failure();
