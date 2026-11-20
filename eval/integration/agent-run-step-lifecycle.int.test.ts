import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { initialPolicyDraft } from "@/lib/control-center/drafts"
import {
  acknowledgeControl,
  beginCommandAttempt,
  beginStep,
  claimResumableRun,
  finishStep,
  heartbeatRun,
  parkWait,
  recordAttemptResult,
  recoverStaleRuns,
  registerCommand,
  requestRunControl,
  resolveReconciliation,
  resolveWait,
  resumePausedRun,
  type PreEffectCheck,
  type RunLease,
} from "@/lib/agent-os/run-lifecycle"
import { INTEGRATION_WITH_SESSION, anonClient, seedShop, stagePending } from "./_db"
import { createGovernedFixture, resilientService, uniq, type World } from "./_governed-run-fixture"

/**
 * Governed run lifecycle on REAL Postgres: heartbeats, stale-lease recovery, steps, stable commands,
 * write-ahead attempts, pause / cancel / kill request-and-acknowledge, waits, reconciliation, and the
 * pre-effect gate. Every concurrency and crash case here is an adversarial one: the point is that the
 * database, not the caller's good behavior, keeps an unknown outcome from being retried or declared done.
 */
describe.skipIf(!INTEGRATION_WITH_SESSION)("governed run step lifecycle [integration]", { timeout: 180_000 }, () => {
  let db: SupabaseClient
  let fx: ReturnType<typeof createGovernedFixture>
  let w: World

  beforeAll(() => {
    db = resilientService()
    fx = createGovernedFixture(db)
  })
  // Founder Pilot allows two active agents per workspace, so every test gets its own workspace.
  beforeEach(async () => {
    w = await fx.world()
  })
  afterAll(async () => {
    await fx.done()
  })

  /** A claimed governed run with an `effect` step already open. */
  async function liveRun(over: Record<string, unknown> = {}, home: World = w) {
    const { agent } = await fx.governed(home, over)
    const c = await fx.claimWindow(agent)
    expect(c.outcome).toBe("claimed")
    const step = await beginStep(db, c.lease, { key: "act-1", kind: "effect" })
    expect(step.outcome).toBe("started")
    return { agent, c, lease: c.lease as RunLease }
  }
  const cmd = (lease: RunLease, over: Record<string, unknown> = {}) =>
    registerCommand(db, lease, { stepKey: "act-1", commandKey: `cmd-${uniq()}`, operation: "crm.edit", intent: "stage", payload: { a: 1 }, ...over })
  const registered = async (lease: RunLease, over: Record<string, unknown> = {}) => {
    const r = await cmd(lease, over)
    if (r.outcome === "refused") throw new Error(`register refused: ${r.reasons.join(",")}`)
    return r
  }
  const started = async (lease: RunLease, commandId: string, checks = fx.allPass()) => {
    const a = await beginCommandAttempt(db, lease, commandId, checks)
    if (a.outcome !== "started") throw new Error(`attempt not started: ${JSON.stringify(a)}`)
    return a
  }
  const cmdRow = async (id: string) => (await db.from("agent_run_commands").select("*").eq("id", id).single()).data!
  const attempts = async (commandId: string) => (await db.from("agent_run_attempts").select("*").eq("command_id", commandId).order("attempt_number")).data!
  const waitsOf = async (runId: string) => (await db.from("agent_run_waits").select("*").eq("run_id", runId).order("created_at")).data!
  const owner = (s = w.shop) => ({ shopId: s.shopId, actorId: s.ownerId })

  async function newPolicyRevision(x: World, active: number) {
    const current = await x.owner.from("control_policy_drafts").select("revision").eq("shop_id", x.shop.shopId).single()
    const saved = await x.owner.rpc("save_control_policy_draft", { p_shop: x.shop.shopId, p_expected_revision: current.data!.revision, p_definition: { ...initialPolicyDraft(), workspaceCeiling: "approval" } })
    expect(saved.error).toBeNull()
    const act = await x.owner.rpc("activate_control_policy", { p_shop: x.shop.shopId, p_revision: saved.data, p_expected_active: active })
    expect(act.error).toBeNull()
    return act.data as number
  }

  // ------------------------------------------------------------------ heartbeat
  describe("heartbeat", () => {
    it("extends a live lease only; wrong worker, wrong attempt and an expired lease are refused and never resurrected", async () => {
      const { c, lease } = await liveRun()
      const before = await fx.runRow(lease.runId)
      const hb = await heartbeatRun(db, lease, 300)
      expect(hb).toEqual({ alive: true, control: null })
      const after = await fx.runRow(lease.runId)
      expect(Date.parse(after.lease_expires_at)).toBeGreaterThan(Date.parse(before.lease_expires_at))
      expect(after.last_heartbeat_at).not.toBeNull()

      expect(await heartbeatRun(db, { ...lease, workerId: randomUUID() })).toMatchObject({ alive: false, reason: "run_not_owned" })
      expect(await heartbeatRun(db, { ...lease, attempt: 2 })).toMatchObject({ alive: false, reason: "run_not_owned" })
      // An out-of-range lease request is a contract error and never extends anything.
      expect(await heartbeatRun(db, lease, 5)).toMatchObject({ alive: false, reason: "heartbeat_unverifiable" })

      await fx.expireLease(c.run_id)
      expect(await heartbeatRun(db, lease)).toMatchObject({ alive: false, reason: "run_not_owned" })
      const dead = await fx.runRow(lease.runId)
      expect(Date.parse(dead.lease_expires_at)).toBeLessThan(Date.now())
    })

    it("stops a worker at the definition's own runtime ceiling and refuses new steps and attempts past it", async () => {
      const { agent } = await fx.governed(w, { limits: { maximumStepsPerRun: 6, maximumRuntimeSeconds: 5, maximumCreditsPerRun: 50, maximumRunsPerDay: 24, maximumConcurrentRuns: 1 } })
      const c = await fx.claimWindow(agent)
      const command = await (async () => {
        await beginStep(db, c.lease, { key: "act-1", kind: "effect" })
        return registered(c.lease)
      })()
      await db.from("custom_agent_runs").update({ lease_started_at: new Date(Date.now() - 6_000).toISOString() }).eq("id", c.run_id)
      expect(await heartbeatRun(db, c.lease)).toMatchObject({ alive: false, reason: "runtime_limit_reached" })
      expect(await beginStep(db, c.lease, { key: "late", kind: "read" })).toEqual({ outcome: "refused", reasons: ["runtime_limit_reached"] })
      expect(await beginCommandAttempt(db, c.lease, command.commandId, fx.allPass())).toMatchObject({ outcome: "refused", reasons: ["runtime_limit_reached"] })
    })
  })

  // ------------------------------------------------------------ stale lease recovery
  describe("stale lease recovery and restart", () => {
    it("a dead worker with NO attempt in flight is recoverable; the resume claim bumps the attempt and fences the zombie", async () => {
      const { agent, c, lease } = await liveRun()
      await fx.expireLease(c.run_id)
      await recoverStaleRuns(db)
      expect(await fx.runRow(lease.runId)).toMatchObject({ state: "waiting", wait_reason: "restart_recovery", lease_expires_at: null, finished_at: null })
      expect((await fx.rows("agent_run_steps", lease.runId))[0]).toMatchObject({ step_key: "act-1", state: "abandoned" })
      expect((await waitsOf(lease.runId)).filter((x) => x.state === "open")).toHaveLength(1)

      const w2 = randomUUID()
      const resumed = await claimResumableRun(db, { workerId: w2, agentId: agent })
      expect(resumed).toMatchObject({ outcome: "claimed", lease: { runId: lease.runId, attempt: 2 }, waitKind: "restart_recovery" })
      // The zombie holder of attempt 1 can do nothing at all.
      expect(await heartbeatRun(db, lease)).toMatchObject({ alive: false })
      expect(await beginStep(db, lease, { key: "x", kind: "read" })).toMatchObject({ outcome: "refused", reasons: ["run_not_owned"] })
      expect((await fx.finish(lease)).data).toBe(false)
      expect(await registerCommand(db, lease, { stepKey: "act-1", commandKey: "z", operation: "crm.edit", intent: "stage", payload: {} })).toMatchObject({ outcome: "refused" })

      const lease2 = (resumed as { lease: RunLease }).lease
      expect(await beginStep(db, lease2, { key: "act-1", kind: "effect" })).toMatchObject({ outcome: "resumed" })
      expect(await fx.eventKinds(lease.runId)).toEqual(expect.arrayContaining(["claimed", "stale_lease_recovered", "resumed"]))
    })

    it("a dead worker WITH an attempt in flight becomes UNKNOWN: attempt, command and run, plus one reconciliation wait; nothing resumes", async () => {
      const { agent, c, lease } = await liveRun()
      const command = await registered(lease)
      const attempt = await started(lease, command.commandId)
      await fx.expireLease(c.run_id)
      await recoverStaleRuns(db)

      expect(await fx.runRow(lease.runId)).toMatchObject({ state: "unknown", error_code: "lease_expired", wait_reason: "reconciliation_required", fired: false })
      expect(await cmdRow(command.commandId)).toMatchObject({ state: "unknown" })
      expect((await attempts(command.commandId))[0]).toMatchObject({ id: attempt.attemptId, state: "unknown" })
      const open = (await waitsOf(lease.runId)).filter((x) => x.state === "open")
      expect(open).toHaveLength(1)
      expect(open[0]).toMatchObject({ kind: "reconciliation", command_id: command.commandId })
      expect(await claimResumableRun(db, { workerId: randomUUID(), agentId: agent })).toEqual({ outcome: "none" })

      // A late "success" from the zombie is evidence for the reconciler, never the outcome.
      expect(await recordAttemptResult(db, lease, attempt.attemptId, { result: "succeeded", providerRef: "late-ref" })).toMatchObject({ recorded: false })
      expect(await cmdRow(command.commandId)).toMatchObject({ state: "unknown", provider_ref: null })
      expect(await fx.eventKinds(lease.runId)).toContain("late_result_reported")
      // A second sweep changes nothing.
      const before = (await fx.eventKinds(lease.runId)).length
      await recoverStaleRuns(db)
      expect((await fx.eventKinds(lease.runId)).length).toBe(before)
    })

    it("eight concurrent sweeps plus a racing window claim produce exactly one transition and one reconciliation wait", async () => {
      const { agent, c, lease } = await liveRun()
      const command = await registered(lease)
      await started(lease, command.commandId)
      await fx.expireLease(c.run_id)
      const results = await Promise.all([
        ...Array.from({ length: 8 }, () => db.rpc("recover_stale_agent_runs", { p_limit: 50 })),
        db.rpc("claim_scheduled_agent_run", { p_agent: agent, p_trigger_key: c.run_id ? (await fx.runRow(lease.runId)).trigger_key : "x", p_worker: randomUUID(), p_lease_seconds: 60 }),
      ])
      for (const r of results) expect(r.error).toBeNull()
      const kinds = await fx.eventKinds(lease.runId)
      expect(kinds.filter((k) => k === "lease_expired_unknown")).toHaveLength(1)
      expect((await waitsOf(lease.runId)).filter((x) => x.kind === "reconciliation")).toHaveLength(1)
      expect((await attempts(command.commandId)).filter((a) => a.state === "unknown")).toHaveLength(1)
    })

    it("the window claim classifies an expired governed run from evidence: waiting is an open duplicate, in-flight is unknown", async () => {
      const a = await liveRun()
      await fx.expireLease(a.lease.runId)
      const key = (await fx.runRow(a.lease.runId)).trigger_key as string
      const second = await db.rpc("claim_scheduled_agent_run", { p_agent: a.agent, p_trigger_key: key, p_worker: randomUUID(), p_lease_seconds: 60 })
      expect(second.data).toMatchObject({ outcome: "open_duplicate", state: "waiting", run_id: a.lease.runId })

      const b = await liveRun()
      const command = await registered(b.lease)
      await started(b.lease, command.commandId)
      await fx.expireLease(b.lease.runId)
      const key2 = (await fx.runRow(b.lease.runId)).trigger_key as string
      const third = await db.rpc("claim_scheduled_agent_run", { p_agent: b.agent, p_trigger_key: key2, p_worker: randomUUID(), p_lease_seconds: 60 })
      expect(third.data).toMatchObject({ outcome: "unknown", run_id: b.lease.runId })
    })
  })

  // ---------------------------------------------------------------------- steps
  describe("steps", () => {
    it("are idempotent by key, replay when done, bounded by the definition, and cannot close over unresolved work", async () => {
      const { c, lease } = await liveRun({ limits: { maximumStepsPerRun: 2, maximumRuntimeSeconds: 120, maximumCreditsPerRun: 50, maximumRunsPerDay: 24, maximumConcurrentRuns: 1 } })
      expect(await beginStep(db, lease, { key: "act-1", kind: "effect" })).toMatchObject({ outcome: "already_running" })
      expect(await beginStep(db, lease, { key: "act-1", kind: "read" })).toMatchObject({ outcome: "refused", reasons: ["step_kind_changed"] }) // a step's kind is part of its identity
      const command = await registered(lease)
      await started(lease, command.commandId)
      // The step still owns an unconfirmed attempt: it cannot be closed.
      expect(await finishStep(db, lease, { key: "act-1", state: "succeeded" })).toBe(false)
      const attempt = (await attempts(command.commandId))[0]
      expect((await recordAttemptResult(db, lease, attempt.id, { result: "succeeded", providerRef: "ref-1" }))).toMatchObject({ recorded: true })
      expect(await finishStep(db, lease, { key: "act-1", state: "succeeded", evidence: { ok: true } })).toBe(true)
      expect(await beginStep(db, lease, { key: "act-1", kind: "effect" })).toMatchObject({ outcome: "replay_done" })
      expect(await beginStep(db, lease, { key: "two", kind: "read" })).toMatchObject({ outcome: "started" })
      expect(await beginStep(db, lease, { key: "three", kind: "read" })).toEqual({ outcome: "refused", reasons: ["step_limit_reached"] })
      // Replays remain possible beyond the limit; a failed step is never silently re-run.
      expect(await beginStep(db, lease, { key: "act-1", kind: "effect" })).toMatchObject({ outcome: "replay_done" })
      expect(await finishStep(db, lease, { key: "two", state: "failed", outcomeCode: "boom" })).toBe(true)
      expect(await beginStep(db, lease, { key: "two", kind: "read" })).toMatchObject({ outcome: "refused", reasons: ["step_failed"] })
      expect((await fx.rows("agent_run_steps", c.run_id)).map((s) => s.ordinal).sort()).toEqual([1, 2])
    })
  })

  // ------------------------------------------------------------------- commands
  describe("stable commands", () => {
    it("keep one identity; a changed payload, operation or step is refused, never silently edited", async () => {
      const { lease } = await liveRun()
      const first = await registered(lease, { commandKey: "send-1", payload: { to: "a", body: "x" } })
      const same = await registered(lease, { commandKey: "send-1", payload: { body: "x", to: "a" } }) // key order irrelevant
      expect(same).toMatchObject({ outcome: "existing", commandId: first.commandId, idempotencyKey: first.idempotencyKey })
      expect(await cmd(lease, { commandKey: "send-1", payload: { to: "a", body: "EDITED" } })).toEqual({ outcome: "refused", reasons: ["command_changed"] })
      expect(await cmd(lease, { commandKey: "send-1", payload: { to: "a", body: "x" }, operation: "pipeline.change" })).toEqual({ outcome: "refused", reasons: ["command_changed"] })
      expect(await cmd(lease, { commandKey: "send-1", payload: { to: "a", body: "x" }, intent: "execute" })).toEqual({ outcome: "refused", reasons: ["command_changed"] })
      expect((await fx.rows("agent_run_commands", lease.runId))).toHaveLength(1)
      // Identity is immutable even for the service role's own SQL surface (no UPDATE grant at all).
      const direct = await db.from("agent_run_commands").update({ payload_hash: "0".repeat(64) }).eq("id", first.commandId)
      expect(direct.error).not.toBeNull()
    })

    it("refuse an ungranted or post-MVP operation and an unopened step", async () => {
      const { lease } = await liveRun()
      expect(await cmd(lease, { operation: "booking.create" })).toEqual({ outcome: "refused", reasons: ["tool_not_granted"] })
      expect(await cmd(lease, { operation: "voice.outbound" })).toEqual({ outcome: "refused", reasons: ["tool_not_granted"] })
      expect(await cmd(lease, { stepKey: "never-opened" })).toEqual({ outcome: "refused", reasons: ["step_not_running"] })
    })

    it("one live command per business object per agent across runs; freed by a confirmed non-effect or cancellation", async () => {
      const first = await liveRun()
      const a = await registered(first.lease, { dedupeKey: `followup:lead:${uniq()}` })
      const key = (await fx.rows("agent_run_commands", first.lease.runId))[0].dedupe_key as string
      // A second window of the same agent while the first still holds the key.
      expect((await beginStep(db, first.lease, { key: "park", kind: "read" })).outcome).toBe("started")
      expect(await parkWait(db, first.lease, "park", { kind: "dependency", reason: "later" })).toMatchObject({ waiting: true })
      const second = await fx.claimWindow(first.agent)
      expect(second.outcome).toBe("claimed")
      await beginStep(db, second.lease, { key: "act-1", kind: "effect" })
      expect(await cmd(second.lease, { commandKey: "other", dedupeKey: key })).toEqual({ outcome: "refused", reasons: ["dedupe_key_in_use"] })
      // Once the first run is cancelled its pending command no longer holds the key.
      expect(await requestRunControl(db, { ...owner(), runId: first.lease.runId, kind: "cancel", reason: "test" })).toMatchObject({ outcome: "acknowledged", state: "cancelled" })
      expect((await cmdRow(a.commandId)).state).toBe("cancelled")
      expect(await cmd(second.lease, { commandKey: "other", dedupeKey: key })).toMatchObject({ outcome: "registered" })
    })
  })

  // ------------------------------------------------------------ attempt admission
  describe("pre-effect gate and write-ahead attempts", () => {
    it("admits only with all six checks present once and passing; every refusal is recorded with its evidence and starts nothing", async () => {
      const { lease } = await liveRun()
      const command = await registered(lease)
      const base = fx.allPass()
      const cases: [string, PreEffectCheck[], string][] = [
        ["missing", base.filter((c) => c.name !== "policy"), "check_missing_policy"],
        ["failed", fx.allPass({ readiness: "fail" }), "check_failed_readiness"],
        ["unknown", fx.allPass({ budget: "unknown" }), "check_failed_budget"],
        ["duplicate", [...base, { name: "grants", status: "pass" }], "check_duplicate_grants"],
        ["not applicable where it must pass", fx.allPass({ policy: "not_applicable" }), "check_failed_policy"],
        ["empty", [], "check_missing_policy"],
      ]
      for (const [, checks, reason] of cases) {
        const r = await beginCommandAttempt(db, lease, command.commandId, checks)
        expect(r.outcome).toBe("refused")
        expect((r as { reasons: string[] }).reasons).toContain(reason)
      }
      const rows = await attempts(command.commandId)
      expect(rows.length).toBe(cases.length)
      expect(rows.every((a) => a.state === "refused" && a.finished_at && a.refusal_reasons.length > 0)).toBe(true)
      expect(rows[1].checks).toEqual(fx.allPass({ readiness: "fail" }))
      expect(await cmdRow(command.commandId)).toMatchObject({ state: "pending", attempts_started: 0 })
      const ok = await beginCommandAttempt(db, lease, command.commandId, base)
      expect(ok).toMatchObject({ outcome: "started", attemptNumber: cases.length + 1, idempotencyKey: command.idempotencyKey })
      expect(await cmdRow(command.commandId)).toMatchObject({ state: "in_flight", attempts_started: 1 })
    })

    it("eight concurrent begins on one command admit exactly one attempt", async () => {
      const { lease } = await liveRun()
      const command = await registered(lease)
      const results = await Promise.all(Array.from({ length: 8 }, () => beginCommandAttempt(db, lease, command.commandId, fx.allPass())))
      expect(results.filter((r) => r.outcome === "started")).toHaveLength(1)
      expect(results.filter((r) => r.outcome === "refused" && r.reasons.includes("attempt_in_flight"))).toHaveLength(7)
      expect((await attempts(command.commandId)).filter((a) => a.state === "started")).toHaveLength(1)
    })

    it("a succeeded command replays without a new attempt; a definitive rejection allows one fresh attempt with the SAME idempotency key", async () => {
      const { lease } = await liveRun()
      const ok = await registered(lease, { commandKey: "ok" })
      const a1 = await started(lease, ok.commandId)
      expect(await recordAttemptResult(db, lease, a1.attemptId, { result: "succeeded", providerRef: "ref-ok", providerStatus: "accepted" })).toMatchObject({ recorded: true, result: "succeeded" })
      expect(await beginCommandAttempt(db, lease, ok.commandId, fx.allPass())).toEqual({ outcome: "replay_succeeded", commandId: ok.commandId, providerRef: "ref-ok" })
      expect((await attempts(ok.commandId))).toHaveLength(1)
      // A recorded result is final: a second report for the same attempt is only evidence.
      expect(await recordAttemptResult(db, lease, a1.attemptId, { result: "unknown" })).toMatchObject({ recorded: false })
      expect(await cmdRow(ok.commandId)).toMatchObject({ state: "succeeded", provider_ref: "ref-ok" })

      const rej = await registered(lease, { commandKey: "rej" })
      const b1 = await started(lease, rej.commandId)
      expect(await recordAttemptResult(db, lease, b1.attemptId, { result: "rejected", providerStatus: "invalid_recipient" })).toMatchObject({ recorded: true, result: "rejected", runState: "running" })
      expect(await cmdRow(rej.commandId)).toMatchObject({ state: "failed_before_effect" })
      const b2 = await started(lease, rej.commandId)
      expect(b2.attemptNumber).toBe(2)
      expect(b2.idempotencyKey).toBe(rej.idempotencyKey)
    })

    it("an UNKNOWN outcome stops the run, is never retried, and only a person can reopen it", async () => {
      const { agent, lease } = await liveRun()
      const command = await registered(lease)
      const a1 = await started(lease, command.commandId)
      expect(await recordAttemptResult(db, lease, a1.attemptId, { result: "unknown", providerStatus: "timeout" })).toMatchObject({ recorded: true, result: "unknown", runState: "unknown" })
      expect(await fx.runRow(lease.runId)).toMatchObject({ state: "unknown", error_code: "attempt_outcome_unknown", lease_expires_at: null })
      expect(await cmdRow(command.commandId)).toMatchObject({ state: "unknown" })
      // The worker that saw the timeout can do nothing further, and nothing resumes by itself.
      expect(await beginCommandAttempt(db, lease, command.commandId, fx.allPass())).toMatchObject({ outcome: "refused", reasons: ["run_not_owned"] })
      expect(await claimResumableRun(db, { workerId: randomUUID(), agentId: agent })).toEqual({ outcome: "none" })
      expect((await fx.finish(lease, "succeeded")).data).toBe(false)

      // Inconclusive review keeps it open.
      expect(await resolveReconciliation(db, { ...owner(), commandId: command.commandId, resolution: "cannot_determine", note: "Could not reach the provider dashboard." })).toMatchObject({ outcome: "recorded_unresolved" })
      expect(await cmdRow(command.commandId)).toMatchObject({ state: "unknown" })
      // A confirmed non-effect makes ONE new admitted attempt possible, with the same idempotency key.
      expect(await resolveReconciliation(db, { ...owner(), commandId: command.commandId, resolution: "no_effect_confirmed", note: "Provider shows no message for this key." })).toMatchObject({ outcome: "resolved", runState: "waiting" })
      expect(await cmdRow(command.commandId)).toMatchObject({ state: "failed_before_effect", resolution: "no_effect_confirmed" })
      const resumed = await claimResumableRun(db, { workerId: randomUUID(), agentId: agent })
      expect(resumed).toMatchObject({ outcome: "claimed", lease: { attempt: 2 } })
      const lease2 = (resumed as { lease: RunLease }).lease
      await beginStep(db, lease2, { key: "act-1", kind: "effect" })
      const retry = await started(lease2, command.commandId)
      expect(retry.attemptNumber).toBe(2)
      expect(retry.idempotencyKey).toBe(command.idempotencyKey)
    })

    it("defense in depth: even if a run is forced back to running by a corrupted write, an unknown command is never admitted again", async () => {
      const { lease } = await liveRun()
      const command = await registered(lease)
      const a = await started(lease, command.commandId)
      await recordAttemptResult(db, lease, a.attemptId, { result: "unknown" })
      // Simulate operator error / a bug: the run row says running with a live lease again.
      const forced = await db.from("custom_agent_runs").update({ state: "running", finished_at: null, lease_expires_at: new Date(Date.now() + 60_000).toISOString() }).eq("id", lease.runId)
      expect(forced.error).toBeNull()
      expect(await beginCommandAttempt(db, lease, command.commandId, fx.allPass())).toMatchObject({ outcome: "refused", reasons: ["outcome_unknown_requires_reconciliation"] })
      expect((await attempts(command.commandId)).filter((x) => x.state === "started")).toHaveLength(0)
      // And it still cannot declare success over the unknown outcome.
      expect((await fx.finish(lease, "succeeded")).data).toBe(false)
    })

    it("a confirmed effect completes the command without a second send; reconciliation needs a human owner or manager and a written note", async () => {
      const { agent, lease } = await liveRun()
      const command = await registered(lease)
      const a1 = await started(lease, command.commandId)
      await recordAttemptResult(db, lease, a1.attemptId, { result: "unknown" })
      const staff = await seedShop(db, { password: "Synthetic-password-123!" })
      fx.seeded.push(staff)
      await fx.addMember(w.shop.shopId, staff, "staff")
      expect(await resolveReconciliation(db, { shopId: w.shop.shopId, actorId: staff.ownerId, commandId: command.commandId, resolution: "effect_confirmed", note: "Seen in the provider log." })).toMatchObject({ outcome: "forbidden" })
      expect(await resolveReconciliation(db, { ...owner(), commandId: command.commandId, resolution: "effect_confirmed", note: "" })).toMatchObject({ outcome: "invalid" })
      expect(await resolveReconciliation(db, { ...owner(), commandId: command.commandId, resolution: "effect_confirmed", note: "Seen in the provider log.", providerRef: "ref-seen" })).toMatchObject({ outcome: "resolved", runState: "waiting" })
      expect(await cmdRow(command.commandId)).toMatchObject({ state: "succeeded", provider_ref: "ref-seen", resolution: "effect_confirmed" })
      expect((await attempts(command.commandId))[0].state).toBe("confirmed_effect")
      // Resolving it again changes nothing.
      expect(await resolveReconciliation(db, { ...owner(), commandId: command.commandId, resolution: "no_effect_confirmed", note: "Changed my mind." })).toMatchObject({ outcome: "not_unknown" })
      const resumed = await claimResumableRun(db, { workerId: randomUUID(), agentId: agent })
      const lease2 = (resumed as { lease: RunLease }).lease
      await beginStep(db, lease2, { key: "act-1", kind: "effect" })
      // The confirmed effect is never repeated.
      expect(await beginCommandAttempt(db, lease2, command.commandId, fx.allPass())).toMatchObject({ outcome: "replay_succeeded", providerRef: "ref-seen" })
    })

    it("an accepted result needs a provider reference, and the credit budget counts in-flight, done and unknown work", async () => {
      const { lease } = await liveRun()
      const c1 = await registered(lease, { commandKey: "c1", credits: 30 })
      const a1 = await started(lease, c1.commandId)
      const bad = await db.rpc("record_agent_attempt_result", { p_run: lease.runId, p_worker: lease.workerId, p_attempt: lease.attempt, p_attempt_id: a1.attemptId, p_result: "succeeded" })
      expect(bad.error?.code).toBe("22023")
      const c2 = await registered(lease, { commandKey: "c2", credits: 30 })
      // c1 is still in flight and counts.
      expect(await beginCommandAttempt(db, lease, c2.commandId, fx.allPass())).toMatchObject({ outcome: "refused", reasons: ["budget_exceeded"] })
      await recordAttemptResult(db, lease, a1.attemptId, { result: "succeeded", providerRef: "r1" })
      expect(await beginCommandAttempt(db, lease, c2.commandId, fx.allPass())).toMatchObject({ outcome: "refused", reasons: ["budget_exceeded"] })
      const c3 = await registered(lease, { commandKey: "c3", credits: 20 })
      expect(await beginCommandAttempt(db, lease, c3.commandId, fx.allPass())).toMatchObject({ outcome: "started" })
    })

    it("an execute command is re-verified against its approval's CURRENT status, payload and consumption", async () => {
      const { lease } = await liveRun()
      const pending = await fx.stageApproval(w.shop, { note: "original" })
      const command = await registered(lease, { commandKey: "exec", intent: "execute", approvalRequired: true, pendingActionId: pending })
      const checks = fx.allPass({ approval: "pass" })
      // Staged but not approved.
      expect(await beginCommandAttempt(db, lease, command.commandId, checks)).toMatchObject({ outcome: "refused", reasons: ["approval_not_current"] })
      // The caller cannot claim an approval the database does not see; "not applicable" is refused too.
      expect(await beginCommandAttempt(db, lease, command.commandId, fx.allPass({ approval: "not_applicable" }))).toMatchObject({ outcome: "refused" })

      expect((await db.from("pending_actions").update({ status: "approved", decided_at: new Date().toISOString(), decided_by_user: w.shop.ownerId }).eq("id", pending)).error).toBeNull()
      // Edited after registration (and approval): stale proof.
      expect((await db.from("pending_actions").update({ payload: { note: "EDITED after approval" } }).eq("id", pending)).error).toBeNull()
      expect(await beginCommandAttempt(db, lease, command.commandId, checks)).toMatchObject({ outcome: "refused", reasons: ["approval_payload_changed"] })
      expect((await db.from("pending_actions").update({ payload: { note: "original" } }).eq("id", pending)).error).toBeNull()
      // Consumed elsewhere (the human path already executed it).
      expect((await db.from("pending_actions").update({ result_id: randomUUID() }).eq("id", pending)).error).toBeNull()
      expect(await beginCommandAttempt(db, lease, command.commandId, checks)).toMatchObject({ outcome: "refused", reasons: ["approval_consumed"] })
      expect((await db.from("pending_actions").update({ result_id: null }).eq("id", pending)).error).toBeNull()
      expect(await beginCommandAttempt(db, lease, command.commandId, checks)).toMatchObject({ outcome: "started" })
    })

    it("revocation before the effect: a paused definition, a moved policy or a disabled agent refuses the attempt and the next step", async () => {
      const policyRun = await liveRun()
      const pc = await registered(policyRun.lease)
      const newRevision = await newPolicyRevision(w, w.policyRevision)
      const refused = await beginCommandAttempt(db, policyRun.lease, pc.commandId, fx.allPass())
      expect(refused).toMatchObject({ outcome: "refused" })
      expect((refused as { reasons: string[] }).reasons).toContain("policy_changed")
      expect(await beginStep(db, policyRun.lease, { key: "next", kind: "read" })).toMatchObject({ outcome: "refused" })
      expect((await attempts(pc.commandId))[0]).toMatchObject({ state: "refused" })
      // Restore the world for the other tests (a fresh agent evaluates under the new policy).
      w = { ...w, policyRevision: newRevision }

      const pauseRun = await liveRun()
      const cmdP = await registered(pauseRun.lease)
      const state = (await db.from("agent_definition_state").select("active_revision").eq("agent_id", pauseRun.agent).single()).data!
      expect((await fx.pauseDefinition(w, pauseRun.agent, state.active_revision as number)).ok).toBe(true)
      const r2 = await beginCommandAttempt(db, pauseRun.lease, cmdP.commandId, fx.allPass())
      expect(r2).toMatchObject({ outcome: "refused" })
      expect((r2 as { reasons: string[] }).reasons).toContain("agent_disabled")
      expect(await cmdRow(cmdP.commandId)).toMatchObject({ state: "pending", attempts_started: 0 })
    })
  })

  // ------------------------------------------------------------- pause/cancel/kill
  describe("pause, cancel and kill", () => {
    it("pause is a REQUEST the worker acknowledges at a boundary; resume is a person's act and fences the old lease", async () => {
      const { agent, lease } = await liveRun()
      const command = await registered(lease)
      const manager = await seedShop(db, { password: "Synthetic-password-123!" })
      fx.seeded.push(manager)
      await fx.addMember(w.shop.shopId, manager, "manager")
      expect(await requestRunControl(db, { shopId: w.shop.shopId, actorId: manager.ownerId, runId: lease.runId, kind: "pause", reason: "Hold while I check" })).toMatchObject({ outcome: "requested", state: "running" })
      expect(await fx.runRow(lease.runId)).toMatchObject({ state: "running", control_request: "pause", control_acked_at: null })
      // Visible on the next heartbeat; no new step or attempt may begin.
      expect(await heartbeatRun(db, lease)).toEqual({ alive: true, control: "pause" })
      expect(await beginStep(db, lease, { key: "more", kind: "read" })).toEqual({ outcome: "refused", reasons: ["pause_requested"] })
      expect(await beginCommandAttempt(db, lease, command.commandId, fx.allPass())).toMatchObject({ outcome: "refused", reasons: ["pause_requested"] })
      // Repeating is a no-op.
      expect(await requestRunControl(db, { ...owner(), runId: lease.runId, kind: "pause", reason: "again" })).toMatchObject({ outcome: "unchanged" })
      expect(await acknowledgeControl(db, lease, "cancel")).toMatchObject({ acknowledged: false, reason: "no_matching_request" })
      expect(await acknowledgeControl(db, lease, "pause")).toEqual({ acknowledged: true, state: "paused" })
      expect(await fx.runRow(lease.runId)).toMatchObject({ state: "paused", lease_expires_at: null, control_acked_by: "worker" })
      expect(await heartbeatRun(db, lease)).toMatchObject({ alive: false })
      // Not resumable until a person says so.
      expect(await claimResumableRun(db, { workerId: randomUUID(), agentId: agent })).toEqual({ outcome: "none" })
      const staffUser = await seedShop(db, { password: "Synthetic-password-123!" })
      fx.seeded.push(staffUser)
      await fx.addMember(w.shop.shopId, staffUser, "staff")
      expect(await resumePausedRun(db, { shopId: w.shop.shopId, actorId: staffUser.ownerId, runId: lease.runId })).toBe("forbidden")
      expect(await resumePausedRun(db, { shopId: w.shop.shopId, actorId: manager.ownerId, runId: lease.runId })).toBe("resumed")
      expect(await resumePausedRun(db, { shopId: w.shop.shopId, actorId: manager.ownerId, runId: lease.runId })).toBe("not_paused")
      const resumed = await claimResumableRun(db, { workerId: randomUUID(), agentId: agent })
      expect(resumed).toMatchObject({ outcome: "claimed", lease: { attempt: 2 } })
      expect(await fx.runRow(lease.runId)).toMatchObject({ state: "running", control_request: null })
    })

    it("cancel with an attempt in flight is REQUESTED, then acknowledged only after the attempt's outcome; provider cancellation is reported separately", async () => {
      const { lease } = await liveRun()
      const pendingCmd = await registered(lease, { commandKey: "never-started" })
      const live = await registered(lease, { commandKey: "in-flight" })
      const a = await started(lease, live.commandId)
      expect(await requestRunControl(db, { ...owner(), runId: lease.runId, kind: "cancel", reason: "Customer called" })).toMatchObject({ outcome: "requested", state: "running" })
      expect((await attempts(live.commandId))[0]).toMatchObject({ state: "started", cancel_state: "requested" })
      expect(await acknowledgeControl(db, lease, "cancel")).toMatchObject({ acknowledged: false, reason: "attempt_in_flight" })
      // The provider could not be stopped: the effect happened and is recorded as such.
      expect(await recordAttemptResult(db, lease, a.attemptId, { result: "succeeded", providerRef: "ref-late", cancel: "not_cancellable" })).toMatchObject({ recorded: true, runState: "running" })
      expect(await acknowledgeControl(db, lease, "cancel")).toEqual({ acknowledged: true, state: "cancelled" })
      expect(await fx.runRow(lease.runId)).toMatchObject({ state: "cancelled", control_acked_by: "worker", lease_expires_at: null })
      expect((await attempts(live.commandId))[0]).toMatchObject({ state: "succeeded", cancel_state: "not_cancellable" })
      expect(await cmdRow(live.commandId)).toMatchObject({ state: "succeeded" }) // truthful: cancelled run, completed effect
      expect(await cmdRow(pendingCmd.commandId)).toMatchObject({ state: "cancelled" })
      expect((await fx.rows("agent_run_steps", lease.runId))[0].state).toBe("abandoned")
    })

    it("a provider that confirms cancellation is recorded as confirmed, and the command stays eligible only through a definitive rejection", async () => {
      const { lease } = await liveRun()
      const command = await registered(lease)
      const a = await started(lease, command.commandId)
      await requestRunControl(db, { ...owner(), runId: lease.runId, kind: "cancel", reason: "stop" })
      expect(await recordAttemptResult(db, lease, a.attemptId, { result: "rejected", cancel: "confirmed_cancelled" })).toMatchObject({ recorded: true })
      expect((await attempts(command.commandId))[0]).toMatchObject({ state: "rejected", cancel_state: "confirmed_cancelled" })
      expect(await acknowledgeControl(db, lease, "cancel")).toMatchObject({ acknowledged: true })
    })

    it("kill is acknowledged by the database at once: the lease is revoked, an in-flight attempt is UNKNOWN, and the run is not called killed until reconciled", async () => {
      const { lease } = await liveRun()
      const idle = await registered(lease, { commandKey: "idle" })
      const flying = await registered(lease, { commandKey: "flying" })
      const a = await started(lease, flying.commandId)
      expect(await requestRunControl(db, { ...owner(), runId: lease.runId, kind: "kill", reason: "Emergency stop" })).toMatchObject({ outcome: "acknowledged", control: "kill", state: "unknown" })
      expect(await fx.runRow(lease.runId)).toMatchObject({ state: "unknown", error_code: "killed_in_flight", control_acked_by: "database", lease_expires_at: null })
      expect((await attempts(flying.commandId))[0]).toMatchObject({ state: "unknown", cancel_state: "unknown" })
      expect(await cmdRow(idle.commandId)).toMatchObject({ state: "cancelled" })
      // The worker is fenced instantly, including its result.
      expect(await heartbeatRun(db, lease)).toMatchObject({ alive: false })
      expect(await recordAttemptResult(db, lease, a.attemptId, { result: "succeeded", providerRef: "ghost" })).toMatchObject({ recorded: false })
      expect(await cmdRow(flying.commandId)).toMatchObject({ state: "unknown" })
      // Reconciling finishes the stop that was asked for: killed, not resumable.
      expect(await resolveReconciliation(db, { ...owner(), commandId: flying.commandId, resolution: "no_effect_confirmed", note: "Nothing in the provider log." })).toMatchObject({ outcome: "resolved", runState: "killed" })
      expect(await fx.runRow(lease.runId)).toMatchObject({ state: "killed", control_request: "kill" })
    })

    it("kill with nothing in flight is simply killed; a waiting run is cancelled or paused immediately; terminal runs stay terminal", async () => {
      const killed = await liveRun()
      await registered(killed.lease)
      expect(await requestRunControl(db, { ...owner(), runId: killed.lease.runId, kind: "kill", reason: "stop" })).toMatchObject({ outcome: "acknowledged", state: "killed" })
      expect(await fx.runRow(killed.lease.runId)).toMatchObject({ state: "killed", finished_at: expect.any(String) })
      expect(await requestRunControl(db, { ...owner(), runId: killed.lease.runId, kind: "cancel", reason: "again" })).toEqual({ outcome: "already_terminal", state: "killed" })

      const waiting = await liveRun()
      expect(await parkWait(db, waiting.lease, "act-1", { kind: "customer_reply", reason: "Waiting for the customer" })).toMatchObject({ waiting: true })
      expect(await requestRunControl(db, { ...owner(), runId: waiting.lease.runId, kind: "pause", reason: "hold" })).toMatchObject({ outcome: "acknowledged", state: "paused" })
      expect(await requestRunControl(db, { ...owner(), runId: waiting.lease.runId, kind: "pause", reason: "hold" })).toMatchObject({ outcome: "unchanged" })
      expect(await requestRunControl(db, { ...owner(), runId: waiting.lease.runId, kind: "cancel", reason: "drop it" })).toMatchObject({ outcome: "acknowledged", state: "cancelled" })
      expect((await waitsOf(waiting.lease.runId)).every((x) => x.state === "cancelled")).toBe(true)
    })

    it("requests only escalate, and only the right people may make them", async () => {
      const { lease } = await liveRun()
      const manager = await seedShop(db, { password: "Synthetic-password-123!" })
      fx.seeded.push(manager)
      await fx.addMember(w.shop.shopId, manager, "manager")
      const stranger = await fx.world()
      expect(await requestRunControl(db, { shopId: w.shop.shopId, actorId: manager.ownerId, runId: lease.runId, kind: "cancel", reason: "x" })).toEqual({ outcome: "forbidden" })
      expect(await requestRunControl(db, { shopId: w.shop.shopId, actorId: manager.ownerId, runId: lease.runId, kind: "kill", reason: "x" })).toEqual({ outcome: "forbidden" })
      expect(await requestRunControl(db, { shopId: w.shop.shopId, actorId: stranger.shop.ownerId, runId: lease.runId, kind: "pause", reason: "x" })).toEqual({ outcome: "forbidden" })
      // Another workspace's run id with its own owner is simply not found.
      expect(await requestRunControl(db, { shopId: stranger.shop.shopId, actorId: stranger.shop.ownerId, runId: lease.runId, kind: "kill", reason: "x" })).toEqual({ outcome: "not_found" })
      expect(await fx.runRow(lease.runId)).toMatchObject({ state: "running", control_request: null })

      expect(await requestRunControl(db, { ...owner(), runId: lease.runId, kind: "pause", reason: "a" })).toMatchObject({ outcome: "requested" })
      expect(await requestRunControl(db, { ...owner(), runId: lease.runId, kind: "cancel", reason: "b" })).toMatchObject({ outcome: "requested", control: "cancel" })
      expect(await requestRunControl(db, { ...owner(), runId: lease.runId, kind: "pause", reason: "c" })).toMatchObject({ outcome: "unchanged", control: "cancel" })
      // A revoked owner-membership loses the ability immediately.
      await fx.addMember(w.shop.shopId, manager, "manager", false)
      expect(await requestRunControl(db, { shopId: w.shop.shopId, actorId: manager.ownerId, runId: lease.runId, kind: "pause", reason: "x" })).toEqual({ outcome: "forbidden" })
      // The system may pause or kill, never cancel.
      expect(await requestRunControl(db, { shopId: w.shop.shopId, runId: lease.runId, kind: "cancel", reason: "x", system: true })).toEqual({ outcome: "unavailable" })
      expect(await requestRunControl(db, { shopId: w.shop.shopId, runId: lease.runId, kind: "kill", reason: "kill switch", system: true })).toMatchObject({ outcome: "acknowledged", state: "killed" })
      expect((await db.from("agent_run_events").select("actor_kind").eq("run_id", lease.runId).eq("kind", "kill_requested")).data![0].actor_kind).toBe("system")
    })
  })

  // ------------------------------------------------------------------------ waits
  describe("waits and resume", () => {
    it("an approval wait releases the lease, links the pending action, and resumes only once it is decided", async () => {
      const { agent, lease } = await liveRun()
      const pending = await fx.stageApproval(w.shop)
      const parked = await parkWait(db, lease, "act-1", {
        kind: "approval", reason: "Waiting for the owner to approve the follow-up", ref: { kind: "pending_action", id: pending },
        ownerUserId: w.shop.ownerId, escalateAt: new Date(Date.now() + 3_600_000), escalateTo: "owner", dueAt: new Date(Date.now() + 86_400_000),
      })
      expect(parked).toMatchObject({ waiting: true })
      expect(await fx.runRow(lease.runId)).toMatchObject({ state: "waiting", lease_expires_at: null, wait_reason: "Waiting for the owner to approve the follow-up" })
      const wait = (await waitsOf(lease.runId))[0]
      expect(wait).toMatchObject({ kind: "approval", state: "open", ref_kind: "pending_action", ref_id: pending, owner_user_id: w.shop.ownerId, escalate_to: "owner" })
      expect(await heartbeatRun(db, lease)).toMatchObject({ alive: false })
      expect(await claimResumableRun(db, { workerId: randomUUID(), agentId: agent })).toEqual({ outcome: "none" })

      expect((await db.from("pending_actions").update({ status: "approved", decided_at: new Date().toISOString(), decided_by_user: w.shop.ownerId }).eq("id", pending)).error).toBeNull()
      const resumed = await claimResumableRun(db, { workerId: randomUUID(), agentId: agent })
      expect(resumed).toMatchObject({ outcome: "claimed", waitKind: "approval", waitResolution: "satisfied", waitRef: { kind: "pending_action", id: pending }, lease: { attempt: 2 } })
      expect((await waitsOf(lease.runId))[0]).toMatchObject({ state: "satisfied", resolution: "satisfied" })
      expect(await beginStep(db, (resumed as { lease: RunLease }).lease, { key: "act-1", kind: "effect" })).toMatchObject({ outcome: "resumed" })
    })

    it("refuses links to another workspace, owners who are not members, bad due times and a second open wait", async () => {
      const other = await fx.world()
      const foreign = await stagePending(db, other.shop.shopId, other.shop.ownerId, "add_note", { n: 1 })
      const { lease } = await liveRun()
      expect(await parkWait(db, lease, "act-1", { kind: "approval", reason: "x", ref: { kind: "pending_action", id: foreign } })).toEqual({ waiting: false, reasons: ["ref_not_found"] })
      expect(await parkWait(db, lease, "act-1", { kind: "customer_reply", reason: "x", ownerUserId: other.shop.ownerId })).toEqual({ waiting: false, reasons: ["owner_not_a_member"] })
      expect(await parkWait(db, lease, "act-1", { kind: "time_window", reason: "x", dueAt: new Date(Date.now() + 200 * 86_400_000) })).toMatchObject({ waiting: false })
      expect(await parkWait(db, lease, "act-1", { kind: "time_window", reason: "x" })).toMatchObject({ waiting: false })
      expect(await fx.runRow(lease.runId)).toMatchObject({ state: "running" })
      // An unconfirmed attempt blocks leaving.
      const command = await registered(lease)
      await started(lease, command.commandId)
      expect(await parkWait(db, lease, "act-1", { kind: "customer_reply", reason: "x" })).toEqual({ waiting: false, reasons: ["attempt_in_flight"] })
    })

    it("a due time resumes as expired; a not-yet-due wait stays; an external event satisfies a customer wait; a reconciliation wait cannot be resolved by an event", async () => {
      const due = await liveRun()
      await parkWait(db, due.lease, "act-1", { kind: "time_window", reason: "Quiet hours", dueAt: new Date(Date.now() - 30_000) })
      const claimed = await claimResumableRun(db, { workerId: randomUUID(), agentId: due.agent })
      expect(claimed).toMatchObject({ outcome: "claimed", waitKind: "time_window", waitResolution: "expired" })

      const future = await liveRun({}, await fx.world())
      await parkWait(db, future.lease, "act-1", { kind: "time_window", reason: "Tomorrow", dueAt: new Date(Date.now() + 3_600_000) })
      expect(await claimResumableRun(db, { workerId: randomUUID(), agentId: future.agent })).toEqual({ outcome: "none" })

      const reply = await liveRun({}, await fx.world())
      await parkWait(db, reply.lease, "act-1", { kind: "customer_reply", reason: "Waiting for a reply" })
      expect(await claimResumableRun(db, { workerId: randomUUID(), agentId: reply.agent })).toEqual({ outcome: "none" })
      const waitId = (await waitsOf(reply.lease.runId))[0].id as string
      expect(await resolveWait(db, waitId, "satisfied", { event: "inbound_sms" })).toBe("resolved")
      expect(await resolveWait(db, waitId, "satisfied")).toBe("unchanged")
      expect(await claimResumableRun(db, { workerId: randomUUID(), agentId: reply.agent })).toMatchObject({ outcome: "claimed" })

      const unknown = await liveRun({}, await fx.world())
      const command = await registered(unknown.lease)
      const a = await started(unknown.lease, command.commandId)
      await recordAttemptResult(db, unknown.lease, a.attemptId, { result: "unknown" })
      const reconciliation = (await waitsOf(unknown.lease.runId)).find((x) => x.kind === "reconciliation")!
      expect(await resolveWait(db, reconciliation.id as string, "satisfied")).toBe("refused")
      expect((await waitsOf(unknown.lease.runId)).find((x) => x.id === reconciliation.id)!.state).toBe("open")
    })

    it("overdue escalations are marked exactly once", async () => {
      const { lease } = await liveRun()
      await parkWait(db, lease, "act-1", { kind: "customer_reply", reason: "x", escalateAt: new Date(Date.now() - 30_000), escalateTo: "manager" })
      await Promise.all([recoverStaleRuns(db), recoverStaleRuns(db), recoverStaleRuns(db)])
      await recoverStaleRuns(db)
      expect((await waitsOf(lease.runId))[0].escalated_at).not.toBeNull()
      expect((await fx.eventKinds(lease.runId)).filter((k) => k === "wait_escalated")).toHaveLength(1)
    })

    it("a binding that broke while waiting FAILS the run with a known state; it never runs under another definition", async () => {
      const { agent, lease } = await liveRun()
      await parkWait(db, lease, "act-1", { kind: "time_window", reason: "due", dueAt: new Date(Date.now() - 30_000) })
      const state = (await db.from("agent_definition_state").select("active_revision").eq("agent_id", agent).single()).data!
      expect((await fx.pauseDefinition(w, agent, state.active_revision as number)).ok).toBe(true)
      expect(await claimResumableRun(db, { workerId: randomUUID(), agentId: agent })).toEqual({ outcome: "none" })
      const row = await fx.runRow(lease.runId)
      expect(row).toMatchObject({ state: "failed", error_code: "binding_not_current", lease_expires_at: null })
      expect(row.binding_at_finish).toContain("agent_disabled")
      expect((await waitsOf(lease.runId)).every((x) => x.state !== "open")).toBe(true)
      expect(await fx.eventKinds(lease.runId)).toContain("resume_refused")
    })

    it("eight concurrent resume claims admit exactly one; the definition's concurrency ceiling holds back a second run", async () => {
      const first = await liveRun()
      await parkWait(db, first.lease, "act-1", { kind: "time_window", reason: "due", dueAt: new Date(Date.now() - 30_000) })
      const results = await Promise.all(Array.from({ length: 8 }, () => claimResumableRun(db, { workerId: randomUUID(), agentId: first.agent })))
      expect(results.filter((r) => r.outcome === "claimed")).toHaveLength(1)
      expect(await fx.runRow(first.lease.runId)).toMatchObject({ state: "running", attempt: 2 })

      // While that run is running, another waiting run of the same agent is not resumed.
      const resumedLease = (results.find((r) => r.outcome === "claimed") as { lease: RunLease }).lease
      await beginStep(db, resumedLease, { key: "act-1", kind: "effect" })
      await parkWait(db, resumedLease, "act-1", { kind: "time_window", reason: "again", dueAt: new Date(Date.now() - 30_000) })
      const second = await fx.claimWindow(first.agent)
      expect(second.outcome).toBe("claimed")
      expect(await claimResumableRun(db, { workerId: randomUUID(), agentId: first.agent })).toEqual({ outcome: "none" })
      expect((await fx.finish(second.lease, "skipped")).data).toBe(true)
      expect(await claimResumableRun(db, { workerId: randomUUID(), agentId: first.agent })).toMatchObject({ outcome: "claimed" })
    })
  })

  // ---------------------------------------------------------------------- finish
  describe("finishing a governed run", () => {
    it("is refused with an unconfirmed attempt, cannot report success past an unknown command, and closes what never started", async () => {
      const { lease } = await liveRun()
      const never = await registered(lease, { commandKey: "never" })
      const command = await registered(lease, { commandKey: "flying" })
      const a = await started(lease, command.commandId)
      expect((await fx.finish(lease, "failed")).data).toBe(false)
      expect((await fx.finish(lease, "succeeded")).data).toBe(false)
      await recordAttemptResult(db, lease, a.attemptId, { result: "succeeded", providerRef: "r" })
      expect((await fx.finish(lease, "succeeded")).data).toBe(true)
      expect(await cmdRow(never.commandId)).toMatchObject({ state: "cancelled" })
      expect((await fx.rows("agent_run_steps", lease.runId))[0].state).toBe("abandoned")
      expect(await fx.runRow(lease.runId)).toMatchObject({ state: "succeeded", fired: true, binding_at_finish: "current" })
      expect(await fx.eventKinds(lease.runId)).toContain("finished")
    })
  })

  // ------------------------------------------------------------ tenancy and privileges
  describe("tenancy, privileges and history", () => {
    it("exposes nothing to browsers or anon, and the service role cannot write the ledger directly", async () => {
      const { lease } = await liveRun()
      const command = await registered(lease)
      await started(lease, command.commandId)
      for (const table of ["agent_run_steps", "agent_run_commands", "agent_run_attempts", "agent_run_waits", "agent_run_events"]) {
        const asOwner = await w.owner.from(table).select("*")
        expect(asOwner.error !== null || (asOwner.data ?? []).length === 0, `${table} owner read`).toBe(true)
        const asAnon = await anonClient().from(table).select("*")
        expect(asAnon.error !== null || (asAnon.data ?? []).length === 0, `${table} anon read`).toBe(true)
        expect((await db.from(table).insert({}).select()).error, `${table} service insert`).not.toBeNull()
        expect((await db.from(table).delete().not("id", "is", null)).error, `${table} service delete`).not.toBeNull()
      }
      expect((await db.from("agent_run_events").update({ kind: "tampered" }).eq("run_id", lease.runId)).error).not.toBeNull()
      // Browsers cannot call any lifecycle function.
      for (const fn of ["heartbeat_agent_run", "recover_stale_agent_runs", "claim_resumable_agent_run", "request_agent_run_control"]) {
        const r = await w.owner.rpc(fn, {})
        expect(r.error, fn).not.toBeNull()
      }
    })

    it("a worker of one workspace cannot link, approve or act on another workspace's records", async () => {
      const other = await fx.world()
      const foreign = await stagePending(db, other.shop.shopId, other.shop.ownerId, "add_note", { n: 1 })
      const { lease } = await liveRun()
      expect(await cmd(lease, { commandKey: "x", intent: "execute", approvalRequired: true, pendingActionId: foreign })).toEqual({ outcome: "refused", reasons: ["approval_missing"] })
      // Another workspace's owner cannot reconcile this workspace's command.
      const command = await registered(lease)
      const a = await started(lease, command.commandId)
      await recordAttemptResult(db, lease, a.attemptId, { result: "unknown" })
      expect(await resolveReconciliation(db, { shopId: other.shop.shopId, actorId: other.shop.ownerId, commandId: command.commandId, resolution: "effect_confirmed", note: "I own this." })).toMatchObject({ outcome: "not_found" })
      expect(await resolveReconciliation(db, { shopId: w.shop.shopId, actorId: other.shop.ownerId, commandId: command.commandId, resolution: "effect_confirmed", note: "I own this." })).toMatchObject({ outcome: "forbidden" })
      expect(await cmdRow(command.commandId)).toMatchObject({ state: "unknown" })
      // A lease from one run never works on another run of the same shop.
      const sibling = await liveRun()
      expect(await beginCommandAttempt(db, sibling.lease, command.commandId, fx.allPass())).toMatchObject({ outcome: "refused", reasons: ["command_not_found"] })
    })

    it("history is append-only for the events ledger and the migration left historical runs untouched", async () => {
      const { lease } = await liveRun()
      const events = (await db.from("agent_run_events").select("*").eq("run_id", lease.runId)).data!
      expect(events.length).toBeGreaterThan(0)
      expect((await db.from("agent_run_events").update({ detail: {} }).eq("id", events[0].id)).error).not.toBeNull()
      // A historical manual run keeps its old shape and the new columns are simply null.
      const history = await db.from("custom_agent_runs").insert({ agent_id: lease.runId ? (await fx.runRow(lease.runId)).agent_id : "", shop_id: w.shop.shopId, trigger_source: "manual", fired: true, state: "succeeded", attempt: 1 }).select("*").single()
      expect(history.error).toBeNull()
      expect(history.data).toMatchObject({ control_request: null, last_heartbeat_at: null, lease_started_at: null, definition_revision: null })
      // Legacy rows can never be waiting, paused, cancelled or killed.
      const bad = await db.from("custom_agent_runs").update({ state: "waiting" }).eq("id", history.data!.id)
      expect(bad.error).not.toBeNull()
    })
  })

  // ------------------------------------------------------------- legacy compatibility
  describe("legacy (ungoverned) runs", () => {
    it("keep their exact claim, expiry and finish behavior; the ledger refuses them; recovery ignores them", async () => {
      const legacy = (await db.from("custom_agents").insert({ shop_id: w.shop.shopId, owner_id: w.shop.ownerId, name: `Legacy ${uniq()}`, problem_text: "x", config: {}, enabled: true }).select("id").single()).data!.id as string
      const c = await fx.claimWindow(legacy)
      expect(c.outcome).toBe("claimed")
      expect((c as unknown as { governed?: boolean }).governed).toBeUndefined()
      // A heartbeat extends a legacy lease too (additive); nothing else of the ledger applies.
      expect(await heartbeatRun(db, c.lease)).toEqual({ alive: true, control: null })
      expect(await beginStep(db, c.lease, { key: "x", kind: "read" })).toEqual({ outcome: "refused", reasons: ["run_not_governed"] })
      expect(await requestRunControl(db, { ...owner(), runId: c.lease.runId, kind: "kill", reason: "x" })).toEqual({ outcome: "not_found" })
      await fx.expireLease(c.run_id)
      await recoverStaleRuns(db)
      expect(await fx.runRow(c.run_id)).toMatchObject({ state: "running" }) // sweep never touches a legacy run
      // The existing contract: the same window answers unknown and marks the run unknown.
      const key = (await fx.runRow(c.run_id)).trigger_key as string
      const again = await db.rpc("claim_scheduled_agent_run", { p_agent: legacy, p_trigger_key: key, p_worker: randomUUID(), p_lease_seconds: 60 })
      expect(again.data).toMatchObject({ outcome: "unknown", run_id: c.run_id })
      expect(await fx.runRow(c.run_id)).toMatchObject({ state: "unknown", error_code: "lease_expired", wait_reason: "reconciliation_required" })
      expect((await fx.rows("agent_run_waits", c.run_id))).toHaveLength(0)
      expect((await fx.rows("agent_run_events", c.run_id))).toHaveLength(0)

      const d = await fx.claimWindow(legacy)
      expect((await fx.finish(d.lease, "succeeded")).data).toBe(true)
      const stamped = await fx.runRow(d.run_id)
      expect(stamped).toMatchObject({ state: "succeeded", fired: true, binding_at_finish: null })
    })
  })
})
