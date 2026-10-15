-- Disposable test fixture only, never an application migration.
CREATE OR REPLACE FUNCTION public.test_whisper_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.binding->'payload'->>'reason'='INJECT_WHISPER_FAILURE' OR NEW.binding->'payload'->>'body'='INJECT_WHISPER_FAILURE' THEN RAISE EXCEPTION 'Injected whisper failure'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS test_whisper_failure ON public.conversation_audit;
CREATE TRIGGER test_whisper_failure BEFORE INSERT ON public.conversation_audit FOR EACH ROW EXECUTE FUNCTION public.test_whisper_failure();
