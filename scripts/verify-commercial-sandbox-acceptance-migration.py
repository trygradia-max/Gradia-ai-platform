"""Non-destructive upgrade probe for the commercial sandbox acceptance migration (PR F1).

Everything runs inside ONE transaction on the unlinked gradia-isolated-tests stack and ends with
ROLLBACK, so no database state is ever changed or destroyed. Inside it the probe
  1. removes exactly what 20261117120000 added (it only ADDS objects; nothing existing is replaced),
  2. seeds fictional legacy shops, PR C billing accounts with a bound platform customer, and a PR D
     settlement whose six lines cover every delivery status (not_required/pending/in_flight/delivered/
     rejected/unknown), plus a PR E1 adjustment contract row,
  3. applies the migration's REAL SQL text (BEGIN/COMMIT removed so the outer transaction controls it) and proves:
       * no existing row was rewritten (content, xmin and physical position) and every new table starts empty,
       * function and table ACLs match the authority model (browser roles: nothing readable or writable;
         service role: functions only; owners: evidence reads of their own shop),
       * the dispatch worklists (per-shop scoping, no browser access),
       * delivery reconciliation: only an `unknown` line, the database decides the outcome, a confirmed
         result is final and replays, the line itself is never rewritten, a window that does not contain
         the event is refused,
       * adjustment application: no review / a rejection / another shop is refused, one approved
         adjustment is claimed once, recorded once, never repeated,
       * append-only tables and the tenant-deletion cascade.
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

NEW = '20261117120000'


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
assert not re.search(r'(?i)\b(drop|alter\s+table\s+public\.commercial_(settlement|billing|subscription|usage|membership)|update\s+public\.|delete\s+from)\b', top_level(body)), \
    'the migration must only ADD objects: no drop, no alteration of an existing table, no row rewrite'
versions = sorted(p.name.split('_')[0] for p in (root / 'supabase/migrations').glob('*.sql'))
assert versions[-1] == NEW, 'the sandbox acceptance migration must be the latest migration in the repository'


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
assert run("SELECT to_regclass('public.commercial_settlement_lines') IS NOT NULL AND to_regclass('public.commercial_settlement_adjustments') IS NOT NULL") == 't', \
    'PR A-E1 schema must be present'
ledger_before = run("SELECT count(*) || ':' || max(version) FROM supabase_migrations.schema_migrations")

REMOVE_NEW = """
DROP FUNCTION public.commercial_adjustment_application_read(uuid);
DROP FUNCTION public.commercial_adjustment_application_record(uuid, uuid, uuid, text, text);
DROP FUNCTION public.commercial_adjustment_application_claim(uuid, uuid);
DROP FUNCTION public.commercial_adjustment_application_pending(integer, uuid);
DROP FUNCTION public.commercial_delivery_reconciliation_read(uuid, uuid);
DROP FUNCTION public.commercial_delivery_reconcile_record(uuid, uuid, uuid, bigint, timestamptz);
DROP FUNCTION public.commercial_settlement_delivery_unresolved(integer, uuid);
DROP FUNCTION public.commercial_settlement_delivery_pending(integer, uuid);
DROP TABLE public.commercial_adjustment_application_events;
DROP TABLE public.commercial_adjustment_applications;
DROP FUNCTION public.commercial_adjustment_applications_guard();
DROP TABLE public.commercial_delivery_reconciliations;
DO $$ BEGIN
 IF to_regclass('public.commercial_delivery_reconciliations') IS NOT NULL OR to_regclass('public.commercial_adjustment_applications') IS NOT NULL
  OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname LIKE 'commercial\\_adjustment\\_application%')
  OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname IN ('commercial_settlement_delivery_pending', 'commercial_settlement_delivery_unresolved',
                   'commercial_delivery_reconcile_record', 'commercial_delivery_reconciliation_read'))
 THEN RAISE EXCEPTION 'Pre-PR-F1 schema was not restored'; END IF;
END $$;
"""

FP_SOURCES = """
   SELECT 'shops' tbl, id::text pk, to_jsonb(t)::text content, t.xmin::text x, t.ctid::text p FROM public.shops t
   UNION ALL SELECT 'commercial_billing_accounts', shop_id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_billing_accounts t
   UNION ALL SELECT 'commercial_settlements', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_settlements t
   UNION ALL SELECT 'commercial_settlement_lines', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_settlement_lines t
   UNION ALL SELECT 'commercial_settlement_events', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_settlement_events t
   UNION ALL SELECT 'commercial_settlement_adjustments', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_settlement_adjustments t
   UNION ALL SELECT 'commercial_adjustment_reviews', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_adjustment_reviews t
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


