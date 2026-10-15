"""Local-only membership schema, ACL, verified-email and audit rollback probes."""
from pathlib import Path
import os
import subprocess

root = Path(__file__).resolve().parent.parent
assert 'project_id = "gradia-isolated-tests"' in (root / 'tests/supabase/config.toml').read_text()
assert not (root / '.local-tools/supabase-test/supabase/.temp/project-ref').exists()
command = ['docker', 'exec', '-i', 'supabase_db_gradia-isolated-tests', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-At']
def run(sql):
    result = subprocess.run(command, input=sql, text=True, capture_output=True,
                            env={'PATH': os.environ['PATH'], 'DOCKER_HOST': 'unix:///var/run/docker.sock'})
    if result.returncode:
        raise SystemExit('FAIL: disposable team probe failed; database output withheld')
    return result.stdout.strip()

versions = sorted(p.name.split('_')[0] for p in (root / 'supabase/migrations').glob('*.sql'))
actual = run('SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;').splitlines()
assert actual == versions, 'Migration ledger differs from repository'
print(f'PASS: exact {len(versions)}-migration ledger')
run("""
DO $$ DECLARE t text; f record; BEGIN
 FOREACH t IN ARRAY ARRAY['shop_memberships','shop_locations','shop_assignments','shop_invitations','shop_team_audit'] LOOP
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid=('public.'||t)::regclass) THEN RAISE EXCEPTION 'RLS missing'; END IF;
  IF has_table_privilege('authenticated','public.'||t,'INSERT,UPDATE,DELETE') OR has_table_privilege('anon','public.'||t,'SELECT,INSERT,UPDATE,DELETE') THEN RAISE EXCEPTION 'Unsafe table ACL'; END IF;
 END LOOP;
 FOR f IN SELECT oid,prosecdef,proconfig FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'team_%' LOOP
  IF NOT f.prosecdef OR NOT ('search_path=""'=ANY(f.proconfig)) OR has_function_privilege('anon',f.oid,'EXECUTE') THEN RAISE EXCEPTION 'Unsafe function definition'; END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_constraint WHERE conrelid='public.shop_assignments'::regclass AND contype='f' AND cardinality(conkey)=2)<>3 THEN RAISE EXCEPTION 'Composite references missing'; END IF;
END $$;
""")
print('PASS: five RLS tables; explicit mutation/anonymous denial; fixed-search-path RPCs; three composite assignment references')
run(r"""
BEGIN;
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES
 ('00000000-0000-4000-8000-000000000001','owner@example.test',now()),
 ('00000000-0000-4000-8000-000000000002','unverified@example.test',NULL);
INSERT INTO public.shops(id,owner_id,name) VALUES('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','Synthetic team probe');
INSERT INTO public.customers(id,shop_id,name) VALUES('00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000003','Fictional customer');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
SELECT set_config('team.test_token',public.team_invite('00000000-0000-4000-8000-000000000003','unverified@example.test','staff','{}','Fictional staff')->>'token',true);
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',true);
DO $$ BEGIN
 BEGIN
  PERFORM public.team_accept_invite(current_setting('team.test_token'));
  RAISE EXCEPTION 'Unverified account accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $$;
RESET ROLE;
UPDATE auth.users SET email_confirmed_at=now() WHERE id='00000000-0000-4000-8000-000000000002';
SET LOCAL ROLE authenticated;
SELECT public.team_accept_invite(current_setting('team.test_token'));
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
SELECT public.team_assign('00000000-0000-4000-8000-000000000003',(SELECT id FROM public.shop_memberships WHERE user_id='00000000-0000-4000-8000-000000000002'),'00000000-0000-4000-8000-000000000004');
RESET ROLE;
CREATE FUNCTION pg_temp.reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test audit failure'; END $$;
CREATE TRIGGER test_audit_failure BEFORE INSERT ON public.shop_team_audit FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_audit();
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',true);
DO $$ BEGIN
 BEGIN
  PERFORM public.team_add_note('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004','Synthetic rollback note');
  RAISE EXCEPTION 'Audit failure did not abort';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM<>'test audit failure' THEN RAISE; END IF;
 END;
 IF EXISTS(SELECT 1 FROM public.interactions WHERE shop_id='00000000-0000-4000-8000-000000000003') THEN RAISE EXCEPTION 'Note did not roll back'; END IF;
END $$;
ROLLBACK;
""")
print('PASS: unverified email refused; verified acceptance succeeds; audit failure rolls back note; all probe fixtures rolled back')
