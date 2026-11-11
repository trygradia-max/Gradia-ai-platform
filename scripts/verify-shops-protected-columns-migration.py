"""Non-destructive upgrade probe for 20261110130000_shops_protected_columns_guard.

Everything runs inside ONE transaction on the unlinked gradia-isolated-tests stack and ends
with ROLLBACK, so no database state is ever changed or destroyed. Inside it the probe
  1. removes exactly the two objects the migration created (one trigger, one function), which
     restores the schema the previous migration left behind (the migration adds objects only),
  2. seeds fictional LEGACY shops, one of them already carrying non-default values in every
     protected column (a grandfathered paid, voice-enabled, number-holding shop),
  3. applies the migration's REAL SQL text (BEGIN/COMMIT removed so the outer transaction
     stays in control) and proves:
       * no existing shops row was rewritten (content, xmin, physical position) and the
         table's columns, policies and grants are identical to before,
       * the function is SECURITY INVOKER, has a pinned search_path and no EXECUTE for any role,
         and the trigger is an enabled BEFORE INSERT OR UPDATE row trigger,
       * as authenticated and anon: every protected column is refused on UPDATE (forge, change,
         clear) and on INSERT (non-default), vapi_stale only on true -> false, and safe owner
         columns still save; a grandfathered shop's owner can still edit safe fields,
       * as service_role, postgres and a SECURITY DEFINER function: every protected column is
         still writable, including INSERT with non-default values,
       * row-level security still hides another owner's shop,
  4. rolls everything back, then confirms the migration is still applied exactly as before.
No credential-bearing output is printed. The literal `supabase db reset --version` path is
NOT used by this script.
"""
from pathlib import Path
import re
import subprocess

root = Path(__file__).resolve().parent.parent
project = 'gradia-isolated-tests'
config = root / 'tests/supabase/config.toml'
assert f'project_id = "{project}"' in config.read_text() and 'env(' not in config.read_text()
assert not (root / '.local-tools/supabase-test/supabase/.temp/project-ref').exists(), 'remote links forbidden'

NEW = '20261110130000'
migration = next((root / 'supabase/migrations').glob(f'{NEW}_*.sql'))
text = migration.read_text().strip()
assert text.startswith('BEGIN;') and text.endswith('COMMIT;'), 'migration must be one BEGIN..COMMIT block'
body = text[len('BEGIN;'):-len('COMMIT;')]


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


assert run("SELECT max(version) FROM supabase_migrations.schema_migrations") == versions[-1] == NEW, 'stack must be at the latest migration'
ledger_before = run("SELECT count(*) || ':' || max(version) FROM supabase_migrations.schema_migrations")

DROP_NEW = """
DROP TRIGGER shops_a_protected_columns_guard ON public.shops;
DROP FUNCTION public.shops_protected_columns_guard();
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'shops_a_protected_columns_guard')
  OR EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'shops_protected_columns_guard')
 THEN RAISE EXCEPTION 'Pre-migration schema was not restored'; END IF;
END $$;
"""