def line(n, component, status, extra=''):
    ident = f"'gradia-cb-settle-verifyfixture{n:04d}'" if status != 'not_required' else 'NULL'
    value = 'NULL' if status == 'not_required' else '7'
    basis = 'NULL' if status == 'not_required' else "'billed_quantity'"
    name = 'NULL' if status == 'not_required' else f"'verify_fixture_{component}'"
    ts = 'NULL' if status == 'not_required' else "'2026-08-31T23:59:59Z'"
    return (f"INSERT INTO public.commercial_settlement_lines (id, settlement_id, shop_id, component, billed_quantity, charge_cents, value_basis, event_name, "
            f"event_value, provider_identifier, event_timestamp, delivery_status{', claim_token, claimed_at' if extra else ''}{', failure_code' if status in ('rejected', 'unknown') else ''}) "
            f"VALUES ('00000000-0000-4000-8000-0000000a30{n:02d}', '{SETTLEMENT}', '{S(1)}', '{component}', '7', 700, {basis}, {name}, {value}, {ident}, {ts}, '{status}'"
            f"{', ' + extra if extra else ''}{(', ' + repr('provider_outcome_unknown')) if status in ('rejected', 'unknown') else ''});")


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
 r := public.commercial_checkout_begin('{S(2)}', '{U(2)}', {CAT}, {LOOKUP}, 'agents', '{'a' * 64}');
 PERFORM public.commercial_checkout_bind_customer('{S(2)}', '{U(2)}', (r->>'attempt_id')::uuid, 'cus_VerifyCustomer02');
END $$;
INSERT INTO public.commercial_settlements (id, shop_id, catalog_version, plan_key, window_start, window_end, as_of, evidence_digest, document_digest,
  document, base_cents, seat_cents, usage_cents, usage_cap_cents, total_cents, mapping_version, stripe_customer_id, account_version, requested_by, idempotency_key)
VALUES ('{SETTLEMENT}', '{S(1)}', '2026-11-03.v1', 'founder-pilot', '2026-08-01Z', '2026-09-01Z', '2026-09-02Z',
  repeat('a',64), repeat('b',64), '{{}}'::jsonb, 19900, 0, 0, 10000, 19900, 'verify-fixture', 'cus_VerifyCustomer01', 1, '{U(1)}', 'cset.v1.legacyverifyfixture0002');
{line(1, 'standard_digital_outcome', 'pending')}
{line(2, 'qualified_lead', 'in_flight', "'00000000-0000-4000-8000-0000000a9902', now()")}
{line(3, 'confirmed_appointment', 'delivered', "'00000000-0000-4000-8000-0000000a9903', now()")}
{line(4, 'inbound_voice_agent_minute', 'rejected', "'00000000-0000-4000-8000-0000000a9904', now()")}
{line(5, 'sms_segment', 'unknown', "'00000000-0000-4000-8000-0000000a9905', now()")}
{line(6, 'extra_operator_seat_proration', 'not_required')}
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
 IF EXISTS (SELECT 1 FROM public.commercial_delivery_reconciliations) OR EXISTS (SELECT 1 FROM public.commercial_adjustment_applications)
  OR EXISTS (SELECT 1 FROM public.commercial_adjustment_application_events)
 THEN RAISE EXCEPTION 'The upgrade must not invent reconciliations or applications'; END IF;
