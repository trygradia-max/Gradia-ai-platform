"""Non-destructive upgrade probe for the commercial worker lease migration (PR F2).

Everything runs inside ONE transaction on the unlinked gradia-isolated-tests stack and ends with
ROLLBACK, so no database state is ever changed or destroyed. Inside it the probe
  1. removes exactly what 20261118120000 added (it only ADDS objects; nothing existing is replaced),
  2. seeds fictional legacy shops with PR C billing accounts, a PR D settlement and lines of every delivery
     status, and fingerprints them (content, xmin, physical position),
  3. applies the migration's REAL SQL text (BEGIN/COMMIT removed so the outer transaction controls it) and proves:
       * no existing row was rewritten and the new table holds exactly the three fixed worker rows,
       * function and table ACLs (browser roles: nothing; service role: the four functions, SELECT only on the table;
         the guard function is executable by nobody),
       * the lease state machine: acquire, held, renew (holder only, unexpired only), expiry takeover with a higher
         fencing generation, a stale holder can neither renew nor release, release by the holder only, TTL clamps,
         unknown worker / outcome refused, the operator read never returns the token,
       * browser roles are refused, rows cannot be deleted, truncated, renamed, or have their generation lowered,
       * the settlement lines and every other legacy row are untouched by lease activity,
  4. rolls everything back, then confirms the ledger is exactly as before.
No credential-bearing output is printed. The literal `supabase db reset --version` path is NOT used.
"""
from pathlib import Path
import os
import re
import subprocess

root = Path(__file__).resolve().parent.parent
project = 'gradia-isolated-tests'
config = root / 'tests/supabase/config.toml'
assert f'project_id = "{project}"' in config.read_text() and 'env(' not in config.read_text()
assert not (root / '.local-tools/supabase-test/supabase/.temp/project-ref').exists(), 'remote links forbidden'

NEW = '20261118120000'


def migration_text(version):
    return next((root / 'supabase/migrations').glob(f'{version}_*.sql')).read_text()


text = migration_text(NEW).strip()
assert text.startswith('BEGIN;') and text.endswith('COMMIT;'), 'migration must be one BEGIN..COMMIT block'
body = text[len('BEGIN;'):-len('COMMIT;')]


def top_level(sql):
    assert re.search(r'\$[A-Za-z_]\w*\$', sql) is None, 'named dollar quotes are not handled'
    return re.sub(r'\$\$.*?\$\$', '$$$$', sql, flags=re.S)


TXN_CONTROL = re.compile(r'(?im)^\s*(commit|rollback|begin|start\s+transaction|savepoint|release|abort|end)\b')
assert not TXN_CONTROL.search(top_level(body)), 'unexpected transaction control inside the migration'
assert not re.search(r'(?i)\b(drop|alter\s+table\s+public\.commercial_(settlement|billing|subscription|usage|membership)|update\s+public\.(?!commercial_worker_leases)|delete\s+from\s+public\.(?!commercial_worker_leases))', top_level(body)), \
    'the migration must only ADD objects: no drop, no alteration of an existing table, no row rewrite'
versions = sorted(p.name.split('_')[0] for p in (root / 'supabase/migrations').glob('*.sql'))
assert NEW in versions, 'the worker lease migration must be present in the repository'


