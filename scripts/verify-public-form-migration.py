"""Read catalog and prove rollback only on the dedicated unlinked form test DB."""
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent.parent
config = root / '.local-tools/public-form/supabase'
assert 'project_id = "gradia-public-form-tests"' in (config / 'config.toml').read_text()
assert 'port = 57331' in (config / 'config.toml').read_text()
assert not (config / '.temp/project-ref').exists()

def sql(query):
    result = subprocess.run(['docker', 'exec', '-i', 'supabase_db_gradia-public-form-tests', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'], input=query, text=True, capture_output=True)
    assert result.returncode == 0, 'Disposable probe failed; output withheld'
    return result.stdout.strip()

versions = sorted(p.name.split('_')[0] for p in (root / 'supabase/migrations').glob('*.sql'))
assert sql('SELECT version FROM supabase_migrations.schema_migrations ORDER BY version').splitlines() == versions
assert sql("SELECT relrowsecurity FROM pg_class WHERE oid='public.public_intake_forms'::regclass") == 't'
for role in ['anon', 'authenticated', 'service_role']:
    assert sql(f"SELECT has_table_privilege('{role}','public.public_intake_forms','SELECT,INSERT,UPDATE,DELETE')") == 'f'
functions = {
    'configure_public_intake_form(uuid,uuid,text,boolean,integer)': 'authenticated',
    'list_public_intake_forms(uuid)': 'authenticated',
    'public_intake_form_origin(uuid,text)': 'service_role',
    'submit_public_intake_form(uuid,text,uuid,jsonb)': 'service_role',
}
for function, permitted in functions.items():
    for role in ['anon', 'authenticated', 'service_role']:
        assert sql(f"SELECT has_function_privilege('{role}','public.{function}','EXECUTE')") == ('t' if role == permitted else 'f')
    assert sql(f"SELECT prosecdef AND proconfig @> ARRAY['search_path=\"\"'] FROM pg_proc WHERE oid='public.{function}'::regprocedure") == 't'
assert sql("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.public_intake_forms'::regclass AND contype='f' ORDER BY conname").splitlines() == sorted([
    'FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL',
    'FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE',
    'FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL',
])
# The induced error occurs after workflow insertion, proving the entire new
# command rolls back and a caller can safely retry after an unsuccessful write.
sql("""
BEGIN;
INSERT INTO auth.users(id) VALUES('00000000-0000-4000-8000-000000000011');
INSERT INTO public.shops(id,owner_id,name) VALUES('00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000011','Synthetic public form rollback');
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000011',true);
SELECT public.configure_public_intake_form('00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000013','https://fixture.example.test',true,0);
CREATE FUNCTION public.test_public_form_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic intake failure'; END $$;
CREATE TRIGGER test_public_form_failure BEFORE INSERT ON public.lead_intake_envelopes FOR EACH ROW EXECUTE FUNCTION public.test_public_form_failure();
DO $$ BEGIN
 BEGIN
  PERFORM public.submit_public_intake_form('00000000-0000-4000-8000-000000000013','https://fixture.example.test','00000000-0000-4000-8000-000000000014','{"email":"fixture@example.test"}');
  RAISE EXCEPTION 'Expected refusal';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM <> 'Synthetic intake failure' THEN RAISE; END IF;
 END;
 IF EXISTS(SELECT 1 FROM public.lead_workflows WHERE shop_id='00000000-0000-4000-8000-000000000012') THEN RAISE EXCEPTION 'Partial workflow'; END IF;
 IF EXISTS(SELECT 1 FROM public.lead_intake_envelopes WHERE shop_id='00000000-0000-4000-8000-000000000012') THEN RAISE EXCEPTION 'Partial envelope'; END IF;
END $$;
ROLLBACK;
""")
print(f'PASS: exact {len(versions)} migrations; form RLS/ACLs, fixed-path authority, three relationships and atomic intake rollback')
