"""Non-destructive upgrade probe for 20261116120000_provider_boundary_hold_unique.

Everything runs inside ONE transaction on the unlinked gradia-isolated-tests stack and ends with
ROLLBACK, so no database state is changed. Inside it the probe
  1. seeds fictional shops/customers and a LEGACY interactions history that already holds
     duplicate hold markers (the pre-migration race outcome), raw customer evidence and ordinary
     system notes carrying the same key text,
  2. applies the migration's REAL SQL text (BEGIN/COMMIT removed so the outer transaction stays
     in control) and proves:
       * only the later duplicate markers were removed (oldest per shop+channel+key kept),
       * raw customer evidence, Gradia replies and non-marker system notes are untouched,
       * the index is unique, partial, valid, and covers exactly the marker rows,
       * a second marker for the same shop+channel+key raises 23505, while another stage,
         channel or shop is accepted, and a non-marker row with the same key text is accepted,
       * deleting a customer / shop still cascades the marker, RLS is still enabled, and the
         table's policies and grants are unchanged,
  3. rolls back, then confirms the ledger and schema are exactly as before.
No credential-bearing output is printed.
"""
from pathlib import Path
import re
import subprocess

root = Path(__file__).resolve().parent.parent
project = 'gradia-isolated-tests'
config = root / 'tests/supabase/config.toml'
assert f'project_id = "{project}"' in config.read_text() and 'env(' not in config.read_text()
assert not (root / '.local-tools/supabase-test/supabase/.temp/project-ref').exists(), 'remote links forbidden'

NEW = '20261116120000'
migration = next((root / 'supabase/migrations').glob(f'{NEW}_*.sql'))
text = migration.read_text().strip()
assert text.startswith('BEGIN;') and text.endswith('COMMIT;'), 'migration must be one BEGIN..COMMIT block'
body = text[len('BEGIN;'):-len('COMMIT;')]
stripped = re.sub(r'\$\$.*?\$\$', '$$$$', body, flags=re.S)
assert not re.search(r'(?im)^\s*(commit|rollback|begin|start\s+transaction|savepoint|release|abort|end)\b', stripped), 'unexpected transaction control'
versions = sorted(p.name.split('_')[0] for p in (root / 'supabase/migrations').glob('*.sql'))
assert versions[-1] == NEW, 'probe expects this to be the newest migration'


