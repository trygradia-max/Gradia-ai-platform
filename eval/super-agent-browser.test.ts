import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { browserCheckDetailSchema, unavailableBrowserCheck } from "@/lib/super-agent/browser"
import { executeBrowserCheck, type BrowserStore } from "@/lib/super-agent/browser-job"
import { saveBrowserCheck } from "@/lib/super-agent/browser-store"
import type { EmployeeBrief } from "@/lib/super-agent/brief"
import type { SavedBrowserCheck } from "@/lib/super-agent/browser-store"

const brief: EmployeeBrief = { name: "Google helper", goal: "Help my business show up on Google", deliverable: "A checklist", business_context: "https://shop.example/", steps: ["Sign in and update the profile"], connections_needed: [], questions: [] }

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

function storeFor(found: EmployeeBrief | null, existing?: SavedBrowserCheck): BrowserStore & { rows: SavedBrowserCheck[]; saves: number } {
  const rows = existing ? [existing] : []
  return {
    rows,
    saves: 0,
    draft: async () => found,
    check: async (_shopId, checkId) => rows.find(row => row.id === checkId) ?? null,
    owns: async () => true,
    save: async row => {
      const saved = rows.find(item => item.id === row.id)
      if (saved) return saved.draft_id === row.draftId ? "replay" : "conflict"
      rows.push({ id: row.id, draft_id: row.draftId, status: "unavailable", detail: row.detail, created_at: "2026-10-16T00:00:00.000Z" })
      return "saved"
    },
  }
}

describe("cloud browser check", () => {
  const input = { shopId: "shop-1", userId: "owner-1", checkId: "check-1", draftId: "draft-1", namedProviderIgnored: false }

  it("saves only an unavailable result and replays that same check", async () => {
    const store = storeFor(brief)
    const saved = await executeBrowserCheck(input, store)
    expect(saved).toMatchObject({ ok: true, replayed: false, check: { status: "unavailable", detail: unavailableBrowserCheck(false) } })
    const again = await executeBrowserCheck(input, store)
    expect(again).toMatchObject({ ok: true, replayed: true })
    expect(store.rows).toHaveLength(1)
    expect(JSON.stringify(store.rows)).not.toMatch(/session_started":true|credentials_stored":true|local_machine_used":true/)
  })

  it("does not save another workspace's brief, a reused id, or a revoked check", async () => {
    expect(await executeBrowserCheck(input, storeFor(null))).toMatchObject({ ok: false, error: "That employee brief is not in this workspace." })
    const conflict = storeFor(brief, { id: "check-1", draft_id: "other", status: "unavailable", detail: unavailableBrowserCheck(false), created_at: "2026-10-16T00:00:00.000Z" })
    expect(await executeBrowserCheck(input, conflict)).toMatchObject({ ok: false, error: "This check already belongs to a different brief." })
    const revoked = storeFor(brief)
    let seen = 0
    revoked.owns = async () => { seen += 1; return seen === 1 }
    expect(await executeBrowserCheck(input, revoked)).toMatchObject({ ok: false, error: expect.stringMatching(/access changed/) })
    expect(revoked.rows).toEqual([])
  })

  it("rejects a started session, stored credentials, or a chosen provider", () => {
    const detail = unavailableBrowserCheck(true)
    expect(detail.named_provider_ignored).toBe(true)
    expect(detail.provider).toBe("none")
    expect(browserCheckDetailSchema.safeParse({ ...detail, session_started: true }).success).toBe(false)
    expect(browserCheckDetailSchema.safeParse({ ...detail, credentials_stored: true }).success).toBe(false)
    expect(browserCheckDetailSchema.safeParse({ ...detail, local_machine_used: true }).success).toBe(false)
    expect(browserCheckDetailSchema.safeParse({ ...detail, provider: "browserbase" }).success).toBe(false)
    expect(browserCheckDetailSchema.safeParse({ ...detail, shell: true }).success).toBe(false)
  })

  it("does not insert a result the schema refuses", async () => {
    let inserted = false
    const db = { from: () => ({ insert: () => { inserted = true; return { error: null } } }) } as unknown as SupabaseClient
    const detail = { ...unavailableBrowserCheck(false), session_started: true }
    expect(await saveBrowserCheck(db, { id: "check-1", shopId: "shop-1", draftId: "draft-1", detail: detail as never })).toBe("failed")
    expect(inserted).toBe(false)
  })

  it("writes the workspace id and does not mount a cron or a browser runtime", () => {
    const inserted: unknown[] = []
    const filters: string[] = []
    const builder = {
      select() { return builder }, eq(column: string, value: string) { filters.push(`${column}=${value}`); return builder },
      order() { return builder }, limit() { return builder }, maybeSingle: async () => ({ data: null, error: null }),
      insert(payload: unknown) { inserted.push(payload); return { error: null } },
    }
    const db = { from: () => builder } as unknown as SupabaseClient
    return saveBrowserCheck(db, { id: "check-1", shopId: "shop-1", draftId: "draft-1", detail: unavailableBrowserCheck(false) }).then(result => {
      expect(result).toBe("saved")
      expect(inserted[0]).toMatchObject({ shop_id: "shop-1", draft_id: "draft-1", status: "unavailable", provider: "none" })
      const source = ["src/lib/super-agent/browser.ts", "src/lib/super-agent/browser-job.ts", "src/lib/super-agent/browser-store.ts", "src/app/actions/super-agent-browser.ts"].map(path => readFileSync(path, "utf8")).join("\n")
      expect(source).not.toMatch(/child_process|playwright|puppeteer|browserbase|node:dns|node:net|spawn\(|exec\(|recordUsage|page-transport|lookup\(/)
      const cron = files("src/app/api/cron").map(path => readFileSync(path, "utf8")).join("\n")
      expect(cron).not.toMatch(/super_agent_browser|checkCloudBrowser|executeBrowserCheck/)
      expect(readFileSync("vercel.json", "utf8")).not.toMatch(/super_agent_browser|cloud-browser/)
    })
  })
})
