"""Verify only the dedicated, unlinked disposable database catalog."""
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
for table in ['conversation_work','conversation_reads','conversation_audit','conversation_notifications']:
    assert sql(f"SELECT relrowsecurity FROM pg_class WHERE oid='public.{table}'::regclass") == 't'
    for role in ['anon','authenticated','service_role']:
        assert sql(f"SELECT has_table_privilege('{role}','public.{table}','SELECT,INSERT,UPDATE,DELETE')") == 'f'
for signature in ['list_whisper_threads(uuid,integer)','read_whisper_thread(uuid,uuid,text,integer)','whisper_command(uuid,uuid,text,uuid,uuid,integer,text,jsonb)']:
    assert sql(f"SELECT prosecdef AND proconfig=ARRAY['search_path=\"\"'] AND has_function_privilege('authenticated',oid,'EXECUTE') AND NOT has_function_privilege('anon',oid,'EXECUTE') AND NOT has_function_privilege('service_role',oid,'EXECUTE') FROM pg_proc WHERE oid='public.{signature}'::regprocedure") == 't'
manifest = {
 'conversation_work': ['FOREIGN KEY (shop_id, customer_id) REFERENCES customers(shop_id, id) ON DELETE CASCADE','FOREIGN KEY (shop_id, assignee_id) REFERENCES shop_memberships(shop_id, id) ON DELETE SET NULL (assignee_id)'],
 'conversation_reads': ['FOREIGN KEY (shop_id, customer_id) REFERENCES customers(shop_id, id) ON DELETE CASCADE'],
 'conversation_notifications': ['FOREIGN KEY (shop_id, customer_id) REFERENCES customers(shop_id, id) ON DELETE CASCADE'],
}
for table, definitions in manifest.items():
    actual = sql(f"SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.{table}'::regclass AND contype='f'").splitlines()
    assert all(d in actual for d in definitions), f'Relationship mismatch: {table}'
assert sql("SELECT count(*) FROM pg_constraint WHERE contype='p' AND conrelid='public.conversation_audit'::regclass") == '1'
print(f'PASS: exact {len(versions)} migrations; four metadata tables deny direct access; session-only fixed-search-path RPCs; four composite relationships; durable command primary key')

signature='whisper_reply_context(uuid,uuid)'
assert sql(f"SELECT prosecdef AND proconfig=ARRAY['search_path=\"\"'] AND has_function_privilege('authenticated',oid,'EXECUTE') AND has_function_privilege('service_role',oid,'EXECUTE') AND NOT has_function_privilege('anon',oid,'EXECUTE') FROM pg_proc WHERE oid='public.{signature}'::regprocedure") == 't'
print('PASS: immutable reply-context RPC has fixed search path, owner/service authority and no anonymous grant')

assert sql("SELECT relrowsecurity FROM pg_class WHERE oid='public.delivery_reconciliations'::regclass") == 't'
for role in ['anon','authenticated','service_role']:
    assert sql(f"SELECT has_table_privilege('{role}','public.delivery_reconciliations','SELECT,INSERT,UPDATE,DELETE')") == 'f'
for signature in ['record_delivery_reconciliation(uuid,uuid,uuid,integer,timestamptz,text,text)','read_delivery_reconciliation(uuid,uuid,integer)']:
    assert sql(f"SELECT prosecdef AND proconfig=ARRAY['search_path=\"\"'] AND has_function_privilege('authenticated',oid,'EXECUTE') AND NOT has_function_privilege('anon',oid,'EXECUTE') AND NOT has_function_privilege('service_role',oid,'EXECUTE') FROM pg_proc WHERE oid='public.{signature}'::regprocedure") == 't'
assert sql("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.delivery_reconciliations'::regclass AND contype='f'") == 'FOREIGN KEY (shop_id, action_id) REFERENCES service_proof_consumptions(shop_id, action_id) ON DELETE CASCADE'
print('PASS: delivery reviews deny direct access; owner-session RPCs and tenant-bound durable proof relationship verified')
