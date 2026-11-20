"""Non-destructive upgrade probe for the commercial subscription polling migration (PR F3).

Everything runs inside ONE transaction on the unlinked gradia-isolated-tests stack and ends with ROLLBACK, so no database
state is ever changed or destroyed. Inside it the probe
  1. removes exactly what 20261119120000 added or replaced: the poll functions and tables, the three widened closed sets, the
     `subscription_poll` lease row, and it RESTORES the PR E1 versions of `commercial_subscription_apply_evidence` and
     `commercial_execution_gate` from the E1 migration's own text (with their ACLs),
  2. seeds fictional legacy shops (a webhook-established active subscription whose verified period has elapsed, an open Checkout
     session, a sticky catalog mismatch) and fingerprints them (content, xmin, physical position),
  3. applies the migration's REAL SQL text (BEGIN/COMMIT removed so the outer transaction controls it) and proves:
       * no existing row was rewritten; the lease table gains exactly the one idle `subscription_poll` row,
       * function and table ACLs (browser roles: nothing; service role: three functions, SELECT only on the tables; the guard
         function is executable by nobody; the two replaced functions keep their service-role-only ACL),
       * the single evidence writer: `provider_poll` is accepted ONLY with a required verified period, an unknown source and live
         mode are still refused, and a poll can NEVER clear a sticky integrity block (a `reviewed_reconciliation` source still can),
       * the claim: tenant, customer, known subscription and Checkout attempt come from server rows; a live claim holds the shop;
         canceled / sticky / unconfigured accounts are not claimable; an expired claim is superseded and counts as a failure,
       * the record: one observation per claim (replay returns the stored result, changed content is CB409), a foreign or made-up
         claim records nothing, a customer that is not the bound one is refused, a metadata shop id that names another shop blocks
         ONLY the customer's own shop, a never-seen subscription is accepted only through the server-held session, an elapsed or
         unverified period is never active, polled active evidence opens the lapse gate only with a verified period,
       * the rate limit and backoff (15 minutes, doubling to a 6 hour cap; 6 hours for a healthy long period),
       * browser roles are refused, observations are append-only, the schedule cannot be deleted/truncated/renamed or have its
         counter lowered, and the overview returns counts only,
  4. rolls everything back, then confirms the ledger is exactly as before.
`--mutate sticky|tenant` weakens the migration text on purpose and the probe MUST then FAIL (proof the probes bite).
No credential-bearing output is printed. The literal `supabase db reset --version` path is NOT used.
"""
from pathlib import Path
import os
import re
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
project = 'gradia-isolated-tests'
config = root / 'tests/supabase/config.toml'
assert f'project_id = "{project}"' in config.read_text() and 'env(' not in config.read_text()
assert not (root / '.local-tools/supabase-test/supabase/.temp/project-ref').exists(), 'remote links forbidden'

NEW = '20261119120000'
E1 = '20261116140000'
mutation = sys.argv[sys.argv.index('--mutate') + 1] if '--mutate' in sys.argv else None
assert mutation in (None, 'sticky', 'tenant')


def migration_text(version):
    return next((root / 'supabase/migrations').glob(f'{version}_*.sql')).read_text()


text = migration_text(NEW).strip()
assert text.startswith('BEGIN;') and text.endswith('COMMIT;'), 'migration must be one BEGIN..COMMIT block'
body = text[len('BEGIN;'):-len('COMMIT;')]
if mutation == 'sticky':
    assert body.count("p_source <> 'reviewed_reconciliation'") == 2
    body = body.replace("p_source <> 'reviewed_reconciliation'", "p_source NOT IN ('reviewed_reconciliation', 'provider_poll')")
elif mutation == 'tenant':
    assert body.count("v_facts ->> 'metadata_shop_id' <> p_shop::text") == 1
    body = body.replace("v_facts ->> 'metadata_shop_id' <> p_shop::text", "false")


def top_level(sql):
    assert re.search(r'\$[A-Za-z_]\w*\$', sql) is None, 'named dollar quotes are not handled'
    return re.sub(r'\$\$.*?\$\$', '$$$$', sql, flags=re.S)


TXN_CONTROL = re.compile(r'(?im)^\s*(commit|rollback|begin|start\s+transaction|savepoint|release|abort|end)\b')
assert not TXN_CONTROL.search(top_level(body)), 'unexpected transaction control inside the migration'
versions = sorted(p.name.split('_')[0] for p in (root / 'supabase/migrations').glob('*.sql'))
assert NEW in versions, 'the polling migration must be present in the repository'


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


assert run(f"SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '{NEW}'") == '1', \
    'the stack must already have the migration applied (the probe removes and re-applies it inside a transaction)'
assert run("SELECT to_regprocedure('public.commercial_subscription_apply_evidence(uuid,text,text,text,text,text,text,text,text,timestamptz,boolean,uuid,timestamptz,timestamptz,timestamptz,boolean,timestamptz,boolean)') IS NOT NULL "
           "AND to_regclass('public.commercial_worker_leases') IS NOT NULL") == 't', 'PR E1 and PR F2 schema must be present'
ledger_before = run("SELECT count(*) || ':' || max(version) FROM supabase_migrations.schema_migrations")

# ---------------------------------------------------------------------------------------------------------------------
# 1. Restore the pre-F3 schema: drop what F3 added, restore what F3 replaced from the E1 migration's own text.
# ---------------------------------------------------------------------------------------------------------------------
e1 = migration_text(E1)


def e1_function(name):
    start = e1.index(f'CREATE FUNCTION public.{name}(')
    return e1[start:e1.index('END $$;', start) + len('END $$;')]


E1_EVIDENCE_KINDS = e1[e1.index('ALTER TABLE public.commercial_billing_events ADD CONSTRAINT'):]
E1_EVIDENCE_KINDS = E1_EVIDENCE_KINDS[:E1_EVIDENCE_KINDS.index(';') + 1]
WRITER_SIG = 'public.commercial_subscription_apply_evidence(uuid, text, text, text, text, text, text, text, text, timestamptz, boolean, uuid, timestamptz, timestamptz, timestamptz, boolean, timestamptz, boolean)'

