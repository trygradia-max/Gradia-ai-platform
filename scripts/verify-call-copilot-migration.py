"""Non-destructive upgrade probe for 20261119130000_call_copilot_ingress.

Everything runs inside ONE transaction on the unlinked gradia-isolated-tests stack and ends with
ROLLBACK, so no database state is changed. Inside it the probe
  1. seeds fictional shops and LEGACY `call_records` rows (the receptionist call artifact),
     fingerprints that table (rows, columns, policies, grants, triggers, constraints),
  2. applies the migration's REAL SQL text (BEGIN/COMMIT removed so the outer transaction stays
     in control) and proves:
       * `call_records` is byte-for-byte unchanged and the existing receptionist upsert still works,
       * the three new tables are RLS-enabled with no browser-role or direct service-role write grant,
         and only the three entry-point functions are executable, and only by service_role,
       * the ledger is append-only (UPDATE/DELETE/TRUNCATE refused) yet a shop delete cascades,
       * an exact replay is a duplicate, a changed replay is a conflict and fails the call closed,
         a reused sequence is a conflict, another shop cannot adopt a call id,
       * consent is never manufactured by reordering, a decline/pause/stop denies capture and
         preserves an explicit gap, and the gate raises CC403 for every denied purpose,
       * structurally invalid events (content-shaped columns, wrong party) are refused,
  3. rolls back, then confirms the ledger and schema are exactly as before.
No credential-bearing output is printed.
"""
from pathlib import Path
import re
import subprocess

root = Path(__file__).resolve().parent.parent
project = 'gradia-isolated-tests'
config = root / 'tests/supabase/config.toml'
assert f'project_id = "{project}"' in config.read_text() and 'env(' not in config.read_text()
assert not (root / '.local-tools/supabase-test/supabase/.temp/project-ref').exists(), 'remote links forbidden'

NEW = '20261119130000'
migration = next((root / 'supabase/migrations').glob(f'{NEW}_*.sql'))
text = migration.read_text().strip()
assert text.startswith('BEGIN;') and text.endswith('COMMIT;'), 'migration must be one BEGIN..COMMIT block'
body = text[len('BEGIN;'):-len('COMMIT;')]
stripped = re.sub(r'\$\$.*?\$\$', '$$$$', body, flags=re.S)
assert not re.search(r'(?im)^\s*(commit|rollback|begin|start\s+transaction|savepoint|release|abort|end)\b', stripped), 'unexpected transaction control'
versions = sorted(p.name.split('_')[0] for p in (root / 'supabase/migrations').glob('*.sql'))
assert versions[-1] == NEW, 'probe expects this to be the newest migration'


