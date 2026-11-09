"""Non-destructive upgrade probe for the immutable Agent definition migration (Build 1).

Everything runs inside ONE transaction on the unlinked gradia-isolated-tests stack and ends
with ROLLBACK, so no database state is ever changed or destroyed. Inside it the probe
  1. removes exactly the objects 20261107120000 created and restores the two functions it
     re-declares (custom_agents_activation_guard, claim_scheduled_agent_run) from the
     previous migrations' real SQL - i.e. the schema of current main,
  2. seeds fictional legacy shops, memberships, agents (enabled and disabled), runs, reviewed
     memory, an active Control Center policy and active Founder Pilot billing evidence,
  3. applies the migration's REAL SQL text (BEGIN/COMMIT wrapper removed so the outer
     transaction stays in control), and proves:
       * no existing shop, membership, agent, run, memory, policy, membership or commercial
         billing row was rewritten (content, xmin and physical position) and no definition
         state is invented for any existing agent (legacy agents stay unversioned),
       * function and table ACLs match the authority model (browser roles: nothing; service
         role: SELECT and the narrow commands only),
       * only a service-role caller naming a LIVE OWNER of the exact shop can save, activate,
         pause or block (manager, staff, revoked, cross-shop owner, unknown, browser refused),
       * revisions are immutable and gapless; lineage, exact replay and changed-replay conflict;
         history is append-only (UPDATE, DELETE and TRUNCATE are refused for every table),
       * memory is pinned to the exact reviewed revision and wrong-shop / unpublished memory is
         refused; stale policy, knowledge, readiness, evaluation, hash and pointer are refused,
       * ROLLBACK IN BOTH DIRECTIONS with injected failures: a failure in the pointer write
         rolls `custom_agents.enabled` back, and a failure of the enabling write leaves the
         pointer and history untouched,
       * the two-active-agent cap and missing Founder Pilot evidence block activation without
         moving a pointer; paused/blocked definitions cannot claim; legacy claims are unchanged;
         a governed agent cannot be enabled around activation by any role,
       * the tenant-deletion contract holds and a single governed agent cannot be deleted.
  4. rolls everything back, then confirms the migration is still applied exactly as before.
No credential-bearing output is printed. Concurrency is proven by the integration suite
(real parallel connections), which one transaction cannot exercise.
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

NEW = '20261107120000'    # agent definition revisions
PREV_CLAIM = '20261029120000'   # claim_scheduled_agent_run
PREV_GUARD = '20261106130000'   # custom_agents_activation_guard


def migration_text(version):
    return next((root / 'supabase/migrations').glob(f'{version}_*.sql')).read_text()


def migration_body(version):
    text = migration_text(version).strip()
    assert text.startswith('BEGIN;') and text.endswith('COMMIT;'), 'migration must be one BEGIN..COMMIT block'
    return text[len('BEGIN;'):-len('COMMIT;')]


def top_level(sql):
    """SQL with dollar-quoted bodies removed: PL/pgSQL BEGIN/END blocks are not transaction control."""
    assert re.search(r'\$[A-Za-z_]\w*\$', sql) is None, 'named dollar quotes are not handled'
    return re.sub(r'\$\$.*?\$\$', '$$$$', sql, flags=re.S)


body = migration_body(NEW)
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
        detail = errors[0].split('ERROR:', 1)[1].strip()[:300] if errors else 'no detail'
        extra = ('\n' + result.stderr[-2500:]) if os.environ.get('VERIFY_DEBUG') == '1' else ''
        raise SystemExit(f'FAIL: probe failed ({detail}); the transaction was rolled back; raw output withheld' + extra)
    return result.stdout.strip()


IDS = {}
for n in range(1, 10):
    IDS[f'U{n}'] = f'00000000-0000-4000-8000-0000000a{n:04d}'   # auth users
    IDS[f'S{n}'] = f'00000000-0000-4000-8000-0000000b{n:04d}'   # shops
    IDS[f'A{n}'] = f'00000000-0000-4000-8000-0000000c{n:04d}'   # agents
    IDS[f'R{n}'] = f'00000000-0000-4000-8000-0000000d{n:04d}'   # request ids
IDS['DEAD'] = '00000000-0000-4000-8000-00000000dead'


def fmt(sql):
    for key in sorted(IDS, key=len, reverse=True):
        sql = sql.replace(f'@{key}@', IDS[key])
    assert re.search(r'@[A-Z]+[0-9]*@', sql) is None, 'unresolved placeholder'
    return sql


assert run("SELECT max(version) FROM supabase_migrations.schema_migrations") == versions[-1] == NEW, 'stack must be at the latest migration'
ledger_before = run("SELECT count(*) || ':' || max(version) FROM supabase_migrations.schema_migrations")


def function_block(text, start, end_marker):
    a = text.index(start)
    b = text.index(end_marker, a)
    return text[a:b].replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION', 1)


ORIG_CLAIM = function_block(migration_text(PREV_CLAIM), 'CREATE FUNCTION public.claim_scheduled_agent_run(', 'CREATE FUNCTION public.finish_scheduled_agent_run(')
ORIG_GUARD = function_block(migration_text(PREV_GUARD), 'CREATE FUNCTION public.custom_agents_activation_guard()', 'CREATE TRIGGER custom_agents_activation_guard')

OBJECT_FUNCS = [
    'agent_definition_create_revision(uuid,uuid,uuid,uuid,jsonb,integer)',
    'agent_definition_record_evaluation(uuid,uuid,integer,text,text,text,text,text,numeric,boolean,integer,jsonb,timestamptz,text)',
    'agent_definition_activate(uuid,uuid,uuid,integer,text,integer,integer,integer,text[],text)',
    'agent_definition_set_lifecycle(uuid,uuid,uuid,text,text,integer)',
    'agent_definition_emit(uuid,uuid,text,integer,integer,uuid,jsonb)',
    'agent_definition_open_write()', 'agent_definition_close_write()',
    'agent_definition_actor_role(uuid,uuid)', 'agent_definition_connector_fingerprint(uuid)', 'agent_definition_require_service()',
    'agent_definition_state_guard()', 'agent_definition_append_only()',
    'custom_agents_governed_disable()',
]
TABLES = ['agent_definition_events', 'agent_definition_evaluations', 'agent_definition_memory_pins',
          'agent_definition_state', 'agent_definition_revisions']

DROP_NEW = f"""
DROP TRIGGER custom_agents_governed_disable ON public.custom_agents;
{ORIG_GUARD}
{ORIG_CLAIM}
DROP TABLE public.agent_definition_events, public.agent_definition_evaluations, public.agent_definition_memory_pins,
  public.agent_definition_state, public.agent_definition_revisions CASCADE;
""" + "\n".join(f"DROP FUNCTION public.{f};" for f in OBJECT_FUNCS) + """
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname LIKE 'agent\\_definition\\_%')
  OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND (p.proname LIKE 'agent\\_definition\\_%' OR p.proname = 'custom_agents_governed_disable'))
 THEN RAISE EXCEPTION 'Pre-Build-1 schema was not restored'; END IF;
END $$;
"""

FP_SOURCES = """
   SELECT 'shops' tbl, id::text pk, to_jsonb(t)::text content, t.xmin::text x, t.ctid::text p FROM public.shops t
   UNION ALL SELECT 'shop_memberships', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.shop_memberships t
   UNION ALL SELECT 'custom_agents', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.custom_agents t
   UNION ALL SELECT 'custom_agent_runs', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.custom_agent_runs t
   UNION ALL SELECT 'reviewed_memory_sources', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.reviewed_memory_sources t
   UNION ALL SELECT 'reviewed_memory_revisions', shop_id::text || source_id::text || revision::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.reviewed_memory_revisions t
   UNION ALL SELECT 'reviewed_memory_active', shop_id::text || source_id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.reviewed_memory_active t
   UNION ALL SELECT 'reviewed_memory_heads', shop_id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.reviewed_memory_heads t
   UNION ALL SELECT 'control_policy_history', shop_id::text || revision::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.control_policy_history t
   UNION ALL SELECT 'control_policy_active', shop_id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.control_policy_active t
   UNION ALL SELECT 'commercial_billing_accounts', shop_id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_billing_accounts t
   UNION ALL SELECT 'commercial_checkout_attempts', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_checkout_attempts t
   UNION ALL SELECT 'commercial_billing_events', shop_id::text || shop_seq::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_billing_events t
   UNION ALL SELECT 'commercial_subscription_evidence', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_subscription_evidence t
   UNION ALL SELECT 'commercial_usage_recognitions', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.commercial_usage_recognitions t
   UNION ALL SELECT 'usage_events', id::text, to_jsonb(t)::text, t.xmin::text, t.ctid::text FROM public.usage_events t
