"""Non-destructive upgrade probe for the commercial settlement migration (PR D).

Everything runs inside ONE transaction on the unlinked gradia-isolated-tests stack and
ends with ROLLBACK, so no database state is ever changed or destroyed. Inside it the probe
  1. removes exactly the objects 20261115120000 created, which restores the schema the
     previous migrations left behind (this migration adds objects only; it alters nothing else),
  2. seeds fictional legacy shops, memberships, a PR C billing account with a platform
     customer, PR A commercial usage and PR B membership billing evidence (coverage
     backdated so a past window is covered),
  3. applies the migration's REAL SQL text (its BEGIN/COMMIT wrapper removed so the outer
     transaction stays in control), and proves:
       * no existing shops, memberships, usage, PR A, PR B or PR C row was rewritten
         (content, xmin and physical position) and the new tables start empty,
       * function and table ACLs match the authority model (browser roles: no writer, no table),
       * only a service-role caller naming a LIVE OWNER can begin a settlement; manager, staff,
         revoked, cross-shop and non-service callers are refused,
       * open / misaligned / wrong-length windows, uncovered shops, missing accounts and customers,
         changed evidence, impossible documents and unreviewed delivery values are refused,
       * an exact replay returns the original, a changed replay conflicts, overlap conflicts,
       * the claim -> record state machine rejects out-of-order attempts and marks a stale claim
         unknown, and never hands an unknown line out again,
       * settlements, lines and events are immutable where they must be (including for the table
         owner), live mode is unrepresentable, and the tenant-deletion contract holds.
  4. rolls everything back, then confirms the ledger is exactly as before.
No credential-bearing output is printed. The literal `supabase db reset --version` +
`migration up` path is NOT used by this script.
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

NEW = '20261115120000'


def migration_body(version):
    migration = next((root / 'supabase/migrations').glob(f'{version}_*.sql'))
    text = migration.read_text().strip()
    assert text.startswith('BEGIN;') and text.endswith('COMMIT;'), 'migration must be one BEGIN..COMMIT block'
    return text[len('BEGIN;'):-len('COMMIT;')]


body = migration_body(NEW)


def top_level(sql):
    """SQL with dollar-quoted bodies removed: PL/pgSQL BEGIN/END blocks are not transaction control."""
    assert re.search(r'\$[A-Za-z_]\w*\$', sql) is None, 'named dollar quotes are not handled'
    return re.sub(r'\$\$.*?\$\$', '$$$$', sql, flags=re.S)


TXN_CONTROL = re.compile(r'(?im)^\s*(commit|rollback|begin|start\s+transaction|savepoint|release|abort|end)\b')
assert not TXN_CONTROL.search(top_level(body)), 'unexpected transaction control inside the migration'
versions = sorted(p.name.split('_')[0] for p in (root / 'supabase/migrations').glob('*.sql'))
assert versions[-1] == NEW, 'the settlement migration must be the latest migration in the repository'


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
    return f'00000000-0000-4000-8000-0000000a{n:04d}'


def S(n):
    return f'00000000-0000-4000-8000-0000000b{n:04d}'


assert run(f"SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '{NEW}'") == '1', \
    'the stack must already have the migration applied (the probe removes and re-applies it inside a transaction)'
assert run("SELECT to_regclass('public.commercial_billing_accounts') IS NOT NULL AND to_regclass('public.commercial_membership_events') IS NOT NULL") == 't', \
    'PR A/B/C schema must be present'
ledger_before = run("SELECT count(*) || ':' || max(version) FROM supabase_migrations.schema_migrations")

DROP_PR_D = """
DROP FUNCTION public.commercial_settlement_read(uuid, timestamptz, timestamptz);
DROP FUNCTION public.commercial_settlement_delivery_record(uuid, uuid, uuid, uuid, text, text);
DROP FUNCTION public.commercial_settlement_delivery_claim(uuid, uuid, uuid);
DROP FUNCTION public.commercial_settlement_begin(uuid, uuid, text, text, timestamptz, timestamptz, timestamptz, text, jsonb, text, text, jsonb, text);
DROP FUNCTION public.commercial_settlement_emit(uuid, uuid, uuid, text, uuid, jsonb);
DROP FUNCTION public.commercial_settlement_evidence(uuid, timestamptz, timestamptz, timestamptz);
DROP FUNCTION public.commercial_settlement_evidence_digest(jsonb, jsonb);
DROP TABLE public.commercial_settlement_events;
DROP TABLE public.commercial_settlement_lines;
DROP TABLE public.commercial_settlements;
DROP FUNCTION public.commercial_settlement_lines_guard();
DO $$ BEGIN
 IF to_regclass('public.commercial_settlements') IS NOT NULL
  OR to_regclass('public.commercial_settlement_lines') IS NOT NULL
  OR to_regclass('public.commercial_settlement_events') IS NOT NULL
  OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname LIKE 'commercial\\_settlement\\_%')
 THEN RAISE EXCEPTION 'Pre-PR-D schema was not restored'; END IF;
