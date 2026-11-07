"""Non-destructive upgrade probe for the commercial billing state migration (PR C).

Everything runs inside ONE transaction on the unlinked gradia-isolated-tests stack and
ends with ROLLBACK, so no database state is ever changed or destroyed. Inside it the probe
  1. removes exactly the objects 20261106120000 created, which restores the schema the
     previous migration left behind (this migration adds objects only; it alters nothing else),
  2. seeds fictional legacy shops, memberships, PR A commercial usage and PR B membership
     billing evidence next to whatever rows already exist,
  3. applies the migration's REAL SQL text (its BEGIN/COMMIT wrapper removed so the outer
     transaction stays in control), and proves:
       * no existing shops, shop_memberships, usage_events, PR A or PR B row was rewritten
         (content, xmin and physical position) and the new tables start empty,
       * function and table ACLs match the intended authority model (browser roles: nothing),
       * only a service-role caller naming a LIVE OWNER can begin Checkout; manager, staff,
         revoked, cross-shop and non-service callers are refused,
       * a changed in-flight request conflicts, a stale in-flight attempt becomes unknown /
         reconciliation_required (never retried), a completed session is not payment proof,
       * attempts/events/evidence are immutable where they must be (identity, write-once
         session id, forward-only status, append-only history, no truncate),
       * only reviewed non-live evidence can make an account active; live mode, unreviewed
         sources, out-of-order, duplicate-subscription and mismatched-customer cases fail closed,
       * the tenant-deletion contract holds.
  4. rolls everything back, then confirms the migration is still applied exactly as before.
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

NEW = '20261106120000'    # billing state
NEW2 = '20261106130000'   # atomic agent activation (review fix)

def migration_body(version):
    migration = next((root / 'supabase/migrations').glob(f'{version}_*.sql'))
    text = migration.read_text().strip()
    assert text.startswith('BEGIN;') and text.endswith('COMMIT;'), 'migration must be one BEGIN..COMMIT block'
    return text[len('BEGIN;'):-len('COMMIT;')]

body = migration_body(NEW)
body2 = migration_body(NEW2)
def top_level(sql):
    """SQL with dollar-quoted bodies removed: PL/pgSQL BEGIN/END blocks are not transaction control."""
    assert re.search(r'\$[A-Za-z_]\w*\$', sql) is None, 'named dollar quotes are not handled'
    return re.sub(r'\$\$.*?\$\$', '$$$$', sql, flags=re.S)


# Transaction control means a statement STARTING with these words; "ON COMMIT DROP" is ordinary DDL.
TXN_CONTROL = re.compile(r'(?im)^\s*(commit|rollback|begin|start\s+transaction|savepoint|release|abort|end)\b')
assert not TXN_CONTROL.search(top_level(body)), 'unexpected transaction control inside the migration'
assert not TXN_CONTROL.search(top_level(body2)), 'unexpected transaction control inside the activation migration'
versions = sorted(p.name.split('_')[0] for p in (root / 'supabase/migrations').glob('*.sql'))


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




def U(n):  # auth users
    return f'00000000-0000-4000-8000-0000000a{n:04d}'


def S(n):  # shops
    return f'00000000-0000-4000-8000-0000000b{n:04d}'


assert run("SELECT max(version) FROM supabase_migrations.schema_migrations") == versions[-1] == NEW2, 'stack must be at the latest migration'
ledger_before = run("SELECT count(*) || ':' || max(version) FROM supabase_migrations.schema_migrations")

DROP_PR_C = """
DROP TRIGGER custom_agents_activation_guard ON public.custom_agents;
DROP FUNCTION public.commercial_agent_activate(uuid, uuid, uuid);
DROP FUNCTION public.custom_agents_activation_guard();
DROP FUNCTION public.commercial_billing_read(uuid);
DROP FUNCTION public.commercial_subscription_apply_evidence(uuid, text, text, text, text, text, text, text, text, timestamptz, boolean, uuid);
DROP FUNCTION public.commercial_checkout_observe(uuid, uuid, uuid, text);
DROP FUNCTION public.commercial_checkout_mark_unknown(uuid, uuid, uuid, text);
DROP FUNCTION public.commercial_checkout_reject(uuid, uuid, uuid, text);
DROP FUNCTION public.commercial_checkout_record_session(uuid, uuid, uuid, text);
DROP FUNCTION public.commercial_checkout_bind_customer(uuid, uuid, uuid, text);
DROP FUNCTION public.commercial_checkout_begin(uuid, uuid, text, text, text, text, text);
DROP FUNCTION public.commercial_billing_lock(uuid, uuid, text, text);
DROP FUNCTION public.commercial_billing_advance(uuid, text, text, uuid);
DROP FUNCTION public.commercial_billing_emit(uuid, text, uuid, uuid, text, jsonb);
DROP FUNCTION public.commercial_billing_require_service();
DROP FUNCTION public.commercial_billing_actor_is_owner(uuid, uuid);
DROP TABLE public.commercial_billing_accounts;
DROP TABLE public.commercial_billing_events;
DROP TABLE public.commercial_subscription_evidence;
DROP TABLE public.commercial_checkout_attempts;
DROP FUNCTION public.commercial_billing_accounts_guard();
DROP FUNCTION public.commercial_checkout_attempts_guard();
DO $$ BEGIN
 IF to_regclass('public.commercial_billing_accounts') IS NOT NULL
  OR to_regclass('public.commercial_checkout_attempts') IS NOT NULL
  OR to_regclass('public.commercial_billing_events') IS NOT NULL
  OR to_regclass('public.commercial_subscription_evidence') IS NOT NULL
  OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND (p.proname LIKE 'commercial\\_checkout\\_%' OR p.proname LIKE 'commercial\\_billing\\_%' OR p.proname LIKE 'commercial\\_agent\\_%' OR p.proname = 'custom_agents_activation_guard'
                                              OR p.proname = 'commercial_subscription_apply_evidence'))
 THEN RAISE EXCEPTION 'Pre-PR-C schema was not restored'; END IF;
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
"""

SEED = f"""
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES
 ('{U(1)}','owner1@example.test',now()),('{U(2)}','manager1@example.test',now()),
 ('{U(3)}','staff1@example.test',now()),('{U(4)}','gone1@example.test',now()),
 ('{U(5)}','owner2@example.test',now());
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