"""

SERVICE = "SELECT set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true);"


def as_user(u):
    return f"SELECT set_config('request.jwt.claims', '{{\"role\":\"authenticated\",\"sub\":\"@{u}@\"}}', true);"


SEED = f"""
{SERVICE}
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES
 ('@U1@','owner1@example.test',now()),('@U2@','manager1@example.test',now()),
 ('@U3@','staff1@example.test',now()),('@U4@','gone1@example.test',now()),
 ('@U5@','owner2@example.test',now());
INSERT INTO public.shops(id,owner_id,name) VALUES
 ('@S1@','@U1@','Fictional legacy shop one'),('@S2@','@U5@','Fictional legacy shop two');
INSERT INTO public.shop_memberships(shop_id,user_id,role,active,revoked_at,capabilities) VALUES
 ('@S1@','@U2@','manager',true,NULL,'{{}}'),
 ('@S1@','@U3@','staff',true,NULL,'{{}}'),
 ('@S1@','@U4@','manager',false,now() - interval '3 days','{{}}');

-- Legacy agents: S1 has disabled ones, S2 has an ENABLED one that must keep working.
INSERT INTO public.custom_agents(id,shop_id,owner_id,name,problem_text,config,enabled) VALUES
 ('@A1@','@S2@','@U5@','legacy enabled','p','{{"legacy":true}}',true),
 ('@A5@','@S1@','@U1@','legacy disabled','p','{{"legacy":true}}',false),
 ('@A2@','@S1@','@U1@','candidate 2','p','{{}}',false),
 ('@A3@','@S1@','@U1@','candidate 3','p','{{}}',false),
 ('@A4@','@S1@','@U1@','candidate 4','p','{{}}',false),
 ('@A6@','@S2@','@U5@','candidate in S2','p','{{}}',false);
INSERT INTO public.custom_agent_runs(agent_id,shop_id,trigger_source,fired,reason)
 VALUES ('@A1@','@S2@','manual',true,'legacy run'),('@A5@','@S1@','manual',false,'legacy skip');

-- Active Control Center policy for both shops (owner session simulated by the JWT claim).
{as_user('U1')}
SELECT public.activate_control_policy('@S1@', (SELECT revision FROM public.control_policy_drafts WHERE shop_id = '@S1@'), NULL);
{as_user('U5')}
SELECT public.activate_control_policy('@S2@', (SELECT revision FROM public.control_policy_drafts WHERE shop_id = '@S2@'), NULL);

-- Reviewed, published memory in S1 (and a distinct one in S2).
{as_user('U1')}
DO $$ DECLARE c jsonb; BEGIN
 c := public.create_reviewed_memory_candidate('@S1@', 'Refund policy', 'Deposits are refundable.', '[{{"content":"Deposits are refundable.","embedding":null}}]'::jsonb, NULL, NULL, NULL, NULL, NULL);
 PERFORM public.review_memory_revision('@S1@', (c->>'source_id')::uuid, (c->>'revision')::int);
 PERFORM public.publish_memory_revision('@S1@', (c->>'source_id')::uuid, (c->>'revision')::int, NULL);
 CREATE TEMP TABLE probe_mem(label text, source_id uuid, revision int) ON COMMIT DROP;
 INSERT INTO probe_mem VALUES ('s1', (c->>'source_id')::uuid, (c->>'revision')::int);
END $$;
{as_user('U5')}
DO $$ DECLARE c jsonb; BEGIN
 c := public.create_reviewed_memory_candidate('@S2@', 'Other shop policy', 'Other shop text.', '[{{"content":"Other shop text.","embedding":null}}]'::jsonb, NULL, NULL, NULL, NULL, NULL);
 PERFORM public.review_memory_revision('@S2@', (c->>'source_id')::uuid, (c->>'revision')::int);
 PERFORM public.publish_memory_revision('@S2@', (c->>'source_id')::uuid, (c->>'revision')::int, NULL);
 INSERT INTO probe_mem VALUES ('s2', (c->>'source_id')::uuid, (c->>'revision')::int);
END $$;

-- Active Founder Pilot billing evidence for S1 only (S2 deliberately has none).
{SERVICE}
DO $$ DECLARE r jsonb; att uuid; BEGIN
 r := public.commercial_checkout_begin('@S1@', '@U1@', '2026-11-03.v1', 'founder-pilot', 'gradia_founder_pilot_2026_11_monthly', 'agents', '{'a' * 64}');
 att := (r->>'attempt_id')::uuid;
 PERFORM public.commercial_checkout_bind_customer('@S1@', '@U1@', att, 'cus_FakeVerifier01');
 PERFORM public.commercial_subscription_apply_evidence('@S1@', 'sub_FakeVerifier01', 'cus_FakeVerifier01', 'active', '2026-11-03.v1', 'founder-pilot',
   'gradia_founder_pilot_2026_11_monthly', 'signed_webhook', 'evt_fake_verifier_01', now() - interval '1 minute', false, att);
 IF (SELECT state FROM public.commercial_billing_accounts WHERE shop_id = '@S1@') <> 'active' THEN RAISE EXCEPTION 'seed billing not active'; END IF;
END $$;

-- Row-exact fingerprints of everything that must not change.
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
 IF EXISTS (SELECT 1 FROM public.agent_definition_state) OR EXISTS (SELECT 1 FROM public.agent_definition_revisions)
  OR EXISTS (SELECT 1 FROM public.agent_definition_events) OR EXISTS (SELECT 1 FROM public.agent_definition_evaluations)
  OR EXISTS (SELECT 1 FROM public.agent_definition_memory_pins)
 THEN RAISE EXCEPTION 'The upgrade must not invent definition state for existing agents'; END IF;
END $$;
"""

ACLS = """
DO $$
DECLARE r text; f text; t text;
BEGIN
 FOREACH f IN ARRAY ARRAY[
   'public.agent_definition_create_revision(uuid,uuid,uuid,uuid,jsonb,integer)',
   'public.agent_definition_record_evaluation(uuid,uuid,integer,text,text,text,text,text,numeric,boolean,integer,jsonb,timestamptz,text)',
   'public.agent_definition_activate(uuid,uuid,uuid,integer,text,integer,integer,integer,text[],text)',
   'public.agent_definition_set_lifecycle(uuid,uuid,uuid,text,text,integer)',
   'public.agent_definition_actor_role(uuid,uuid)',
   'public.agent_definition_connector_fingerprint(uuid)',
   'public.claim_scheduled_agent_run(uuid,text,uuid,integer)'] LOOP
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
   OR NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
   RAISE EXCEPTION 'Command % must be executable by the service role only', f; END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY[
   'public.agent_definition_emit(uuid,uuid,text,integer,integer,uuid,jsonb)', 'public.agent_definition_open_write()',
   'public.agent_definition_close_write()', 'public.agent_definition_require_service()',
   'public.agent_definition_state_guard()', 'public.agent_definition_append_only()',
   'public.custom_agents_governed_disable()', 'public.custom_agents_activation_guard()',
   'public.commercial_agent_activate(uuid,uuid,uuid)'] LOOP
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
   IF has_function_privilege(r, f, 'EXECUTE') THEN RAISE EXCEPTION 'Internal function % must not be executable by %', f, r; END IF;
  END LOOP;
 END LOOP;
 FOREACH f IN ARRAY ARRAY[
   'public.agent_definition_emit(uuid,uuid,text,integer,integer,uuid,jsonb)', 'public.agent_definition_open_write()',
   'public.agent_definition_close_write()', 'public.agent_definition_require_service()',
   'public.agent_definition_state_guard()', 'public.agent_definition_append_only()',
   'public.custom_agents_governed_disable()', 'public.custom_agents_activation_guard()'] LOOP
  IF has_function_privilege('service_role', f, 'EXECUTE') THEN RAISE EXCEPTION 'Helper % must not be executable by the service role', f; END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['public.agent_definition_state','public.agent_definition_revisions','public.agent_definition_memory_pins',
   'public.agent_definition_evaluations','public.agent_definition_events'] LOOP
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF has_table_privilege(r, t, 'INSERT') OR has_table_privilege(r, t, 'UPDATE')
    OR has_table_privilege(r, t, 'DELETE') OR has_table_privilege(r, t, 'TRUNCATE') OR has_table_privilege(r, t, 'REFERENCES') THEN
    RAISE EXCEPTION 'Unsafe table write privilege on % for %', t, r; END IF;
  END LOOP;
  IF has_table_privilege('anon', t, 'SELECT') OR has_table_privilege('authenticated', t, 'SELECT')
   OR NOT has_table_privilege('service_role', t, 'SELECT') THEN
   RAISE EXCEPTION 'Table read authority wrong on %', t; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = t::regclass) THEN RAISE EXCEPTION 'RLS off on %', t; END IF;
 END LOOP;
