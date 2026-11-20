"""Non-destructive upgrade probe for 20261120140000_call_copilot_proposals (Call Copilot PR E).

Everything runs inside ONE transaction on the unlinked gradia-isolated-tests stack and ends with
ROLLBACK, so no database state is changed. Inside it the probe
  1. seeds fictional shops with EXISTING data (a customer, vehicle, interaction, pending actions of several
     types, a receptionist call record and a consented PR D call ledger), fingerprints every existing table
     the migration could conceivably touch (rows, columns, policies, grants, triggers, constraints) and the
     ACL + definition of control_claim, claim_control_action and claim_delegated_message, then runs an
     ordinary (non Call Copilot) claim and records exactly what it returned and audited,
  2. applies the migration's REAL SQL text (BEGIN/COMMIT removed so the outer transaction stays in control)
     and proves:
       * every existing table is byte-for-byte unchanged and the ACLs of the three claim functions are
         unchanged, and control_claim differs from its previous definition ONLY by the recheck hook,
       * an identical ordinary claim returns and audits exactly what it did before,
       * the six new tables are RLS-enabled with no browser-role privilege, transcript text and transcript
         conflicts are readable by NO role, and only the reviewed functions are executable (and only by the
         intended roles),
       * the capture gate runs BEFORE any text is stored (before consent, in a pause gap, after a decline,
         across a gap, for another shop, for an unknown call): nothing is persisted; card numbers are refused,
       * exact replay is a duplicate, changed text is a recorded conflict that fails the call closed,
       * coverage is truthful: partial unless attested AND every observable check passes,
       * extraction records one run, stages executable proposals as ORDINARY PENDING (approval-required)
         actions, creates no CRM row, replays without duplicates, refuses forged citations / customers,
       * approval re-verifies, through the existing claim, payload edits, consent, evidence revision, the
         requester, the agent definition and the CRM identity, and an unedited proposal executes through the
         existing record command exactly once,
       * a customer-specific memory proposal enters the EXISTING reviewed-memory candidate lifecycle inert,
       * a shop delete still cascades every new row,
  3. rolls back, then confirms the schema and ledger are exactly as before.
No credential-bearing output is printed.

`--mutate NAME` re-runs the probe against a deliberately broken copy of the migration and REQUIRES it to
fail (proving the probe really detects that defect). `--mutate all` runs every mutation.
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

NEW = '20261120140000'
migration = next((root / 'supabase/migrations').glob(f'{NEW}_*.sql'))
text = migration.read_text().strip()
assert text.startswith('BEGIN;') and text.endswith('COMMIT;'), 'migration must be one BEGIN..COMMIT block'
body = text[len('BEGIN;'):-len('COMMIT;')]
stripped = re.sub(r'\$\$.*?\$\$', '$$$$', body, flags=re.S)
assert not re.search(r'(?im)^\s*(commit|rollback|begin|start\s+transaction|savepoint|release|abort|end)\b', stripped), 'unexpected transaction control'
versions = sorted(p.name.split('_')[0] for p in (root / 'supabase/migrations').glob('*.sql'))
assert versions[-1] == NEW, 'probe expects this to be the newest migration'


def run(sql):
    if os.environ.get('PROBE_DUMP'):
        Path(os.environ['PROBE_DUMP']).write_text(sql)
    r = subprocess.run(['docker', 'exec', '-i', f'supabase_db_{project}', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'],
                       input=sql, text=True, capture_output=True)
    if r.returncode:
        errors = [l for l in r.stderr.splitlines() if 'ERROR:' in l]
        detail = errors[0].split('ERROR:', 1)[1].strip()[:400] if errors else 'no detail'
        raise SystemExit(f'FAIL: probe failed ({detail}); rolled back; raw output withheld')
    return r.stdout.strip()


stack_max = run("SELECT max(version) FROM supabase_migrations.schema_migrations")
assert run("SELECT to_regclass('public.call_copilot_proposals') IS NOT NULL") == 'f', 'migration already applied on the stack; the upgrade probe needs the pre-migration schema'
assert run("SELECT to_regclass('public.call_copilot_calls') IS NOT NULL") == 't', 'PR D ledger required'
ledger_before = run("SELECT count(*) || ':' || max(version) FROM supabase_migrations.schema_migrations")
assert stack_max < NEW, f'stack already holds a migration at or after {NEW}: {stack_max}'

TABLES = ['call_records', 'call_copilot_calls', 'call_copilot_events', 'call_copilot_conflicts', 'pending_actions', 'customers',
          'vehicles', 'interactions', 'reviewed_memory_revisions', 'reviewed_memory_sources', 'control_execution_decisions']
FNS = ['control_claim(uuid,uuid,uuid,text,text)', 'claim_control_action(uuid,uuid,uuid,text)', 'claim_delegated_message(uuid,uuid,text)',
       'control_review_hash(jsonb)', 'create_reviewed_memory_candidate(uuid,text,text,jsonb,uuid,integer,timestamptz,timestamptz,timestamptz)',
       'call_copilot_record_event(uuid,text,text,text,integer,text,text,text,integer,text,text,text,text,timestamptz)',
       'call_copilot_capture_state(uuid,uuid)', 'call_copilot_assert_capture(uuid,uuid,text,timestamptz)']


def fingerprint_sql():
    parts = []
    for t in TABLES:
        order = 'id' if t not in ('reviewed_memory_revisions',) else 'shop_id, source_id, revision'
        parts.append(f"""
SELECT '{t}:rows' AS k, md5(coalesce(string_agg(tt::text, ',' ORDER BY {'tt.id' if order == 'id' else order}), '')) AS v FROM public.{t} tt
UNION ALL SELECT '{t}:columns', md5(string_agg(column_name||':'||data_type||':'||is_nullable, ',' ORDER BY ordinal_position)) FROM information_schema.columns WHERE table_schema='public' AND table_name='{t}'
UNION ALL SELECT '{t}:policies', md5(coalesce(string_agg(polname||':'||polcmd::text||':'||coalesce(pg_get_expr(polqual,polrelid),'')||':'||coalesce(pg_get_expr(polwithcheck,polrelid),''), ',' ORDER BY polname), '')) FROM pg_policy WHERE polrelid='public.{t}'::regclass
UNION ALL SELECT '{t}:grants', md5(coalesce(string_agg(grantee||':'||privilege_type, ',' ORDER BY grantee, privilege_type), '')) FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='{t}'
UNION ALL SELECT '{t}:triggers', md5(coalesce(string_agg(tgname, ',' ORDER BY tgname), '')) FROM pg_trigger WHERE tgrelid='public.{t}'::regclass AND NOT tgisinternal
UNION ALL SELECT '{t}:constraints', md5(coalesce(string_agg(conname||':'||pg_get_constraintdef(oid), ',' ORDER BY conname), '')) FROM pg_constraint WHERE conrelid='public.{t}'::regclass""")
    for f in FNS:
        parts.append(f"""