SEED = f"""
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES
 ('{U(1)}','paid-owner@example.test',now()),('{U(2)}','free-owner@example.test',now()),('{U(3)}','insert-owner@example.test',now());
-- Legacy shop 1: grandfathered, every protected column already non-default (written by trusted code).
INSERT INTO public.shops(id,owner_id,name,plan,voice_addon,voice_addon_ended_at,stripe_subscription_id,credit_period_start,
  stripe_account_id,stripe_charges_enabled,vapi_assistant_id,vapi_stale,voice_minutes_budget,gradia_number_e164,gradia_number_sid,
  twilio_subaccount_sid,twilio_subaccount_token_enc,number_purchase_claim,number_purchase_claimed_at) VALUES
 ('{S(1)}','{U(1)}','Fictional paid shop','active',true,now() - interval '40 days','sub_legacy_1',now() - interval '12 days',
  'acct_legacy_1',true,'asst_legacy_1',true,30,'+15550010001','PNlegacy1','ACLEGACY1','enc:legacy1','00000000-0000-4000-8000-0000000c0001',now() - interval '1 day');
-- Legacy shop 2: plain defaults.
INSERT INTO public.shops(id,owner_id,name) VALUES ('{S(2)}','{U(2)}','Fictional free shop');

CREATE TEMP TABLE legacy_fp AS
 SELECT id::text AS pk, to_jsonb(t)::text AS content, t.xmin::text AS x, t.ctid::text AS p FROM public.shops t;
CREATE TEMP TABLE schema_fp AS
 SELECT 'columns' AS k, md5(string_agg(column_name||':'||data_type||':'||coalesce(column_default,'')||':'||is_nullable, ',' ORDER BY ordinal_position)) AS v
   FROM information_schema.columns WHERE table_schema='public' AND table_name='shops'
 UNION ALL SELECT 'policies', md5(coalesce(string_agg(polname||':'||polcmd::text||':'||coalesce(pg_get_expr(polqual,polrelid),'')||':'||coalesce(pg_get_expr(polwithcheck,polrelid),''), ',' ORDER BY polname),''))
   FROM pg_policy WHERE polrelid='public.shops'::regclass
 UNION ALL SELECT 'grants', md5(coalesce(string_agg(grantee||':'||privilege_type, ',' ORDER BY grantee, privilege_type),''))
   FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='shops'
 UNION ALL SELECT 'other_triggers', md5(coalesce(string_agg(tgname, ',' ORDER BY tgname),'')) FROM pg_trigger WHERE tgrelid='public.shops'::regclass AND NOT tgisinternal;
GRANT SELECT ON legacy_fp, schema_fp TO PUBLIC;
"""

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

 -- Columns, policies, grants and every OTHER trigger are identical; only the one trigger was added.
 IF EXISTS (
   SELECT 1 FROM schema_fp f JOIN (
     SELECT 'columns' k, md5(string_agg(column_name||':'||data_type||':'||coalesce(column_default,'')||':'||is_nullable, ',' ORDER BY ordinal_position)) v
       FROM information_schema.columns WHERE table_schema='public' AND table_name='shops'
     UNION ALL SELECT 'policies', md5(coalesce(string_agg(polname||':'||polcmd::text||':'||coalesce(pg_get_expr(polqual,polrelid),'')||':'||coalesce(pg_get_expr(polwithcheck,polrelid),''), ',' ORDER BY polname),''))
       FROM pg_policy WHERE polrelid='public.shops'::regclass
     UNION ALL SELECT 'grants', md5(coalesce(string_agg(grantee||':'||privilege_type, ',' ORDER BY grantee, privilege_type),''))
       FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='shops'
     UNION ALL SELECT 'other_triggers', md5(coalesce(string_agg(tgname, ',' ORDER BY tgname),'')) FROM pg_trigger
       WHERE tgrelid='public.shops'::regclass AND NOT tgisinternal AND tgname <> 'shops_a_protected_columns_guard'
   ) c USING (k) WHERE f.v <> c.v)
 THEN RAISE EXCEPTION 'shops columns, policies, grants or other triggers changed'; END IF;
END $$;
"""

STRUCTURE = """
DO $$
DECLARE p pg_proc%ROWTYPE; t pg_trigger%ROWTYPE; r text;
BEGIN
 SELECT * INTO p FROM pg_proc WHERE proname='shops_protected_columns_guard' AND pronamespace='public'::regnamespace;
 IF NOT FOUND THEN RAISE EXCEPTION 'guard function missing'; END IF;
 IF p.prosecdef THEN RAISE EXCEPTION 'guard must be SECURITY INVOKER (current_user is the caller)'; END IF;
 IF p.proconfig IS NULL OR NOT ('search_path=""' = ANY(p.proconfig)) THEN RAISE EXCEPTION 'guard search_path is not pinned'; END IF;
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF has_function_privilege(r, p.oid, 'EXECUTE') THEN RAISE EXCEPTION '% can EXECUTE the guard function', r; END IF;
 END LOOP;
 SELECT * INTO t FROM pg_trigger WHERE tgname='shops_a_protected_columns_guard' AND tgrelid='public.shops'::regclass;
 IF NOT FOUND THEN RAISE EXCEPTION 'guard trigger missing'; END IF;
 IF t.tgenabled <> 'O' THEN RAISE EXCEPTION 'guard trigger not enabled'; END IF;
 -- row-level (1) + BEFORE (2) + INSERT (4) + UPDATE (16) = 23; no UPDATE OF column list.
 IF t.tgtype <> 23 OR t.tgattr::text <> '' THEN RAISE EXCEPTION 'guard trigger is not BEFORE INSERT OR UPDATE FOR EACH ROW without a column list (%)', t.tgtype; END IF;