END $$;
"""

DEF = """'{"schemaVersion":1,"key":"verifier-agent","job":{"roleLabel":"Quote follow-up","goal":"Follow up on open quotes politely.","expectedOutcomes":["Quote answered"],"stopConditions":["Customer says stop"]},"knowledge":{"sourceIds":[],"includeShopKnowledge":false,"includeCustomerMemory":false,"maxResultsPerQuery":4},"tools":[{"operation":"crm.read","maximumMode":"read"}],"schedule":{"kind":"manual"},"limits":{"maximumStepsPerRun":5,"maximumRuntimeSeconds":120,"maximumCreditsPerRun":50,"maximumRunsPerDay":20,"maximumConcurrentRuns":1},"routing":{"strategy":"cost_aware","semanticCache":false}}'::jsonb"""

AUTHORITY = f"""
-- A non-service caller cannot even execute a command (service role required, 42501).
DO $$ BEGIN
 BEGIN
  PERFORM set_config('request.jwt.claims', '{{"role":"authenticated","sub":"@U1@"}}', true);
  PERFORM public.agent_definition_create_revision('@S1@', '@U1@', '@A2@', '@R1@', {DEF}, NULL);
  RAISE EXCEPTION 'An authenticated caller executed a command';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  PERFORM set_config('request.jwt.claims', '{{"role":"anon"}}', true);
  PERFORM public.agent_definition_activate('@S1@', '@U1@', '@A2@', 1, '{'a' * 64}', NULL, 1, 1, ARRAY['crm.read'], public.agent_definition_connector_fingerprint('@S1@'));
  RAISE EXCEPTION 'An anonymous caller executed a command';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;

-- Only a LIVE OWNER of that exact shop, via the service role, may use a command.
DO $$
DECLARE refused integer := 0; who text; r jsonb;
BEGIN
 PERFORM set_config('request.jwt.claims', '{{"role":"service_role"}}', true);
 FOREACH who IN ARRAY ARRAY['@U2@', '@U3@', '@U4@', '@U5@', '@DEAD@'] LOOP
  BEGIN
   PERFORM public.agent_definition_create_revision('@S1@', who::uuid, '@A2@', '@R1@', {DEF}, NULL);
   RAISE EXCEPTION 'Actor % was allowed to save a revision', who;
  EXCEPTION WHEN insufficient_privilege THEN refused := refused + 1; END;
  BEGIN
   PERFORM public.agent_definition_set_lifecycle('@S1@', who::uuid, '@A2@', 'paused', 'nope', NULL);
   RAISE EXCEPTION 'Actor % was allowed to pause', who;
  EXCEPTION WHEN insufficient_privilege THEN refused := refused + 1; END;
  BEGIN
   PERFORM public.agent_definition_activate('@S1@', who::uuid, '@A2@', 1, '{'a' * 64}', NULL, 1, 1, ARRAY['crm.read'], public.agent_definition_connector_fingerprint('@S1@'));
   RAISE EXCEPTION 'Actor % was allowed to activate', who;
  EXCEPTION WHEN insufficient_privilege THEN refused := refused + 1; END;
 END LOOP;
 IF refused <> 15 THEN RAISE EXCEPTION 'Expected 15 refusals (manager, staff, revoked, cross-shop owner, unknown x 3 commands); got %', refused; END IF;
 IF EXISTS (SELECT 1 FROM public.agent_definition_state) OR EXISTS (SELECT 1 FROM public.agent_definition_revisions) THEN
  RAISE EXCEPTION 'A refused caller left state behind'; END IF;

 -- Tenant binding: another shop's agent is "not found", never writable by naming it.
 r := public.agent_definition_create_revision('@S1@', '@U1@', '@A6@', '@R1@', {DEF}, NULL);
 IF r->>'code' <> 'agent_not_found' THEN RAISE EXCEPTION 'Cross-shop agent must be not found: %', r; END IF;
 -- A legacy ENABLED agent is not silently converted.
 r := public.agent_definition_create_revision('@S2@', '@U5@', '@A1@', '@R1@', {DEF}, NULL);
 IF r->>'code' <> 'legacy_agent_enabled' THEN RAISE EXCEPTION 'Enabled legacy agent must not be converted: %', r; END IF;
 IF EXISTS (SELECT 1 FROM public.agent_definition_state) THEN RAISE EXCEPTION 'Refusals left state behind'; END IF;
 -- The database refuses unvalidated JSON from a trusted caller.
 BEGIN PERFORM public.agent_definition_create_revision('@S1@', '@U1@', '@A2@', '@R1@', ({DEF}) || '{{"systemPrompt":"x"}}'::jsonb, NULL);
  RAISE EXCEPTION 'An unsupported field was accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN PERFORM public.agent_definition_create_revision('@S1@', '@U1@', '@A2@', '@R1@', ({DEF}) || '{{"revision":9}}'::jsonb, NULL);
  RAISE EXCEPTION 'A client revision was accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
END $$;
"""

REVISIONS = f"""
{SERVICE}
DO $$
DECLARE r jsonb; r2 jsonb; h text; n integer;
BEGIN
 r := public.agent_definition_create_revision('@S1@', '@U1@', '@A2@', '@R1@', {DEF}, NULL);
 IF r->>'outcome' <> 'created' OR (r->>'revision')::int <> 1 OR r->'parent_revision' <> 'null'::jsonb THEN RAISE EXCEPTION 'First save: %', r; END IF;
 SELECT encode(sha256(convert_to(definition::text, 'UTF8')), 'hex') INTO h FROM public.agent_definition_revisions WHERE agent_id = '@A2@' AND revision = 1;
 IF h <> r->>'definition_hash' THEN RAISE EXCEPTION 'Stored hash does not match the stored definition'; END IF;
 IF (SELECT definition->>'lifecycle' FROM public.agent_definition_revisions WHERE agent_id = '@A2@' AND revision = 1) <> 'draft' THEN
  RAISE EXCEPTION 'A stored revision must be a draft'; END IF;
 -- Exact replay returns the same revision; a changed replay conflicts.
 r2 := public.agent_definition_create_revision('@S1@', '@U1@', '@A2@', '@R1@', {DEF}, NULL);
 IF r2->>'outcome' <> 'replayed' OR r2->>'definition_hash' <> r->>'definition_hash' THEN RAISE EXCEPTION 'Replay: %', r2; END IF;
 BEGIN PERFORM public.agent_definition_create_revision('@S1@', '@U1@', '@A2@', '@R1@', jsonb_set({DEF}, '{{job,goal}}', '"A different goal for the agent."'), NULL);
  RAISE EXCEPTION 'A changed replay was accepted';
 EXCEPTION WHEN SQLSTATE 'AD409' THEN NULL; END;
 -- Lineage: a second save descends from the first, with a gapless number.
 r2 := public.agent_definition_create_revision('@S1@', '@U1@', '@A2@', '@R2@', {DEF}, 1);
 IF (r2->>'revision')::int <> 2 OR (r2->>'parent_revision')::int <> 1 THEN RAISE EXCEPTION 'Lineage: %', r2; END IF;
 IF (SELECT definition_hash FROM public.agent_definition_revisions WHERE agent_id = '@A2@' AND revision = 2) = h THEN
  RAISE EXCEPTION 'Distinct revisions must have distinct hashes (revision number is part of the definition)'; END IF;
 r2 := public.agent_definition_create_revision('@S1@', '@U1@', '@A2@', '@R3@', {DEF}, 99);
 IF r2->>'code' <> 'parent_not_found' THEN RAISE EXCEPTION 'Unknown parent: %', r2; END IF;
 SELECT latest_revision INTO n FROM public.agent_definition_state WHERE agent_id = '@A2@';
 IF n <> 2 THEN RAISE EXCEPTION 'Counter should be 2, got %', n; END IF;
 IF (SELECT count(*) FROM public.agent_definition_events WHERE agent_id = '@A2@') <> 2 THEN RAISE EXCEPTION 'History should hold two events'; END IF;
