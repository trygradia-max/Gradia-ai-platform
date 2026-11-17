"""Non-destructive upgrade probe for the commercial reconciliation migration (PR E1).

Everything runs inside ONE transaction on the unlinked gradia-isolated-tests stack and ends with
ROLLBACK, so no database state is ever changed or destroyed. Inside it the probe
  1. removes exactly what 20261116140000 added or replaced and restores the PR C subscription-evidence
     writer and the PR D settlement functions from their own migration text, which recreates the
     schema the earlier migrations left behind,
  2. seeds fictional legacy shops, memberships, PR C billing accounts with a platform customer and a
     legacy active evidence row, PR A usage and PR D settlement data,
  3. applies the migration's REAL SQL text (BEGIN/COMMIT wrapper removed so the outer transaction stays
     in control) and proves:
       * no existing row was rewritten (content of the original columns, xmin and physical position)
         and every new table starts empty,
       * function and table ACLs match the authority model (browser roles: nothing; service role:
         writers by function only),
       * signed-event ingest: durable replay, changed-content conflict, tenant resolution only from
         bound customers/subscriptions/attempts, metadata cross-check, out-of-order and terminal rules,
         period recording, duplicate-subscription blocking, provider facts without any state change,
       * the lapse gate (legacy shop allowed, every non-active state blocked),
       * Customer Portal authority (live owner only),
       * settlement refuses any window that is not an exact verified period,
       * the adjustment contract (one decision, no applied state, settlement untouched),
       * append-only tables, live mode unrepresentable, and the tenant-deletion cascade.
  4. rolls everything back, then confirms the ledger is exactly as before.
No credential-bearing output is printed. The literal `supabase db reset --version` + `migration up`
path is NOT used by this script.
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

NEW = '20261116140000'
PR_C = '20261106120000'
PR_D = '20261115130000'


def migration_text(version):
    return next((root / 'supabase/migrations').glob(f'{version}_*.sql')).read_text()


def migration_body(version):
    text = migration_text(version).strip()
    assert text.startswith('BEGIN;') and text.endswith('COMMIT;'), 'migration must be one BEGIN..COMMIT block'
    return text[len('BEGIN;'):-len('COMMIT;')]


def function_block(text, name, replace=False):
    start = text.index(f'CREATE FUNCTION public.{name}(')
    end = text.index('END $$;', start) + len('END $$;')
    block = text[start:end]
    return block.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION', 1) if replace else block


body = migration_body(NEW)


def top_level(sql):
    assert re.search(r'\$[A-Za-z_]\w*\$', sql) is None, 'named dollar quotes are not handled'
    return re.sub(r'\$\$.*?\$\$', '$$$$', sql, flags=re.S)


TXN_CONTROL = re.compile(r'(?im)^\s*(commit|rollback|begin|start\s+transaction|savepoint|release|abort|end)\b')
assert not TXN_CONTROL.search(top_level(body)), 'unexpected transaction control inside the migration'
versions = sorted(p.name.split('_')[0] for p in (root / 'supabase/migrations').glob('*.sql'))
assert versions[-1] == NEW, 'the reconciliation migration must be the latest migration in the repository'


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
    return f'00000000-0000-4000-8000-0000000e{n:04d}'


def S(n):
    return f'00000000-0000-4000-8000-0000000f{n:04d}'


assert run(f"SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '{NEW}'") == '1', \
    'the stack must already have the migration applied (the probe removes and re-applies it inside a transaction)'
assert run("SELECT to_regclass('public.commercial_settlements') IS NOT NULL AND to_regclass('public.commercial_billing_accounts') IS NOT NULL") == 't', \
    'PR A/B/C/D schema must be present'
ledger_before = run("SELECT count(*) || ':' || max(version) FROM supabase_migrations.schema_migrations")

SIG18 = 'uuid, text, text, text, text, text, text, text, text, timestamptz, boolean, uuid, timestamptz, timestamptz, timestamptz, boolean, timestamptz, boolean'
OLD_KINDS = ("'account_opened', 'checkout_attempt_started', 'customer_bound', 'session_created', 'session_observed_open', "
             "'session_completed_unverified', 'session_expired', 'attempt_rejected', 'provider_outcome_unknown', "
             "'stale_attempt_marked_unknown', 'subscription_evidence_applied', 'subscription_evidence_not_current', 'reconciliation_required'")

pr_c_text = migration_text(PR_C)
pr_d_text = migration_text(PR_D)
RESTORE_PR_E_PREVIOUS = f"""
DROP FUNCTION public.commercial_adjustment_read(uuid);
DROP FUNCTION public.commercial_adjustment_review(uuid, uuid, text, text, text);
DROP FUNCTION public.commercial_adjustment_propose(uuid, uuid, text, bigint, text, uuid, text, text);
DROP FUNCTION public.commercial_webhook_ingest(text, text, timestamptz, text, boolean, jsonb);
DROP FUNCTION public.commercial_portal_authorize(uuid, uuid, text);
DROP FUNCTION public.commercial_execution_gate(uuid);
DROP FUNCTION public.commercial_subscription_period_status(uuid, timestamptz, timestamptz);
DROP FUNCTION public.commercial_subscription_apply_evidence({SIG18});
DROP TABLE public.commercial_adjustment_reviews;
DROP TABLE public.commercial_settlement_adjustments;
DROP TABLE public.commercial_provider_facts;
DROP TABLE public.commercial_webhook_receipts;
DROP TABLE public.commercial_subscription_periods;
DROP FUNCTION public.commercial_subscription_periods_guard();
ALTER TABLE public.commercial_subscription_evidence DROP CONSTRAINT commercial_subscription_evidence_period_check;
ALTER TABLE public.commercial_subscription_evidence
  DROP COLUMN subscription_started_at, DROP COLUMN period_start, DROP COLUMN period_end,
  DROP COLUMN cancel_at_period_end, DROP COLUMN canceled_at, DROP COLUMN derived_reason;
