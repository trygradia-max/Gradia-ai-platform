import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { parseAgentConfig } from "@/lib/agent-config-schema"
import {
  AGENT_NAME_BOUNDS,
  MAX_AGENT_IDENTITIES,
  createAgentIdentity,
  inertLegacyConfig,
  readMemoryCatalog,
  validateAgentName,
} from "@/lib/agent-os/identity-store"

const shopId = "00000000-0000-4000-8000-000000000001"
const actorId = "00000000-0000-4000-8000-000000000002"
const otherShop = "00000000-0000-4000-8000-0000000000ff"

type Calls = { rpc: unknown[][]; inserts: Record<string, unknown>[]; selects: { table: string; columns: string }[] }

function fakeService(opts: { role?: string | null; roleError?: boolean; count?: number | null; insertError?: boolean; tables?: Record<string, Record<string, unknown>[]>; failTable?: string } = {}) {
  const calls: Calls = { rpc: [], inserts: [], selects: [] }
  const service = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.rpc.push([fn, args])
      // The database role check is scoped to the exact shop it is given.
      if (opts.roleError) return { data: null, error: { code: "XX000" } }
      return { data: args.p_shop === shopId ? (opts.role ?? null) : null, error: null }
    },
    from: (table: string) => {
      let rows = [...(opts.tables?.[table] ?? [])]
      const b: Record<string, unknown> = {
        select: (columns: string, o?: { head?: boolean }) => {
          calls.selects.push({ table, columns })
          if (o?.head) return Object.assign(Promise.resolve({ count: opts.count === undefined ? 0 : opts.count, error: opts.count === null ? { code: "x" } : null }), { eq: () => Promise.resolve({ count: opts.count === undefined ? 0 : opts.count, error: opts.count === null ? { code: "x" } : null }) })
          return b
        },
        insert: (row: Record<string, unknown>) => {
          calls.inserts.push(row)
          return { select: () => ({ single: async () => (opts.insertError ? { data: null, error: { code: "x" } } : { data: { id: "00000000-0000-4000-8000-0000000000aa" }, error: null }) }) }
        },
        eq: (c: string, v: unknown) => ((rows = rows.filter((r) => r[c] === v)), b),
        in: (c: string, v: unknown[]) => ((rows = rows.filter((r) => v.includes(r[c]))), b),
        order: () => b,
        limit: (n: number) => ((rows = rows.slice(0, n)), b),
        then: (resolve: (v: unknown) => unknown) => resolve(opts.failTable === table ? { data: null, error: { code: "XX000" } } : { data: rows, error: null }),
      }
      return b
    },
  }
  return { service: service as never, calls }
}

