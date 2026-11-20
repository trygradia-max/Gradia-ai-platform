"""Non-destructive upgrade probe for 20261120103700_agent_run_step_lifecycle.

Everything runs inside ONE transaction and ends with ROLLBACK, so no database state is changed. It needs a
DISPOSABLE local stack whose schema is still BEFORE this migration (the shared integration stack already has it
applied once the integration suites have run, so use a stack at the previous state):

    GRADIA_PROBE_STACK=gradia-voice-columns python3 scripts/verify-agent-run-lifecycle-migration.py

Inside the transaction the probe
  1. seeds fictional shops/agents and a HISTORICAL custom_agent_runs set (a manual success, a skipped run, a legacy
     scheduled run that is running with a live lease, one whose lease already expired, and a failed run),
  2. fingerprints those rows, applies the migration's REAL SQL text (BEGIN/COMMIT removed so the outer transaction
     stays in control) and proves:
       * every historical row is byte-for-byte unchanged and the new columns are NULL,
       * old CHECK constraints still hold for them and a legacy row can never become waiting/paused/cancelled/killed,
       * legacy claim / duplicate / lease-expiry-to-unknown / late-finish behavior is EXACTLY the old contract and writes
         no step, command, attempt, wait or event row,
       * the lifecycle functions refuse a legacy run ('run_not_governed') and the recovery sweep ignores it,
       * a heartbeat extends a live legacy lease and never resurrects an expired one,
       * browsers (authenticated/anon) have no privilege on the ledger tables or any lifecycle function, and keep
         their old read / history-insert permissions on custom_agent_runs but still cannot forge a scheduled claim,
       * the service role can read but not write the ledger tables directly, and the events ledger is append-only,
  3. rolls back, then confirms the ledger and schema are exactly as before.
No credential-bearing output is printed.
"""
from pathlib import Path
import os
import re
import subprocess

root = Path(__file__).resolve().parent.parent
project = os.environ.get('GRADIA_PROBE_STACK', 'gradia-isolated-tests')
assert project.startswith('gradia-') and re.fullmatch(r'[a-z0-9-]+', project), 'only a local gradia-* disposable stack is allowed'
assert not (root / '.local-tools/supabase-test/supabase/.temp/project-ref').exists(), 'remote links forbidden'

NEW = '20261120103700'
migration = next((root / 'supabase/migrations').glob(f'{NEW}_*.sql'))
text = migration.read_text().strip()
assert text.startswith('BEGIN;') and text.endswith('COMMIT;'), 'migration must be one BEGIN..COMMIT block'
body = text[len('BEGIN;'):-len('COMMIT;')]
stripped = re.sub(r'\$\$.*?\$\$', '$$$$', body, flags=re.S)
assert not re.search(r'(?im)^\s*(commit|rollback|begin|start\s+transaction|savepoint|release|abort|end)\b', stripped), 'unexpected transaction control'