ALTER TABLE public.commercial_billing_events DROP CONSTRAINT commercial_billing_events_kind_check;
ALTER TABLE public.commercial_billing_events ADD CONSTRAINT commercial_billing_events_kind_check CHECK (kind IN ({OLD_KINDS}));
{function_block(pr_c_text, 'commercial_subscription_apply_evidence')}
REVOKE ALL ON FUNCTION public.commercial_subscription_apply_evidence(uuid, text, text, text, text, text, text, text, text, timestamptz, boolean, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commercial_subscription_apply_evidence(uuid, text, text, text, text, text, text, text, text, timestamptz, boolean, uuid) TO service_role;
{function_block(pr_d_text, 'commercial_settlement_evidence', replace=True)}
{function_block(pr_d_text, 'commercial_settlement_begin', replace=True)}
DO $$ BEGIN
 IF to_regclass('public.commercial_webhook_receipts') IS NOT NULL OR to_regclass('public.commercial_subscription_periods') IS NOT NULL
  OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname IN ('commercial_webhook_ingest', 'commercial_execution_gate', 'commercial_portal_authorize'))
  OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'commercial_subscription_evidence' AND column_name = 'period_start')
 THEN RAISE EXCEPTION 'Pre-PR-E1 schema was not restored'; END IF;
END $$;
"""

EVIDENCE_ORIGINAL_COLUMNS = ("'subscription_started_at', 'period_start', 'period_end', 'cancel_at_period_end', 'canceled_at', 'derived_reason'")
FP_SOURCES = f"""
   SELECT 'shop_memberships' tbl, id::text pk, to_jsonb(t)::text content, t.xmin::text x, t.ctid::text p FROM public.shop_memberships t
   UNION ALL SELECT 'shops', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.shops t
   UNION ALL SELECT 'usage_events', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.usage_events t
   UNION ALL SELECT 'commercial_usage_recognitions', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_usage_recognitions t
   UNION ALL SELECT 'commercial_membership_events', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_membership_events t
   UNION ALL SELECT 'commercial_billing_accounts', shop_id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_billing_accounts t
   UNION ALL SELECT 'commercial_checkout_attempts', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_checkout_attempts t
   UNION ALL SELECT 'commercial_billing_events', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_billing_events t
   UNION ALL SELECT 'commercial_subscription_evidence', id::text, (to_jsonb(t) - 'subscription_started_at' - 'period_start' - 'period_end' - 'cancel_at_period_end' - 'canceled_at' - 'derived_reason')::text, t.xmin::text, t.ctid::text FROM public.commercial_subscription_evidence t
   UNION ALL SELECT 'commercial_settlements', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_settlements t
"""

JWT_SERVICE = "SELECT set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true);"
def jwt(role, sub=None):
    claims = '{"role":"%s"%s}' % (role, (',"sub":"%s"' % sub) if sub else '')
    return f"SELECT set_config('request.jwt.claims', '{claims}', true);"

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

CAT = "'2026-11-03.v1', 'founder-pilot'"
LOOKUP = "'gradia_founder_pilot_2026_11_monthly'"
SEED = f"""
{FAILS}
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES
 ('{U(1)}','owner1@example.test',now()),('{U(2)}','manager1@example.test',now()),
 ('{U(3)}','staff1@example.test',now()),('{U(4)}','gone1@example.test',now()),
 ('{U(5)}','owner2@example.test',now()),('{U(6)}','owner3@example.test',now()),('{U(7)}','owner4@example.test',now());
