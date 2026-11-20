import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { recheckBeforeEffect, serviceEffectChecks, type EffectCheckResolvers } from "@/lib/agent-os/pre-effect-checks"
import { runPlaybook, type EffectOutcome, type Playbook, type RunClaim } from "@/lib/agent-os/run-executor"
import { claimResumableRun, recoverStaleRuns, requestRunControl, resolveReconciliation, type PreEffectCheck } from "@/lib/agent-os/run-lifecycle"
import { INTEGRATION_WITH_SESSION } from "./_db"
import { createGovernedFixture, resilientService, uniq, type World } from "./_governed-run-fixture"

/**
 * The step runner end to end on REAL Postgres with a fake provider. These are the acceptance cases from the
 * Gate 1 definition: a worker can stop mid-run, restart, and continue or reconcile without duplicating an
 * external action or declaring an unknown action complete.
 */
describe.skipIf(!INTEGRATION_WITH_SESSION)("governed run executor [integration]", { timeout: 180_000 }, () => {
  let db: SupabaseClient
  let fx: ReturnType<typeof createGovernedFixture>
  let w: World

  beforeAll(() => {
    db = resilientService()
    fx = createGovernedFixture(db)
  })
  beforeEach(async () => {
    w = await fx.world()
  })
  afterAll(async () => {
    await fx.done()
  })

  /** Resolvers that pass, unless overridden. Counts how many times each runs. */
  const resolvers = (over: Partial<Record<string, PreEffectCheck["status"] | "throw">> = {}) => {
    const calls: string[] = []
    const make = (name: string): EffectCheckResolvers["policy"] => async () => {
      calls.push(name)
      const v = over[name]
      if (v === "throw") throw new Error("resolver exploded")
      return { name, status: v ?? (name === "consent" || name === "approval" ? "not_applicable" : "pass") } as PreEffectCheck
    }
    const r = Object.fromEntries(["policy", "consent", "readiness", "approval", "budget", "grants"].map((n) => [n, make(n)])) as EffectCheckResolvers
    return { r, calls }
  }
  const effectLog = () => {
    const log: { key: string; attempt: number }[] = []
    const ok = (ref: string): ((ctx: { idempotencyKey: string; attemptNumber: number }) => Promise<EffectOutcome>) => async (ctx) => {
      log.push({ key: ctx.idempotencyKey, attempt: ctx.attemptNumber })
      return { kind: "accepted", providerRef: ref }
    }
    return { log, ok }
  }

  async function claimed(over: Record<string, unknown> = {}): Promise<{ agent: string; claim: RunClaim; key: string }> {
    const { agent } = await fx.governed(w, over)
    const c = await fx.claimWindow(agent)
    expect(c.outcome).toBe("claimed")
    const row = await fx.runRow(c.run_id)
    return { agent, key: row.trigger_key as string, claim: toClaim(c.lease, w.shop.shopId, agent, row) }
  }
  const toClaim = (lease: RunClaim["lease"], shopId: string, agentId: string, row: { definition_snapshot: unknown; policy_revision: number | null }): RunClaim => ({
    lease, shopId, agentId, definitionSnapshot: row.definition_snapshot as RunClaim["definitionSnapshot"], policyRevision: row.policy_revision,
  })
  const claimFromResume = async (agent: string, runId: string): Promise<RunClaim> => {
    const r = await claimResumableRun(db, { workerId: randomUUID(), agentId: agent })
    if (r.outcome !== "claimed") throw new Error("nothing to resume")
    return toClaim(r.lease, w.shop.shopId, agent, await fx.runRow(runId))
  }
  const send = (key: string, op: "crm.edit" | "pipeline.change" = "crm.edit") => ({ commandKey: key, operation: op, intent: "stage" as const, payload: { key }, safetyVerified: true })

  it("runs steps to completion; the effect happens once, evidence is complete, and a replayed window runs nothing", async () => {
    const { agent, claim, key } = await claimed()
    const { log, ok } = effectLog()
    const stagedAction = await fx.stageApproval(w.shop)
    const playbook: Playbook = {
      steps: [
        { key: "look-up", kind: "read", run: async () => ({ kind: "done", evidence: { rows: 3 } }) },
        {
          key: "stage-followup", kind: "effect",
          run: async (s) => {
            const r = await s.command(send("followup-1"), async (ctx) => ({ ...(await ok("proposal-1")(ctx)) as Extract<EffectOutcome, { kind: "accepted" }>, pendingActionId: stagedAction }))
            return r.outcome === "done" ? { kind: "done" } : { kind: "halt" }
          },
        },
      ],
    }
    const { r } = resolvers()
    expect(await runPlaybook({ db, checks: r }, claim, playbook)).toEqual({ state: "succeeded" })
    expect(log).toHaveLength(1)
    const row = await fx.runRow(claim.lease.runId)
    expect(row).toMatchObject({ state: "succeeded", fired: true, binding_at_finish: "current", pending_action_ids: [stagedAction] })
    expect((await fx.rows("agent_run_steps", claim.lease.runId)).map((s) => [s.step_key, s.state])).toEqual(expect.arrayContaining([["look-up", "succeeded"], ["stage-followup", "succeeded"]]))
    const [attempt] = await fx.rows("agent_run_attempts", claim.lease.runId)
    expect(attempt).toMatchObject({ state: "succeeded", provider_ref: "proposal-1" })
    expect(attempt.checks).toHaveLength(6) // evidence of every recheck is stored with the attempt

    // The same window never runs again, even with a second worker.
    const again = await db.rpc("claim_scheduled_agent_run", { p_agent: agent, p_trigger_key: key, p_worker: randomUUID(), p_lease_seconds: 60 })
    expect(again.data).toMatchObject({ outcome: "terminal_duplicate", state: "succeeded" })
    expect(log).toHaveLength(1)
  })

  it("eight workers racing for one window: exactly one claims, one effect", async () => {
    const { agent } = await fx.governed(w)
    const key = `window-${uniq()}`
    const results = await Promise.all(Array.from({ length: 8 }, () => fx.claimWindow(agent, key)))
    expect(results.filter((r) => r.outcome === "claimed")).toHaveLength(1)
    expect(results.filter((r) => ["active_duplicate"].includes(r.outcome))).toHaveLength(7)
  })

  it("a provider timeout is UNKNOWN: the effect is never repeated by a retry, sweep or resume; a person's reconciliation allows one fresh attempt with the same key", async () => {
    const { agent, claim } = await claimed()
    const keys: string[] = []
    const flaky = async (ctx: { idempotencyKey: string; attemptNumber: number }): Promise<EffectOutcome> => {
      keys.push(ctx.idempotencyKey)
      if (ctx.attemptNumber === 1) throw new Error("socket hang up")
      return { kind: "accepted", providerRef: "after-review" }
    }
    const playbook: Playbook = {
      steps: [{ key: "send", kind: "effect", run: async (s) => ((await s.command(send("send-1"), flaky)).outcome === "done" ? { kind: "done" } : { kind: "halt" }) }],
    }
    const { r } = resolvers()
    const outcome = await runPlaybook({ db, checks: r }, claim, playbook)
    expect(outcome).toMatchObject({ state: "unknown" })
    expect(await fx.runRow(claim.lease.runId)).toMatchObject({ state: "unknown", error_code: "attempt_outcome_unknown" })
    const [command] = await fx.rows("agent_run_commands", claim.lease.runId)
    expect(command.state).toBe("unknown")

    // Nothing runs it again: not another worker, not the sweep, not the resume claim.
    await recoverStaleRuns(db)
    expect(await claimResumableRun(db, { workerId: randomUUID(), agentId: agent })).toEqual({ outcome: "none" })
    expect(await runPlaybook({ db, checks: r }, claim, playbook)).toMatchObject({ state: "lease_lost" })
    expect(keys).toHaveLength(1)

    // The owner confirms nothing was sent; the run continues from its evidence, same idempotency key.
    expect(await resolveReconciliation(db, { shopId: w.shop.shopId, actorId: w.shop.ownerId, commandId: command.id, resolution: "no_effect_confirmed", note: "Provider shows nothing for this key." })).toMatchObject({ outcome: "resolved" })
    const resumed = await claimFromResume(agent, claim.lease.runId)
    expect(await runPlaybook({ db, checks: r }, resumed, playbook)).toEqual({ state: "succeeded" })
    expect(keys).toHaveLength(2)
    expect(keys[1]).toBe(keys[0])
    expect(await fx.runRow(claim.lease.runId)).toMatchObject({ state: "succeeded", attempt: 2 })
  })

  it("a lease lost during the provider call: the late 'success' is not believed, the run is unknown, nothing is repeated", async () => {
    const { agent, claim } = await claimed()
    let calls = 0
    const playbook: Playbook = {
      steps: [{
        key: "send", kind: "effect",
        run: async (s) => {
          const r = await s.command(send("slow-1"), async () => {
            calls += 1
            await fx.expireLease(claim.lease.runId) // the worker stalled past its lease
            return { kind: "accepted", providerRef: "too-late" }
          })
          return r.outcome === "done" ? { kind: "done" } : { kind: "halt" }
        },
      }],
    }
    const outcome = await runPlaybook({ db, checks: resolvers().r }, claim, playbook)
    expect(outcome.state === "unknown" || outcome.state === "lease_lost").toBe(true)
    const row = await fx.runRow(claim.lease.runId)
    expect(row.state).toBe("unknown")
    const [command] = await fx.rows("agent_run_commands", claim.lease.runId)
    expect(command).toMatchObject({ state: "unknown", provider_ref: null })
    expect(await claimResumableRun(db, { workerId: randomUUID(), agentId: agent })).toEqual({ outcome: "none" })
    expect(calls).toBe(1)
    expect(await fx.eventKinds(claim.lease.runId)).toContain("late_result_reported")
  })

  it("an accepted answer with no provider reference is UNKNOWN, never success", async () => {
    const { claim } = await claimed()
    const playbook: Playbook = {
      steps: [{ key: "send", kind: "effect", run: async (s) => ((await s.command(send("noref"), async () => ({ kind: "accepted", providerRef: "" }))).outcome === "done" ? { kind: "done" } : { kind: "halt" }) }],
    }
    expect(await runPlaybook({ db, checks: resolvers().r }, claim, playbook)).toMatchObject({ state: "unknown" })
    expect((await fx.rows("agent_run_commands", claim.lease.runId))[0].state).toBe("unknown")
  })

  it("pause requested mid-run is acknowledged at the next boundary; resume continues WITHOUT repeating the finished effect", async () => {
    const { agent, claim } = await claimed()
    const { log, ok } = effectLog()
    let second = 0
    const playbook: Playbook = {
      steps: [
        {
          key: "first", kind: "effect",
          run: async (s) => {
            const r = await s.command(send("one"), async (ctx) => {
              // The owner asks for a pause while the provider call is running.
              expect(await requestRunControl(db, { shopId: w.shop.shopId, actorId: w.shop.ownerId, runId: claim.lease.runId, kind: "pause", reason: "Hold on" })).toMatchObject({ outcome: "requested" })
              return ok("one-ref")(ctx)
            })
            return r.outcome === "done" ? { kind: "done" } : { kind: "halt" }
          },
        },
        {
          key: "second", kind: "effect",
          run: async (s) => {
            const r = await s.command(send("two", "pipeline.change"), async () => { second += 1; return { kind: "accepted", providerRef: "two-ref" } })
            return r.outcome === "done" ? { kind: "done" } : { kind: "halt" }
          },
        },
      ],
    }
    const { r } = resolvers()
    expect(await runPlaybook({ db, checks: r }, claim, playbook)).toEqual({ state: "paused" })
    expect(log).toHaveLength(1)
    expect(second).toBe(0)
    expect(await fx.runRow(claim.lease.runId)).toMatchObject({ state: "paused", control_acked_by: "worker" })

    expect(await claimResumableRun(db, { workerId: randomUUID(), agentId: agent })).toEqual({ outcome: "none" })
    const resume = await db.rpc("resume_paused_agent_run", { p_shop: w.shop.shopId, p_actor: w.shop.ownerId, p_run: claim.lease.runId })
    expect((resume.data as { outcome: string }).outcome).toBe("resumed")
    const resumed = await claimFromResume(agent, claim.lease.runId)
    expect(await runPlaybook({ db, checks: r }, resumed, playbook)).toEqual({ state: "succeeded" })
    expect(log).toHaveLength(1) // the first effect was NOT repeated
    expect(second).toBe(1)
  })

  it("cancel requested while the provider call runs aborts it through the heartbeat; confirmed provider cancellation is recorded", async () => {
    const { claim } = await claimed()
    const playbook: Playbook = {
      steps: [{
        key: "send", kind: "effect",
        run: async (s) => {
          const r = await s.command(send("cancellable"), async (ctx) => {
            await requestRunControl(db, { shopId: w.shop.shopId, actorId: w.shop.ownerId, runId: claim.lease.runId, kind: "cancel", reason: "Customer called" })
            await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }))
            return { kind: "rejected", providerStatus: "cancelled_by_us", cancel: "confirmed_cancelled" }
          })
          return r.outcome === "done" ? { kind: "done" } : { kind: "halt" }
        },
      }],
    }
    const outcome = await runPlaybook({ db, checks: resolvers().r, heartbeatMs: 50 }, claim, playbook)
    expect(outcome).toEqual({ state: "cancelled" })
    const [attempt] = await fx.rows("agent_run_attempts", claim.lease.runId)
    expect(attempt).toMatchObject({ state: "rejected", cancel_state: "confirmed_cancelled" })
    expect(await fx.runRow(claim.lease.runId)).toMatchObject({ state: "cancelled", control_acked_by: "worker" })
  })

  it("kill during the provider call fences the worker at once; the run is unknown, not killed, until a person reconciles", async () => {
    const { claim } = await claimed()
    let finished = false
    const playbook: Playbook = {
      steps: [{
        key: "send", kind: "effect",
        run: async (s) => {
          const r = await s.command(send("killed"), async (ctx) => {
            await requestRunControl(db, { shopId: w.shop.shopId, actorId: w.shop.ownerId, runId: claim.lease.runId, kind: "kill", reason: "Emergency" })
            await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }))
            finished = true
            return { kind: "accepted", providerRef: "it-went-through-anyway" }
          })
          return r.outcome === "done" ? { kind: "done" } : { kind: "halt" }
        },
      }],
    }
    const outcome = await runPlaybook({ db, checks: resolvers().r, heartbeatMs: 50 }, claim, playbook)
    expect(finished).toBe(true)
    expect(outcome.state).toBe("unknown")
    const row = await fx.runRow(claim.lease.runId)
    expect(row).toMatchObject({ state: "unknown", error_code: "killed_in_flight", control_acked_by: "database" })
    expect((await fx.rows("agent_run_commands", claim.lease.runId))[0]).toMatchObject({ state: "unknown", provider_ref: null })
  })

  it("revocation between steps: a paused definition stops the run before the second effect, with a known failure", async () => {
    const { agent, claim } = await claimed()
    const { log, ok } = effectLog()
    let secondRan = false
    const playbook: Playbook = {
      steps: [
        {
          key: "first", kind: "effect",
          run: async (s) => {
            const r = await s.command(send("one"), async (ctx) => {
              const pointer = (await db.from("agent_definition_state").select("active_revision").eq("agent_id", agent).single()).data!.active_revision as number
              expect((await fx.pauseDefinition(w, agent, pointer)).ok).toBe(true)
              return ok("r1")(ctx)
            })
            return r.outcome === "done" ? { kind: "done" } : { kind: "halt" }
          },
        },
        { key: "second", kind: "effect", run: async () => { secondRan = true; return { kind: "done" } } },
      ],
    }
    const outcome = await runPlaybook({ db, checks: resolvers().r }, claim, playbook)
    expect(outcome).toMatchObject({ state: "failed", code: "step_refused" })
    expect(secondRan).toBe(false)
    expect(log).toHaveLength(1)
    const row = await fx.runRow(claim.lease.runId)
    expect(row).toMatchObject({ state: "failed", error_code: "step_refused" })
    expect(row.binding_at_finish).toContain("agent_disabled")
  })

  it("a failing or crashing recheck blocks the effect, is recorded as evidence, and nothing is sent", async () => {
    for (const [name, mode] of [["consent", "fail"], ["readiness", "unknown"], ["budget", "throw"], ["policy", "fail"]] as const) {
      const x = await fx.world()
      w = x
      const { claim } = await claimed()
      const { log, ok } = effectLog()
      const { r } = resolvers({ [name]: mode })
      let result: unknown
      const playbook: Playbook = {
        steps: [{ key: "send", kind: "effect", run: async (s) => { result = await s.command(send("blocked"), ok("never")); return { kind: "halt" } } }],
      }
      await runPlaybook({ db, checks: r }, claim, playbook)
      expect(result, name).toMatchObject({ outcome: "blocked", reasons: [`check_failed_${name}`] })
      expect(log, name).toHaveLength(0)
      const [attempt] = await fx.rows("agent_run_attempts", claim.lease.runId)
      expect(attempt, name).toMatchObject({ state: "refused", refusal_reasons: [`check_failed_${name}`] })
      expect((await fx.rows("agent_run_commands", claim.lease.runId))[0], name).toMatchObject({ state: "pending", attempts_started: 0 })
    }
  })

  it("an edited approval is refused by the database even when every application check passes", async () => {
    const { claim } = await claimed()
    const pending = await fx.stageApproval(w.shop, { body: "original" })
    const { log, ok } = effectLog()
    let result: unknown
    const playbook: Playbook = {
      steps: [{
        key: "send", kind: "effect",
        run: async (s) => {
          // Approved, then the content is edited before the run reaches the effect.
          result = await s.command({ ...send("exec"), intent: "execute", approvalRequired: true, pendingActionId: pending }, ok("never"))
          return { kind: "halt" }
        },
      }],
    }
    // Register the command first through a first pass that is only allowed to register.
    const blocker = resolvers({ policy: "fail" })
    await runPlaybook({ db, checks: blocker.r }, claim, playbook)
    expect(result).toMatchObject({ outcome: "blocked" })
    await db.from("pending_actions").update({ status: "approved", decided_at: new Date().toISOString(), decided_by_user: w.shop.ownerId }).eq("id", pending)
    await db.from("pending_actions").update({ payload: { body: "EDITED" } }).eq("id", pending)
    // Same lease, same step: the registered command identity persists; a second pass reaches the gate with all checks passing.
    const pass = resolvers({ approval: "pass" })
    await runPlaybook({ db, checks: pass.r }, claim, playbook)
    expect(result).toMatchObject({ outcome: "blocked", reasons: ["approval_payload_changed"] })
    expect(log).toHaveLength(0)
  })

  it("a zombie worker whose lease was recovered and re-claimed cannot run a single effect", async () => {
    const { agent, claim } = await claimed()
    const { log, ok } = effectLog()
    const playbook: Playbook = {
      steps: [{ key: "send", kind: "effect", run: async (s) => ((await s.command(send("z"), ok("z-ref"))).outcome === "done" ? { kind: "done" } : { kind: "halt" }) }],
    }
    await fx.expireLease(claim.lease.runId)
    await recoverStaleRuns(db)
    const live = await claimFromResume(agent, claim.lease.runId)
    expect(await runPlaybook({ db, checks: resolvers().r }, claim, playbook)).toMatchObject({ state: "lease_lost" })
    expect(log).toHaveLength(0)
    expect(await runPlaybook({ db, checks: resolvers().r }, live, playbook)).toEqual({ state: "succeeded" })
    expect(log).toHaveLength(1)
  })

  it("an approval wait parks the run; once decided it resumes and the finished work is not repeated", async () => {
    const { agent, claim } = await claimed()
    const { log, ok } = effectLog()
    const pending = await fx.stageApproval(w.shop)
    const playbook: Playbook = {
      steps: [
        { key: "stage", kind: "effect", run: async (s) => ((await s.command(send("stage-1"), ok("s1"))).outcome === "done" ? { kind: "done" } : { kind: "halt" }) },
        {
          key: "await-owner", kind: "decision",
          run: async () => {
            const decided = (await db.from("pending_actions").select("status").eq("id", pending).single()).data!.status
            if (decided === "pending") return { kind: "wait", wait: { kind: "approval", reason: "Waiting for the owner to approve", ref: { kind: "pending_action", id: pending } } }
            return { kind: "done", evidence: { decided } }
          },
        },
        { key: "record", kind: "effect", run: async (s) => ((await s.command(send("record-1", "pipeline.change"), ok("r1"))).outcome === "done" ? { kind: "done" } : { kind: "halt" }) },
      ],
    }
    const { r } = resolvers()
    const first = await runPlaybook({ db, checks: r }, claim, playbook)
    expect(first).toMatchObject({ state: "waiting" })
    expect(await fx.runRow(claim.lease.runId)).toMatchObject({ state: "waiting", lease_expires_at: null })
    expect(await claimResumableRun(db, { workerId: randomUUID(), agentId: agent })).toEqual({ outcome: "none" })
    await db.from("pending_actions").update({ status: "approved", decided_at: new Date().toISOString(), decided_by_user: w.shop.ownerId }).eq("id", pending)
    const resumed = await claimFromResume(agent, claim.lease.runId)
    expect(await runPlaybook({ db, checks: r }, resumed, playbook)).toEqual({ state: "succeeded" })
    expect(log.map((l) => l.attempt)).toEqual([1, 1]) // stage ran once, record ran once; nothing repeated
  })

  describe("production resolvers over real data (read-only)", () => {
    const input = (over: Record<string, unknown> = {}) => ({
      shopId: w.shop.shopId, agentId: randomUUID(), commandId: randomUUID(), operation: "crm.edit" as const, intent: "stage" as const,
      payloadHash: "a".repeat(64), approvalRequired: false,
      tools: [{ operation: "crm.edit", maximumMode: "approval" as const }], boundPolicyRevision: w.policyRevision, safetyVerified: true,
      ...over,
    })

    it("pass for an approval-first stage under the active policy and fail closed when anything is off", async () => {
      const real = serviceEffectChecks(db, {})
      const ok = await recheckBeforeEffect(real, input())
      expect(Object.fromEntries(ok.map((c) => [c.name, c.status]))).toEqual({
        policy: "pass", consent: "not_applicable", readiness: "pass", approval: "not_applicable", budget: "pass", grants: "pass",
      })
      // Unverified content safety, a moved policy revision, an insufficient grant and a missing grant each fail.
      expect((await recheckBeforeEffect(real, input({ safetyVerified: false }))).find((c) => c.name === "policy")!.status).toBe("fail")
      expect((await recheckBeforeEffect(real, input({ boundPolicyRevision: w.policyRevision + 1 }))).find((c) => c.name === "policy")).toMatchObject({ status: "fail", code: "policy_changed" })
      expect((await recheckBeforeEffect(real, input({ tools: [{ operation: "crm.edit", maximumMode: "read" }] }))).find((c) => c.name === "grants")!.status).toBe("fail")
      expect((await recheckBeforeEffect(real, input({ tools: [] }))).find((c) => c.name === "grants")!.status).toBe("fail")
      // A workspace with no active policy fails closed (no policy is never "allow").
      const bare = await fx.newUser()
      expect((await recheckBeforeEffect(real, input({ shopId: bare.shopId }))).find((c) => c.name === "policy")).toMatchObject({ status: "fail", code: "policy_unavailable" })
    })

    it("consent blocks a customer who said STOP or is marked do-not-contact, and only an execute command needs it", async () => {
      const real = serviceEffectChecks(db, {})
      const cust = await db.from("customers").insert({ shop_id: w.shop.shopId, name: "Synthetic Person", phone: "+15035550123", do_not_contact: true }).select("id").single()
      expect(cust.error).toBeNull()
      const subject = { channel: "sms" as const, destination: "+15035550123", customerId: cust.data!.id as string, category: "transactional" as const }
      const execute = input({ operation: "sms.followup", intent: "execute", tools: [{ operation: "sms.followup", maximumMode: "approval" }], subject })
      const blocked = await recheckBeforeEffect(real, execute)
      expect(blocked.find((c) => c.name === "consent")).toMatchObject({ status: "fail", code: "send_not_permitted" })
      // Staging only drafts: it contacts nobody, so consent is not what stops it.
      const staged = await recheckBeforeEffect(real, { ...execute, intent: "stage" })
      expect(staged.find((c) => c.name === "consent")!.status).toBe("not_applicable")
      // No recipient at all fails closed.
      expect((await recheckBeforeEffect(real, { ...execute, subject: undefined })).find((c) => c.name === "consent")).toMatchObject({ status: "fail", code: "recipient_missing" })
    })

    it("a throwing, malformed or mislabeled resolver is recorded as unknown, never as a pass", async () => {
      const real = serviceEffectChecks(db, {})
      const hostile = {
        ...real,
        policy: vi.fn(async () => ({ name: "consent", status: "pass" }) as PreEffectCheck), // wrong name
        budget: vi.fn(async () => ({ name: "budget", status: "approved" }) as unknown as PreEffectCheck), // invalid status
        readiness: vi.fn(async () => { throw new Error("db down") }),
      }
      const out = await recheckBeforeEffect(hostile, input())
      expect(out.map((c) => c.name)).toEqual(["policy", "consent", "readiness", "approval", "budget", "grants"])
      expect(out.find((c) => c.name === "policy")).toMatchObject({ status: "unknown", code: "invalid_result" })
      expect(out.find((c) => c.name === "budget")).toMatchObject({ status: "unknown", code: "invalid_result" })
      expect(out.find((c) => c.name === "readiness")).toMatchObject({ status: "unknown", code: "check_unavailable" })
    })
  })
})