-- Row-exact fingerprints of everything that must not change (PR A usage and PR B membership evidence included).
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
 IF EXISTS (SELECT 1 FROM public.commercial_billing_accounts) OR EXISTS (SELECT 1 FROM public.commercial_checkout_attempts)
  OR EXISTS (SELECT 1 FROM public.commercial_billing_events) OR EXISTS (SELECT 1 FROM public.commercial_subscription_evidence)
 THEN RAISE EXCEPTION 'The upgrade must not invent billing state for existing shops'; END IF;
END $$;
"""

ACLS = """
DO $$
DECLARE r text; f text; t text;
BEGIN
 FOREACH f IN ARRAY ARRAY[
   'public.commercial_checkout_begin(uuid,uuid,text,text,text,text,text)',
   'public.commercial_checkout_bind_customer(uuid,uuid,uuid,text)',
   'public.commercial_checkout_record_session(uuid,uuid,uuid,text)',
   'public.commercial_checkout_reject(uuid,uuid,uuid,text)',
   'public.commercial_checkout_mark_unknown(uuid,uuid,uuid,text)',
   'public.commercial_checkout_observe(uuid,uuid,uuid,text)',
   'public.commercial_subscription_apply_evidence(uuid,text,text,text,text,text,text,text,text,timestamptz,boolean,uuid)',
   'public.commercial_agent_activate(uuid,uuid,uuid)'] LOOP
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
   OR NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
   RAISE EXCEPTION 'Writer % must be executable by the service role only', f; END IF;
 END LOOP;
 IF has_function_privilege('anon', 'public.commercial_billing_read(uuid)', 'EXECUTE')
  OR NOT has_function_privilege('authenticated', 'public.commercial_billing_read(uuid)', 'EXECUTE')
  OR NOT has_function_privilege('service_role', 'public.commercial_billing_read(uuid)', 'EXECUTE')
 THEN RAISE EXCEPTION 'Reader authority is wrong'; END IF;
 FOREACH f IN ARRAY ARRAY[
   'public.commercial_billing_actor_is_owner(uuid,uuid)', 'public.commercial_billing_require_service()',
   'public.commercial_billing_emit(uuid,text,uuid,uuid,text,jsonb)', 'public.commercial_billing_advance(uuid,text,text,uuid)',
   'public.commercial_billing_lock(uuid,uuid,text,text)', 'public.commercial_checkout_attempts_guard()',
   'public.commercial_billing_accounts_guard()', 'public.custom_agents_activation_guard()'] LOOP
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF has_function_privilege(r, f, 'EXECUTE') THEN RAISE EXCEPTION 'Internal helper % must not be executable by %', f, r; END IF;
  END LOOP;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['public.commercial_billing_accounts','public.commercial_checkout_attempts',
   'public.commercial_billing_events','public.commercial_subscription_evidence'] LOOP
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

SVC = "SELECT set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true);"

def as_service(inner):
    return f"DO $$ BEGIN PERFORM set_config('request.jwt.claims', '{{\"role\":\"service_role\"}}', true); {inner} END $$;"

BEGIN_ARGS = lambda actor, fp='a' * 64, shop=None: f"'{shop or S(1)}', '{actor}', '2026-11-03.v1', 'founder-pilot', 'gradia_founder_pilot_2026_11_monthly', 'agents', '{fp}'"