SELECT 'fn:{f}:acl', coalesce(proacl::text, 'default') FROM pg_proc WHERE oid = 'public.{f}'::regprocedure
UNION ALL SELECT 'fn:{f}:owner', proowner::regrole::text FROM pg_proc WHERE oid = 'public.{f}'::regprocedure""")
    return '\nUNION ALL '.join(p.strip().replace("SELECT '", "SELECT '", 1) for p in parts)


def T(sql):
    for k, v in {'@S1@': '00000000-0000-4000-8000-0000000b0001', '@S2@': '00000000-0000-4000-8000-0000000b0002',
                 '@U1@': '00000000-0000-4000-8000-0000000a0001', '@U2@': '00000000-0000-4000-8000-0000000a0002',
                 '@U3@': '00000000-0000-4000-8000-0000000a0003', '@U4@': '00000000-0000-4000-8000-0000000a0004', '@C1@': '00000000-0000-4000-8000-0000000c0001'}.items():
        sql = sql.replace(k, v)
    return sql


FP = fingerprint_sql()

SEED = T("""
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES ('@U1@','o1@example.test',now()),('@U2@','o2@example.test',now()),('@U3@','m3@example.test',now()),('@U4@','m4@example.test',now());
INSERT INTO public.shops(id,owner_id,name) VALUES ('@S1@','@U1@','Fictional A'),('@S2@','@U2@','Fictional B');
INSERT INTO public.shop_memberships(shop_id,user_id,role,capabilities,display_name) VALUES ('@S1@','@U4@','manager',ARRAY['crm.read'],'Manager');
INSERT INTO public.customers(id,shop_id,name,phone,email) VALUES ('@C1@','@S1@','Jordan Rivera','+1 555 014 2988','jordan.rivera@example.test');
INSERT INTO public.vehicles(shop_id,customer_id,make,model) VALUES ('@S1@','@C1@','Tesla','Model 3');
INSERT INTO public.call_records(shop_id,vapi_call_id,summary) VALUES ('@S1@','legacy-call-1','Legacy receptionist summary');
INSERT INTO public.interactions(shop_id,customer_id,channel,role,content) VALUES ('@S1@','@C1@','note','gradia','legacy note');
INSERT INTO public.pending_actions(id,shop_id,requested_by,action_type,payload) VALUES
 ('00000000-0000-4000-8000-0000000d0001','@S1@','@U1@','add_note','{"content":"legacy a","customer_name":null,"phone":null}'),
 ('00000000-0000-4000-8000-0000000d0002','@S1@','@U1@','add_note','{"content":"legacy b","customer_name":null,"phone":null}'),
 ('00000000-0000-4000-8000-0000000d0003','@S1@','@U1@','create_lead','{"customer_name":"Legacy","phone":"+15550140000","car_info":null,"pin_notes":null,"status":"new"}');
