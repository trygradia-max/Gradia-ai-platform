import { readFileSync } from "node:fs"
import type { SupabaseClient } from "@supabase/supabase-js"
import { describe, expect, it, vi } from "vitest"

import { assertGovernedRunCurrent, claimScheduledAgentRun, loadGovernedAgentStates } from "@/lib/agent-runs"
import {
  GOVERNED_EXECUTOR_ENABLED,
  governedWindowKey,
  runCustomAgent,
  runEventRecipe,
  runGovernedScheduledAgent,
} from "@/lib/agent-runtime"
import type { CustomAgentRow } from "@/lib/types/database"

const SHOP = "00000000-0000-4000-8000-000000000001"
const AGENT = "00000000-0000-4000-8000-000000000004"
const RUN = "00000000-0000-4000-8000-0000000000b1"
const EVAL = "00000000-0000-4000-8000-0000000000e1"
const NOW = new Date("2026-11-11T10:20:30.000Z")
const agent = { id: AGENT, shop_id: SHOP, name: "Governed agent", enabled: true, config: {} } as unknown as CustomAgentRow

const claimedReply = {
  outcome: "claimed", run_id: RUN, attempt: 1, shop_id: SHOP,
  definition_snapshot: { schemaVersion: 1 }, definition_hash: "a".repeat(64), policy_revision: 3, knowledge_revision: 1,
  governed: true, definition_revision: 2, evaluation_id: EVAL, memory_pins: [{ source_id: "s", memory_revision: 1, content_hash: "b".repeat(64) }], activation_event_seq: 4,
}

type Handlers = Record<string, (args: Record<string, unknown>) => { data?: unknown; error?: unknown }>
function fake(opts: { schedule?: unknown; revisionError?: boolean; states?: { agent_id: string; lifecycle: string; active_revision: number | null }[] | "error"; rpc: Handlers }) {
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = []
  const client = {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args })
      const h = opts.rpc[fn]
      if (!h) throw new Error(`unexpected rpc ${fn}`)
      const r = h(args)
      return { data: r.data ?? null, error: r.error ?? null }
    }),
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      const self = () => chain
      Object.assign(chain, {
        select: self, eq: self, in: async () => (opts.states === "error" ? { data: null, error: { message: "boom" } } : { data: opts.states ?? [], error: null }),
        maybeSingle: async () => (table === "agent_definition_revisions"
          ? opts.revisionError ? { data: null, error: { message: "boom" } } : { data: { definition: { schedule: opts.schedule ?? { kind: "interval", everyMinutes: 60 } } }, error: null }
          : { data: null, error: null }),
        insert: async () => ({ error: null }),
      })
      return chain
    },
  }
  return { client: client as unknown as SupabaseClient, rpcCalls }
}
const active = { lifecycle: "active", activeRevision: 2 }

describe("governed claim parsing", () => {
  const claim = (reply: unknown) => claimScheduledAgentRun({ rpc: async () => ({ data: reply, error: null }) } as unknown as SupabaseClient, { agentId: AGENT, triggerKey: "k", workerId: "w" })

  it("carries the exact binding for a governed claim and none for a legacy claim", async () => {
    const governed = await claim(claimedReply)
    expect(governed).toMatchObject({ outcome: "claimed", governed: { definitionRevision: 2, evaluationId: EVAL, activationEventSeq: 4 } })
    const legacy = await claim({ outcome: "claimed", run_id: RUN, attempt: 1, shop_id: SHOP, definition_snapshot: {}, definition_hash: "a".repeat(64), policy_revision: null, knowledge_revision: null })
    expect(legacy).not.toHaveProperty("governed")
  })

  it("a governed claim without its binding is an error, never a silent legacy claim", async () => {
    await expect(claim({ ...claimedReply, evaluation_id: null })).rejects.toThrow(/missing its binding/)
    await expect(claim({ ...claimedReply, memory_pins: null })).rejects.toThrow(/missing its binding/)
  })

  it("parses typed refusals and rejects an empty or malformed one", async () => {
    await expect(claim({ outcome: "refused", reasons: ["policy_changed", "memory_stale"] })).resolves.toEqual({ outcome: "refused", reasons: ["policy_changed", "memory_stale"] })
    await expect(claim({ outcome: "refused", reasons: [] })).rejects.toThrow(/invalid refusal/)
    await expect(claim({ outcome: "refused" })).rejects.toThrow(/invalid refusal/)
    await expect(claim({ outcome: "refused", reasons: [1] })).rejects.toThrow(/invalid refusal/)
  })
})