AUTHORITY = f"""
-- A non-service caller cannot even execute the writer (permission denied, 42501).
DO $$ BEGIN
 BEGIN
  PERFORM set_config('request.jwt.claims', '{{"role":"authenticated","sub":"{U(1)}"}}', true);
  PERFORM public.commercial_checkout_begin({BEGIN_ARGS(U(1))});
  RAISE EXCEPTION 'An authenticated caller executed a writer';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;

END $$;

-- Only a LIVE OWNER of that exact shop, via the service role, can begin Checkout.
DO $$
DECLARE refused integer := 0; who text; res jsonb;
BEGIN
 PERFORM set_config('request.jwt.claims', '{{"role":"service_role"}}', true);
 FOREACH who IN ARRAY ARRAY['{U(2)}', '{U(3)}', '{U(4)}', '{U(5)}', '00000000-0000-4000-8000-00000000dead'] LOOP
  BEGIN
   PERFORM public.commercial_checkout_begin('{S(1)}', who::uuid, '2026-11-03.v1', 'founder-pilot', 'gradia_founder_pilot_2026_11_monthly', 'agents', '{'a' * 64}');
   RAISE EXCEPTION 'Actor % was allowed to begin Checkout', who;
  EXCEPTION WHEN insufficient_privilege THEN refused := refused + 1; END;
 END LOOP;
 IF refused <> 5 THEN RAISE EXCEPTION 'Expected five refusals (manager, staff, revoked, cross-shop owner, unknown); got %', refused; END IF;

 IF EXISTS (SELECT 1 FROM public.commercial_billing_accounts WHERE shop_id = '{S(1)}') THEN
  RAISE EXCEPTION 'A refused caller left an account behind'; END IF;
 -- A mismatched catalog/plan/lookup/fingerprint is invalid input, not a free pass.

 BEGIN PERFORM public.commercial_checkout_begin('{S(1)}', '{U(1)}', '2026-11-03.v1', 'founder-pilot', 'gradia_founder_pilot_2026_11_monthly', 'agents', 'not-a-fingerprint');
  RAISE EXCEPTION 'A bad fingerprint was accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN PERFORM public.commercial_checkout_begin('{S(1)}', '{U(1)}', '2025-01-01.v1', 'founder-pilot', 'gradia_founder_pilot_2026_11_monthly', 'agents', '{'a' * 64}');
  RAISE EXCEPTION 'An unregistered catalog version was accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
 BEGIN PERFORM public.commercial_checkout_begin('{S(1)}', '{U(1)}', '2026-11-03.v1', 'growth', 'gradia_founder_pilot_2026_11_monthly', 'agents', '{'a' * 64}');
  RAISE EXCEPTION 'A non-sellable plan was accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN PERFORM public.commercial_checkout_begin('{S(1)}', '{U(1)}', '2026-11-03.v1', 'founder-pilot', 'gradia_growth_2026_11_monthly', 'agents', '{'a' * 64}');
  RAISE EXCEPTION 'A non-approved price lookup key was accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN PERFORM public.commercial_checkout_begin('{S(1)}', '{U(1)}', '2026-11-03.v1', 'founder-pilot', 'gradia_founder_pilot_2026_11_monthly', 'https://evil.example', '{'a' * 64}');
  RAISE EXCEPTION 'An arbitrary return target was accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;

 IF EXISTS (SELECT 1 FROM public.commercial_checkout_attempts WHERE shop_id = '{S(1)}') THEN
  RAISE EXCEPTION 'Invalid requests left attempts behind'; END IF;
END $$;
"""

LIFECYCLE = f"""
DO $$
DECLARE r jsonb; r2 jsonb; att uuid;
BEGIN
 PERFORM set_config('request.jwt.claims', '{{"role":"service_role"}}', true);
 r := public.commercial_checkout_begin({BEGIN_ARGS(U(1))});
 IF r->>'action' <> 'create' OR r->>'state' <> 'checkout_pending' THEN RAISE EXCEPTION 'First begin should create: %', r; END IF;
 att := (r->>'attempt_id')::uuid;
 -- exact replay while the first is still being created: in_progress, same attempt, never a second create
 r2 := public.commercial_checkout_begin({BEGIN_ARGS(U(1))});
 IF r2->>'action' <> 'in_progress' OR (r2->>'attempt_id')::uuid <> att THEN RAISE EXCEPTION 'Replay should be in_progress: %', r2; END IF;
 -- a changed request conflicts
 BEGIN PERFORM public.commercial_checkout_begin({BEGIN_ARGS(U(1), 'b' * 64)});
  RAISE EXCEPTION 'A changed in-flight request was accepted';
 EXCEPTION WHEN SQLSTATE 'CB409' THEN NULL; END;
 -- a connected-account id is never a platform customer
 BEGIN PERFORM public.commercial_checkout_bind_customer('{S(1)}', '{U(1)}', att, 'acct_FakeConnected1');
  RAISE EXCEPTION 'A connected account id was bound as the platform customer';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 PERFORM public.commercial_checkout_bind_customer('{S(1)}', '{U(1)}', att, 'cus_FakeCustomer01');
 BEGIN PERFORM public.commercial_checkout_bind_customer('{S(1)}', '{U(1)}', att, 'cus_FakeCustomer02');
  RAISE EXCEPTION 'The platform customer binding was replaced';
 EXCEPTION WHEN SQLSTATE 'CB409' THEN NULL; END;
 -- one customer cannot serve two workspaces

 PERFORM public.commercial_billing_lock('{S(2)}', '{U(5)}', '2026-11-03.v1', 'founder-pilot');

 -- a live-shaped / malformed session id is refused
 BEGIN PERFORM public.commercial_checkout_record_session('{S(1)}', '{U(1)}', att, 'cs_live_FakeSession01');
  RAISE EXCEPTION 'A live session id was accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 PERFORM public.commercial_checkout_record_session('{S(1)}', '{U(1)}', att, 'cs_test_FakeSession01');
 IF (public.commercial_checkout_record_session('{S(1)}', '{U(1)}', att, 'cs_test_FakeSession01')->>'replayed')::boolean IS NOT TRUE THEN
  RAISE EXCEPTION 'Recording the same session twice must replay'; END IF;
 BEGIN PERFORM public.commercial_checkout_record_session('{S(1)}', '{U(1)}', att, 'cs_test_FakeSession02');
  RAISE EXCEPTION 'A second session was recorded for one attempt';
 EXCEPTION WHEN SQLSTATE 'CB409' THEN NULL; END;
 r := public.commercial_checkout_begin({BEGIN_ARGS(U(1))});
 IF r->>'action' <> 'replay' OR r->>'session_id' <> 'cs_test_FakeSession01' THEN RAISE EXCEPTION 'Open session should replay: %', r; END IF;
 -- a completed redirect is NOT payment proof and is never repeated
 PERFORM public.commercial_checkout_observe('{S(1)}', '{U(1)}', att, 'complete');
 r := public.commercial_checkout_begin({BEGIN_ARGS(U(1))});
 IF r->>'action' <> 'blocked' OR r->>'state' <> 'checkout_pending' OR r->>'reason' <> 'checkout_completed_awaiting_evidence' THEN
  RAISE EXCEPTION 'A completed session must wait for evidence: %', r; END IF;

 IF (SELECT state FROM public.commercial_billing_accounts WHERE shop_id = '{S(1)}') = 'active' THEN
  RAISE EXCEPTION 'A completed Checkout must never be active'; END IF;
 IF (SELECT count(*) FROM public.commercial_checkout_attempts WHERE shop_id = '{S(1)}') <> 1 THEN
  RAISE EXCEPTION 'Exactly one attempt expected'; END IF;
 -- the same customer id cannot be bound to the other workspace

 DECLARE r3 jsonb; att2 uuid; BEGIN
  r3 := public.commercial_checkout_begin({BEGIN_ARGS(U(5), 'c' * 64, S(2))});
  att2 := (r3->>'attempt_id')::uuid;
  BEGIN PERFORM public.commercial_checkout_bind_customer('{S(2)}', '{U(5)}', att2, 'cus_FakeCustomer01');
   RAISE EXCEPTION 'One platform customer was bound to two workspaces';
  EXCEPTION WHEN unique_violation THEN NULL; END;
 END;

END $$;
"""