INSERT INTO public.shops(id,owner_id,name) VALUES
 ('{S(1)}','{U(1)}','Fictional legacy shop one'),('{S(2)}','{U(5)}','Fictional shop two'),
 ('{S(3)}','{U(6)}','Fictional shop three (account only)'),('{S(4)}','{U(7)}','Fictional shop four (no billing)');
INSERT INTO public.shop_memberships(shop_id,user_id,role,active,revoked_at,capabilities) VALUES
 ('{S(1)}','{U(2)}','manager',true,NULL,'{{}}'),('{S(1)}','{U(3)}','staff',true,NULL,'{{}}'),
 ('{S(1)}','{U(4)}','manager',false,now() - interval '3 days','{{}}');
INSERT INTO public.usage_events(id,shop_id,kind,quantity,credits,vendor_ref) VALUES
 ('00000000-0000-4000-8000-0000000c1001','{S(1)}','voice_minute',7,0,'legacy-call-e1');
-- PR C billing: shops one and two have a customer + an open session; shop three has an account only.
DO $$
DECLARE r jsonb;
BEGIN
 PERFORM set_config('request.jwt.claims', '{{"role":"service_role"}}', true);
 r := public.commercial_checkout_begin('{S(1)}', '{U(1)}', {CAT}, {LOOKUP}, 'agents', '{'a' * 64}');
 PERFORM public.commercial_checkout_bind_customer('{S(1)}', '{U(1)}', (r->>'attempt_id')::uuid, 'cus_VerifyCustomer01');
 PERFORM public.commercial_checkout_record_session('{S(1)}', '{U(1)}', (r->>'attempt_id')::uuid, 'cs_test_VerifySession01');
 r := public.commercial_checkout_begin('{S(2)}', '{U(5)}', {CAT}, {LOOKUP}, 'agents', '{'a' * 64}');
 PERFORM public.commercial_checkout_bind_customer('{S(2)}', '{U(5)}', (r->>'attempt_id')::uuid, 'cus_VerifyCustomer02');
 PERFORM public.commercial_checkout_record_session('{S(2)}', '{U(5)}', (r->>'attempt_id')::uuid, 'cs_test_VerifySession02');
 r := public.commercial_checkout_begin('{S(3)}', '{U(6)}', {CAT}, {LOOKUP}, 'agents', '{'a' * 64}');
 -- Legacy (pre-E1) active evidence for shop one: reviewed source, NO period.
 PERFORM public.commercial_subscription_apply_evidence('{S(1)}', 'sub_VerifySub0001', 'cus_VerifyCustomer01', 'active',
   '2026-11-03.v1', 'founder-pilot', {LOOKUP}, 'reviewed_reconciliation', 'evt_legacy_active_0001', '2026-07-31T00:00:00Z', false, NULL);
END $$;
-- A PR D settlement that predates the upgrade (window Aug 2026).
INSERT INTO public.commercial_settlements (id, shop_id, catalog_version, plan_key, window_start, window_end, as_of, evidence_digest, document_digest,
  document, base_cents, seat_cents, usage_cents, usage_cap_cents, total_cents, mapping_version, stripe_customer_id, account_version, requested_by, idempotency_key)
VALUES ('00000000-0000-4000-8000-0000000a1001', '{S(1)}', '2026-11-03.v1', 'founder-pilot', '2026-08-01Z', '2026-09-01Z', '2026-09-02Z',
  repeat('a',64), repeat('b',64), '{{}}'::jsonb, 19900, 0, 0, 10000, 19900, 'verify-fixture', 'cus_VerifyCustomer01', 1, '{U(1)}', 'cset.v1.legacyverifyfixture0001');
