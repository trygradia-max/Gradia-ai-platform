import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

import { createAgentDefinitionRevision } from "@/lib/agent-os/definition-store"

const shopId = "00000000-0000-4000-8000-000000000001"
const actorId = "00000000-0000-4000-8000-000000000002"
const agentId = "00000000-0000-4000-8000-000000000004"
const requestId = "00000000-0000-4000-8000-0000000000a1"

const definition = {
  schemaVersion: 1,
  key: "quote-follow-up-000000",
  job: { roleLabel: "Quote follow-up", goal: "Follow up with quiet quotes and draft a message.", expectedOutcomes: ["Every quiet quote gets a draft"], stopConditions: ["Customer asks to stop"] },
  knowledge: { sourceIds: [], includeShopKnowledge: false, includeCustomerMemory: false, maxResultsPerQuery: 4 },
  tools: [],
  schedule: { kind: "manual" },
  limits: { maximumStepsPerRun: 5, maximumRuntimeSeconds: 60, maximumCreditsPerRun: 10, maximumRunsPerDay: 10, maximumConcurrentRuns: 1 },
  routing: { strategy: "cost_aware", semanticCache: false },
}

type RpcArgs = Record<string, unknown>
/** The database decides expected-latest atomically; the store only passes it through and maps the answer. */
function fake(respond: (args: RpcArgs) => { data?: unknown; error?: { code: string } }) {
  const calls: { fn: string; args: RpcArgs }[] = []
  const service = {
    rpc: async (fn: string, args: RpcArgs) => {
      calls.push({ fn, args })
      const r = respond(args)
      return { data: r.data ?? null, error: r.error ?? null }
    },
    from: () => {
      throw new Error("the store must not read agent state before the atomic RPC")
    },
  }
  return { service: service as never, calls }
}
const created = (revision: number) => ({ data: { outcome: "created", revision, definition_hash: "a".repeat(64), parent_revision: revision > 1 ? revision - 1 : null } })

const save = (deps: ReturnType<typeof fake>, over: Record<string, unknown> = {}) =>
  createAgentDefinitionRevision({ service: deps.service }, { shopId, actorId, agentId, requestId, definition, ...over })

describe("expected-latest is decided inside the database, not by a pre-read", () => {
  it("passes the editor's latest revision to the RPC and makes exactly one call", async () => {
    const deps = fake(() => created(3))
    expect(await save(deps, { parentRevision: 2, expectedLatest: 2 })).toMatchObject({ ok: true, outcome: "created", revision: 3 })
    expect(deps.calls).toHaveLength(1)
    expect(deps.calls[0]).toMatchObject({ fn: "agent_definition_create_revision", args: { p_parent: 2, p_expected_latest: 2 } })
  })

  it("'nothing saved yet' is sent as 0, and 'not stated' as null (Build 1 behavior)", async () => {
    const first = fake(() => created(1))
    await save(first, { expectedLatest: null })
    expect(first.calls[0].args.p_expected_latest).toBe(0)
    const unstated = fake(() => created(6))
    await save(unstated, { parentRevision: 1 })
    expect(unstated.calls[0].args.p_expected_latest).toBeNull()
  })

  it("a stale_latest answer is a conflict and carries no revision", async () => {
    const deps = fake(() => ({ data: { outcome: "blocked", code: "stale_latest", latest_revision: 3 } }))
    expect(await save(deps, { parentRevision: 1, expectedLatest: 1 })).toEqual({ ok: false, code: "conflict" })
  })

  it("a replay of an already-recorded request still succeeds (the database replays before it compares)", async () => {
    const deps = fake(() => ({ data: { outcome: "replayed", revision: 2, definition_hash: "a".repeat(64), parent_revision: 1 } }))
    expect(await save(deps, { parentRevision: 1, expectedLatest: 1 })).toMatchObject({ ok: true, outcome: "replayed", revision: 2 })
  })

  it("a changed replay (AD409) is a conflict", async () => {
    expect(await save(fake(() => ({ error: { code: "AD409" } })), { expectedLatest: 1 })).toEqual({ ok: false, code: "conflict" })
  })

  it("non-owners are refused by the database authority check", async () => {
    expect(await save(fake(() => ({ error: { code: "42501" } })), { expectedLatest: 2 })).toEqual({ ok: false, code: "forbidden" })
  })

  it("fails closed when the RPC is unavailable", async () => {
    expect(await save(fake(() => ({ error: { code: "XX000" } })), { expectedLatest: 2 })).toEqual({ ok: false, code: "unavailable" })
  })

  it("the migration compares under the agent and state locks, after replay, and locks the privileges down", () => {
    const sql = readFileSync("supabase/migrations/20261110120000_agent_definition_atomic_expected_latest.sql", "utf8")
    const lockState = sql.indexOf("FROM public.agent_definition_state WHERE agent_id = p_agent FOR UPDATE")
    const replay = sql.indexOf("'replayed'")
    const compare = sql.indexOf("p_expected_latest <> st.latest_revision")
    const allocate = sql.indexOf("v_next := st.latest_revision + 1")
    expect(lockState).toBeGreaterThan(0)
    expect(lockState).toBeLessThan(replay)
    expect(replay).toBeLessThan(compare)
    expect(compare).toBeLessThan(allocate)
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.agent_definition_create_revision\(uuid, uuid, uuid, uuid, jsonb, integer, integer\)\s+FROM PUBLIC, anon, authenticated, service_role/)
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.agent_definition_create_revision\(uuid, uuid, uuid, uuid, jsonb, integer, integer\)\s+TO service_role/)
    expect(sql).toContain("DROP FUNCTION public.agent_definition_create_revision(uuid, uuid, uuid, uuid, jsonb, integer);")
  })
})