END $$;

-- Memory is pinned to the EXACT reviewed revision; wrong-shop / unpublished memory is refused.
DO $$
DECLARE r jsonb; m1 uuid; m1r int; m2 uuid; pins int;
BEGIN
 SELECT source_id, revision INTO m1, m1r FROM probe_mem WHERE label = 's1';
 SELECT source_id INTO m2 FROM probe_mem WHERE label = 's2';
 r := public.agent_definition_create_revision('@S1@', '@U1@', '@A3@', '@R4@',
   jsonb_set({DEF}, '{{knowledge,sourceIds}}', jsonb_build_array(m1)), NULL);
 IF r->>'outcome' <> 'created' THEN RAISE EXCEPTION 'Pinned save: %', r; END IF;
 SELECT count(*) INTO pins FROM public.agent_definition_memory_pins WHERE agent_id = '@A3@' AND revision = 1 AND source_id = m1 AND memory_revision = m1r;
 IF pins <> 1 THEN RAISE EXCEPTION 'Memory was not pinned to the exact reviewed revision'; END IF;
 r := public.agent_definition_create_revision('@S1@', '@U1@', '@A4@', '@R5@',
   jsonb_set({DEF}, '{{knowledge,sourceIds}}', jsonb_build_array(m2)), NULL);
 IF r->>'code' <> 'memory_not_selectable' THEN RAISE EXCEPTION 'Another shop''s memory must not be selectable: %', r; END IF;
 r := public.agent_definition_create_revision('@S1@', '@U1@', '@A4@', '@R5@',
   jsonb_set({DEF}, '{{knowledge,sourceIds}}', jsonb_build_array(gen_random_uuid())), NULL);
 IF r->>'code' <> 'memory_not_selectable' THEN RAISE EXCEPTION 'Unknown memory must not be selectable: %', r; END IF;
 IF EXISTS (SELECT 1 FROM public.agent_definition_state WHERE agent_id = '@A4@') AND (SELECT latest_revision FROM public.agent_definition_state WHERE agent_id = '@A4@') <> 0 THEN
  RAISE EXCEPTION 'A refused save advanced the counter'; END IF;
END $$;
"""

IMMUTABILITY = """
-- The probe runs as the table owner, so privileges do not apply: ONLY the triggers stand in the way.
DO $$
DECLARE t text; refused integer := 0;
BEGIN
 FOREACH t IN ARRAY ARRAY['agent_definition_revisions','agent_definition_memory_pins','agent_definition_evaluations','agent_definition_events'] LOOP
  BEGIN EXECUTE format('UPDATE public.%I SET shop_id = shop_id', t);
   RAISE EXCEPTION '% accepted an UPDATE', t;
  EXCEPTION WHEN insufficient_privilege THEN refused := refused + 1; END;
  BEGIN EXECUTE format('DELETE FROM public.%I', t);
   RAISE EXCEPTION '% accepted a DELETE', t;
  EXCEPTION WHEN insufficient_privilege THEN refused := refused + 1; END;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['agent_definition_revisions','agent_definition_memory_pins','agent_definition_evaluations','agent_definition_events','agent_definition_state'] LOOP
  BEGIN EXECUTE format('TRUNCATE public.%I CASCADE', t);
   RAISE EXCEPTION '% accepted a TRUNCATE', t;
  EXCEPTION WHEN insufficient_privilege THEN refused := refused + 1; END;
 END LOOP;
 IF refused <> 13 THEN RAISE EXCEPTION 'Expected 13 refusals, got %', refused; END IF;
 -- The pointer row changes only through the commands (transaction-local flag).
 BEGIN UPDATE public.agent_definition_state SET lifecycle = 'blocked' WHERE agent_id = '@A2@';
  RAISE EXCEPTION 'The pointer row accepted a direct UPDATE';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN DELETE FROM public.agent_definition_state WHERE agent_id = '@A2@';
  RAISE EXCEPTION 'The pointer row accepted a direct DELETE';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 -- Even with the flag open, identity and version discipline hold.
 PERFORM public.agent_definition_open_write();
 BEGIN UPDATE public.agent_definition_state SET version = version + 5 WHERE agent_id = '@A2@';
  RAISE EXCEPTION 'The version advanced by more than one';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE public.agent_definition_state SET latest_revision = 0 WHERE agent_id = '@A2@';
  RAISE EXCEPTION 'The revision counter moved backwards';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE public.agent_definition_state SET agent_id = '@A5@' WHERE agent_id = '@A2@';
  RAISE EXCEPTION 'The identity was rewritten';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 PERFORM public.agent_definition_close_write();
 -- The pointer cannot reference a revision that does not exist.
 PERFORM public.agent_definition_open_write();
 BEGIN UPDATE public.agent_definition_state SET lifecycle = 'active', active_revision = 1, version = version + 1 WHERE agent_id = '@A3@';
  UPDATE public.agent_definition_state SET active_revision = 9, latest_revision = 9, version = version + 1 WHERE agent_id = '@A3@';
  RAISE EXCEPTION 'A pointer to a missing revision was accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
 PERFORM public.agent_definition_close_write();
 -- A tenant cannot be crossed by the revision foreign key.
 BEGIN INSERT INTO public.agent_definition_revisions(shop_id, agent_id, revision, schema_version, definition, definition_hash, request_id, request_fingerprint, authored_by)
   VALUES ('@S2@', '@A2@', 7, 1, '{"schemaVersion":1,"revision":7,"lifecycle":"draft"}', repeat('a', 64), gen_random_uuid(), repeat('a', 64), '@U5@');
  RAISE EXCEPTION 'A revision crossed tenants';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