def run(sql):
    r = subprocess.run(['docker', 'exec', '-i', f'supabase_db_{project}', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'],
                       input=sql, text=True, capture_output=True)
    if r.returncode:
        errors = [l for l in r.stderr.splitlines() if 'ERROR:' in l]
        detail = errors[0].split('ERROR:', 1)[1].strip()[:300] if errors else 'no detail'
        raise SystemExit(f'FAIL: probe failed ({detail}); rolled back; raw output withheld')
    return r.stdout.strip()


assert run("SELECT to_regclass('public.agent_run_steps') IS NULL") == 't', 'migration already applied on this stack; use a stack at the previous state'
ledger_before = run("SELECT count(*) || ':' || max(version) FROM supabase_migrations.schema_migrations")
schema_before = run("SELECT md5(string_agg(column_name || data_type, ',' ORDER BY ordinal_position)) FROM information_schema.columns WHERE table_name='custom_agent_runs' AND table_schema='public'")

U = lambda n: f'00000000-0000-4000-8000-0000000a{n:04d}'
S = lambda n: f'00000000-0000-4000-8000-0000000b{n:04d}'
A = lambda n: f'00000000-0000-4000-8000-0000000c{n:04d}'
R = lambda n: f'00000000-0000-4000-8000-0000000d{n:04d}'
WORKER = '00000000-0000-4000-8000-0000000e0001'
SERVICE = "SELECT set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true), set_config('request.jwt.claim.role', 'service_role', true);"

OLD_COLUMNS = 'id,agent_id,shop_id,trigger_source,fired,reason,stats,pending_action_ids,trigger_key,state,attempt,worker_id,lease_expires_at,started_at,finished_at,definition_snapshot,definition_hash,policy_revision,knowledge_revision,wait_reason,error_code,created_at'

PRE = f"""
BEGIN;
{SERVICE}
CREATE FUNCTION pg_temp.ok(c boolean, m text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN IF c IS NOT TRUE THEN RAISE EXCEPTION 'ASSERT FAILED: %', m; END IF; RETURN 'PASS ' || m; END $f$;
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES ('{U(1)}','o1@example.test',now()),('{U(2)}','o2@example.test',now());
INSERT INTO public.shops(id,owner_id,name) VALUES ('{S(1)}','{U(1)}','Fictional A'),('{S(2)}','{U(2)}','Fictional B');
INSERT INTO public.custom_agents(id,shop_id,owner_id,name,problem_text,config,enabled) VALUES
 ('{A(1)}','{S(1)}','{U(1)}','Legacy one','x','{{}}',true),('{A(2)}','{S(2)}','{U(2)}','Legacy two','x','{{}}',true);
INSERT INTO public.custom_agent_runs(id,agent_id,shop_id,trigger_source,fired,reason,state,attempt,started_at,finished_at,trigger_key,worker_id,lease_expires_at,definition_snapshot,definition_hash) VALUES
 ('{R(1)}','{A(1)}','{S(1)}','manual',true,'ok','succeeded',1,now(),now(),NULL,NULL,NULL,NULL,NULL),
 ('{R(2)}','{A(1)}','{S(1)}','schedule',false,'nothing','skipped',1,now(),now(),'w-skipped',NULL,NULL,NULL,NULL),
 ('{R(3)}','{A(1)}','{S(1)}','schedule',false,NULL,'running',1,now(),NULL,'w-live','{WORKER}',now() + interval '10 minutes','{{}}','{'a' * 64}'),
 ('{R(4)}','{A(2)}','{S(2)}','schedule',false,NULL,'running',1,now() - interval '1 hour',NULL,'w-dead','{WORKER}',now() - interval '5 minutes','{{}}','{'b' * 64}'),
 ('{R(5)}','{A(2)}','{S(2)}','event:payment_received',false,'boom','failed',1,now(),now(),NULL,NULL,NULL,NULL,NULL);
CREATE TEMP TABLE probe_before AS SELECT id, md5(row_to_json(t)::text) h FROM (SELECT {OLD_COLUMNS} FROM public.custom_agent_runs) t;
"""

APPLY = body

POST = f"""
SELECT pg_temp.ok((SELECT count(*) FROM probe_before) = 5, 'five historical rows seeded');
SELECT pg_temp.ok(NOT EXISTS (
  SELECT 1 FROM probe_before b JOIN (SELECT id, md5(row_to_json(t)::text) h FROM (SELECT {OLD_COLUMNS} FROM public.custom_agent_runs) t) a USING (id) WHERE a.h <> b.h),
  'every historical row is unchanged, byte for byte, on the old columns');
SELECT pg_temp.ok((SELECT bool_and(control_request IS NULL AND control_acked_at IS NULL AND last_heartbeat_at IS NULL AND lease_started_at IS NULL AND definition_revision IS NULL) FROM public.custom_agent_runs),
  'new columns are NULL on every historical row');
SELECT pg_temp.ok((SELECT count(*) FROM public.agent_run_steps) + (SELECT count(*) FROM public.agent_run_commands) + (SELECT count(*) FROM public.agent_run_attempts)
  + (SELECT count(*) FROM public.agent_run_waits) + (SELECT count(*) FROM public.agent_run_events) = 0, 'no ledger row exists for history');

-- A legacy row can never become an open or stopped governed state.
DO $t$ BEGIN
  BEGIN UPDATE public.custom_agent_runs SET state='waiting', lease_expires_at=NULL, finished_at=NULL WHERE id='{R(1)}'; RAISE EXCEPTION 'not refused';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE public.custom_agent_runs SET control_request='kill' WHERE id='{R(1)}'; RAISE EXCEPTION 'not refused';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $t$;
SELECT 'PASS a legacy row cannot become waiting or carry a half control request';

{SERVICE}
-- Legacy claim contract, exactly as before.
SELECT pg_temp.ok((SELECT (public.claim_scheduled_agent_run('{A(1)}','w-new','{WORKER}',60))->>'outcome') = 'claimed', 'legacy window claim still claims');
SELECT pg_temp.ok((SELECT (public.claim_scheduled_agent_run('{A(1)}','w-new','{WORKER}',60))->>'outcome') = 'active_duplicate', 'legacy duplicate window is active_duplicate');
SELECT pg_temp.ok((SELECT (public.claim_scheduled_agent_run('{A(1)}','w-skipped','{WORKER}',60))->>'outcome') = 'terminal_duplicate', 'legacy terminal window is terminal_duplicate');
SELECT pg_temp.ok((SELECT (public.claim_scheduled_agent_run('{A(2)}','w-dead','{WORKER}',60))->>'outcome') = 'unknown', 'legacy expired lease still answers unknown');
SELECT pg_temp.ok((SELECT state || ':' || error_code || ':' || wait_reason FROM public.custom_agent_runs WHERE id='{R(4)}') = 'unknown:lease_expired:reconciliation_required', 'legacy expired run is marked unknown exactly as before');
SELECT pg_temp.ok(public.finish_scheduled_agent_run('{R(4)}','{WORKER}',1,'skipped',false) = false, 'a late finish cannot overwrite the unknown outcome');
SELECT pg_temp.ok(public.finish_scheduled_agent_run('{R(3)}','{WORKER}',1,'succeeded',true) = true, 'legacy finish still completes a live run');
SELECT pg_temp.ok((SELECT binding_at_finish IS NULL AND state='succeeded' FROM public.custom_agent_runs WHERE id='{R(3)}'), 'legacy finish writes no binding');
SELECT pg_temp.ok((SELECT (public.heartbeat_agent_run((SELECT id FROM public.custom_agent_runs WHERE agent_id='{A(1)}' AND trigger_key='w-new'),'{WORKER}',1,60))->>'alive') = 'true', 'a heartbeat extends a live legacy lease');
SELECT pg_temp.ok((SELECT (public.heartbeat_agent_run('{R(4)}','{WORKER}',1,60))->>'alive') = 'false', 'a heartbeat never resurrects an expired lease');

-- Ledger functions refuse a legacy run; the sweep ignores it.
SELECT pg_temp.ok((SELECT (public.begin_agent_run_step((SELECT id FROM public.custom_agent_runs WHERE agent_id='{A(1)}' AND trigger_key='w-new'),'{WORKER}',1,'look-up','read'))->'reasons'->>0) = 'run_not_governed', 'steps refuse a legacy run');
UPDATE public.custom_agent_runs SET lease_expires_at = now() - interval '1 minute' WHERE agent_id='{A(1)}' AND trigger_key='w-new';
SELECT pg_temp.ok((SELECT (public.recover_stale_agent_runs(50))->'recovered') = '{{}}'::jsonb, 'the recovery sweep ignores legacy runs');
SELECT pg_temp.ok((SELECT state FROM public.custom_agent_runs WHERE agent_id='{A(1)}' AND trigger_key='w-new') = 'running', 'a legacy run is left exactly as it was');
SELECT pg_temp.ok(public.mark_scheduled_agent_run_unknown((SELECT id FROM public.custom_agent_runs WHERE agent_id='{A(1)}' AND trigger_key='w-new')) = true, 'legacy mark-unknown still works');
SELECT pg_temp.ok((SELECT count(*) FROM public.agent_run_events) + (SELECT count(*) FROM public.agent_run_waits) = 0, 'legacy behavior writes no lifecycle evidence');

-- Privileges.
SELECT pg_temp.ok(NOT EXISTS (
  SELECT 1 FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name IN ('agent_run_steps','agent_run_commands','agent_run_attempts','agent_run_waits','agent_run_events')
   AND (grantee IN ('anon','authenticated','PUBLIC') OR (grantee='service_role' AND privilege_type <> 'SELECT'))), 'ledger tables: no browser privilege and service role is SELECT only');
SELECT pg_temp.ok((SELECT bool_and(c.relrowsecurity) FROM pg_class c WHERE c.relname IN ('agent_run_steps','agent_run_commands','agent_run_attempts','agent_run_waits','agent_run_events') AND c.relnamespace='public'::regnamespace), 'RLS enabled on every ledger table');
SELECT pg_temp.ok(NOT EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN (VALUES ('anon'),('authenticated')) r(role)
   WHERE n.nspname='public' AND p.proname IN ('heartbeat_agent_run','begin_agent_run_step','finish_agent_run_step','register_agent_command','begin_agent_command_attempt','record_agent_attempt_result','request_agent_run_control','acknowledge_agent_run_control','resume_paused_agent_run','park_agent_run_wait','resolve_agent_run_wait','claim_resumable_agent_run','recover_stale_agent_runs','resolve_agent_command_reconciliation','claim_scheduled_agent_run','finish_scheduled_agent_run','mark_scheduled_agent_run_unknown')
   AND has_function_privilege(r.role, p.oid, 'EXECUTE')), 'no lifecycle function is executable by browsers');
SELECT pg_temp.ok(EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname='heartbeat_agent_run' AND has_function_privilege('service_role', p.oid, 'EXECUTE')), 'the service role can execute the lifecycle functions');

-- Browser permissions on custom_agent_runs are unchanged: owner reads and records manual history, cannot forge a claim.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{{"role":"authenticated","sub":"{U(1)}"}}', true), set_config('request.jwt.claim.sub', '{U(1)}', true);
SELECT pg_temp.ok((SELECT count(*) FROM public.custom_agent_runs) >= 1 AND NOT EXISTS (SELECT 1 FROM public.custom_agent_runs WHERE shop_id='{S(2)}'), 'an owner still reads only their own shop''s runs');
INSERT INTO public.custom_agent_runs(agent_id,shop_id,trigger_source,fired,state,attempt) VALUES ('{A(1)}','{S(1)}','manual',true,'succeeded',1);
SELECT 'PASS an owner can still record manual history';
DO $t$ BEGIN
  BEGIN INSERT INTO public.custom_agent_runs(agent_id,shop_id,trigger_source,trigger_key,fired,state,attempt) VALUES ('{A(1)}','{S(1)}','schedule','forged',false,'running',1); RAISE EXCEPTION 'not refused';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN NULL; END;
  BEGIN INSERT INTO public.custom_agent_runs(agent_id,shop_id,trigger_source,fired,state,attempt) VALUES ('{A(1)}','{S(1)}','manual',false,'killed',1); RAISE EXCEPTION 'not refused';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN NULL; END;
  BEGIN UPDATE public.custom_agent_runs SET state='cancelled' WHERE shop_id='{S(1)}'; RAISE EXCEPTION 'not refused';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $t$;
SELECT 'PASS an owner cannot forge a scheduled claim, a stopped state, or update a run';
RESET ROLE;
{SERVICE}
SELECT pg_temp.ok((SELECT count(*) FROM public.custom_agent_runs WHERE shop_id='{S(2)}') = 2, 'rows of the other shop are untouched');
ROLLBACK;
"""

out = run(PRE + APPLY + POST)
lines = [l for l in out.splitlines() if l.startswith('PASS')]
bad = [l for l in out.splitlines() if 'ASSERT' in l]
assert not bad, bad
assert 'to_regclass' not in out
print('\n'.join(lines))

assert run("SELECT to_regclass('public.agent_run_steps') IS NULL") == 't', 'rollback left the new table behind'
assert run("SELECT count(*) || ':' || max(version) FROM supabase_migrations.schema_migrations") == ledger_before, 'ledger changed'
assert run("SELECT md5(string_agg(column_name || data_type, ',' ORDER BY ordinal_position)) FROM information_schema.columns WHERE table_name='custom_agent_runs' AND table_schema='public'") == schema_before, 'schema changed'
print(f'PASS rolled back: ledger and custom_agent_runs schema identical to before ({len(lines)} checks on {project})')