REMOVE_NEW = f"""
DROP FUNCTION public.commercial_subscription_poll_overview();
DROP FUNCTION public.commercial_subscription_poll_record(uuid, uuid, jsonb);
DROP FUNCTION public.commercial_subscription_poll_claim(uuid, integer);
DROP TABLE public.commercial_subscription_poll_observations;
DROP TABLE public.commercial_subscription_poll_schedule;
DROP FUNCTION public.commercial_subscription_poll_schedule_guard();

ALTER TABLE public.commercial_worker_leases DISABLE TRIGGER commercial_worker_leases_guard;
DELETE FROM public.commercial_worker_leases WHERE worker = 'subscription_poll';
ALTER TABLE public.commercial_worker_leases ENABLE TRIGGER commercial_worker_leases_guard;
ALTER TABLE public.commercial_worker_leases DROP CONSTRAINT commercial_worker_leases_worker_check;
ALTER TABLE public.commercial_worker_leases ADD CONSTRAINT commercial_worker_leases_worker_check
  CHECK (worker IN ('settlement_dispatch', 'delivery_reconcile', 'adjustment_apply'));

ALTER TABLE public.commercial_subscription_evidence DROP CONSTRAINT commercial_subscription_evidence_evidence_source_check;
ALTER TABLE public.commercial_subscription_evidence ADD CONSTRAINT commercial_subscription_evidence_evidence_source_check
  CHECK (evidence_source IN ('signed_webhook', 'reviewed_reconciliation'));
ALTER TABLE public.commercial_billing_events DROP CONSTRAINT commercial_billing_events_kind_check;
{E1_EVIDENCE_KINDS}

DROP FUNCTION {WRITER_SIG};
DROP FUNCTION public.commercial_execution_gate(uuid);
{e1_function('commercial_subscription_apply_evidence')}
{e1_function('commercial_execution_gate')}
REVOKE ALL ON FUNCTION {WRITER_SIG}, public.commercial_execution_gate(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION {WRITER_SIG}, public.commercial_execution_gate(uuid) TO service_role;

DO $$ BEGIN
 IF to_regclass('public.commercial_subscription_poll_schedule') IS NOT NULL OR to_regclass('public.commercial_subscription_poll_observations') IS NOT NULL
  OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname LIKE 'commercial\\_subscription\\_poll%')
  OR EXISTS (SELECT 1 FROM public.commercial_worker_leases WHERE worker = 'subscription_poll')
  OR pg_get_functiondef('public.commercial_execution_gate(uuid)'::regprocedure) LIKE '%provider_poll%'
  OR pg_get_functiondef('{WRITER_SIG}'::regprocedure) LIKE '%provider_poll%'
 THEN RAISE EXCEPTION 'Pre-PR-F3 schema was not restored'; END IF;
END $$;
"""

FP_SOURCES = """
   SELECT 'shops' tbl, id::text pk, to_jsonb(t)::text content, t.xmin::text x, t.ctid::text p FROM public.shops t
   UNION ALL SELECT 'commercial_billing_accounts', shop_id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_billing_accounts t
   UNION ALL SELECT 'commercial_checkout_attempts', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_checkout_attempts t
   UNION ALL SELECT 'commercial_subscription_evidence', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_subscription_evidence t
   UNION ALL SELECT 'commercial_subscription_periods', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_subscription_periods t
   UNION ALL SELECT 'commercial_webhook_receipts', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_webhook_receipts t
   UNION ALL SELECT 'commercial_provider_facts', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_provider_facts t
   UNION ALL SELECT 'commercial_billing_events', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_billing_events t
   UNION ALL SELECT 'commercial_worker_leases', worker, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_worker_leases t
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
-- The facts a poll hands the database (same shape as the signed-webhook normalizer).
CREATE FUNCTION pg_temp.facts(sub text, cust text, status text, ps timestamptz, pe timestamptz, started timestamptz,
  meta_shop text DEFAULT NULL, lookup text DEFAULT 'gradia_founder_pilot_2026_11_monthly') RETURNS jsonb
LANGUAGE sql AS $$
  SELECT jsonb_build_object('object', 'subscription', 'subscription_id', sub, 'customer_id', cust, 'status', status,
    'catalog_version', '2026-11-03.v1', 'plan_key', 'founder-pilot', 'metadata_shop_id', meta_shop, 'checkout_attempt_id', NULL,
    'price_lookup_key', lookup, 'period_start', ps, 'period_end', pe, 'started_at', started, 'cancel_at_period_end', false, 'canceled_at', NULL)
$$;
CREATE FUNCTION pg_temp.sub_obs(cust text, f jsonb, d text, session_sub text DEFAULT NULL) RETURNS jsonb
LANGUAGE sql AS $$ SELECT jsonb_build_object('kind', 'subscription', 'customer_id', cust, 'session_subscription_id', session_sub, 'digest', repeat(d, 64), 'facts', f) $$;
CREATE FUNCTION pg_temp.none_obs(cust text, cls text, code text, d text) RETURNS jsonb
LANGUAGE sql AS $$ SELECT jsonb_build_object('kind', 'none', 'customer_id', cust, 'class', cls, 'code', code, 'digest', repeat(d, 64)) $$;
CREATE FUNCTION pg_temp.due(shop uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.commercial_subscription_poll_schedule SET next_due_at = clock_timestamp() - interval '1 minute' WHERE shop_id = shop;
END $$;
"""
JWT_SERVICE = "SELECT set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true);"


def jwt(role, sub=None):
    claims = '{"role":"%s"%s}' % (role, (',"sub":"%s"' % sub) if sub else '')
    return f"SELECT set_config('request.jwt.claims', '{claims}', true);"