END $$;
"""

FP_SOURCES = """
   SELECT 'shop_memberships' tbl, id::text pk, to_jsonb(t)::text content, t.xmin::text x, t.ctid::text p FROM public.shop_memberships t
   UNION ALL SELECT 'shops', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.shops t
   UNION ALL SELECT 'usage_events', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.usage_events t
   UNION ALL SELECT 'commercial_usage_recognitions', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_usage_recognitions t
   UNION ALL SELECT 'commercial_usage_corrections', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_usage_corrections t
   UNION ALL SELECT 'commercial_membership_events', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_membership_events t
   UNION ALL SELECT 'commercial_membership_coverage', shop_id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_membership_coverage t
   UNION ALL SELECT 'commercial_catalog_versions', version, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_catalog_versions t
   UNION ALL SELECT 'commercial_billing_accounts', shop_id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_billing_accounts t
   UNION ALL SELECT 'commercial_checkout_attempts', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_checkout_attempts t
   UNION ALL SELECT 'commercial_billing_events', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_billing_events t
   UNION ALL SELECT 'commercial_subscription_evidence', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_subscription_evidence t
"""

BACKDATE = '2026-07-01T00:00:00Z'
SEED = f"""
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES
 ('{U(1)}','owner1@example.test',now()),('{U(2)}','manager1@example.test',now()),
 ('{U(3)}','staff1@example.test',now()),('{U(4)}','gone1@example.test',now()),
 ('{U(5)}','owner2@example.test',now()),('{U(6)}','owner3@example.test',now());
INSERT INTO public.shops(id,owner_id,name) VALUES
 ('{S(1)}','{U(1)}','Fictional legacy shop one'),('{S(2)}','{U(5)}','Fictional shop two (uncovered)'),
 ('{S(3)}','{U(6)}','Fictional shop three (no customer)');
INSERT INTO public.shop_memberships(shop_id,user_id,role,active,revoked_at,capabilities) VALUES
 ('{S(1)}','{U(2)}','manager',true,NULL,'{{}}'),
 ('{S(1)}','{U(3)}','staff',true,NULL,'{{}}'),
 ('{S(1)}','{U(4)}','manager',false,now() - interval '3 days','{{}}');
-- Shop one is covered from before the window; shop two keeps its real (creation-time) coverage.
ALTER TABLE public.commercial_membership_events DISABLE TRIGGER commercial_membership_events_append_only;
ALTER TABLE public.commercial_membership_coverage DISABLE TRIGGER commercial_membership_coverage_append_only;
UPDATE public.commercial_membership_events SET effective_at = '{BACKDATE}', recorded_at = '{BACKDATE}' WHERE shop_id = '{S(1)}';
UPDATE public.commercial_membership_coverage SET covered_from = '{BACKDATE}', recorded_at = '{BACKDATE}' WHERE shop_id = '{S(1)}';
ALTER TABLE public.commercial_membership_events ENABLE TRIGGER commercial_membership_events_append_only;
ALTER TABLE public.commercial_membership_coverage ENABLE TRIGGER commercial_membership_coverage_append_only;
-- PR A usage evidence inside the window.
INSERT INTO public.usage_events(id,shop_id,kind,quantity,credits,vendor_ref) VALUES
 ('00000000-0000-4000-8000-0000000c0001','{S(1)}','voice_minute',7,0,'legacy-call-1');
INSERT INTO public.commercial_usage_recognitions(id,shop_id,catalog_version,metric,quantity,source_kind,source_ref,workflow_key,evidence,recognized_at,idempotency_key)
 VALUES('00000000-0000-4000-8000-0000000d0001','{S(1)}','2026-11-03.v1','qualified_lead',1,'workflow_outcome','wf:legacy','wf-legacy','{{"outcome_state":"confirmed","human_completed":false}}','2026-08-15T00:00:00Z','legacy.recognition.0000000000000001');