END $$;
"""

ACLS = """
DO $$
DECLARE r text; f text; t text;
BEGIN
 FOREACH f IN ARRAY ARRAY[
   'public.commercial_settlement_delivery_pending(integer,uuid)',
   'public.commercial_settlement_delivery_unresolved(integer,uuid)',
   'public.commercial_delivery_reconcile_record(uuid,uuid,uuid,bigint,timestamptz)',
   'public.commercial_adjustment_application_pending(integer,uuid)',
   'public.commercial_adjustment_application_claim(uuid,uuid)',
   'public.commercial_adjustment_application_record(uuid,uuid,uuid,text,text)'] LOOP
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
   OR NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
   RAISE EXCEPTION 'Worker % must be executable by the service role only', f; END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.commercial_delivery_reconciliation_read(uuid,uuid)', 'public.commercial_adjustment_application_read(uuid)'] LOOP
  IF has_function_privilege('anon', f, 'EXECUTE') OR NOT has_function_privilege('authenticated', f, 'EXECUTE')
   OR NOT has_function_privilege('service_role', f, 'EXECUTE') THEN RAISE EXCEPTION 'Reader % authority is wrong', f; END IF;
 END LOOP;
 IF has_function_privilege('service_role', 'public.commercial_adjustment_applications_guard()', 'EXECUTE')
  OR has_function_privilege('authenticated', 'public.commercial_adjustment_applications_guard()', 'EXECUTE') THEN
  RAISE EXCEPTION 'The application guard must not be executable'; END IF;
 FOREACH t IN ARRAY ARRAY['public.commercial_delivery_reconciliations','public.commercial_adjustment_applications','public.commercial_adjustment_application_events'] LOOP
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF has_table_privilege(r, t, 'INSERT') OR has_table_privilege(r, t, 'UPDATE')
    OR has_table_privilege(r, t, 'DELETE') OR has_table_privilege(r, t, 'TRUNCATE') THEN
    RAISE EXCEPTION 'Unsafe table write privilege on % for %', t, r; END IF;
  END LOOP;
  IF has_table_privilege('anon', t, 'SELECT') OR has_table_privilege('authenticated', t, 'SELECT')
   OR NOT has_table_privilege('service_role', t, 'SELECT') THEN RAISE EXCEPTION 'Table read authority wrong on %', t; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = t::regclass) THEN RAISE EXCEPTION 'RLS off on %', t; END IF;
 END LOOP;
END $$;
"""

LINE = lambda n: f"00000000-0000-4000-8000-0000000a30{n:02d}"
PROBES = f"""
-- ===== dispatch worklists =====
{JWT_SERVICE}
DO $$
DECLARE w jsonb;
BEGIN
 w := public.commercial_settlement_delivery_pending(50, '{S(1)}');
 IF jsonb_array_length(w) <> 2 THEN RAISE EXCEPTION 'pending worklist must hold the pending and in-flight lines: %', w; END IF;
 IF jsonb_array_length(public.commercial_settlement_delivery_pending(50, '{S(2)}')) <> 0 THEN RAISE EXCEPTION 'worklist must be per shop'; END IF;
 IF jsonb_array_length(public.commercial_settlement_delivery_unresolved(50, '{S(1)}')) <> 1 THEN RAISE EXCEPTION 'exactly one unresolved unknown line expected'; END IF;
END $$;
{jwt('authenticated', U(1))}
DO $$
BEGIN
 PERFORM pg_temp.fails($q$SELECT public.commercial_settlement_delivery_pending(5, NULL)$q$, '42501');
 PERFORM pg_temp.fails($q$SELECT public.commercial_settlement_delivery_unresolved(5, NULL)$q$, '42501');
 PERFORM pg_temp.fails($q$SELECT public.commercial_adjustment_application_pending(5, NULL)$q$, '42501');
 PERFORM pg_temp.fails($q$SELECT public.commercial_delivery_reconcile_record('{S(1)}', '{SETTLEMENT}', '{LINE(5)}', 7, '2026-08-31T23:59:00Z')$q$, '42501');
 PERFORM pg_temp.fails($q$SELECT public.commercial_adjustment_application_claim('{S(1)}', '{SETTLEMENT}')$q$, '42501');
 PERFORM pg_temp.fails($q$SELECT public.commercial_delivery_reconciliation_read('{S(2)}', '{SETTLEMENT}')$q$, '42501');
 PERFORM public.commercial_delivery_reconciliation_read('{S(1)}', '{SETTLEMENT}');
 PERFORM public.commercial_adjustment_application_read('{S(1)}');
 PERFORM pg_temp.fails($q$SELECT public.commercial_adjustment_application_read('{S(2)}')$q$, '42501');
END $$;
{jwt('anon')}
DO $$
BEGIN
 PERFORM pg_temp.fails($q$SELECT public.commercial_delivery_reconciliation_read('{S(1)}', '{SETTLEMENT}')$q$, '42501');
END $$;

