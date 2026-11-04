"""Disposable-only upgrade probe for the commercial usage recognition migration.

Resets the unlinked gradia-isolated-tests stack to the migration immediately BEFORE
20261104130000, seeds fictional legacy usage_events rows, applies the new migration
as a normal upgrade, then proves:
  * no existing usage_events row was rewritten (content, xmin and physical position),
  * the evidence tables are append-only for every role including the table owner,
  * function and table ACLs match the intended authority model.
It never targets a linked or shared project and prints no credential-bearing output.
"""
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
project = 'gradia-isolated-tests'
config = root / 'tests/supabase/config.toml'
assert f'project_id = "{project}"' in config.read_text() and 'env(' not in config.read_text()
work = root / '.local-tools/supabase-test'
assert (work / 'supabase/config.toml').exists(), 'run: node scripts/test-stack.mjs start'
assert not (work / 'supabase/.temp/project-ref').exists(), 'remote links forbidden'
env = {'PATH': __import__('os').environ['PATH'], 'HOME': __import__('os').environ['HOME'], 'DOCKER_HOST': 'unix:///var/run/docker.sock'}

NEW = '20261104130000'
versions = sorted(p.name.split('_')[0] for p in (root / 'supabase/migrations').glob('*.sql'))
assert NEW in versions
previous = versions[versions.index(NEW) - 1]


def cli(*args):
    result = subprocess.run(['supabase', '--workdir', str(work), *args], capture_output=True, text=True, env=env)
    if result.returncode:
        raise SystemExit(f'FAIL: supabase {args[0]} {args[1]} failed; raw output withheld')
    return result.stdout + result.stderr