describe("createAgentIdentity", () => {
  it("creates ONLY a disabled, shop-bound, owner-bound identity with an inert config", async () => {
    const { service, calls } = fakeService({ role: "owner" })
    const result = await createAgentIdentity({ service }, { shopId, actorId, name: "  Quote   follow-up " })
    expect(result).toEqual({ ok: true, agentId: "00000000-0000-4000-8000-0000000000aa" })
    expect(calls.inserts).toHaveLength(1)
    const row = calls.inserts[0] as Record<string, unknown> & { config: Record<string, unknown> }
    expect(row).toMatchObject({ shop_id: shopId, owner_id: actorId, enabled: false, name: "Quote follow-up" })
    expect(calls.rpc[0]).toEqual(["agent_definition_actor_role", { p_shop: shopId, p_actor: actorId }])
    // No authority rides along: nothing to run, nothing to call, no credential or prompt.
    expect(Object.keys(row).sort()).toEqual(["config", "description", "enabled", "name", "owner_id", "problem_text", "shop_id"])
    expect(row.config).not.toHaveProperty("recipe")
    expect(row.config).not.toHaveProperty("freeform")
    expect(row.config).not.toHaveProperty("schedule")
    expect(JSON.stringify(row)).not.toMatch(/token|secret|api[_-]?key|prompt|provider|openai|anthropic/i)
  })

  it("the inert config is a valid legacy shape that the legacy cards can read and the runtime cannot run", () => {
    const parsed = parseAgentConfig(inertLegacyConfig("Quote follow-up"))
    expect(parsed.ok).toBe(true)
    const config = inertLegacyConfig("Quote follow-up")
    expect(Boolean(config.recipe?.id || config.freeform)).toBe(false)
  })

  it.each([["manager"], ["staff"], [null]])("refuses a %s before any write", async (role) => {
    const { service, calls } = fakeService({ role })
    expect(await createAgentIdentity({ service }, { shopId, actorId, name: "Quote follow-up" })).toEqual({ ok: false, code: "forbidden" })
    expect(calls.inserts).toHaveLength(0)
    expect(calls.selects).toHaveLength(0)
  })

  it("is tenant-bound: an owner of another shop cannot create here", async () => {
    // The fake resolves the role only for `shopId`; naming another shop yields no role.
    const { service, calls } = fakeService({ role: "owner" })
    expect(await createAgentIdentity({ service }, { shopId: otherShop, actorId, name: "Quote follow-up" })).toEqual({ ok: false, code: "forbidden" })
    expect(calls.inserts).toHaveLength(0)
  })

  it("fails closed when the role cannot be read", async () => {
    const { service, calls } = fakeService({ roleError: true })
    expect(await createAgentIdentity({ service }, { shopId, actorId, name: "Quote follow-up" })).toEqual({ ok: false, code: "unavailable" })
    expect(calls.inserts).toHaveLength(0)
  })

  it.each([["ab"], ["x".repeat(AGENT_NAME_BOUNDS.max + 1)], ["bad\u0000name"], ["<script>alert(1)</script>"], ["zero​width"], ["   "], [""]])("rejects the invalid name %j without writing", async (name) => {
    const { service, calls } = fakeService({ role: "owner" })
    expect(await createAgentIdentity({ service }, { shopId, actorId, name })).toEqual({ ok: false, code: "invalid_name" })
    expect(calls.inserts).toHaveLength(0)
  })

  it.each([[undefined], [null], [42], [{}], [["a", "b", "c"]]])("rejects the non-string name %j", async (name) => {
    const { service, calls } = fakeService({ role: "owner" })
    expect(await createAgentIdentity({ service }, { shopId, actorId, name })).toEqual({ ok: false, code: "invalid_name" })
    expect(calls.inserts).toHaveLength(0)
  })

  it("is bounded per workspace", async () => {
    const { service, calls } = fakeService({ role: "owner", count: MAX_AGENT_IDENTITIES })
    expect(await createAgentIdentity({ service }, { shopId, actorId, name: "One more" })).toEqual({ ok: false, code: "limit_reached" })
    expect(calls.inserts).toHaveLength(0)
  })

  it("never reports success when the count or the insert fails", async () => {
    expect(await createAgentIdentity({ service: fakeService({ role: "owner", count: null }).service }, { shopId, actorId, name: "Quote follow-up" })).toEqual({ ok: false, code: "unavailable" })
    expect(await createAgentIdentity({ service: fakeService({ role: "owner", insertError: true }).service }, { shopId, actorId, name: "Quote follow-up" })).toEqual({ ok: false, code: "unavailable" })
  })

  it("collapses internal whitespace, including newlines, into single spaces", () => {
    expect(validateAgentName("new\n\n line\t name")).toEqual({ ok: true, name: "new line name" })
  })

  it("validates names exactly at the bounds", () => {
    expect(validateAgentName("a".repeat(AGENT_NAME_BOUNDS.min))).toEqual({ ok: true, name: "aaa" })
    expect(validateAgentName("a".repeat(AGENT_NAME_BOUNDS.max)).ok).toBe(true)
    expect(validateAgentName("a".repeat(AGENT_NAME_BOUNDS.min - 1)).ok).toBe(false)
    expect(validateAgentName("Détailing & Co. – #1 (north)")).toMatchObject({ ok: true })
  })
})