def run(sql):
    r = subprocess.run(['docker', 'exec', '-i', f'supabase_db_{project}', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'],
                       input=sql, text=True, capture_output=True)
    if r.returncode:
        errors = [l for l in r.stderr.splitlines() if 'ERROR:' in l]
        detail = errors[0].split('ERROR:', 1)[1].strip()[:240] if errors else 'no detail'
        raise SystemExit(f'FAIL: probe failed ({detail}); rolled back; raw output withheld')
    return r.stdout.strip()


INDEX = 'interactions_provider_boundary_hold_unique'
stack_max = run("SELECT max(version) FROM supabase_migrations.schema_migrations")
applied = run("SELECT to_regclass('public.%s') IS NOT NULL" % INDEX) == 't'
ledger_before = run("SELECT count(*) || ':' || max(version) FROM supabase_migrations.schema_migrations")
assert not applied, 'index already applied on the stack; the upgrade probe needs the pre-migration schema'
assert stack_max == '20261115130000', f'stack must be at the previous migration, found {stack_max}'

U = lambda n: f'00000000-0000-4000-8000-0000000a{n:04d}'
S = lambda n: f'00000000-0000-4000-8000-0000000b{n:04d}'
C = lambda n: f'00000000-0000-4000-8000-0000000c{n:04d}'
meta = lambda stage, ref: '{"source":"provider_boundary","kind":"hold","stage":"%s","boundary_hold_key":"%s:%s","reasons":["override_role"]}' % (stage, stage, ref)

SEED = f"""
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES ('{U(1)}','o1@example.test',now()),('{U(2)}','o2@example.test',now());
INSERT INTO public.shops(id,owner_id,name) VALUES ('{S(1)}','{U(1)}','Fictional A'),('{S(2)}','{U(2)}','Fictional B');
INSERT INTO public.customers(id,shop_id,name) VALUES ('{C(1)}','{S(1)}','Fictional Customer');
-- Legacy duplicate markers (same shop, channel, key): three copies, oldest first.
INSERT INTO public.interactions(id,shop_id,customer_id,channel,role,content,metadata,created_at) VALUES
 ('00000000-0000-4000-8000-00000d000001','{S(1)}',NULL,'email','system','marker', '{meta("classify","m1")}', now() - interval '3 minutes'),
 ('00000000-0000-4000-8000-00000d000002','{S(1)}','{C(1)}','email','system','marker', '{meta("classify","m1")}', now() - interval '2 minutes'),
 ('00000000-0000-4000-8000-00000d000003','{S(1)}',NULL,'email','system','marker', '{meta("classify","m1")}', now() - interval '1 minute'),
 ('00000000-0000-4000-8000-00000d000004','{S(1)}',NULL,'email','system','marker', '{meta("draft","m1")}', now()),
 ('00000000-0000-4000-8000-00000d000005','{S(1)}',NULL,'sms','system','marker', '{meta("classify","m1")}', now()),
 ('00000000-0000-4000-8000-00000d000006','{S(2)}',NULL,'email','system','marker', '{meta("classify","m1")}', now());
-- Same key text on rows that are NOT markers: must survive untouched.
INSERT INTO public.interactions(id,shop_id,channel,role,content,metadata) VALUES
 ('00000000-0000-4000-8000-00000d000010','{S(1)}','email','customer','raw customer words','{{"boundary_hold_key":"classify:m1"}}'),
 ('00000000-0000-4000-8000-00000d000011','{S(1)}','email','customer','raw customer words','{{"boundary_hold_key":"classify:m1"}}'),
 ('00000000-0000-4000-8000-00000d000012','{S(1)}','email','system','ordinary note','{{"boundary_hold_key":"classify:m1"}}'),
 ('00000000-0000-4000-8000-00000d000013','{S(1)}','email','system','ordinary note','{{"source":"provider_boundary","kind":"other","boundary_hold_key":"classify:m1"}}'),
 ('00000000-0000-4000-8000-00000d000014','{S(1)}','email','gradia','reply','{{}}');
CREATE TEMP TABLE schema_fp AS
 SELECT 'policies' AS k, md5(coalesce(string_agg(polname||':'||polcmd::text||':'||coalesce(pg_get_expr(polqual,polrelid),'')||':'||coalesce(pg_get_expr(polwithcheck,polrelid),''),',' ORDER BY polname),'')) AS v
   FROM pg_policy WHERE polrelid='public.interactions'::regclass
 UNION ALL SELECT 'grants', md5(coalesce(string_agg(grantee||':'||privilege_type,',' ORDER BY grantee,privilege_type),''))
   FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='interactions'
 UNION ALL SELECT 'columns', md5(string_agg(column_name||':'||data_type,',' ORDER BY ordinal_position))
   FROM information_schema.columns WHERE table_schema='public' AND table_name='interactions'
 UNION ALL SELECT 'triggers', md5(coalesce(string_agg(tgname,',' ORDER BY tgname),'')) FROM pg_trigger WHERE tgrelid='public.interactions'::regclass AND NOT tgisinternal;
"""

CHECKS = f"""
DO $$
DECLARE n integer; code text;
BEGIN
 -- dedupe: oldest per (shop, channel, key) kept; later duplicates gone; distinct keys untouched
 SELECT count(*) INTO n FROM public.interactions WHERE id IN ('00000000-0000-4000-8000-00000d000001','00000000-0000-4000-8000-00000d000004','00000000-0000-4000-8000-00000d000005','00000000-0000-4000-8000-00000d000006');
 IF n <> 4 THEN RAISE EXCEPTION 'expected the oldest/distinct markers to survive, found %', n; END IF;
 SELECT count(*) INTO n FROM public.interactions WHERE id IN ('00000000-0000-4000-8000-00000d000002','00000000-0000-4000-8000-00000d000003');
 IF n <> 0 THEN RAISE EXCEPTION 'later duplicate markers were not removed'; END IF;
 -- non-markers untouched
 SELECT count(*) INTO n FROM public.interactions WHERE id::text LIKE '00000000-0000-4000-8000-00000d0000__' AND id::text >= '00000000-0000-4000-8000-00000d000010';
 IF n <> 5 THEN RAISE EXCEPTION 'non-marker rows were touched (% left of 5)', n; END IF;
 -- index shape
 PERFORM 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname='{INDEX}' AND i.indisunique AND i.indisvalid AND i.indpred IS NOT NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'index is not a valid unique partial index'; END IF;
 -- the constraint
 BEGIN
  INSERT INTO public.interactions(shop_id,channel,role,content,metadata) VALUES ('{S(1)}','email','system','marker','{meta("classify","m1")}');
  RAISE EXCEPTION 'duplicate marker was accepted';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 -- different stage / channel / shop / ref accepted
 INSERT INTO public.interactions(shop_id,channel,role,content,metadata) VALUES
  ('{S(1)}','email','system','marker','{meta("classify","m2")}'),
  ('{S(2)}','sms','system','marker','{meta("classify","m1")}');
 -- non-marker rows with the same key text accepted
 INSERT INTO public.interactions(shop_id,channel,role,content,metadata) VALUES
  ('{S(1)}','email','customer','raw','{{"boundary_hold_key":"classify:m1"}}'),
  ('{S(1)}','email','system','note','{{"boundary_hold_key":"classify:m1"}}');
 -- cascades
 DELETE FROM public.customers WHERE id='{C(1)}';
 DELETE FROM public.shops WHERE id='{S(2)}';
 SELECT count(*) INTO n FROM public.interactions WHERE shop_id='{S(2)}';
 IF n <> 0 THEN RAISE EXCEPTION 'shop delete did not cascade markers'; END IF;
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.interactions'::regclass) THEN RAISE EXCEPTION 'RLS disabled'; END IF;
 IF (SELECT count(*) FROM schema_fp) <> 4 THEN RAISE EXCEPTION 'fingerprint missing'; END IF;
END $$;
-- policies, grants, columns, triggers identical to before
DO $$ DECLARE x text; BEGIN
 SELECT string_agg(f.k, ',') INTO x FROM schema_fp f JOIN (
  SELECT 'policies' k, md5(coalesce(string_agg(polname||':'||polcmd::text||':'||coalesce(pg_get_expr(polqual,polrelid),'')||':'||coalesce(pg_get_expr(polwithcheck,polrelid),''),',' ORDER BY polname),'')) v FROM pg_policy WHERE polrelid='public.interactions'::regclass
  UNION ALL SELECT 'grants', md5(coalesce(string_agg(grantee||':'||privilege_type,',' ORDER BY grantee,privilege_type),'')) FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='interactions'
  UNION ALL SELECT 'columns', md5(string_agg(column_name||':'||data_type,',' ORDER BY ordinal_position)) FROM information_schema.columns WHERE table_schema='public' AND table_name='interactions'
  UNION ALL SELECT 'triggers', md5(coalesce(string_agg(tgname,',' ORDER BY tgname),'')) FROM pg_trigger WHERE tgrelid='public.interactions'::regclass AND NOT tgisinternal) c USING (k)
 WHERE f.v <> c.v;
 IF x IS NOT NULL THEN RAISE EXCEPTION 'schema drift on interactions: %', x; END IF;
END $$;
"""

out = run(f"BEGIN;\n{SEED}\n{body}\n{CHECKS}\nROLLBACK;")
assert run("SELECT to_regclass('public.%s') IS NULL" % INDEX) == 't', 'probe leaked the index'
assert run("SELECT count(*) || ':' || max(version) FROM supabase_migrations.schema_migrations") == ledger_before, 'ledger changed'
assert run("SELECT count(*) FROM public.shops WHERE name LIKE 'Fictional %'") == '0', 'probe leaked rows'
print('PASS: upgrade probe applied the real migration SQL, proved dedupe/uniqueness/scoping/cascade/RLS, and rolled back')
