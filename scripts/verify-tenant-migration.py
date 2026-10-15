"""Verify the explicit manifest and refusal atomically on synthetic local data only."""
from pathlib import Path
import os
import re
import subprocess
root = Path(__file__).resolve().parent.parent
assert 'project_id = "gradia-isolated-tests"' in (root / 'tests/supabase/config.toml').read_text()
assert not (root / '.local-tools/supabase-test/supabase/.temp/project-ref').exists()
env = {'PATH': os.environ['PATH'], 'DOCKER_HOST': 'unix:///var/run/docker.sock'}
command = ['docker','exec','-i','supabase_db_gradia-isolated-tests','psql','-X','-U','postgres','-d','postgres','-At']
def run(sql):
    return subprocess.run(command,input=sql,text=True,capture_output=True,env=env)
migration=(root/'supabase/migrations/20260909091000_tenant_relationships.sql').read_text()
manifest=re.findall(r'ALTER TABLE public\.(\w+) DROP CONSTRAINT (\w+), ADD CONSTRAINT \w+ (FOREIGN KEY[^;]+);',migration)
assert len(manifest)==26
catalog=run("SELECT conrelid::regclass,conname,pg_get_constraintdef(oid) FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace;")
assert catalog.returncode==0
actual={tuple(row.split('|')[:2]):row.split('|')[2] for row in catalog.stdout.splitlines()}
for child,name,definition in manifest:
    assert actual[(child,name)]==definition.replace('public.',''), (child,name)
print('PASS: all 26 explicit composite foreign keys match their complete reviewed definitions')
# A pre-existing corrupt quote is constructed only inside this rolled-back probe.
setup=r'''
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO auth.users(id) VALUES('00000000-0000-4000-8000-000000000001');
INSERT INTO public.shops(id,owner_id,name) VALUES
('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','Synthetic A'),
('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','Synthetic B');
INSERT INTO public.customers(id,shop_id) VALUES('00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000003');
ALTER TABLE public.quotes DROP CONSTRAINT quotes_customer_id_fkey;
INSERT INTO public.quotes(id,shop_id,customer_id) VALUES('00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000004');
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE public.quotes ADD CONSTRAINT quotes_customer_id_fkey FOREIGN KEY(customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;
CREATE TEMP TABLE before_constraints AS SELECT oid FROM pg_constraint WHERE connamespace='public'::regnamespace;
SAVEPOINT before_migration;
\set ON_ERROR_STOP off
'''
body=migration.replace('BEGIN;','').replace('COMMIT;','')
finish=r'''
\if :ERROR
ROLLBACK TO SAVEPOINT before_migration;
\else
ROLLBACK;
\quit 1
\endif
\set ON_ERROR_STOP on
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.quotes q JOIN public.customers c ON c.id=q.customer_id WHERE q.id='00000000-0000-4000-8000-000000000005' AND q.shop_id<>c.shop_id) THEN RAISE EXCEPTION 'Fixture was repaired'; END IF;
 IF EXISTS(SELECT oid FROM before_constraints EXCEPT SELECT oid FROM pg_constraint) THEN RAISE EXCEPTION 'DDL was not rolled back'; END IF;
END $$;
ROLLBACK;
'''
result=run(setup+body+finish)
if result.returncode or 'violates foreign key constraint "quotes_customer_id_fkey"' not in result.stderr:
    raise SystemExit('FAIL: disposable migration refusal verification failed: '+str(re.findall(r'ERROR: [^\n]+',result.stderr)[:2]))
print('PASS: explicit migration refuses mismatched quote; original rows and all prior constraints preserved after rollback')