def psql(sql):
    result = subprocess.run(
        ['docker', 'exec', '-i', f'supabase_db_{project}', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'],
        input=sql, text=True, capture_output=True, env=env)
    if result.returncode:
        raise SystemExit('FAIL: disposable probe failed; raw database output withheld\n' + result.stderr.splitlines()[-1][:200] if result.stderr else 'FAIL')
    return result.stdout.strip()


# 1. Upgrade path: stop at the previous migration and seed the legacy ledger.
cli('db', 'reset', '--local', '--no-seed', '--version', previous)
assert psql("SELECT max(version) FROM supabase_migrations.schema_migrations") == previous
assert psql("SELECT to_regclass('public.commercial_usage_recognitions') IS NULL") == 't'
psql("""
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES('00000000-0000-4000-8000-000000000a01','commercial-probe@example.test',now());
INSERT INTO public.shops(id,owner_id,name) VALUES('00000000-0000-4000-8000-000000000a02','00000000-0000-4000-8000-000000000a01','Fictional commercial probe');
INSERT INTO public.usage_events(id,shop_id,kind,quantity,credits,vendor_ref,wholesale_cost,retail_cost,ref_id) VALUES
 ('00000000-0000-4000-8000-000000000b01','00000000-0000-4000-8000-000000000a02','voice_minute',7,0,'legacy-call-1',84,175,'legacy-call-1'),
 ('00000000-0000-4000-8000-000000000b02','00000000-0000-4000-8000-000000000a02','sms_segment',2,8,'legacy-sms-1',2.4,8,'legacy-sms-1'),
 ('00000000-0000-4000-8000-000000000b03','00000000-0000-4000-8000-000000000a02','agent_run',1,1,NULL,NULL,NULL,NULL),
 ('00000000-0000-4000-8000-000000000b04','00000000-0000-4000-8000-000000000a02','inbound_classify',1,0,'legacy-classify-1',0.2,0,NULL);
""")
snapshot = """SELECT count(*) || ':' || md5(string_agg(to_jsonb(u)::text || ':' || u.xmin::text || ':' || u.ctid::text, '|' ORDER BY u.id)) FROM public.usage_events u"""
before = psql(snapshot)
assert before.startswith('4:')

# 2. Apply exactly the new migration.
cli('migration', 'up', '--local')
assert psql("SELECT max(version) FROM supabase_migrations.schema_migrations") == versions[-1]
assert psql("SELECT to_regclass('public.commercial_usage_recognitions') IS NOT NULL") == 't'
after = psql(snapshot)
assert after == before, 'usage_events rows were rewritten by the upgrade'
assert psql("SELECT count(*) FROM public.commercial_usage_recognitions") == '0'
assert psql("SELECT count(*) FROM public.commercial_usage_corrections") == '0'

# 3. Authority model, evidence immutability and ACLs.
psql("""
DO $$
DECLARE r text;
BEGIN
 -- Table and function ACLs.
 IF has_function_privilege('anon','public.commercial_recognize_usage(uuid,text,text,numeric,text,text,uuid,text,numeric,text,jsonb,timestamptz,text)','EXECUTE')
  OR has_function_privilege('authenticated','public.commercial_recognize_usage(uuid,text,text,numeric,text,text,uuid,text,numeric,text,jsonb,timestamptz,text)','EXECUTE')
  OR has_function_privilege('anon','public.commercial_correct_usage(uuid,uuid,numeric,text,text,text)','EXECUTE')
  OR has_function_privilege('authenticated','public.commercial_correct_usage(uuid,uuid,numeric,text,text,text)','EXECUTE')
  OR has_function_privilege('anon','public.commercial_usage_read(uuid,timestamptz,timestamptz,timestamptz)','EXECUTE')
  OR has_function_privilege('anon','public.commercial_is_active_owner(uuid)','EXECUTE')
  OR has_function_privilege('authenticated','public.commercial_is_active_owner(uuid)','EXECUTE')
 THEN RAISE EXCEPTION 'Unsafe function authority'; END IF;
 IF NOT has_function_privilege('service_role','public.commercial_recognize_usage(uuid,text,text,numeric,text,text,uuid,text,numeric,text,jsonb,timestamptz,text)','EXECUTE')
  OR NOT has_function_privilege('service_role','public.commercial_correct_usage(uuid,uuid,numeric,text,text,text)','EXECUTE')
  OR NOT has_function_privilege('authenticated','public.commercial_usage_read(uuid,timestamptz,timestamptz,timestamptz)','EXECUTE')
 THEN RAISE EXCEPTION 'Missing intended function authority'; END IF;
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF has_table_privilege(r,'public.commercial_usage_recognitions','INSERT')
   OR has_table_privilege(r,'public.commercial_usage_recognitions','UPDATE')
   OR has_table_privilege(r,'public.commercial_usage_recognitions','DELETE')
   OR has_table_privilege(r,'public.commercial_usage_recognitions','TRUNCATE')
   OR has_table_privilege(r,'public.commercial_usage_corrections','INSERT')
   OR has_table_privilege(r,'public.commercial_usage_corrections','UPDATE')
   OR has_table_privilege(r,'public.commercial_usage_corrections','DELETE')
   OR has_table_privilege(r,'public.commercial_usage_corrections','TRUNCATE')
   OR has_table_privilege(r,'public.commercial_catalog_versions','INSERT')
  THEN RAISE EXCEPTION 'Unsafe table write privilege for %', r; END IF;
 END LOOP;
 IF has_table_privilege('anon','public.commercial_usage_recognitions','SELECT')
  OR has_table_privilege('authenticated','public.commercial_usage_recognitions','SELECT')
  OR has_table_privilege('authenticated','public.commercial_usage_corrections','SELECT')
 THEN RAISE EXCEPTION 'Browser roles must not read evidence tables directly'; END IF;
END $$;
""")

# 4. Even the table owner cannot edit, delete or truncate recognized facts.
psql("""
BEGIN;
INSERT INTO public.commercial_usage_recognitions(id,shop_id,catalog_version,metric,quantity,source_kind,source_ref,source_usage_event_id,evidence,recognized_at,idempotency_key)
VALUES('00000000-0000-4000-8000-000000000c01','00000000-0000-4000-8000-000000000a02','2026-11-03.v1','inbound_voice_agent_minute',7,'usage_event','legacy-call-1','00000000-0000-4000-8000-000000000b01','{"direction":"inbound"}','2026-10-15T00:00:00Z','probe.recognition.0000000000000001');
INSERT INTO public.commercial_usage_corrections(id,shop_id,recognition_id,quantity,reason,idempotency_key)
VALUES('00000000-0000-4000-8000-000000000d01','00000000-0000-4000-8000-000000000a02','00000000-0000-4000-8000-000000000c01',1,'duplicate','probe.correction.0000000000000001');
DO $$
DECLARE blocked integer := 0;
BEGIN
 BEGIN UPDATE public.commercial_usage_recognitions SET quantity = 1; EXCEPTION WHEN insufficient_privilege THEN blocked := blocked + 1; END;
 BEGIN DELETE FROM public.commercial_usage_recognitions; EXCEPTION WHEN insufficient_privilege THEN blocked := blocked + 1; END;
 BEGIN TRUNCATE public.commercial_usage_recognitions CASCADE; EXCEPTION WHEN insufficient_privilege THEN blocked := blocked + 1; END;
 BEGIN UPDATE public.commercial_usage_corrections SET quantity = 1; EXCEPTION WHEN insufficient_privilege THEN blocked := blocked + 1; END;
 BEGIN DELETE FROM public.commercial_usage_corrections; EXCEPTION WHEN insufficient_privilege THEN blocked := blocked + 1; END;
 BEGIN UPDATE public.commercial_catalog_versions SET version = '2099-01-01.v1'; EXCEPTION WHEN insufficient_privilege THEN blocked := blocked + 1; END;
 BEGIN DELETE FROM public.usage_events WHERE id = '00000000-0000-4000-8000-000000000b01'; EXCEPTION WHEN foreign_key_violation THEN blocked := blocked + 1; END;
 IF blocked <> 7 THEN RAISE EXCEPTION 'Append-only guard let % of 7 probes through', 7 - blocked; END IF;
END $$;
-- Deleting the whole shop is the tenant-deletion contract and removes everything.
DELETE FROM public.shops WHERE id = '00000000-0000-4000-8000-000000000a02';
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM public.commercial_usage_recognitions) OR EXISTS (SELECT 1 FROM public.commercial_usage_corrections)
  OR EXISTS (SELECT 1 FROM public.usage_events WHERE shop_id = '00000000-0000-4000-8000-000000000a02')
 THEN RAISE EXCEPTION 'Tenant deletion left evidence behind'; END IF;
END $$;
ROLLBACK;
""")
# The probe's fictional rows are removed; restore the stack to the exact main-plus-PR schema.
psql("DELETE FROM public.shops WHERE id = '00000000-0000-4000-8000-000000000a02'; DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-000000000a01';")

print(
    f'PASS: upgraded {previous} -> {versions[-1]}; 4 legacy usage_events rows unchanged '
    '(content, xmin and ctid); evidence tables append-only for every role including the owner; '
    'writers service-only; browser roles have no table or writer access; tenant deletion contract holds'
)
