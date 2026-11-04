"""Non-destructive upgrade probe for the membership billing history migration (PR B).

Everything runs inside ONE transaction on the unlinked gradia-isolated-tests stack and
ends with ROLLBACK, so no database state is ever changed or destroyed. Inside it the probe
  1. removes exactly the objects 20261104140000 created, which restores the schema the
     previous migration left behind (this migration adds objects only; it alters nothing else),
  2. seeds fictional legacy shops, memberships and PR A commercial usage evidence next to
     whatever rows already exist,
  3. applies the migration's REAL SQL text (its BEGIN/COMMIT wrapper removed so the outer
     transaction stays in control), and proves:
       * no existing shop_memberships, shops, usage_events or PR A commercial row was
         rewritten (content, xmin and physical position),
       * every existing shop gets one explicit coverage row from ONE migration instant plus
         an exact snapshot of its current memberships; nothing is claimed before that instant,
       * a membership change and its billing evidence commit or roll back together, in both
         directions, including direct trusted writes,
       * the evidence tables are append-only for every role including the table owner, and the
         interval guard refuses gaps, discontinuity and backwards time,
       * function and table ACLs match the intended authority model,
       * new shops are covered from creation and the tenant-deletion contract holds.
  4. rolls everything back, then confirms the migration is still applied exactly as before.
No credential-bearing output is printed. The literal `supabase db reset --version` +
`migration up` path is NOT used by this script.
"""
from pathlib import Path
import re
import subprocess

root = Path(__file__).resolve().parent.parent
project = 'gradia-isolated-tests'
config = root / 'tests/supabase/config.toml'
assert f'project_id = "{project}"' in config.read_text() and 'env(' not in config.read_text()
assert not (root / '.local-tools/supabase-test/supabase/.temp/project-ref').exists(), 'remote links forbidden'

NEW = '20261104140000'
migration = next((root / 'supabase/migrations').glob(f'{NEW}_*.sql'))
text = migration.read_text().strip()
assert text.startswith('BEGIN;') and text.endswith('COMMIT;'), 'migration must be one BEGIN..COMMIT block'
body = text[len('BEGIN;'):-len('COMMIT;')]
def top_level(sql):
    """SQL with dollar-quoted bodies removed: PL/pgSQL BEGIN/END blocks are not transaction control."""
    assert re.search(r'\$[A-Za-z_]\w*\$', sql) is None, 'named dollar quotes are not handled'
    return re.sub(r'\$\$.*?\$\$', '$$$$', sql, flags=re.S)


# Transaction control means a statement STARTING with these words; "ON COMMIT DROP" is ordinary DDL.
TXN_CONTROL = re.compile(r'(?im)^\s*(commit|rollback|begin|start\s+transaction|savepoint|release|abort|end)\b')
assert not TXN_CONTROL.search(top_level(body)), 'unexpected transaction control inside the migration'
versions = sorted(p.name.split('_')[0] for p in (root / 'supabase/migrations').glob('*.sql'))


