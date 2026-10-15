"""Read-only disposable ledger, intake relationship and RPC authority verification."""
from pathlib import Path
import subprocess
import sys
root = Path(__file__).resolve().parent.parent
assert sys.argv[1:] in ([], ['--fresh'])
fresh = sys.argv[1:] == ['--fresh']
project = 'gradia-record-fresh' if fresh else 'gradia-isolated-tests'
work = root / ('.local-tools/record-fresh' if fresh else '.local-tools/supabase-test')
assert f'project_id = "{project}"' in (work / 'supabase/config.toml').read_text()
assert not (work / 'supabase/.temp/project-ref').exists()
def run(sql):
    result = subprocess.run(['docker', 'exec', '-i', f'supabase_db_{project}', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'], input=sql, text=True, capture_output=True)
    assert result.returncode == 0, 'Disposable catalog check failed; database output withheld'
    return result.stdout.strip()
versions = sorted(p.name.split('_')[0] for p in (root / 'supabase/migrations').glob('*.sql'))
assert run('SELECT version FROM supabase_migrations.schema_migrations ORDER BY version').splitlines() == versions
manifest = {
    'lead_workflow_customer': 'FOREIGN KEY (shop_id, customer_id) REFERENCES customers(shop_id, id) ON DELETE SET NULL (customer_id)',
    'intake_vehicle_customer': 'FOREIGN KEY (shop_id, customer_id, vehicle_id) REFERENCES vehicles(shop_id, customer_id, id) ON DELETE SET NULL (vehicle_id) DEFERRABLE INITIALLY DEFERRED',
}
for name, expected in manifest.items():
    actual = run(f"SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.lead_workflows'::regclass AND conname='{name}'")
    assert actual == expected, f'Intake relationship mismatch: {name}'
for signature in ['intake_vehicle_choices(uuid,uuid,integer)', 'link_intake_vehicle(uuid,uuid,integer,uuid,timestamptz,uuid,jsonb,uuid)']:
    assert run(f"SELECT has_function_privilege('authenticated','public.{signature}','EXECUTE') AND NOT has_function_privilege('anon','public.{signature}','EXECUTE') AND NOT has_function_privilege('service_role','public.{signature}','EXECUTE')") == 't'
print(f'PASS: exact {len(versions)} migrations; both intake relationship definitions and session-only vehicle RPC privileges verified')