STALE_AND_UNKNOWN = f"""
DO $$
DECLARE r jsonb; att uuid;
BEGIN
 -- third workspace: a started attempt that never recorded an outcome becomes unknown once stale.
 PERFORM public.commercial_billing_lock('{S(3)}', '{U(6)}', '2026-11-03.v1', 'founder-pilot');
 PERFORM set_config('request.jwt.claims', '{{"role":"service_role"}}', true);
 r := public.commercial_checkout_begin({BEGIN_ARGS(U(6), 'd' * 64, S(3))});
 att := (r->>'attempt_id')::uuid;

 ALTER TABLE public.commercial_checkout_attempts DISABLE TRIGGER commercial_checkout_attempts_guard;
 UPDATE public.commercial_checkout_attempts SET created_at = created_at - interval '10 minutes' WHERE id = att;
 ALTER TABLE public.commercial_checkout_attempts ENABLE TRIGGER commercial_checkout_attempts_guard;

 r := public.commercial_checkout_begin({BEGIN_ARGS(U(6), 'd' * 64, S(3))});
 IF r->>'action' <> 'blocked' OR r->>'state' <> 'reconciliation_required' OR r->>'reason' <> 'stale_in_flight' THEN
  RAISE EXCEPTION 'A stale in-flight attempt must become reconciliation_required: %', r; END IF;
 -- and it is never retried blindly, however often it is asked
 FOR i IN 1..3 LOOP
  r := public.commercial_checkout_begin({BEGIN_ARGS(U(6), 'd' * 64, S(3))});
  IF r->>'action' <> 'blocked' OR r->>'state' <> 'reconciliation_required' THEN RAISE EXCEPTION 'Unknown attempt was retried: %', r; END IF;
 END LOOP;

 IF (SELECT count(*) FROM public.commercial_checkout_attempts WHERE shop_id = '{S(3)}') <> 1
  OR (SELECT status FROM public.commercial_checkout_attempts WHERE id = att) <> 'unknown' THEN
  RAISE EXCEPTION 'The ambiguous attempt must stay the only attempt and be unknown'; END IF;
END $$;
"""