CREATE FUNCTION pg_temp.ev(p_shop uuid, p_call text, p_event text, p_seq int, p_kind text,
  p_party text DEFAULT NULL, p_ver text DEFAULT NULL, p_resp int DEFAULT NULL, p_secs int DEFAULT 0,
  p_reason text DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.call_copilot_record_event(p_shop, 'twilio', p_call, p_event, p_seq, p_kind, p_party, p_ver, p_resp,
    CASE WHEN p_kind='call_opened' THEN 'gradia_controlled_number' END, NULL, NULL, p_reason,
    now() - interval '10 minutes' + make_interval(secs => p_secs))
$$;
-- a fully consented PR D call: capture interval opens at +4s
CREATE FUNCTION pg_temp.consent(p_shop uuid, p_call text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_temp.ev(p_shop,p_call,p_call||'e1',1,'call_opened');
  PERFORM pg_temp.ev(p_shop,p_call,p_call||'e2',2,'disclosure_delivered','operator','v1',NULL,1);
  PERFORM pg_temp.ev(p_shop,p_call,p_call||'e3',3,'disclosure_delivered','caller','v1',NULL,2);
  PERFORM pg_temp.ev(p_shop,p_call,p_call||'e4',4,'consent_granted','operator','v1',2,3);
  PERFORM pg_temp.ev(p_shop,p_call,p_call||'e5',5,'consent_granted','caller','v1',3,4);
END $$;
SELECT pg_temp.consent('@S1@','CAlegacy01');
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
CREATE TEMP TABLE claim_before AS
  SELECT public.claim_control_action('@S1@','00000000-0000-4000-8000-0000000d0001','@U1@','hitl') AS cr;
CREATE TEMP TABLE decision_before AS
  SELECT action_type, mode, allowed, reason, context, actor_role, policy_revision FROM public.control_execution_decisions WHERE action_id='00000000-0000-4000-8000-0000000d0001';
CREATE TEMP TABLE fp_before AS """ + FP + """;
CREATE TEMP TABLE def_before AS SELECT pg_get_functiondef('public.control_claim(uuid,uuid,uuid,text,text)'::regprocedure) AS d;
""")

CHECKS = T(r"""
DO $$
DECLARE n integer; r jsonb; s jsonb; x text; cid uuid; call_a uuid; rev jsonb; rev2 jsonb; run jsonb; prop record; act uuid;
 res jsonb; pid uuid; defn text; before_d text; after_d text;
BEGIN
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);

 -- ------------------------------------------------------------------ existing objects untouched
 SELECT string_agg(f.k, ',') INTO x FROM fp_before f JOIN (""" + FP + r""") c USING (k) WHERE f.v IS DISTINCT FROM c.v;
 IF x IS NOT NULL THEN RAISE EXCEPTION 'existing objects drifted: %', x; END IF;
 -- control_claim differs from its previous definition ONLY by the three hook lines
 SELECT d INTO before_d FROM def_before;
 after_d := pg_get_functiondef('public.control_claim(uuid,uuid,uuid,text,text)'::regprocedure);
 IF after_d = before_d THEN RAISE EXCEPTION 'control_claim was not replaced'; END IF;
 after_d := replace(after_d, ' call_reason text;', '');
 after_d := replace(after_d, E' -- Call Copilot proposals only: re-verify consent, evidence revision, payload, requester, agent definition\n -- and CRM identity at the moment of approval. NULL for every other action (unchanged path).\n call_reason:=public.call_copilot_claim_recheck(p_shop,p_action,action.payload,p_context);\n', '');
 after_d := replace(after_d, E'  WHEN call_reason IS NOT NULL THEN call_reason\n', '');
 IF regexp_replace(after_d, '\s+', ' ', 'g') <> regexp_replace(before_d, '\s+', ' ', 'g') THEN
   RAISE EXCEPTION 'control_claim differs beyond the recheck hook'; END IF;

 -- an identical ordinary claim returns and audits exactly what it did before
 res := public.claim_control_action('@S1@','00000000-0000-4000-8000-0000000d0002','@U1@','hitl');
 IF (res - 'id' - 'payload') IS DISTINCT FROM ((SELECT cr FROM claim_before) - 'id' - 'payload') THEN RAISE EXCEPTION 'ordinary claim result changed: % vs %', res, (SELECT cr FROM claim_before); END IF;
 IF NOT EXISTS (SELECT 1 FROM public.control_execution_decisions d, decision_before b WHERE d.action_id='00000000-0000-4000-8000-0000000d0002'
    AND (d.action_type,d.mode,d.allowed,d.reason,d.context,d.actor_role,d.policy_revision) IS NOT DISTINCT FROM (b.action_type,b.mode,b.allowed,b.reason,b.context,b.actor_role,b.policy_revision)) THEN
   RAISE EXCEPTION 'ordinary claim audit changed'; END IF;

 -- the card detector matches card layouts and NEVER identifiers that merely contain digits
 IF NOT public.call_copilot_has_card_number('x 4111 1111 1111 1111 y') OR NOT public.call_copilot_has_card_number('4111-1111-1111-1111')
    OR NOT public.call_copilot_has_card_number('4111111111111111') OR NOT public.call_copilot_has_card_number('3782 822463 10005')
    OR public.call_copilot_has_card_number('4111 1111 1111 1112') OR public.call_copilot_has_card_number('call 555 014 2988 zip 94103') THEN
   RAISE EXCEPTION 'card detector misbehaves'; END IF;
 SELECT count(*) INTO n FROM generate_series(1, 20000) g
  WHERE public.call_copilot_has_card_number('{"customer_id":"' || gen_random_uuid()::text || '","at":"' || to_char(now() + g * interval '37 seconds', 'YYYY-MM-DD"T"HH24:MI:SS.US') || '+00:00"}');
 IF n <> 0 THEN RAISE EXCEPTION 'card detector matched % identifier-shaped strings', n; END IF;

 -- ------------------------------------------------------------------ RLS and privileges
 FOREACH x IN ARRAY ARRAY['call_copilot_transcript_segments','call_copilot_transcript_conflicts','call_copilot_evidence_revisions',
   'call_copilot_extraction_runs','call_copilot_proposals','call_copilot_memory_submissions'] LOOP
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.'||x)::regclass) THEN RAISE EXCEPTION 'RLS disabled on %', x; END IF;
  IF has_table_privilege('anon','public.'||x,'SELECT') OR has_table_privilege('authenticated','public.'||x,'SELECT')
     OR has_table_privilege('authenticated','public.'||x,'INSERT') OR has_table_privilege('anon','public.'||x,'INSERT') THEN RAISE EXCEPTION 'browser role can reach %', x; END IF;
  IF has_table_privilege('service_role','public.'||x,'INSERT') OR has_table_privilege('service_role','public.'||x,'UPDATE')
     OR has_table_privilege('service_role','public.'||x,'DELETE') OR has_table_privilege('service_role','public.'||x,'TRUNCATE') THEN RAISE EXCEPTION 'service_role can write % directly', x; END IF;
 END LOOP;
 IF has_table_privilege('service_role','public.call_copilot_transcript_segments','SELECT') OR has_table_privilege('service_role','public.call_copilot_transcript_conflicts','SELECT') THEN
   RAISE EXCEPTION 'service_role can read transcript text directly'; END IF;
 IF NOT has_table_privilege('service_role','public.call_copilot_proposals','SELECT') THEN RAISE EXCEPTION 'service_role cannot read proposals'; END IF;
 FOREACH x IN ARRAY ARRAY[
   'call_copilot_record_segment(uuid,uuid,integer,text,text,timestamptz,timestamptz,text,text[])',
   'call_copilot_seal_evidence(uuid,uuid,uuid,boolean,integer)', 'call_copilot_read_transcript(uuid,uuid,uuid,uuid)',
   'call_copilot_record_extraction(uuid,uuid,uuid,uuid,jsonb,jsonb)', 'call_copilot_find_unknown_run(uuid,uuid,uuid,uuid,text,text,integer)'] LOOP
  IF NOT has_function_privilege('service_role','public.'||x,'EXECUTE') OR has_function_privilege('anon','public.'||x,'EXECUTE') OR has_function_privilege('authenticated','public.'||x,'EXECUTE') THEN
    RAISE EXCEPTION 'ACL wrong on %', x; END IF;
 END LOOP;
 FOREACH x IN ARRAY ARRAY['call_copilot_claim_recheck(uuid,uuid,jsonb,text)','call_copilot_actor_ok(uuid,uuid)','call_copilot_evidence_snapshot(uuid,uuid,boolean,integer)',
   'call_copilot_evidence_is_current(uuid,uuid)','call_copilot_assert_span(uuid,uuid,timestamptz,timestamptz,text)','call_copilot_resolve_fields(uuid,uuid,jsonb)',
   'call_copilot_customer_binding(uuid,uuid,text[])','control_claim(uuid,uuid,uuid,text,text)'] LOOP
  IF has_function_privilege('service_role','public.'||x,'EXECUTE') OR has_function_privilege('anon','public.'||x,'EXECUTE') OR has_function_privilege('authenticated','public.'||x,'EXECUTE') THEN
    RAISE EXCEPTION 'internal function callable via API: %', x; END IF;
 END LOOP;
 IF NOT has_function_privilege('authenticated','public.call_copilot_submit_memory_candidate(uuid,uuid)','EXECUTE') OR has_function_privilege('anon','public.call_copilot_submit_memory_candidate(uuid,uuid)','EXECUTE')
    OR has_function_privilege('service_role','public.call_copilot_submit_memory_candidate(uuid,uuid)','EXECUTE') THEN RAISE EXCEPTION 'memory submit ACL wrong'; END IF;

 -- ------------------------------------------------------------------ the gate runs BEFORE any text is stored
 SELECT id INTO call_a FROM public.call_copilot_calls WHERE provider_call_id = 'CAlegacy01';
 -- before consent (interval opens at +4s)
 BEGIN
  PERFORM public.call_copilot_record_segment('@S1@', call_a, 0, 'seg-pre', 'caller', now()-interval '10 minutes'+interval '1 second', now()-interval '10 minutes'+interval '3 seconds', 'hello before consent', '{}');
  RAISE EXCEPTION 'stored text before consent';
 EXCEPTION WHEN SQLSTATE 'CC403' THEN NULL; END;
 -- another shop and an unknown call
 BEGIN
  PERFORM public.call_copilot_record_segment('@S2@', call_a, 0, 'seg-x', 'caller', now()-interval '10 minutes'+interval '5 seconds', now()-interval '10 minutes'+interval '6 seconds', 'cross shop', '{}');
  RAISE EXCEPTION 'cross-shop text stored';
 EXCEPTION WHEN SQLSTATE 'CC403' THEN NULL; END;
 BEGIN
  PERFORM public.call_copilot_record_segment('@S1@', gen_random_uuid(), 0, 'seg-y', 'caller', now()-interval '10 minutes'+interval '5 seconds', now()-interval '10 minutes'+interval '6 seconds', 'unknown call', '{}');
  RAISE EXCEPTION 'unknown-call text stored';
 EXCEPTION WHEN SQLSTATE 'CC403' THEN NULL; END;
 -- payment-card data is refused even if the application forgot to redact
 BEGIN
  PERFORM public.call_copilot_record_segment('@S1@', call_a, 0, 'seg-card', 'caller', now()-interval '10 minutes'+interval '5 seconds', now()-interval '10 minutes'+interval '6 seconds', 'my card is 4111 1111 1111 1111', '{}');
  RAISE EXCEPTION 'stored a card number';
 EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
 IF EXISTS (SELECT 1 FROM public.call_copilot_transcript_segments) THEN RAISE EXCEPTION 'a denied segment was stored'; END IF;

 -- consented segments, replay and changed replay
 r := public.call_copilot_record_segment('@S1@', call_a, 0, 'seg-0', 'caller', now()-interval '10 minutes'+interval '5 seconds', now()-interval '10 minutes'+interval '7 seconds', 'Hi this is Jordan Rivera', '{}');
 IF r->>'outcome' <> 'recorded' THEN RAISE EXCEPTION 'segment: %', r; END IF;
 r := public.call_copilot_record_segment('@S1@', call_a, 0, 'seg-0', 'caller', now()-interval '10 minutes'+interval '5 seconds', now()-interval '10 minutes'+interval '7 seconds', 'Hi this is Jordan Rivera', '{}');
 IF r->>'outcome' <> 'duplicate' THEN RAISE EXCEPTION 'replay: %', r; END IF;
 PERFORM public.call_copilot_record_segment('@S1@', call_a, 1, 'seg-1', 'caller', now()-interval '10 minutes'+interval '8 seconds', now()-interval '10 minutes'+interval '10 seconds', 'I would like a ceramic coating please', '{}');
 SELECT count(*) INTO n FROM public.call_copilot_transcript_segments WHERE call_id = call_a;
 IF n <> 2 THEN RAISE EXCEPTION 'expected 2 segments, got %', n; END IF;
 BEGIN UPDATE public.call_copilot_transcript_segments SET text = 'edited'; RAISE EXCEPTION 'segment update accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN DELETE FROM public.call_copilot_transcript_segments; RAISE EXCEPTION 'segment delete accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;

 -- ------------------------------------------------------------------ truthful coverage + stable revisions
 rev := public.call_copilot_seal_evidence('@S1@','@U1@', call_a, true, 2);
 IF rev->>'outcome' <> 'sealed' OR rev->>'coverage_status' <> 'partial' OR NOT (rev->'coverage_reasons') @> '"call_not_ended"' THEN
   RAISE EXCEPTION 'an attested but still-open call must be partial: %', rev; END IF;
 rev2 := public.call_copilot_seal_evidence('@S1@','@U1@', call_a, true, 2);
 IF rev2->>'outcome' <> 'unchanged' OR rev2->>'evidence_revision_id' <> rev->>'evidence_revision_id' THEN RAISE EXCEPTION 'unchanged evidence must keep its revision: %', rev2; END IF;
 r := public.call_copilot_seal_evidence('@S1@','@U1@', call_a, false, NULL);
 IF r->>'outcome' <> 'sealed' OR NOT (r->'coverage_reasons') @> '"completion_not_attested"' OR NOT (r->'coverage_reasons') @> '"segment_count_unconfirmed"' THEN RAISE EXCEPTION 'unattested must be partial: %', r; END IF;
 -- an unauthorised member cannot seal or read
 BEGIN PERFORM public.call_copilot_seal_evidence('@S1@','@U3@', call_a, true, 2); RAISE EXCEPTION 'non-member sealed evidence';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM public.call_copilot_read_transcript('@S1@','@U2@', call_a, (rev->>'evidence_revision_id')::uuid); RAISE EXCEPTION 'foreign owner read the transcript';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 -- a read returns exactly the sealed content
 s := public.call_copilot_read_transcript('@S1@','@U1@', call_a, (rev->>'evidence_revision_id')::uuid);
 IF jsonb_array_length(s->'segments') <> 2 OR s->>'coverage_status' <> 'partial' THEN RAISE EXCEPTION 'read: %', s; END IF;
 -- a new segment changes the evidence: the old revision is no longer current and cannot be read for a model
 PERFORM public.call_copilot_record_segment('@S1@', call_a, 2, 'seg-2', 'operator', now()-interval '10 minutes'+interval '11 seconds', now()-interval '10 minutes'+interval '12 seconds', 'Sure thing', '{}');
 BEGIN PERFORM public.call_copilot_read_transcript('@S1@','@U1@', call_a, (rev->>'evidence_revision_id')::uuid); RAISE EXCEPTION 'stale revision read';
 EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL; END;
 BEGIN PERFORM public.call_copilot_record_extraction('@S1@','@U1@', call_a, (rev->>'evidence_revision_id')::uuid,
   jsonb_build_object('status','completed','extractor_id','fixture','extractor_version','1','schema_version',1,'crm_context_digest',repeat('a',64)), '[]'::jsonb);
  RAISE EXCEPTION 'extraction on a stale revision';
 EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL; END;
 rev := public.call_copilot_seal_evidence('@S1@','@U1@', call_a, true, 3);
 IF (rev->>'revision')::integer < 3 THEN RAISE EXCEPTION 'revision numbers must advance: %', rev; END IF;

 -- ------------------------------------------------------------------ extraction: proposals stage, never execute
 run := jsonb_build_object('status','completed','extractor_id','fixture','extractor_version','1','schema_version',1,'crm_context_digest',repeat('a',64),'refused_count',2);
 res := public.call_copilot_record_extraction('@S1@','@U1@', call_a, (rev->>'evidence_revision_id')::uuid, run, jsonb_build_array(
   jsonb_build_object('kind','customer','route','pending_action','action_type','resolve_customer','confidence','high',
     'payload', jsonb_build_object('name','Jordan Rivera','phone','+15550142988','email',NULL),
     'fields', jsonb_build_array(jsonb_build_object('name','name','value','Jordan Rivera','confidence','high','citations',
        jsonb_build_array(jsonb_build_object('segment_index',0,'start',11,'end',24)))),
     'customer_id', '@C1@'),
   jsonb_build_object('kind','service_request','route','pending_action','action_type','record_interaction','confidence','high',
     'payload', jsonb_build_object('customer_id','@C1@','channel','note','role','system','content','Call note: ceramic coating','metadata',jsonb_build_object('origin','call_copilot')),
     'bind', jsonb_build_array('name','phone'),
     'fields', jsonb_build_array(jsonb_build_object('name','service','value','ceramic coating','confidence','high','citations',
        jsonb_build_array(jsonb_build_object('segment_index',1,'start',15,'end',30)))),
     'customer_id','@C1@'),
   jsonb_build_object('kind','followup_task','route','review_only','review_reason','no_guarded_executor','confidence','medium',
     'fields', jsonb_build_array(jsonb_build_object('name','title','value','call back','confidence','medium','citations',
        jsonb_build_array(jsonb_build_object('segment_index',2,'start',0,'end',4)))))));
 IF res->>'outcome' <> 'recorded' OR (res->>'created')::integer <> 3 THEN RAISE EXCEPTION 'extraction: %', res; END IF;
 -- the database verified every cited span itself
 IF NOT EXISTS (SELECT 1 FROM public.call_copilot_proposals p, jsonb_array_elements(p.fields) f, jsonb_array_elements(f->'citations') c
    WHERE p.kind='customer' AND c->>'quote_digest' = encode(sha256(convert_to('Jordan Rivera','UTF8')),'hex') AND c->>'speaker'='caller') THEN
   RAISE EXCEPTION 'citation was not resolved from the stored transcript'; END IF;
 -- APPROVAL REQUIRED: staged as ordinary pending actions, nothing executed
 SELECT count(*) INTO n FROM public.pending_actions a JOIN public.call_copilot_proposals p ON p.pending_action_id = a.id WHERE a.status = 'pending' AND p.initial_mode = 'approval_required';
 IF n <> 2 THEN RAISE EXCEPTION 'expected 2 staged pending actions, got %', n; END IF;
 IF EXISTS (SELECT 1 FROM public.pending_actions a JOIN public.call_copilot_proposals p ON p.pending_action_id = a.id WHERE a.status <> 'pending' OR a.result_id IS NOT NULL OR a.decided_at IS NOT NULL) THEN
   RAISE EXCEPTION 'a proposal was executed at creation'; END IF;
 IF (SELECT count(*) FROM public.customers WHERE shop_id='@S1@') <> 1 OR (SELECT count(*) FROM public.interactions WHERE shop_id='@S1@') <> 1 THEN RAISE EXCEPTION 'extraction wrote CRM rows'; END IF;
 -- replay: same run, no duplicates
 r := public.call_copilot_record_extraction('@S1@','@U1@', call_a, (rev->>'evidence_revision_id')::uuid, run, '[]'::jsonb);
 IF r->>'outcome' <> 'replayed' OR r->>'run_id' <> res->>'run_id' THEN RAISE EXCEPTION 'replay: %', r; END IF;
 -- a different extractor version over the same evidence dedupes identical proposals
 r := public.call_copilot_record_extraction('@S1@','@U1@', call_a, (rev->>'evidence_revision_id')::uuid,
   run || '{"extractor_version":"2"}'::jsonb,
   (SELECT jsonb_build_array(jsonb_build_object('kind','followup_task','route','review_only','review_reason','no_guarded_executor','confidence','medium',
     'fields', jsonb_build_array(jsonb_build_object('name','title','value','call back','confidence','medium','citations', jsonb_build_array(jsonb_build_object('segment_index',2,'start',0,'end',4))))))));
 IF (r->>'created')::integer <> 0 OR (r->>'deduplicated')::integer <> 1 THEN RAISE EXCEPTION 'dedupe: %', r; END IF;
 -- forged citations / customers / action types are refused and leave nothing behind
 BEGIN PERFORM public.call_copilot_record_extraction('@S1@','@U1@', call_a, (rev->>'evidence_revision_id')::uuid, run || '{"extractor_version":"3"}'::jsonb,
    jsonb_build_array(jsonb_build_object('kind','timing','route','review_only','review_reason','customer_unresolved','confidence','high','fields',
      jsonb_build_array(jsonb_build_object('name','preferred_timing','value','x','confidence','high','citations', jsonb_build_array(jsonb_build_object('segment_index',0,'start',0,'end',400)))))));
  RAISE EXCEPTION 'out-of-range citation accepted'; EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
 BEGIN PERFORM public.call_copilot_record_extraction('@S1@','@U1@', call_a, (rev->>'evidence_revision_id')::uuid, run || '{"extractor_version":"4"}'::jsonb,
    jsonb_build_array(jsonb_build_object('kind','timing','route','review_only','review_reason','customer_unresolved','confidence','high','customer_id', gen_random_uuid(),'fields',
      jsonb_build_array(jsonb_build_object('name','preferred_timing','value','x','confidence','high','citations', jsonb_build_array(jsonb_build_object('segment_index',0,'start',0,'end',4)))))));
  RAISE EXCEPTION 'forged customer accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM public.call_copilot_record_extraction('@S1@','@U1@', call_a, (rev->>'evidence_revision_id')::uuid, run || '{"extractor_version":"5"}'::jsonb,
    jsonb_build_array(jsonb_build_object('kind','customer','route','pending_action','action_type','charge_customer','confidence','high','payload','{}'::jsonb,'fields',
      jsonb_build_array(jsonb_build_object('name','name','value','x','confidence','high','citations', jsonb_build_array(jsonb_build_object('segment_index',0,'start',0,'end',4)))))));
  RAISE EXCEPTION 'a money action type was accepted'; EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
 BEGIN PERFORM public.call_copilot_record_extraction('@S1@','@U3@', call_a, (rev->>'evidence_revision_id')::uuid, run || '{"extractor_version":"6"}'::jsonb, '[]'::jsonb);
  RAISE EXCEPTION 'non-member recorded an extraction'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM public.call_copilot_record_extraction('@S1@','@U1@', call_a, (rev->>'evidence_revision_id')::uuid, run || '{"extractor_version":"7","definition_agent_id":"00000000-0000-4000-8000-0000000e0001","definition_revision":1}'::jsonb, '[]'::jsonb);
  RAISE EXCEPTION 'inactive agent definition accepted'; EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL; END;
 -- a failed extraction is recorded, stages nothing and does not block a later run
 r := public.call_copilot_record_extraction('@S1@','@U1@', call_a, (rev->>'evidence_revision_id')::uuid,
   jsonb_build_object('status','failed_before_effect','failure_code','invalid_output','extractor_id','fixture','extractor_version','9','schema_version',1,'crm_context_digest',repeat('b',64)), '[]'::jsonb);
 IF r->>'outcome' <> 'recorded' THEN RAISE EXCEPTION 'failure not recorded: %', r; END IF;
 r := public.call_copilot_record_extraction('@S1@','@U1@', call_a, (rev->>'evidence_revision_id')::uuid,
   jsonb_build_object('status','unknown_outcome','failure_code','deadline_exceeded','extractor_id','fixture','extractor_version','10','schema_version',1,'crm_context_digest',repeat('b',64)), '[]'::jsonb);
 IF public.call_copilot_find_unknown_run('@S1@','@U1@', call_a, (rev->>'evidence_revision_id')::uuid, 'fixture', '10', 1) IS NULL THEN RAISE EXCEPTION 'unknown-outcome run not findable'; END IF;
 IF public.call_copilot_find_unknown_run('@S1@','@U1@', call_a, (rev->>'evidence_revision_id')::uuid, 'fixture', '11', 1) IS NOT NULL THEN RAISE EXCEPTION 'unknown-outcome run matched another extractor version'; END IF;
 IF public.call_copilot_find_unknown_run('@S1@','@U2@', call_a, (rev->>'evidence_revision_id')::uuid, 'fixture', '10', 1) IS NOT NULL THEN RAISE EXCEPTION 'unknown-outcome run leaked to a non-member'; END IF;
 r := public.call_copilot_record_extraction('@S1@','@U1@', call_a, (rev->>'evidence_revision_id')::uuid,
   jsonb_build_object('status','completed','extractor_id','fixture','extractor_version','10','schema_version',1,'crm_context_digest',repeat('b',64)), '[]'::jsonb);
 IF r->>'outcome' <> 'replayed' THEN RAISE EXCEPTION 'an unknown-outcome run must be terminal for its identity: %', r; END IF;

 -- ------------------------------------------------------------------ approval: the existing claim re-verifies
 SELECT p.pending_action_id, p.id INTO act, pid FROM public.call_copilot_proposals p WHERE p.kind='service_request';
 -- 0. a proposal can never be claimed automatically, whatever autonomy is granted
 r := public.claim_control_action('@S1@', act, '@U1@', 'automatic');
 IF r->>'denied' <> 'call_human_approval_required' THEN RAISE EXCEPTION 'an automatic claim of a proposal must deny: %', r; END IF;
 -- 1. an edited operative field invalidates the proof
 UPDATE public.pending_actions SET payload = jsonb_set(payload,'{content}','"Call note: EDITED"') WHERE id = act;
 r := public.claim_control_action('@S1@', act, '@U1@', 'hitl');
 IF r->>'denied' <> 'call_proposal_edited' THEN RAISE EXCEPTION 'edit must deny: %', r; END IF;
 IF (SELECT status::text FROM public.pending_actions WHERE id = act) <> 'pending' THEN RAISE EXCEPTION 'a denied claim consumed the action'; END IF;
 UPDATE public.pending_actions SET payload = jsonb_set(payload,'{content}','"Call note: ceramic coating"') WHERE id = act;
 -- 2. executor annotations are not edits
 UPDATE public.pending_actions SET payload = payload || '{"availability":{"checked":true}}'::jsonb WHERE id = act;
 -- 3. the CRM identity changed since the proposal
 UPDATE public.customers SET name = 'Jon Rivers' WHERE id = '@C1@';
 r := public.claim_control_action('@S1@', act, '@U1@', 'hitl');
 IF r->>'denied' <> 'call_crm_state_changed' THEN RAISE EXCEPTION 'CRM change must deny: %', r; END IF;
 UPDATE public.customers SET name = 'Jordan Rivera' WHERE id = '@C1@';
 -- 4. new evidence arrives after the proposal
 PERFORM public.call_copilot_record_segment('@S1@', call_a, 3, 'seg-3', 'caller', now()-interval '10 minutes'+interval '13 seconds', now()-interval '10 minutes'+interval '14 seconds', 'One more thing', '{}');
 r := public.claim_control_action('@S1@', act, '@U1@', 'hitl');
 IF r->>'denied' <> 'call_evidence_changed' THEN RAISE EXCEPTION 'new evidence must deny: %', r; END IF;
 -- the customer-resolution proposal is bound to the same evidence, so it is stale too
 r := public.claim_control_action('@S1@', (SELECT pending_action_id FROM public.call_copilot_proposals WHERE kind='customer'), '@U1@', 'hitl');
 IF r->>'denied' <> 'call_evidence_changed' THEN RAISE EXCEPTION 'stale customer proposal must deny: %', r; END IF;
 IF (SELECT count(*) FROM public.interactions WHERE shop_id='@S1@') <> 1 THEN RAISE EXCEPTION 'a denied claim wrote a record'; END IF;
 -- every denial above was audited by the existing decision log
 IF (SELECT count(*) FROM public.control_execution_decisions WHERE action_id = act AND NOT allowed AND reason LIKE 'call\_%') < 3 THEN RAISE EXCEPTION 'denials were not audited'; END IF;

 -- ------------------------------------------------------------------ a clean call: approve once through the existing record command
 PERFORM pg_temp.consent('@S1@','CAclean001');
 SELECT id INTO call_a FROM public.call_copilot_calls WHERE provider_call_id='CAclean001';
 PERFORM public.call_copilot_record_segment('@S1@', call_a, 0, 'c-0', 'caller', now()-interval '10 minutes'+interval '5 seconds', now()-interval '10 minutes'+interval '7 seconds', 'I prefer drop-off after nine and mornings', '{}');
 rev := public.call_copilot_seal_evidence('@S1@','@U1@', call_a, false, NULL);
 res := public.call_copilot_record_extraction('@S1@','@U1@', call_a, (rev->>'evidence_revision_id')::uuid, run, jsonb_build_array(
   jsonb_build_object('kind','service_request','route','pending_action','action_type','record_interaction','confidence','high',
     'payload', jsonb_build_object('customer_id','@C1@','channel','note','role','system','content','Call note: mornings','metadata',jsonb_build_object('origin','call_copilot')),
     'fields', jsonb_build_array(jsonb_build_object('name','preferred_timing','value','mornings','confidence','high','citations', jsonb_build_array(jsonb_build_object('segment_index',0,'start',33,'end',41)))),
     'customer_id','@C1@'),
   jsonb_build_object('kind','memory_candidate','route','review_only','review_reason','memory_requires_review','confidence','high',
     'fields', jsonb_build_array(jsonb_build_object('name','preference','value','Prefers drop-off after 9 am','confidence','high','citations', jsonb_build_array(jsonb_build_object('segment_index',0,'start',9,'end',28)))),
     'customer_id','@C1@')));
 -- a manager with crm.read may request extraction; if that manager loses access the proposal can no longer be approved
 res := public.call_copilot_record_extraction('@S1@','@U4@', call_a, (rev->>'evidence_revision_id')::uuid, run || '{"extractor_version":"mgr"}'::jsonb, jsonb_build_array(
   jsonb_build_object('kind','timing','route','pending_action','action_type','record_interaction','confidence','high',
     'payload', jsonb_build_object('customer_id','@C1@','channel','note','role','system','content','Call note: manager','metadata',jsonb_build_object('origin','call_copilot')),
     'fields', jsonb_build_array(jsonb_build_object('name','preferred_timing','value','mornings','confidence','high','citations', jsonb_build_array(jsonb_build_object('segment_index',0,'start',33,'end',41)))),
     'customer_id','@C1@')));
 IF (res->>'created')::integer <> 1 THEN RAISE EXCEPTION 'manager extraction: %', res; END IF;
 UPDATE public.shop_memberships SET active = false WHERE shop_id='@S1@' AND user_id='@U4@';
 r := public.claim_control_action('@S1@', (SELECT pending_action_id FROM public.call_copilot_proposals WHERE call_id = call_a AND kind='timing'), '@U1@', 'hitl');
 IF r->>'denied' <> 'call_requester_revoked' THEN RAISE EXCEPTION 'a revoked requester must block approval: %', r; END IF;
 BEGIN PERFORM public.call_copilot_record_extraction('@S1@','@U4@', call_a, (rev->>'evidence_revision_id')::uuid, run || '{"extractor_version":"mgr2"}'::jsonb, '[]'::jsonb); RAISE EXCEPTION 'revoked member recorded an extraction';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 SELECT pending_action_id INTO act FROM public.call_copilot_proposals WHERE call_id = call_a AND kind='service_request';
 SELECT id INTO pid FROM public.call_copilot_proposals WHERE call_id = call_a AND kind='memory_candidate';
 r := public.claim_control_action('@S1@', act, '@U1@', 'hitl');
 IF r->>'denied' IS NOT NULL OR r->>'result_id' IS NULL THEN RAISE EXCEPTION 'an unedited, consented proposal must execute: %', r; END IF;
 IF (SELECT count(*) FROM public.interactions WHERE shop_id='@S1@') <> 2 THEN RAISE EXCEPTION 'record command did not run exactly once'; END IF;
 r := public.claim_control_action('@S1@', act, '@U1@', 'hitl');
 IF coalesce((r->>'already_decided')::boolean,false) IS NOT TRUE THEN RAISE EXCEPTION 'second claim must be already_decided: %', r; END IF;
 IF (SELECT count(*) FROM public.interactions WHERE shop_id='@S1@') <> 2 THEN RAISE EXCEPTION 'executed twice'; END IF;

 -- ------------------------------------------------------------------ memory: existing candidate lifecycle, inert
 PERFORM set_config('request.jwt.claims','{"role":"authenticated","sub":"@U1@"}',true);
 r := public.call_copilot_submit_memory_candidate('@S1@', pid);
 IF r->>'outcome' <> 'submitted' OR r->>'state' <> 'candidate' THEN RAISE EXCEPTION 'memory submit: %', r; END IF;
 IF EXISTS (SELECT 1 FROM public.reviewed_memory_active WHERE shop_id='@S1@') THEN RAISE EXCEPTION 'a memory candidate became active'; END IF;
 IF (SELECT state FROM public.reviewed_memory_revisions WHERE shop_id='@S1@' AND source_id=(r->>'source_id')::uuid) <> 'candidate' THEN RAISE EXCEPTION 'memory candidate must be inert'; END IF;
 r := public.call_copilot_submit_memory_candidate('@S1@', pid);
 IF r->>'outcome' <> 'already_submitted' THEN RAISE EXCEPTION 'memory submit must be idempotent: %', r; END IF;
 BEGIN PERFORM public.call_copilot_submit_memory_candidate('@S1@', (SELECT id FROM public.call_copilot_proposals WHERE call_id = call_a AND kind='service_request')); RAISE EXCEPTION 'a non-memory proposal was submitted';
 EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
 PERFORM set_config('request.jwt.claims','{"role":"authenticated","sub":"@U2@"}',true);
 BEGIN PERFORM public.call_copilot_submit_memory_candidate('@S1@', pid); RAISE EXCEPTION 'another shop owner submitted memory';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);

 -- ------------------------------------------------------------------ a decline after proposals blocks approval AND derivation
 PERFORM pg_temp.consent('@S1@','CAdecl0001');
 SELECT id INTO call_a FROM public.call_copilot_calls WHERE provider_call_id='CAdecl0001';
 PERFORM public.call_copilot_record_segment('@S1@', call_a, 0, 'd-0', 'caller', now()-interval '10 minutes'+interval '5 seconds', now()-interval '10 minutes'+interval '7 seconds', 'I need a quote', '{}');
 rev := public.call_copilot_seal_evidence('@S1@','@U1@', call_a, false, NULL);
 PERFORM public.call_copilot_record_extraction('@S1@','@U1@', call_a, (rev->>'evidence_revision_id')::uuid, run, jsonb_build_array(
   jsonb_build_object('kind','service_request','route','pending_action','action_type','record_interaction','confidence','high',
     'payload', jsonb_build_object('customer_id','@C1@','channel','note','role','system','content','Call note: quote','metadata',jsonb_build_object('origin','call_copilot')),
     'fields', jsonb_build_array(jsonb_build_object('name','service','value','quote','confidence','high','citations', jsonb_build_array(jsonb_build_object('segment_index',0,'start',9,'end',14)))),
     'customer_id','@C1@')));
 PERFORM pg_temp.ev('@S1@','CAdecl0001','dd6',6,'consent_declined','caller','v1',3,30);
 r := public.claim_control_action('@S1@', (SELECT pending_action_id FROM public.call_copilot_proposals WHERE call_id = call_a), '@U1@', 'hitl');
 IF r->>'denied' <> 'call_consent_unavailable' THEN RAISE EXCEPTION 'decline must deny approval: %', r; END IF;
 BEGIN PERFORM public.call_copilot_read_transcript('@S1@','@U1@', call_a, (rev->>'evidence_revision_id')::uuid); RAISE EXCEPTION 'read after decline';
 EXCEPTION WHEN SQLSTATE 'CC403' THEN NULL; END;
 BEGIN PERFORM public.call_copilot_record_segment('@S1@', call_a, 1, 'd-1', 'caller', now()-interval '10 minutes'+interval '8 seconds', now()-interval '10 minutes'+interval '9 seconds', 'late text', '{}'); RAISE EXCEPTION 'text stored after decline';
 EXCEPTION WHEN SQLSTATE 'CC403' THEN NULL; END;

 -- a changed segment replay is a recorded conflict that fails the whole call closed
 PERFORM pg_temp.consent('@S1@','CAconf0001');
 SELECT id INTO call_a FROM public.call_copilot_calls WHERE provider_call_id='CAconf0001';
 PERFORM public.call_copilot_record_segment('@S1@', call_a, 0, 'k-0', 'caller', now()-interval '10 minutes'+interval '5 seconds', now()-interval '10 minutes'+interval '7 seconds', 'original words', '{}');
 r := public.call_copilot_record_segment('@S1@', call_a, 0, 'k-0', 'caller', now()-interval '10 minutes'+interval '5 seconds', now()-interval '10 minutes'+interval '7 seconds', 'changed words', '{}');
 IF r->>'outcome' <> 'conflict' THEN RAISE EXCEPTION 'changed replay: %', r; END IF;
 r := public.call_copilot_record_segment('@S1@', call_a, 0, 'k-other', 'caller', now()-interval '10 minutes'+interval '5 seconds', now()-interval '10 minutes'+interval '7 seconds', 'reused index', '{}');
 IF r->>'conflict_kind' <> 'index_reused' THEN RAISE EXCEPTION 'index reuse: %', r; END IF;
 BEGIN PERFORM public.call_copilot_seal_evidence('@S1@','@U1@', call_a, true, 1); RAISE EXCEPTION 'sealed evidence over a conflict';
 EXCEPTION WHEN SQLSTATE 'CC403' THEN NULL; END;
 IF (SELECT count(*) FROM public.call_copilot_transcript_segments WHERE call_id = call_a) <> 1 THEN RAISE EXCEPTION 'a conflicting segment was stored'; END IF;

 -- complete requires attestation AND every observable check
 PERFORM pg_temp.consent('@S1@','CAfull0001');
 SELECT id INTO call_a FROM public.call_copilot_calls WHERE provider_call_id='CAfull0001';
 PERFORM public.call_copilot_record_segment('@S1@', call_a, 0, 'f-0', 'caller', now()-interval '10 minutes'+interval '5 seconds', now()-interval '10 minutes'+interval '7 seconds', 'all of it', '{}');
 PERFORM pg_temp.ev('@S1@','CAfull0001','fe6',6,'call_ended',NULL,NULL,NULL,20);
 rev := public.call_copilot_seal_evidence('@S1@','@U1@', call_a, true, 1);
 IF rev->>'coverage_status' <> 'complete' THEN RAISE EXCEPTION 'attested, ended, contiguous and counted must be complete: %', rev; END IF;
 rev := public.call_copilot_seal_evidence('@S1@','@U1@', call_a, true, 2);
 IF rev->>'coverage_status' <> 'partial' OR NOT (rev->'coverage_reasons') @> '"segment_count_mismatch"' THEN RAISE EXCEPTION 'count mismatch must be partial: %', rev; END IF;
 -- a pause leaves a visible gap: partial for ever
 PERFORM pg_temp.consent('@S1@','CAgap00001');
 SELECT id INTO call_a FROM public.call_copilot_calls WHERE provider_call_id='CAgap00001';
 PERFORM public.call_copilot_record_segment('@S1@', call_a, 0, 'g-0', 'caller', now()-interval '10 minutes'+interval '5 seconds', now()-interval '10 minutes'+interval '7 seconds', 'before the pause', '{}');
 PERFORM pg_temp.ev('@S1@','CAgap00001','ge6',6,'capture_paused',NULL,NULL,NULL,10);
 BEGIN PERFORM public.call_copilot_record_segment('@S1@', call_a, 1, 'g-1', 'caller', now()-interval '10 minutes'+interval '11 seconds', now()-interval '10 minutes'+interval '12 seconds', 'inside the pause', '{}'); RAISE EXCEPTION 'text stored inside a pause gap';
 EXCEPTION WHEN SQLSTATE 'CC403' THEN NULL; END;
 BEGIN PERFORM public.call_copilot_record_segment('@S1@', call_a, 1, 'g-2', 'caller', now()-interval '10 minutes'+interval '8 seconds', now()-interval '10 minutes'+interval '12 seconds', 'straddles the pause', '{}'); RAISE EXCEPTION 'a span across the gap was stored';
 EXCEPTION WHEN SQLSTATE 'CC403' THEN NULL; END;
 PERFORM pg_temp.ev('@S1@','CAgap00001','ge7',7,'call_ended',NULL,NULL,NULL,30);
 rev := public.call_copilot_seal_evidence('@S1@','@U1@', call_a, true, 1);
 IF rev->>'coverage_status' <> 'partial' OR NOT (rev->'coverage_reasons') @> '"capture_gap"' THEN RAISE EXCEPTION 'a pause gap must keep coverage partial: %', rev; END IF;
 -- unknown provider outcome is never complete
 PERFORM pg_temp.consent('@S1@','CAunk00001');
 SELECT id INTO call_a FROM public.call_copilot_calls WHERE provider_call_id='CAunk00001';
 PERFORM public.call_copilot_record_segment('@S1@', call_a, 0, 'u-0', 'caller', now()-interval '10 minutes'+interval '5 seconds', now()-interval '10 minutes'+interval '7 seconds', 'unknown ending', '{}');
 PERFORM pg_temp.ev('@S1@','CAunk00001','ue6',6,'provider_outcome_unknown',NULL,NULL,NULL,20,'provider_timeout');
 rev := public.call_copilot_seal_evidence('@S1@','@U1@', call_a, true, 1);
 IF rev->>'coverage_status' <> 'partial' OR NOT (rev->'coverage_reasons') @> '"provider_outcome_unknown"' THEN RAISE EXCEPTION 'unknown outcome must be partial: %', rev; END IF;

 -- ------------------------------------------------------------------ shop delete cascades every new row
 DELETE FROM public.shops WHERE id = '@S1@';
 FOREACH x IN ARRAY ARRAY['call_copilot_transcript_segments','call_copilot_transcript_conflicts','call_copilot_evidence_revisions','call_copilot_extraction_runs','call_copilot_proposals','call_copilot_memory_submissions'] LOOP
  EXECUTE format('SELECT count(*) FROM public.%I WHERE shop_id = %L', x, '@S1@') INTO n;
  IF n <> 0 THEN RAISE EXCEPTION 'shop delete did not cascade %', x; END IF;
 END LOOP;