-- ===== delivery reconciliation =====
{JWT_SERVICE}
DO $$
DECLARE r jsonb; fp text;
BEGIN
 fp := (SELECT to_jsonb(l)::text || l.xmin::text FROM public.commercial_settlement_lines l WHERE id = '{LINE(5)}');
 -- only an unknown line is reconciled
 PERFORM pg_temp.fails($q$SELECT public.commercial_delivery_reconcile_record('{S(1)}', '{SETTLEMENT}', '{LINE(3)}', 7, '2026-08-31T23:59:00Z')$q$, 'CB409');
 PERFORM pg_temp.fails($q$SELECT public.commercial_delivery_reconcile_record('{S(1)}', '{SETTLEMENT}', '{LINE(4)}', 7, '2026-08-31T23:59:00Z')$q$, 'CB409');
 -- the window must be one aligned minute containing the event
 PERFORM pg_temp.fails($q$SELECT public.commercial_delivery_reconcile_record('{S(1)}', '{SETTLEMENT}', '{LINE(5)}', 7, '2026-08-31T23:58:00Z')$q$, '22023');
 PERFORM pg_temp.fails($q$SELECT public.commercial_delivery_reconcile_record('{S(1)}', '{SETTLEMENT}', '{LINE(5)}', 7, '2026-08-31T23:59:30Z')$q$, '22023');
 -- another shop cannot reach this line
 PERFORM pg_temp.fails($q$SELECT public.commercial_delivery_reconcile_record('{S(2)}', '{SETTLEMENT}', '{LINE(5)}', 7, '2026-08-31T23:59:00Z')$q$, 'CB409');
 r := public.commercial_delivery_reconcile_record('{S(1)}', '{SETTLEMENT}', '{LINE(5)}', 0, '2026-08-31T23:59:00Z');
 IF r->>'outcome' <> 'not_confirmed' THEN RAISE EXCEPTION 'zero observation is not a confirmation: %', r; END IF;
 IF jsonb_array_length(public.commercial_settlement_delivery_unresolved(50, '{S(1)}')) <> 1 THEN RAISE EXCEPTION 'unconfirmed stays unresolved'; END IF;
 r := public.commercial_delivery_reconcile_record('{S(1)}', '{SETTLEMENT}', '{LINE(5)}', 9, '2026-08-31T23:59:00Z');
 IF r->>'outcome' <> 'mismatch' THEN RAISE EXCEPTION 'an excess observation is a mismatch: %', r; END IF;
 r := public.commercial_delivery_reconcile_record('{S(1)}', '{SETTLEMENT}', '{LINE(5)}', 7, '2026-08-31T23:59:00Z');
 IF r->>'outcome' <> 'confirmed_delivered' OR (r->>'replayed')::boolean THEN RAISE EXCEPTION 'exact observation confirms: %', r; END IF;
 r := public.commercial_delivery_reconcile_record('{S(1)}', '{SETTLEMENT}', '{LINE(5)}', 3, '2026-08-31T23:59:00Z');
 IF r->>'outcome' <> 'confirmed_delivered' OR NOT (r->>'replayed')::boolean THEN RAISE EXCEPTION 'a confirmed result is final: %', r; END IF;
 IF (SELECT count(*) FROM public.commercial_delivery_reconciliations WHERE line_id = '{LINE(5)}') <> 3 THEN RAISE EXCEPTION 'append-only evidence count'; END IF;
 IF jsonb_array_length(public.commercial_settlement_delivery_unresolved(50, '{S(1)}')) <> 0 THEN RAISE EXCEPTION 'confirmed lines leave the worklist'; END IF;
 IF fp <> (SELECT to_jsonb(l)::text || l.xmin::text FROM public.commercial_settlement_lines l WHERE id = '{LINE(5)}') THEN
  RAISE EXCEPTION 'reconciliation must never rewrite the settlement line'; END IF;
END $$;