CREATE TEMP TABLE legacy_fp AS SELECT * FROM ({FP_SOURCES}) q;
"""

UNCHANGED = f"""
DO $$
DECLARE changed integer; missing integer;
BEGIN
 SELECT count(*) INTO changed FROM legacy_fp f JOIN ({FP_SOURCES}) c USING (tbl, pk)
   WHERE f.content <> c.content OR f.x <> c.x OR f.p <> c.p;
 IF changed <> 0 THEN RAISE EXCEPTION '% legacy rows were rewritten by the upgrade', changed; END IF;
 SELECT count(*) INTO missing FROM legacy_fp f WHERE NOT EXISTS (SELECT 1 FROM ({FP_SOURCES}) c WHERE c.tbl = f.tbl AND c.pk = f.pk);
 IF missing <> 0 THEN RAISE EXCEPTION '% legacy rows disappeared', missing; END IF;
 IF (SELECT count(*) FROM legacy_fp) <> (SELECT count(*) FROM ({FP_SOURCES}) c) THEN RAISE EXCEPTION 'Legacy row count changed'; END IF;
 IF EXISTS (SELECT 1 FROM public.commercial_webhook_receipts) OR EXISTS (SELECT 1 FROM public.commercial_provider_facts)
  OR EXISTS (SELECT 1 FROM public.commercial_subscription_periods) OR EXISTS (SELECT 1 FROM public.commercial_settlement_adjustments)
  OR EXISTS (SELECT 1 FROM public.commercial_adjustment_reviews)
 THEN RAISE EXCEPTION 'The upgrade must not invent receipts, facts, periods or adjustments'; END IF;
 IF EXISTS (SELECT 1 FROM public.commercial_subscription_evidence WHERE period_start IS NOT NULL OR subscription_started_at IS NOT NULL OR derived_reason IS NOT NULL)
 THEN RAISE EXCEPTION 'Legacy evidence must keep NULL period fields'; END IF;
END $$;
"""

ACLS = """
DO $$
DECLARE r text; f text; t text;
BEGIN
 FOREACH f IN ARRAY ARRAY[
   'public.commercial_webhook_ingest(text,text,timestamptz,text,boolean,jsonb)',
   'public.commercial_execution_gate(uuid)',
   'public.commercial_portal_authorize(uuid,uuid,text)',
   'public.commercial_subscription_period_status(uuid,timestamptz,timestamptz)',
   'public.commercial_adjustment_propose(uuid,uuid,text,bigint,text,uuid,text,text)',
   'public.commercial_adjustment_review(uuid,uuid,text,text,text)',
   'public.commercial_subscription_apply_evidence(uuid,text,text,text,text,text,text,text,text,timestamptz,boolean,uuid,timestamptz,timestamptz,timestamptz,boolean,timestamptz,boolean)'] LOOP
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
   OR NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
   RAISE EXCEPTION 'Writer % must be executable by the service role only', f; END IF;
 END LOOP;
 IF has_function_privilege('anon', 'public.commercial_adjustment_read(uuid)', 'EXECUTE')
  OR NOT has_function_privilege('authenticated', 'public.commercial_adjustment_read(uuid)', 'EXECUTE') THEN
  RAISE EXCEPTION 'Adjustment reader authority is wrong'; END IF;
 IF has_function_privilege('service_role', 'public.commercial_subscription_periods_guard()', 'EXECUTE')
  OR has_function_privilege('authenticated', 'public.commercial_subscription_periods_guard()', 'EXECUTE') THEN
  RAISE EXCEPTION 'The period guard must not be executable'; END IF;
 -- The replaced PR D functions keep their ACLs.
 FOREACH f IN ARRAY ARRAY['public.commercial_settlement_begin(uuid,uuid,text,text,timestamptz,timestamptz,timestamptz,text,jsonb,text,text,jsonb,text)'] LOOP
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
   OR NOT has_function_privilege('service_role', f, 'EXECUTE') THEN RAISE EXCEPTION 'Replaced writer % lost its ACL', f; END IF;
 END LOOP;
 IF NOT has_function_privilege('authenticated', 'public.commercial_settlement_evidence(uuid,timestamptz,timestamptz,timestamptz)', 'EXECUTE')
  OR has_function_privilege('anon', 'public.commercial_settlement_evidence(uuid,timestamptz,timestamptz,timestamptz)', 'EXECUTE') THEN
  RAISE EXCEPTION 'Replaced reader lost its ACL'; END IF;
 -- The old 17-argument writer must not still exist next to the new one.
 IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = 'commercial_subscription_apply_evidence' AND p.pronargs <> 18)
 THEN RAISE EXCEPTION 'A stale evidence writer overload remains'; END IF;
 FOREACH t IN ARRAY ARRAY['public.commercial_webhook_receipts','public.commercial_provider_facts','public.commercial_subscription_periods',
                          'public.commercial_settlement_adjustments','public.commercial_adjustment_reviews'] LOOP
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


def ingest(event, etype, created, digest, facts):
    return (f"public.commercial_webhook_ingest('{event}', '{etype}', '{created}', '{digest * 64}', false, '{facts}'::jsonb)")