def run(sql):
    result = subprocess.run(
        ['docker', 'exec', '-i', f'supabase_db_{project}', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'],
        input=sql, text=True, capture_output=True)
    if result.returncode:
        errors = [line for line in result.stderr.splitlines() if 'ERROR:' in line]
        detail = errors[0].split('ERROR:', 1)[1].strip()[:240] if errors else 'no detail'
        extra = ('\n' + result.stderr[-1500:]) if os.environ.get('VERIFY_DEBUG') == '1' else ''
        raise SystemExit(f'FAIL: probe failed ({detail}); the transaction was rolled back; raw output withheld' + extra)
    return result.stdout.strip()


def U(n):
    return f'00000000-0000-4000-8000-0000000d{n:04d}'


def S(n):
    return f'00000000-0000-4000-8000-0000000b{n:04d}'


SETTLEMENT = '00000000-0000-4000-8000-0000000a2001'
assert run(f"SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '{NEW}'") == '1', \
    'the stack must already have the migration applied (the probe removes and re-applies it inside a transaction)'
assert run("SELECT to_regclass('public.commercial_settlement_lines') IS NOT NULL AND to_regprocedure('public.commercial_billing_require_service()') IS NOT NULL") == 't', \
    'PR C-F1 schema must be present'
ledger_before = run("SELECT count(*) || ':' || max(version) FROM supabase_migrations.schema_migrations")

REMOVE_NEW = """
DROP FUNCTION public.commercial_worker_lease_read();
DROP FUNCTION public.commercial_worker_lease_release(text, uuid, text);
DROP FUNCTION public.commercial_worker_lease_renew(text, uuid, integer);
DROP FUNCTION public.commercial_worker_lease_acquire(text, integer);
DROP TABLE public.commercial_worker_leases;
DROP FUNCTION public.commercial_worker_leases_guard();
DO $$ BEGIN
 IF to_regclass('public.commercial_worker_leases') IS NOT NULL
  OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname LIKE 'commercial\\_worker\\_lease%')
 THEN RAISE EXCEPTION 'Pre-PR-F2 schema was not restored'; END IF;
END $$;
"""

FP_SOURCES = """
   SELECT 'shops' tbl, id::text pk, to_jsonb(t)::text content, t.xmin::text x, t.ctid::text p FROM public.shops t
   UNION ALL SELECT 'commercial_billing_accounts', shop_id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_billing_accounts t
   UNION ALL SELECT 'commercial_settlements', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_settlements t
   UNION ALL SELECT 'commercial_settlement_lines', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_settlement_lines t
   UNION ALL SELECT 'commercial_settlement_events', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_settlement_events t
   UNION ALL SELECT 'commercial_settlement_adjustments', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_settlement_adjustments t
   UNION ALL SELECT 'commercial_adjustment_applications', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_adjustment_applications t
   UNION ALL SELECT 'commercial_delivery_reconciliations', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_delivery_reconciliations t
"""

FAILS = """
CREATE FUNCTION pg_temp.fails(q text, code text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE q;
  RAISE EXCEPTION 'expected % but the statement succeeded: %', code, left(q, 100);
EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE = code THEN RETURN; END IF;
  RAISE EXCEPTION 'expected % but got % (%): %', code, SQLSTATE, SQLERRM, left(q, 100);
END $$;
"""
JWT_SERVICE = "SELECT set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true);"


def jwt(role, sub=None):
    claims = '{"role":"%s"%s}' % (role, (',"sub":"%s"' % sub) if sub else '')
    return f"SELECT set_config('request.jwt.claims', '{claims}', true);"


CAT = "'2026-11-03.v1', 'founder-pilot'"
LOOKUP = "'gradia_founder_pilot_2026_11_monthly'"

SEED = f"""
{FAILS}
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES
 ('{U(1)}','owner1@example.test',now()),('{U(2)}','owner2@example.test',now());
INSERT INTO public.shops(id,owner_id,name) VALUES ('{S(1)}','{U(1)}','Fictional shop one'),('{S(2)}','{U(2)}','Fictional shop two');
DO $$
DECLARE r jsonb;
BEGIN
 PERFORM set_config('request.jwt.claims', '{{"role":"service_role"}}', true);
 r := public.commercial_checkout_begin('{S(1)}', '{U(1)}', {CAT}, {LOOKUP}, 'agents', '{'a' * 64}');
 PERFORM public.commercial_checkout_bind_customer('{S(1)}', '{U(1)}', (r->>'attempt_id')::uuid, 'cus_VerifyCustomer01');
END $$;
INSERT INTO public.commercial_settlements (id, shop_id, catalog_version, plan_key, window_start, window_end, as_of, evidence_digest, document_digest,
  document, base_cents, seat_cents, usage_cents, usage_cap_cents, total_cents, mapping_version, stripe_customer_id, account_version, requested_by, idempotency_key)
VALUES ('{SETTLEMENT}', '{S(1)}', '2026-11-03.v1', 'founder-pilot', '2026-08-01Z', '2026-09-01Z', '2026-09-02Z',
  repeat('a',64), repeat('b',64), '{{}}'::jsonb, 19900, 0, 0, 10000, 19900, 'verify-fixture', 'cus_VerifyCustomer01', 1, '{U(1)}', 'cset.v1.legacyverifyfixture0003');
INSERT INTO public.commercial_settlement_lines (id, settlement_id, shop_id, component, billed_quantity, charge_cents, value_basis, event_name,
  event_value, provider_identifier, event_timestamp, delivery_status)
VALUES ('00000000-0000-4000-8000-0000000a3001', '{SETTLEMENT}', '{S(1)}', 'qualified_lead', '7', 700, 'billed_quantity', 'verify_fixture_qualified_lead', 7,
  'gradia-cb-settle-verifyfixture0001', '2026-08-31T23:59:59Z', 'pending');
CREATE TEMP TABLE legacy_fp AS SELECT * FROM ({FP_SOURCES}) q;
"""

UNCHANGED = f"""
DO $$
DECLARE changed integer; missing integer;
BEGIN
 SELECT count(*) INTO changed FROM legacy_fp f JOIN ({FP_SOURCES}) c USING (tbl, pk) WHERE f.content <> c.content OR f.x <> c.x OR f.p <> c.p;
 IF changed <> 0 THEN RAISE EXCEPTION '% legacy rows were rewritten by the upgrade', changed; END IF;
 SELECT count(*) INTO missing FROM legacy_fp f WHERE NOT EXISTS (SELECT 1 FROM ({FP_SOURCES}) c WHERE c.tbl = f.tbl AND c.pk = f.pk);
 IF missing <> 0 THEN RAISE EXCEPTION '% legacy rows disappeared', missing; END IF;
 IF (SELECT count(*) FROM legacy_fp) <> (SELECT count(*) FROM ({FP_SOURCES}) c) THEN RAISE EXCEPTION 'Legacy row count changed'; END IF;
 IF (SELECT array_agg(worker ORDER BY worker) FROM public.commercial_worker_leases) <> ARRAY['adjustment_apply','delivery_reconcile','settlement_dispatch']
  OR EXISTS (SELECT 1 FROM public.commercial_worker_leases WHERE holder_token IS NOT NULL OR lease_until IS NOT NULL OR generation <> 0)
 THEN RAISE EXCEPTION 'The upgrade must seed exactly the three idle worker rows'; END IF;
END $$;
"""

ACLS = """
DO $$
DECLARE r text; f text;
BEGIN
 FOREACH f IN ARRAY ARRAY[
   'public.commercial_worker_lease_acquire(text,integer)',
   'public.commercial_worker_lease_renew(text,uuid,integer)',
   'public.commercial_worker_lease_release(text,uuid,text)',
   'public.commercial_worker_lease_read()'] LOOP
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
   OR NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
   RAISE EXCEPTION 'Lease function % must be executable by the service role only', f; END IF;
 END LOOP;
 IF has_function_privilege('service_role', 'public.commercial_worker_leases_guard()', 'EXECUTE')
  OR has_function_privilege('authenticated', 'public.commercial_worker_leases_guard()', 'EXECUTE')
  OR has_function_privilege('anon', 'public.commercial_worker_leases_guard()', 'EXECUTE') THEN
  RAISE EXCEPTION 'The lease guard must not be executable'; END IF;
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF has_table_privilege(r, 'public.commercial_worker_leases', 'INSERT') OR has_table_privilege(r, 'public.commercial_worker_leases', 'UPDATE')
   OR has_table_privilege(r, 'public.commercial_worker_leases', 'DELETE') OR has_table_privilege(r, 'public.commercial_worker_leases', 'TRUNCATE') THEN
   RAISE EXCEPTION 'Unsafe table write privilege for %', r; END IF;
 END LOOP;
 IF has_table_privilege('anon', 'public.commercial_worker_leases', 'SELECT') OR has_table_privilege('authenticated', 'public.commercial_worker_leases', 'SELECT')
  OR NOT has_table_privilege('service_role', 'public.commercial_worker_leases', 'SELECT') THEN RAISE EXCEPTION 'Table read authority wrong'; END IF;
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.commercial_worker_leases'::regclass) THEN RAISE EXCEPTION 'RLS off'; END IF;
END $$;
"""

PROBES = f"""
-- ===== browser roles are refused =====
{jwt('authenticated', U(1))}
DO $$
BEGIN
 PERFORM pg_temp.fails($q$SELECT public.commercial_worker_lease_acquire('adjustment_apply', 60)$q$, '42501');
 PERFORM pg_temp.fails($q$SELECT public.commercial_worker_lease_renew('adjustment_apply', '{U(1)}', 60)$q$, '42501');
 PERFORM pg_temp.fails($q$SELECT public.commercial_worker_lease_release('adjustment_apply', '{U(1)}', 'completed')$q$, '42501');
 PERFORM pg_temp.fails($q$SELECT public.commercial_worker_lease_read()$q$, '42501');
END $$;
{jwt('anon')}
DO $$
BEGIN
 PERFORM pg_temp.fails($q$SELECT public.commercial_worker_lease_acquire('adjustment_apply', 60)$q$, '42501');
END $$;

-- ===== the lease state machine =====
{JWT_SERVICE}
DO $$
DECLARE a jsonb; b jsonb; held jsonb; t1 uuid; t2 uuid; lines_fp text;
BEGIN
 lines_fp := (SELECT to_jsonb(l)::text || l.xmin::text FROM public.commercial_settlement_lines l WHERE id = '00000000-0000-4000-8000-0000000a3001');
 PERFORM pg_temp.fails($q$SELECT public.commercial_worker_lease_acquire('evil_worker', 60)$q$, '22023');
 PERFORM pg_temp.fails($q$SELECT public.commercial_worker_lease_release('adjustment_apply', NULL, 'nonsense')$q$, '22023');

 a := public.commercial_worker_lease_acquire('delivery_reconcile', 1);
 IF NOT (a->>'acquired')::boolean OR (a->>'generation')::bigint <> 1 THEN RAISE EXCEPTION 'first acquire: %', a; END IF;
 t1 := (a->>'token')::uuid;
 -- TTL floor of 30 s (asked for 1)
 IF (SELECT lease_until - clock_timestamp() FROM public.commercial_worker_leases WHERE worker = 'delivery_reconcile') < interval '20 seconds' THEN
  RAISE EXCEPTION 'the TTL floor must be 30 seconds'; END IF;
 -- held: a second acquirer is refused, nothing changes
 held := public.commercial_worker_lease_acquire('delivery_reconcile', 60);
 IF (held->>'acquired')::boolean OR held->>'reason' <> 'lease_held' THEN RAISE EXCEPTION 'a live lease must be held: %', held; END IF;
 IF (SELECT holder_token FROM public.commercial_worker_leases WHERE worker = 'delivery_reconcile') <> t1 THEN RAISE EXCEPTION 'a refused acquire must not change the holder'; END IF;
 -- other workers are independent
 IF NOT (public.commercial_worker_lease_acquire('adjustment_apply', 60)->>'acquired')::boolean THEN RAISE EXCEPTION 'workers are independent'; END IF;
 -- renew: holder only
 IF (public.commercial_worker_lease_renew('delivery_reconcile', '{U(9)}', 60)->>'renewed')::boolean THEN RAISE EXCEPTION 'a stranger cannot renew'; END IF;
 IF NOT (public.commercial_worker_lease_renew('delivery_reconcile', t1, 10000000)->>'renewed')::boolean THEN RAISE EXCEPTION 'the holder renews'; END IF;
 IF (SELECT lease_until - clock_timestamp() FROM public.commercial_worker_leases WHERE worker = 'delivery_reconcile') > interval '901 seconds' THEN
  RAISE EXCEPTION 'the TTL ceiling must be 15 minutes'; END IF;
 -- release: holder only
 IF (public.commercial_worker_lease_release('delivery_reconcile', '{U(9)}', 'failed')->>'released')::boolean THEN RAISE EXCEPTION 'a stranger cannot release'; END IF;

 -- the holder dies: expiry, takeover with a higher fencing generation
 UPDATE public.commercial_worker_leases SET lease_until = clock_timestamp() - interval '1 second' WHERE worker = 'delivery_reconcile';
 IF (public.commercial_worker_lease_renew('delivery_reconcile', t1, 60)->>'renewed')::boolean THEN RAISE EXCEPTION 'an expired holder must stop'; END IF;
 b := public.commercial_worker_lease_acquire('delivery_reconcile', 60);
 IF NOT (b->>'acquired')::boolean OR (b->>'generation')::bigint <> 2 OR NOT (b->>'expired_prior_holder')::boolean THEN RAISE EXCEPTION 'takeover: %', b; END IF;
 t2 := (b->>'token')::uuid;
 IF t1 = t2 THEN RAISE EXCEPTION 'a takeover must mint a new token'; END IF;
 IF (public.commercial_worker_lease_renew('delivery_reconcile', t1, 60)->>'renewed')::boolean
  OR (public.commercial_worker_lease_release('delivery_reconcile', t1, 'failed')->>'released')::boolean THEN
  RAISE EXCEPTION 'a stale holder can neither renew nor release'; END IF;
 IF (SELECT holder_token FROM public.commercial_worker_leases WHERE worker = 'delivery_reconcile') <> t2 THEN RAISE EXCEPTION 'stale holder changed the lease'; END IF;
 IF NOT (public.commercial_worker_lease_release('delivery_reconcile', t2, 'completed')->>'released')::boolean THEN RAISE EXCEPTION 'the holder releases'; END IF;
 IF EXISTS (SELECT 1 FROM public.commercial_worker_leases WHERE worker = 'delivery_reconcile' AND (holder_token IS NOT NULL OR lease_until IS NOT NULL OR last_outcome <> 'completed')) THEN
  RAISE EXCEPTION 'release must free the lease and record the outcome'; END IF;
 IF (public.commercial_worker_lease_release('delivery_reconcile', t2, 'completed')->>'released')::boolean THEN RAISE EXCEPTION 'a double release is a no-op'; END IF;
 -- the operator read never carries the token
 IF public.commercial_worker_lease_read()::text LIKE '%' || t2::text || '%' OR public.commercial_worker_lease_read()::text LIKE '%holder_token%' THEN
  RAISE EXCEPTION 'the operator read must not return the token'; END IF;
 IF jsonb_array_length(public.commercial_worker_lease_read()) <> 3 THEN RAISE EXCEPTION 'three workers expected'; END IF;
 -- lease activity never touched the settlement ledger
 IF lines_fp <> (SELECT to_jsonb(l)::text || l.xmin::text FROM public.commercial_settlement_lines l WHERE id = '00000000-0000-4000-8000-0000000a3001') THEN
  RAISE EXCEPTION 'lease activity must not touch settlement lines'; END IF;
END $$;

-- ===== immutability =====
DO $$
BEGIN
 PERFORM pg_temp.fails($q$DELETE FROM public.commercial_worker_leases$q$, '42501');
 PERFORM pg_temp.fails($q$TRUNCATE public.commercial_worker_leases$q$, '42501');
 PERFORM pg_temp.fails($q$UPDATE public.commercial_worker_leases SET worker = 'renamed' WHERE worker = 'adjustment_apply'$q$, '42501');
 PERFORM pg_temp.fails($q$UPDATE public.commercial_worker_leases SET generation = 0 WHERE worker = 'delivery_reconcile'$q$, '42501');
 PERFORM pg_temp.fails($q$INSERT INTO public.commercial_worker_leases (worker) VALUES ('invented')$q$, '23514');
 PERFORM pg_temp.fails($q$UPDATE public.commercial_worker_leases SET holder_token = gen_random_uuid() WHERE worker = 'delivery_reconcile'$q$, '23514');
END $$;
"""

program = '\n'.join(['BEGIN;', REMOVE_NEW, SEED, body, UNCHANGED, ACLS, PROBES, 'ROLLBACK;'])
run(program)
assert run("SELECT count(*) || ':' || max(version) FROM supabase_migrations.schema_migrations") == ledger_before, 'ledger changed'
assert run("SELECT to_regclass('public.commercial_worker_leases') IS NOT NULL") == 't', \
    'the probe must leave the applied migration exactly as it found it'
print('PASS: commercial worker lease migration upgrade, authority, lease state machine, immutability (rolled back)')