EVIDENCE = f"""
DO $$
DECLARE r jsonb; att uuid;
BEGIN
 SELECT current_attempt_id INTO att FROM public.commercial_billing_accounts WHERE shop_id = '{S(1)}';
 PERFORM set_config('request.jwt.claims', '{{"role":"service_role"}}', true);
 -- live mode, and sources that are not reviewed, are refused outright
 BEGIN PERFORM public.commercial_subscription_apply_evidence('{S(1)}','sub_FakeSub0001','cus_FakeCustomer01','active','2026-11-03.v1','founder-pilot','gradia_founder_pilot_2026_11_monthly','signed_webhook','evt_fake_live_0001', now(), true, NULL);
  RAISE EXCEPTION 'Live-mode evidence was accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN PERFORM public.commercial_subscription_apply_evidence('{S(1)}','sub_FakeSub0001','cus_FakeCustomer01','active','2026-11-03.v1','founder-pilot','gradia_founder_pilot_2026_11_monthly','browser_redirect','evt_fake_redir_0001', now(), false, NULL);
  RAISE EXCEPTION 'A browser redirect was accepted as evidence';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;

 IF (SELECT state FROM public.commercial_billing_accounts WHERE shop_id = '{S(1)}') = 'active' THEN
  RAISE EXCEPTION 'An unreviewed assertion made the account active'; END IF;

 -- reviewed, non-live, current-catalog, matching customer: active
 r := public.commercial_subscription_apply_evidence('{S(1)}','sub_FakeSub0001','cus_FakeCustomer01','active','2026-11-03.v1','founder-pilot','gradia_founder_pilot_2026_11_monthly','signed_webhook','evt_fake_active_001', now() - interval '1 minute', false, att);
 IF r->>'state' <> 'active' OR (r->>'advanced')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'Reviewed evidence should activate: %', r; END IF;
 -- exact replay is idempotent; a changed replay conflicts
 r := public.commercial_subscription_apply_evidence('{S(1)}','sub_FakeSub0001','cus_FakeCustomer01','active','2026-11-03.v1','founder-pilot','gradia_founder_pilot_2026_11_monthly','signed_webhook','evt_fake_active_001', now() - interval '1 minute', false, att);
 IF (r->>'replayed')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'Evidence replay must be idempotent: %', r; END IF;
 BEGIN PERFORM public.commercial_subscription_apply_evidence('{S(1)}','sub_FakeSub0001','cus_FakeCustomer01','canceled','2026-11-03.v1','founder-pilot','gradia_founder_pilot_2026_11_monthly','signed_webhook','evt_fake_active_001', now(), false, att);
  RAISE EXCEPTION 'A changed evidence replay was accepted';
 EXCEPTION WHEN SQLSTATE 'CB409' THEN NULL; END;
 -- out-of-order evidence is kept but does not move the pointer
 r := public.commercial_subscription_apply_evidence('{S(1)}','sub_FakeSub0001','cus_FakeCustomer01','past_due','2026-11-03.v1','founder-pilot','gradia_founder_pilot_2026_11_monthly','signed_webhook','evt_fake_late_00001', now() - interval '1 hour', false, att);
 IF (r->>'advanced')::boolean IS NOT FALSE THEN RAISE EXCEPTION 'Out-of-order evidence moved the pointer: %', r; END IF;
 -- a different live subscription forces reconciliation
 r := public.commercial_subscription_apply_evidence('{S(1)}','sub_FakeSub0002','cus_FakeCustomer01','active','2026-11-03.v1','founder-pilot','gradia_founder_pilot_2026_11_monthly','signed_webhook','evt_fake_second_001', now(), false, NULL);
 IF r->>'state' <> 'reconciliation_required' THEN RAISE EXCEPTION 'Duplicate subscription must force reconciliation: %', r; END IF;

 IF (SELECT state_reason FROM public.commercial_billing_accounts WHERE shop_id = '{S(1)}') <> 'duplicate_subscription' THEN
  RAISE EXCEPTION 'Wrong reconciliation reason'; END IF;
 IF (SELECT count(*) FROM public.commercial_subscription_evidence WHERE shop_id = '{S(1)}') <> 3 THEN
  RAISE EXCEPTION 'Evidence history must be preserved (3 rows)'; END IF;
END $$;

-- Unknown / unreviewable provider statuses never become active.
DO $$
DECLARE r jsonb; s text;
BEGIN
 PERFORM public.commercial_billing_lock('{S(2)}', '{U(5)}', '2026-11-03.v1', 'founder-pilot');
 UPDATE public.commercial_billing_accounts SET platform_customer_id = 'cus_FakeCustomer77', version = version + 1 WHERE shop_id = '{S(2)}';
 PERFORM set_config('request.jwt.claims', '{{"role":"service_role"}}', true);
 FOREACH s IN ARRAY ARRAY['trialing','unpaid','paused'] LOOP
  r := public.commercial_subscription_apply_evidence('{S(2)}','sub_FakeSub9' || s,'cus_FakeCustomer77', s,'2026-11-03.v1','founder-pilot','gradia_founder_pilot_2026_11_monthly','reviewed_reconciliation','evt_fake_' || s || '_1', now() + (length(s) || ' seconds')::interval, false, NULL);
  IF r->>'state' <> 'unknown' THEN RAISE EXCEPTION 'Provider status % must be unknown, got %', s, r; END IF;
 END LOOP;
 -- a catalog mismatch and a customer mismatch are quarantined
 r := public.commercial_subscription_apply_evidence('{S(2)}','sub_FakeSubMis1','cus_FakeCustomer77','active','2025-01-01.v1','founder-pilot','gradia_founder_pilot_2026_11_monthly','signed_webhook','evt_fake_mis_00001', now() + interval '1 hour', false, NULL);
 IF r->>'state' <> 'reconciliation_required' THEN RAISE EXCEPTION 'Catalog mismatch must be quarantined: %', r; END IF;
 r := public.commercial_subscription_apply_evidence('{S(2)}','sub_FakeSubMis2','cus_Someone0Else','active','2026-11-03.v1','founder-pilot','gradia_founder_pilot_2026_11_monthly','signed_webhook','evt_fake_mis_00002', now() + interval '2 hours', false, NULL);
 IF r->>'state' <> 'reconciliation_required' THEN RAISE EXCEPTION 'Customer mismatch must be quarantined: %', r; END IF;

END $$;
"""

