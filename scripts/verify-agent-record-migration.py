"""Disposable-only record command ACL, exact ledger and late-failure rollback probe."""
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
fresh = sys.argv[1:] == ['--fresh']
assert sys.argv[1:] in ([], ['--fresh'])
project = 'gradia-record-fresh' if fresh else 'gradia-isolated-tests'
config = root / ('.local-tools/record-fresh/supabase/config.toml' if fresh else 'tests/supabase/config.toml')
assert f'project_id = "{project}"' in config.read_text()
work = root / ('.local-tools/record-fresh' if fresh else '.local-tools/supabase-test')
assert not (work / 'supabase/.temp/project-ref').exists()

def run(sql):
    result = subprocess.run(['docker', 'exec', '-i', f'supabase_db_{project}', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'], input=sql, text=True, capture_output=True)
    if result.returncode:
        raise SystemExit('FAIL: disposable record probe failed; raw database output withheld')
    return result.stdout.strip()

versions = sorted(p.name.split('_')[0] for p in (root / 'supabase/migrations').glob('*.sql'))
assert run('SELECT version FROM supabase_migrations.schema_migrations ORDER BY version').splitlines() == versions
run("""
DO $$ BEGIN
 IF has_function_privilege('anon','public.stage_agent_capture(uuid,uuid,uuid,text,jsonb,text,uuid)','EXECUTE')
 OR has_function_privilege('authenticated','public.control_apply_record(uuid,uuid,uuid,text,jsonb)','EXECUTE')
 OR has_function_privilege('service_role','public.control_apply_record(uuid,uuid,uuid,text,jsonb)','EXECUTE')
 THEN RAISE EXCEPTION 'Unsafe record authority'; END IF;
END $$;
BEGIN;
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES('00000000-0000-4000-8000-000000000701','record-probe@example.test',now());
INSERT INTO public.shops(id,owner_id,name) VALUES('00000000-0000-4000-8000-000000000702','00000000-0000-4000-8000-000000000701','Fictional record probe');
INSERT INTO public.customers(id,shop_id,name,email) VALUES('00000000-0000-4000-8000-000000000703','00000000-0000-4000-8000-000000000702','Fictional customer','before@example.test');
CREATE TEMP TABLE before_customer AS SELECT to_jsonb(c) AS value FROM public.customers c WHERE id='00000000-0000-4000-8000-000000000703';
INSERT INTO public.pending_actions(id,shop_id,requested_by,action_type,payload)
SELECT '00000000-0000-4000-8000-000000000704','00000000-0000-4000-8000-000000000702','00000000-0000-4000-8000-000000000701','update_customer',jsonb_build_object('customer_id',id,'before',jsonb_build_object('name',name,'phone',phone,'email',email),'expected_updated_at',updated_at,'changes',jsonb_build_object('email','after@example.test'),'vehicle',null) FROM public.customers WHERE id='00000000-0000-4000-8000-000000000703';
CREATE FUNCTION pg_temp.reject_final_record_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic final-claim failure'; END $$;
CREATE TRIGGER test_record_claim_failure BEFORE UPDATE ON public.pending_actions FOR EACH ROW WHEN (NEW.id='00000000-0000-4000-8000-000000000704') EXECUTE FUNCTION pg_temp.reject_final_record_claim();
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000701',true);
SELECT set_config('request.jwt.claim.role','authenticated',true);
DO $$ BEGIN
 BEGIN
  PERFORM public.claim_control_action('00000000-0000-4000-8000-000000000702','00000000-0000-4000-8000-000000000704','00000000-0000-4000-8000-000000000701','hitl');
  RAISE EXCEPTION 'Expected synthetic failure';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'Synthetic final-claim failure' THEN RAISE; END IF; END;
END $$;
RESET ROLE;
DO $$ BEGIN
 IF (SELECT value FROM before_customer) IS DISTINCT FROM (SELECT to_jsonb(c) FROM public.customers c WHERE id='00000000-0000-4000-8000-000000000703') THEN RAISE EXCEPTION 'Partial record edit survived'; END IF;
 IF EXISTS(SELECT 1 FROM public.control_execution_decisions WHERE action_id='00000000-0000-4000-8000-000000000704') THEN RAISE EXCEPTION 'Partial decision audit survived'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.pending_actions WHERE id='00000000-0000-4000-8000-000000000704' AND status='pending' AND result_id IS NULL) THEN RAISE EXCEPTION 'Partial claim survived'; END IF;
END $$;
DROP TRIGGER test_record_claim_failure ON public.pending_actions;
SET LOCAL ROLE authenticated;
SELECT public.claim_control_action('00000000-0000-4000-8000-000000000702','00000000-0000-4000-8000-000000000704','00000000-0000-4000-8000-000000000701','hitl');
RESET ROLE;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.customers WHERE id='00000000-0000-4000-8000-000000000703' AND email='after@example.test') THEN RAISE EXCEPTION 'Record edit did not commit'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.pending_actions WHERE id='00000000-0000-4000-8000-000000000704' AND status='approved' AND result_id='00000000-0000-4000-8000-000000000703') THEN RAISE EXCEPTION 'Claim result missing'; END IF;
END $$;
ROLLBACK;
""")
print(f'PASS: {project}; exact {len(versions)} migrations; internal writer inaccessible; final-claim failure rolls back domain edit, audit and claim; successful command commits all; synthetic fixtures rolled back')