def sub_facts(sub, customer, status='active', ps='2026-08-01T00:00:00Z', pe='2026-09-01T00:00:00Z', started='2026-08-01T00:00:00Z',
              attempt='NULL', meta_shop='NULL', lookup='gradia_founder_pilot_2026_11_monthly'):
    import json
    return json.dumps({
        'object': 'subscription', 'subscription_id': sub, 'customer_id': customer, 'status': status,
        'catalog_version': '2026-11-03.v1', 'plan_key': 'founder-pilot', 'price_lookup_key': lookup,
        'metadata_shop_id': None if meta_shop == 'NULL' else meta_shop,
        'checkout_attempt_id': None if attempt == 'NULL' else attempt,
        'period_start': ps, 'period_end': pe, 'started_at': started, 'cancel_at_period_end': False, 'canceled_at': None,
    })


PROBES = f"""
-- ===== signed-event ingest =====
{JWT_SERVICE}
DO $$
DECLARE r jsonb; st text;
BEGIN
 -- legacy shop one (known subscription, no period yet): an active event WITH a verified period is applied.
 r := {ingest('evt_verify_000001', 'customer.subscription.updated', '2026-08-01T00:00:10Z', 'a', sub_facts('sub_VerifySub0001', 'cus_VerifyCustomer01'))};
 IF r->>'outcome' <> 'applied' OR (r->>'replayed')::boolean THEN RAISE EXCEPTION 'active event not applied: %', r; END IF;
 IF (SELECT count(*) FROM public.commercial_subscription_periods WHERE shop_id = '{S(1)}') <> 1 THEN RAISE EXCEPTION 'period not recorded'; END IF;
 -- exact replay, and a changed replay of the same event id
 r := {ingest('evt_verify_000001', 'customer.subscription.updated', '2026-08-01T00:00:10Z', 'a', sub_facts('sub_VerifySub0001', 'cus_VerifyCustomer01'))};
 IF NOT (r->>'replayed')::boolean OR r->>'outcome' <> 'applied' THEN RAISE EXCEPTION 'replay not recognised: %', r; END IF;
 PERFORM pg_temp.fails($q$SELECT {ingest('evt_verify_000001', 'customer.subscription.updated', '2026-08-01T00:00:10Z', 'b', sub_facts('sub_VerifySub0001', 'cus_VerifyCustomer01'))}$q$, 'CB409');
 IF (SELECT count(*) FROM public.commercial_webhook_receipts WHERE event_id = 'evt_verify_000001') <> 1 THEN RAISE EXCEPTION 'receipt duplicated'; END IF;
 -- tenant: unknown customer, unbound subscription, metadata disagreement
 r := {ingest('evt_verify_000002', 'customer.subscription.updated', '2026-08-02T00:00:00Z', 'c', sub_facts('sub_VerifyStray01', 'cus_Nobody0000001'))};
 IF r->>'outcome' <> 'unresolved' THEN RAISE EXCEPTION 'unknown customer must be unresolved: %', r; END IF;
 r := {ingest('evt_verify_000003', 'customer.subscription.updated', '2026-08-02T00:00:00Z', 'd', sub_facts('sub_VerifyStray02', 'cus_VerifyCustomer02'))};
 IF r->>'outcome' <> 'unresolved' OR r->>'reason' <> 'subscription_unbound' THEN RAISE EXCEPTION 'unbound subscription must be unresolved: %', r; END IF;
 IF EXISTS (SELECT 1 FROM public.commercial_subscription_evidence WHERE shop_id = '{S(2)}') THEN RAISE EXCEPTION 'unresolved event wrote evidence'; END IF;
 r := {ingest('evt_verify_000004', 'customer.subscription.updated', '2026-08-02T00:00:00Z', 'e',
   sub_facts('sub_VerifyMeta001', 'cus_VerifyCustomer02', attempt=None or 'NULL', meta_shop=S(1)))};
 IF r->>'outcome' <> 'refused' OR r->>'reason' <> 'tenant_conflict' THEN RAISE EXCEPTION 'metadata mismatch must be refused: %', r; END IF;
 SELECT state INTO st FROM public.commercial_billing_accounts WHERE shop_id = '{S(2)}';
 IF st <> 'reconciliation_required' THEN RAISE EXCEPTION 'tenant conflict must block the customer shop'; END IF;
 IF (SELECT state FROM public.commercial_billing_accounts WHERE shop_id = '{S(1)}') <> 'active' THEN RAISE EXCEPTION 'the named shop must be untouched'; END IF;
 -- live-mode events are refused by the database
 PERFORM pg_temp.fails($q$SELECT public.commercial_webhook_ingest('evt_verify_live01', 'x.y', now(), '{'a' * 64}', true, '{{}}'::jsonb)$q$, '22023');
 -- ordering: a newer past_due, then an OLDER active that must not regress it
 r := {ingest('evt_verify_000005', 'customer.subscription.updated', '2026-08-10T00:00:00Z', '1', sub_facts('sub_VerifySub0001', 'cus_VerifyCustomer01', status='past_due'))};
 IF r->>'outcome' <> 'applied' THEN RAISE EXCEPTION 'past_due not applied: %', r; END IF;
 r := {ingest('evt_verify_000006', 'customer.subscription.updated', '2026-08-05T00:00:00Z', '2', sub_facts('sub_VerifySub0001', 'cus_VerifyCustomer01'))};
 IF r->>'outcome' <> 'not_current' THEN RAISE EXCEPTION 'older evidence must not advance: %', r; END IF;
 IF (SELECT state FROM public.commercial_billing_accounts WHERE shop_id = '{S(1)}') <> 'past_due' THEN RAISE EXCEPTION 'older evidence regressed the account'; END IF;
 -- provider facts change nothing
 r := {ingest('evt_verify_000007', 'invoice.payment_failed', '2026-08-11T00:00:00Z', '3',
   '{"object":"invoice","outcome":"payment_failed","invoice_id":"in_Verify0001","customer_id":"cus_VerifyCustomer01","subscription_id":"sub_VerifySub0001","amount_cents":19900,"currency":"usd","attempt_count":2}')};
 IF r->>'outcome' <> 'recorded_fact' THEN RAISE EXCEPTION 'payment failure not recorded: %', r; END IF;
 r := {ingest('evt_verify_000008', 'charge.refunded', '2026-08-12T00:00:00Z', '4',
   '{"object":"charge","object_id":"ch_Verify0001","customer_id":"cus_VerifyCustomer01","invoice_id":"in_Verify0001","amount_cents":5000,"currency":"usd"}')};
 IF r->>'outcome' <> 'recorded_fact' THEN RAISE EXCEPTION 'refund not recorded: %', r; END IF;
 IF (SELECT state FROM public.commercial_billing_accounts WHERE shop_id = '{S(1)}') <> 'past_due' THEN RAISE EXCEPTION 'a fact changed the account'; END IF;
 -- canceled is terminal
 r := {ingest('evt_verify_000009', 'customer.subscription.deleted', '2026-08-20T00:00:00Z', '5', sub_facts('sub_VerifySub0001', 'cus_VerifyCustomer01', status='canceled'))};
 r := {ingest('evt_verify_000010', 'customer.subscription.updated', '2026-08-25T00:00:00Z', '6', sub_facts('sub_VerifySub0001', 'cus_VerifyCustomer01'))};
 IF r->>'outcome' <> 'not_current' OR (SELECT state FROM public.commercial_billing_accounts WHERE shop_id = '{S(1)}') <> 'canceled' THEN
  RAISE EXCEPTION 'canceled must be terminal: %', r; END IF;
 -- checkout completion is never active
 r := {ingest('evt_verify_000011', 'checkout.session.completed', '2026-08-03T00:00:00Z', '7',
   '{"object":"checkout_session","outcome":"completed","session_id":"cs_test_VerifySession02","customer_id":"cus_VerifyCustomer02"}')};
 IF r->>'outcome' <> 'refused' AND (SELECT state FROM public.commercial_billing_accounts WHERE shop_id = '{S(2)}') = 'active' THEN
  RAISE EXCEPTION 'checkout completion must never be active'; END IF;
END $$;

-- ===== lapse gate =====
DO $$
DECLARE g jsonb;
BEGIN
 g := public.commercial_execution_gate('{S(4)}');
 IF NOT (g->>'allowed')::boolean OR g->>'mode' <> 'legacy_no_commercial_account' THEN RAISE EXCEPTION 'a shop with no account is legacy and allowed: %', g; END IF;
 FOR g IN SELECT public.commercial_execution_gate(s) FROM (VALUES ('{S(1)}'::uuid), ('{S(2)}'), ('{S(3)}')) v(s) LOOP
  IF (g->>'allowed')::boolean THEN RAISE EXCEPTION 'a non-active account must block: %', g; END IF;
 END LOOP;
END $$;
{jwt('authenticated', U(1))}
SELECT pg_temp.fails($q$SELECT public.commercial_execution_gate('{S(1)}')$q$, '42501');

-- ===== Customer Portal authority =====
{JWT_SERVICE}
DO $$
DECLARE r jsonb;
BEGIN
 r := public.commercial_portal_authorize('{S(1)}', '{U(1)}', 'billing');
 IF NOT (r->>'authorized')::boolean OR r->>'customer_id' <> 'cus_VerifyCustomer01' THEN RAISE EXCEPTION 'owner must get the bound customer: %', r; END IF;
 PERFORM pg_temp.fails($q$SELECT public.commercial_portal_authorize('{S(1)}', '{U(2)}', 'billing')$q$, '42501'); -- manager
 PERFORM pg_temp.fails($q$SELECT public.commercial_portal_authorize('{S(1)}', '{U(3)}', 'billing')$q$, '42501'); -- staff
 PERFORM pg_temp.fails($q$SELECT public.commercial_portal_authorize('{S(1)}', '{U(4)}', 'billing')$q$, '42501'); -- revoked
 PERFORM pg_temp.fails($q$SELECT public.commercial_portal_authorize('{S(1)}', '{U(5)}', 'billing')$q$, '42501'); -- another shop's owner
 PERFORM pg_temp.fails($q$SELECT public.commercial_portal_authorize('{S(1)}', '{U(1)}', 'https://evil.example')$q$, '22023');
 r := public.commercial_portal_authorize('{S(3)}', '{U(6)}', 'billing');
 IF (r->>'authorized')::boolean THEN RAISE EXCEPTION 'no customer must not authorize'; END IF;
END $$;
{jwt('authenticated', U(1))}
SELECT pg_temp.fails($q$SELECT public.commercial_portal_authorize('{S(1)}', '{U(1)}', 'billing')$q$, '42501');

-- ===== settlement binds to an exact verified period =====
{JWT_SERVICE}
DO $$
DECLARE r jsonb;
BEGIN
 r := public.commercial_settlement_evidence('{S(1)}', '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', NULL);
 IF NOT (r->'eligibility'->'subscription_period'->>'verified')::boolean OR NOT (r->'eligibility'->'subscription_period'->>'chain_complete')::boolean THEN
  RAISE EXCEPTION 'the exact period must verify: %', r->'eligibility'->'subscription_period'; END IF;
 r := public.commercial_settlement_evidence('{S(1)}', '2026-08-02T00:00:00Z', '2026-09-02T00:00:00Z', NULL);
 IF (r->'eligibility'->'subscription_period'->>'verified')::boolean THEN RAISE EXCEPTION 'a shifted window must not verify'; END IF;
 -- the old calendar placeholder no longer authorizes anything: a UTC month that is not the period is refused
 PERFORM pg_temp.fails($q$SELECT public.commercial_settlement_begin('{S(1)}', '{U(1)}', '2026-11-03.v1', 'founder-pilot', '2026-09-01Z', '2026-10-01Z',
   '2026-10-02Z', '{'a' * 64}', '{{"state":"ok"}}'::jsonb, '{'b' * 64}', 'verify', '[]'::jsonb, 'cset.v1.verifyshifted00000001')$q$, 'CB422');
END $$;

-- ===== adjustment contract =====
DO $$
DECLARE a jsonb; adj_id uuid; before_row text;
BEGIN
 before_row := (SELECT to_jsonb(s)::text FROM public.commercial_settlements s WHERE id = '00000000-0000-4000-8000-0000000a1001');
 a := public.commercial_adjustment_propose('{S(1)}', '00000000-0000-4000-8000-0000000a1001', 'late_usage_evidence', -300, 'late_outcome_correction', NULL, 'adj.v1.verifyadjustment0001', 'system_reconciliation');
 adj_id := (a->>'adjustment_id')::uuid;
 IF a->>'status' <> 'pending_review' THEN RAISE EXCEPTION 'adjustment must start pending review: %', a; END IF;
 IF (SELECT target_period_start FROM public.commercial_settlement_adjustments x WHERE x.id = adj_id) <> '2026-09-01Z' THEN RAISE EXCEPTION 'adjustment must target the next period'; END IF;
 a := public.commercial_adjustment_propose('{S(1)}', '00000000-0000-4000-8000-0000000a1001', 'late_usage_evidence', -300, 'late_outcome_correction', NULL, 'adj.v1.verifyadjustment0001', 'system_reconciliation');
 IF a->>'action' <> 'replay' THEN RAISE EXCEPTION 'exact replay expected'; END IF;
 PERFORM pg_temp.fails($q$SELECT public.commercial_adjustment_propose('{S(1)}', '00000000-0000-4000-8000-0000000a1001', 'late_usage_evidence', -301, 'late_outcome_correction', NULL, 'adj.v1.verifyadjustment0001', 'system_reconciliation')$q$, 'CB409');
 PERFORM pg_temp.fails($q$SELECT public.commercial_adjustment_propose('{S(1)}', '00000000-0000-4000-8000-0000000a1001', 'correction', 0, 'zero_amount_nope', NULL, 'adj.v1.verifyadjustment0002', 'system_reconciliation')$q$, '23514');
 PERFORM pg_temp.fails($q$SELECT public.commercial_adjustment_propose('{S(2)}', '00000000-0000-4000-8000-0000000a1001', 'correction', -1, 'cross_shop_nope', NULL, 'adj.v1.verifyadjustment0003', 'system_reconciliation')$q$, 'CB422');
 PERFORM pg_temp.fails($q$SELECT public.commercial_adjustment_review('{S(1)}', '{'00000000-0000-4000-8000-0000000a1001'}', 'approved', 'reviewer:abcdefgh')$q$, '22023');
 a := public.commercial_adjustment_review('{S(1)}', adj_id, 'approved', 'reviewer:abcdefgh', 'checked');
 PERFORM pg_temp.fails(format($q$SELECT public.commercial_adjustment_review('{S(1)}', %L, 'rejected', 'reviewer:abcdefgh')$q$, adj_id), 'CB409');
 PERFORM pg_temp.fails(format($q$SELECT public.commercial_adjustment_review('{S(1)}', %L, 'applied', 'reviewer:abcdefgh')$q$, adj_id), '22023');
 IF before_row <> (SELECT to_jsonb(s)::text FROM public.commercial_settlements s WHERE id = '00000000-0000-4000-8000-0000000a1001') THEN
  RAISE EXCEPTION 'a settlement was rewritten by an adjustment'; END IF;
 IF EXISTS (SELECT 1 FROM public.commercial_settlement_lines WHERE settlement_id = '00000000-0000-4000-8000-0000000a1001') THEN RAISE EXCEPTION 'adjustment created a line'; END IF;
END $$;

-- ===== immutability, live mode, cascade =====
DO $$
BEGIN
 PERFORM pg_temp.fails($q$UPDATE public.commercial_webhook_receipts SET outcome = 'applied'$q$, '42501');
 PERFORM pg_temp.fails($q$DELETE FROM public.commercial_webhook_receipts$q$, '42501');
 PERFORM pg_temp.fails($q$UPDATE public.commercial_provider_facts SET amount_cents = 1$q$, '42501');
 PERFORM pg_temp.fails($q$DELETE FROM public.commercial_subscription_periods$q$, '42501');
 PERFORM pg_temp.fails($q$UPDATE public.commercial_settlement_adjustments SET signed_amount_cents = 1$q$, '42501');
 PERFORM pg_temp.fails($q$DELETE FROM public.commercial_adjustment_reviews$q$, '42501');
 PERFORM pg_temp.fails($q$TRUNCATE public.commercial_subscription_periods$q$, '42501');
 PERFORM pg_temp.fails($q$INSERT INTO public.commercial_webhook_receipts (event_id,event_type,event_created_at,payload_digest,livemode,outcome) VALUES ('evt_verify_livemode','x.yy',now(),'{'a' * 64}',true,'applied')$q$, '23514');
 PERFORM pg_temp.fails($q$SELECT public.commercial_billing_emit('{S(1)}', 'portal_session_requested', NULL, NULL, 'active', '{{"u":"https://billing.stripe.com/x"}}'::jsonb)$q$, '23514');
 DELETE FROM public.shops WHERE id = '{S(1)}';
 IF EXISTS (SELECT 1 FROM public.commercial_webhook_receipts WHERE shop_id = '{S(1)}')
  OR EXISTS (SELECT 1 FROM public.commercial_provider_facts WHERE shop_id = '{S(1)}')
  OR EXISTS (SELECT 1 FROM public.commercial_subscription_periods WHERE shop_id = '{S(1)}')
  OR EXISTS (SELECT 1 FROM public.commercial_settlement_adjustments WHERE shop_id = '{S(1)}') THEN
  RAISE EXCEPTION 'tenant deletion must remove E1 rows'; END IF;
END $$;
"""

program = '\n'.join([
    'BEGIN;',
    RESTORE_PR_E_PREVIOUS,
    SEED,
    body,
    UNCHANGED,
    ACLS,
    PROBES,
    'ROLLBACK;',
])
run(program)
assert run("SELECT count(*) || ':' || max(version) FROM supabase_migrations.schema_migrations") == ledger_before, 'ledger changed'
assert run("SELECT to_regclass('public.commercial_webhook_receipts') IS NOT NULL AND to_regclass('public.commercial_subscription_periods') IS NOT NULL") == 't', \
    'the probe must leave the applied migration exactly as it found it'
print('PASS: commercial reconciliation migration upgrade, authority, ingest, gate, portal, binding, adjustments, immutability (rolled back)')
