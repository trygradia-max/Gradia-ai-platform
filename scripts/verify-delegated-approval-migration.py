"""Verify delegated message approval objects on the dedicated, unlinked disposable database only."""
from pathlib import Path
import subprocess
root = Path(__file__).resolve().parent.parent
work = root / '.local-tools/record-fresh/supabase'
assert 'project_id = "gradia-record-fresh"' in (work / 'config.toml').read_text()
assert not (work / '.temp/project-ref').exists()
def sql(query):
    result = subprocess.run(['docker', 'exec', '-i', 'supabase_db_gradia-record-fresh', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'], input=query, text=True, capture_output=True)
    assert result.returncode == 0, 'Disposable catalog query failed; output withheld'
    return result.stdout.strip()
versions = sorted(p.name.split('_')[0] for p in (root / 'supabase/migrations').glob('*.sql'))
assert sql('SELECT version FROM supabase_migrations.schema_migrations ORDER BY version').splitlines() == versions
definer = "prosecdef AND proconfig=ARRAY['search_path=\"\"']"
def grants(signature):
    return [sql(f"SELECT has_function_privilege('{role}','public.{signature}','EXECUTE')") for role in ['anon', 'authenticated', 'service_role']]
# Internal claim body and helpers are callable by no API role.
for signature in ['control_claim(uuid,uuid,uuid,text,text)', 'control_review_hash(jsonb)', 'message_approval_role(uuid)']:
    assert grants(signature) == ['f', 'f', 'f'], f'Internal function exposed: {signature}'
assert sql(f"SELECT {definer} FROM pg_proc WHERE oid='public.control_claim(uuid,uuid,uuid,text,text)'::regprocedure") == 't'
# Delegated entry points are session-only; the owner entry point keeps its original grants.
for signature in ['claim_delegated_message(uuid,uuid,text)', 'list_delegated_message_approvals(uuid,integer)']:
    assert grants(signature) == ['f', 't', 'f'], f'Unexpected grants: {signature}'
    assert sql(f"SELECT {definer} FROM pg_proc WHERE oid='public.{signature}'::regprocedure") == 't'
assert grants('claim_control_action(uuid,uuid,uuid,text)') == ['f', 't', 't']
assert sql(f"SELECT {definer} FROM pg_proc WHERE oid='public.claim_control_action(uuid,uuid,uuid,text)'::regprocedure") == 't'
assert sql("SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('claim_control_action','control_claim','claim_delegated_message')") == '3'
for table in ['shop_memberships', 'shop_invitations']:
    names = sql(f"SELECT conname FROM pg_constraint WHERE conrelid='public.{table}'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%approvals.messages%' ORDER BY conname").splitlines()
    assert names == [f'{table}_capabilities_known', f'{table}_message_approval_needs_read'], f'Capability constraints mismatch: {table}'
assert sql("SELECT is_nullable='NO' AND column_default IS NULL FROM information_schema.columns WHERE table_schema='public' AND table_name='control_execution_decisions' AND column_name='actor_role'") == 't'
for role in ['anon', 'authenticated', 'service_role']:
    assert sql(f"SELECT has_table_privilege('{role}','public.control_execution_decisions','INSERT,UPDATE,DELETE')") == 'f'
print(f'PASS: exact {len(versions)} migrations; one private claim body; session-only delegated claim and queue; owner entry point grants unchanged; constrained grant; decision role mandatory and not client-writable')
