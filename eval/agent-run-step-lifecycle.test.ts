import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import type { SupabaseClient } from "@supabase/supabase-js"
import { describe, expect, it, vi } from "vitest"

import { recheckBeforeEffect, REQUIRED_CHECKS, type EffectCheckResolvers } from "@/lib/agent-os/pre-effect-checks"
import { runPlaybook, type EffectOutcome, type Playbook, type RunClaim } from "@/lib/agent-os/run-executor"
import {
  beginCommandAttempt,
  beginStep,
  claimResumableRun,
  heartbeatRun,
  payloadHash,
  recordAttemptResult,
  recoverStaleRuns,
  registerCommand,
  requestRunControl,
  resolveReconciliation,
  type PreEffectCheck,
  type RunLease,
} from "@/lib/agent-os/run-lifecycle"
import { GOVERNED_EXECUTOR_ENABLED } from "@/lib/agent-runtime"

const lease: RunLease = { runId: "11111111-1111-4111-8111-111111111111", workerId: "22222222-2222-4222-8222-222222222222", attempt: 1 }

type Answer = { data?: unknown; error?: { code?: string; message: string } | null }
/** A scripted client: answers by function name and records the order of calls. */
function fake(answers: Record<string, Answer | ((args: Record<string, unknown>) => Answer)>) {
  const calls: { fn: string; args: Record<string, unknown> }[] = []
  const client = {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args })
      const a = answers[fn]
      if (a === undefined) return { data: null, error: { message: `unscripted ${fn}` } }
      const r = typeof a === "function" ? a(args) : a
      return { data: r.data ?? null, error: r.error ?? null }
    }),
  }
  return { db: client as unknown as SupabaseClient, calls }
}

