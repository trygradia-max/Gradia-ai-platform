"""Disposable-only policy ledger, RLS, references and atomic history probe."""
from pathlib import Path
import os
import subprocess
root = Path(__file__).resolve().parent.parent
assert 'project_id = "gradia-isolated-tests"' in (root / 'tests/supabase/config.toml').read_text()
assert not (root / '.local-tools/supabase-test/supabase/.temp/project-ref').exists()
def run(sql):
    r = subprocess.run(['docker','exec','-i','supabase_db_gradia-isolated-tests','psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres','-At'], input=sql, text=True, capture_output=True, env={'PATH':os.environ['PATH'],'DOCKER_HOST':'unix:///var/run/docker.sock'})
    if r.returncode: raise SystemExit('FAIL: disposable policy probe failed; database output withheld')
    return r.stdout.strip()
versions=sorted(p.name.split('_')[0] for p in (root/'supabase/migrations').glob('*.sql'))
assert run('SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;').splitlines()==versions
print(f'PASS: exact {len(versions)}-migration ledger')
run("""
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['control_policy_drafts','control_policy_history'] LOOP
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid=('public.'||t)::regclass) THEN RAISE EXCEPTION 'RLS missing'; END IF;
  IF has_table_privilege('authenticated','public.'||t,'INSERT,UPDATE,DELETE') OR has_table_privilege('anon','public.'||t,'SELECT,INSERT,UPDATE,DELETE') THEN RAISE EXCEPTION 'Unsafe ACL'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=('public.'||t)::regclass AND confrelid='public.shop_locations'::regclass AND array_length(conkey,1)=2 AND confdeltype='a') THEN RAISE EXCEPTION 'Location constraint missing'; END IF;
 END LOOP;
 IF has_function_privilege('anon','public.save_control_policy_draft(uuid,integer,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'Anonymous mutation'; END IF;
END $$;
BEGIN;
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES('00000000-0000-4000-8000-000000000081','policy-owner@example.test',now());
INSERT INTO public.shops(id,owner_id,name) VALUES('00000000-0000-4000-8000-000000000082','00000000-0000-4000-8000-000000000081','Synthetic policy probe');
CREATE FUNCTION pg_temp.reject_policy_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test history failure'; END $$;
CREATE TRIGGER test_history_failure BEFORE INSERT ON public.control_policy_history FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_policy_history();
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000081',true);
DO $$ DECLARE draft jsonb; BEGIN
 SELECT definition INTO draft FROM public.control_policy_drafts WHERE shop_id='00000000-0000-4000-8000-000000000082';
 BEGIN
  PERFORM public.save_control_policy_draft('00000000-0000-4000-8000-000000000082',1,jsonb_set(draft,'{enabled}','false'));
  RAISE EXCEPTION 'Expected history failure';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'test history failure' THEN RAISE; END IF; END;
 IF NOT EXISTS(SELECT 1 FROM public.control_policy_drafts WHERE shop_id='00000000-0000-4000-8000-000000000082' AND revision=1 AND definition=draft) THEN RAISE EXCEPTION 'Draft changed without audit'; END IF;
 IF (SELECT count(*) FROM public.control_policy_history WHERE shop_id='00000000-0000-4000-8000-000000000082')<>1 THEN RAISE EXCEPTION 'Partial audit'; END IF;
END $$;
RESET ROLE;
DROP TRIGGER test_history_failure ON public.control_policy_history;
CREATE FUNCTION pg_temp.reject_draft_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test draft failure'; END $$;
CREATE TRIGGER test_draft_failure BEFORE UPDATE ON public.control_policy_drafts FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_draft_update();
SET LOCAL ROLE authenticated;
DO $$ DECLARE draft jsonb; BEGIN
 SELECT definition INTO draft FROM public.control_policy_drafts WHERE shop_id='00000000-0000-4000-8000-000000000082';
 BEGIN
  PERFORM public.save_control_policy_draft('00000000-0000-4000-8000-000000000082',1,jsonb_set(draft,'{enabled}','false'));
  RAISE EXCEPTION 'Expected draft failure';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'test draft failure' THEN RAISE; END IF; END;
 IF (SELECT count(*) FROM public.control_policy_history WHERE shop_id='00000000-0000-4000-8000-000000000082')<>1 THEN RAISE EXCEPTION 'Orphaned history revision'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.control_policy_drafts WHERE shop_id='00000000-0000-4000-8000-000000000082' AND revision=1 AND definition=draft) THEN RAISE EXCEPTION 'Draft partially changed'; END IF;
END $$;
ROLLBACK;
""")
print('PASS: owner-only table ACLs; RLS; two composite location constraints; history failure and subsequent draft-update failure both roll back atomically; synthetic probe rolled back')
# Simulate the 70->71 upgrade transactionally on this disposable database only.
# Rollback restores the original schema/data after proving existing shop backfill.
migration=(root/'supabase/migrations/20260924120000_control_policy_drafts.sql').read_text().removeprefix('BEGIN;').removesuffix('COMMIT;\n')
run("""
BEGIN;
DROP TRIGGER control_initialize_draft ON public.shop_locations;
DROP FUNCTION public.save_control_policy_draft(uuid,integer,jsonb);
DROP TABLE public.control_policy_history,public.control_policy_drafts;
DROP FUNCTION public.control_initialize_draft(),public.control_validate_draft(jsonb);
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES('00000000-0000-4000-8000-000000000091','policy-upgrade@example.test',now());
INSERT INTO public.shops(id,owner_id,name) VALUES('00000000-0000-4000-8000-000000000092','00000000-0000-4000-8000-000000000091','Synthetic upgrade shop');
CREATE TEMP TABLE original_shop AS SELECT to_jsonb(s) AS value FROM public.shops s WHERE id='00000000-0000-4000-8000-000000000092';
"""+migration+"""
DO $$ BEGIN
 IF (SELECT value FROM original_shop) IS DISTINCT FROM (SELECT to_jsonb(s) FROM public.shops s WHERE id='00000000-0000-4000-8000-000000000092') THEN RAISE EXCEPTION 'Existing shop changed'; END IF;
 IF (SELECT count(*) FROM public.control_policy_drafts WHERE shop_id='00000000-0000-4000-8000-000000000092' AND revision=1)<>1 THEN RAISE EXCEPTION 'Draft backfill missing'; END IF;
 IF (SELECT count(*) FROM public.control_policy_history WHERE shop_id='00000000-0000-4000-8000-000000000092' AND revision=1 AND actor_id='00000000-0000-4000-8000-000000000091')<>1 THEN RAISE EXCEPTION 'History backfill missing'; END IF;
END $$;
ROLLBACK;
""")
print('PASS: transactional 70->71 backfill; existing shop row unchanged; exactly one baseline draft/history; probe rolled back')