END $$;
"""

ACTIVATION = f"""
{SERVICE}
-- Exact-revision evaluation evidence is recorded by the trusted seam only.
DO $$
DECLARE r jsonb; h1 text; h2 text; ev jsonb; base text;
BEGIN
 SELECT definition_hash INTO h1 FROM public.agent_definition_revisions WHERE agent_id = '@A2@' AND revision = 1;
 SELECT definition_hash INTO h2 FROM public.agent_definition_revisions WHERE agent_id = '@A2@' AND revision = 2;
 -- Without evidence the exact revision is refused, and nothing is written.
 r := public.agent_definition_activate('@S1@', '@U1@', '@A2@', 1, h1, NULL, (SELECT revision FROM public.control_policy_active WHERE shop_id = '@S1@'), 1, ARRAY['crm.read'], public.agent_definition_connector_fingerprint('@S1@'));
 IF r->>'outcome' <> 'blocked' OR r->'reasons' <> '["evaluation_required"]'::jsonb THEN RAISE EXCEPTION 'Missing evaluation: %', r; END IF;
 -- A client "source" is refused even from the service role.
 BEGIN PERFORM public.agent_definition_record_evaluation('@S1@', '@A2@', 1, h1, 'k', 's', 'f', repeat('b', 64), 1, true, 1, '{{}}', now() - interval '1 second', 'client');
  RAISE EXCEPTION 'A forged evaluation source was accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 -- Wrong hash / wrong revision / other shop's agent are refused.
 IF public.agent_definition_record_evaluation('@S1@', '@A2@', 1, repeat('f', 64), 'k', 's', 'f', repeat('b', 64), 1, true, 1, '{{}}', now() - interval '1 second', 'trusted_evaluator')->>'code' <> 'definition_hash_mismatch' THEN RAISE EXCEPTION 'hash mismatch'; END IF;
 IF public.agent_definition_record_evaluation('@S1@', '@A2@', 9, h1, 'k', 's', 'f', repeat('b', 64), 1, true, 1, '{{}}', now() - interval '1 second', 'trusted_evaluator')->>'code' <> 'revision_not_found' THEN RAISE EXCEPTION 'revision'; END IF;
 IF public.agent_definition_record_evaluation('@S2@', '@A2@', 1, h1, 'k', 's', 'f', repeat('b', 64), 1, true, 1, '{{}}', now() - interval '1 second', 'trusted_evaluator')->>'code' <> 'agent_not_found' THEN RAISE EXCEPTION 'cross shop'; END IF;
 -- Weak then unsafe then strong (newest wins; failures remain in the record).
 PERFORM public.agent_definition_record_evaluation('@S1@', '@A2@', 1, h1, 'weak', 's', 'f', repeat('b', 64), 0.9, true, 1, '{{}}', now() - interval '4 seconds', 'trusted_evaluator');
 r := public.agent_definition_activate('@S1@', '@U1@', '@A2@', 1, h1, NULL, (SELECT revision FROM public.control_policy_active WHERE shop_id = '@S1@'), 1, ARRAY['crm.read'], public.agent_definition_connector_fingerprint('@S1@'));
 IF r->'reasons' <> '["quality_evaluation_failed"]'::jsonb THEN RAISE EXCEPTION 'Weak: %', r; END IF;
 PERFORM public.agent_definition_record_evaluation('@S1@', '@A2@', 1, h1, 'unsafe', 's', 'f', repeat('b', 64), 1, false, 1, '{{}}', now() - interval '3 seconds', 'trusted_evaluator');
 r := public.agent_definition_activate('@S1@', '@U1@', '@A2@', 1, h1, NULL, (SELECT revision FROM public.control_policy_active WHERE shop_id = '@S1@'), 1, ARRAY['crm.read'], public.agent_definition_connector_fingerprint('@S1@'));
 IF r->'reasons' <> '["safety_evaluation_failed"]'::jsonb THEN RAISE EXCEPTION 'Unsafe: %', r; END IF;
 -- Evidence recorded for revision 1 never satisfies revision 2.
 r := public.agent_definition_activate('@S1@', '@U1@', '@A2@', 2, h2, NULL, (SELECT revision FROM public.control_policy_active WHERE shop_id = '@S1@'), 1, ARRAY['crm.read'], public.agent_definition_connector_fingerprint('@S1@'));
 IF r->'reasons' <> '["evaluation_required"]'::jsonb THEN RAISE EXCEPTION 'Other revision evidence: %', r; END IF;
 PERFORM public.agent_definition_record_evaluation('@S1@', '@A2@', 1, h1, 'good', 's', 'f', repeat('b', 64), 1, true, 12, '{{"basis":"synthetic"}}', now() - interval '2 seconds', 'trusted_evaluator');
 IF (SELECT count(*) FROM public.agent_definition_evaluations WHERE agent_id = '@A2@') <> 3 THEN RAISE EXCEPTION 'Failures must stay in the append-only record'; END IF;
 IF NOT public.agent_definition_record_evaluation('@S1@', '@A2@', 1, h1, 'good', 's', 'f', repeat('b', 64), 1, true, 12, '{{"basis":"synthetic"}}', now() - interval '2 seconds', 'trusted_evaluator') ? 'evaluation_id'
  OR public.agent_definition_record_evaluation('@S1@', '@A2@', 1, h1, 'good', 's', 'f', repeat('b', 64), 1, true, 12, '{{"basis":"synthetic"}}', now() - interval '2 seconds', 'trusted_evaluator')->>'outcome' <> 'replayed' THEN
  RAISE EXCEPTION 'Evaluation replay must be recognized'; END IF;
 BEGIN PERFORM public.agent_definition_record_evaluation('@S1@', '@A2@', 1, h1, 'good', 's', 'f', repeat('b', 64), 0.5, true, 12, '{{"basis":"synthetic"}}', now() - interval '2 seconds', 'trusted_evaluator');
  RAISE EXCEPTION 'A changed evaluation replay was accepted';
 EXCEPTION WHEN SQLSTATE 'AD409' THEN NULL; END;
END $$;

-- Stale / wrong application evidence is refused by the database on its own.
DO $$
DECLARE r jsonb; h1 text; pol int;
BEGIN
 SELECT definition_hash INTO h1 FROM public.agent_definition_revisions WHERE agent_id = '@A2@' AND revision = 1;
 SELECT revision INTO pol FROM public.control_policy_active WHERE shop_id = '@S1@';
 IF public.agent_definition_activate('@S1@', '@U1@', '@A2@', 1, repeat('e', 64), NULL, pol, 1, ARRAY['crm.read'], public.agent_definition_connector_fingerprint('@S1@'))->>'code' <> 'definition_hash_mismatch' THEN RAISE EXCEPTION 'hash'; END IF;
 IF public.agent_definition_activate('@S1@', '@U1@', '@A2@', 8, h1, NULL, pol, 1, ARRAY['crm.read'], public.agent_definition_connector_fingerprint('@S1@'))->>'code' <> 'revision_not_found' THEN RAISE EXCEPTION 'revision'; END IF;
 IF public.agent_definition_activate('@S1@', '@U1@', '@A2@', 1, h1, 4, pol, 1, ARRAY['crm.read'], public.agent_definition_connector_fingerprint('@S1@'))->>'code' <> 'pointer_changed' THEN RAISE EXCEPTION 'pointer'; END IF;
 IF public.agent_definition_activate('@S1@', '@U1@', '@A2@', 1, h1, NULL, pol + 7, 1, ARRAY['crm.read'], public.agent_definition_connector_fingerprint('@S1@'))->'reasons' <> '["policy_stale"]'::jsonb THEN RAISE EXCEPTION 'policy'; END IF;
 IF public.agent_definition_activate('@S1@', '@U1@', '@A2@', 1, h1, NULL, pol, 9, ARRAY['crm.read'], public.agent_definition_connector_fingerprint('@S1@'))->'reasons' <> '["knowledge_stale"]'::jsonb THEN RAISE EXCEPTION 'knowledge'; END IF;
 IF public.agent_definition_activate('@S1@', '@U1@', '@A2@', 1, h1, NULL, pol, 1, ARRAY[]::text[], public.agent_definition_connector_fingerprint('@S1@'))->'reasons' <> '["tool_not_ready"]'::jsonb THEN RAISE EXCEPTION 'readiness'; END IF;
 IF public.agent_definition_activate('@S1@', '@U1@', '@A2@', 1, h1, NULL, pol, 1, ARRAY['crm.read'], repeat('0', 64))->'reasons' <> '["connector_stale"]'::jsonb THEN RAISE EXCEPTION 'connector stale'; END IF;
 BEGIN PERFORM public.agent_definition_activate('@S1@', '@U1@', '@A2@', 1, h1, NULL, pol, 1, ARRAY['crm.read'], NULL);
  RAISE EXCEPTION 'Missing connector fingerprint was accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN PERFORM public.agent_definition_activate('@S1@', '@U1@', '@A2@', 1, h1, NULL, pol, 1, NULL, public.agent_definition_connector_fingerprint('@S1@'));
  RAISE EXCEPTION 'Missing readiness input was accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 IF (SELECT enabled FROM public.custom_agents WHERE id = '@A2@') OR (SELECT lifecycle FROM public.agent_definition_state WHERE agent_id = '@A2@') <> 'draft' THEN
  RAISE EXCEPTION 'A refused activation changed state'; END IF;
END $$;

