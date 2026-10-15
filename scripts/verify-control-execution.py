"""Disposable-only ledger, activation authority and audit rollback verification."""
from pathlib import Path
import subprocess
root = Path(__file__).resolve().parent.parent
assert 'project_id = "gradia-isolated-tests"' in (root/'tests/supabase/config.toml').read_text()
assert not (root/'.local-tools/supabase-test/supabase/.temp/project-ref').exists()
def run(sql):
    result = subprocess.run(['docker','exec','-i','supabase_db_gradia-isolated-tests','psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres'],input=sql,text=True,capture_output=True)
    if result.returncode: raise SystemExit('FAIL: disposable policy probe failed; raw database output withheld')
    return result.stdout.strip()
versions=sorted(p.name.split('_')[0] for p in (root/'supabase/migrations').glob('*.sql'))
assert run('SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;').splitlines()==versions
run("""
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['control_policy_active','control_policy_activations','control_execution_decisions'] LOOP
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid=('public.'||t)::regclass) OR has_table_privilege('authenticated','public.'||t,'INSERT,UPDATE,DELETE') OR has_table_privilege('anon','public.'||t,'SELECT,INSERT,UPDATE,DELETE') THEN RAISE EXCEPTION 'Unsafe policy ACL'; END IF;
 END LOOP;
 IF has_function_privilege('anon','public.claim_control_action(uuid,uuid,uuid,text)','EXECUTE') OR has_function_privilege('service_role','public.activate_control_policy(uuid,integer,integer)','EXECUTE') THEN RAISE EXCEPTION 'Unsafe RPC ACL'; END IF;
 IF (SELECT count(*) FROM pg_constraint WHERE conrelid IN ('public.control_policy_active'::regclass,'public.control_policy_activations'::regclass,'public.control_execution_decisions'::regclass) AND contype='f' AND cardinality(conkey)=2)<>6 THEN RAISE EXCEPTION 'Tenant relationship missing'; END IF;
END $$;
BEGIN;
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES('00000000-0000-4000-8000-000000000271','policy-probe@example.test',now());
INSERT INTO public.shops(id,owner_id,name) VALUES('00000000-0000-4000-8000-000000000272','00000000-0000-4000-8000-000000000271','Fictional authority probe');
INSERT INTO public.pending_actions(id,shop_id,requested_by,action_type,payload) VALUES('00000000-0000-4000-8000-000000000273','00000000-0000-4000-8000-000000000272','00000000-0000-4000-8000-000000000271','add_note','{"content":"Fictional"}');
CREATE FUNCTION pg_temp.reject_policy_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic policy failure'; END $$;
CREATE TRIGGER test_activation_failure BEFORE INSERT ON public.control_policy_active FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_policy_write();
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000271',true);
SELECT set_config('request.jwt.claim.role','authenticated',true);
DO $$ BEGIN
 BEGIN
  PERFORM public.activate_control_policy('00000000-0000-4000-8000-000000000272',1,NULL);
  RAISE EXCEPTION 'Expected failure';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'synthetic policy failure' THEN RAISE; END IF; END;
 IF EXISTS(SELECT 1 FROM public.control_policy_activations WHERE shop_id='00000000-0000-4000-8000-000000000272') THEN RAISE EXCEPTION 'Partial activation audit'; END IF;
END $$;
RESET ROLE;
DROP TRIGGER test_activation_failure ON public.control_policy_active;
CREATE TRIGGER test_decision_failure BEFORE INSERT ON public.control_execution_decisions FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_policy_write();
SET LOCAL ROLE authenticated;
SELECT public.activate_control_policy('00000000-0000-4000-8000-000000000272',1,NULL);
DO $$ BEGIN
 BEGIN
  PERFORM public.claim_control_action('00000000-0000-4000-8000-000000000272','00000000-0000-4000-8000-000000000273','00000000-0000-4000-8000-000000000271','hitl');
  RAISE EXCEPTION 'Expected failure';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'synthetic policy failure' THEN RAISE; END IF; END;
 IF NOT EXISTS(SELECT 1 FROM public.pending_actions WHERE id='00000000-0000-4000-8000-000000000273' AND status::text='pending' AND decided_at IS NULL) THEN RAISE EXCEPTION 'Claim survived failed audit'; END IF;
END $$;
ROLLBACK;
""")
print(f'PASS: exact {len(versions)} migrations; three RLS tables; RPC ACLs; six tenant relationships; activation/history and claim/audit rollback; synthetic fixtures rolled back')