-- PR C billing accounts: shop one and shop two have a platform customer; shop three has an account only.
DO $$
DECLARE r jsonb;
BEGIN
 PERFORM set_config('request.jwt.claims', '{{"role":"service_role"}}', true);
 r := public.commercial_checkout_begin('{S(1)}', '{U(1)}', '2026-11-03.v1', 'founder-pilot', 'gradia_founder_pilot_2026_11_monthly', 'agents', '{'a' * 64}');
 PERFORM public.commercial_checkout_bind_customer('{S(1)}', '{U(1)}', (r->>'attempt_id')::uuid, 'cus_VerifyCustomer01');
 r := public.commercial_checkout_begin('{S(2)}', '{U(5)}', '2026-11-03.v1', 'founder-pilot', 'gradia_founder_pilot_2026_11_monthly', 'agents', '{'a' * 64}');
 PERFORM public.commercial_checkout_bind_customer('{S(2)}', '{U(5)}', (r->>'attempt_id')::uuid, 'cus_VerifyCustomer02');
 r := public.commercial_checkout_begin('{S(3)}', '{U(6)}', '2026-11-03.v1', 'founder-pilot', 'gradia_founder_pilot_2026_11_monthly', 'agents', '{'a' * 64}');
END $$;
CREATE TEMP TABLE legacy_fp AS SELECT * FROM ({FP_SOURCES}) q;
"""

UNCHANGED = f"""
DO $$
DECLARE changed integer; missing integer;
BEGIN
 SELECT count(*) INTO changed FROM legacy_fp f JOIN ({FP_SOURCES}) c USING (tbl, pk)
   WHERE f.content <> c.content OR f.x <> c.x OR f.p <> c.p;
 IF changed <> 0 THEN RAISE EXCEPTION '% legacy rows were rewritten by the upgrade', changed; END IF;
 SELECT count(*) INTO missing FROM legacy_fp f WHERE NOT EXISTS (
   SELECT 1 FROM ({FP_SOURCES}) c WHERE c.tbl = f.tbl AND c.pk = f.pk);
 IF missing <> 0 THEN RAISE EXCEPTION '% legacy rows disappeared', missing; END IF;
 IF (SELECT count(*) FROM legacy_fp) <> (SELECT count(*) FROM ({FP_SOURCES}) c) THEN
  RAISE EXCEPTION 'Legacy row count changed'; END IF;
 IF EXISTS (SELECT 1 FROM public.commercial_settlements) OR EXISTS (SELECT 1 FROM public.commercial_settlement_lines)
  OR EXISTS (SELECT 1 FROM public.commercial_settlement_events)
 THEN RAISE EXCEPTION 'The upgrade must not invent settlements for existing shops'; END IF;
END $$;
"""

ACLS = """
DO $$
DECLARE r text; f text; t text;
BEGIN
 FOREACH f IN ARRAY ARRAY[
   'public.commercial_settlement_begin(uuid,uuid,text,text,timestamptz,timestamptz,timestamptz,text,jsonb,text,text,jsonb,text)',
   'public.commercial_settlement_delivery_claim(uuid,uuid,uuid)',
   'public.commercial_settlement_delivery_record(uuid,uuid,uuid,uuid,text,text)'] LOOP
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
   OR NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
   RAISE EXCEPTION 'Writer % must be executable by the service role only', f; END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY[
   'public.commercial_settlement_evidence(uuid,timestamptz,timestamptz,timestamptz)',
   'public.commercial_settlement_read(uuid,timestamptz,timestamptz)'] LOOP
  IF has_function_privilege('anon', f, 'EXECUTE')
   OR NOT has_function_privilege('authenticated', f, 'EXECUTE')
   OR NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
   RAISE EXCEPTION 'Reader % authority is wrong', f; END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY[
   'public.commercial_settlement_lines_guard()', 'public.commercial_settlement_evidence_digest(jsonb,jsonb)',
   'public.commercial_settlement_emit(uuid,uuid,uuid,text,uuid,jsonb)'] LOOP
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF has_function_privilege(r, f, 'EXECUTE') THEN RAISE EXCEPTION 'Internal helper % must not be executable by %', f, r; END IF;
  END LOOP;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['public.commercial_settlements','public.commercial_settlement_lines','public.commercial_settlement_events'] LOOP
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF has_table_privilege(r, t, 'INSERT') OR has_table_privilege(r, t, 'UPDATE')
    OR has_table_privilege(r, t, 'DELETE') OR has_table_privilege(r, t, 'TRUNCATE') THEN
    RAISE EXCEPTION 'Unsafe table write privilege on % for %', t, r; END IF;
  END LOOP;
  IF has_table_privilege('anon', t, 'SELECT') OR has_table_privilege('authenticated', t, 'SELECT')
   OR NOT has_table_privilege('service_role', t, 'SELECT') THEN
   RAISE EXCEPTION 'Table read authority wrong on %', t; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = t::regclass) THEN RAISE EXCEPTION 'RLS off on %', t; END IF;
 END LOOP;