describe("readMemoryCatalog", () => {
  const future = new Date(Date.now() + 86_400_000).toISOString()
  const past = new Date(Date.now() - 86_400_000).toISOString()
  const S = (n: number) => `00000000-0000-4000-8000-00000000010${n}`
  const tables = () => ({
    reviewed_memory_sources: [
      { id: S(1), source_name: "Published", shop_id: shopId },
      { id: S(2), source_name: "Candidate", shop_id: shopId },
      { id: S(3), source_name: "Revoked", shop_id: shopId },
      { id: S(4), source_name: "Expired", shop_id: shopId },
      { id: S(5), source_name: "Empty", shop_id: shopId },
      { id: S(6), source_name: "Other shop source", shop_id: otherShop },
    ],
    reviewed_memory_active: [
      { shop_id: shopId, source_id: S(1), revision: 2 },
      { shop_id: shopId, source_id: S(4), revision: 1 },
    ],
    reviewed_memory_revisions: [
      { shop_id: shopId, source_id: S(1), revision: 2, state: "published", valid_from: past, valid_until: null, retention_until: null },
      { shop_id: shopId, source_id: S(2), revision: 1, state: "candidate", valid_from: past, valid_until: null, retention_until: null },
      { shop_id: shopId, source_id: S(3), revision: 1, state: "revoked", valid_from: past, valid_until: null, retention_until: null },
      { shop_id: shopId, source_id: S(4), revision: 1, state: "published", valid_from: past, valid_until: past, retention_until: future },
    ],
  })

  it("lists ids, names, revision and status only; only current published memory is selectable; other shops never appear", async () => {
    const { service, calls } = fakeService({ role: "manager", tables: tables() })
    const result = await readMemoryCatalog({ service }, { shopId, actorId })
    expect(result.status).toBe("ok")
    if (result.status !== "ok") return
    const byName = Object.fromEntries(result.data.sources.map((s) => [s.name, s]))
    expect(byName.Published).toMatchObject({ status: "selectable", memoryRevision: 2 })
    expect(byName.Candidate).toMatchObject({ status: "awaiting_review", memoryRevision: null })
    expect(byName.Revoked).toMatchObject({ status: "revoked", memoryRevision: null })
    expect(byName.Expired).toMatchObject({ status: "expired", memoryRevision: null })
    expect(byName.Empty).toMatchObject({ status: "not_published", memoryRevision: null })
    expect(byName).not.toHaveProperty("Other shop source")
    expect(Object.keys(result.data.sources[0]).sort()).toEqual(["memoryRevision", "name", "sourceId", "status"])
    // No body, hash, embedding or candidate text is ever selected.
    const columns = calls.selects.map((s) => s.columns).join(",")
    expect(columns).not.toMatch(/raw_content|content_hash|content\b|embedding|safety/)
    expect(JSON.stringify(result)).not.toMatch(/raw_content|embedding/)
  })

  it("is forbidden without a live membership and unavailable on any read error, never an empty catalog", async () => {
    expect(await readMemoryCatalog({ service: fakeService({ role: null, tables: tables() }).service }, { shopId, actorId })).toEqual({ status: "forbidden" })
    expect(await readMemoryCatalog({ service: fakeService({ roleError: true }).service }, { shopId, actorId })).toMatchObject({ status: "unavailable" })
    for (const failTable of ["reviewed_memory_sources", "reviewed_memory_active", "reviewed_memory_revisions"]) {
      const result = await readMemoryCatalog({ service: fakeService({ role: "owner", tables: tables(), failTable }).service }, { shopId, actorId })
      expect(result, failTable).toMatchObject({ status: "unavailable" })
    }
  })

  it("returns an honest empty catalog only when the read succeeded", async () => {
    const result = await readMemoryCatalog({ service: fakeService({ role: "owner", tables: { reviewed_memory_sources: [], reviewed_memory_active: [], reviewed_memory_revisions: [] } }).service }, { shopId, actorId })
    expect(result).toEqual({ status: "ok", data: { sources: [], truncated: false } })
  })
})