CAT = "'2026-11-03.v1', 'founder-pilot'"
LOOKUP = "'gradia_founder_pilot_2026_11_monthly'"
SUB1 = 'sub_VerifySub0001'
C1, C2, C3, C4 = 'cus_VerifyCustomer01', 'cus_VerifyCustomer02', 'cus_VerifyCustomer03', 'cus_VerifyCustomer04'

SEED = f"""
{FAILS}
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES
 ('{U(1)}','owner1@example.test',now()),('{U(2)}','owner2@example.test',now()),('{U(3)}','owner3@example.test',now()),
 ('{U(4)}','owner4@example.test',now()),('{U(5)}','owner5@example.test',now());
INSERT INTO public.shops(id,owner_id,name) VALUES ('{S(1)}','{U(1)}','Fictional shop one'),('{S(2)}','{U(2)}','Fictional shop two'),
 ('{S(3)}','{U(3)}','Fictional shop three'),('{S(4)}','{U(4)}','Fictional shop four'),('{S(5)}','{U(5)}','Fictional shop five (no billing)');
DO $$
DECLARE r jsonb;
BEGIN
 PERFORM set_config('request.jwt.claims', '{{"role":"service_role"}}', true);
 -- S1: a webhook-established ACTIVE subscription whose verified period ELAPSED (webhooks stopped).
 r := public.commercial_checkout_begin('{S(1)}', '{U(1)}', {CAT}, {LOOKUP}, 'agents', '{'a' * 64}');
 PERFORM public.commercial_checkout_bind_customer('{S(1)}', '{U(1)}', (r->>'attempt_id')::uuid, '{C1}');
 PERFORM public.commercial_subscription_apply_evidence('{S(1)}', '{SUB1}', '{C1}', 'active', '2026-11-03.v1', 'founder-pilot', {LOOKUP},
   'signed_webhook', 'evt_verify_s1_000001', now() - interval '10 days', false, NULL,
   now() - interval '40 days', now() - interval '10 days', now() - interval '40 days', false, NULL, true);
 -- S2: an open Checkout session, no subscription evidence yet.
 r := public.commercial_checkout_begin('{S(2)}', '{U(2)}', {CAT}, {LOOKUP}, 'agents', '{'b' * 64}');
 PERFORM public.commercial_checkout_bind_customer('{S(2)}', '{U(2)}', (r->>'attempt_id')::uuid, '{C2}');
 PERFORM public.commercial_checkout_record_session('{S(2)}', '{U(2)}', (r->>'attempt_id')::uuid, 'cs_test_VerifySession02');
 -- S3: a sticky catalog mismatch.
 r := public.commercial_checkout_begin('{S(3)}', '{U(3)}', {CAT}, {LOOKUP}, 'agents', '{'c' * 64}');
 PERFORM public.commercial_checkout_bind_customer('{S(3)}', '{U(3)}', (r->>'attempt_id')::uuid, '{C3}');
 PERFORM public.commercial_subscription_apply_evidence('{S(3)}', 'sub_VerifySub0003', '{C3}', 'active', '2026-11-03.v1', 'founder-pilot', 'some_other_price',
   'signed_webhook', 'evt_verify_s3_000001', now() - interval '2 days', false, NULL,
   now() - interval '2 days', now() + interval '28 days', now() - interval '2 days', false, NULL, true);
 -- S4: a second open Checkout session (used for first-seen subscription binding).
 r := public.commercial_checkout_begin('{S(4)}', '{U(4)}', {CAT}, {LOOKUP}, 'agents', '{'d' * 64}');
 PERFORM public.commercial_checkout_bind_customer('{S(4)}', '{U(4)}', (r->>'attempt_id')::uuid, '{C4}');
 PERFORM public.commercial_checkout_record_session('{S(4)}', '{U(4)}', (r->>'attempt_id')::uuid, 'cs_test_VerifySession04');
END $$;
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
 -- The only new row anywhere is the one idle lease row.
 IF (SELECT count(*) FROM ({FP_SOURCES}) c) <> (SELECT count(*) FROM legacy_fp) + 1 THEN RAISE EXCEPTION 'Unexpected row count change'; END IF;
 IF (SELECT array_agg(worker ORDER BY worker) FROM public.commercial_worker_leases) <> ARRAY['adjustment_apply','delivery_reconcile','settlement_dispatch','subscription_poll']
  OR EXISTS (SELECT 1 FROM public.commercial_worker_leases WHERE worker = 'subscription_poll' AND (holder_token IS NOT NULL OR lease_until IS NOT NULL OR generation <> 0))
 THEN RAISE EXCEPTION 'The upgrade must add exactly the one idle subscription_poll worker row'; END IF;
 IF EXISTS (SELECT 1 FROM public.commercial_subscription_poll_schedule) OR EXISTS (SELECT 1 FROM public.commercial_subscription_poll_observations)
 THEN RAISE EXCEPTION 'The upgrade must not backfill any poll row'; END IF;
END $$;
"""

ACLS = """
DO $$
DECLARE r text; f text; t text;
BEGIN
 FOREACH f IN ARRAY ARRAY[
   'public.commercial_subscription_poll_claim(uuid,integer)',
   'public.commercial_subscription_poll_record(uuid,uuid,jsonb)',
   'public.commercial_subscription_poll_overview()',
   'public.commercial_subscription_apply_evidence(uuid,text,text,text,text,text,text,text,text,timestamptz,boolean,uuid,timestamptz,timestamptz,timestamptz,boolean,timestamptz,boolean)',
   'public.commercial_execution_gate(uuid)'] LOOP
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
   OR NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
   RAISE EXCEPTION 'Function % must be executable by the service role only', f; END IF;
 END LOOP;
 IF has_function_privilege('service_role', 'public.commercial_subscription_poll_schedule_guard()', 'EXECUTE')
  OR has_function_privilege('authenticated', 'public.commercial_subscription_poll_schedule_guard()', 'EXECUTE')
  OR has_function_privilege('anon', 'public.commercial_subscription_poll_schedule_guard()', 'EXECUTE') THEN
  RAISE EXCEPTION 'The schedule guard must not be executable'; END IF;
 FOREACH t IN ARRAY ARRAY['public.commercial_subscription_poll_schedule', 'public.commercial_subscription_poll_observations'] LOOP
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF has_table_privilege(r, t, 'INSERT') OR has_table_privilege(r, t, 'UPDATE') OR has_table_privilege(r, t, 'DELETE') OR has_table_privilege(r, t, 'TRUNCATE') THEN
    RAISE EXCEPTION 'Unsafe table write privilege for % on %', r, t; END IF;
  END LOOP;
  IF has_table_privilege('anon', t, 'SELECT') OR has_table_privilege('authenticated', t, 'SELECT') OR NOT has_table_privilege('service_role', t, 'SELECT') THEN
   RAISE EXCEPTION 'Table read authority wrong on %', t; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = t::regclass) THEN RAISE EXCEPTION 'RLS off on %', t; END IF;
 END LOOP;
END $$;
"""