IMMUTABILITY = f"""
DO $$
DECLARE blocked integer := 0; att uuid;
BEGIN
 SELECT current_attempt_id INTO att FROM public.commercial_billing_accounts WHERE shop_id = '{S(1)}';
 -- append-only tables (as the table owner)
 BEGIN UPDATE public.commercial_billing_events SET kind = 'account_opened'; EXCEPTION WHEN insufficient_privilege THEN blocked := blocked + 1; END;
 BEGIN DELETE FROM public.commercial_billing_events; EXCEPTION WHEN insufficient_privilege THEN blocked := blocked + 1; END;
 BEGIN TRUNCATE public.commercial_billing_events CASCADE; EXCEPTION WHEN insufficient_privilege THEN blocked := blocked + 1; END;
 BEGIN UPDATE public.commercial_subscription_evidence SET derived_state = 'active'; EXCEPTION WHEN insufficient_privilege THEN blocked := blocked + 1; END;
 BEGIN DELETE FROM public.commercial_subscription_evidence; EXCEPTION WHEN insufficient_privilege THEN blocked := blocked + 1; END;
 BEGIN TRUNCATE public.commercial_subscription_evidence CASCADE; EXCEPTION WHEN insufficient_privilege THEN blocked := blocked + 1; END;
 -- attempts: identity immutable, session write-once, status forward-only, never deleted
 BEGIN UPDATE public.commercial_checkout_attempts SET request_fingerprint = repeat('f', 64) WHERE id = att; EXCEPTION WHEN insufficient_privilege THEN blocked := blocked + 1; END;
 BEGIN UPDATE public.commercial_checkout_attempts SET shop_id = '{S(2)}' WHERE id = att; EXCEPTION WHEN insufficient_privilege THEN blocked := blocked + 1; END;
 BEGIN UPDATE public.commercial_checkout_attempts SET provider_session_id = 'cs_test_Swapped0001' WHERE id = att; EXCEPTION WHEN insufficient_privilege THEN blocked := blocked + 1; END;
 BEGIN UPDATE public.commercial_checkout_attempts SET status = 'started', provider_session_id = NULL WHERE id = att; EXCEPTION WHEN insufficient_privilege THEN blocked := blocked + 1; END;
 BEGIN DELETE FROM public.commercial_checkout_attempts WHERE id = att; EXCEPTION WHEN insufficient_privilege THEN blocked := blocked + 1; END;
 BEGIN TRUNCATE public.commercial_checkout_attempts CASCADE; EXCEPTION WHEN insufficient_privilege THEN blocked := blocked + 1; END;
 -- account: binding fixed, customer write-once, version advances by exactly one, never deleted
 BEGIN UPDATE public.commercial_billing_accounts SET catalog_version = '2026-11-03.v1', plan_key = 'founder-pilot', created_at = now() WHERE shop_id = '{S(1)}'; EXCEPTION WHEN insufficient_privilege THEN blocked := blocked + 1; END;
 BEGIN UPDATE public.commercial_billing_accounts SET platform_customer_id = 'cus_FakeReplaced1', version = version + 1 WHERE shop_id = '{S(1)}'; EXCEPTION WHEN insufficient_privilege THEN blocked := blocked + 1; END;
 BEGIN UPDATE public.commercial_billing_accounts SET state = 'active', version = version + 5 WHERE shop_id = '{S(1)}'; EXCEPTION WHEN insufficient_privilege THEN blocked := blocked + 1; END;
 BEGIN DELETE FROM public.commercial_billing_accounts WHERE shop_id = '{S(1)}'; EXCEPTION WHEN insufficient_privilege THEN blocked := blocked + 1; END;
 BEGIN TRUNCATE public.commercial_billing_accounts CASCADE; EXCEPTION WHEN insufficient_privilege THEN blocked := blocked + 1; END;
 IF blocked <> 17 THEN RAISE EXCEPTION 'Immutability guards let % of 17 probes through', 17 - blocked; END IF;
 -- a live account or live evidence is unrepresentable even for the table owner
 BEGIN UPDATE public.commercial_billing_accounts SET state = 'unknown', version = version + 1 WHERE shop_id = '{S(1)}';
 EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'The pointer must still advance atomically: %', SQLERRM; END;
 BEGIN INSERT INTO public.commercial_billing_accounts(shop_id, catalog_version, plan_key, provider_mode, state)
   SELECT '{S(3)}'::uuid, '2026-11-03.v1', 'founder-pilot', 'live', 'checkout_required' WHERE false;
 END;
 BEGIN PERFORM public.commercial_billing_emit('{S(1)}', 'session_created', NULL, NULL, 'checkout_pending', '{{"u":"https://checkout.stripe.com/c/pay/x"}}'::jsonb);
  RAISE EXCEPTION 'A URL was accepted in event details';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN PERFORM public.commercial_billing_emit('{S(1)}', 'session_created', NULL, NULL, 'checkout_pending', '{{"k":"sk_live_abcdefghijkl"}}'::jsonb);
  RAISE EXCEPTION 'A key-shaped value was accepted in event details';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
-- A live provider mode is a CHECK violation, not a policy.
DO $$ BEGIN
 BEGIN INSERT INTO public.commercial_billing_accounts(shop_id, catalog_version, plan_key, provider_mode, state)
   VALUES ('{S(3)}', '2026-11-03.v1', 'founder-pilot', 'live', 'checkout_required');
  RAISE EXCEPTION 'A live-mode account was accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN INSERT INTO public.commercial_subscription_evidence(shop_id, provider_subscription_id, provider_customer_id, provider_status, derived_state,
    catalog_version, plan_key, price_lookup_key, evidence_source, source_event_id, source_event_created_at, livemode)
   VALUES ('{S(3)}', 'sub_FakeLive0001', 'cus_FakeLive0001', 'active', 'active', '2026-11-03.v1', 'founder-pilot',
    'gradia_founder_pilot_2026_11_monthly', 'signed_webhook', 'evt_fake_live_0009', now(), true);
  RAISE EXCEPTION 'Live-mode evidence was stored';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN INSERT INTO public.commercial_subscription_evidence(shop_id, provider_subscription_id, provider_customer_id, provider_status, derived_state,
    catalog_version, plan_key, price_lookup_key, evidence_source, source_event_id, source_event_created_at, livemode)
   VALUES ('{S(3)}', 'sub_FakeNoRev001', 'cus_FakeNoRev001', 'trialing', 'active', '2026-11-03.v1', 'founder-pilot',
    'gradia_founder_pilot_2026_11_monthly', 'signed_webhook', 'evt_fake_trial_09', now(), false);
  RAISE EXCEPTION 'A non-active provider status was stored as active';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN INSERT INTO public.commercial_subscription_evidence(shop_id, provider_subscription_id, provider_customer_id, provider_status, derived_state,
    catalog_version, plan_key, price_lookup_key, evidence_source, source_event_id, source_event_created_at, livemode)
   VALUES ('{S(3)}', 'sub_FakeBrowser01', 'cus_FakeBrowser01', 'active', 'active', '2026-11-03.v1', 'founder-pilot',
    'gradia_founder_pilot_2026_11_monthly', 'browser_redirect', 'evt_fake_redir_09', now(), false);
  RAISE EXCEPTION 'A redirect was stored as evidence';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
"""