// ---------------------------------------------------------------------------
// The server actions: nothing tenant-shaped comes from the client.
// ---------------------------------------------------------------------------

const session = { user: { id: actorId }, shop: { id: shopId, name: "Shop" } }
const holder: { service: ReturnType<typeof fakeService>["service"] | null } = { service: null }

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/lib/shop", () => ({
  requireUser: async () => session.user,
  requireShop: async () => session.shop,
}))
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }))
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => holder.service }))
vi.mock("@/lib/commercial-billing-service", () => ({ readCommercialBillingDto: vi.fn(), resolveBillingRuntime: () => ({}) }))

describe("session-derived actions", () => {
  beforeEach(() => {
    holder.service = null
  })

  it("createGradiaAgentIdentity ignores any client-supplied shop or actor", async () => {
    const { service, calls } = fakeService({ role: "owner" })
    holder.service = service
    const { createGradiaAgentIdentity } = await import("@/app/actions/agent-definitions")
    const forged = { name: "Quote follow-up", shopId: otherShop, shop_id: otherShop, actorId: otherShop, owner_id: otherShop, enabled: true } as never
    const result = await createGradiaAgentIdentity(forged)
    expect(result.ok).toBe(true)
    expect(calls.inserts[0]).toMatchObject({ shop_id: shopId, owner_id: actorId, enabled: false })
    expect(calls.rpc[0]).toEqual(["agent_definition_actor_role", { p_shop: shopId, p_actor: actorId }])
  })

  it("createGradiaAgentIdentity refuses a non-owner and a malformed payload before any write", async () => {
    const { service, calls } = fakeService({ role: "staff" })
    holder.service = service
    const { createGradiaAgentIdentity } = await import("@/app/actions/agent-definitions")
    expect(await createGradiaAgentIdentity({ name: "Quote follow-up" })).toEqual({ ok: false, code: "forbidden" })
    expect(await createGradiaAgentIdentity({ name: 12 } as never)).toEqual({ ok: false, code: "invalid_name" })
    expect(await createGradiaAgentIdentity(undefined as never)).toEqual({ ok: false, code: "invalid_name" })
    expect(calls.inserts).toHaveLength(0)
  })

  it("getSelectableMemory reads only the session's shop", async () => {
    const { service, calls } = fakeService({ role: "owner", tables: { reviewed_memory_sources: [], reviewed_memory_active: [], reviewed_memory_revisions: [] } })
    holder.service = service
    const { getSelectableMemory } = await import("@/app/actions/agent-definitions")
    expect(await getSelectableMemory()).toMatchObject({ status: "ok" })
    expect(calls.rpc[0]).toEqual(["agent_definition_actor_role", { p_shop: shopId, p_actor: actorId }])
  })

  it("no exported action accepts a shop, actor or evidence argument", () => {
    const source = readFileSync("src/app/actions/agent-definitions.ts", "utf8")
    const signatures = [...source.matchAll(/export async function (\w+)\(([^)]*)\)/g)]
    expect(signatures.length).toBeGreaterThanOrEqual(10)
    for (const [, name, params] of signatures) {
      expect(params, name).not.toMatch(/shopId|shop_id|actorId|actor_id|policy|connector|billing|evaluation/i)
    }
    // The ONE evaluation action only REQUESTS the trusted evaluator: ids in, nothing evidence-shaped.
    const evaluationActions = [...source.matchAll(/export async function (\w*[Ee]valuation\w*)\(([^)]*)\)/g)]
    expect(evaluationActions.map((m) => m[1])).toEqual(["runAgentRevisionEvaluation"])
    expect(evaluationActions[0][2].replace(/\s+/g, " ")).toBe("input: { agentId: string; revision: number }")
    expect(source).not.toMatch(/recordTrustedAgentEvaluation\(|import[^;]*recordTrustedAgentEvaluation/)
  })
})