describe("assertGovernedRunCurrent", () => {
  const ask = (reply: { data?: unknown; error?: unknown }) => assertGovernedRunCurrent({ rpc: async () => ({ data: reply.data ?? null, error: reply.error ?? null }) } as unknown as SupabaseClient, { runId: RUN, workerId: "w", attempt: 1 })
  it("passes through the database answer", async () => {
    expect(await ask({ data: { current: true, governed: true, reasons: [] } })).toEqual({ current: true, governed: true, reasons: [] })
    expect(await ask({ data: { current: false, governed: true, reasons: ["pointer_changed"] } })).toEqual({ current: false, governed: true, reasons: ["pointer_changed"] })
    expect(await ask({ data: { current: true, governed: false, reasons: [] } })).toMatchObject({ governed: false, current: true })
  })
  it("an error or malformed answer is never 'current'", async () => {
    expect(await ask({ error: { message: "x" } })).toEqual({ current: false, governed: true, reasons: ["binding_unverifiable"] })
    expect(await ask({ data: { current: "yes", governed: true, reasons: [] } })).toMatchObject({ current: false })
    expect(await ask({ data: null })).toMatchObject({ current: false })
    expect(await ask({ data: { current: true, governed: true, reasons: [3] } })).toMatchObject({ current: false })
  })
})

describe("governed state lookup", () => {
  it("fails closed when it cannot tell (callers must not run the agent as legacy)", async () => {
    await expect(loadGovernedAgentStates(fake({ states: "error", rpc: {} }).client, [AGENT])).rejects.toThrow(/governed state lookup failed/)
    expect((await loadGovernedAgentStates(fake({ rpc: {} }).client, [])).size).toBe(0)
  })
})

describe("runGovernedScheduledAgent", () => {
  const key = governedWindowKey(60, NOW)
  const baseRpc = (over: Handlers = {}): Handlers => ({
    claim_scheduled_agent_run: () => ({ data: claimedReply }),
    assert_governed_run_current: () => ({ data: { current: true, governed: true, reasons: [] } }),
    finish_scheduled_agent_run: () => ({ data: true }),
    mark_scheduled_agent_run_unknown: () => ({ data: true }),
    ...over,
  })

  it("window keys are deterministic per interval window", () => {
    expect(key).toBe(governedWindowKey(60, new Date("2026-11-11T10:59:59.000Z")))
    expect(key).not.toBe(governedWindowKey(60, new Date("2026-11-11T11:00:00.000Z")))
    expect(governedWindowKey(15, NOW)).not.toBe(governedWindowKey(60, NOW))
  })

  it("claims the bound window, re-verifies, and finishes as SKIPPED while the governed executor is off", async () => {
    expect(GOVERNED_EXECUTOR_ENABLED).toBe(false)
    const f = fake({ rpc: baseRpc() })
    let ctx: unknown
    const outcome = await runGovernedScheduledAgent(f.client, agent, active, NOW, (c) => { ctx = c })
    expect(outcome).toMatchObject({ fired: false, reason: expect.stringContaining("bound to revision 2") })
    expect(f.rpcCalls.map((c) => c.fn)).toEqual(["claim_scheduled_agent_run", "assert_governed_run_current", "finish_scheduled_agent_run"])
    expect(f.rpcCalls[0].args).toMatchObject({ p_agent: AGENT, p_trigger_key: key })
    expect(f.rpcCalls[2].args).toMatchObject({ p_state: "skipped", p_fired: false, p_error_code: "governed_executor_disabled", p_pending_action_ids: [] })
    expect(ctx).toMatchObject({ runId: RUN, attempt: 1 })
  })

  it("a refused claim runs nothing and reports the reasons", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const f = fake({ rpc: baseRpc({ claim_scheduled_agent_run: () => ({ data: { outcome: "refused", reasons: ["policy_changed"] } }) }) })
    const outcome = await runGovernedScheduledAgent(f.client, agent, active, NOW, () => {})
    expect(outcome).toMatchObject({ fired: false, reason: "governed definition not runnable: policy_changed" })
    expect(f.rpcCalls.map((c) => c.fn)).toEqual(["claim_scheduled_agent_run"])
    warn.mockRestore()
  })

  it("a binding that is no longer current right after the claim is finished, not run", async () => {
    const f = fake({ rpc: baseRpc({ assert_governed_run_current: () => ({ data: { current: false, governed: true, reasons: ["pointer_changed"] } }) }) })
    const outcome = await runGovernedScheduledAgent(f.client, agent, active, NOW, () => {})
    expect(outcome).toMatchObject({ reason: "governed binding no longer current: pointer_changed" })
    expect(f.rpcCalls.at(-1)).toMatchObject({ fn: "finish_scheduled_agent_run", args: { p_error_code: "binding_not_current", p_state: "skipped" } })
  })

  it("a finish the database did not confirm becomes an unknown outcome", async () => {
    const f = fake({ rpc: baseRpc({ finish_scheduled_agent_run: () => ({ data: false }) }) })
    const outcome = await runGovernedScheduledAgent(f.client, agent, active, NOW, () => {})
    expect(outcome?.reason).toMatch(/reconciliation required/)
    expect(f.rpcCalls.at(-1)?.fn).toBe("mark_scheduled_agent_run_unknown")
  })

  it("duplicates and unknown windows never execute and never finish a run", async () => {
    for (const reply of [{ outcome: "active_duplicate", run_id: RUN, attempt: 1 }, { outcome: "terminal_duplicate", run_id: RUN, attempt: 1, state: "skipped" }, { outcome: "unknown", run_id: RUN, attempt: 1 }, { outcome: "agent_unavailable" }]) {
      const f = fake({ rpc: baseRpc({ claim_scheduled_agent_run: () => ({ data: reply }) }) })
      const outcome = await runGovernedScheduledAgent(f.client, agent, active, NOW, () => {})
      expect(outcome?.fired).toBe(false)
      expect(f.rpcCalls.map((c) => c.fn)).toEqual(["claim_scheduled_agent_run"])
    }
  })

  it("manual and event definitions, and non-active pointers, are never started by the cron tick", async () => {
    for (const schedule of [{ kind: "manual" }, { kind: "event", event: "lead.received" }]) {
      const f = fake({ schedule, rpc: baseRpc() })
      expect(await runGovernedScheduledAgent(f.client, agent, active, NOW, () => {})).toBeNull()
      expect(f.rpcCalls).toEqual([])
    }
    for (const state of [{ lifecycle: "paused", activeRevision: 2 }, { lifecycle: "blocked", activeRevision: 2 }, { lifecycle: "draft", activeRevision: null }, { lifecycle: "active", activeRevision: null }]) {
      const f = fake({ rpc: baseRpc() })
      expect(await runGovernedScheduledAgent(f.client, agent, state, NOW, () => {})).toBeNull()
      expect(f.rpcCalls).toEqual([])
    }
  })

  it("a claim for another shop, or without its binding, is an error after the context is exposed (so the crash handler can finish it)", async () => {
    for (const reply of [{ ...claimedReply, shop_id: "00000000-0000-4000-8000-0000000000ff" }]) {
      const f = fake({ rpc: baseRpc({ claim_scheduled_agent_run: () => ({ data: reply }) }) })
      let ctx: unknown = null
      await expect(runGovernedScheduledAgent(f.client, agent, active, NOW, (c) => { ctx = c })).rejects.toThrow(/different shop/)
      expect(ctx).toMatchObject({ runId: RUN })
    }
  })

  it("fails closed when the definition cannot be read", async () => {
    await expect(runGovernedScheduledAgent(fake({ revisionError: true, rpc: baseRpc() }).client, agent, active, NOW, () => {})).rejects.toThrow(/lookup failed/)
  })
})

