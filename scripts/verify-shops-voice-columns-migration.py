"""Non-destructive upgrade probe for 20261115120000_shops_voice_columns_guard.

Everything runs inside ONE transaction on an unlinked disposable stack and ends with ROLLBACK, so
no database state is ever changed or destroyed. Inside it the probe
  1. puts back the guard function exactly as the previous migration (20261110130000) defined it
     (the new migration only REPLACES that one function body; no object is added or dropped),
  2. seeds fictional LEGACY shops: one holding a real voice identity, one already carrying
     forged-looking values from before the fix (voice_live = true with no assistant), one plain,
  3. PROVES THE EXPLOIT ON THE OLD SCHEMA: as `authenticated`, the owner can write every one of the
     five voice columns on UPDATE and INSERT,
  4. applies the migration's REAL SQL text (BEGIN/COMMIT removed so the outer transaction stays in
     control) and proves:
       * no existing shops row was rewritten (content, xmin, physical position) and the table's
         columns, policies, grants and trigger set are identical to before,
       * the function is still SECURITY INVOKER with a pinned search_path and no EXECUTE for any
         role, and the one trigger is still an enabled BEFORE INSERT OR UPDATE row trigger,
       * as authenticated: each of the five voice columns is refused on UPDATE (change, clear, from
         default; voice_live in BOTH directions) and on INSERT (non-default), with SQLSTATE 42501,
         DETAIL server_written and HINT = the column; every column the previous migration protected
         is still refused; vapi_stale still only true -> false; safe owner edits and a
         defaults-only INSERT still work; a shop already holding forged values keeps them but its
         owner cannot change them (no silent repair, no lockout of safe edits),
       * service_role, a SECURITY DEFINER function and postgres still write every voice column,
       * cross-tenant and anon writes reach nothing,
  5. rolls everything back, then confirms the migration is still applied exactly as before.
No credential-bearing output is printed. The literal `supabase db reset --version` path is NOT used.

Usage: python3 scripts/verify-shops-voice-columns-migration.py
Stack: GRADIA_VERIFY_PROJECT (default gradia-isolated-tests; also accepts gradia-voice-columns).
"""
from pathlib import Path
import os
import re
import subprocess

root = Path(__file__).resolve().parent.parent
project = os.environ.get('GRADIA_VERIFY_PROJECT', 'gradia-isolated-tests')
CONFIGS = {
    'gradia-isolated-tests': (root / 'tests/supabase/config.toml', root / '.local-tools/supabase-test/supabase/.temp/project-ref'),
    'gradia-voice-columns': (root / '.local-tools/voice-columns/supabase/config.toml', root / '.local-tools/voice-columns/supabase/.temp/project-ref'),
}
assert project in CONFIGS, 'unknown disposable project'
config, link = CONFIGS[project]
assert f'project_id = "{project}"' in config.read_text() and 'env(' not in config.read_text()
assert not link.exists(), 'remote links forbidden'

NEW = '20261115120000'
PREV = '20261110130000'
migration = next((root / 'supabase/migrations').glob(f'{NEW}_*.sql'))
text = migration.read_text().strip()
assert text.startswith('BEGIN;') and text.endswith('COMMIT;'), 'migration must be one BEGIN..COMMIT block'
body = text[len('BEGIN;'):-len('COMMIT;')]
prev_text = next((root / 'supabase/migrations').glob(f'{PREV}_*.sql')).read_text()
old_fn = re.search(r'CREATE FUNCTION public\.shops_protected_columns_guard.*?END \$\$;', prev_text, re.S).group(0)
old_fn = old_fn.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION', 1)


def top_level(sql):
    """SQL with dollar-quoted bodies removed: PL/pgSQL BEGIN/END blocks are not transaction control."""
    assert re.search(r'\$[A-Za-z_]\w*\$', sql) is None, 'named dollar quotes are not handled'
    return re.sub(r'\$\$.*?\$\$', '$$$$', sql, flags=re.S)


TXN_CONTROL = re.compile(r'(?im)^\s*(commit|rollback|begin|start\s+transaction|savepoint|release|abort|end)\b')
assert not TXN_CONTROL.search(top_level(body)), 'unexpected transaction control inside the migration'
versions = sorted(p.name.split('_')[0] for p in (root / 'supabase/migrations').glob('*.sql'))