END $$;
"""

# Protected UPDATE targets for shop 1 (already non-default): (column, a different non-null value, SQL for clearing or NULL when not clearable).
COLUMNS = [
    ('plan', "'past_due'", None),
    ('voice_addon', 'false', None),
    ('voice_addon_ended_at', "now()", 'NULL'),
    ('stripe_subscription_id', "'sub_forged'", 'NULL'),
    ('credit_period_start', "now() + interval '30 days'", None),
    ('stripe_account_id', "'acct_forged'", 'NULL'),
    ('stripe_charges_enabled', 'false', None),
    ('voice_minutes_budget', '300', 'NULL'),
    ('gradia_number_e164', "'+15550099999'", 'NULL'),
    ('gradia_number_sid', "'PNforged'", 'NULL'),
    ('twilio_subaccount_sid', "'ACFORGED'", 'NULL'),
    ('twilio_subaccount_token_enc', "'enc:forged'", 'NULL'),
    ('number_purchase_claim', "'00000000-0000-4000-8000-0000000c0099'", 'NULL'),
    ('number_purchase_claimed_at', "now()", 'NULL'),
]
# INSERT non-default targets (each separately).
INSERTS = [
    ('plan', "'active'"), ('voice_addon', 'true'), ('voice_addon_ended_at', 'now()'), ('stripe_subscription_id', "'sub_x'"),
    ('credit_period_start', "now() + interval '1 day'"), ('stripe_account_id', "'acct_x'"), ('stripe_charges_enabled', 'true'),
    ('vapi_stale', 'true'), ('voice_minutes_budget', '5'), ('gradia_number_e164', "'+15550077777'"), ('gradia_number_sid', "'PNx'"),
    ('twilio_subaccount_sid', "'ACX'"), ('twilio_subaccount_token_enc', "'enc:x'"),
    ('number_purchase_claim', "'00000000-0000-4000-8000-0000000c0098'"), ('number_purchase_claimed_at', 'now()'),
]


def as_role(role, uid):
    claims = '{"sub":"%s","role":"%s"}' % (uid, role) if uid else '{"role":"%s"}' % role
    return f"PERFORM set_config('request.jwt.claims', '{claims}', true); EXECUTE 'SET LOCAL ROLE {role}';"


# An UPDATE/INSERT must raise the guard's SQLSTATE 42501 with DETAIL=server_written and HINT=<column>;
# anything else (including success, or an RLS 42501 without that detail) fails the probe.
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


authenticated_update = []
for col, forged, clear in COLUMNS:
    for role in ('authenticated',):
        authenticated_update.append(refused(f'{role} change {col}', role, U(1), f"UPDATE public.shops SET {col} = {forged} WHERE id = '{S(1)}'", col))
        if clear:
            authenticated_update.append(refused(f'{role} clear {col}', role, U(1), f"UPDATE public.shops SET {col} = {clear} WHERE id = '{S(1)}'", col))
        # Re-sending the stored value is not a change.
        authenticated_update.append(allowed(f'{role} re-send unchanged {col}', role, U(1), f"UPDATE public.shops SET {col} = {col} WHERE id = '{S(1)}'"))
# Forge from the default on a plain shop too, and as anon through a (hypothetical) policy-free role grant path.
for col, forged in INSERTS:
    if col == 'vapi_stale':
        continue  # raising it is allowed by design; covered below
    authenticated_update.append(refused(f'authenticated forge-from-default {col}', 'authenticated', U(2), f"UPDATE public.shops SET {col} = {forged} WHERE id = '{S(2)}'", col))
authenticated_update.append(refused('authenticated mixed patch', 'authenticated', U(2), f"UPDATE public.shops SET name = 'x', plan = 'active' WHERE id = '{S(2)}'", 'plan'))
authenticated_update.append(refused('authenticated clear vapi_stale', 'authenticated', U(1), f"UPDATE public.shops SET vapi_stale = false WHERE id = '{S(1)}'", 'vapi_stale'))
authenticated_update.append(refused('authenticated clear vapi_stale with safe column', 'authenticated', U(1), f"UPDATE public.shops SET vapi_stale = false, voice_live = true WHERE id = '{S(1)}'", 'vapi_stale'))
authenticated_update.append(allowed('authenticated raise vapi_stale', 'authenticated', U(2), f"UPDATE public.shops SET vapi_stale = true WHERE id = '{S(2)}'"))
authenticated_update.append(allowed('authenticated re-raise vapi_stale', 'authenticated', U(2), f"UPDATE public.shops SET vapi_stale = true WHERE id = '{S(2)}'"))
authenticated_update.append(refused('authenticated clear raised vapi_stale', 'authenticated', U(2), f"UPDATE public.shops SET vapi_stale = false WHERE id = '{S(2)}'", 'vapi_stale'))
AUTH_UPDATES = block(*authenticated_update)

SAFE = block(
    allowed('grandfathered owner edits safe fields', 'authenticated', U(1),
            f"UPDATE public.shops SET name='Edited paid shop', location='Fictional City', phone='+15551110000', settings='{{\"k\":1}}', voice_live=true, credit_limit=77, timezone='America/Chicago' WHERE id='{S(1)}'"),
    allowed('free owner edits safe fields', 'authenticated', U(2),
            f"UPDATE public.shops SET name='Edited free shop', credit_limit=55 WHERE id='{S(2)}'"),
    """
 IF (SELECT count(*) FROM public.shops WHERE id IN ('%s','%s') AND name LIKE 'Edited%%') <> 2 THEN RAISE EXCEPTION 'safe edits did not persist'; END IF;
 IF (SELECT concat(plan,voice_addon,stripe_account_id,gradia_number_e164) FROM public.shops WHERE id='%s') <> 'activetacct_legacy_1+15550010001' THEN RAISE EXCEPTION 'legacy protected values moved'; END IF;"""
    % (S(1), S(2), S(1)),
)

INSERTS_BLOCK = block(
    allowed('authenticated INSERT with only safe fields gets defaults', 'authenticated', U(3),
            f"INSERT INTO public.shops(id,owner_id,name,location,phone,settings) VALUES ('{S(3)}','{U(3)}','Fictional new shop','City','+15552220000','{{}}')"),
    f"""
 IF (SELECT concat(plan,voice_addon,vapi_stale,stripe_charges_enabled,(stripe_account_id IS NULL),(gradia_number_e164 IS NULL)) FROM public.shops WHERE id='{S(3)}') <> 'freeffftt' THEN RAISE EXCEPTION 'defaults not applied'; END IF;
 IF (SELECT credit_period_start FROM public.shops WHERE id='{S(3)}') <> now() THEN RAISE EXCEPTION 'credit_period_start default is not now()'; END IF;""",
    allowed('authenticated INSERT with explicit defaults', 'authenticated', U(3),
            f"INSERT INTO public.shops(id,owner_id,name,plan,voice_addon,stripe_charges_enabled,vapi_stale) VALUES ('00000000-0000-4000-8000-0000000b0004','{U(3)}','Explicit defaults','free',false,false,false)"),
    *[refused(f'authenticated INSERT {col}', 'authenticated', U(3),
              f"INSERT INTO public.shops(id,owner_id,name,{col}) VALUES (gen_random_uuid(),'{U(3)}','Forged {col}',{val})", col) for col, val in INSERTS],
    f"""
 IF EXISTS (SELECT 1 FROM public.shops WHERE name LIKE 'Forged %') THEN RAISE EXCEPTION 'a forged INSERT left a row behind'; END IF;""",
)

SERVICE = block(
    *[allowed(f'service_role change {col}', 'service_role', None, f"UPDATE public.shops SET {col} = {forged} WHERE id = '{S(1)}'") for col, forged, _ in COLUMNS],
    *[allowed(f'service_role clear {col}', 'service_role', None, f"UPDATE public.shops SET {col} = {clear} WHERE id = '{S(1)}'") for col, _, clear in COLUMNS if clear],
    allowed('service_role clears vapi_stale', 'service_role', None, f"UPDATE public.shops SET vapi_stale = false WHERE id = '{S(1)}'"),
    allowed('service_role INSERT already paid', 'service_role', None,
            f"INSERT INTO public.shops(id,owner_id,name,plan,voice_addon,stripe_account_id,vapi_stale,gradia_number_e164) VALUES ('00000000-0000-4000-8000-0000000b0005','{U(3)}','Service created','active',true,'acct_svc',true,'+15550088888')"),
    """
 IF (SELECT plan FROM public.shops WHERE id='00000000-0000-4000-8000-0000000b0005') <> 'active' THEN RAISE EXCEPTION 'service INSERT did not persist'; END IF;""",
)

DEFINER = f"""
CREATE FUNCTION public.__probe_definer_write(p uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path='' AS
 'UPDATE public.shops SET plan=''past_due'', vapi_stale=false, gradia_number_sid=''PNdefiner'' WHERE id=$1';
""" + block(
    allowed('SECURITY DEFINER function owned by the migration role writes protected columns', 'authenticated', U(1), f"PERFORM public.__probe_definer_write('{S(1)}')"),
    f"""
 IF (SELECT plan FROM public.shops WHERE id='{S(1)}') <> 'past_due' THEN RAISE EXCEPTION 'definer write did not persist'; END IF;
 UPDATE public.shops SET plan='active', gradia_number_sid=NULL WHERE id='{S(1)}';""",
) + "DROP FUNCTION public.__probe_definer_write(uuid);\n"

TENANT = block(
    f"""
 {as_role('authenticated', U(2))}
 UPDATE public.shops SET name = 'cross tenant', plan = 'active' WHERE id = '{S(1)}';
 GET DIAGNOSTICS n = ROW_COUNT;
 IF n <> 0 THEN RAISE EXCEPTION 'owner 2 reached owner 1 shop'; END IF;
 IF EXISTS (SELECT 1 FROM public.shops WHERE id = '{S(1)}') THEN RAISE EXCEPTION 'owner 2 can read owner 1 shop'; END IF;
 EXECUTE 'RESET ROLE';
 IF (SELECT name FROM public.shops WHERE id='{S(1)}') = 'cross tenant' THEN RAISE EXCEPTION 'cross-tenant write applied'; END IF;""",
    f"""
 {as_role('anon', None)}
 UPDATE public.shops SET plan = 'active' WHERE id = '{S(2)}';
 GET DIAGNOSTICS n = ROW_COUNT;
 EXECUTE 'RESET ROLE';
 IF n <> 0 THEN RAISE EXCEPTION 'anon updated a shop'; END IF;""",
)

script = "\n".join([
    "BEGIN;",
    DROP_NEW,
    SEED,
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

# Nothing was changed: the migration is still applied exactly as before, with its objects.
assert run("SELECT count(*) || ':' || max(version) FROM supabase_migrations.schema_migrations") == ledger_before
assert run("SELECT count(*) FROM pg_trigger WHERE tgname = 'shops_a_protected_columns_guard' AND NOT tgisinternal") == '1'
assert run("SELECT count(*) FROM pg_proc WHERE proname = 'shops_protected_columns_guard' AND pronamespace = 'public'::regnamespace") == '1'
assert run("SELECT count(*) FROM public.shops WHERE id IN ('%s','%s','%s')" % (S(1), S(2), S(3))) == '0'
assert run("SELECT count(*) FROM pg_proc WHERE proname = '__probe_definer_write'") == '0'

print(
    f'PASS: upgrade {versions[-2]} -> {NEW} applied from its real SQL inside a rolled-back transaction; existing shops '
    'rows unchanged (content, xmin, ctid) including a grandfathered paid shop; columns, policies, grants and other '
    'triggers identical; guard is SECURITY INVOKER with a pinned search_path and no EXECUTE for any role; '
    f'authenticated refused for all {len(COLUMNS)} protected columns on UPDATE (change, clear, from default) and all '
    f'{len(INSERTS)} on INSERT, vapi_stale only true -> false, safe owner edits and defaults-only INSERT allowed; '
    'service_role, a SECURITY DEFINER function and postgres still write every protected column; cross-tenant and anon '
    'writes reach nothing; database left exactly as it was'
)