END $$;
"""

# A valid, internally consistent document for shop one: one qualified lead ($5.00) and no extra seats.
def doc(usage=500, total=None, state='ok', seat=0):
    total = (19900 + seat + usage) if total is None else total
    comps = [
        ('confirmed_appointment', '0', 0), ('extra_operator_seat_proration', '0', seat),
        ('inbound_voice_agent_minute', '0', 0), ('qualified_lead', '1', usage),
        ('sms_segment', '0', 0), ('standard_digital_outcome', '0', 0)]
    items = ','.join(
        f'{{"component":"{c}","included_quantity":null,"recognized_quantity":null,"billed_quantity":"{q}","charge_cents":{cc}}}'
        for c, q, cc in comps)
    return (f'{{"state":"{state}","catalog_version":"2026-11-03.v1","plan_key":"founder-pilot","base_cents":19900,'
            f'"seat_cents":{seat},"usage_cents":{usage},"usage_cap_cents":10000,"total_cents":{total},"components":[{items}]}}')

W_START, W_END = '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z'
DELIVERY = ('[{"component":"qualified_lead","value_basis":"billed_quantity","event_name":"verify_fixture_qualified_lead",'
            '"event_value":"1","provider_identifier":"gradia-cb-settle-verifyfixture000000000000000000001","event_timestamp":"2026-08-31T23:59:59Z"}]')

AUTHORITY = f"""
DO $$
DECLARE ev record; who text; refused integer := 0; code text;
BEGIN
 -- A browser caller cannot execute the writer (permission denied).
 BEGIN
  PERFORM set_config('request.jwt.claims', '{{"role":"authenticated","sub":"{U(1)}"}}', true);
  PERFORM public.commercial_settlement_delivery_claim('{S(1)}', '{S(1)}', '{S(1)}');
  RAISE EXCEPTION 'An authenticated caller executed a writer';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;

 PERFORM set_config('request.jwt.claims', '{{"role":"service_role"}}', true);
 SELECT (e->>'as_of')::timestamptz AS as_of, e->>'evidence_digest' AS digest INTO ev
   FROM (SELECT public.commercial_settlement_evidence('{S(1)}','{W_START}','{W_END}',NULL) e) q;

 -- Only a LIVE OWNER of that exact shop, via the service role.
 FOREACH who IN ARRAY ARRAY['{U(2)}', '{U(3)}', '{U(4)}', '{U(5)}', '00000000-0000-4000-8000-00000000dead'] LOOP
  BEGIN
   PERFORM public.commercial_settlement_begin('{S(1)}', who::uuid, '2026-11-03.v1', 'founder-pilot', '{W_START}', '{W_END}',
     ev.as_of, ev.digest, '{doc()}'::jsonb, '{'e' * 64}', 'verify-mapping.v1', '{DELIVERY}'::jsonb, 'cset.v1.verifyfixture000000000001');
   RAISE EXCEPTION 'Actor % was allowed to settle', who;
  EXCEPTION WHEN insufficient_privilege THEN refused := refused + 1; END;
 END LOOP;
 IF refused <> 5 THEN RAISE EXCEPTION 'Expected five refusals (manager, staff, revoked, cross-shop owner, unknown); got %', refused; END IF;
 IF EXISTS (SELECT 1 FROM public.commercial_settlements) THEN RAISE EXCEPTION 'A refused caller left a settlement behind'; END IF;
