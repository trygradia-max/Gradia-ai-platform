import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { EmployeeBrief } from "@/lib/super-agent/brief"
import { memoryReadDetailSchema, memorySnapshot } from "@/lib/super-agent/memory"
import { executeMemoryRead, type MemoryStore } from "@/lib/super-agent/memory-job"
import { saveMemoryRead, type SavedMemoryRead } from "@/lib/super-agent/memory-store"

const brief: EmployeeBrief = { name: "Helper", goal: "Help my business show up on Google", deliverable: "A checklist", business_context: "Hours and services", steps: ["Read the notes"], connections_needed: [], questions: [] }

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

function storeFor(found: EmployeeBrief | null, notes: { ok: true; notes: { source_name: string; content: string }[] } | { ok: false }, existing?: SavedMemoryRead): MemoryStore & { rows: SavedMemoryRead[] } {
  const rows = existing ? [existing] : []
  return {
    rows,
    draft: async () => found,
    read: async (_shopId, readId) => rows.find(row => row.id === readId) ?? null,
    owns: async () => true,
    notes: async () => notes,
    save: async row => {
      const saved = rows.find(item => item.id === row.id)
      if (saved) return saved.draft_id === row.draftId ? "replay" : "conflict"
      rows.push({ id: row.id, draft_id: row.draftId, detail: row.detail, created_at: "2026-10-16T00:00:00.000Z" })
      return "saved"
    },
  }
}

describe("employee business-note read", () => {
  const input = { shopId: "shop-1", userId: "owner-1", readId: "read-1", draftId: "draft-1" }

  it("saves excerpts from existing notes and does not publish them", async () => {
    const store = storeFor(brief, { ok: true, notes: [{ source_name: "Hours", content: `Open at 9. ${"x".repeat(400)}` }, { source_name: "  ", content: "blank" }] })
    const saved = await executeMemoryRead(input, store)
    expect(saved).toMatchObject({ ok: true, replayed: false })
    if (!saved.ok) return
    expect(saved.read.detail.published).toBe(false)
    expect(saved.read.detail.lesson_created).toBe(false)
    expect(saved.read.detail.research_included).toBe(false)
    expect(saved.read.detail.notes).toEqual([{ source_name: "Hours", excerpt: `Open at 9. ${"x".repeat(229)}` }])
    expect(saved.read.detail.summary).toMatch(/did not publish/)
    expect(await executeMemoryRead(input, store)).toMatchObject({ ok: true, replayed: true })
    expect(store.rows).toHaveLength(1)
  })

  it("saves an empty read without turning a failed lookup into no notes", async () => {
    const empty = storeFor(brief, { ok: true, notes: [] })
    expect(await executeMemoryRead(input, empty)).toMatchObject({ ok: true, read: { detail: memorySnapshot([]) } })
    const failed = storeFor(brief, { ok: false })
    expect(await executeMemoryRead(input, failed)).toMatchObject({ ok: false, error: expect.stringMatching(/could not be read/) })
    expect(failed.rows).toEqual([])
  })

  it("does not save another workspace's brief or a revoked read", async () => {
    expect(await executeMemoryRead(input, storeFor(null, { ok: true, notes: [] }))).toMatchObject({ ok: false, error: "That employee brief is not in this workspace." })
    const revoked = storeFor(brief, { ok: true, notes: [{ source_name: "Hours", content: "Open at 9." }] })
    let seen = 0
    revoked.owns = async () => { seen += 1; return seen === 1 }
    expect(await executeMemoryRead(input, revoked)).toMatchObject({ ok: false, error: expect.stringMatching(/access changed/) })
    expect(revoked.rows).toEqual([])
  })

  it("rejects a published lesson or research evidence", async () => {
    const detail = memorySnapshot([{ source_name: "Hours", content: "Open at 9." }])
    expect(memoryReadDetailSchema.safeParse({ ...detail, published: true }).success).toBe(false)
    expect(memoryReadDetailSchema.safeParse({ ...detail, lesson_created: true }).success).toBe(false)
    expect(memoryReadDetailSchema.safeParse({ ...detail, research_included: true }).success).toBe(false)
    expect(memoryReadDetailSchema.safeParse({ ...detail, summary: "Published a new shop rule." }).success).toBe(false)
    let inserted = false
    const db = { from: () => ({ insert: () => { inserted = true; return { error: null } } }) } as unknown as SupabaseClient
    expect(await saveMemoryRead(db, { id: "read-1", shopId: "shop-1", draftId: "draft-1", detail: { ...detail, published: true } as never })).toBe("failed")
    expect(inserted).toBe(false)
  })

  it("does not write knowledge, embed text, or mount a cron", () => {
    const source = ["src/lib/super-agent/memory.ts", "src/lib/super-agent/memory-job.ts", "src/lib/super-agent/memory-store.ts", "src/app/actions/super-agent-memory.ts"].map(path => readFileSync(path, "utf8")).join("\n")
    expect(source).not.toMatch(/recordInteraction|addShopKnowledge|deleteShopKnowledge|embedText|searchCustomerMemory|searchShopKnowledge|match_customer_memory|super_agent_research/)
    expect(source).toMatch(/shop_knowledge/)
    const cron = files("src/app/api/cron").map(path => readFileSync(path, "utf8")).join("\n")
    expect(cron).not.toMatch(/super_agent_memory|readEmployeeMemory|executeMemoryRead/)
    expect(readFileSync("vercel.json", "utf8")).not.toMatch(/super_agent_memory/)
  })
})
