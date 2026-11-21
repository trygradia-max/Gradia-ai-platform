"""Non-destructive upgrade probe for 20261120160000_call_copilot_review_reads (Call Copilot PR F).

Everything runs inside ONE transaction on the unlinked gradia-isolated-tests stack and ends with ROLLBACK, so no
database state is changed. Inside it the probe
  1. (if the stack already holds the review objects) drops exactly those objects, so the probe can be re-run,
  2. seeds fictional shops, owners, a manager with crm.read, a manager without it, a staff member with crm.read, an
     inactive manager, a consented Call Copilot call with transcript segments, a sealed evidence revision and three
     proposals (two executable, one review-only), and fingerprints every public table and every existing function,
  3. applies the migration's REAL SQL text (BEGIN/COMMIT removed so the outer transaction stays in control) and proves:
       * every existing table (rows, columns, policies, grants, triggers, constraints) and every existing function
         (definition and ACL) is byte-for-byte unchanged; the only additions are six functions and one index,
       * no browser role can read or write any call_copilot_* table; only the two readers are executable, and only by
         `authenticated`; helpers are executable by no API role; the service role (no auth.uid) is refused,
       * as `authenticated`: the owner reads (can_approve), a crm.read manager reads (cannot approve), a manager
         without crm.read, a staff member, an inactive manager and another shop's owner are refused (42501), another
         shop's call is indistinguishable from a missing one, and an unknown call is {found:false},
       * only the exact cited span is returned (never a whole segment, a provider id or a user id); candidate ids are
         counts; review-only proposals carry no action,
       * the freshness the review shows equals the denial the approval's own recheck gives, for a fresh proposal, an
         edited payload, a changed customer, new evidence and a late consent decline,
       * after a late decline or new evidence every snippet is withheld (no transcript words leave the database),
       * pagination is bounded and keyset-ordered, and a bad cursor is refused,
  4. rolls back, then confirms the schema and ledger are exactly as before.
No credential-bearing output is printed.

`--mutate NAME` re-runs the probe against a deliberately broken copy of the migration and REQUIRES it to fail (proving
the probe really detects that defect). `--mutate all` runs every mutation.
"""
from pathlib import Path
import os
import re
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
project = os.environ.get('PROBE_PROJECT', 'gradia-isolated-tests')
config = root / 'tests/supabase/config.toml'
if project == 'gradia-isolated-tests':
    assert f'project_id = "{project}"' in config.read_text() and 'env(' not in config.read_text()
else:
    assert project.startswith('gradia-') and 'prod' not in project, 'the probe only runs against a disposable local stack'
assert not (root / '.local-tools/supabase-test/supabase/.temp/project-ref').exists(), 'remote links forbidden'

NEW = '20261120160000'
migration = next((root / 'supabase/migrations').glob(f'{NEW}_*.sql'))
ORIGINAL = migration.read_text().strip()
versions = sorted(p.name.split('_')[0] for p in (root / 'supabase/migrations').glob('*.sql'))
assert versions[-1] == NEW, 'probe expects this to be the newest migration'
NEW_FUNCS = ['call_copilot_review_viewer(uuid)', 'call_copilot_review_ambiguity(jsonb)', 'call_copilot_review_freshness(uuid,uuid,jsonb,boolean,boolean)',
             'call_copilot_review_snippet(uuid,uuid,uuid,integer,integer,text,jsonb)', 'call_copilot_review_list(uuid,integer,timestamptz,uuid)',
             'call_copilot_review_detail(uuid,uuid,integer)']
READERS = ['call_copilot_review_list(uuid,integer,timestamptz,uuid)', 'call_copilot_review_detail(uuid,uuid,integer)']


def body_of(text):
    assert text.startswith('BEGIN;') and text.endswith('COMMIT;'), 'migration must be one BEGIN..COMMIT block'
    body = text[len('BEGIN;'):-len('COMMIT;')]
    stripped = re.sub(r'\$\$.*?\$\$', '$$$$', body, flags=re.S)
    assert not re.search(r'(?im)^\s*(commit|rollback|begin|start\s+transaction|savepoint|release|abort|end)\b', stripped), 'unexpected transaction control'
    return body