-- ===== adjustment application =====
DO $$
DECLARE a1 uuid; a2 uuid; c jsonb;
BEGIN
 a1 := (public.commercial_adjustment_propose('{S(1)}', '{SETTLEMENT}', 'late_usage_evidence', -300, 'late_outcome_correction', NULL, 'adj.v1.verifyapplication0001', 'reviewed_operator')->>'adjustment_id')::uuid;
 a2 := (public.commercial_adjustment_propose('{S(1)}', '{SETTLEMENT}', 'late_usage_evidence', 450, 'late_outcome_correction', NULL, 'adj.v1.verifyapplication0002', 'reviewed_operator')->>'adjustment_id')::uuid;
 IF jsonb_array_length(public.commercial_adjustment_application_pending(50, '{S(1)}')) <> 0 THEN RAISE EXCEPTION 'unreviewed adjustments are not on the worklist'; END IF;
 PERFORM pg_temp.fails(format($q$SELECT public.commercial_adjustment_application_claim('{S(1)}', %L)$q$, a1), 'CB409');
 PERFORM public.commercial_adjustment_review('{S(1)}', a2, 'rejected', 'reviewer:abcdefgh', NULL);
 PERFORM pg_temp.fails(format($q$SELECT public.commercial_adjustment_application_claim('{S(1)}', %L)$q$, a2), 'CB409');
 PERFORM public.commercial_adjustment_review('{S(1)}', a1, 'approved', 'reviewer:abcdefgh', NULL);
 IF jsonb_array_length(public.commercial_adjustment_application_pending(50, '{S(1)}')) <> 1 THEN RAISE EXCEPTION 'only the approved adjustment is on the worklist'; END IF;
 PERFORM pg_temp.fails(format($q$SELECT public.commercial_adjustment_application_claim('{S(2)}', %L)$q$, a1), 'CB409');
 c := public.commercial_adjustment_application_claim('{S(1)}', a1);
 IF c->>'action' <> 'claimed' OR (c->>'signed_amount_cents')::bigint <> -300 OR c->>'stripe_customer_id' <> 'cus_VerifyCustomer01' THEN RAISE EXCEPTION 'bad claim %', c; END IF;
 IF public.commercial_adjustment_application_claim('{S(1)}', a1)->>'action' <> 'in_progress' THEN RAISE EXCEPTION 'a live claim is never handed out twice'; END IF;
 PERFORM pg_temp.fails(format($q$SELECT public.commercial_adjustment_application_record('{S(1)}', %L, %L, 'applied', NULL)$q$, a1, '00000000-0000-4000-8000-000000000001'), 'CB409');
 PERFORM public.commercial_adjustment_application_record('{S(1)}', a1, (c->>'claim_token')::uuid, 'applied', NULL);
 PERFORM pg_temp.fails(format($q$SELECT public.commercial_adjustment_application_record('{S(1)}', %L, %L, 'unknown', 'late_flip')$q$, a1, c->>'claim_token'), 'CB409');
 IF public.commercial_adjustment_application_claim('{S(1)}', a1)->>'action' <> 'applied' THEN RAISE EXCEPTION 'an applied adjustment is never applied twice'; END IF;
 IF (SELECT count(*) FROM public.commercial_adjustment_applications) <> 1 THEN RAISE EXCEPTION 'exactly one application'; END IF;
 IF (SELECT array_agg(kind ORDER BY recorded_at) FROM public.commercial_adjustment_application_events) <> ARRAY['claimed','applied'] THEN RAISE EXCEPTION 'application evidence'; END IF;
 IF jsonb_array_length(public.commercial_adjustment_application_pending(50, '{S(1)}')) <> 0 THEN RAISE EXCEPTION 'applied leaves the worklist'; END IF;
END $$;

-- ===== immutability and cascade =====
DO $$
BEGIN
 PERFORM pg_temp.fails($q$UPDATE public.commercial_delivery_reconciliations SET observed_value = 1$q$, '42501');
 PERFORM pg_temp.fails($q$DELETE FROM public.commercial_delivery_reconciliations$q$, '42501');
 PERFORM pg_temp.fails($q$TRUNCATE public.commercial_delivery_reconciliations$q$, '42501');
 PERFORM pg_temp.fails($q$UPDATE public.commercial_adjustment_applications SET signed_amount_cents = 1$q$, '42501');
 PERFORM pg_temp.fails($q$UPDATE public.commercial_adjustment_applications SET status = 'in_flight'$q$, '42501');
 PERFORM pg_temp.fails($q$DELETE FROM public.commercial_adjustment_applications$q$, '42501');
 PERFORM pg_temp.fails($q$DELETE FROM public.commercial_adjustment_application_events$q$, '42501');
 PERFORM pg_temp.fails($q$TRUNCATE public.commercial_adjustment_applications$q$, '0A000');
 DELETE FROM public.shops WHERE id = '{S(1)}';
 IF EXISTS (SELECT 1 FROM public.commercial_delivery_reconciliations WHERE shop_id = '{S(1)}')
  OR EXISTS (SELECT 1 FROM public.commercial_adjustment_applications WHERE shop_id = '{S(1)}')
  OR EXISTS (SELECT 1 FROM public.commercial_adjustment_application_events WHERE shop_id = '{S(1)}') THEN
  RAISE EXCEPTION 'tenant deletion must remove F1 rows'; END IF;
END $$;
"""

program = '\n'.join(['BEGIN;', REMOVE_NEW, SEED, body, UNCHANGED, ACLS, PROBES, 'ROLLBACK;'])
run(program)
assert run("SELECT count(*) || ':' || max(version) FROM supabase_migrations.schema_migrations") == ledger_before, 'ledger changed'
assert run("SELECT to_regclass('public.commercial_delivery_reconciliations') IS NOT NULL AND to_regclass('public.commercial_adjustment_applications') IS NOT NULL") == 't', \
    'the probe must leave the applied migration exactly as it found it'
print('PASS: commercial sandbox acceptance migration upgrade, authority, worklists, reconciliation, adjustment application, immutability (rolled back)')
