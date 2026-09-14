"""Prove the lowercase migration refuses inconsistent synthetic data, without repair."""
from pathlib import Path
import os
import subprocess
root = Path(__file__).resolve().parent.parent
assert 'project_id = "gradia-isolated-tests"' in (root / 'tests/supabase/config.toml').read_text()
assert not (root / '.local-tools/supabase-test/supabase/.temp/project-ref').exists()
body = (root / 'supabase/migrations/20260910101000_canonical_photo_identifiers.sql').read_text().replace('BEGIN;', '').replace('COMMIT;', '')
setup = r'''
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO auth.users(id) VALUES('00000000-0000-4000-8000-000000000001');
INSERT INTO public.shops(id,owner_id,name) VALUES('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','Synthetic photo refusal');
ALTER TABLE public.appointments DROP CONSTRAINT appointments_before_photo_scope;
INSERT INTO public.appointments(id,shop_id,scheduled_at,photos_before) VALUES('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002',now(),ARRAY['00000000-0000-4000-8000-000000000002/00000000-0000-4000-8000-000000000003/before-AAAAAAAA-1234-4234-9234-123456789abc.jpg']);
ALTER TABLE public.appointments ADD CONSTRAINT appointments_before_photo_scope CHECK(true);
CREATE TEMP TABLE original_photos AS SELECT id,photos_before FROM public.appointments;
CREATE TEMP TABLE original_constraints AS SELECT oid FROM pg_constraint;
SAVEPOINT before_migration;
\set ON_ERROR_STOP off
'''
finish = r'''
\if :ERROR
ROLLBACK TO SAVEPOINT before_migration;
\else
ROLLBACK;
\quit 1
\endif
\set ON_ERROR_STOP on
DO $$ BEGIN
 IF EXISTS(SELECT * FROM original_photos EXCEPT SELECT id,photos_before FROM public.appointments) THEN RAISE EXCEPTION 'Photos changed'; END IF;
 IF EXISTS(SELECT oid FROM original_constraints EXCEPT SELECT oid FROM pg_constraint) THEN RAISE EXCEPTION 'Constraint identity changed'; END IF;
END $$;
ROLLBACK;
'''
r = subprocess.run(['docker','exec','-i','supabase_db_gradia-isolated-tests','psql','-X','-U','postgres','-d','postgres','-At'], input=setup+body+finish, text=True, capture_output=True, env={'PATH':os.environ['PATH'],'DOCKER_HOST':'unix:///var/run/docker.sock'})
if r.returncode or 'check constraint "appointments_before_photo_scope"' not in r.stderr:
    raise SystemExit('FAIL: disposable photo migration refusal probe failed; no database output printed')
print('PASS: uppercase stored photo migration refused; data and original constraints preserved; fixture rolled back')