def run(sql):
    r = subprocess.run(['docker', 'exec', '-i', f'supabase_db_{project}', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'],
                       input=sql, text=True, capture_output=True)
    if r.returncode:
        errors = [l for l in r.stderr.splitlines() if 'ERROR:' in l]
        detail = errors[0].split('ERROR:', 1)[1].strip()[:300] if errors else 'no detail'
        raise SystemExit(f'FAIL: probe failed ({detail}); rolled back; raw output withheld')
    return r.stdout.strip()


stack_max = run("SELECT max(version) FROM supabase_migrations.schema_migrations")
applied = run("SELECT to_regclass('public.call_copilot_events') IS NOT NULL") == 't'
ledger_before = run("SELECT count(*) || ':' || max(version) FROM supabase_migrations.schema_migrations")
assert not applied, 'migration already applied on the stack; the upgrade probe needs the pre-migration schema'
assert stack_max < NEW, f'stack already holds a migration at or after {NEW}: {stack_max}'

U = lambda n: f'00000000-0000-4000-8000-0000000a{n:04d}'
S = lambda n: f'00000000-0000-4000-8000-0000000b{n:04d}'

FP = """
SELECT 'rows' AS k, md5(coalesce(string_agg(t::text, ',' ORDER BY t.id), '')) AS v FROM public.call_records t
UNION ALL SELECT 'columns', md5(string_agg(column_name||':'||data_type||':'||is_nullable, ',' ORDER BY ordinal_position)) FROM information_schema.columns WHERE table_schema='public' AND table_name='call_records'
UNION ALL SELECT 'policies', md5(coalesce(string_agg(polname||':'||polcmd::text||':'||coalesce(pg_get_expr(polqual,polrelid),'')||':'||coalesce(pg_get_expr(polwithcheck,polrelid),''), ',' ORDER BY polname), '')) FROM pg_policy WHERE polrelid='public.call_records'::regclass
UNION ALL SELECT 'grants', md5(coalesce(string_agg(grantee||':'||privilege_type, ',' ORDER BY grantee, privilege_type), '')) FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='call_records'
UNION ALL SELECT 'triggers', md5(coalesce(string_agg(tgname, ',' ORDER BY tgname), '')) FROM pg_trigger WHERE tgrelid='public.call_records'::regclass AND NOT tgisinternal
UNION ALL SELECT 'constraints', md5(coalesce(string_agg(conname||':'||pg_get_constraintdef(oid), ',' ORDER BY conname), '')) FROM pg_constraint WHERE conrelid='public.call_records'::regclass
"""

SEED = f"""
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES ('{U(1)}','o1@example.test',now()),('{U(2)}','o2@example.test',now());
INSERT INTO public.shops(id,owner_id,name) VALUES ('{S(1)}','{U(1)}','Fictional A'),('{S(2)}','{U(2)}','Fictional B');
INSERT INTO public.call_records(shop_id,vapi_call_id,summary,ended_reason,duration_seconds,started_at,ended_at) VALUES
 ('{S(1)}','legacy-call-1','Legacy receptionist summary','customer-ended-call',61,now()-interval '1 hour',now()-interval '59 minutes'),
 ('{S(1)}','legacy-call-2',NULL,NULL,NULL,NULL,NULL),
 ('{S(2)}','legacy-call-1','Other shop, same vendor id','assistant-ended-call',12,NULL,NULL);
CREATE TEMP TABLE fp_before AS {FP};
"""

# Helper: ev(shop, call, event, seq, kind, party, version, respond_to, secs_from_base, reason)
HELPER = """
CREATE FUNCTION pg_temp.ev(p_shop uuid, p_call text, p_event text, p_seq int, p_kind text,
  p_party text DEFAULT NULL, p_ver text DEFAULT NULL, p_resp int DEFAULT NULL, p_secs int DEFAULT 0,
  p_reason text DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.call_copilot_record_event(p_shop, 'twilio', p_call, p_event, p_seq, p_kind, p_party, p_ver, p_resp,
    CASE WHEN p_kind='call_opened' THEN 'gradia_controlled_number' END, NULL, NULL, p_reason,
    now() - interval '10 minutes' + make_interval(secs => p_secs))
$$;
CREATE FUNCTION pg_temp.st(p_shop uuid, p_call text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.call_copilot_capture_state(p_shop, (SELECT id FROM public.call_copilot_calls WHERE provider_call_id = p_call))
$$;
"""

CHECKS = f"""
DO $$
DECLARE n integer; code text; r jsonb; s jsonb; cid uuid; x text;
BEGIN
 -- receptionist artifact untouched; the existing upsert still works
 IF (SELECT count(*) FROM fp_before) <> 6 THEN RAISE EXCEPTION 'fingerprint missing'; END IF;
 SELECT string_agg(f.k, ',') INTO x FROM fp_before f JOIN ({FP}) c USING (k) WHERE f.v <> c.v;
 IF x IS NOT NULL THEN RAISE EXCEPTION 'call_records drifted: %', x; END IF;
 INSERT INTO public.call_records(shop_id,vapi_call_id,summary) VALUES ('{S(1)}','legacy-call-1','updated')
   ON CONFLICT (shop_id,vapi_call_id) DO UPDATE SET summary = EXCLUDED.summary;
 SELECT count(*) INTO n FROM public.call_records WHERE shop_id='{S(1)}' AND summary='updated';
 IF n <> 1 THEN RAISE EXCEPTION 'receptionist upsert broke'; END IF;

 -- RLS and privileges
 FOR x IN SELECT unnest(ARRAY['call_copilot_calls','call_copilot_events','call_copilot_conflicts']) LOOP
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.'||x)::regclass) THEN RAISE EXCEPTION 'RLS disabled on %', x; END IF;
  IF has_table_privilege('anon', 'public.'||x, 'SELECT') OR has_table_privilege('authenticated', 'public.'||x, 'SELECT')
     OR has_table_privilege('authenticated', 'public.'||x, 'INSERT') THEN RAISE EXCEPTION 'browser role can reach %', x; END IF;
  IF NOT has_table_privilege('service_role', 'public.'||x, 'SELECT') THEN RAISE EXCEPTION 'service_role cannot read %', x; END IF;
  IF has_table_privilege('service_role', 'public.'||x, 'INSERT') OR has_table_privilege('service_role', 'public.'||x, 'UPDATE')
     OR has_table_privilege('service_role', 'public.'||x, 'DELETE') OR has_table_privilege('service_role', 'public.'||x, 'TRUNCATE') THEN
    RAISE EXCEPTION 'service_role can write % directly', x; END IF;
 END LOOP;
 IF NOT has_function_privilege('service_role', 'public.call_copilot_record_event(uuid,text,text,text,integer,text,text,text,integer,text,text,text,text,timestamptz)', 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.call_copilot_capture_state(uuid,uuid)', 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.call_copilot_assert_capture(uuid,uuid,text,timestamptz)', 'EXECUTE') THEN
   RAISE EXCEPTION 'service_role lost an entry point'; END IF;
 IF has_function_privilege('anon', 'public.call_copilot_record_event(uuid,text,text,text,integer,text,text,text,integer,text,text,text,text,timestamptz)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.call_copilot_record_event(uuid,text,text,text,integer,text,text,text,integer,text,text,text,text,timestamptz)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.call_copilot_assert_capture(uuid,uuid,text,timestamptz)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.call_copilot_capture_state(uuid,uuid)', 'EXECUTE')
    OR has_function_privilege('service_role', 'public.call_copilot_close_interval(jsonb,integer,timestamptz,text)', 'EXECUTE')
    OR has_function_privilege('service_role', 'public.call_copilot_event_digest(text,integer,text,text,text,integer,text,text,text,text,timestamptz)', 'EXECUTE') THEN
   RAISE EXCEPTION 'function ACL too broad'; END IF;

 -- consenting call: both parties disclosed and granted -> capture active, one open interval
 r := pg_temp.ev('{S(1)}','CAcall0001','e1',1,'call_opened');
 IF r->>'outcome' <> 'recorded' OR r->>'status' <> 'awaiting_consent' THEN RAISE EXCEPTION 'open: %', r; END IF;
 PERFORM pg_temp.ev('{S(1)}','CAcall0001','e2',2,'disclosure_delivered','operator','v1',NULL,1);
 PERFORM pg_temp.ev('{S(1)}','CAcall0001','e3',3,'disclosure_delivered','caller','v1',NULL,2);
 r := pg_temp.ev('{S(1)}','CAcall0001','e4',4,'consent_granted','operator','v1',2,3);
 IF (r->>'capture_permitted_now')::boolean THEN RAISE EXCEPTION 'one consent must not enable capture'; END IF;
 r := pg_temp.ev('{S(1)}','CAcall0001','e5',5,'consent_granted','caller','v1',3,4);
 IF NOT (r->>'capture_permitted_now')::boolean OR r->>'status' <> 'active' THEN RAISE EXCEPTION 'both consents: %', r; END IF;

 -- exact replay is a duplicate; changed replay is a conflict and fails the call closed
 r := pg_temp.ev('{S(1)}','CAcall0001','e5',5,'consent_granted','caller','v1',3,4);
 IF r->>'outcome' <> 'duplicate' THEN RAISE EXCEPTION 'replay: %', r; END IF;
 r := pg_temp.ev('{S(1)}','CAcall0001','e5',5,'consent_granted','caller','v1',3,9);
 IF r->>'outcome' <> 'conflict' THEN RAISE EXCEPTION 'changed replay: %', r; END IF;
 s := pg_temp.st('{S(1)}','CAcall0001');
 IF s->>'status' <> 'uncertain' OR s->>'reason' <> 'conflicting_replay' OR (s->>'capture_permitted_now')::boolean THEN RAISE EXCEPTION 'conflict must fail closed: %', s; END IF;
 SELECT count(*) INTO n FROM public.call_copilot_events WHERE call_id = (SELECT id FROM public.call_copilot_calls WHERE provider_call_id='CAcall0001');
 IF n <> 5 THEN RAISE EXCEPTION 'a conflicting event was stored'; END IF;
 r := pg_temp.ev('{S(1)}','CAcall0001','e9',5,'consent_declined','caller','v1',3,5);
 IF r->>'conflict_kind' <> 'sequence_reused' THEN RAISE EXCEPTION 'sequence reuse: %', r; END IF;

 -- another shop cannot adopt the call id and writes nothing
 r := pg_temp.ev('{S(2)}','CAcall0001','x1',1,'call_opened');
 IF r->>'outcome' <> 'foreign_call' THEN RAISE EXCEPTION 'foreign call: %', r; END IF;
 IF EXISTS (SELECT 1 FROM public.call_copilot_events WHERE shop_id = '{S(2)}') THEN RAISE EXCEPTION 'foreign write happened'; END IF;
 BEGIN
  INSERT INTO public.call_copilot_events(shop_id,call_id,sequence,provider_event_id,kind,route_kind,occurred_at,payload_digest)
   VALUES ('{S(2)}',(SELECT id FROM public.call_copilot_calls WHERE provider_call_id='CAcall0001'),1,'z','call_opened','gradia_controlled_number',now(),repeat('a',64));
  RAISE EXCEPTION 'cross-shop event row was accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;

 -- reordering cannot manufacture consent: seq 5 (caller granted) first, then the rest out of order
 r := pg_temp.ev('{S(1)}','CAcall0002','o5',5,'consent_granted','caller','v1',3,4);
 IF (r->>'capture_permitted_now')::boolean THEN RAISE EXCEPTION 'orphan consent enabled capture'; END IF;
 PERFORM pg_temp.ev('{S(1)}','CAcall0002','o4',4,'consent_granted','operator','v1',2,3);
 PERFORM pg_temp.ev('{S(1)}','CAcall0002','o3',3,'disclosure_delivered','caller','v1',NULL,2);
 s := pg_temp.st('{S(1)}','CAcall0002');
 IF (s->>'capture_permitted_now')::boolean OR s->>'reason' <> 'sequence_gap' THEN RAISE EXCEPTION 'gap must deny: %', s; END IF;
 PERFORM pg_temp.ev('{S(1)}','CAcall0002','o2',2,'disclosure_delivered','operator','v1',NULL,1);
 s := pg_temp.st('{S(1)}','CAcall0002');
 IF (s->>'capture_permitted_now')::boolean THEN RAISE EXCEPTION 'call_opened still missing must deny: %', s; END IF;
 PERFORM pg_temp.ev('{S(1)}','CAcall0002','o1',1,'call_opened');
 s := pg_temp.st('{S(1)}','CAcall0002');
 IF NOT (s->>'capture_permitted_now')::boolean THEN RAISE EXCEPTION 'complete in-order set must permit: %', s; END IF;

 -- a decline that arrives LAST still wins over an earlier-sequence-looking grant ordering
 PERFORM pg_temp.ev('{S(1)}','CAcall0003','d1',1,'call_opened');
 PERFORM pg_temp.ev('{S(1)}','CAcall0003','d2',2,'disclosure_delivered','operator','v1',NULL,1);
 PERFORM pg_temp.ev('{S(1)}','CAcall0003','d3',3,'disclosure_delivered','caller','v1',NULL,2);
 PERFORM pg_temp.ev('{S(1)}','CAcall0003','d5',5,'consent_granted','caller','v1',3,4);
 PERFORM pg_temp.ev('{S(1)}','CAcall0003','d4',4,'consent_declined','operator','v1',2,3);
 s := pg_temp.st('{S(1)}','CAcall0003');
 IF s->>'status' <> 'declined' OR (s->>'capture_permitted_now')::boolean OR (s->>'derivation_permitted')::boolean THEN RAISE EXCEPTION 'decline: %', s; END IF;

 -- pause records an explicit gap and voids consent; resume needs fresh consent
 cid := (SELECT id FROM public.call_copilot_calls WHERE provider_call_id='CAcall0001');
 PERFORM pg_temp.ev('{S(1)}','CAcall0004','p1',1,'call_opened');
 PERFORM pg_temp.ev('{S(1)}','CAcall0004','p2',2,'disclosure_delivered','operator','v1',NULL,1);
 PERFORM pg_temp.ev('{S(1)}','CAcall0004','p3',3,'disclosure_delivered','caller','v1',NULL,1);
 PERFORM pg_temp.ev('{S(1)}','CAcall0004','p4',4,'consent_granted','operator','v1',2,2);
 PERFORM pg_temp.ev('{S(1)}','CAcall0004','p5',5,'consent_granted','caller','v1',3,3);
 PERFORM pg_temp.ev('{S(1)}','CAcall0004','p6',6,'capture_paused',NULL,NULL,NULL,10);
 PERFORM pg_temp.ev('{S(1)}','CAcall0004','p7',7,'capture_resumed',NULL,NULL,NULL,20);
 s := pg_temp.st('{S(1)}','CAcall0004');
 IF s->>'status' <> 'paused' OR (s->>'capture_permitted_now')::boolean THEN RAISE EXCEPTION 'resume without consent must stay paused: %', s; END IF;
 PERFORM pg_temp.ev('{S(1)}','CAcall0004','p8',8,'disclosure_delivered','operator','v1',NULL,21);
 PERFORM pg_temp.ev('{S(1)}','CAcall0004','p9',9,'disclosure_delivered','caller','v1',NULL,22);
 PERFORM pg_temp.ev('{S(1)}','CAcall0004','p10',10,'consent_granted','operator','v1',8,23);
 PERFORM pg_temp.ev('{S(1)}','CAcall0004','p11',11,'consent_granted','caller','v1',9,24);
 PERFORM pg_temp.ev('{S(1)}','CAcall0004','p12',12,'capture_resumed',NULL,NULL,NULL,25);
 s := pg_temp.st('{S(1)}','CAcall0004');
 IF s->>'status' <> 'active' OR jsonb_array_length(s->'intervals') <> 2 THEN RAISE EXCEPTION 'resume: %', s; END IF;
 IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'gaps') g WHERE g->>'reason' = 'paused' AND g->>'ended_at' IS NOT NULL) THEN RAISE EXCEPTION 'pause gap missing: %', s; END IF;

 -- the gate: denied for every purpose when not consented, allowed when consented, never inside a gap
 FOREACH x IN ARRAY ARRAY['recording','transcription','model_use','summarization','extraction','crm_mutation'] LOOP
  BEGIN
   PERFORM public.call_copilot_assert_capture('{S(1)}', (SELECT id FROM public.call_copilot_calls WHERE provider_call_id='CAcall0003'), x);
   RAISE EXCEPTION 'gate allowed % on a declined call', x;
  EXCEPTION WHEN SQLSTATE 'CC403' THEN NULL; END;
 END LOOP;
 PERFORM public.call_copilot_assert_capture('{S(1)}', (SELECT id FROM public.call_copilot_calls WHERE provider_call_id='CAcall0004'), 'recording');
 BEGIN
  PERFORM public.call_copilot_assert_capture('{S(1)}', (SELECT id FROM public.call_copilot_calls WHERE provider_call_id='CAcall0004'), 'extraction', now() - interval '10 minutes' + interval '15 seconds');
  RAISE EXCEPTION 'gate allowed a moment inside the pause gap';
 EXCEPTION WHEN SQLSTATE 'CC403' THEN NULL; END;
 BEGIN
  PERFORM public.call_copilot_assert_capture('{S(1)}', (SELECT id FROM public.call_copilot_calls WHERE provider_call_id='CAcall0004'), 'unknown_purpose');
  RAISE EXCEPTION 'unknown purpose accepted';
 EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
 BEGIN
  PERFORM public.call_copilot_assert_capture('{S(2)}', (SELECT id FROM public.call_copilot_calls WHERE provider_call_id='CAcall0004'), 'recording');
  RAISE EXCEPTION 'cross-shop gate allowed';
 EXCEPTION WHEN SQLSTATE 'CC403' THEN NULL; END;

 -- invalid shapes are refused and leave no call row behind
 BEGIN
  PERFORM public.call_copilot_record_event('{S(1)}','twilio','CAcall0099','i1',2,'consent_granted','operator','v1',NULL,NULL,NULL,NULL,NULL,now());
  RAISE EXCEPTION 'consent without a reference was accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  PERFORM public.call_copilot_record_event('{S(1)}','twilio','CAcall0099','i2',2,'disclosure_delivered','someone','v1',NULL,NULL,NULL,NULL,NULL,now());
  RAISE EXCEPTION 'unknown party was accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  PERFORM public.call_copilot_record_event('{S(1)}','twilio','CAcall0099','i3',1,'call_opened',NULL,NULL,NULL,'gradia_controlled_number',NULL,NULL,NULL,now() + interval '1 day');
  RAISE EXCEPTION 'future time was accepted';
 EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
 IF EXISTS (SELECT 1 FROM public.call_copilot_calls WHERE provider_call_id='CAcall0099') THEN RAISE EXCEPTION 'invalid event left a call row'; END IF;

 -- append-only
 BEGIN UPDATE public.call_copilot_events SET reason = 'edited_reason'; RAISE EXCEPTION 'update accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN DELETE FROM public.call_copilot_events WHERE shop_id = '{S(1)}'; RAISE EXCEPTION 'delete accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN TRUNCATE public.call_copilot_events CASCADE; RAISE EXCEPTION 'truncate accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE public.call_copilot_calls SET provider_call_id = 'CAhijack01'; RAISE EXCEPTION 'call update accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;

 -- shop delete still cascades the evidence away
 DELETE FROM public.shops WHERE id = '{S(1)}';
 SELECT count(*) INTO n FROM public.call_copilot_events WHERE shop_id = '{S(1)}';
 IF n <> 0 THEN RAISE EXCEPTION 'shop delete did not cascade events'; END IF;
 SELECT count(*) INTO n FROM public.call_copilot_calls WHERE shop_id = '{S(1)}';
 IF n <> 0 THEN RAISE EXCEPTION 'shop delete did not cascade calls'; END IF;
END $$;
"""

out = run(f"BEGIN;\n{SEED}\n{body}\n{HELPER}\n{CHECKS}\nROLLBACK;")
assert run("SELECT to_regclass('public.call_copilot_events') IS NULL AND to_regclass('public.call_copilot_calls') IS NULL") == 't', 'probe leaked tables'
assert run("SELECT count(*) || ':' || max(version) FROM supabase_migrations.schema_migrations") == ledger_before, 'ledger changed'
assert run("SELECT count(*) FROM public.shops WHERE name LIKE 'Fictional %'") == '0', 'probe leaked rows'
assert run("SELECT count(*) FROM public.call_records WHERE vapi_call_id LIKE 'legacy-call-%'") == '0', 'probe leaked call_records'
print('PASS: upgrade probe applied the real migration SQL, proved call_records is untouched, append-only evidence, replay/conflict/tenant/consent/gap/gate behaviour and ACLs, and rolled back')