-- Pinned memory: a newer revision (stale) and a revocation both block; nothing silently refreshes.
DO $$
DECLARE r jsonb; h text; pol int; m uuid; mr int; c jsonb;
BEGIN
 SELECT definition_hash INTO h FROM public.agent_definition_revisions WHERE agent_id = '@A3@' AND revision = 1;
 SELECT revision INTO pol FROM public.control_policy_active WHERE shop_id = '@S1@';
 SELECT source_id, revision INTO m, mr FROM probe_mem WHERE label = 's1';
 PERFORM public.agent_definition_record_evaluation('@S1@', '@A3@', 1, h, 'ok', 's', 'f', repeat('b', 64), 1, true, 1, '{{}}', now() - interval '1 second', 'trusted_evaluator');
 -- new reviewed revision published
 PERFORM set_config('request.jwt.claims', '{{"role":"authenticated","sub":"@U1@"}}', true);
 c := public.create_reviewed_memory_candidate('@S1@', 'x', 'Deposits are refundable within 48 hours.', '[{{"content":"Deposits are refundable within 48 hours.","embedding":null}}]'::jsonb, m, mr, NULL, NULL, NULL);
 PERFORM public.review_memory_revision('@S1@', m, (c->>'revision')::int);
 PERFORM public.publish_memory_revision('@S1@', m, (c->>'revision')::int, mr);
 PERFORM set_config('request.jwt.claims', '{{"role":"service_role"}}', true);
 r := public.agent_definition_activate('@S1@', '@U1@', '@A3@', 1, h, NULL, pol, (SELECT revision FROM public.reviewed_memory_heads WHERE shop_id = '@S1@'), ARRAY['crm.read'], public.agent_definition_connector_fingerprint('@S1@'));
 IF r->'reasons' <> '["memory_stale"]'::jsonb THEN RAISE EXCEPTION 'Stale memory: %', r; END IF;
 -- revoke the newer revision: the original pin is no longer the active one either
 PERFORM set_config('request.jwt.claims', '{{"role":"authenticated","sub":"@U1@"}}', true);
 PERFORM public.remove_memory_revision('@S1@', m, (c->>'revision')::int, (c->>'revision')::int);
 PERFORM set_config('request.jwt.claims', '{{"role":"service_role"}}', true);
 r := public.agent_definition_activate('@S1@', '@U1@', '@A3@', 1, h, NULL, pol, (SELECT revision FROM public.reviewed_memory_heads WHERE shop_id = '@S1@'), ARRAY['crm.read'], public.agent_definition_connector_fingerprint('@S1@'));
 IF r->>'outcome' <> 'blocked' OR NOT (r->'reasons' ? 'memory_stale' OR r->'reasons' ? 'memory_revoked') THEN RAISE EXCEPTION 'Revoked memory: %', r; END IF;
 IF (SELECT enabled FROM public.custom_agents WHERE id = '@A3@') THEN RAISE EXCEPTION 'Blocked activation enabled the agent'; END IF;
END $$;
"""

ROLLBACK_BOTH = f"""
{SERVICE}
-- Direction 1: the POINTER write fails AFTER the enabling write succeeded. Both must roll back.
CREATE FUNCTION pg_temp.probe_fail_pointer() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN IF NEW.lifecycle = 'active' THEN RAISE EXCEPTION 'injected pointer failure' USING ERRCODE = 'P0001'; END IF; RETURN NEW; END $f$;
CREATE TRIGGER probe_fail_pointer BEFORE UPDATE ON public.agent_definition_state
  FOR EACH ROW EXECUTE FUNCTION pg_temp.probe_fail_pointer();
DO $$
DECLARE h text; pol int; failed boolean := false;
BEGIN
 SELECT definition_hash INTO h FROM public.agent_definition_revisions WHERE agent_id = '@A2@' AND revision = 1;
 SELECT revision INTO pol FROM public.control_policy_active WHERE shop_id = '@S1@';
 BEGIN
  PERFORM public.agent_definition_activate('@S1@', '@U1@', '@A2@', 1, h, NULL, pol, (SELECT coalesce(max(revision), 1) FROM public.reviewed_memory_heads WHERE shop_id = '@S1@'), ARRAY['crm.read'], public.agent_definition_connector_fingerprint('@S1@'));
 EXCEPTION WHEN SQLSTATE 'P0001' THEN failed := true; END;
 IF NOT failed THEN RAISE EXCEPTION 'The injected pointer failure did not fire'; END IF;
 IF (SELECT enabled FROM public.custom_agents WHERE id = '@A2@') THEN RAISE EXCEPTION 'enabled survived a failed pointer write'; END IF;
 IF (SELECT lifecycle FROM public.agent_definition_state WHERE agent_id = '@A2@') <> 'draft'
  OR (SELECT active_revision FROM public.agent_definition_state WHERE agent_id = '@A2@') IS NOT NULL THEN RAISE EXCEPTION 'The pointer moved'; END IF;
 IF EXISTS (SELECT 1 FROM public.agent_definition_events WHERE agent_id = '@A2@' AND kind = 'activated') THEN RAISE EXCEPTION 'History survived the rollback'; END IF;
END $$;
DROP TRIGGER probe_fail_pointer ON public.agent_definition_state;

-- Direction 2: the ENABLING write (merged commercial activation) fails. The pointer must never move.
CREATE FUNCTION pg_temp.probe_fail_enable() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN IF NEW.enabled IS TRUE AND OLD.enabled IS NOT TRUE THEN RAISE EXCEPTION 'injected enabling failure' USING ERRCODE = 'P0001'; END IF; RETURN NEW; END $f$;
CREATE TRIGGER probe_fail_enable BEFORE UPDATE OF enabled ON public.custom_agents
  FOR EACH ROW EXECUTE FUNCTION pg_temp.probe_fail_enable();
DO $$
DECLARE h text; pol int; failed boolean := false;
BEGIN
 SELECT definition_hash INTO h FROM public.agent_definition_revisions WHERE agent_id = '@A2@' AND revision = 1;
 SELECT revision INTO pol FROM public.control_policy_active WHERE shop_id = '@S1@';
 BEGIN
  PERFORM public.agent_definition_activate('@S1@', '@U1@', '@A2@', 1, h, NULL, pol, (SELECT coalesce(max(revision), 1) FROM public.reviewed_memory_heads WHERE shop_id = '@S1@'), ARRAY['crm.read'], public.agent_definition_connector_fingerprint('@S1@'));
 EXCEPTION WHEN SQLSTATE 'P0001' THEN failed := true; END;
 IF NOT failed THEN RAISE EXCEPTION 'The injected enabling failure did not fire'; END IF;
 IF (SELECT enabled FROM public.custom_agents WHERE id = '@A2@') THEN RAISE EXCEPTION 'enabled changed'; END IF;
 IF (SELECT lifecycle FROM public.agent_definition_state WHERE agent_id = '@A2@') <> 'draft'
  OR EXISTS (SELECT 1 FROM public.agent_definition_events WHERE agent_id = '@A2@' AND kind = 'activated') THEN
  RAISE EXCEPTION 'The pointer or history moved although the enabling write failed'; END IF;
