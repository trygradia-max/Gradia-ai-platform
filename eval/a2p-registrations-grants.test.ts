import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

// Structural lock for the a2p_registrations owner-write fix (security audit run-1).
// The row is server-written: the owner role may only read it, and no browser/owner-session
// code path may write it. Behaviour is proven in eval/integration/a2p-registrations-server-written.int.test.ts.
const MIGRATIONS = join(process.cwd(), "supabase/migrations")
const sql = readdirSync(MIGRATIONS).sort().map((f) => ({ f, text: readFileSync(join(MIGRATIONS, f), "utf8") }))
const fix = sql.find((m) => m.f.endsWith("_a2p_registrations_server_written.sql"))!

describe("a2p_registrations is owner read-only (migration)", () => {
  it("replaces the FOR ALL policy with SELECT-only", () => {
    expect(fix).toBeDefined()
    expect(fix.text).toMatch(/DROP POLICY IF EXISTS a2p_registrations_tenant_isolation/)
    expect(fix.text).toMatch(/CREATE POLICY a2p_registrations_owner_select[\s\S]*?FOR SELECT/)
    expect(fix.text).not.toMatch(/CREATE POLICY[^;]*FOR (ALL|INSERT|UPDATE|DELETE)/)
  })
  it("revokes writes from authenticated and anon and installs the guard trigger", () => {
    expect(fix.text).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public\.a2p_registrations FROM anon, authenticated/)
    expect(fix.text).toMatch(/BEFORE INSERT OR UPDATE OR DELETE ON public\.a2p_registrations/)
    expect(fix.text).toMatch(/current_user IN \('authenticated', 'anon'\)/)
    expect(fix.text).toMatch(/REVOKE ALL ON FUNCTION public\.a2p_registrations_guard\(\)/)
  })
  it("no later migration re-opens an owner write policy or grant on the table", () => {
    const later = sql.filter((m) => m.f > fix.f)
    for (const m of later) {
      expect(m.text, m.f).not.toMatch(/ON public\.a2p_registrations[\s\S]{0,80}FOR (ALL|INSERT|UPDATE|DELETE)/)
      expect(m.text, m.f).not.toMatch(/GRANT[^;]*(INSERT|UPDATE|DELETE|ALL)[^;]*ON (TABLE )?public\.a2p_registrations[^;]*TO[^;]*(authenticated|anon)/i)
    }
  })
  it("the claim/finish functions stay service_role only", () => {
    const all = sql.map((m) => m.text).join("\n")
    expect(all).toMatch(/GRANT EXECUTE ON FUNCTION public\.a2p_finish_registration\(uuid, uuid, text, text, jsonb, text, text\) TO service_role/)
    expect(all).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.a2p_(claim|finish)_registration[^;]*TO[^;]*(authenticated|anon)/)
  })
})

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

describe("a2p_registrations writers (importer list)", () => {
  // Files that write the table must do so with the service client only.
  const writers = walk(join(process.cwd(), "src")).filter((p) => {
    const t = readFileSync(p, "utf8")
    return /from\("a2p_registrations"\)[\s\S]{0,200}\.(insert|update|upsert|delete)\(/.test(t)
  })
  it("only the reviewed provider module writes the table", () => {
    expect(writers.map((p) => p.replace(process.cwd() + "/", "")).sort()).toEqual(["src/lib/a2p-reconciler.ts", "src/lib/telephony-provider.ts"])
  })
  it("owner-session server actions never write it", () => {
    const t = readFileSync(join(process.cwd(), "src/app/actions/a2p.ts"), "utf8")
    expect(t).not.toMatch(/\.(insert|update|upsert|delete)\(/)
  })
})