describe("legacy run paths refuse governed agents and fail closed", () => {
  const governedStates = [{ agent_id: AGENT, lifecycle: "active", active_revision: 2 }]
  const shop = { id: SHOP } as never
  it("manual 'Run now' and event dispatch do not run a governed agent", async () => {
    const manual = await runCustomAgent(fake({ states: governedStates, rpc: {} }).client, agent)
    expect(manual).toMatchObject({ fired: false, reason: expect.stringContaining("governed definition") })
    const event = await runEventRecipe(fake({ states: governedStates, rpc: {} }).client, shop, agent, { kind: "lead.received" } as never)
    expect(event).toMatchObject({ fired: false, reason: expect.stringContaining("governed definition") })
  })
  it("if governance cannot be determined, nothing runs", async () => {
    expect(await runCustomAgent(fake({ states: "error", rpc: {} }).client, agent)).toMatchObject({ fired: false, reason: expect.stringContaining("could not verify") })
    expect(await runEventRecipe(fake({ states: "error", rpc: {} }).client, shop, agent, { kind: "lead.received" } as never)).toMatchObject({ fired: false, reason: expect.stringContaining("could not verify") })
  })
})

describe("source locks", () => {
  const runtime = readFileSync("src/lib/agent-runtime.ts", "utf8")
  it("the cron tick reads governed state before any handler and branches governed agents first", () => {
    const tick = runtime.slice(runtime.indexOf("export async function runScheduledAgents"))
    expect(tick.indexOf("loadGovernedAgentStates")).toBeGreaterThan(0)
    expect(tick.indexOf("loadGovernedAgentStates")).toBeLessThan(tick.indexOf("resolveScheduledHandler(agent)"))
    expect(tick.indexOf("governedStates.get(agent.id)")).toBeLessThan(tick.indexOf("resolveScheduledHandler(agent)"))
  })
  it("the governed branch never imports a handler, sender, model or meter", () => {
    const branch = runtime.slice(runtime.indexOf("export async function runGovernedScheduledAgent"), runtime.indexOf("export async function runCustomAgent") > 0 ? runtime.indexOf("/**\n * One-shot fire of a single agent") : undefined)
    expect(branch).not.toMatch(/RECIPE_HANDLERS|handler\(|maybeAutoExecute|meterDrafts|stampFired|recordUsage|fetch\(|anthropic|openai/i)
  })
})