END $$;
""")


MUTATIONS = {
    'hook_removed': ("call_reason:=public.call_copilot_claim_recheck(p_shop,p_action,action.payload,p_context);", "call_reason:=NULL;"),
    'gate_removed_before_store': ("  PERFORM public.call_copilot_assert_span(p_shop, p_call, p_started_at, p_ended_at, 'extraction');\n", ""),
    'card_numbers_allowed': ("  IF public.call_copilot_has_card_number(p_text) THEN\n    RAISE EXCEPTION 'Payment-card data must be redacted before storage' USING ERRCODE = '22023';\n  END IF;\n", ""),
    'edit_allowed': ("IS DISTINCT FROM prop.staged_payload THEN\n    RETURN 'call_proposal_edited';", "IS DISTINCT FROM p_payload THEN\n    RETURN 'call_proposal_edited';"),
    'consent_ignored_at_approval': ("PERFORM public.call_copilot_assert_capture(p_shop, prop.call_id, 'crm_mutation', NULL);", "PERFORM 1;"),
    'evidence_change_ignored': ("IF NOT coalesce((cur ->> 'current')::boolean, false) THEN RETURN 'call_evidence_changed'; END IF;", ""),
    'automatic_claim_allowed': ("IF p_context IS DISTINCT FROM 'hitl' THEN RETURN 'call_human_approval_required'; END IF;", ""),
    'requester_revocation_ignored': ("IF NOT public.call_copilot_actor_ok(p_shop, prop.created_by) THEN RETURN 'call_requester_revoked'; END IF;", ""),
    'crm_change_ignored': ("IF now_binding IS DISTINCT FROM prop.crm_binding THEN RETURN 'call_crm_state_changed'; END IF;", ""),
    'open_call_called_complete': ("  IF NOT (st ->> 'call_ended')::boolean THEN reasons := array_append(reasons, 'call_not_ended'); END IF;\n", ""),
    'pause_gap_not_partial': ("  IF mid_gap THEN reasons := array_append(reasons, 'capture_gap'); END IF;\n", ""),
    'proposal_staged_as_approved': ("VALUES (v_cmd, p_shop, p_actor, v_atype::public.pending_action_type, v_payload);", "VALUES (v_cmd, p_shop, p_actor, v_atype::public.pending_action_type, v_payload); UPDATE public.pending_actions SET status = 'approved' WHERE id = v_cmd;"),
    'forged_citation_trusted': ("      IF NOT FOUND OR s < 0 OR e <= s OR e > length(seg.text) THEN\n        RAISE EXCEPTION 'Citation does not match the transcript' USING ERRCODE = '22023';\n      END IF;\n", ""),
    'conflict_not_fail_closed': ("ok := (st ->> 'derivation_permitted')::boolean AND tconf = 0 AND outside = 0;", "ok := (st ->> 'derivation_permitted')::boolean AND outside = 0;"),
    'memory_published_active': ("  INSERT INTO public.call_copilot_memory_submissions (proposal_id, shop_id, source_id, revision, submitted_by)", "  INSERT INTO public.reviewed_memory_active (shop_id, source_id, revision, activated_by) VALUES (p_shop, (res ->> 'source_id')::uuid, (res ->> 'revision')::integer, auth.uid());\n  INSERT INTO public.call_copilot_memory_submissions (proposal_id, shop_id, source_id, revision, submitted_by)"),
}
args = sys.argv[1:]
if args[:1] == ['--mutate']:
    names = list(MUTATIONS) if args[1:2] == ['all'] else args[1:2]
    for name in names:
        old, new = MUTATIONS[name]
        assert body.count(old) == 1, f'mutation {name} does not apply exactly once'
        broken = body.replace(old, new)
        try:
            run(f"BEGIN;\n{SEED}\n{broken}\n{CHECKS}\nROLLBACK;")
        except SystemExit as failure:
            print(f'mutation {name}: probe FAILED as required ({str(failure)[:110]})')
            continue
        raise SystemExit(f'FAIL: mutation {name} SURVIVED; the probe does not detect it')
    print('PASS: every requested mutation was detected')
    raise SystemExit(0)

out = run(f"BEGIN;\n{SEED}\n{body}\n{CHECKS}\nROLLBACK;")
assert run("SELECT to_regclass('public.call_copilot_proposals') IS NULL AND to_regclass('public.call_copilot_transcript_segments') IS NULL") == 't', 'probe leaked tables'
assert run("SELECT count(*) || ':' || max(version) FROM supabase_migrations.schema_migrations") == ledger_before, 'ledger changed'
assert run("SELECT count(*) FROM public.shops WHERE name LIKE 'Fictional %'") == '0', 'probe leaked rows'
assert run("SELECT count(*) FROM public.call_records WHERE vapi_call_id = 'legacy-call-1' AND summary = 'Legacy receptionist summary'") == '0', 'probe leaked call_records'
print('PASS: upgrade probe applied the real migration SQL on existing data, proved every existing table and the claim ACLs are unchanged, '
      'control_claim differs only by the recheck hook, ordinary claims behave identically, the gate runs before storage, coverage is truthful, '
      'proposals stage as approval-required pending actions and execute only through the existing claim after it re-verifies consent, evidence, '
      'payload, requester and CRM identity, memory enters the existing candidate lifecycle inert, and rolled back')