END $$;
"""

REFUSALS = f"""
DO $$
DECLARE ev record; ev2 record; sqlstate_seen text;
BEGIN
 PERFORM set_config('request.jwt.claims', '{{"role":"service_role"}}', true);
 SELECT (e->>'as_of')::timestamptz AS as_of, e->>'evidence_digest' AS digest INTO ev
   FROM (SELECT public.commercial_settlement_evidence('{S(1)}','{W_START}','{W_END}',NULL) e) q;
 -- Window rules (CB422): open, evidence instant before close, misaligned, wrong length.
 BEGIN PERFORM public.commercial_settlement_begin('{S(1)}','{U(1)}','2026-11-03.v1','founder-pilot','2026-08-01T00:00:00Z','2026-08-15T00:00:00Z',ev.as_of,ev.digest,'{doc()}'::jsonb,'{'e'*64}','verify-mapping.v1','{DELIVERY}'::jsonb,'cset.v1.verifyfixture000000000001');
  RAISE EXCEPTION 'A 14-day window was accepted';
 EXCEPTION WHEN SQLSTATE 'CB422' THEN NULL; END;
 BEGIN PERFORM public.commercial_settlement_begin('{S(1)}','{U(1)}','2026-11-03.v1','founder-pilot','2026-08-01T06:00:00Z','2026-09-01T06:00:00Z',ev.as_of,ev.digest,'{doc()}'::jsonb,'{'e'*64}','verify-mapping.v1','{DELIVERY}'::jsonb,'cset.v1.verifyfixture000000000001');
  RAISE EXCEPTION 'A misaligned window was accepted';
 EXCEPTION WHEN SQLSTATE 'CB422' THEN NULL; END;
 BEGIN PERFORM public.commercial_settlement_begin('{S(1)}','{U(1)}','2026-11-03.v1','founder-pilot','{W_START}','{W_END}','2026-08-31T00:00:00Z',ev.digest,'{doc()}'::jsonb,'{'e'*64}','verify-mapping.v1','{DELIVERY}'::jsonb,'cset.v1.verifyfixture000000000001');
  RAISE EXCEPTION 'An evidence instant before the window closed was accepted';
 EXCEPTION WHEN SQLSTATE 'CB422' THEN NULL; END;
 BEGIN PERFORM public.commercial_settlement_begin('{S(1)}','{U(1)}','2026-11-03.v1','founder-pilot','2099-01-01T00:00:00Z','2099-02-01T00:00:00Z','2099-02-02T00:00:00Z',ev.digest,'{doc()}'::jsonb,'{'e'*64}','verify-mapping.v1','{DELIVERY}'::jsonb,'cset.v1.verifyfixture000000000001');
  RAISE EXCEPTION 'A window in the future was accepted';
 EXCEPTION WHEN SQLSTATE 'CB422' THEN NULL; END;
 -- Uncovered shop (coverage begins at creation), no account is never invented, account without customer.
 SELECT (e->>'as_of')::timestamptz AS as_of, e->>'evidence_digest' AS digest INTO ev2
   FROM (SELECT public.commercial_settlement_evidence('{S(2)}','{W_START}','{W_END}',NULL) e) q;
 BEGIN PERFORM public.commercial_settlement_begin('{S(2)}','{U(5)}','2026-11-03.v1','founder-pilot','{W_START}','{W_END}',ev2.as_of,ev2.digest,'{doc()}'::jsonb,'{'e'*64}','verify-mapping.v1','{DELIVERY}'::jsonb,'cset.v1.verifyfixture000000000002');
  RAISE EXCEPTION 'An uncovered window was accepted';
 EXCEPTION WHEN SQLSTATE 'CB422' THEN NULL; END;
 BEGIN PERFORM public.commercial_settlement_begin('{S(3)}','{U(6)}','2026-11-03.v1','founder-pilot','{W_START}','{W_END}',ev2.as_of,ev2.digest,'{doc()}'::jsonb,'{'e'*64}','verify-mapping.v1','{DELIVERY}'::jsonb,'cset.v1.verifyfixture000000000003');
  RAISE EXCEPTION 'A shop without a platform customer was accepted';
 EXCEPTION WHEN SQLSTATE 'CB422' THEN NULL; END;
 -- Evidence that is not the evidence on record; unapproved terms; impossible documents (22023 / CB409).
 BEGIN PERFORM public.commercial_settlement_begin('{S(1)}','{U(1)}','2026-11-03.v1','founder-pilot','{W_START}','{W_END}',ev.as_of,'{'0'*64}','{doc()}'::jsonb,'{'e'*64}','verify-mapping.v1','{DELIVERY}'::jsonb,'cset.v1.verifyfixture000000000001');
  RAISE EXCEPTION 'Wrong evidence was accepted';
 EXCEPTION WHEN SQLSTATE 'CB409' THEN NULL; END;
 BEGIN PERFORM public.commercial_settlement_begin('{S(1)}','{U(1)}','2025-01-01.v1','founder-pilot','{W_START}','{W_END}',ev.as_of,ev.digest,'{doc()}'::jsonb,'{'e'*64}','verify-mapping.v1','{DELIVERY}'::jsonb,'cset.v1.verifyfixture000000000001');
  RAISE EXCEPTION 'An unapproved catalog was accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN PERFORM public.commercial_settlement_begin('{S(1)}','{U(1)}','2026-11-03.v1','founder-pilot','{W_START}','{W_END}',ev.as_of,ev.digest,'{doc(state='cap_exceeded')}'::jsonb,'{'e'*64}','verify-mapping.v1','{DELIVERY}'::jsonb,'cset.v1.verifyfixture000000000001');
  RAISE EXCEPTION 'A non-ok document was accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN PERFORM public.commercial_settlement_begin('{S(1)}','{U(1)}','2026-11-03.v1','founder-pilot','{W_START}','{W_END}',ev.as_of,ev.digest,'{doc(total=1)}'::jsonb,'{'e'*64}','verify-mapping.v1','{DELIVERY}'::jsonb,'cset.v1.verifyfixture000000000001');
  RAISE EXCEPTION 'Inconsistent totals were accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN PERFORM public.commercial_settlement_begin('{S(1)}','{U(1)}','2026-11-03.v1','founder-pilot','{W_START}','{W_END}',ev.as_of,ev.digest,'{doc(usage=20000)}'::jsonb,'{'e'*64}','verify-mapping.v1','{DELIVERY}'::jsonb,'cset.v1.verifyfixture000000000001');
  RAISE EXCEPTION 'Usage over the one combined cap was accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN PERFORM public.commercial_settlement_begin('{S(1)}','{U(1)}','2026-11-03.v1','founder-pilot','{W_START}','{W_END}',ev.as_of,ev.digest,'{doc()}'::jsonb,'{'e'*64}','verify-mapping.v1','{DELIVERY.replace('"event_value":"1"', '"event_value":"9"')}'::jsonb,'cset.v1.verifyfixture000000000001');
  RAISE EXCEPTION 'A delivery value that differs from the settled quantity was accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN PERFORM public.commercial_settlement_begin('{S(1)}','{U(1)}','2026-11-03.v1','founder-pilot','{W_START}','{W_END}',ev.as_of,ev.digest,'{doc()}'::jsonb,'{'e'*64}','verify-mapping.v1','[]'::jsonb,'cset.v1.verifyfixture000000000001');
  RAISE EXCEPTION 'A charged component without a delivery was accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN PERFORM public.commercial_settlement_begin('{S(1)}','{U(1)}','2026-11-03.v1','founder-pilot','{W_START}','{W_END}',ev.as_of,ev.digest,'{doc()}'::jsonb,'{'e'*64}','verify-mapping.v1','{DELIVERY.replace('qualified_lead', 'model_invented_metric')}'::jsonb,'cset.v1.verifyfixture000000000001');
  RAISE EXCEPTION 'A delivery for an invented component was accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 IF EXISTS (SELECT 1 FROM public.commercial_settlements) THEN RAISE EXCEPTION 'A refused request left a settlement behind'; END IF;
