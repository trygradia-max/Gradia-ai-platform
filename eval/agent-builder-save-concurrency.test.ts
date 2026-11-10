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

function fake(opts: { role?: string | null; latest?: number | null; existingRequest?: boolean; stateError?: boolean }) {
  const rpcs: string[] = []
  const service = {
    rpc: async (fn: string) => {
      rpcs.push(fn)
      if (fn === "agent_definition_actor_role") return { data: opts.role ?? "owner", error: null }
      return { data: { outcome: "created", revision: (opts.latest ?? 0) + 1, definition_hash: "a".repeat(64), parent_revision: opts.latest ?? null }, error: null }
    },
    from: (table: string) => ({
      select: () => ({
        eq: function () { return this },
        maybeSingle: async () => {
          if (table === "agent_definition_revisions") return { data: opts.existingRequest ? { revision: 2 } : null, error: null }
          if (opts.stateError) return { data: null, error: { code: "x" } }
          return { data: opts.latest === null || opts.latest === undefined ? null : { agent_id: agentId, latest_revision: opts.latest, lifecycle: "draft", active_revision: null, lifecycle_reason: null, version: 1 }, error: null }
        },
      }),
    }),
  }
  return { service: service as never, rpcs }
}

const save = (deps: ReturnType<typeof fake>, over: Record<string, unknown> = {}) =>
  createAgentDefinitionRevision({ service: deps.service }, { shopId, actorId, agentId, requestId, definition, ...over })

describe("stale-view detection on save", () => {
  it("saves when the editor's latest matches the server's latest", async () => {
    const deps = fake({ latest: 2 })
    expect(await save(deps, { parentRevision: 2, expectedLatest: 2 })).toMatchObject({ ok: true, outcome: "created" })
    expect(deps.rpcs).toContain("agent_definition_create_revision")
  })

  it("the first save (nothing yet) succeeds only if nothing exists", async () => {
    expect(await save(fake({ latest: null }), { expectedLatest: null })).toMatchObject({ ok: true })
    const raced = fake({ latest: 1 })
    expect(await save(raced, { expectedLatest: null })).toEqual({ ok: false, code: "conflict" })
    expect(raced.rpcs).not.toContain("agent_definition_create_revision")
  })

  it("a stale tab conflicts and writes nothing, instead of silently becoming the new latest", async () => {
    const deps = fake({ latest: 3 })
    expect(await save(deps, { parentRevision: 1, expectedLatest: 1 })).toEqual({ ok: false, code: "conflict" })
    expect(deps.rpcs).not.toContain("agent_definition_create_revision")
  })

  it("a retry of a request that already exists is left to the database (replay), even though latest moved", async () => {
    const deps = fake({ latest: 2, existingRequest: true })
    expect(await save(deps, { parentRevision: 1, expectedLatest: 1 })).toMatchObject({ ok: true })
    expect(deps.rpcs).toContain("agent_definition_create_revision")
  })

  it("is not enforced when the caller does not state its view (Build 1 behavior unchanged)", async () => {
    const deps = fake({ latest: 5 })
    expect(await save(deps, { parentRevision: 1 })).toMatchObject({ ok: true })
  })

  it("non-owners are refused before anything is read about the agent", async () => {
    const deps = fake({ role: "manager", latest: 2 })
    expect(await save(deps, { expectedLatest: 2 })).toEqual({ ok: false, code: "forbidden" })
    expect(deps.rpcs).toEqual(["agent_definition_actor_role"])
  })

  it("fails closed when the latest revision cannot be read", async () => {
    const deps = fake({ latest: 2, stateError: true })
    expect(await save(deps, { expectedLatest: 2 })).toEqual({ ok: false, code: "unavailable" })
    expect(deps.rpcs).not.toContain("agent_definition_create_revision")
  })
})