TENANT_DELETE = f"""
DELETE FROM public.shops WHERE id IN ('{S(1)}','{S(2)}','{S(3)}','{S(4)}');
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM public.commercial_billing_accounts WHERE shop_id IN ('{S(1)}','{S(2)}','{S(3)}'))
  OR EXISTS (SELECT 1 FROM public.commercial_checkout_attempts WHERE shop_id IN ('{S(1)}','{S(2)}','{S(3)}'))
  OR EXISTS (SELECT 1 FROM public.commercial_billing_events WHERE shop_id IN ('{S(1)}','{S(2)}','{S(3)}'))
  OR EXISTS (SELECT 1 FROM public.commercial_subscription_evidence WHERE shop_id IN ('{S(1)}','{S(2)}','{S(3)}'))
  OR EXISTS (SELECT 1 FROM public.commercial_usage_recognitions WHERE shop_id = '{S(1)}')
 THEN RAISE EXCEPTION 'Tenant deletion left billing evidence behind'; END IF;
END $$;
"""

SEED3 = f"""
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES ('{U(6)}','owner3@example.test',now());
INSERT INTO public.shops(id,owner_id,name) VALUES ('{S(3)}','{U(6)}','Fictional legacy shop three');
"""

ACTIVATION = f"""
-- Atomic activation writer: service role + live owner only; tenant-bound; evidence-gated;
-- count enforced inside the transaction; disabling and already-active are never gated.
DO $$
DECLARE r jsonb; a1 uuid; a2 uuid; a3 uuid; foreign_agent uuid; who text; refused integer := 0; n integer;
BEGIN
 INSERT INTO auth.users(id,email,email_confirmed_at) VALUES ('{U(7)}','owner4@example.test',now());
 INSERT INTO public.shops(id,owner_id,name) VALUES ('{S(4)}','{U(7)}','Fictional active shop four');
 PERFORM set_config('request.jwt.claims', '{{"role":"service_role"}}', true);
 -- reviewed active Founder Pilot evidence for this workspace, through the real writers
 r := public.commercial_checkout_begin({BEGIN_ARGS(U(7), shop=S(4))});
 PERFORM public.commercial_checkout_bind_customer('{S(4)}', '{U(7)}', (r->>'attempt_id')::uuid, 'cus_FakeCustomer04');
 r := public.commercial_subscription_apply_evidence('{S(4)}','sub_FakeSub0004','cus_FakeCustomer04','active','2026-11-03.v1','founder-pilot','gradia_founder_pilot_2026_11_monthly','signed_webhook','evt_fake_active_004', now() - interval '1 minute', false, NULL);
 IF r->>'state' <> 'active' THEN RAISE EXCEPTION 'Fixture shop should be active: %', r; END IF;
 INSERT INTO public.custom_agents(shop_id, owner_id, name, problem_text, config) VALUES ('{S(4)}', '{U(7)}', 'probe 1', 'p', '{{}}') RETURNING id INTO a1;
 INSERT INTO public.custom_agents(shop_id, owner_id, name, problem_text, config) VALUES ('{S(4)}', '{U(7)}', 'probe 2', 'p', '{{}}') RETURNING id INTO a2;
 INSERT INTO public.custom_agents(shop_id, owner_id, name, problem_text, config) VALUES ('{S(4)}', '{U(7)}', 'probe 3', 'p', '{{}}') RETURNING id INTO a3;
 INSERT INTO public.custom_agents(shop_id, owner_id, name, problem_text, config) VALUES ('{S(2)}', '{U(5)}', 'probe foreign', 'p', '{{}}') RETURNING id INTO foreign_agent;

 FOREACH who IN ARRAY ARRAY['{U(2)}', '{U(3)}', '{U(4)}', '{U(5)}', '00000000-0000-4000-8000-00000000dead'] LOOP
  BEGIN
   PERFORM public.commercial_agent_activate('{S(4)}', who::uuid, a1);
   RAISE EXCEPTION 'Actor % was allowed to activate', who;
  EXCEPTION WHEN insufficient_privilege THEN refused := refused + 1; END;
 END LOOP;
 IF refused <> 5 THEN RAISE EXCEPTION 'Expected every non-owner refused, got %', refused; END IF;

 r := public.commercial_agent_activate('{S(4)}', '{U(7)}', foreign_agent);
 IF r->>'code' <> 'agent_not_found' THEN RAISE EXCEPTION 'Cross-shop agent must be not found: %', r; END IF;

 r := public.commercial_agent_activate('{S(4)}', '{U(7)}', a1);
 IF r->>'outcome' <> 'activated' THEN RAISE EXCEPTION 'Reviewed active evidence should allow activation: %', r; END IF;
 r := public.commercial_agent_activate('{S(4)}', '{U(7)}', a1);
 IF r->>'outcome' <> 'already_active' THEN RAISE EXCEPTION 'Already active must be a no-op: %', r; END IF;
 r := public.commercial_agent_activate('{S(4)}', '{U(7)}', a2);
 IF r->>'outcome' <> 'activated' THEN RAISE EXCEPTION 'Second agent should activate: %', r; END IF;
 r := public.commercial_agent_activate('{S(4)}', '{U(7)}', a3);
 IF r->>'code' <> 'active_agent_limit_reached' THEN RAISE EXCEPTION 'Third agent must be refused: %', r; END IF;
 SELECT count(*) INTO n FROM public.custom_agents WHERE shop_id = '{S(4)}' AND enabled;
 IF n <> 2 THEN RAISE EXCEPTION 'Exactly two agents should be active, got %', n; END IF;

 -- A workspace without reviewed active evidence never activates (S(2) is quarantined/mismatched above).
 INSERT INTO public.custom_agents(shop_id, owner_id, name, problem_text, config) VALUES ('{S(2)}', '{U(5)}', 'probe 4', 'p', '{{}}') RETURNING id INTO a1;
 r := public.commercial_agent_activate('{S(2)}', '{U(5)}', a1);
 IF r->>'outcome' <> 'blocked' THEN RAISE EXCEPTION 'No reviewed evidence must not activate: %', r; END IF;

 -- Guard: a browser role cannot enable an agent around the writer, but can disable.
 PERFORM set_config('request.jwt.claims', '{{"role":"authenticated","sub":"{U(1)}"}}', true);
 BEGIN
  UPDATE public.custom_agents SET enabled = true WHERE id = a3;
  RAISE EXCEPTION 'A browser role enabled an agent directly';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 UPDATE public.custom_agents SET enabled = false WHERE shop_id = '{S(4)}' AND enabled;
END $$;
"""