END $$;
"""

LIFECYCLE = f"""
DO $$
DECLARE ev record; r jsonb; r2 jsonb; sid uuid; lead_line uuid; c jsonb; tok uuid;
BEGIN
 PERFORM set_config('request.jwt.claims', '{{"role":"service_role"}}', true);
 SELECT (e->>'as_of')::timestamptz AS as_of, e->>'evidence_digest' AS digest INTO ev
   FROM (SELECT public.commercial_settlement_evidence('{S(1)}','{W_START}','{W_END}',NULL) e) q;
 r := public.commercial_settlement_begin('{S(1)}','{U(1)}','2026-11-03.v1','founder-pilot','{W_START}','{W_END}',ev.as_of,ev.digest,'{doc()}'::jsonb,'{'e'*64}','verify-mapping.v1','{DELIVERY}'::jsonb,'cset.v1.verifyfixture000000000001');
 IF r->>'action' <> 'created' THEN RAISE EXCEPTION 'First begin should create: %', r; END IF;
 sid := (r->>'settlement_id')::uuid;
 SELECT id INTO lead_line FROM public.commercial_settlement_lines WHERE settlement_id = sid AND component = 'qualified_lead';
 IF (SELECT count(*) FROM public.commercial_settlement_lines WHERE settlement_id = sid) <> 6 THEN RAISE EXCEPTION 'Six components expected'; END IF;
 IF (SELECT count(*) FROM public.commercial_settlement_lines WHERE settlement_id = sid AND delivery_status = 'pending') <> 1 THEN
  RAISE EXCEPTION 'Only the charged component is delivered'; END IF;
 -- Exact replay returns the original; a changed replay conflicts; an overlapping window conflicts.
 r2 := public.commercial_settlement_begin('{S(1)}','{U(1)}','2026-11-03.v1','founder-pilot','{W_START}','{W_END}',ev.as_of,ev.digest,'{doc()}'::jsonb,'{'e'*64}','verify-mapping.v1','{DELIVERY}'::jsonb,'cset.v1.verifyfixture000000000001');
 IF r2->>'action' <> 'replay' OR (r2->>'settlement_id')::uuid <> sid THEN RAISE EXCEPTION 'Replay should return the original: %', r2; END IF;
 BEGIN PERFORM public.commercial_settlement_begin('{S(1)}','{U(1)}','2026-11-03.v1','founder-pilot','{W_START}','{W_END}',ev.as_of,ev.digest,'{doc()}'::jsonb,'{'f'*64}','verify-mapping.v1','{DELIVERY}'::jsonb,'cset.v1.verifyfixture000000000001');
  RAISE EXCEPTION 'A changed replay was accepted';
 EXCEPTION WHEN SQLSTATE 'CB409' THEN NULL; END;
 BEGIN PERFORM public.commercial_settlement_begin('{S(1)}','{U(1)}','2026-11-03.v1','founder-pilot','2026-08-10T00:00:00Z','2026-09-09T00:00:00Z',ev.as_of,ev.digest,'{doc()}'::jsonb,'{'e'*64}','verify-mapping.v1','{DELIVERY}'::jsonb,'cset.v1.verifyfixture000000000009');
  RAISE EXCEPTION 'An overlapping window was accepted';
 EXCEPTION WHEN SQLSTATE 'CB409' THEN NULL; END;
 IF (SELECT count(*) FROM public.commercial_settlements) <> 1 THEN RAISE EXCEPTION 'Exactly one settlement expected'; END IF;

 -- Claim -> record: out of order is refused, a live claim is not handed out twice.
 tok := gen_random_uuid();
 BEGIN PERFORM public.commercial_settlement_delivery_record('{S(1)}', sid, lead_line, tok, 'delivered', NULL);
  RAISE EXCEPTION 'Recording before claiming was accepted';
 EXCEPTION WHEN SQLSTATE 'CB409' THEN NULL; END;
 c := public.commercial_settlement_delivery_claim('{S(1)}', sid, lead_line);
 IF c->>'action' <> 'claimed' OR c->>'stripe_customer_id' <> 'cus_VerifyCustomer01' OR c->>'event_value' <> '1' THEN
  RAISE EXCEPTION 'Claim payload wrong: %', c; END IF;
 IF public.commercial_settlement_delivery_claim('{S(1)}', sid, lead_line)->>'action' <> 'in_progress' THEN
  RAISE EXCEPTION 'A live claim was handed out twice'; END IF;
 BEGIN PERFORM public.commercial_settlement_delivery_record('{S(1)}', sid, lead_line, tok, 'delivered', NULL);
  RAISE EXCEPTION 'A wrong claim token was accepted';
 EXCEPTION WHEN SQLSTATE 'CB409' THEN NULL; END;
 BEGIN PERFORM public.commercial_settlement_delivery_claim('{S(2)}', sid, lead_line);
  RAISE EXCEPTION 'A claim across tenants was accepted';
 EXCEPTION WHEN SQLSTATE 'CB409' THEN NULL; END;
 -- Age the claim: an abandoned claim becomes unknown and is never handed out again.
 ALTER TABLE public.commercial_settlement_lines DISABLE TRIGGER commercial_settlement_lines_guard;
 UPDATE public.commercial_settlement_lines SET claimed_at = clock_timestamp() - interval '130 seconds' WHERE id = lead_line;
 ALTER TABLE public.commercial_settlement_lines ENABLE TRIGGER commercial_settlement_lines_guard;
 c := public.commercial_settlement_delivery_claim('{S(1)}', sid, lead_line);
 IF c->>'action' <> 'blocked' OR c->>'failure_code' <> 'stale_in_flight' THEN RAISE EXCEPTION 'A stale claim should be unknown: %', c; END IF;
 IF public.commercial_settlement_delivery_claim('{S(1)}', sid, lead_line)->>'action' <> 'blocked' THEN
  RAISE EXCEPTION 'An unknown line was handed out again'; END IF;
 BEGIN PERFORM public.commercial_settlement_delivery_record('{S(1)}', sid, lead_line, (c->>'claim_token')::uuid, 'delivered', NULL);
  RAISE EXCEPTION 'A late outcome was recorded over an unknown line';
 EXCEPTION WHEN SQLSTATE 'CB409' THEN NULL; END;
 IF (SELECT count(*) FROM public.commercial_settlement_events WHERE settlement_id = sid) <> 3 THEN
  RAISE EXCEPTION 'Expected created, claimed and stale events'; END IF;
 IF (SELECT array_agg(shop_seq ORDER BY shop_seq) FROM public.commercial_settlement_events WHERE shop_id = '{S(1)}') <> ARRAY[1,2,3]::bigint[] THEN
  RAISE EXCEPTION 'The event sequence must be gapless'; END IF;
 -- No account or subscription state was touched by settlement.
 IF (SELECT state FROM public.commercial_billing_accounts WHERE shop_id = '{S(1)}') = 'active' THEN
  RAISE EXCEPTION 'Settlement must never make an account active'; END IF;