def run(sql):
    result = subprocess.run(
        ['docker', 'exec', '-i', f'supabase_db_{project}', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'],
        input=sql, text=True, capture_output=True)
    if result.returncode:
        errors = [line for line in result.stderr.splitlines() if 'ERROR:' in line]
        detail = errors[0].split('ERROR:', 1)[1].strip()[:240] if errors else 'no detail'
        raise SystemExit(f'FAIL: probe failed ({detail}); the transaction was rolled back; raw output withheld')
    return result.stdout.strip()


def U(n):  # auth users
    return f'00000000-0000-4000-8000-0000000a{n:04d}'


def S(n):  # shops
    return f'00000000-0000-4000-8000-0000000b{n:04d}'


assert run("SELECT max(version) FROM supabase_migrations.schema_migrations") == versions[-1] == NEW, 'stack must be at the latest migration'
ledger_before = run("SELECT count(*) || ':' || max(version) FROM supabase_migrations.schema_migrations")

DROP_PR_B = """
DROP TRIGGER commercial_membership_capture ON public.shop_memberships;
DROP FUNCTION public.commercial_membership_capture();
DROP FUNCTION public.commercial_membership_emit(uuid, uuid, uuid, text, boolean, text, boolean, text);
DROP FUNCTION public.commercial_membership_correct(uuid, uuid, timestamptz, boolean, uuid, text, text);
DROP FUNCTION public.commercial_membership_read(uuid, timestamptz, timestamptz, timestamptz);
DROP TABLE public.commercial_membership_events;
DROP TABLE public.commercial_membership_coverage;
DROP FUNCTION public.commercial_membership_events_guard();
DO $$ BEGIN
 IF to_regclass('public.commercial_membership_events') IS NOT NULL
  OR to_regclass('public.commercial_membership_coverage') IS NOT NULL
  OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname LIKE 'commercial_membership\\_%')
  OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'commercial_membership_capture')
 THEN RAISE EXCEPTION 'Pre-PR-B schema was not restored'; END IF;
END $$;
"""

SEED = f"""
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES
 ('{U(1)}','owner1@example.test',now()),('{U(2)}','manager1@example.test',now()),
 ('{U(3)}','staff1@example.test',now()),('{U(4)}','gone1@example.test',now()),
 ('{U(5)}','owner2@example.test',now());
-- Shop bootstrap creates each owner membership (before PR B there is no capture).
INSERT INTO public.shops(id,owner_id,name) VALUES
 ('{S(1)}','{U(1)}','Fictional legacy shop one'),('{S(2)}','{U(5)}','Fictional legacy shop two');
INSERT INTO public.shop_memberships(shop_id,user_id,role,active,revoked_at,capabilities) VALUES
 ('{S(1)}','{U(2)}','manager',true,NULL,'{{}}'),
 ('{S(1)}','{U(3)}','staff',true,NULL,'{{}}'),
 ('{S(1)}','{U(4)}','manager',false,now() - interval '3 days','{{}}');
-- PR A commercial usage evidence that must survive untouched.
INSERT INTO public.usage_events(id,shop_id,kind,quantity,credits,vendor_ref) VALUES
 ('00000000-0000-4000-8000-0000000c0001','{S(1)}','voice_minute',7,0,'legacy-call-1');
INSERT INTO public.commercial_usage_recognitions(id,shop_id,catalog_version,metric,quantity,source_kind,source_ref,workflow_key,evidence,recognized_at,idempotency_key)
 VALUES('00000000-0000-4000-8000-0000000d0001','{S(1)}','2026-11-03.v1','qualified_lead',1,'workflow_outcome','wf:legacy','wf-legacy','{{"outcome_state":"confirmed","human_completed":false}}','2026-10-15T00:00:00Z','legacy.recognition.0000000000000001');
INSERT INTO public.commercial_usage_corrections(id,shop_id,recognition_id,quantity,reason,idempotency_key)
 VALUES('00000000-0000-4000-8000-0000000e0001','{S(1)}','00000000-0000-4000-8000-0000000d0001',1,'duplicate','legacy.correction.0000000000000001');

-- Row-exact fingerprints of everything that must not change.
CREATE TEMP TABLE legacy_fp AS
 SELECT 'shop_memberships' AS tbl, id::text AS pk, to_jsonb(t)::text AS content, t.xmin::text AS x, t.ctid::text AS p FROM public.shop_memberships t
 UNION ALL SELECT 'shops', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.shops t
 UNION ALL SELECT 'usage_events', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.usage_events t
 UNION ALL SELECT 'commercial_usage_recognitions', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_usage_recognitions t
 UNION ALL SELECT 'commercial_usage_corrections', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_usage_corrections t;
"""

UNCHANGED = """
DO $$
DECLARE changed integer; missing integer; extra integer;
BEGIN
 SELECT count(*) INTO changed FROM legacy_fp f JOIN (
   SELECT 'shop_memberships' tbl, id::text pk, to_jsonb(t)::text content, t.xmin::text x, t.ctid::text p FROM public.shop_memberships t
   UNION ALL SELECT 'shops', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.shops t
   UNION ALL SELECT 'usage_events', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.usage_events t
   UNION ALL SELECT 'commercial_usage_recognitions', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_usage_recognitions t
   UNION ALL SELECT 'commercial_usage_corrections', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_usage_corrections t
 ) c USING (tbl, pk) WHERE f.content <> c.content OR f.x <> c.x OR f.p <> c.p;
 IF changed <> 0 THEN RAISE EXCEPTION '% legacy rows were rewritten by the upgrade', changed; END IF;
 SELECT count(*) INTO missing FROM legacy_fp f WHERE NOT EXISTS (
   SELECT 1 FROM (SELECT 'shop_memberships' tbl, id::text pk FROM public.shop_memberships
     UNION ALL SELECT 'shops', id::text FROM public.shops UNION ALL SELECT 'usage_events', id::text FROM public.usage_events
     UNION ALL SELECT 'commercial_usage_recognitions', id::text FROM public.commercial_usage_recognitions
     UNION ALL SELECT 'commercial_usage_corrections', id::text FROM public.commercial_usage_corrections) c
   WHERE c.tbl = f.tbl AND c.pk = f.pk);
 IF missing <> 0 THEN RAISE EXCEPTION '% legacy rows disappeared', missing; END IF;
 IF (SELECT count(*) FROM legacy_fp WHERE tbl = 'shop_memberships') <> (SELECT count(*) FROM public.shop_memberships) THEN
  RAISE EXCEPTION 'Membership row count changed'; END IF;
END $$;
"""

COVERAGE = f"""
DO $$
DECLARE instants integer; mems integer;
BEGIN
 IF (SELECT count(*) FROM public.commercial_membership_coverage) <> (SELECT count(*) FROM public.shops)
  OR EXISTS (SELECT 1 FROM public.commercial_membership_coverage WHERE basis <> 'migration_snapshot')
 THEN RAISE EXCEPTION 'Every existing shop needs exactly one migration_snapshot coverage row'; END IF;
 SELECT count(DISTINCT covered_from) INTO instants FROM public.commercial_membership_coverage;
 IF instants <> 1 THEN RAISE EXCEPTION 'Coverage must start from ONE migration instant, found %', instants; END IF;
 SELECT count(*) INTO mems FROM public.shop_memberships;
 IF (SELECT count(*) FROM public.commercial_membership_events) <> mems
  OR (SELECT count(*) FROM public.commercial_membership_events WHERE kind = 'snapshot') <> mems
 THEN RAISE EXCEPTION 'Snapshot must contain exactly the existing memberships and nothing else'; END IF;
 -- Nothing is claimed before coverage: every snapshot event sits exactly at the coverage instant.
 IF EXISTS (SELECT 1 FROM public.commercial_membership_events e JOIN public.commercial_membership_coverage c USING (shop_id)
            WHERE e.effective_at <> c.covered_from OR e.previous_billable IS NOT NULL
              OR e.source_operation <> 'migration_snapshot' OR e.actor_kind <> 'system')
 THEN RAISE EXCEPTION 'Snapshot events must be system facts at the coverage instant'; END IF;
 -- Snapshot state equals the membership row it describes.
 IF EXISTS (SELECT 1 FROM public.commercial_membership_events e JOIN public.shop_memberships m ON m.id = e.member_id
            WHERE e.new_role <> m.role OR e.new_active <> m.active
              OR e.new_billable <> (m.active AND m.role IN ('owner','manager','staff')))
 THEN RAISE EXCEPTION 'Snapshot does not match the membership it describes'; END IF;
 IF (SELECT new_billable FROM public.commercial_membership_events WHERE shop_id = '{S(1)}' AND user_id = '{U(4)}') THEN
  RAISE EXCEPTION 'A revoked member must not be billable'; END IF;
 IF (SELECT count(*) FROM public.commercial_membership_events WHERE shop_id = '{S(1)}' AND new_billable) <> 3 THEN
  RAISE EXCEPTION 'Shop one has exactly three billable operators'; END IF;
 IF EXISTS (SELECT 1 FROM (SELECT shop_id, count(*) n, max(shop_seq) mx FROM public.commercial_membership_events GROUP BY shop_id) g WHERE n <> mx)
 THEN RAISE EXCEPTION 'Per-shop sequence has a gap'; END IF;
END $$;
"""

ACLS = """
DO $$
DECLARE r text;
BEGIN
 IF has_function_privilege('anon','public.commercial_membership_read(uuid,timestamptz,timestamptz,timestamptz)','EXECUTE')
  OR has_function_privilege('anon','public.commercial_membership_correct(uuid,uuid,timestamptz,boolean,uuid,text,text)','EXECUTE')
  OR has_function_privilege('authenticated','public.commercial_membership_correct(uuid,uuid,timestamptz,boolean,uuid,text,text)','EXECUTE')
  OR has_function_privilege('anon','public.commercial_membership_emit(uuid,uuid,uuid,text,boolean,text,boolean,text)','EXECUTE')
  OR has_function_privilege('authenticated','public.commercial_membership_emit(uuid,uuid,uuid,text,boolean,text,boolean,text)','EXECUTE')
  OR has_function_privilege('service_role','public.commercial_membership_emit(uuid,uuid,uuid,text,boolean,text,boolean,text)','EXECUTE')
  OR has_function_privilege('authenticated','public.commercial_membership_capture()','EXECUTE')
  OR has_function_privilege('authenticated','public.commercial_membership_events_guard()','EXECUTE')
 THEN RAISE EXCEPTION 'Unsafe function authority'; END IF;
 IF NOT has_function_privilege('service_role','public.commercial_membership_correct(uuid,uuid,timestamptz,boolean,uuid,text,text)','EXECUTE')
  OR NOT has_function_privilege('authenticated','public.commercial_membership_read(uuid,timestamptz,timestamptz,timestamptz)','EXECUTE')
  OR NOT has_function_privilege('service_role','public.commercial_membership_read(uuid,timestamptz,timestamptz,timestamptz)','EXECUTE')
 THEN RAISE EXCEPTION 'Missing intended function authority'; END IF;
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF has_table_privilege(r,'public.commercial_membership_events','INSERT')
   OR has_table_privilege(r,'public.commercial_membership_events','UPDATE')
   OR has_table_privilege(r,'public.commercial_membership_events','DELETE')
   OR has_table_privilege(r,'public.commercial_membership_events','TRUNCATE')
   OR has_table_privilege(r,'public.commercial_membership_coverage','INSERT')
   OR has_table_privilege(r,'public.commercial_membership_coverage','UPDATE')
   OR has_table_privilege(r,'public.commercial_membership_coverage','DELETE')
   OR has_table_privilege(r,'public.commercial_membership_coverage','TRUNCATE')
  THEN RAISE EXCEPTION 'Unsafe table write privilege for %', r; END IF;
 END LOOP;
 IF has_table_privilege('anon','public.commercial_membership_events','SELECT')
  OR has_table_privilege('authenticated','public.commercial_membership_events','SELECT')
  OR has_table_privilege('authenticated','public.commercial_membership_coverage','SELECT')
 THEN RAISE EXCEPTION 'Browser roles must not read evidence tables directly'; END IF;
END $$;
"""

# Each statement below runs in its own subtransaction, so a refusal is observed and undone.
APPEND_ONLY = f"""
DO $$
DECLARE blocked integer := 0;
BEGIN
 BEGIN UPDATE public.commercial_membership_events SET new_billable = NOT new_billable; EXCEPTION WHEN insufficient_privilege THEN blocked := blocked + 1; END;
 BEGIN DELETE FROM public.commercial_membership_events; EXCEPTION WHEN insufficient_privilege THEN blocked := blocked + 1; END;
 BEGIN TRUNCATE public.commercial_membership_events CASCADE; EXCEPTION WHEN insufficient_privilege THEN blocked := blocked + 1; END;
 BEGIN UPDATE public.commercial_membership_coverage SET covered_from = covered_from - interval '30 days'; EXCEPTION WHEN insufficient_privilege THEN blocked := blocked + 1; END;
 BEGIN DELETE FROM public.commercial_membership_coverage; EXCEPTION WHEN insufficient_privilege THEN blocked := blocked + 1; END;
 BEGIN TRUNCATE public.commercial_membership_coverage CASCADE; EXCEPTION WHEN insufficient_privilege THEN blocked := blocked + 1; END;
 IF blocked <> 6 THEN RAISE EXCEPTION 'Append-only guard let % of 6 probes through', 6 - blocked; END IF;
 -- Each probe below is otherwise a fully valid row (it satisfies every table CHECK), so ONLY the
 -- interval guard can refuse it, and the refusal message is asserted. Shop one has events 1..4.
 BEGIN
  INSERT INTO public.commercial_membership_events (shop_id, shop_seq, user_id, kind, previous_billable, new_role, new_active, new_billable,
    effective_at, source_operation, actor_kind, idempotency_key)
  VALUES ('{S(1)}', 99, '{U(2)}', 'change', true, 'manager', false, false, clock_timestamp(), 'membership_update', 'system', 'probe.gap.000000000000001');
  RAISE EXCEPTION 'A sequence gap was accepted';
 EXCEPTION WHEN check_violation THEN
  IF SQLERRM <> 'Membership billing sequence must be gapless' THEN RAISE; END IF; blocked := blocked + 1; END;
 BEGIN
  INSERT INTO public.commercial_membership_events (shop_id, shop_seq, user_id, kind, previous_billable, new_role, new_active, new_billable,
    effective_at, source_operation, actor_kind, idempotency_key)
  VALUES ('{S(1)}', 5, '{U(2)}', 'change', false, 'manager', true, true, clock_timestamp(), 'membership_update', 'system', 'probe.discontinuity.0000001');
  RAISE EXCEPTION 'A discontinuous interval was accepted';
 EXCEPTION WHEN check_violation THEN
  IF SQLERRM <> 'Change does not continue the recorded interval' THEN RAISE; END IF; blocked := blocked + 1; END;
 BEGIN
  INSERT INTO public.commercial_membership_events (shop_id, shop_seq, user_id, kind, previous_billable, new_role, new_active, new_billable,
    effective_at, source_operation, actor_kind, idempotency_key)
  VALUES ('{S(1)}', 5, '{U(2)}', 'change', true, 'manager', true, true, '2000-01-01T00:00:00Z', 'membership_update', 'system', 'probe.backwards.000000000001');
  RAISE EXCEPTION 'Backwards time was accepted';
 EXCEPTION WHEN check_violation THEN
  IF SQLERRM <> 'Membership billing time cannot move backwards' THEN RAISE; END IF; blocked := blocked + 1; END;
 IF blocked <> 9 THEN RAISE EXCEPTION 'Interval guard let probes through'; END IF;
END $$;
"""

ATOMIC = f"""
CREATE TEMP TABLE probe_state(n integer);
INSERT INTO probe_state SELECT count(*) FROM public.commercial_membership_events WHERE shop_id = '{S(1)}';

-- (a) A capture failure rolls the membership change back with it.
CREATE FUNCTION pg_temp.reject_capture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic capture failure'; END $$;
CREATE TRIGGER a_reject_capture BEFORE INSERT ON public.commercial_membership_events FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_capture();
DO $$
BEGIN
 BEGIN
  UPDATE public.shop_memberships SET role = 'staff' WHERE shop_id = '{S(1)}' AND user_id = '{U(2)}';
  RAISE EXCEPTION 'Expected the synthetic capture failure';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM <> 'Synthetic capture failure' THEN RAISE; END IF;
 END;
 IF (SELECT role FROM public.shop_memberships WHERE shop_id = '{S(1)}' AND user_id = '{U(2)}') <> 'manager' THEN
  RAISE EXCEPTION 'Membership change survived a failed capture'; END IF;
 IF (SELECT count(*) FROM public.commercial_membership_events WHERE shop_id = '{S(1)}') <> (SELECT n FROM probe_state) THEN
  RAISE EXCEPTION 'Evidence appeared for a failed membership change'; END IF;
END $$;
DROP TRIGGER a_reject_capture ON public.commercial_membership_events;

-- (b) A rolled-back membership change leaves no evidence; the change and its capture share one transaction.
SAVEPOINT member_change;
UPDATE public.shop_memberships SET role = 'staff' WHERE shop_id = '{S(1)}' AND user_id = '{U(2)}';
DO $$ BEGIN
 IF (SELECT count(*) FROM public.commercial_membership_events WHERE shop_id = '{S(1)}') <> (SELECT n FROM probe_state) + 1 THEN
  RAISE EXCEPTION 'The change was not captured inside its own transaction'; END IF;
END $$;
ROLLBACK TO SAVEPOINT member_change;
DO $$ BEGIN
 IF (SELECT role FROM public.shop_memberships WHERE shop_id = '{S(1)}' AND user_id = '{U(2)}') <> 'manager'
  OR (SELECT count(*) FROM public.commercial_membership_events WHERE shop_id = '{S(1)}') <> (SELECT n FROM probe_state) THEN
  RAISE EXCEPTION 'A rolled-back membership change left evidence behind'; END IF;
END $$;

-- (c) A committed direct trusted write leaves exactly one event that continues the snapshot interval.
UPDATE public.shop_memberships SET role = 'staff' WHERE shop_id = '{S(1)}' AND user_id = '{U(2)}';
DO $$ DECLARE last text; BEGIN
 SELECT kind || '|' || source_operation || '|' || previous_role || '|' || new_role || '|' || previous_billable || '|' || new_billable
   INTO last FROM public.commercial_membership_events WHERE shop_id = '{S(1)}' ORDER BY shop_seq DESC LIMIT 1;
 IF last <> 'change|membership_update|manager|staff|true|true'
  OR (SELECT count(*) FROM public.commercial_membership_events WHERE shop_id = '{S(1)}') <> (SELECT n FROM probe_state) + 1 THEN
  RAISE EXCEPTION 'Direct write was not captured exactly once: %', last; END IF;
END $$;

-- (d) A refused mutation (owner must stay active) records nothing.
DO $$ BEGIN
 BEGIN UPDATE public.shop_memberships SET active = false WHERE shop_id = '{S(1)}' AND user_id = '{U(1)}';
 EXCEPTION WHEN check_violation THEN NULL; END;
 IF (SELECT count(*) FROM public.commercial_membership_events WHERE shop_id = '{S(1)}') <> (SELECT n FROM probe_state) + 1 THEN
  RAISE EXCEPTION 'A refused membership change recorded evidence'; END IF;
END $$;

-- (e) Deactivate, reactivate, a non-billing edit and delete are captured as they should be.
UPDATE public.shop_memberships SET active = false WHERE shop_id = '{S(1)}' AND user_id = '{U(3)}';
UPDATE public.shop_memberships SET active = true WHERE shop_id = '{S(1)}' AND user_id = '{U(3)}';
UPDATE public.shop_memberships SET display_name = 'Renamed', capabilities = '{{}}' WHERE shop_id = '{S(1)}' AND user_id = '{U(3)}';
DELETE FROM public.shop_memberships WHERE shop_id = '{S(1)}' AND user_id = '{U(4)}';
DO $$ DECLARE tail text; BEGIN
 SELECT string_agg(source_operation || ':' || previous_billable || '>' || new_billable, ',' ORDER BY shop_seq) INTO tail
   FROM (SELECT * FROM public.commercial_membership_events WHERE shop_id = '{S(1)}' ORDER BY shop_seq DESC LIMIT 3) t;
 IF tail <> 'membership_update:true>false,membership_update:false>true,membership_delete:false>false' THEN
  RAISE EXCEPTION 'Unexpected captured tail: %', tail; END IF;
 IF (SELECT count(*) FROM public.commercial_membership_events WHERE shop_id = '{S(1)}') <> (SELECT n FROM probe_state) + 4 THEN
  RAISE EXCEPTION 'A non-billing edit must record nothing'; END IF;
END $$;

-- (f) A shop created after the migration is covered from its own creation.
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES ('{U(6)}','owner3@example.test',now());
INSERT INTO public.shops(id,owner_id,name) VALUES ('{S(3)}','{U(6)}','Fictional post-migration shop');
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.commercial_membership_coverage c JOIN public.commercial_membership_events e USING (shop_id)
     WHERE c.shop_id = '{S(3)}' AND c.basis = 'shop_created' AND e.effective_at = c.covered_from
       AND e.user_id = '{U(6)}' AND e.new_billable AND e.source_operation = 'membership_insert')
 THEN RAISE EXCEPTION 'A new shop must be covered from creation with its owner recorded'; END IF;
 IF (SELECT covered_from FROM public.commercial_membership_coverage WHERE shop_id = '{S(3)}')
    <= (SELECT covered_from FROM public.commercial_membership_coverage WHERE shop_id = '{S(1)}')
 THEN RAISE EXCEPTION 'A new shop cannot be covered before the migration instant'; END IF;
END $$;

-- (g) Tenant deletion contract: deleting a shop removes its history, and PR A evidence goes with it.
DELETE FROM public.shops WHERE id IN ('{S(1)}','{S(2)}','{S(3)}');
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM public.commercial_membership_events WHERE shop_id IN ('{S(1)}','{S(2)}','{S(3)}'))
  OR EXISTS (SELECT 1 FROM public.commercial_membership_coverage WHERE shop_id IN ('{S(1)}','{S(2)}','{S(3)}'))
  OR EXISTS (SELECT 1 FROM public.commercial_usage_recognitions WHERE shop_id = '{S(1)}')
 THEN RAISE EXCEPTION 'Tenant deletion left evidence behind'; END IF;
END $$;
"""

script = "\n".join([
    "BEGIN;",
    DROP_PR_B,
    SEED,
    "-- ===== the migration's real SQL, wrapper removed =====",
    body,
    "-- ===== assertions =====",
    UNCHANGED,
    COVERAGE,
    ACLS,
    APPEND_ONLY,
    ATOMIC,
    "ROLLBACK;",
])
outside = top_level(script).replace('ON COMMIT DROP', '')
assert re.search(r'(?i)\bcommit\b', outside) is None, 'the probe must never commit'
assert len(re.findall(r'(?m)^ROLLBACK;$', outside)) == 1 and outside.rstrip().endswith('ROLLBACK;'), 'the probe must end with exactly one ROLLBACK'
run(script)

# Nothing was changed: the migration is still applied exactly as before, with all its objects.
assert run("SELECT count(*) || ':' || max(version) FROM supabase_migrations.schema_migrations") == ledger_before
assert run("SELECT to_regclass('public.commercial_membership_events') IS NOT NULL AND to_regclass('public.commercial_membership_coverage') IS NOT NULL") == 't'
assert run("SELECT count(*) FROM pg_trigger WHERE tgname = 'commercial_membership_capture' AND NOT tgisinternal") == '1'
assert run("SELECT count(*) FROM public.shops WHERE id IN ('%s','%s','%s')" % (S(1), S(2), S(3))) == '0'

print(
    f'PASS: upgrade {versions[-2]} -> {NEW} applied from its real SQL inside a rolled-back transaction; legacy '
    'memberships, shops, usage_events and PR A commercial evidence unchanged (content, xmin, ctid); one coverage '
    'instant and an exact membership snapshot per existing shop; nothing claimed before coverage; membership change and '
    'billing evidence commit/roll back together (capture failure, rollback, refused change, direct trusted writes); '
    'evidence append-only for every role including the owner; interval guard refuses gaps, discontinuity and backwards '
    'time; writers service-only; browser roles have no access; new shops covered from creation; tenant deletion holds; '
    'database left exactly as it was'
)