def run(sql):
    r = subprocess.run(['docker', 'exec', '-i', f'supabase_db_{project}', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'],
                       input=sql, text=True, capture_output=True)
    if r.returncode:
        errors = [l for l in r.stderr.splitlines() if 'ERROR:' in l]
        detail = errors[0].split('ERROR:', 1)[1].strip()[:400] if errors else (r.stderr.strip().splitlines() or ['no detail'])[-1][:300]
        raise SystemExit(f'FAIL: probe failed ({detail}); rolled back; raw output withheld')
    return r.stdout.strip()


assert run("SELECT to_regclass('public.call_copilot_proposals') IS NOT NULL") == 't', 'PR E migration required'
ledger_before = run("SELECT count(*) || ':' || max(version) FROM supabase_migrations.schema_migrations WHERE version <> '%s'" % NEW)

U = {'@U1@': '00000000-0000-4000-8000-0000000a0001', '@U2@': '00000000-0000-4000-8000-0000000a0002', '@U3@': '00000000-0000-4000-8000-0000000a0003',
     '@U4@': '00000000-0000-4000-8000-0000000a0004', '@U5@': '00000000-0000-4000-8000-0000000a0005', '@U6@': '00000000-0000-4000-8000-0000000a0006',
     '@S1@': '00000000-0000-4000-8000-0000000b0001', '@S2@': '00000000-0000-4000-8000-0000000b0002', '@C1@': '00000000-0000-4000-8000-0000000c0001'}


def T(sql):
    for k, v in U.items():
        sql = sql.replace(k, v)
    return sql


# Existing objects only: everything in public that is not one of the six new functions or the new index.
FP = """(
 SELECT 'table:' || c.relname AS k, md5(string_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull::text, ',' ORDER BY a.attnum)) AS v
   FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' GROUP BY c.relname
 UNION ALL SELECT 'policies', md5(coalesce(string_agg(polrelid::regclass::text||polname||polcmd::text||coalesce(pg_get_expr(polqual,polrelid),'')||coalesce(pg_get_expr(polwithcheck,polrelid),''), ',' ORDER BY polrelid::regclass::text, polname), '')) FROM pg_policy
 UNION ALL SELECT 'table_grants', md5(coalesce(string_agg(table_name||grantee||privilege_type, ',' ORDER BY table_name, grantee, privilege_type), '')) FROM information_schema.role_table_grants WHERE table_schema='public'
 UNION ALL SELECT 'triggers', md5(coalesce(string_agg(tgrelid::regclass::text||tgname, ',' ORDER BY tgrelid::regclass::text, tgname), '')) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text LIKE 'public.%'
 UNION ALL SELECT 'constraints', md5(coalesce(string_agg(conrelid::regclass::text||conname||pg_get_constraintdef(oid), ',' ORDER BY conrelid::regclass::text, conname), '')) FROM pg_constraint WHERE connamespace='public'::regnamespace
 UNION ALL SELECT 'indexes', md5(coalesce(string_agg(indexname||indexdef, ',' ORDER BY indexname), '')) FROM pg_indexes WHERE schemaname='public' AND indexname <> 'call_copilot_calls_shop_created_idx'
 UNION ALL SELECT 'functions', md5(coalesce(string_agg(p.oid::regprocedure::text||coalesce(p.proacl::text,'default')||p.proowner::regrole::text||md5(pg_get_functiondef(p.oid)), ',' ORDER BY p.oid::regprocedure::text), ''))
   FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind='f' AND p.proname NOT LIKE 'call_copilot_review_%'
)"""

DROP_NEW = """
DROP FUNCTION IF EXISTS public.call_copilot_review_list(uuid,integer,timestamptz,uuid), public.call_copilot_review_detail(uuid,uuid,integer),
 public.call_copilot_review_snippet(uuid,uuid,uuid,integer,integer,text,jsonb), public.call_copilot_review_freshness(uuid,uuid,jsonb,boolean,boolean),
 public.call_copilot_review_ambiguity(jsonb), public.call_copilot_review_viewer(uuid);
DROP INDEX IF EXISTS public.call_copilot_calls_shop_created_idx;
"""

SEED = T("""
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES ('@U1@','o1@example.test',now()),('@U2@','o2@example.test',now()),('@U3@','m3@example.test',now()),
 ('@U4@','m4@example.test',now()),('@U5@','s5@example.test',now()),('@U6@','m6@example.test',now());
INSERT INTO public.shops(id,owner_id,name,timezone) VALUES ('@S1@','@U1@','Fictional A','America/Los_Angeles'),('@S2@','@U2@','Fictional B','America/Los_Angeles');
INSERT INTO public.shop_memberships(shop_id,user_id,role,capabilities,display_name,active) VALUES
 ('@S1@','@U3@','manager',ARRAY['crm.read'],'Manager',true),('@S1@','@U4@','manager',ARRAY['notes.write'],'NoCrm',true),
 ('@S1@','@U5@','staff',ARRAY[]::text[],'Staff',true),('@S1@','@U6@','manager',ARRAY['crm.read'],'Inactive',false);
INSERT INTO public.customers(id,shop_id,name,phone,email) VALUES ('@C1@','@S1@','Jordan Rivera','+1 555 014 2988','jordan.rivera@example.test');
CREATE FUNCTION pg_temp.ev(p_shop uuid, p_call text, p_event text, p_seq int, p_kind text, p_party text DEFAULT NULL, p_ver text DEFAULT NULL,
  p_resp int DEFAULT NULL, p_secs int DEFAULT 0) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.call_copilot_record_event(p_shop, 'twilio', p_call, p_event, p_seq, p_kind, p_party, p_ver, p_resp,
    CASE WHEN p_kind='call_opened' THEN 'gradia_controlled_number' END, NULL, NULL, NULL, now() - interval '10 minutes' + make_interval(secs => p_secs))
$$;
CREATE FUNCTION pg_temp.consent(p_shop uuid, p_call text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_temp.ev(p_shop,p_call,p_call||'e1',1,'call_opened');
  PERFORM pg_temp.ev(p_shop,p_call,p_call||'e2',2,'disclosure_delivered','operator','v1',NULL,1);
  PERFORM pg_temp.ev(p_shop,p_call,p_call||'e3',3,'disclosure_delivered','caller','v1',NULL,2);
  PERFORM pg_temp.ev(p_shop,p_call,p_call||'e4',4,'consent_granted','operator','v1',2,3);
  PERFORM pg_temp.ev(p_shop,p_call,p_call||'e5',5,'consent_granted','caller','v1',3,4);
END $$;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT pg_temp.consent('@S1@','CAreview01');
CREATE TEMP TABLE ctx AS SELECT id AS call_id FROM public.call_copilot_calls WHERE shop_id='@S1@' AND provider_call_id='CAreview01';
DO $$ DECLARE c uuid := (SELECT call_id FROM ctx); rev jsonb; run jsonb; res jsonb;
BEGIN
 PERFORM public.call_copilot_record_segment('@S1@', c, 0, 'seg-0', 'caller', now()-interval '10 minutes'+interval '5 seconds', now()-interval '10 minutes'+interval '7 seconds', 'Hi this is Jordan Rivera and I need some help', '{}');
 PERFORM public.call_copilot_record_segment('@S1@', c, 1, 'seg-1', 'caller', now()-interval '10 minutes'+interval '8 seconds', now()-interval '10 minutes'+interval '10 seconds', 'I would like a ceramic coating please', '{}');
 rev := public.call_copilot_seal_evidence('@S1@','@U1@', c, true, 2);
 run := jsonb_build_object('status','completed','extractor_id','fixture','extractor_version','1','schema_version',1,'crm_context_digest',repeat('a',64));
 res := public.call_copilot_record_extraction('@S1@','@U1@', c, (rev->>'evidence_revision_id')::uuid, run, jsonb_build_array(
   jsonb_build_object('kind','customer','route','pending_action','action_type','resolve_customer','confidence','high',
     'payload', jsonb_build_object('name','Jordan Rivera','phone','+15550142988','email',NULL), 'bind', jsonb_build_array('name','phone','email'),
     'fields', jsonb_build_array(jsonb_build_object('name','name','value','Jordan Rivera','confidence','high','citations', jsonb_build_array(jsonb_build_object('segment_index',0,'start',11,'end',24)))),
     'customer_id', '@C1@'),
   jsonb_build_object('kind','service_request','route','pending_action','action_type','record_interaction','confidence','high',
     'payload', jsonb_build_object('customer_id','@C1@','channel','note','role','system','content','Call note: ceramic coating','metadata',jsonb_build_object('origin','call_copilot')),
     'bind', jsonb_build_array('name','phone'),
     'fields', jsonb_build_array(jsonb_build_object('name','service','value','ceramic coating','confidence','high','citations', jsonb_build_array(jsonb_build_object('segment_index',1,'start',15,'end',30)))),
     'customer_id','@C1@'),
   jsonb_build_object('kind','memory_candidate','route','review_only','review_reason','customer_memory_review_only','confidence','medium',
     'ambiguity', jsonb_build_object('candidate_customer_ids', jsonb_build_array('00000000-0000-4000-8000-0000000c00aa','00000000-0000-4000-8000-0000000c00bb'), 'secret_key', 'x'),
     'fields', jsonb_build_array(jsonb_build_object('name','preference','value','ceramic','confidence','medium','citations', jsonb_build_array(jsonb_build_object('segment_index',1,'start',15,'end',22)))))));
 IF res->>'outcome' <> 'recorded' THEN RAISE EXCEPTION 'seed extraction: %', res; END IF;
END $$;
CREATE TEMP TABLE fp_before AS """ + FP + """;
CREATE TEMP TABLE ledger_before AS SELECT count(*) AS n FROM supabase_migrations.schema_migrations WHERE version <> '""" + NEW + """';
""")

CHECKS = T(r"""
DO $$
DECLARE c uuid := (SELECT call_id FROM ctx); x text; r jsonb; d jsonb; p jsonb; fn text; n integer; edited uuid; pl jsonb; prop record; code_a text; code_b text; txt text; first_cursor jsonb;
 caught boolean;
BEGIN
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
 -- ------------------------------------------------------------------ existing objects untouched, additions are exactly the review objects
 SELECT string_agg(f.k, ',') INTO x FROM fp_before f FULL JOIN (""" + FP + r""") a USING (k) WHERE f.v IS DISTINCT FROM a.v;
 IF x IS NOT NULL THEN RAISE EXCEPTION 'existing objects drifted: %', x; END IF;
 SELECT count(*) INTO n FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'call_copilot_review_%';
 IF n <> 6 THEN RAISE EXCEPTION 'expected six review functions, found %', n; END IF;

 -- ------------------------------------------------------------------ privileges: no table access, exactly two readers for authenticated
 FOREACH x IN ARRAY ARRAY['call_copilot_calls','call_copilot_events','call_copilot_conflicts','call_copilot_transcript_segments','call_copilot_transcript_conflicts',
   'call_copilot_evidence_revisions','call_copilot_extraction_runs','call_copilot_proposals','call_copilot_run_proposals'] LOOP
  IF has_table_privilege('anon','public.'||x,'SELECT') OR has_table_privilege('authenticated','public.'||x,'SELECT') OR has_table_privilege('authenticated','public.'||x,'INSERT')
     OR has_table_privilege('authenticated','public.'||x,'UPDATE') OR has_table_privilege('authenticated','public.'||x,'DELETE') OR has_table_privilege('anon','public.'||x,'INSERT') THEN
    RAISE EXCEPTION 'browser role can reach %', x; END IF;
 END LOOP;
 FOREACH fn IN ARRAY ARRAY['call_copilot_review_viewer(uuid)','call_copilot_review_ambiguity(jsonb)','call_copilot_review_freshness(uuid,uuid,jsonb,boolean,boolean)',
   'call_copilot_review_snippet(uuid,uuid,uuid,integer,integer,text,jsonb)','call_copilot_review_list(uuid,integer,timestamptz,uuid)','call_copilot_review_detail(uuid,uuid,integer)'] LOOP
  IF has_function_privilege('anon','public.'||fn,'EXECUTE') OR has_function_privilege('service_role','public.'||fn,'EXECUTE') THEN RAISE EXCEPTION 'anon or service_role can run %', fn; END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid=('public.'||fn)::regprocedure) ~ '(^\{|,)=X' THEN RAISE EXCEPTION 'PUBLIC can run %', fn; END IF;
  IF has_function_privilege('authenticated','public.'||fn,'EXECUTE') <> (fn LIKE 'call_copilot_review_list%' OR fn LIKE 'call_copilot_review_detail%') THEN
    RAISE EXCEPTION 'authenticated EXECUTE is wrong for %', fn; END IF;
 END LOOP;

 -- ------------------------------------------------------------------ the service role has no auth.uid and is refused
 caught := false; BEGIN PERFORM public.call_copilot_review_detail('@S1@', c); EXCEPTION WHEN SQLSTATE '42501' THEN caught := true; END;
 IF NOT caught THEN RAISE EXCEPTION 'service role read a review'; END IF;

 -- ------------------------------------------------------------------ the owner
 SET LOCAL ROLE authenticated; PERFORM set_config('request.jwt.claims','{"sub":"@U1@","role":"authenticated"}',true);
 d := public.call_copilot_review_detail('@S1@', c, NULL);
 r := public.call_copilot_review_list('@S1@', 20, NULL, NULL);
 RESET ROLE;
 IF d->>'viewer_role' <> 'owner' OR (d->>'can_approve')::boolean IS NOT TRUE OR jsonb_array_length(d->'proposals') <> 3 THEN RAISE EXCEPTION 'owner view: %', left(d::text, 300); END IF;
 IF jsonb_array_length(r->'items') <> 1 OR jsonb_typeof(r->'next_cursor') <> 'null' OR (r->'items'->0->'proposals'->>'total')::int <> 3 THEN RAISE EXCEPTION 'owner list: %', r; END IF;
 IF d->'evidence'->'selected'->>'coverage_status' <> 'partial' OR NOT (d->'evidence'->'selected'->'coverage_reasons') ? 'call_not_ended' OR (d->'evidence'->'selected'->>'current')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'coverage: %', d->'evidence'; END IF;
 IF (d->'capture'->>'review_permitted')::boolean IS NOT TRUE OR (d->>'snippets_withheld')::boolean THEN RAISE EXCEPTION 'review not permitted on a consented call'; END IF;
 -- only the exact cited span; never a whole segment, a provider id, a user id or a candidate id
 txt := d::text;
 IF txt LIKE '%Hi this is Jordan Rivera and I need%' OR txt LIKE '%I would like a ceramic coating please%' OR txt LIKE '%4111%' OR txt LIKE '%CAreview01%'
    OR txt LIKE '%@U1@%' OR txt LIKE '%0000000c00aa%' OR txt LIKE '%secret_key%' THEN RAISE EXCEPTION 'review leaked more than the cited spans'; END IF;
 IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(d->'proposals') pr, jsonb_array_elements(pr->'fields') f, jsonb_array_elements(f->'citations') ci
     WHERE pr->>'kind'='customer' AND ci->>'state'='shown' AND ci->>'snippet'='Jordan Rivera' AND ci->>'speaker'='caller') THEN RAISE EXCEPTION 'exact cited span not shown'; END IF;
 SELECT pr INTO p FROM jsonb_array_elements(d->'proposals') pr WHERE pr->>'kind'='memory_candidate';
 IF p->>'route' <> 'review_only' OR p->'action_id' <> 'null'::jsonb OR p->'staged' <> 'null'::jsonb OR p->'status' <> 'null'::jsonb OR (p->'ambiguity'->>'candidate_customers')::int <> 2 THEN
   RAISE EXCEPTION 'review-only projection: %', p; END IF;
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(d->'proposals') pr WHERE pr->>'freshness' IS NOT NULL) THEN RAISE EXCEPTION 'a fresh proposal reports a denial'; END IF;

 -- a cited span whose digest does not match the stored words is withheld, never shown
 SELECT public.call_copilot_review_snippet('@S1@', c, (SELECT id FROM public.call_copilot_transcript_segments WHERE call_id = c AND segment_index = 0), 11, 24, repeat('0', 64), public.call_copilot_capture_state('@S1@', c)) INTO r;
 IF r <> '{"state": "mismatch"}'::jsonb THEN RAISE EXCEPTION 'a mismatched digest was not withheld: %', r; END IF;
 SELECT public.call_copilot_review_snippet('@S1@', c, (SELECT id FROM public.call_copilot_transcript_segments WHERE call_id = c AND segment_index = 0), 11, 24,
   encode(sha256(convert_to('Jordan Rivera','UTF8')),'hex'), public.call_copilot_capture_state('@S1@', c)) INTO r;
 IF r <> '{"state": "shown", "snippet": "Jordan Rivera"}'::jsonb THEN RAISE EXCEPTION 'the exact span was not shown: %', r; END IF;
 -- ------------------------------------------------------------------ roles
 SET LOCAL ROLE authenticated; PERFORM set_config('request.jwt.claims','{"sub":"@U3@","role":"authenticated"}',true);
 d := public.call_copilot_review_detail('@S1@', c, NULL); RESET ROLE;
 IF d->>'viewer_role' <> 'manager' OR (d->>'can_approve')::boolean OR jsonb_array_length(d->'proposals') <> 3 THEN RAISE EXCEPTION 'manager view'; END IF;
 -- ------------------ refusal loop
 FOREACH x IN ARRAY ARRAY['@U4@','@U5@','@U6@','@U2@'] LOOP
  caught := false;
  BEGIN
   SET LOCAL ROLE authenticated; PERFORM set_config('request.jwt.claims', json_build_object('sub', x, 'role','authenticated')::text, true);
   PERFORM public.call_copilot_review_detail('@S1@', c, NULL);
  EXCEPTION WHEN SQLSTATE '42501' THEN caught := true; END;
  RESET ROLE;
  IF NOT caught THEN RAISE EXCEPTION 'user % read this shop review', x; END IF;
  caught := false;
  BEGIN
   SET LOCAL ROLE authenticated; PERFORM set_config('request.jwt.claims', json_build_object('sub', x, 'role','authenticated')::text, true);
   PERFORM public.call_copilot_review_list('@S1@', 20, NULL, NULL);
  EXCEPTION WHEN SQLSTATE '42501' THEN caught := true; END;
  RESET ROLE;
  IF NOT caught THEN RAISE EXCEPTION 'user % listed this shop', x; END IF;
 END LOOP;
 -- ------------------ cross shop
 -- another shop's owner naming their own shop with this shop's call id: exactly a missing call
 SET LOCAL ROLE authenticated; PERFORM set_config('request.jwt.claims','{"sub":"@U2@","role":"authenticated"}',true);
 d := public.call_copilot_review_detail('@S2@', c, NULL); r := public.call_copilot_review_detail('@S2@', gen_random_uuid(), NULL);
 RESET ROLE;
 IF d IS DISTINCT FROM '{"found": false}'::jsonb OR r IS DISTINCT FROM d THEN RAISE EXCEPTION 'cross-shop call distinguishable: % / %', d, r; END IF;
 -- anon: has_function_privilege above proves it cannot execute either reader. It is not exercised by calling the function as anon
 -- inside this block: a permission error raised under SET ROLE anon inside a plpgsql subtransaction segfaults PostgreSQL 17.6 here
 -- (reproduced on a private stack; unrelated to this migration), so the executed anon check lives in the integration suite
 -- (PostgREST answers 42501).
 -- ------------------ bad cursor
 caught := false;
 BEGIN SET LOCAL ROLE authenticated; PERFORM set_config('request.jwt.claims','{"sub":"@U1@","role":"authenticated"}',true);
  PERFORM public.call_copilot_review_list('@S1@', 20, now(), NULL); EXCEPTION WHEN SQLSTATE '22023' THEN caught := true; END; RESET ROLE;
 IF NOT caught THEN RAISE EXCEPTION 'half a cursor accepted'; END IF;

 -- ------------------------------------------------------------------ freshness parity with the claim's own recheck
 FOR n IN 1..5 LOOP
  IF n = 2 THEN   -- an edited pending payload
    UPDATE public.pending_actions SET payload = payload || '{"content":"tampered"}'::jsonb WHERE id = (SELECT pending_action_id FROM public.call_copilot_proposals WHERE kind='service_request');
    edited := (SELECT id FROM public.call_copilot_proposals WHERE kind='service_request');
  ELSIF n = 3 THEN -- the customer's identity changes
    UPDATE public.customers SET name = 'Someone Else' WHERE id = '@C1@';
  ELSIF n = 4 THEN -- new evidence
    PERFORM public.call_copilot_record_segment('@S1@', c, 2, 'seg-2', 'caller', now()-interval '10 minutes'+interval '11 seconds', now()-interval '10 minutes'+interval '12 seconds', 'One more thing about wheels', '{}');
  ELSIF n = 5 THEN -- a late consent decline
    PERFORM pg_temp.ev('@S1@','CAreview01','CAreview01e6',6,'consent_declined','caller','v1',3,70);
  END IF;
  FOR prop IN SELECT p.id, p.pending_action_id, p.route FROM public.call_copilot_proposals p WHERE p.call_id = c AND p.route = 'pending_action' LOOP
   pl := (SELECT a.payload FROM public.pending_actions a WHERE a.id = prop.pending_action_id);
   code_a := public.call_copilot_review_freshness('@S1@', prop.id, pl, NULL, NULL);
   code_b := public.call_copilot_recheck('@S1@', prop.id, pl);
   IF code_a IS DISTINCT FROM code_b THEN RAISE EXCEPTION 'freshness drift at step %: review=% claim=%', n, code_a, code_b; END IF;
   IF n = 1 AND code_a IS NOT NULL THEN RAISE EXCEPTION 'fresh proposal denied: %', code_a; END IF;
   IF n = 2 AND prop.pending_action_id = (SELECT pending_action_id FROM public.call_copilot_proposals WHERE kind='service_request') AND code_a <> 'call_proposal_edited' THEN RAISE EXCEPTION 'edit not shown: %', code_a; END IF;
   IF n = 3 AND code_a IS NULL AND prop.id = (SELECT id FROM public.call_copilot_proposals WHERE kind='customer') THEN RAISE EXCEPTION 'crm change not shown'; END IF;
   IF n = 4 AND prop.id <> edited AND code_a <> 'call_evidence_changed' THEN RAISE EXCEPTION 'new evidence not shown: %', code_a; END IF;
   IF n = 5 AND prop.id <> edited AND code_a <> 'call_consent_unavailable' THEN RAISE EXCEPTION 'decline not shown: %', code_a; END IF;
  END LOOP;
  IF n = 4 THEN
    SET LOCAL ROLE authenticated; PERFORM set_config('request.jwt.claims','{"sub":"@U1@","role":"authenticated"}',true);
    d := public.call_copilot_review_detail('@S1@', c, NULL); RESET ROLE;
    IF (d->'evidence'->'selected'->>'current')::boolean OR NOT (d->>'snippets_withheld')::boolean OR d::text LIKE '%wheels%' OR d::text LIKE '%Jordan Rivera and I%' THEN
      RAISE EXCEPTION 'new evidence did not withhold snippets: %', left(d::text, 300); END IF;
  END IF;
 END LOOP;
 -- after the decline: the call is still listed, every snippet is withheld and no transcript word leaves
 SET LOCAL ROLE authenticated; PERFORM set_config('request.jwt.claims','{"sub":"@U1@","role":"authenticated"}',true);
 d := public.call_copilot_review_detail('@S1@', c, NULL); RESET ROLE;
 IF (d->'capture'->>'review_permitted')::boolean OR NOT (d->>'snippets_withheld')::boolean OR d::text LIKE '%Jordan Rivera and I%' OR d::text LIKE '%ceramic coating please%' THEN RAISE EXCEPTION 'decline did not withhold'; END IF;
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(d->'proposals') pr, jsonb_array_elements(pr->'fields') f, jsonb_array_elements(f->'citations') ci WHERE ci->>'state' <> 'withheld') THEN RAISE EXCEPTION 'a snippet survived a decline'; END IF;
END $$;
""")


def trace(sql):
    """PROBE_TRACE=1 adds a server-log line before each section, so a backend crash can be located."""
    if not os.environ.get('PROBE_TRACE'):
        return sql
    return re.sub(r"(?m)^( -- -{10,} )(.*)$", lambda m: f" RAISE LOG 'PROBE_TRACE {m.group(2)[:50].replace(chr(39), '')}';", sql)


def probe(text):
    body = body_of(text)
    sql = f"BEGIN;\n{DROP_NEW}\n{SEED}\n{body}\n{trace(CHECKS)}\nROLLBACK;\n"
    run(sql)


def mutations():
    o = ORIGINAL
    def sub(old, new, count=1):
        assert old in o, f'mutation anchor missing: {old[:60]}'
        return o.replace(old, new, count)
    detail_gate = "IF v_role IS NULL THEN RAISE EXCEPTION 'Call review access unavailable' USING ERRCODE = '42501'; END IF;\n  SELECT * INTO v_call"
    return {
        'grant_anon': sub("  TO authenticated;\n\nCOMMIT;", "  TO authenticated, anon;\n\nCOMMIT;"),
        'no_viewer_check': sub(detail_gate, "SELECT * INTO v_call"),
        'table_grant': sub("COMMIT;", "GRANT SELECT ON public.call_copilot_transcript_segments TO authenticated;\nCOMMIT;") if o.rstrip().endswith("COMMIT;") else o,
        'always_show_snippets': sub("can_show := gate_ok AND sel_current;", "can_show := true;"),
        'no_digest_check': sub("IF encode(sha256(convert_to(q, 'UTF8')), 'hex') IS DISTINCT FROM p_digest THEN RETURN jsonb_build_object('state', 'mismatch'); END IF;", ""),
        'whole_segment_text': sub("jsonb_build_object('state', 'shown', 'snippet', CASE WHEN length(q) > 280 THEN left(q, 279) || '…' ELSE q END)", "jsonb_build_object('state', 'shown', 'snippet', seg.text)"),
        'freshness_ignores_crm': sub("IF now_binding IS DISTINCT FROM prop.crm_binding THEN RETURN 'call_crm_state_changed'; END IF;", "NULL;"),
        'manager_without_crm_read': sub("OR (m.role = 'manager' AND 'crm.read' = ANY (m.capabilities)))\n   LIMIT 1", "OR (m.role = 'manager'))\n   LIMIT 1"),
        'cross_shop_viewer': sub("AND m.shop_id = p_shop AND m.user_id = auth.uid() AND m.active", "AND m.user_id = auth.uid() AND m.active"),
        'inactive_member': sub("AND m.shop_id = p_shop AND m.user_id = auth.uid() AND m.active", "AND m.shop_id = p_shop AND m.user_id = auth.uid()"),
        'leaks_candidate_ids': sub("'candidate_customers', CASE WHEN jsonb_typeof(a -> 'candidate_customer_ids') = 'array' THEN jsonb_array_length(a -> 'candidate_customer_ids') END,", "'candidate_customers', jsonb_array_length(a -> 'candidate_customer_ids'), 'ids', a -> 'candidate_customer_ids',"),
        'leaks_provider_id': sub("'call', jsonb_build_object('id', v_call.id,", "'call', jsonb_build_object('provider_call_id', v_call.provider_call_id, 'id', v_call.id,"),
    }


def main():
    args = sys.argv[1:]
    if args and args[0] == '--mutate':
        wanted = args[1] if len(args) > 1 else 'all'
        muts = mutations()
        names = list(muts) if wanted == 'all' else [wanted]
        missed = []
        for name in names:
            if muts[name] == ORIGINAL:
                print(f'SKIP {name} (anchor not applicable)'); continue
            try:
                probe(muts[name])
            except SystemExit as e:
                print(f'caught  {name}: {str(e)[:110]}')
                continue
            print(f'MISSED  {name}')
            missed.append(name)
        if missed:
            raise SystemExit(f'FAIL: the probe did not detect: {missed}')
        print(f'PASS: all {len(names)} mutations were detected')
        return
    probe(ORIGINAL)
    after = run("SELECT count(*) || ':' || max(version) FROM supabase_migrations.schema_migrations WHERE version <> '%s'" % NEW)
    assert after == ledger_before, 'ledger changed'
    assert run("SELECT count(*) FROM pg_proc WHERE proname LIKE 'call_copilot_review_%'") in ('0', '6'), 'schema left in an unexpected state'
    print('PASS: review read boundary migration verified (upgrade path), rolled back')


main()
