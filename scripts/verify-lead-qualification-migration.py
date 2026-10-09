"""Verify lead qualification objects on the dedicated, unlinked disposable database only."""
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
for table in ['lead_qualifications', 'lead_qualification_revisions']:
    assert sql(f"SELECT relrowsecurity FROM pg_class WHERE oid='public.{table}'::regclass") == 't'
    for role in ['anon', 'authenticated', 'service_role']:
        assert sql(f"SELECT has_table_privilege('{role}','public.{table}','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')") == 'f', f'{role} can reach {table}'
def grants(signature):
    return [sql(f"SELECT has_function_privilege('{role}','public.{signature}','EXECUTE')") for role in ['anon', 'authenticated', 'service_role']]
definer = "prosecdef AND proconfig=ARRAY['search_path=\"\"']"
for signature in ['read_lead_qualification(uuid,uuid)', 'list_lead_qualifications(uuid,integer)', 'read_lead_qualification_history(uuid,uuid,integer)', 'update_lead_qualification(uuid,uuid,uuid,integer,uuid,uuid,text,jsonb,jsonb)']:
    assert grants(signature) == ['f', 't', 'f'], f'Unexpected grants: {signature}'
    assert sql(f"SELECT {definer} FROM pg_proc WHERE oid='public.{signature}'::regprocedure") == 't'
for signature in ['lead_qualification_role(uuid,boolean)', 'lead_qualification_snapshot(uuid,uuid)', 'lead_qualification_invalid_path(jsonb,jsonb)', 'lead_qualification_text_ok(jsonb,integer,boolean)']:
    assert grants(signature) == ['f', 'f', 'f'], f'Internal function exposed: {signature}'
# Reads cannot write: every read entry point and the snapshot are STABLE.
for signature in ['read_lead_qualification(uuid,uuid)', 'list_lead_qualifications(uuid,integer)', 'read_lead_qualification_history(uuid,uuid,integer)', 'lead_qualification_snapshot(uuid,uuid)']:
    assert sql(f"SELECT provolatile FROM pg_proc WHERE oid='public.{signature}'::regprocedure") == 's'
manifest = {
 'lead_qualifications': 'FOREIGN KEY (shop_id, workflow_id) REFERENCES lead_workflows(shop_id, id) ON DELETE CASCADE',
 'lead_qualification_revisions': 'FOREIGN KEY (shop_id, workflow_id) REFERENCES lead_qualifications(shop_id, workflow_id) ON DELETE CASCADE',
}
for table, definition in manifest.items():
    assert sql(f"SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.{table}'::regclass AND contype='f'") == definition, f'Relationship mismatch: {table}'
assert sql("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.lead_qualification_revisions'::regclass AND contype='p'") == 'PRIMARY KEY (command_id)'
assert sql("SELECT count(*) FROM pg_constraint WHERE conrelid='public.lead_qualifications'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%lead_qualification_invalid_path%'") == '1'
for table in ['shop_memberships', 'shop_invitations']:
    names = sql(f"SELECT conname FROM pg_constraint WHERE conrelid='public.{table}'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%leads.qualify%' ORDER BY conname").splitlines()
    assert names == [f'{table}_capabilities_known', f'{table}_lead_qualify_needs_read'], f'Capability constraints mismatch: {table}'
# The workflow state machine is left alone.
assert "'identity_review'" in sql("SELECT string_agg(pg_get_constraintdef(oid),' ') FROM pg_constraint WHERE conrelid='public.lead_workflows'::regclass AND contype='c'")
assert 'qualif' not in sql("SELECT string_agg(pg_get_constraintdef(oid),' ') FROM pg_constraint WHERE conrelid IN ('public.lead_workflows'::regclass,'public.lead_workflow_transitions'::regclass) AND contype='c'")
print(f'PASS: exact {len(versions)} migrations; two RLS tables deny all direct access; four session-only fixed-search-path RPCs; private helpers; stable reads; two tenant-bound cascading relationships; command primary key; constrained grant; workflow state machine untouched')