END $$;
"""

IMMUTABLE = f"""
DO $$
DECLARE sid uuid;
BEGIN
 SELECT id INTO sid FROM public.commercial_settlements WHERE shop_id = '{S(1)}';
 BEGIN UPDATE public.commercial_settlements SET total_cents = 1 WHERE id = sid; RAISE EXCEPTION 'settlement updated';
 EXCEPTION WHEN insufficient_privilege OR check_violation THEN NULL; END;
 BEGIN DELETE FROM public.commercial_settlements WHERE id = sid; RAISE EXCEPTION 'settlement deleted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN TRUNCATE public.commercial_settlements CASCADE; RAISE EXCEPTION 'settlement truncated';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN TRUNCATE public.commercial_settlement_lines; RAISE EXCEPTION 'lines truncated';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN TRUNCATE public.commercial_settlement_events; RAISE EXCEPTION 'events truncated';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE public.commercial_settlement_events SET kind = 'settlement_created' WHERE shop_id = '{S(1)}'; RAISE EXCEPTION 'event updated';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN DELETE FROM public.commercial_settlement_events WHERE shop_id = '{S(1)}'; RAISE EXCEPTION 'event deleted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE public.commercial_settlement_lines SET charge_cents = 1 WHERE settlement_id = sid; RAISE EXCEPTION 'line amount updated';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE public.commercial_settlement_lines SET delivery_status = 'pending', claim_token = NULL WHERE settlement_id = sid AND delivery_status = 'unknown';
  RAISE EXCEPTION 'line status moved backwards';
 EXCEPTION WHEN insufficient_privilege OR check_violation THEN NULL; END;
 BEGIN UPDATE public.commercial_settlements SET provider_mode = 'live' WHERE id = sid; RAISE EXCEPTION 'live mode accepted';
 EXCEPTION WHEN insufficient_privilege OR check_violation THEN NULL; END;
 BEGIN PERFORM public.commercial_settlement_emit('{S(1)}', sid, NULL, 'delivery_delivered', NULL, '{{"x":"https://example.test/a"}}'::jsonb);
  RAISE EXCEPTION 'a URL was accepted in event details';
 EXCEPTION WHEN check_violation THEN NULL; END;
 -- Tenant deletion cascades (the existing contract); nothing else removes evidence.
 DELETE FROM public.shops WHERE id = '{S(1)}';
 IF EXISTS (SELECT 1 FROM public.commercial_settlements WHERE shop_id = '{S(1)}')
  OR EXISTS (SELECT 1 FROM public.commercial_settlement_lines WHERE shop_id = '{S(1)}')
  OR EXISTS (SELECT 1 FROM public.commercial_settlement_events WHERE shop_id = '{S(1)}')
 THEN RAISE EXCEPTION 'Tenant deletion left settlement evidence behind'; END IF;
END $$;
"""

probe = f"""
BEGIN;
{DROP_PR_D}
{SEED}
{body}
{UNCHANGED}
{ACLS}
{AUTHORITY}
{REFUSALS}
{LIFECYCLE}
{IMMUTABLE}
SELECT 'PROBE_OK';
ROLLBACK;
"""
out = run(probe)
assert out.splitlines()[-1] == 'PROBE_OK', 'probe did not complete'

# Nothing persisted, and the migration is still applied exactly as before.
assert run("SELECT count(*) || ':' || max(version) FROM supabase_migrations.schema_migrations") == ledger_before
assert run("SELECT to_regclass('public.commercial_settlements') IS NOT NULL") == 't', 'migration must still be applied after rollback'
assert run(f"SELECT count(*) FROM public.shops WHERE id = '{S(1)}'") == '0', 'probe fixtures must not persist'
print('PASS: commercial settlement upgrade verified in a rolled-back transaction')