describe("payloadHash", () => {
  it("ignores key order at every depth and changes with any content", () => {
    expect(payloadHash({ a: 1, b: { c: [1, { y: 1, x: 2 }], d: null } })).toBe(payloadHash({ b: { d: null, c: [1, { x: 2, y: 1 }] }, a: 1 }))
    expect(payloadHash({ a: 1 })).not.toBe(payloadHash({ a: 2 }))
    expect(payloadHash({ a: [1, 2] })).not.toBe(payloadHash({ a: [2, 1] }))
    expect(payloadHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("lifecycle wrappers fail closed", () => {
  it("heartbeat: an error, a missing field or a throw is never alive", async () => {
    expect(await heartbeatRun(fake({ heartbeat_agent_run: { error: { message: "down" } } }).db, lease)).toMatchObject({ alive: false })
    expect(await heartbeatRun(fake({ heartbeat_agent_run: { data: {} } }).db, lease)).toMatchObject({ alive: false })
    const throwing = { rpc: async () => { throw new Error("network") } } as unknown as SupabaseClient
    expect(await heartbeatRun(throwing, lease)).toMatchObject({ alive: false, reason: "heartbeat_unverifiable" })
    expect(await heartbeatRun(fake({ heartbeat_agent_run: { data: { alive: true, control: "cancel" } } }).db, lease)).toEqual({ alive: true, control: "cancel" })
  })

  it("steps and commands: an unverifiable answer is a refusal, never an admission", async () => {
    expect(await beginStep(fake({ begin_agent_run_step: { error: { message: "x" } } }).db, lease, { key: "a", kind: "read" })).toMatchObject({ outcome: "refused" })
    expect(await beginStep(fake({ begin_agent_run_step: { data: { outcome: "started" } } }).db, lease, { key: "a", kind: "read" })).toMatchObject({ outcome: "refused" }) // no step id
    expect(await registerCommand(fake({ register_agent_command: { data: { outcome: "registered", command_id: "c" } } }).db, lease, { stepKey: "a", commandKey: "c", operation: "crm.edit", intent: "stage", payload: {} })).toMatchObject({ outcome: "refused" }) // no idempotency key
    for (const data of [{ outcome: "started" }, { outcome: "started", attempt_id: "a", idempotency_key: "k" }, { outcome: "nonsense" }, {}]) {
      const r = await beginCommandAttempt(fake({ begin_agent_command_attempt: { data } }).db, lease, "cmd", [])
      expect(r.outcome, JSON.stringify(data)).toBe("refused")
    }
    expect(await beginCommandAttempt(fake({ begin_agent_command_attempt: { error: { message: "x" } } }).db, lease, "cmd", [])).toMatchObject({ outcome: "refused", reasons: ["lifecycle_unverifiable"] })
  })

  it("results, control, resume and recovery never invent success", async () => {
    expect(await recordAttemptResult(fake({ record_agent_attempt_result: { error: { message: "x" } } }).db, lease, "a", { result: "unknown" })).toEqual({ recorded: false, reason: "lifecycle_unverifiable" })
    expect(await recordAttemptResult(fake({ record_agent_attempt_result: { data: { outcome: "recorded", state: "weird" } } }).db, lease, "a", { result: "unknown" })).toMatchObject({ recorded: false })
    const sent = fake({ record_agent_attempt_result: { data: { outcome: "recorded", state: "succeeded" } } })
    await recordAttemptResult(sent.db, lease, "a", { result: "succeeded", providerRef: "r", cancel: "not_cancellable" })
    expect(sent.calls[0].args).toMatchObject({ p_result: "succeeded", p_provider_ref: "r", p_cancel_state: "not_cancellable" })

    const base = { shopId: "s", runId: "r", kind: "pause" as const, reason: "x", actorId: "u" }
    expect(await requestRunControl(fake({ request_agent_run_control: { error: { code: "42501", message: "no" } } }).db, base)).toEqual({ outcome: "forbidden" })
    expect(await requestRunControl(fake({ request_agent_run_control: { error: { code: "XX000", message: "no" } } }).db, base)).toEqual({ outcome: "unavailable" })
    expect(await requestRunControl(fake({ request_agent_run_control: { data: { outcome: "acknowledged" } } }).db, base)).toEqual({ outcome: "unavailable" }) // missing control/state
    expect(await requestRunControl(fake({ request_agent_run_control: { data: { outcome: "requested", control: "pause", state: "running" } } }).db, base)).toEqual({ outcome: "requested", control: "pause", state: "running" })

    await expect(claimResumableRun(fake({ claim_resumable_agent_run: { error: { message: "x" } } }).db, { workerId: "w" })).rejects.toThrow()
    await expect(claimResumableRun(fake({ claim_resumable_agent_run: { data: { outcome: "claimed", run_id: "r" } } }).db, { workerId: "w" })).rejects.toThrow()
    expect(await claimResumableRun(fake({ claim_resumable_agent_run: { data: { outcome: "none" } } }).db, { workerId: "w" })).toEqual({ outcome: "none" })
    await expect(recoverStaleRuns(fake({ recover_stale_agent_runs: { error: { message: "x" } } }).db)).rejects.toThrow()
    expect(await recoverStaleRuns(fake({ recover_stale_agent_runs: { data: { recovered: { unknown: 2, bad: "x" }, escalated: 1 } } }).db)).toEqual({ recovered: { unknown: 2 }, escalated: 1 })
    expect(await resolveReconciliation(fake({ resolve_agent_command_reconciliation: { error: { code: "22023", message: "x" } } }).db, { shopId: "s", actorId: "a", commandId: "c", resolution: "effect_confirmed", note: "" })).toEqual({ outcome: "invalid" })
  })
})

describe("recheckBeforeEffect", () => {
  const input = { shopId: "s", agentId: "a", commandId: "c", operation: "crm.edit" as const, intent: "stage" as const, payloadHash: "0".repeat(64), approvalRequired: false, tools: [], boundPolicyRevision: 1 }
  const resolvers = (over: Partial<Record<(typeof REQUIRED_CHECKS)[number], () => Promise<PreEffectCheck>>> = {}): EffectCheckResolvers =>
    Object.fromEntries(REQUIRED_CHECKS.map((n) => [n, over[n] ?? (async () => ({ name: n, status: "pass" }) as PreEffectCheck)])) as unknown as EffectCheckResolvers

  it("always returns exactly the six required checks, in a fixed order, and runs policy after its inputs", async () => {
    const order: string[] = []
    const track = (n: (typeof REQUIRED_CHECKS)[number]) => async () => { order.push(n); return { name: n, status: "pass" } as PreEffectCheck }
    const out = await recheckBeforeEffect(resolvers(Object.fromEntries(REQUIRED_CHECKS.map((n) => [n, track(n)])) as never), input)
    expect(out.map((c) => c.name)).toEqual([...REQUIRED_CHECKS])
    expect(order.indexOf("policy")).toBeGreaterThan(order.indexOf("readiness"))
    expect(order.indexOf("policy")).toBeGreaterThan(order.indexOf("approval"))
  })

  it("turns a throw, a wrong name or an invalid status into unknown (which the database refuses)", async () => {
    const out = await recheckBeforeEffect(resolvers({
      consent: async () => { throw new Error("boom") },
      readiness: async () => ({ name: "budget", status: "pass" }),
      budget: async () => ({ name: "budget", status: "yes" as never }),
    }), input)
    expect(out.find((c) => c.name === "consent")).toMatchObject({ status: "unknown", code: "check_unavailable" })
    expect(out.find((c) => c.name === "readiness")).toMatchObject({ status: "unknown", code: "invalid_result" })
    expect(out.find((c) => c.name === "budget")).toMatchObject({ status: "unknown", code: "invalid_result" })
    expect(out.every((c) => c.status !== "pass" || ["policy", "approval", "grants"].includes(c.name))).toBe(true)
  })
})

describe("runPlaybook call ordering (scripted database)", () => {
  const claim: RunClaim = { lease, shopId: "s", agentId: "a", definitionSnapshot: { tools: [{ operation: "crm.edit", maximumMode: "approval" }] }, policyRevision: 1 }
  const checks = Object.fromEntries(REQUIRED_CHECKS.map((n) => [n, async () => ({ name: n, status: n === "consent" || n === "approval" ? "not_applicable" : "pass" }) as PreEffectCheck])) as unknown as EffectCheckResolvers
  const happy = (over: Record<string, Answer | ((a: Record<string, unknown>) => Answer)> = {}) => fake({
    heartbeat_agent_run: { data: { alive: true, control: null } },
    begin_agent_run_step: { data: { outcome: "started", step_id: "step" } },
    register_agent_command: { data: { outcome: "registered", command_id: "cmd", state: "pending", idempotency_key: "k".repeat(64) } },
    begin_agent_command_attempt: { data: { outcome: "started", attempt_id: "att", attempt_number: 1, idempotency_key: "k".repeat(64) } },
    record_agent_attempt_result: (a) => ({ data: { outcome: "recorded", state: a.p_result, run_state: a.p_result === "unknown" ? "unknown" : "running" } }),
    finish_agent_run_step: { data: true },
    finish_scheduled_agent_run: { data: true },
    ...over,
  })
  const playbook = (effect: () => Promise<EffectOutcome>): Playbook => ({
    steps: [{ key: "send", kind: "effect", run: async (s) => ((await s.command({ commandKey: "c1", operation: "crm.edit", intent: "stage", payload: { a: 1 }, safetyVerified: true }, effect)).outcome === "done" ? { kind: "done" } : { kind: "halt" }) }],
  })
  const order = (calls: { fn: string }[]) => calls.map((c) => c.fn)

  it("persists the attempt BEFORE the effect and records the result AFTER, then finishes", async () => {
    const f = happy()
    const seen: string[] = []
    const effect = vi.fn(async (): Promise<EffectOutcome> => { seen.push(order(f.calls).join(",")); return { kind: "accepted", providerRef: "ref" } })
    expect(await runPlaybook({ db: f.db, checks }, claim, playbook(effect))).toEqual({ state: "succeeded" })
    expect(effect).toHaveBeenCalledTimes(1)
    expect(seen[0].endsWith("begin_agent_command_attempt")).toBe(true) // the last durable write before the provider call
    expect(order(f.calls)).toEqual([
      "heartbeat_agent_run", "begin_agent_run_step", "register_agent_command", "begin_agent_command_attempt",
      "record_agent_attempt_result", "finish_agent_run_step", "finish_scheduled_agent_run",
    ])
  })

  it("never calls the provider when the database refuses the attempt", async () => {
    const f = happy({ begin_agent_command_attempt: { data: { outcome: "refused", reasons: ["check_failed_consent"] } } })
    const effect = vi.fn(async (): Promise<EffectOutcome> => ({ kind: "accepted", providerRef: "x" }))
    const out = await runPlaybook({ db: f.db, checks }, claim, playbook(effect))
    expect(effect).not.toHaveBeenCalled()
    expect(out.state).toBe("lease_lost") // halted without a success claim
    expect(order(f.calls)).not.toContain("record_agent_attempt_result")
    expect(order(f.calls)).not.toContain("finish_scheduled_agent_run")
  })

  it("never calls the provider when the application checks fail, and sends the failing evidence to the database", async () => {
    const f = happy({ begin_agent_command_attempt: (a) => ({ data: { outcome: "refused", reasons: ["seen"], echoed: a.p_checks } }) })
    const failing = { ...checks, consent: async () => ({ name: "consent", status: "fail", code: "send_not_permitted" }) as PreEffectCheck }
    const effect = vi.fn(async (): Promise<EffectOutcome> => ({ kind: "accepted", providerRef: "x" }))
    await runPlaybook({ db: f.db, checks: failing }, claim, playbook(effect))
    expect(effect).not.toHaveBeenCalled()
    const begin = f.calls.find((c) => c.fn === "begin_agent_command_attempt")!
    expect((begin.args.p_checks as PreEffectCheck[]).find((c) => c.name === "consent")).toMatchObject({ status: "fail" })
  })

  it("a thrown effect is recorded as UNKNOWN, never failed, and the run is not finished", async () => {
    const f = happy()
    const out = await runPlaybook({ db: f.db, checks }, claim, playbook(async () => { throw new Error("socket hang up") }))
    expect(out.state).toBe("unknown")
    expect(f.calls.find((c) => c.fn === "record_agent_attempt_result")!.args).toMatchObject({ p_result: "unknown" })
    expect(order(f.calls)).not.toContain("finish_scheduled_agent_run")
  })

  it("accepted without a reference is UNKNOWN; a rejection is the only 'no effect' claim", async () => {
    const a = happy()
    expect((await runPlaybook({ db: a.db, checks }, claim, playbook(async () => ({ kind: "accepted", providerRef: "" })))).state).toBe("unknown")
    expect(a.calls.find((c) => c.fn === "record_agent_attempt_result")!.args).toMatchObject({ p_result: "unknown" })
    const r = happy()
    await runPlaybook({ db: r.db, checks }, claim, playbook(async () => ({ kind: "rejected", providerStatus: "invalid_number" })))
    expect(r.calls.find((c) => c.fn === "record_agent_attempt_result")!.args).toMatchObject({ p_result: "rejected" })
  })

  it("if the result cannot be recorded the run is left untouched for lease expiry to classify", async () => {
    const f = happy({ record_agent_attempt_result: { error: { message: "db down" } } })
    const out = await runPlaybook({ db: f.db, checks }, claim, playbook(async () => ({ kind: "accepted", providerRef: "ref" })))
    expect(out.state).toBe("unknown")
    expect(order(f.calls)).not.toContain("finish_scheduled_agent_run")
    expect(order(f.calls)).not.toContain("finish_agent_run_step")
  })

  it("a lost lease stops before any step; a pending pause is acknowledged before the next step", async () => {
    const lost = happy({ heartbeat_agent_run: { data: { alive: false, reason: "run_not_owned" } } })
    expect(await runPlaybook({ db: lost.db, checks }, claim, playbook(vi.fn()))).toMatchObject({ state: "lease_lost" })
    expect(order(lost.calls)).toEqual(["heartbeat_agent_run"])

    const pause = happy({
      heartbeat_agent_run: { data: { alive: true, control: "pause" } },
      acknowledge_agent_run_control: { data: { outcome: "acknowledged", state: "paused" } },
    })
    const effect = vi.fn()
    expect(await runPlaybook({ db: pause.db, checks }, claim, playbook(effect))).toEqual({ state: "paused" })
    expect(effect).not.toHaveBeenCalled()
    expect(order(pause.calls)).toEqual(["heartbeat_agent_run", "acknowledge_agent_run_control"])
  })

  it("a refused step (binding, limit) fails the run with a known state and runs nothing", async () => {
    const f = happy({ begin_agent_run_step: { data: { outcome: "refused", reasons: ["policy_changed"] } } })
    const effect = vi.fn()
    expect(await runPlaybook({ db: f.db, checks }, claim, playbook(effect))).toMatchObject({ state: "failed", code: "step_refused" })
    expect(effect).not.toHaveBeenCalled()
    expect(f.calls.find((c) => c.fn === "finish_scheduled_agent_run")!.args).toMatchObject({ p_state: "failed", p_fired: false })
  })
})

describe("source locks", () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8")
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name)
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(name) ? [p] : []
    })

  it("keeps the governed executor OFF: this PR adds the lifecycle, not production effects", () => {
    expect(GOVERNED_EXECUTOR_ENABLED).toBe(false)
    expect(read("src/lib/agent-runtime.ts")).toContain("export const GOVERNED_EXECUTOR_ENABLED = false as const")
  })

  it("nothing in src writes the ledger tables directly; every write is a database function", () => {
    for (const file of walk("src")) {
      const text = readFileSync(file, "utf8")
      for (const m of text.matchAll(/\.from\(\s*["'`](agent_run_(?:steps|commands|attempts|waits|events))["'`]\s*\)\s*\.(insert|update|upsert|delete)/g)) {
        throw new Error(`${file} writes ${m[1]} directly (${m[2]})`)
      }
    }
  })

  it("the runner and its checks import no provider module: effects arrive as injected functions", () => {
    for (const file of ["src/lib/agent-os/run-executor.ts", "src/lib/agent-os/run-lifecycle.ts"]) {
      const imports = [...read(file).matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1])
      for (const spec of imports) {
        expect(spec, `${file} imports ${spec}`).not.toMatch(/twilio|vapi|aurinko|stripe|telephony-provider|voice-provider|approvals|outbound|sms-|email-/)
      }
    }
    const checks = [...read("src/lib/agent-os/pre-effect-checks.ts").matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1])
    for (const spec of checks) expect(spec).not.toMatch(/twilio|vapi|aurinko|stripe|telephony-provider|voice-provider|approvals/)
  })

  it("the cron tick recovers stale governed runs before any agent runs and keeps the legacy path", () => {
    const runtime = read("src/lib/agent-runtime.ts")
    expect(runtime.indexOf("await recoverStaleRuns(supabase)")).toBeGreaterThan(0)
    expect(runtime.indexOf("await recoverStaleRuns(supabase)")).toBeLessThan(runtime.indexOf("const governedStates = await loadGovernedAgentStates("))
    expect(runtime).toContain("drainResumableGovernedRuns")
    // Recovery is a safety net: its failure must not stop other agents.
    expect(runtime).toMatch(/governed run recovery failed/)
  })

  it("the migration keeps every lifecycle writer service-only, definer-bound and out of reach of browsers", () => {
    const sql = read("supabase/migrations/20261120103700_agent_run_step_lifecycle.sql")
    const functions = [...sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\(([\s\S]*?)\n(?:\$\$;|END \$\$;)/g)]
    expect(functions.length).toBeGreaterThanOrEqual(25)
    for (const [full, name] of functions) {
      expect(full, name).toMatch(/SECURITY DEFINER/)
      expect(full, name).toMatch(/SET search_path\s*=\s*''/)
    }
    // Every function reachable from outside checks the caller is the service role.
    for (const name of ["heartbeat_agent_run", "begin_agent_run_step", "register_agent_command", "begin_agent_command_attempt", "record_agent_attempt_result", "request_agent_run_control", "claim_resumable_agent_run", "recover_stale_agent_runs", "resolve_agent_command_reconciliation"]) {
      const body = functions.find((f) => f[1] === name)![0]
      expect(body, name).toContain("agent_run_require_service()")
    }
    expect(sql).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE|ALL)[^;]*agent_run_(?:steps|commands|attempts|waits|events)[^;]*TO/i)
    expect(sql).not.toMatch(/GRANT[^;]*agent_run_[^;]*TO[^;]*(?:anon|authenticated|PUBLIC)/i)
  })
})
