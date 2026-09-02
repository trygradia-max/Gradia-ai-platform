import { describe, it, expect } from "vitest"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

/**
 * CLEANUP-001 (D-052) — the Housecall Pro connector and the Slack approvals
 * surface are deleted, not dormant. Source-scan locks so neither can creep
 * back without a new decision + ADR: no importer, no route, no flag, no
 * documented secret, no owner-visible copy; the founder ops path uses the
 * P0-012 seam only; the column drop lives outside migrations/ and is not
 * applied.
 */

const ROOT = decodeURIComponent(new URL("../", import.meta.url).pathname)

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

const SRC = walk(join(ROOT, "src"))
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8")

describe("CLEANUP-001 — Housecall Pro + Slack approvals removed (D-052)", () => {
  it("no source file imports the deleted modules", () => {
    const offenders = SRC.filter((f) => {
      const s = readFileSync(f, "utf8")
      return /from "@\/lib\/slack"|from "@\/lib\/housecallpro(-push)?"|housecallpro-settings-card/.test(s)
    })
    expect(offenders).toEqual([])
  })

  it("the deleted routes and modules are gone", () => {
    for (const rel of [
      "src/app/api/slack",
      "src/app/api/housecallpro",
      "src/lib/slack.ts",
      "src/lib/housecallpro.ts",
      "src/lib/housecallpro-push.ts",
      "src/components/gradia/housecallpro-settings-card.tsx",
    ]) {
      expect(existsSync(join(ROOT, rel)), `${rel} must not exist`).toBe(false)
    }
  })

  it("FEATURES carries no slackApprovals flag and the CRM seam has Jobber only", async () => {
    const { FEATURES } = await import("@/lib/features")
    expect("slackApprovals" in FEATURES).toBe(false)
    const seam = read("src/lib/crm-provider.ts")
    expect(seam.match(/name: "/g)).toHaveLength(1)
    expect(seam).toContain('name: "jobber"')
    expect(seam).not.toMatch(/housecallpro/) // identifiers gone; the removal note may name the vendor
  })

  it("no removed secret is documented in .env.example", () => {
    const env = read(".env.example")
    for (const name of [
      "SLACK_WEBHOOK_URL",
      "SLACK_SIGNING_SECRET",
      "SLACK_BOT_TOKEN",
      "SLACK_DEFAULT_CHANNEL_ID",
      "HOUSECALLPRO_CLIENT_ID",
      "HOUSECALLPRO_CLIENT_SECRET",
    ]) {
      expect(new RegExp(`^${name}=`, "m").test(env), `${name} still documented`).toBe(false)
    }
    expect(/^OPS_ALERT_WEBHOOK_URL=/m.test(env)).toBe(true)
  })

  it("owner-visible copy and prompt text no longer mention Slack", () => {
    for (const rel of [
      "src/app/how-it-works/page.tsx",
      "src/components/gradia/add-lead-dialog.tsx",
      "src/components/gradia/ai-lead-section.tsx",
      "src/components/gradia/email-settings-card.tsx",
      "src/lib/agent-planner.ts",
      "src/lib/mcp/server.ts",
      "src/lib/strings.ts",
    ]) {
      expect(read(rel), `${rel} mentions Slack`).not.toMatch(/slack/i)
    }
  })

  it("payment lifecycle notices ride the ops alert seam at SEV-3", () => {
    const route = read("src/app/api/stripe/webhook/route.ts")
    expect(route).toContain('from "@/lib/alerts"')
    expect(route.match(/severity: "SEV-3"/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(route).toContain("Payment received")
    expect(route).toContain("Payment failed")
    expect(route).toContain("Payment refunded")
  })

  it("the column drop is a rollback file, not a migration, and nothing drops the dormant columns", () => {
    expect(existsSync(join(ROOT, "supabase/rollbacks/cleanup-001_hcp_slack_columns_drop.sql"))).toBe(true)
    const migrations = readdirSync(join(ROOT, "supabase/migrations"))
    for (const m of migrations) {
      const sql = read(`supabase/migrations/${m}`)
      expect(/DROP COLUMN[^;]*housecallpro/i.test(sql), `${m} drops an HCP column`).toBe(false)
      expect(/DROP COLUMN[^;]*slack/i.test(sql), `${m} drops a Slack column`).toBe(false)
    }
  })
})