PROBES = f"""
-- ===== browser roles are refused =====
{jwt('authenticated', U(1))}
DO $$
BEGIN
 PERFORM pg_temp.fails($q$SELECT public.commercial_subscription_poll_claim('{S(1)}')$q$, '42501');
 PERFORM pg_temp.fails($q$SELECT public.commercial_subscription_poll_record('{S(1)}', '{U(1)}', '{{}}'::jsonb)$q$, '42501');
 PERFORM pg_temp.fails($q$SELECT public.commercial_subscription_poll_overview()$q$, '42501');
END $$;
{jwt('anon')}
DO $$
BEGIN
 PERFORM pg_temp.fails($q$SELECT public.commercial_subscription_poll_claim('{S(1)}')$q$, '42501');
 PERFORM pg_temp.fails($q$SELECT public.commercial_subscription_poll_overview()$q$, '42501');
END $$;

-- ===== the single evidence writer =====
{JWT_SERVICE}
DO $$
DECLARE r jsonb; before_state text;
BEGIN
 -- A polled source must require a verified period, and unknown sources / live mode are still refused.
 PERFORM pg_temp.fails($q$SELECT public.commercial_subscription_apply_evidence('{S(1)}', '{SUB1}', '{C1}', 'active', '2026-11-03.v1', 'founder-pilot', {LOOKUP},
   'provider_poll', 'poll_verify_noperiod_01', now(), false, NULL, NULL, NULL, NULL, NULL, NULL, false)$q$, '22023');
 PERFORM pg_temp.fails($q$SELECT public.commercial_subscription_apply_evidence('{S(1)}', '{SUB1}', '{C1}', 'active', '2026-11-03.v1', 'founder-pilot', {LOOKUP},
   'provider_poll', 'poll_verify_default_01', now(), false)$q$, '22023');
 PERFORM pg_temp.fails($q$SELECT public.commercial_subscription_apply_evidence('{S(1)}', '{SUB1}', '{C1}', 'active', '2026-11-03.v1', 'founder-pilot', {LOOKUP},
   'polling', 'poll_verify_badsrc_001', now(), false, NULL, NULL, NULL, NULL, NULL, NULL, true)$q$, '22023');
 PERFORM pg_temp.fails($q$SELECT public.commercial_subscription_apply_evidence('{S(1)}', '{SUB1}', '{C1}', 'active', '2026-11-03.v1', 'founder-pilot', {LOOKUP},
   'provider_poll', 'poll_verify_live_00001', now(), true, NULL, now(), now() + interval '30 days', now(), NULL, NULL, true)$q$, '22023');
 -- A poll can NEVER clear a sticky integrity block: it is recorded but blocked; only a reviewed source clears it.
 before_state := (SELECT state || ':' || state_reason FROM public.commercial_billing_accounts WHERE shop_id = '{S(3)}');
 IF before_state <> 'reconciliation_required:catalog_mismatch' THEN RAISE EXCEPTION 'fixture: S3 must be sticky, got %', before_state; END IF;
 r := public.commercial_subscription_apply_evidence('{S(3)}', 'sub_VerifySub0003', '{C3}', 'active', '2026-11-03.v1', 'founder-pilot', {LOOKUP},
   'provider_poll', 'poll_verify_sticky_0001', now() - interval '1 minute', false, NULL,
   now() - interval '2 days', now() + interval '28 days', now() - interval '2 days', false, NULL, true);
 IF (r->>'advanced')::boolean OR r->>'reason' <> 'blocked_pending_review' THEN RAISE EXCEPTION 'a poll must not clear a sticky block: %', r; END IF;
 IF (SELECT state FROM public.commercial_billing_accounts WHERE shop_id = '{S(3)}') <> 'reconciliation_required' THEN RAISE EXCEPTION 'S3 must stay blocked'; END IF;
 -- The gate keeps S3 blocked, and the reviewed path still clears it (unchanged behavior).
 IF (public.commercial_execution_gate('{S(3)}')->>'allowed')::boolean THEN RAISE EXCEPTION 'the gate must stay closed for a sticky block'; END IF;
 r := public.commercial_subscription_apply_evidence('{S(3)}', 'sub_VerifySub0003', '{C3}', 'active', '2026-11-03.v1', 'founder-pilot', {LOOKUP},
   'reviewed_reconciliation', 'evt_verify_s3_review1', now(), false, NULL,
   now() - interval '2 days', now() + interval '28 days', now() - interval '2 days', false, NULL, true);
 IF NOT (r->>'advanced')::boolean OR (SELECT state FROM public.commercial_billing_accounts WHERE shop_id = '{S(3)}') <> 'active' THEN
  RAISE EXCEPTION 'a reviewed reconciliation must still clear the block: %', r; END IF;
END $$;

-- ===== the claim =====
DO $$
DECLARE c jsonb; c2 jsonb;
BEGIN
 c := public.commercial_subscription_poll_claim('{S(1)}');
 IF NOT (c->>'claimed')::boolean OR c->>'shop_id' <> '{S(1)}' OR c->>'customer_id' <> '{C1}' OR c->>'known_subscription_id' <> '{SUB1}'
    OR c->>'attempt_id' IS NOT NULL OR c->>'state' <> 'active' THEN RAISE EXCEPTION 'claim S1 must carry server-held values: %', c; END IF;
 IF extract(epoch FROM (c->>'requested_at')::timestamptz - (c->>'observed_at')::timestamptz) NOT BETWEEN 299 AND 301 THEN
  RAISE EXCEPTION 'observed_at must be claim time minus the 5 minute skew margin'; END IF;
 c2 := public.commercial_subscription_poll_claim('{S(1)}');
 IF (c2->>'claimed')::boolean THEN RAISE EXCEPTION 'a live claim must hold the shop'; END IF;
 -- never claimable: sticky (before review it was; now cleared => claimable again), no billing account, no scope
 IF (public.commercial_subscription_poll_claim('{S(5)}')->>'claimed')::boolean THEN RAISE EXCEPTION 'a shop with no billing account is not claimable'; END IF;
 c2 := public.commercial_subscription_poll_claim('{S(2)}');
 IF NOT (c2->>'claimed')::boolean OR c2->>'known_subscription_id' IS NOT NULL OR c2->>'session_id' <> 'cs_test_VerifySession02' OR c2->>'attempt_id' IS NULL THEN
  RAISE EXCEPTION 'claim S2 must carry the server-held session: %', c2; END IF;
 IF (SELECT claim_token FROM public.commercial_subscription_poll_schedule WHERE shop_id = '{S(2)}') <> (c2->>'claim_token')::uuid THEN
  RAISE EXCEPTION 'the claim must be persisted'; END IF;
END $$;

-- ===== a renewal that no webhook delivered: record, replay, ordering, gate =====
DO $$
DECLARE c jsonb; r jsonb; again jsonb; tok uuid; ev_before integer; ev_id uuid; sched record;
BEGIN
 -- S1 holds a live claim from above.
 SELECT claim_token INTO tok FROM public.commercial_subscription_poll_schedule WHERE shop_id = '{S(1)}';
 IF (public.commercial_execution_gate('{S(1)}')->>'reason') <> 'subscription_period_elapsed' THEN RAISE EXCEPTION 'S1 starts lapsed'; END IF;
 ev_before := (SELECT count(*) FROM public.commercial_subscription_evidence WHERE shop_id = '{S(1)}');
 r := public.commercial_subscription_poll_record('{S(1)}', tok, pg_temp.sub_obs('{C1}',
   pg_temp.facts('{SUB1}', '{C1}', 'active', now() - interval '10 days', now() + interval '20 days', now() - interval '40 days', '{S(1)}'), '1'));
 IF r->>'outcome' <> 'applied' OR (r->>'replayed')::boolean OR r->>'state' <> 'active' THEN RAISE EXCEPTION 'renewal must apply: %', r; END IF;
 ev_id := (r->>'evidence_id')::uuid;
 IF (SELECT evidence_source || ':' || left(source_event_id, 5) || ':' || derived_state FROM public.commercial_subscription_evidence WHERE id = ev_id) <> 'provider_poll:poll_:active' THEN
  RAISE EXCEPTION 'polled evidence must carry the poll source'; END IF;
 IF (SELECT source_event_created_at FROM public.commercial_subscription_evidence WHERE id = ev_id) > now() - interval '4 minutes' THEN
  RAISE EXCEPTION 'polled evidence must be ordered at claim time minus the skew margin'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.commercial_subscription_periods WHERE shop_id = '{S(1)}' AND period_end > now() + interval '19 days') THEN
  RAISE EXCEPTION 'the verified period must be recorded for settlement binding'; END IF;
 IF NOT (public.commercial_execution_gate('{S(1)}')->>'allowed')::boolean THEN RAISE EXCEPTION 'polled, verified active evidence must open the gate'; END IF;
 -- replay: stored result, no second row; changed content: CB409
 again := public.commercial_subscription_poll_record('{S(1)}', tok, pg_temp.sub_obs('{C1}',
   pg_temp.facts('{SUB1}', '{C1}', 'active', now() - interval '10 days', now() + interval '20 days', now() - interval '40 days', '{S(1)}'), '1'));
 IF again->>'outcome' <> 'applied' OR NOT (again->>'replayed')::boolean THEN RAISE EXCEPTION 'an identical replay must return the stored result: %', again; END IF;
  PERFORM pg_temp.fails(format($q$SELECT public.commercial_subscription_poll_record(%L, %L::uuid, pg_temp.none_obs(%L, 'ambiguous', 'list_incomplete', '9'))$q$,
   '{S(1)}', tok, '{C1}'), 'CB409');
 IF (SELECT count(*) FROM public.commercial_subscription_poll_observations WHERE shop_id = '{S(1)}') <> 1
    OR (SELECT count(*) FROM public.commercial_subscription_evidence WHERE shop_id = '{S(1)}') <> ev_before + 1 THEN
  RAISE EXCEPTION 'replay and changed content must write nothing more'; END IF;
 -- the rate limit: not due again for hours (healthy, long period); the claim was cleared; the counter moved
 SELECT * INTO sched FROM public.commercial_subscription_poll_schedule WHERE shop_id = '{S(1)}';
 IF sched.claim_token IS NOT NULL OR sched.polls_total <> 1 OR sched.last_outcome <> 'applied' OR sched.consecutive_failures <> 0
    OR sched.next_due_at < now() + interval '5 hours' OR sched.next_due_at > now() + interval '6 hours 1 minute' THEN
  RAISE EXCEPTION 'healthy long-period shops back off to 6 hours: %', row_to_json(sched); END IF;
 IF (public.commercial_subscription_poll_claim('{S(1)}')->>'claimed')::boolean THEN RAISE EXCEPTION 'a polled shop must not be due again'; END IF;
END $$;
"""
PROBES += f"""
-- ===== ambiguity, ordering and tenant binding =====
DO $$
DECLARE c jsonb; r jsonb; tok uuid; ev_before integer; acct_before text; s2 text; s1_before text;
BEGIN
 -- S1: an `active` whose period has already elapsed (or is unverified) is ambiguous, never applied.
 PERFORM pg_temp.due('{S(1)}');
 c := public.commercial_subscription_poll_claim('{S(1)}'); tok := (c->>'claim_token')::uuid;
 ev_before := (SELECT count(*) FROM public.commercial_subscription_evidence WHERE shop_id = '{S(1)}');
 acct_before := (SELECT to_jsonb(a)::text FROM public.commercial_billing_accounts a WHERE shop_id = '{S(1)}');
 r := public.commercial_subscription_poll_record('{S(1)}', tok, pg_temp.sub_obs('{C1}',
   pg_temp.facts('{SUB1}', '{C1}', 'active', now() - interval '40 days', now() - interval '2 days', now() - interval '40 days'), '2'));
 IF r->>'outcome' <> 'ambiguous' OR r->>'reason' <> 'period_elapsed' THEN RAISE EXCEPTION 'an elapsed period is never active: %', r; END IF;
 PERFORM pg_temp.due('{S(1)}');
 c := public.commercial_subscription_poll_claim('{S(1)}'); tok := (c->>'claim_token')::uuid;
 r := public.commercial_subscription_poll_record('{S(1)}', tok, pg_temp.sub_obs('{C1}',
   pg_temp.facts('{SUB1}', '{C1}', 'active', NULL, NULL, NULL), '3'));
 IF r->>'outcome' <> 'ambiguous' OR r->>'reason' <> 'period_not_verified' THEN RAISE EXCEPTION 'an unverified period is never active: %', r; END IF;
 IF acct_before <> (SELECT to_jsonb(a)::text FROM public.commercial_billing_accounts a WHERE shop_id = '{S(1)}')
    OR ev_before <> (SELECT count(*) FROM public.commercial_subscription_evidence WHERE shop_id = '{S(1)}') THEN
  RAISE EXCEPTION 'ambiguous observations must change nothing'; END IF;
 -- the failure streak backs the interval off (15 min, then 30 min)
 IF (SELECT consecutive_failures FROM public.commercial_subscription_poll_schedule WHERE shop_id = '{S(1)}') <> 2 THEN RAISE EXCEPTION 'failure streak'; END IF;
 IF (SELECT next_due_at FROM public.commercial_subscription_poll_schedule WHERE shop_id = '{S(1)}') NOT BETWEEN now() + interval '29 minutes' AND now() + interval '31 minutes' THEN
  RAISE EXCEPTION 'the second consecutive failure must wait 30 minutes'; END IF;

 -- A customer that is not the server-held binding is refused and changes nothing.
 PERFORM pg_temp.due('{S(1)}');
 c := public.commercial_subscription_poll_claim('{S(1)}'); tok := (c->>'claim_token')::uuid;
 r := public.commercial_subscription_poll_record('{S(1)}', tok, pg_temp.sub_obs('{C2}',
   pg_temp.facts('{SUB1}', '{C2}', 'past_due', now() - interval '10 days', now() + interval '20 days', now() - interval '40 days'), '4'));
 IF r->>'outcome' <> 'refused' OR r->>'reason' <> 'customer_mismatch' THEN RAISE EXCEPTION 'foreign customer must be refused: %', r; END IF;
 IF acct_before <> (SELECT to_jsonb(a)::text FROM public.commercial_billing_accounts a WHERE shop_id = '{S(1)}') THEN RAISE EXCEPTION 'S1 must be unchanged'; END IF;

 -- Another shop's claim token (or a made-up one) can record nothing.
 PERFORM pg_temp.fails(format($q$SELECT public.commercial_subscription_poll_record(%L, %L::uuid, pg_temp.none_obs(%L, 'no_subscription', 'nothing_to_compare', '5'))$q$,
   '{S(2)}', tok, '{C2}'), 'CB409');
 PERFORM pg_temp.fails($q$SELECT public.commercial_subscription_poll_record('{S(1)}', '{U(9)}', pg_temp.none_obs('{C1}', 'no_subscription', 'nothing_to_compare', '5'))$q$, 'CB409');

 -- Metadata never chooses the tenant: S2's observation names S1 in metadata; ONLY S2 is blocked, S1 untouched.
 s1_before := (SELECT to_jsonb(a)::text FROM public.commercial_billing_accounts a WHERE shop_id = '{S(1)}');
 SELECT claim_token INTO tok FROM public.commercial_subscription_poll_schedule WHERE shop_id = '{S(2)}';
 r := public.commercial_subscription_poll_record('{S(2)}', tok, pg_temp.sub_obs('{C2}',
   pg_temp.facts('sub_VerifySub0002', '{C2}', 'active', now() - interval '1 day', now() + interval '29 days', now() - interval '1 day', '{S(1)}'), '6', 'sub_VerifySub0002'));
 IF r->>'outcome' <> 'refused' OR r->>'reason' <> 'tenant_conflict' THEN RAISE EXCEPTION 'metadata disagreement must be refused: %', r; END IF;
 s2 := (SELECT state || ':' || state_reason FROM public.commercial_billing_accounts WHERE shop_id = '{S(2)}');
 IF s2 <> 'reconciliation_required:tenant_conflict' THEN RAISE EXCEPTION 'the customer''s own shop must be blocked, got %', s2; END IF;
 IF s1_before <> (SELECT to_jsonb(a)::text FROM public.commercial_billing_accounts a WHERE shop_id = '{S(1)}') THEN
  RAISE EXCEPTION 'the shop the metadata named must be untouched'; END IF;
 IF EXISTS (SELECT 1 FROM public.commercial_subscription_evidence WHERE shop_id = '{S(2)}') THEN RAISE EXCEPTION 'a refused observation writes no evidence'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.commercial_billing_events WHERE shop_id = '{S(2)}' AND kind = 'subscription_poll_conflict')
    OR EXISTS (SELECT 1 FROM public.commercial_billing_events WHERE shop_id = '{S(1)}' AND kind = 'subscription_poll_conflict') THEN
  RAISE EXCEPTION 'the conflict is audited on the customer''s own shop only'; END IF;
 -- S2 is now sticky: it is no longer claimable at all.
 PERFORM pg_temp.due('{S(2)}');
 IF (public.commercial_subscription_poll_claim('{S(2)}')->>'claimed')::boolean THEN RAISE EXCEPTION 'a sticky shop must not be polled'; END IF;
END $$;

-- ===== a never-seen subscription is accepted only through the server-held session =====
DO $$
DECLARE c jsonb; r jsonb; tok uuid; att uuid;
BEGIN
 c := public.commercial_subscription_poll_claim('{S(4)}'); tok := (c->>'claim_token')::uuid; att := (c->>'attempt_id')::uuid;
 IF c->>'known_subscription_id' IS NOT NULL OR att IS NULL OR c->>'session_id' <> 'cs_test_VerifySession04' THEN RAISE EXCEPTION 'S4 claim: %', c; END IF;
 -- the provider listed a subscription but the server-held session did not name it: ambiguous, nothing adopted
 r := public.commercial_subscription_poll_record('{S(4)}', tok, pg_temp.sub_obs('{C4}',
   pg_temp.facts('sub_VerifySub0004', '{C4}', 'active', now() - interval '1 day', now() + interval '29 days', now() - interval '1 day'), '7'));
 IF r->>'outcome' <> 'ambiguous' OR r->>'reason' <> 'subscription_unbound' THEN RAISE EXCEPTION 'an unbound subscription must not be adopted: %', r; END IF;
 IF EXISTS (SELECT 1 FROM public.commercial_subscription_evidence WHERE shop_id = '{S(4)}') THEN RAISE EXCEPTION 'nothing may be adopted'; END IF;
 -- the session named exactly it: applied through the single writer with the SERVER's attempt
 PERFORM pg_temp.due('{S(4)}');
 c := public.commercial_subscription_poll_claim('{S(4)}'); tok := (c->>'claim_token')::uuid;
 r := public.commercial_subscription_poll_record('{S(4)}', tok, pg_temp.sub_obs('{C4}',
   pg_temp.facts('sub_VerifySub0004', '{C4}', 'active', now() - interval '1 day', now() + interval '29 days', now() - interval '1 day'), '8', 'sub_VerifySub0004'));
 IF r->>'outcome' <> 'applied' THEN RAISE EXCEPTION 'a session-named subscription must apply: %', r; END IF;
 IF (SELECT attempt_id FROM public.commercial_subscription_evidence WHERE shop_id = '{S(4)}') <> att THEN RAISE EXCEPTION 'the attempt must be the server-held one'; END IF;
 IF (SELECT state FROM public.commercial_billing_accounts WHERE shop_id = '{S(4)}') <> 'active' THEN RAISE EXCEPTION 'S4 must be active'; END IF;
END $$;

-- ===== expiry, supersession and unreadable observations =====
DO $$
DECLARE c jsonb; r jsonb; dead uuid; live uuid;
BEGIN
 PERFORM pg_temp.due('{S(1)}');
 c := public.commercial_subscription_poll_claim('{S(1)}'); dead := (c->>'claim_token')::uuid;
 UPDATE public.commercial_subscription_poll_schedule SET claim_until = clock_timestamp() - interval '1 second' WHERE shop_id = '{S(1)}';
 PERFORM pg_temp.fails(format($q$SELECT public.commercial_subscription_poll_record(%L, %L::uuid, pg_temp.none_obs(%L, 'no_subscription', 'nothing_to_compare', 'a'))$q$,
   '{S(1)}', dead, '{C1}'), 'CB409');
 c := public.commercial_subscription_poll_claim('{S(1)}'); live := (c->>'claim_token')::uuid;
 IF NOT (c->>'claimed')::boolean OR live = dead THEN RAISE EXCEPTION 'an expired claim must be superseded'; END IF;
 IF (SELECT consecutive_failures FROM public.commercial_subscription_poll_schedule WHERE shop_id = '{S(1)}') <> 4 THEN RAISE EXCEPTION 'an abandoned claim counts as a failed poll (3 earlier failures + 1)'; END IF;
 PERFORM pg_temp.fails(format($q$SELECT public.commercial_subscription_poll_record(%L, %L::uuid, pg_temp.none_obs(%L, 'no_subscription', 'nothing_to_compare', 'b'))$q$,
   '{S(1)}', dead, '{C1}'), 'CB409');
 -- unreadable: recorded, backs off (4 prior failures -> the 5th waits 15 min x 2^4 = 4 hours), changes nothing
 r := public.commercial_subscription_poll_record('{S(1)}', live, jsonb_build_object('kind', 'unreadable', 'customer_id', '{C1}', 'code', 'provider_unreadable', 'digest', repeat('c', 64)));
 IF r->>'outcome' <> 'unreadable' THEN RAISE EXCEPTION 'unreadable: %', r; END IF;
 IF (SELECT next_due_at FROM public.commercial_subscription_poll_schedule WHERE shop_id = '{S(1)}') NOT BETWEEN now() + interval '239 minutes' AND now() + interval '241 minutes' THEN
  RAISE EXCEPTION 'the fifth consecutive failure must wait 4 hours'; END IF;
 -- the cap: many failures never exceed 6 hours
 UPDATE public.commercial_subscription_poll_schedule SET consecutive_failures = 40 WHERE shop_id = '{S(1)}';
 PERFORM pg_temp.due('{S(1)}');
 c := public.commercial_subscription_poll_claim('{S(1)}'); live := (c->>'claim_token')::uuid;
 PERFORM public.commercial_subscription_poll_record('{S(1)}', live, jsonb_build_object('kind', 'unreadable', 'customer_id', '{C1}', 'code', 'provider_unreadable', 'digest', repeat('d', 64)));
 IF (SELECT next_due_at FROM public.commercial_subscription_poll_schedule WHERE shop_id = '{S(1)}') > now() + interval '6 hours 1 minute' THEN
  RAISE EXCEPTION 'the backoff is capped at six hours'; END IF;
 -- finite, secret-free columns: a code that is not a finite lowercase token is refused (and writes nothing)
 PERFORM pg_temp.due('{S(1)}');
 c := public.commercial_subscription_poll_claim('{S(1)}'); live := (c->>'claim_token')::uuid;
 PERFORM pg_temp.fails(format($q$SELECT public.commercial_subscription_poll_record(%L, %L::uuid, jsonb_build_object('kind', 'unreadable', 'customer_id', %L, 'code', 'https://x', 'digest', repeat('e', 64)))$q$,
   '{S(1)}', live, '{C1}'), '23514');
END $$;

-- ===== the lease row, the overview and immutability =====
DO $$
DECLARE a jsonb; ov jsonb;
BEGIN
 a := public.commercial_worker_lease_acquire('subscription_poll', 60);
 IF NOT (a->>'acquired')::boolean THEN RAISE EXCEPTION 'the poll worker can be leased: %', a; END IF;
 IF NOT (public.commercial_worker_lease_release('subscription_poll', (a->>'token')::uuid, 'completed')->>'released')::boolean THEN RAISE EXCEPTION 'and released'; END IF;
 PERFORM pg_temp.fails($q$SELECT public.commercial_worker_lease_acquire('evil_worker', 60)$q$, '22023');
 IF jsonb_array_length(public.commercial_worker_lease_read()) <> 4 THEN RAISE EXCEPTION 'four workers expected'; END IF;
 ov := public.commercial_subscription_poll_overview();
 IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(ov) k) <> ARRAY['claimed','due','eligible','failing','never_polled','oldest_last_observed_at','outcomes_24h','overdue'] THEN
  RAISE EXCEPTION 'the overview must return counts only: %', ov; END IF;
 IF ov::text ~ '(cus_|sub_|[0-9a-f]{{8}}-[0-9a-f]{{4}}-4)' THEN RAISE EXCEPTION 'the overview must carry no identifier'; END IF;
END $$;
DO $$
BEGIN
 PERFORM pg_temp.fails($q$UPDATE public.commercial_subscription_poll_observations SET outcome = 'unchanged'$q$, '42501');
 PERFORM pg_temp.fails($q$DELETE FROM public.commercial_subscription_poll_observations$q$, '42501');
 PERFORM pg_temp.fails($q$TRUNCATE public.commercial_subscription_poll_observations$q$, '42501');
 PERFORM pg_temp.fails($q$DELETE FROM public.commercial_subscription_poll_schedule$q$, '42501');
 PERFORM pg_temp.fails($q$TRUNCATE public.commercial_subscription_poll_schedule$q$, '42501');
 PERFORM pg_temp.fails($q$UPDATE public.commercial_subscription_poll_schedule SET shop_id = '{S(5)}' WHERE shop_id = '{S(1)}'$q$, '42501');
 PERFORM pg_temp.fails($q$UPDATE public.commercial_subscription_poll_schedule SET polls_total = 0 WHERE shop_id = '{S(1)}'$q$, '42501');
 PERFORM pg_temp.fails($q$UPDATE public.commercial_subscription_poll_schedule SET claim_until = NULL WHERE shop_id = '{S(1)}'$q$, '23514'); -- S1 holds a live claim: half a claim is refused
 PERFORM pg_temp.fails($q$INSERT INTO public.commercial_subscription_poll_observations (shop_id, claim_token, requested_at, observed_at, provider_customer_id, outcome, reason, observation_digest)
   VALUES ('{S(1)}', gen_random_uuid(), now(), now(), '{C1}', 'applied', 'https://x', repeat('f', 64))$q$, '23514');
 PERFORM pg_temp.fails($q$INSERT INTO public.commercial_subscription_poll_observations (shop_id, claim_token, requested_at, observed_at, provider_customer_id, outcome, observation_digest)
   VALUES ('{S(1)}', gen_random_uuid(), now(), now(), '{C1}', 'paid_in_full', repeat('f', 64))$q$, '23514');
END $$;
-- Deleting a shop (the only permitted removal) takes its poll rows with it and nothing else's.
DO $$
DECLARE n_obs_other integer;
BEGIN
 n_obs_other := (SELECT count(*) FROM public.commercial_subscription_poll_observations WHERE shop_id <> '{S(4)}');
 DELETE FROM public.shops WHERE id = '{S(4)}';
 IF EXISTS (SELECT 1 FROM public.commercial_subscription_poll_observations WHERE shop_id = '{S(4)}')
    OR EXISTS (SELECT 1 FROM public.commercial_subscription_poll_schedule WHERE shop_id = '{S(4)}') THEN RAISE EXCEPTION 'cascade must remove the shop''s poll rows'; END IF;
 IF n_obs_other <> (SELECT count(*) FROM public.commercial_subscription_poll_observations) THEN RAISE EXCEPTION 'cascade must not touch other shops'; END IF;
END $$;
"""

program = '\n'.join(['BEGIN;', REMOVE_NEW, SEED, body, UNCHANGED, ACLS, PROBES, 'ROLLBACK;'])
try:
    run(program)
except SystemExit as failure:
    if mutation:
        print(f'EXPECTED FAIL under mutation `{mutation}`: {failure}')
        sys.exit(0)
    raise
if mutation:
    raise SystemExit(f'FAIL: mutation `{mutation}` was NOT detected by the probes')
assert run("SELECT count(*) || ':' || max(version) FROM supabase_migrations.schema_migrations") == ledger_before, 'ledger changed'
assert run("SELECT to_regclass('public.commercial_subscription_poll_schedule') IS NOT NULL") == 't', \
    'the probe must leave the applied migration exactly as it found it'
print('PASS: commercial subscription polling migration upgrade, authority, claim/record, ordering, tenant binding, backoff, immutability (rolled back)')