stages = [
    ("drop", DROP_PR_C), ("seed", SEED), ("migration", body), ("migration2", body2), ("unchanged", UNCHANGED), ("acls", ACLS), ("seed3", SEED3),
    ("authority", AUTHORITY), ("lifecycle", LIFECYCLE), ("stale", STALE_AND_UNKNOWN), ("evidence", EVIDENCE),
    ("activation", ACTIVATION), ("immutability", IMMUTABILITY), ("tenant_delete", TENANT_DELETE),
]
upto = os.environ.get('VERIFY_UPTO')  # debugging aid: stop (and roll back) after a named stage
if upto:
    stages = stages[: [n for n, _ in stages].index(upto) + 1]
script = "\n".join(["BEGIN;"] + [sql for _, sql in stages] + ["ROLLBACK;"])
outside = top_level(script).replace('ON COMMIT DROP', '')
assert re.search(r'(?i)\bcommit\b', outside) is None, 'the probe must never commit'
assert len(re.findall(r'(?m)^ROLLBACK;$', outside)) == 1 and outside.rstrip().endswith('ROLLBACK;'), 'the probe must end with exactly one ROLLBACK'
run(script)

# Nothing was changed: the migration is still applied exactly as before, with all its objects.
assert run("SELECT count(*) || ':' || max(version) FROM supabase_migrations.schema_migrations") == ledger_before
assert run("SELECT bool_and(to_regclass('public.' || t) IS NOT NULL) FROM unnest(ARRAY['commercial_billing_accounts','commercial_checkout_attempts','commercial_billing_events','commercial_subscription_evidence']) t") == 't'
assert run("SELECT count(*) FROM pg_trigger WHERE tgname IN ('commercial_checkout_attempts_guard','commercial_billing_accounts_guard','custom_agents_activation_guard') AND NOT tgisinternal") == '3'
assert run("SELECT count(*) FROM public.shops WHERE id IN ('%s','%s','%s')" % (S(1), S(2), S(3))) == '0'

print(
    f'PASS: upgrade {versions[-3]} -> {NEW} -> {NEW2} applied from their real SQL inside a rolled-back transaction; legacy '
    'shops, memberships, usage_events, PR A commercial usage and PR B membership evidence unchanged (content, xmin, ctid) '
    'and no billing state invented for existing shops; writers service-only, browser roles have no table or writer access; '
    'only a live owner can begin Checkout (manager, staff, revoked, cross-shop, unknown refused) and invalid catalog/plan/'
    'price/return target/fingerprint are refused; a changed in-flight request conflicts; a stale in-flight attempt is '
    'unknown/reconciliation_required and never retried; a completed session is never active; the platform customer binds once '
    'and never to a connected account or two workspaces; live mode, unreviewed sources and non-active statuses are '
    'unrepresentable as active evidence; out-of-order, duplicate-subscription, catalog and customer mismatches fail closed; '
    'history is append-only and attempt identity immutable; agent activation is one owner-verified transaction (service '
    'role + live owner, tenant-bound, evidence-gated, database-counted limit of two, already-active a no-op) and browser roles '
    'cannot enable an agent around it; tenant deletion holds; database left exactly as it was'
)
