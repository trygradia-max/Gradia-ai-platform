import { describe, expect, it } from "vitest"

import { readAgentsHomeDto } from "@/lib/agent-os/definition-store"

/**
 * The Agents home must report EXACT per-agent values even when one agent has far more
 * than 500 rows. The fake mimics PostgREST: filters, order, keyset `gt`, `limit`, and a
 * hard 1,000-row response cap.
 */
const shopId = "00000000-0000-4000-8000-000000000001"
const actorId = "00000000-0000-4000-8000-000000000002"
const busy = "00000000-0000-4000-8000-0000000000a1"
const quiet = "00000000-0000-4000-8000-0000000000a2"
const uuid = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`

type Row = Record<string, unknown>
type Tables = Record<string, Row[]>

function fakeService(tables: Tables, opts: { failTable?: string; failAfterCalls?: number } = {}) {
  const calls: Record<string, number> = {}
  const from = (table: string) => {
    calls[table] = (calls[table] ?? 0) + 1
    let rows = [...(tables[table] ?? [])]
    let max = 1000
    const order: { col: string; asc: boolean }[] = []
    const fails = () => opts.failTable === table && calls[table] > (opts.failAfterCalls ?? 0)
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (c: string, v: unknown) => ((rows = rows.filter((r) => r[c] === v)), b),
      gt: (c: string, v: string) => ((rows = rows.filter((r) => String(r[c]) > v)), b),
      in: (c: string, v: unknown[]) => ((rows = rows.filter((r) => v.includes(r[c]))), b),
      not: (c: string, op: string, v: unknown) => {
        if (op === "is") rows = rows.filter((r) => r[c] !== null && r[c] !== undefined)
        if (op === "eq" && v === "{}") rows = rows.filter((r) => Array.isArray(r[c]) && (r[c] as unknown[]).length > 0)
        return b
      },
      order: (col: string, o?: { ascending?: boolean }) => ((order.push({ col, asc: o?.ascending !== false }), b)),
      limit: (n: number) => ((max = Math.min(n, 1000)), b),
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => {
        if (fails()) return resolve({ data: null, error: { code: "XX000" } })
        const sorted = [...rows]
        for (const { col, asc } of [...order].reverse()) {
          sorted.sort((x, y) => (String(x[col]) < String(y[col]) ? -1 : String(x[col]) > String(y[col]) ? 1 : 0) * (asc ? 1 : -1))
        }
        return resolve({ data: sorted.slice(0, max), error: null })
      },
    }
    return b
  }
  return { from, rpc: async () => ({ data: "owner", error: null }) } as never
}

const baseTables = (): Tables => ({
  custom_agents: [
    { id: busy, name: "Busy", enabled: false, shop_id: shopId, created_at: "2026-01-01" },
    { id: quiet, name: "Quiet", enabled: false, shop_id: shopId, created_at: "2026-01-02" },
  ],
  agent_definition_state: [],
  agent_definition_revisions: [],
  custom_agent_runs: [],
  pending_actions: [],
})

describe("Agents home aggregation is exact beyond 500 rows", () => {
  it("finds an older agent's last confirmed run behind 1,300 newer runs of another agent", async () => {
    const t = baseTables()
    for (let i = 0; i < 1300; i++) {
      t.custom_agent_runs.push({ id: uuid(i + 1), shop_id: shopId, agent_id: busy, state: "succeeded", fired: true, finished_at: `2026-06-01T00:${String(i % 60).padStart(2, "0")}:00Z`, pending_action_ids: [] })
    }
    t.custom_agent_runs.push({ id: uuid(9000), shop_id: shopId, agent_id: quiet, state: "succeeded", fired: true, finished_at: "2026-02-01T00:00:00Z", pending_action_ids: [] })
    const home = await readAgentsHomeDto({ service: fakeService(t) }, { shopId, actorId })
    expect(home.status).toBe("ok")
    if (home.status !== "ok") return
    const byId = new Map(home.data.agents.map((a) => [a.agentId, a]))
    expect(byId.get(quiet)?.lastConfirmedRun).toEqual({ runId: uuid(9000), finishedAt: "2026-02-01T00:00:00Z" })
    expect(byId.get(busy)?.lastConfirmedRun?.finishedAt).toBe("2026-06-01T00:59:00Z")
  })

  it("counts pending approvals attached to runs older than the newest 500, per agent", async () => {
    const t = baseTables()
    // 700 pending approvals belong to the quiet agent's OLD runs; the busy agent has 900 newer runs.
    for (let i = 0; i < 900; i++) {
      t.custom_agent_runs.push({ id: uuid(5000 + i), shop_id: shopId, agent_id: busy, created_at: "2026-09-01", pending_action_ids: [] })
    }
    for (let i = 0; i < 700; i++) {
      t.custom_agent_runs.push({ id: uuid(100 + i), shop_id: shopId, agent_id: quiet, created_at: "2026-01-01", pending_action_ids: [uuid(20000 + i)] })
      t.pending_actions.push({ id: uuid(20000 + i), shop_id: shopId, status: i < 650 ? "pending" : "approved" })
    }
    t.custom_agent_runs.push({ id: uuid(9100), shop_id: shopId, agent_id: busy, created_at: "2026-09-02", pending_action_ids: [uuid(30000)] })
    t.pending_actions.push({ id: uuid(30000), shop_id: shopId, status: "pending" })
    const home = await readAgentsHomeDto({ service: fakeService(t) }, { shopId, actorId })
    expect(home.status).toBe("ok")
    if (home.status !== "ok") return
    const byId = new Map(home.data.agents.map((a) => [a.agentId, a]))
    expect(byId.get(quiet)?.needsReviewCount).toBe(650)
    expect(byId.get(busy)?.needsReviewCount).toBe(1)
  })

  it("never turns a failed or incomplete read into zero or 'none'", async () => {
    const t = baseTables()
    for (let i = 0; i < 600; i++) {
      t.custom_agent_runs.push({ id: uuid(i + 1), shop_id: shopId, agent_id: quiet, pending_action_ids: [uuid(40000 + i)] })
      t.pending_actions.push({ id: uuid(40000 + i), shop_id: shopId, status: "pending" })
    }
    // Page 1 of runs succeeds, page 2 errors: the count is null, not 500.
    const midway = await readAgentsHomeDto({ service: fakeService(t, { failTable: "custom_agent_runs", failAfterCalls: 3 }) }, { shopId, actorId })
    expect(midway.status === "ok" ? midway.data.agents.map((a) => a.needsReviewCount) : "x").toEqual([null, null])
    // A failed confirmed-run read makes the whole home unavailable rather than lastConfirmedRun: null.
    const broken = await readAgentsHomeDto({ service: fakeService(t, { failTable: "custom_agent_runs" }) }, { shopId, actorId })
    expect(broken.status).toBe("unavailable")
    // A failed pending_actions read is null too.
    const pendingDown = await readAgentsHomeDto({ service: fakeService(t, { failTable: "pending_actions" }) }, { shopId, actorId })
    expect(pendingDown.status === "ok" ? pendingDown.data.agents.map((a) => a.needsReviewCount) : "x").toEqual([null, null])
  })
})