END $$;
DROP TRIGGER probe_fail_enable ON public.custom_agents;
"""

FLOW = f"""
{SERVICE}
DO $$
DECLARE r jsonb; h1 text; h2 text; pol int; n int;
BEGIN
 SELECT definition_hash INTO h1 FROM public.agent_definition_revisions WHERE agent_id = '@A2@' AND revision = 1;
 SELECT revision INTO pol FROM public.control_policy_active WHERE shop_id = '@S1@';
 -- With both injected failures gone, the same revision activates: nothing was left half-written.
 r := public.agent_definition_activate('@S1@', '@U1@', '@A2@', 1, h1, NULL, pol, (SELECT coalesce(max(revision), 1) FROM public.reviewed_memory_heads WHERE shop_id = '@S1@'), ARRAY['crm.read'], public.agent_definition_connector_fingerprint('@S1@'));
 IF r->>'outcome' <> 'activated' THEN RAISE EXCEPTION 'Activation: %', r; END IF;
 IF NOT (SELECT enabled FROM public.custom_agents WHERE id = '@A2@')
  OR (SELECT lifecycle FROM public.agent_definition_state WHERE agent_id = '@A2@') <> 'active'
  OR (SELECT active_revision FROM public.agent_definition_state WHERE agent_id = '@A2@') <> 1 THEN RAISE EXCEPTION 'Pointer / enabled not together'; END IF;
 IF (SELECT evidence->>'definition_hash' FROM public.agent_definition_events WHERE agent_id = '@A2@' AND kind = 'activated') <> h1
  OR (SELECT (evidence->>'policy_revision')::int FROM public.agent_definition_events WHERE agent_id = '@A2@' AND kind = 'activated') <> pol
  OR (SELECT evidence->>'billing_evidence_id' FROM public.agent_definition_events WHERE agent_id = '@A2@' AND kind = 'activated') IS NULL THEN
  RAISE EXCEPTION 'Activation evidence was not recorded'; END IF;
 r := public.agent_definition_activate('@S1@', '@U1@', '@A2@', 1, h1, 1, pol, (SELECT coalesce(max(revision), 1) FROM public.reviewed_memory_heads WHERE shop_id = '@S1@'), ARRAY['crm.read'], public.agent_definition_connector_fingerprint('@S1@'));
 IF r->>'outcome' <> 'already_active' THEN RAISE EXCEPTION 'Idempotent activation: %', r; END IF;

 -- Supersede: revision 2 replaces the pointer (single mutable row) and revision 1 is untouched.
 SELECT definition_hash INTO h2 FROM public.agent_definition_revisions WHERE agent_id = '@A2@' AND revision = 2;
 PERFORM public.agent_definition_record_evaluation('@S1@', '@A2@', 2, h2, 'r2', 's', 'f', repeat('b', 64), 1, true, 1, '{{}}', now() - interval '1 second', 'trusted_evaluator');
 r := public.agent_definition_activate('@S1@', '@U1@', '@A2@', 2, h2, NULL, pol, (SELECT coalesce(max(revision), 1) FROM public.reviewed_memory_heads WHERE shop_id = '@S1@'), ARRAY['crm.read'], public.agent_definition_connector_fingerprint('@S1@'));
 IF r->>'code' <> 'pointer_changed' THEN RAISE EXCEPTION 'A stale pointer view must be refused: %', r; END IF;
 r := public.agent_definition_activate('@S1@', '@U1@', '@A2@', 2, h2, 1, pol, (SELECT coalesce(max(revision), 1) FROM public.reviewed_memory_heads WHERE shop_id = '@S1@'), ARRAY['crm.read'], public.agent_definition_connector_fingerprint('@S1@'));
 IF r->>'outcome' <> 'activated' THEN RAISE EXCEPTION 'Supersede: %', r; END IF;
 SELECT count(*) INTO n FROM public.agent_definition_state WHERE agent_id = '@A2@';
 IF n <> 1 OR (SELECT active_revision FROM public.agent_definition_state WHERE agent_id = '@A2@') <> 2 THEN RAISE EXCEPTION 'Exactly one pointer expected'; END IF;
 IF (SELECT array_agg(kind ORDER BY seq) FROM public.agent_definition_events WHERE agent_id = '@A2@')
    <> ARRAY['revision_created','revision_created','activated','superseded','activated'] THEN RAISE EXCEPTION 'History order wrong'; END IF;

 -- Two-agent cap: the third activation is refused WITHOUT moving its pointer.
 PERFORM public.agent_definition_create_revision('@S1@', '@U1@', '@A4@', '@R6@', {DEF}, NULL);
 PERFORM public.agent_definition_record_evaluation('@S1@', '@A4@', 1, (SELECT definition_hash FROM public.agent_definition_revisions WHERE agent_id = '@A4@' AND revision = 1), 'a4', 's', 'f', repeat('b', 64), 1, true, 1, '{{}}', now() - interval '1 second', 'trusted_evaluator');
 PERFORM public.agent_definition_create_revision('@S1@', '@U1@', '@A3@', '@R7@', {DEF}, NULL);
 PERFORM public.agent_definition_record_evaluation('@S1@', '@A3@', 2, (SELECT definition_hash FROM public.agent_definition_revisions WHERE agent_id = '@A3@' AND revision = 2), 'a3', 's', 'f', repeat('b', 64), 1, true, 1, '{{}}', now() - interval '1 second', 'trusted_evaluator');
 r := public.agent_definition_activate('@S1@', '@U1@', '@A3@', 2, (SELECT definition_hash FROM public.agent_definition_revisions WHERE agent_id = '@A3@' AND revision = 2), NULL, pol, (SELECT coalesce(max(revision), 1) FROM public.reviewed_memory_heads WHERE shop_id = '@S1@'), ARRAY['crm.read'], public.agent_definition_connector_fingerprint('@S1@'));
 IF r->>'outcome' <> 'activated' THEN RAISE EXCEPTION 'Second agent should activate: %', r; END IF;
 r := public.agent_definition_activate('@S1@', '@U1@', '@A4@', 1, (SELECT definition_hash FROM public.agent_definition_revisions WHERE agent_id = '@A4@' AND revision = 1), NULL, pol, (SELECT coalesce(max(revision), 1) FROM public.reviewed_memory_heads WHERE shop_id = '@S1@'), ARRAY['crm.read'], public.agent_definition_connector_fingerprint('@S1@'));
 IF r->>'code' <> 'active_agent_limit_reached' THEN RAISE EXCEPTION 'Third agent must be refused: %', r; END IF;
 IF (SELECT lifecycle FROM public.agent_definition_state WHERE agent_id = '@A4@') <> 'draft' OR (SELECT enabled FROM public.custom_agents WHERE id = '@A4@') THEN
  RAISE EXCEPTION 'A cap refusal moved the pointer'; END IF;
 IF (SELECT count(*) FROM public.custom_agents WHERE shop_id = '@S1@' AND enabled) <> 2 THEN RAISE EXCEPTION 'Exactly two agents may be active'; END IF;
END $$;

-- Missing Founder Pilot evidence (S2 has none) blocks activation and moves nothing.
DO $$
DECLARE r jsonb; h text; pol int;
BEGIN
 PERFORM public.agent_definition_create_revision('@S2@', '@U5@', '@A6@', '@R8@', {DEF}, NULL);
 SELECT definition_hash INTO h FROM public.agent_definition_revisions WHERE agent_id = '@A6@' AND revision = 1;
 PERFORM public.agent_definition_record_evaluation('@S2@', '@A6@', 1, h, 'a6', 's', 'f', repeat('b', 64), 1, true, 1, '{{}}', now() - interval '1 second', 'trusted_evaluator');
 SELECT revision INTO pol FROM public.control_policy_active WHERE shop_id = '@S2@';
 r := public.agent_definition_activate('@S2@', '@U5@', '@A6@', 1, h, NULL, pol, (SELECT coalesce(max(revision), 1) FROM public.reviewed_memory_heads WHERE shop_id = '@S2@'), ARRAY['crm.read'], public.agent_definition_connector_fingerprint('@S2@'));
 IF r->>'outcome' <> 'blocked' OR r->>'code' <> 'billing_not_active' THEN RAISE EXCEPTION 'Missing billing must block: %', r; END IF;
 IF (SELECT lifecycle FROM public.agent_definition_state WHERE agent_id = '@A6@') <> 'draft' OR (SELECT enabled FROM public.custom_agents WHERE id = '@A6@') THEN
  RAISE EXCEPTION 'A billing refusal moved the pointer'; END IF;