def run(sql):
    result = subprocess.run(
        ['docker', 'exec', '-i', f'supabase_db_{project}', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'],
        input=sql, text=True, capture_output=True)
    if result.returncode:
        errors = [line for line in result.stderr.splitlines() if 'ERROR:' in line]
        detail = errors[0].split('ERROR:', 1)[1].strip()[:240] if errors else 'no detail'
        raise SystemExit(f'FAIL: probe failed ({detail}); the transaction was rolled back; raw output withheld')
    return result.stdout.strip()


def U(n):
    return f'00000000-0000-4000-8000-0000000a{n:04d}'


def S(n):
    return f'00000000-0000-4000-8000-0000000b{n:04d}'


assert run("SELECT max(version) FROM supabase_migrations.schema_migrations") == versions[-1], 'stack must be at the latest migration'
assert NEW in versions
ledger_before = run("SELECT count(*) || ':' || max(version) FROM supabase_migrations.schema_migrations")

VOICE = ['vapi_assistant_id', 'vapi_phone_number_id', 'voice_live', 'voice_test_called_at', 'vapi_server_secret_enc']
# (column, a different non-null value, SQL that clears it or None when not clearable)
VOICE_UPDATES = [
    ('vapi_assistant_id', "'asst_forged'", 'NULL'),
    ('vapi_phone_number_id', "'pn_forged'", 'NULL'),
    ('voice_live', 'false', None),
    ('voice_test_called_at', "now() + interval '1 day'", 'NULL'),
    ('vapi_server_secret_enc', "'enc:forged'", 'NULL'),
]
# Columns the PREVIOUS migration already protected: must still be refused.
PREVIOUS = [
    ('plan', "'past_due'"), ('voice_addon', 'true'), ('voice_addon_ended_at', 'now()'), ('stripe_subscription_id', "'sub_forged'"),
    ('credit_period_start', "now() + interval '30 days'"), ('stripe_account_id', "'acct_forged'"), ('stripe_charges_enabled', 'true'),
    ('voice_minutes_budget', '300'), ('gradia_number_e164', "'+15550099999'"), ('gradia_number_sid', "'PNforged'"),
    ('twilio_subaccount_sid', "'ACFORGED'"), ('twilio_subaccount_token_enc', "'enc:forged'"),
    ('number_purchase_claim', "'00000000-0000-4000-8000-0000000c0099'"), ('number_purchase_claimed_at', 'now()'),
]
VOICE_INSERTS = [
    ('vapi_assistant_id', "'asst_born'"), ('vapi_phone_number_id', "'pn_born'"), ('voice_live', 'true'),
    ('voice_test_called_at', 'now()'), ('vapi_server_secret_enc', "'enc:born'"),
]

RESTORE_OLD = old_fn + """
DO $$ BEGIN
 IF position('vapi_assistant_id' in pg_get_functiondef('public.shops_protected_columns_guard'::regproc)) <> 0
 THEN RAISE EXCEPTION 'Pre-migration guard was not restored'; END IF;
END $$;
"""

SEED = f"""
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES
 ('{U(1)}','real-voice@example.test',now()),('{U(2)}','plain@example.test',now()),('{U(3)}','insert@example.test',now()),
 ('{U(4)}','legacy-forged@example.test',now()),('{U(5)}','preexploit@example.test',now());
-- Legacy shop 1: a real, server-written voice identity and a live receptionist.
INSERT INTO public.shops(id,owner_id,name,plan,voice_addon,vapi_assistant_id,vapi_phone_number_id,voice_live,voice_test_called_at,vapi_server_secret_enc,gradia_number_e164) VALUES
 ('{S(1)}','{U(1)}','Fictional voice shop','active',true,'asst_legacy_1','pn_legacy_1',true,now() - interval '3 days','enc:legacy1','+15550010001');
-- Legacy shop 2: plain defaults.
INSERT INTO public.shops(id,owner_id,name) VALUES ('{S(2)}','{U(2)}','Fictional plain shop');
-- Legacy shop 4: already carries a forged-looking launch state from BEFORE the fix. The migration must
-- neither rewrite it (no silent repair) nor lock its owner out of safe edits.
INSERT INTO public.shops(id,owner_id,name,voice_live) VALUES ('{S(4)}','{U(4)}','Fictional pre-fix forged shop',true);

CREATE TEMP TABLE legacy_fp AS
 SELECT id::text AS pk, to_jsonb(t)::text AS content, t.xmin::text AS x, t.ctid::text AS p FROM public.shops t;
CREATE TEMP TABLE schema_fp AS
 SELECT 'columns' AS k, md5(string_agg(column_name||':'||data_type||':'||coalesce(column_default,'')||':'||is_nullable, ',' ORDER BY ordinal_position)) AS v
   FROM information_schema.columns WHERE table_schema='public' AND table_name='shops'
 UNION ALL SELECT 'policies', md5(coalesce(string_agg(polname||':'||polcmd::text||':'||coalesce(pg_get_expr(polqual,polrelid),'')||':'||coalesce(pg_get_expr(polwithcheck,polrelid),''), ',' ORDER BY polname),''))
   FROM pg_policy WHERE polrelid='public.shops'::regclass
 UNION ALL SELECT 'grants', md5(coalesce(string_agg(grantee||':'||privilege_type, ',' ORDER BY grantee, privilege_type),''))
   FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='shops'
 UNION ALL SELECT 'triggers', md5(coalesce(string_agg(tgname||':'||tgtype::text||':'||tgenabled::text, ',' ORDER BY tgname),'')) FROM pg_trigger WHERE tgrelid='public.shops'::regclass AND NOT tgisinternal;
GRANT SELECT ON legacy_fp, schema_fp TO PUBLIC;
"""


def as_role(role, uid):
    claims = '{"sub":"%s","role":"%s"}' % (uid, role) if uid else '{"role":"%s"}' % role
    return f"PERFORM set_config('request.jwt.claims', '{claims}', true); EXECUTE 'SET LOCAL ROLE {role}';"


def refused(label, role, uid, stmt, hint):
    return f"""
 BEGIN
  {as_role(role, uid)}
  {stmt};
  EXECUTE 'RESET ROLE';
  RAISE EXCEPTION 'NOT REFUSED: {label}';
 EXCEPTION WHEN insufficient_privilege THEN
  EXECUTE 'RESET ROLE';
  GET STACKED DIAGNOSTICS d = PG_EXCEPTION_DETAIL, h = PG_EXCEPTION_HINT;
  IF d IS DISTINCT FROM 'server_written' OR h IS DISTINCT FROM '{hint}' THEN RAISE EXCEPTION 'WRONG REFUSAL for {label}: detail=% hint=%', d, h; END IF;
 END;"""


def allowed(label, role, uid, stmt):
    return f"""
 BEGIN
  {as_role(role, uid)}
  {stmt};
  EXECUTE 'RESET ROLE';
 EXCEPTION WHEN OTHERS THEN
  EXECUTE 'RESET ROLE';
  RAISE EXCEPTION 'REFUSED BUT SHOULD BE ALLOWED: {label}: %', SQLERRM;
 END;"""


def block(*parts):
    return "DO $$\nDECLARE d text; h text; n integer;\nBEGIN" + "".join(parts) + "\nEND $$;\n"


# ---- 3. the exploit on the OLD guard -------------------------------------------------------------
EXPLOIT_OLD = block(
    *[allowed(f'OLD guard: owner writes {col}', 'authenticated', U(5),
              f"UPDATE public.shops SET {col} = {val} WHERE id = '{S(5)}'") for col, val in
      [('vapi_assistant_id', "'asst_x'"), ('vapi_phone_number_id', "'pn_x'"), ('voice_live', 'true'),
       ('voice_test_called_at', 'now()'), ('vapi_server_secret_enc', "'enc:x'")]],
    f"""
 IF (SELECT concat(vapi_assistant_id,vapi_phone_number_id,voice_live,vapi_server_secret_enc) FROM public.shops WHERE id='{S(5)}') <> 'asst_xpn_xtenc:x' THEN
  RAISE EXCEPTION 'the exploit did not reproduce on the old guard'; END IF;""",
    allowed('OLD guard: owner INSERTs a shop born live with a provider identity', 'authenticated', U(5),
            "INSERT INTO public.shops(id,owner_id,name,voice_live,vapi_assistant_id,vapi_phone_number_id,voice_test_called_at) "
            f"VALUES ('00000000-0000-4000-8000-0000000b0006','{U(5)}','Born live','true'::boolean,'asst_born','pn_born',now())"),
    f"""
 IF NOT (SELECT voice_live FROM public.shops WHERE id='00000000-0000-4000-8000-0000000b0006') THEN RAISE EXCEPTION 'born-live exploit did not reproduce'; END IF;""",
)
CLEAN_EXPLOIT = f"DELETE FROM public.shops WHERE id IN ('{S(5)}','00000000-0000-4000-8000-0000000b0006');\n"
# Shop 5 was inserted by the owner JWT in step 3; it must exist first.
SEED5 = f"INSERT INTO public.shops(id,owner_id,name) VALUES ('{S(5)}','{U(5)}','Fictional exploit shop');\n"

UNCHANGED = """
DO $$
DECLARE changed integer; missing integer; before_n integer; after_n integer;
BEGIN
 SELECT count(*) INTO changed FROM legacy_fp f JOIN (
   SELECT id::text pk, to_jsonb(t)::text content, t.xmin::text x, t.ctid::text p FROM public.shops t) c USING (pk)
  WHERE f.content <> c.content OR f.x <> c.x OR f.p <> c.p;
 IF changed <> 0 THEN RAISE EXCEPTION '% legacy shops rows were rewritten by the upgrade', changed; END IF;
 SELECT count(*) INTO missing FROM legacy_fp f WHERE NOT EXISTS (SELECT 1 FROM public.shops s WHERE s.id::text = f.pk);
 IF missing <> 0 THEN RAISE EXCEPTION '% legacy shops rows disappeared', missing; END IF;
 SELECT count(*) INTO before_n FROM legacy_fp; SELECT count(*) INTO after_n FROM public.shops;
 IF before_n <> after_n THEN RAISE EXCEPTION 'shops row count changed'; END IF;
 IF EXISTS (
   SELECT 1 FROM schema_fp f JOIN (
     SELECT 'columns' k, md5(string_agg(column_name||':'||data_type||':'||coalesce(column_default,'')||':'||is_nullable, ',' ORDER BY ordinal_position)) v
       FROM information_schema.columns WHERE table_schema='public' AND table_name='shops'
     UNION ALL SELECT 'policies', md5(coalesce(string_agg(polname||':'||polcmd::text||':'||coalesce(pg_get_expr(polqual,polrelid),'')||':'||coalesce(pg_get_expr(polwithcheck,polrelid),''), ',' ORDER BY polname),''))
       FROM pg_policy WHERE polrelid='public.shops'::regclass
     UNION ALL SELECT 'grants', md5(coalesce(string_agg(grantee||':'||privilege_type, ',' ORDER BY grantee, privilege_type),''))
       FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='shops'
     UNION ALL SELECT 'triggers', md5(coalesce(string_agg(tgname||':'||tgtype::text||':'||tgenabled::text, ',' ORDER BY tgname),'')) FROM pg_trigger
       WHERE tgrelid='public.shops'::regclass AND NOT tgisinternal
   ) c USING (k) WHERE f.v <> c.v)
 THEN RAISE EXCEPTION 'shops columns, policies, grants or triggers changed (the migration must only replace one function body)'; END IF;
END $$;
"""

STRUCTURE = """
DO $$
DECLARE p pg_proc%ROWTYPE; t pg_trigger%ROWTYPE; r text; c text;
BEGIN
 SELECT * INTO p FROM pg_proc WHERE proname='shops_protected_columns_guard' AND pronamespace='public'::regnamespace;
 IF NOT FOUND THEN RAISE EXCEPTION 'guard function missing'; END IF;
 IF p.prosecdef THEN RAISE EXCEPTION 'guard must be SECURITY INVOKER (current_user is the caller)'; END IF;
 IF p.proconfig IS NULL OR NOT ('search_path=""' = ANY(p.proconfig)) THEN RAISE EXCEPTION 'guard search_path is not pinned'; END IF;
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF has_function_privilege(r, p.oid, 'EXECUTE') THEN RAISE EXCEPTION '% can EXECUTE the guard function', r; END IF;
 END LOOP;
 FOREACH c IN ARRAY ARRAY['vapi_assistant_id','vapi_phone_number_id','voice_live','voice_test_called_at','vapi_server_secret_enc'] LOOP
  IF position(c in pg_get_functiondef(p.oid)) = 0 THEN RAISE EXCEPTION 'guard does not mention %', c; END IF;
 END LOOP;
 SELECT * INTO t FROM pg_trigger WHERE tgname='shops_a_protected_columns_guard' AND tgrelid='public.shops'::regclass;
 IF NOT FOUND THEN RAISE EXCEPTION 'guard trigger missing'; END IF;
 IF t.tgenabled <> 'O' THEN RAISE EXCEPTION 'guard trigger not enabled'; END IF;
 -- row-level (1) + BEFORE (2) + INSERT (4) + UPDATE (16) = 23; no UPDATE OF column list.
 IF t.tgtype <> 23 OR t.tgattr::text <> '' THEN RAISE EXCEPTION 'guard trigger is not BEFORE INSERT OR UPDATE FOR EACH ROW without a column list (%)', t.tgtype; END IF;
END $$;
"""

au = []
for col, forged, clear in VOICE_UPDATES:
    au.append(refused(f'authenticated change {col}', 'authenticated', U(1), f"UPDATE public.shops SET {col} = {forged} WHERE id = '{S(1)}'", col))
    if clear:
        au.append(refused(f'authenticated clear {col}', 'authenticated', U(1), f"UPDATE public.shops SET {col} = {clear} WHERE id = '{S(1)}'", col))
    au.append(allowed(f'authenticated re-send unchanged {col}', 'authenticated', U(1), f"UPDATE public.shops SET {col} = {col} WHERE id = '{S(1)}'"))
# Forge from the default on the plain shop.
for col, val in VOICE_INSERTS:
    au.append(refused(f'authenticated forge-from-default {col}', 'authenticated', U(2), f"UPDATE public.shops SET {col} = {val} WHERE id = '{S(2)}'", col))
au.append(refused('authenticated mixed patch (safe + voice)', 'authenticated', U(2), f"UPDATE public.shops SET name = 'x', voice_live = true WHERE id = '{S(2)}'", 'voice_live'))
au.append(refused('authenticated pauses voice_live directly', 'authenticated', U(1), f"UPDATE public.shops SET voice_live = false WHERE id = '{S(1)}'", 'voice_live'))
# The previous migration's columns are still protected.
for col, val in PREVIOUS:
    au.append(refused(f'authenticated change previous-migration column {col}', 'authenticated', U(2), f"UPDATE public.shops SET {col} = {val} WHERE id = '{S(2)}'", col))
au.append(refused('authenticated clears vapi_stale', 'authenticated', U(2),
                  f"UPDATE public.shops SET vapi_stale = true WHERE id = '{S(2)}'; UPDATE public.shops SET vapi_stale = false WHERE id = '{S(2)}'", 'vapi_stale'))
# A shop that already carries a forged-looking launch flag: unchanged, not repaired, owner cannot alter it, safe edits work.
au.append(refused('pre-fix forged shop: owner cannot change voice_live', 'authenticated', U(4), f"UPDATE public.shops SET voice_live = false WHERE id = '{S(4)}'", 'voice_live'))
au.append(allowed('pre-fix forged shop: owner can still make safe edits', 'authenticated', U(4), f"UPDATE public.shops SET name = 'Edited forged shop', credit_limit = 99 WHERE id = '{S(4)}'"))
AUTH_UPDATES = block(*au)

SAFE = block(
    allowed('owner edits safe fields incl. voice_config', 'authenticated', U(1),
            f"UPDATE public.shops SET name='Edited voice shop', location='Fictional City', phone='+15551110000', settings='{{\"k\":1}}', voice_config='{{\"greeting\":\"Hi\"}}', credit_limit=77, timezone='America/Chicago' WHERE id='{S(1)}'"),
    allowed('owner raises vapi_stale', 'authenticated', U(2), f"UPDATE public.shops SET vapi_stale = true WHERE id='{S(2)}'"),
    f"""
 IF (SELECT concat(vapi_assistant_id,vapi_phone_number_id,voice_live,vapi_server_secret_enc) FROM public.shops WHERE id='{S(1)}') <> 'asst_legacy_1pn_legacy_1tenc:legacy1' THEN
  RAISE EXCEPTION 'voice identity moved during safe edits'; END IF;
 IF (SELECT name FROM public.shops WHERE id='{S(1)}') <> 'Edited voice shop' THEN RAISE EXCEPTION 'safe edit did not persist'; END IF;
 IF (SELECT voice_live FROM public.shops WHERE id='{S(4)}') IS NOT TRUE THEN RAISE EXCEPTION 'pre-fix row was silently repaired'; END IF;""",
)

INSERTS_BLOCK = block(
    allowed('authenticated INSERT with only safe fields gets defaults', 'authenticated', U(3),
            f"INSERT INTO public.shops(id,owner_id,name,location,phone,settings) VALUES ('{S(3)}','{U(3)}','Fictional new shop','City','+15552220000','{{}}')"),
    f"""
 IF (SELECT concat(voice_live,(vapi_assistant_id IS NULL),(vapi_phone_number_id IS NULL),(voice_test_called_at IS NULL),(vapi_server_secret_enc IS NULL)) FROM public.shops WHERE id='{S(3)}') <> 'ftttt' THEN
  RAISE EXCEPTION 'voice defaults not applied'; END IF;""",
    allowed('authenticated INSERT with explicit defaults', 'authenticated', U(3),
            "INSERT INTO public.shops(id,owner_id,name,voice_live,vapi_assistant_id,vapi_phone_number_id,voice_test_called_at,vapi_server_secret_enc) "
            f"VALUES ('00000000-0000-4000-8000-0000000b0009','{U(3)}','Explicit defaults',false,NULL,NULL,NULL,NULL)"),
    *[refused(f'authenticated INSERT {col}', 'authenticated', U(3),
              f"INSERT INTO public.shops(id,owner_id,name,{col}) VALUES (gen_random_uuid(),'{U(3)}','Forged {col}',{val})", col) for col, val in VOICE_INSERTS],
    """
 IF EXISTS (SELECT 1 FROM public.shops WHERE name LIKE 'Forged %') THEN RAISE EXCEPTION 'a forged INSERT left a row behind'; END IF;""",
)

SERVICE = block(
    *[allowed(f'service_role change {col}', 'service_role', None, f"UPDATE public.shops SET {col} = {forged} WHERE id = '{S(1)}'") for col, forged, _ in VOICE_UPDATES],
    *[allowed(f'service_role clear {col}', 'service_role', None, f"UPDATE public.shops SET {col} = {clear} WHERE id = '{S(1)}'") for col, _, clear in VOICE_UPDATES if clear],
    allowed('service_role INSERT already live', 'service_role', None,
            f"INSERT INTO public.shops(id,owner_id,name,voice_live,vapi_assistant_id,vapi_phone_number_id,voice_test_called_at,vapi_server_secret_enc) VALUES ('00000000-0000-4000-8000-0000000b0005','{U(3)}','Service created',true,'asst_svc','pn_svc',now(),'enc:svc')"),
    """
 IF NOT (SELECT voice_live FROM public.shops WHERE id='00000000-0000-4000-8000-0000000b0005') THEN RAISE EXCEPTION 'service INSERT did not persist'; END IF;""",
)

DEFINER = f"""
CREATE FUNCTION public.__probe_definer_write(p uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path='' AS
 'UPDATE public.shops SET voice_live=true, vapi_assistant_id=''asst_definer'', vapi_phone_number_id=''pn_definer'', voice_test_called_at=now(), vapi_server_secret_enc=''enc:definer'' WHERE id=$1';
""" + block(
    allowed('SECURITY DEFINER function owned by the migration role writes the voice columns', 'authenticated', U(1), f"PERFORM public.__probe_definer_write('{S(1)}')"),
    f"""
 IF (SELECT vapi_assistant_id FROM public.shops WHERE id='{S(1)}') <> 'asst_definer' THEN RAISE EXCEPTION 'definer write did not persist'; END IF;""",
) + "DROP FUNCTION public.__probe_definer_write(uuid);\n"

TENANT = block(
    f"""
 {as_role('authenticated', U(2))}
 UPDATE public.shops SET name = 'cross tenant' WHERE id = '{S(1)}';
 GET DIAGNOSTICS n = ROW_COUNT;
 IF n <> 0 THEN RAISE EXCEPTION 'owner 2 reached owner 1 shop'; END IF;
 IF EXISTS (SELECT 1 FROM public.shops WHERE id = '{S(1)}') THEN RAISE EXCEPTION 'owner 2 can read owner 1 shop'; END IF;
 EXECUTE 'RESET ROLE';
 IF (SELECT name FROM public.shops WHERE id='{S(1)}') = 'cross tenant' THEN RAISE EXCEPTION 'cross-tenant write applied'; END IF;""",
    f"""
 {as_role('anon', None)}
 UPDATE public.shops SET voice_live = true WHERE id = '{S(2)}';
 GET DIAGNOSTICS n = ROW_COUNT;
 EXECUTE 'RESET ROLE';
 IF n <> 0 THEN RAISE EXCEPTION 'anon updated a shop'; END IF;""",
)

script = "\n".join([
    "BEGIN;",
    RESTORE_OLD,
    SEED,
    SEED5,
    "-- ===== the exploit, on the schema the previous migration left =====",
    EXPLOIT_OLD,
    CLEAN_EXPLOIT,
    "-- ===== the migration's real SQL, wrapper removed =====",
    body,
    "-- ===== assertions =====",
    UNCHANGED,
    STRUCTURE,
    AUTH_UPDATES,
    SAFE,
    INSERTS_BLOCK,
    SERVICE,
    DEFINER,
    TENANT,
    "ROLLBACK;",
])
outside = top_level(script).replace('ON COMMIT DROP', '')
assert re.search(r'(?i)\bcommit\b', outside) is None, 'the probe must never commit'
assert len(re.findall(r'(?m)^ROLLBACK;$', outside)) == 1 and outside.rstrip().endswith('ROLLBACK;'), 'the probe must end with exactly one ROLLBACK'
run(script)

# Nothing was changed: the migration is still applied exactly as before, with the NEW function body.
assert run("SELECT count(*) || ':' || max(version) FROM supabase_migrations.schema_migrations") == ledger_before
assert run("SELECT count(*) FROM pg_trigger WHERE tgname = 'shops_a_protected_columns_guard' AND NOT tgisinternal") == '1'
assert run("SELECT position('vapi_server_secret_enc' in pg_get_functiondef('public.shops_protected_columns_guard'::regproc)) > 0") == 't'
assert run("SELECT count(*) FROM public.shops WHERE id IN ('%s','%s','%s','%s','%s')" % tuple(S(i) for i in range(1, 6))) == '0'
assert run("SELECT count(*) FROM pg_proc WHERE proname = '__probe_definer_write'") == '0'

print(
    f'PASS ({project}): upgrade {PREV} -> {NEW} applied from its real SQL inside a rolled-back transaction. On the old guard the '
    'owner JWT wrote all five voice columns on UPDATE and a shop born live on INSERT (exploit reproduced). After the migration: '
    'existing shops rows unchanged (content, xmin, ctid) including one with a pre-fix forged flag (no silent repair, owner not '
    'locked out of safe edits); columns, policies, grants and trigger set identical; guard still SECURITY INVOKER, pinned '
    f'search_path, no EXECUTE for any role; authenticated refused for all {len(VOICE_UPDATES)} voice columns on UPDATE (change, '
    f'clear, from default, voice_live both ways) and all {len(VOICE_INSERTS)} on INSERT; all {len(PREVIOUS)} earlier protected '
    'columns and vapi_stale true -> false still enforced; safe owner edits and defaults-only INSERT allowed; service_role, a '
    'SECURITY DEFINER function and postgres still write every voice column; cross-tenant and anon writes reach nothing; database '
    'left exactly as it was'
)
