"""Prove mismatch refusal using synthetic tables inside a rolled-back transaction.
Only the dedicated disposable P0 container is addressable. No credentials printed.
"""
from pathlib import Path
import os
import subprocess

root = Path(__file__).resolve().parent.parent
assert 'project_id = "gradia-p0-tenant-policy-safety"' in (root / "supabase/config.toml").read_text()
assert not (root / "supabase/.temp/project-ref").exists()
migration = (root / "supabase/migrations/20260909091000_tenant_relationships.sql").read_text()
constraint_block = migration[:migration.index("END $$;") + len("END $$;")]
sql = r"""
\set ON_ERROR_STOP on
BEGIN;
CREATE TABLE public.p0_mismatch_parent (id uuid PRIMARY KEY, shop_id uuid NOT NULL);
CREATE TABLE public.p0_mismatch_child (id uuid PRIMARY KEY, shop_id uuid NOT NULL, parent_id uuid REFERENCES public.p0_mismatch_parent(id));
INSERT INTO public.p0_mismatch_parent VALUES ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002');
INSERT INTO public.p0_mismatch_child VALUES ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000001');
SAVEPOINT before_migration;
\set ON_ERROR_STOP off
""" + constraint_block + r"""
\if :ERROR
  ROLLBACK TO SAVEPOINT before_migration;
\else
  ROLLBACK;
  \quit 1
\endif
\set ON_ERROR_STOP on
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.p0_mismatch_child c JOIN public.p0_mismatch_parent p ON p.id=c.parent_id WHERE c.shop_id <> p.shop_id) THEN
    RAISE EXCEPTION 'Inconsistent fixture was silently repaired';
  END IF;
END $$;
ROLLBACK;
"""
env = {key: os.environ[key] for key in ["PATH", "HOME"] if key in os.environ}
env["DOCKER_HOST"] = "unix:///var/run/docker.sock"
result = subprocess.run(["docker", "exec", "-i", "supabase_db_gradia-p0-tenant-policy-safety", "psql", "-X", "-U", "postgres", "-d", "postgres"], input=sql, text=True, capture_output=True, env=env)
if result.returncode or "Tenant relationship violation: p0_mismatch_child.parent_id" not in result.stderr:
    raise SystemExit("Migration refusal verification failed; inspect only the disposable database")
print("PASS: inconsistent synthetic relationship rejected, unchanged at failure, all fixture DDL/data rolled back")