END $$;
"""

CLAIMS = f"""
{SERVICE}
DO $$
DECLARE r jsonb; h1 text;
BEGIN
 -- Governed + active: a new claim is created.
 r := public.claim_scheduled_agent_run('@A2@', 'verifier-window-1', gen_random_uuid(), 60);
 IF r->>'outcome' <> 'claimed' THEN RAISE EXCEPTION 'Active definition must claim: %', r; END IF;
 -- Pause: no new claim, and `enabled` is off so no other path can use it.
 r := public.agent_definition_set_lifecycle('@S1@', '@U1@', '@A2@', 'paused', 'Holiday', 2);
 IF r->>'outcome' <> 'changed' THEN RAISE EXCEPTION 'Pause: %', r; END IF;
 IF (SELECT enabled FROM public.custom_agents WHERE id = '@A2@') THEN RAISE EXCEPTION 'Pause must disable the agent'; END IF;
 IF public.claim_scheduled_agent_run('@A2@', 'verifier-window-2', gen_random_uuid(), 60)->>'outcome' <> 'agent_unavailable' THEN RAISE EXCEPTION 'Paused must not claim'; END IF;
 -- Even a hand-forced enabled flag cannot revive a paused definition (the governed guard refuses it).
 BEGIN UPDATE public.custom_agents SET enabled = true WHERE id = '@A2@';
  RAISE EXCEPTION 'A governed agent was enabled around activation';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 -- Block: terminal for pause; no claim.
 IF public.agent_definition_set_lifecycle('@S1@', '@U1@', '@A2@', 'paused', 'Holiday', 2)->>'outcome' <> 'unchanged' THEN RAISE EXCEPTION 'Idempotent pause'; END IF;
 IF public.agent_definition_set_lifecycle('@S1@', '@U1@', '@A2@', 'blocked', 'Hold', 9)->>'code' <> 'pointer_changed' THEN RAISE EXCEPTION 'Stale pointer'; END IF;
 IF public.agent_definition_set_lifecycle('@S1@', '@U1@', '@A2@', 'blocked', 'Compliance hold', 2)->>'outcome' <> 'changed' THEN RAISE EXCEPTION 'Block'; END IF;
 IF public.agent_definition_set_lifecycle('@S1@', '@U1@', '@A2@', 'paused', 'x', 2)->>'code' <> 'invalid_transition' THEN RAISE EXCEPTION 'blocked -> paused'; END IF;
 IF public.claim_scheduled_agent_run('@A2@', 'verifier-window-3', gen_random_uuid(), 60)->>'outcome' <> 'agent_unavailable' THEN RAISE EXCEPTION 'Blocked must not claim'; END IF;
 IF (SELECT lifecycle FROM public.agent_definition_state WHERE agent_id = '@A2@') <> 'blocked' THEN RAISE EXCEPTION 'Blocked lifecycle not recorded'; END IF;
 -- Resume is an ordinary activation with fresh evidence.
 SELECT definition_hash INTO h1 FROM public.agent_definition_revisions WHERE agent_id = '@A2@' AND revision = 2;
 r := public.agent_definition_activate('@S1@', '@U1@', '@A2@', 2, h1, 2, (SELECT revision FROM public.control_policy_active WHERE shop_id = '@S1@'), (SELECT coalesce(max(revision), 1) FROM public.reviewed_memory_heads WHERE shop_id = '@S1@'), ARRAY['crm.read'], public.agent_definition_connector_fingerprint('@S1@'));
 IF r->>'outcome' <> 'activated' THEN RAISE EXCEPTION 'Resume: %', r; END IF;
 IF public.claim_scheduled_agent_run('@A2@', 'verifier-window-4', gen_random_uuid(), 60)->>'outcome' <> 'claimed' THEN RAISE EXCEPTION 'Resumed definition must claim'; END IF;

 -- A direct disable by the owner pauses the pointer; a direct enable is refused for every role.
 PERFORM set_config('request.jwt.claims', '{{"role":"authenticated","sub":"@U1@"}}', true);
 UPDATE public.custom_agents SET enabled = false WHERE id = '@A3@';
 IF (SELECT lifecycle FROM public.agent_definition_state WHERE agent_id = '@A3@') <> 'paused' THEN RAISE EXCEPTION 'A direct disable must pause the pointer'; END IF;
 IF (SELECT evidence->>'reason' FROM public.agent_definition_events WHERE agent_id = '@A3@' AND kind = 'paused') <> 'disabled_directly' THEN RAISE EXCEPTION 'Direct disable was not recorded'; END IF;
 BEGIN UPDATE public.custom_agents SET enabled = true WHERE id = '@A3@';
  RAISE EXCEPTION 'An owner session enabled a governed agent';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 PERFORM set_config('request.jwt.claims', '{{"role":"service_role"}}', true);
 BEGIN UPDATE public.custom_agents SET enabled = true WHERE id = '@A3@';
  RAISE EXCEPTION 'The service role enabled a governed agent around activation';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;

 -- Legacy agents are untouched: no state, claims unchanged, may still be enabled by the service role.
 IF EXISTS (SELECT 1 FROM public.agent_definition_state WHERE agent_id IN ('@A1@', '@A5@')) THEN RAISE EXCEPTION 'A legacy agent gained definition state'; END IF;
 IF public.claim_scheduled_agent_run('@A1@', 'verifier-window-5', gen_random_uuid(), 60)->>'outcome' <> 'claimed' THEN RAISE EXCEPTION 'Legacy agents must keep claiming'; END IF;
 UPDATE public.custom_agents SET enabled = true WHERE id = '@A5@';
 UPDATE public.custom_agents SET enabled = false WHERE id = '@A5@';
 PERFORM set_config('request.jwt.claims', '{{"role":"authenticated","sub":"@U5@"}}', true);
 BEGIN UPDATE public.custom_agents SET enabled = true WHERE id = '@A5@';
  RAISE EXCEPTION 'The legacy browser enable guard was weakened';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
"""

TENANT_DELETE = f"""
{SERVICE}
-- A single governed agent cannot be deleted out from under its history.
DO $$ BEGIN
 BEGIN DELETE FROM public.custom_agents WHERE id = '@A2@';
  RAISE EXCEPTION 'A governed agent with history was deleted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
-- The tenant-deletion cascade still works.
DO $$ DECLARE n integer; BEGIN
 DELETE FROM public.shops WHERE id IN ('@S1@', '@S2@');
 SELECT (SELECT count(*) FROM public.agent_definition_state) + (SELECT count(*) FROM public.agent_definition_revisions)
      + (SELECT count(*) FROM public.agent_definition_memory_pins) + (SELECT count(*) FROM public.agent_definition_evaluations)
      + (SELECT count(*) FROM public.agent_definition_events) INTO n;
 IF n <> 0 THEN RAISE EXCEPTION 'Tenant deletion left % definition rows behind', n; END IF;
END $$;
"""

stages = [
    ("drop", DROP_NEW), ("seed", SEED), ("migration", body), ("unchanged", UNCHANGED), ("acls", ACLS),
    ("authority", AUTHORITY), ("revisions", REVISIONS), ("activation", ACTIVATION), ("immutability", IMMUTABILITY),
    ("rollback", ROLLBACK_BOTH), ("flow", FLOW), ("claims", CLAIMS), ("tenant_delete", TENANT_DELETE),
]
upto = os.environ.get('VERIFY_UPTO')  # debugging aid: stop (and roll back) after a named stage
if upto:
    stages = stages[: [n for n, _ in stages].index(upto) + 1]
script = "\n".join(["BEGIN;"] + [sql if name == "migration" else fmt(sql) for name, sql in stages] + ["ROLLBACK;"])
outside = top_level(script.replace("$f$", "$$")).replace('ON COMMIT DROP', '')
assert re.search(r'(?i)\bcommit\b', outside) is None, 'the probe must never commit'
assert len(re.findall(r'(?m)^ROLLBACK;$', outside)) == 1 and outside.rstrip().endswith('ROLLBACK;'), 'the probe must end with exactly one ROLLBACK'
run(script)

# Nothing was changed: the migration is still applied exactly as before, with all its objects.
assert run("SELECT count(*) || ':' || max(version) FROM supabase_migrations.schema_migrations") == ledger_before
assert run("SELECT bool_and(to_regclass('public.' || t) IS NOT NULL) FROM unnest(ARRAY['%s']) t" % "','".join(TABLES)) == 't'
assert run("SELECT count(*) FROM pg_trigger WHERE tgname IN ('custom_agents_governed_disable','agent_definition_state_guard','custom_agents_activation_guard') AND NOT tgisinternal") == '3'
assert run("SELECT count(*) FROM public.shops WHERE id IN ('%s','%s')" % (IDS['S1'], IDS['S2'])) == '0'
assert run("SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'probe\\_fail\\_%' AND NOT tgisinternal") == '0'

print(
    f'PASS: upgrade {versions[-2]} -> {NEW} applied from its real SQL inside a rolled-back transaction; legacy shops, '
    'memberships, agents (enabled and disabled), runs, reviewed memory, Control Center policy and Founder Pilot billing '
    'evidence unchanged (content, xmin, ctid) and no definition state invented for any existing agent; commands are '
    'service-only and browser roles have no table or command access; only a live owner of the exact shop may save, '
    'activate, pause or block (manager, staff, revoked, cross-shop, unknown and browser refused); revisions are immutable, '
    'gapless, hashed and lineage-linked with exact-replay and changed-replay conflict; history is append-only (UPDATE, '
    'DELETE, TRUNCATE refused on every table) and the pointer row moves only through the commands; memory is pinned to '
    'the exact reviewed revision and wrong-shop / unknown / stale / revoked memory is refused; stale policy, knowledge, '
    'readiness, evaluation, hash and pointer fail closed; evaluation evidence is exact-revision, trusted-source-only and '
    'replay-safe; rollback holds in BOTH directions with injected failures (pointer write failing after the enabling write, '
    'and the enabling write failing); the two-agent cap and missing Founder Pilot evidence block activation without moving '
    'a pointer; paused and blocked definitions cannot claim and resume needs fresh activation; a direct disable pauses the '
    'pointer and no role can enable a governed agent around activation while legacy behavior is unchanged; a governed '
    'agent cannot be deleted away from its history; tenant deletion cascades; database left exactly as it was'
)
