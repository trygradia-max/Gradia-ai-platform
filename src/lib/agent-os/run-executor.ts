import type { SupabaseClient } from "@supabase/supabase-js"

import { finishScheduledAgentRun } from "@/lib/agent-runs"
import type { Mode, Operation } from "@/lib/control-center/policy"
import {
  recheckBeforeEffect,
  type ConsentSubject,
  type EffectCheckResolvers,
} from "@/lib/agent-os/pre-effect-checks"
import {
  acknowledgeControl,
  beginCommandAttempt,
  beginStep,
  finishStep,
  heartbeatRun,
  parkWait,
  payloadHash,
  recordAttemptResult,
  registerCommand,
  type AttemptResult,
  type CommandIntent,
  type ControlKind,
  type ProviderCancelState,
  type RunLease,
  type StepKind,
  type WaitSpec,
} from "@/lib/agent-os/run-lifecycle"

/**
 * The step runner for ONE governed run that a worker already owns (a window claim or a resume claim).
 * It is the loop around the existing scheduled-run claim, not a scheduler and not a second executor:
 * it never claims windows, never calls a provider itself, and owns no recipe logic. Playbooks supply
 * steps; effects are injected as functions that talk to a provider seam.
 *
 * Contract for every external effect (`StepScope.command`):
 *   1. register a stable command (identity and payload hash are fixed);
 *   2. re-evaluate policy, consent, readiness, approval, budget and grants;
 *   3. ask the database to admit the attempt - the attempt row is durable BEFORE the provider is called;
 *   4. run the effect under a heartbeat;
 *   5. record the result. A thrown error, a timeout or any ambiguity is `unknown` and is NEVER retried.
 */

export type RunClaim = {
  lease: RunLease
  shopId: string
  agentId: string
  /** The immutable snapshot the run was bound to at claim time. */
  definitionSnapshot: { tools: { operation: string; maximumMode: Mode }[] }
  policyRevision: number | null
}

export type EffectOutcome =
  | { kind: "accepted"; providerRef: string; providerStatus?: string; pendingActionId?: string; cancel?: ProviderCancelState }
  /** The provider definitively refused before doing anything. Use ONLY when that is certain. */
  | { kind: "rejected"; providerStatus?: string; cancel?: ProviderCancelState }
  | { kind: "unknown"; providerStatus?: string; cancel?: ProviderCancelState }

export type EffectContext = {
  /** Hand to the provider on every attempt of this command so provider-side de-duplication applies. */
  idempotencyKey: string
  attemptId: string
  attemptNumber: number
  /** Aborts when the worker must stop (cancel / kill requested, lease lost). */
  signal: AbortSignal
}

export type CommandSpec = {
  commandKey: string
  operation: Operation
  intent: CommandIntent
  payload: unknown
  credits?: number
  pendingActionId?: string
  approvalRequired?: boolean
  dedupeKey?: string
  subject?: ConsentSubject
  safetyVerified?: boolean
  causalActionVerified?: boolean
}

export type CommandOutcome =
  | { outcome: "done"; commandId: string; providerRef: string | null; replayed: boolean; pendingActionId?: string }
  /** Refused before any effect: a check, the binding, a limit or a pending stop. Nothing was attempted. */
  | { outcome: "blocked"; reasons: string[]; commandId: string | null }
  /** The provider definitively refused; no effect occurred. The command may take a fresh admitted attempt. */
  | { outcome: "rejected"; commandId: string }
  /** The outcome is unconfirmed. The run is now `unknown`; a person reconciles. Never retried. */
  | { outcome: "unknown"; commandId: string; recorded: boolean }

export type StepOutcome =
  | { kind: "done"; evidence?: Record<string, unknown> }
  | { kind: "wait"; wait: WaitSpec }
  | { kind: "halt" }
  | { kind: "fail"; code: string; reason?: string }

export type StepScope = {
  lease: RunLease
  claim: RunClaim
  signal: AbortSignal
  command(spec: CommandSpec, effect: (ctx: EffectContext) => Promise<EffectOutcome>): Promise<CommandOutcome>
}

export type PlaybookStep = { key: string; kind: StepKind; run: (scope: StepScope) => Promise<StepOutcome> }
export type Playbook = { steps: PlaybookStep[] }

export type RunOutcome =
  | { state: "succeeded" }
  | { state: "failed"; code: string; reason: string }
  | { state: "waiting"; waitId: string }
  | { state: "paused" | "cancelled" }
  | { state: "unknown"; reason: string }
  /** This worker no longer owns the run (lease lost, killed, or stopped elsewhere). Nothing more was done. */
  | { state: "lease_lost"; reason: string }

export type ExecutorDeps = {
  db: SupabaseClient
  checks: EffectCheckResolvers
  leaseSeconds?: number
  /** How often the lease is extended while an effect runs. Must be well under the lease. */
  heartbeatMs?: number
}

const DEFAULT_LEASE_SECONDS = 120

export async function runPlaybook(deps: ExecutorDeps, claim: RunClaim, playbook: Playbook): Promise<RunOutcome> {
  const { db } = deps
  const lease = claim.lease
  const leaseSeconds = deps.leaseSeconds ?? DEFAULT_LEASE_SECONDS
  const stopController = new AbortController()
  const pendingActionIds: string[] = []
  let sawUnknown: CommandOutcome | null = null

  const finishRun = async (state: "succeeded" | "failed", code: string | undefined, reason: string): Promise<boolean> => {
    try {
      return await finishScheduledAgentRun(db, {
        runId: lease.runId, workerId: lease.workerId, attempt: lease.attempt, state, fired: state === "succeeded",
        reason, errorCode: code, pendingActionIds,
      })
    } catch {
      return false
    }
  }

  /** A pending pause/cancel is acknowledged only here, at a boundary with no attempt in flight. */
  const acknowledge = async (control: ControlKind | null): Promise<RunOutcome | null> => {
    if (control !== "pause" && control !== "cancel") return null
    const ack = await acknowledgeControl(db, lease, control)
    if (ack.acknowledged) return { state: ack.state }
    return { state: "lease_lost", reason: ack.reason }
  }

  for (const step of playbook.steps) {
    const hb = await heartbeatRun(db, lease, leaseSeconds)
    if (!hb.alive) return { state: "lease_lost", reason: hb.reason }
    const stopped = await acknowledge(hb.control)
    if (stopped) return stopped

    const begun = await beginStep(db, lease, { key: step.key, kind: step.kind })
    if (begun.outcome === "refused") {
      const control = begun.reasons.find((r) => r === "pause_requested" || r === "cancel_requested")
      if (control) return (await acknowledge(control === "pause_requested" ? "pause" : "cancel")) ?? { state: "lease_lost", reason: control }
      if (begun.reasons.includes("run_not_owned")) return { state: "lease_lost", reason: "run_not_owned" }
      const reason = `step refused: ${begun.reasons.join(", ")}`.slice(0, 900)
      return (await finishRun("failed", "step_refused", reason)) ? { state: "failed", code: "step_refused", reason } : { state: "lease_lost", reason: "finish_unconfirmed" }
    }
    if (begun.outcome === "replay_done") continue

    const scope: StepScope = {
      lease,
      claim,
      signal: stopController.signal,
      command: async (spec, effect) => {
        const result = await executeCommand(deps, claim, step.key, spec, effect, pendingActionIds, stopController)
        if (result.outcome === "unknown") sawUnknown = result
        return result
      },
    }
    let outcome: StepOutcome
    try {
      outcome = await step.run(scope)
    } catch {
      // A step that throws outside a command has done nothing external through this runner.
      outcome = { kind: "fail", code: "step_error", reason: "The step raised an error before any external effect." }
    }

    if (outcome.kind === "halt") {
      // An unconfirmed attempt stops everything: the run is already `unknown` (or will be at lease expiry).
      if (sawUnknown) return { state: "unknown", reason: "An external attempt has no confirmed outcome; a person must reconcile it." }
      // Otherwise a stop was requested (or the lease was lost) mid-step.
      const after = await heartbeatRun(db, lease, leaseSeconds)
      if (!after.alive) return { state: "lease_lost", reason: after.reason }
      const stopped2 = await acknowledge(after.control)
      return stopped2 ?? { state: "lease_lost", reason: "halted" }
    }
    if (outcome.kind === "wait") {
      const wait = await parkWait(db, lease, step.key, outcome.wait)
      if (wait.waiting) return { state: "waiting", waitId: wait.waitId }
      const control = wait.reasons.find((r) => r === "pause_requested" || r === "cancel_requested")
      if (control) return (await acknowledge(control === "pause_requested" ? "pause" : "cancel")) ?? { state: "lease_lost", reason: control }
      const reason = `wait refused: ${wait.reasons.join(", ")}`.slice(0, 900)
      await finishStep(db, lease, { key: step.key, state: "failed", outcomeCode: "wait_refused" })
      return (await finishRun("failed", "wait_refused", reason)) ? { state: "failed", code: "wait_refused", reason } : { state: "lease_lost", reason: "finish_unconfirmed" }
    }
    if (outcome.kind === "fail") {
      await finishStep(db, lease, { key: step.key, state: "failed", outcomeCode: outcome.code.slice(0, 80) })
      const reason = (outcome.reason ?? outcome.code).slice(0, 900)
      return (await finishRun("failed", outcome.code.slice(0, 80), reason)) ? { state: "failed", code: outcome.code, reason } : { state: "lease_lost", reason: "finish_unconfirmed" }
    }
    const closed = await finishStep(db, lease, { key: step.key, state: "succeeded", evidence: outcome.evidence })
    if (!closed) return { state: "lease_lost", reason: "step_close_unconfirmed" }
  }

  return (await finishRun("succeeded", undefined, "All steps completed.")) ? { state: "succeeded" } : { state: "lease_lost", reason: "finish_unconfirmed" }
}

async function executeCommand(
  deps: ExecutorDeps,
  claim: RunClaim,
  stepKey: string,
  spec: CommandSpec,
  effect: (ctx: EffectContext) => Promise<EffectOutcome>,
  pendingActionIds: string[],
  stop: AbortController
): Promise<CommandOutcome> {
  const { db } = deps
  const lease = claim.lease
  const leaseSeconds = deps.leaseSeconds ?? DEFAULT_LEASE_SECONDS

  const registered = await registerCommand(db, lease, {
    stepKey, commandKey: spec.commandKey, operation: spec.operation, intent: spec.intent, payload: spec.payload,
    credits: spec.credits, pendingActionId: spec.pendingActionId, approvalRequired: spec.approvalRequired, dedupeKey: spec.dedupeKey,
  })
  if (registered.outcome === "refused") return { outcome: "blocked", reasons: registered.reasons, commandId: null }

  const checks = await recheckBeforeEffect(deps.checks, {
    shopId: claim.shopId, agentId: claim.agentId, commandId: registered.commandId, operation: spec.operation, intent: spec.intent,
    payloadHash: payloadHash(spec.payload), approvalRequired: spec.approvalRequired ?? false, pendingActionId: spec.pendingActionId,
    tools: claim.definitionSnapshot.tools, boundPolicyRevision: claim.policyRevision, subject: spec.subject,
    safetyVerified: spec.safetyVerified, causalActionVerified: spec.causalActionVerified,
  })
  const admitted = await beginCommandAttempt(db, lease, registered.commandId, checks)
  if (admitted.outcome === "replay_succeeded") {
    return { outcome: "done", commandId: registered.commandId, providerRef: admitted.providerRef, replayed: true }
  }
  if (admitted.outcome === "refused") return { outcome: "blocked", reasons: admitted.reasons, commandId: registered.commandId }

  // From here an effect may reach a provider. Keep the lease alive for as long as it runs.
  const controller = new AbortController()
  const onStop = () => controller.abort()
  stop.signal.addEventListener("abort", onStop, { once: true })
  const intervalMs = deps.heartbeatMs ?? Math.max(1_000, Math.floor((leaseSeconds * 1_000) / 3))
  let beating = true
  const timer = setInterval(() => {
    if (!beating) return
    void heartbeatRun(db, lease, leaseSeconds).then((hb) => {
      if (!hb.alive || hb.control === "cancel" || hb.control === "kill") controller.abort()
    })
  }, intervalMs)

  let observed: AttemptResult
  let pendingActionId: string | undefined
  try {
    const outcome = await effect({ idempotencyKey: admitted.idempotencyKey, attemptId: admitted.attemptId, attemptNumber: admitted.attemptNumber, signal: controller.signal })
    if (outcome.kind === "accepted") {
      // A provider that says "accepted" without a reference cannot be confirmed: that is unknown, not success.
      observed = outcome.providerRef && outcome.providerRef.length <= 200
        ? { result: "succeeded", providerRef: outcome.providerRef, providerStatus: outcome.providerStatus, cancel: outcome.cancel }
        : { result: "unknown", providerStatus: "accepted_without_reference", cancel: outcome.cancel }
      pendingActionId = outcome.pendingActionId
    } else if (outcome.kind === "rejected") {
      observed = { result: "rejected", providerStatus: outcome.providerStatus, cancel: outcome.cancel }
    } else {
      observed = { result: "unknown", providerStatus: outcome.providerStatus, cancel: outcome.cancel }
    }
  } catch {
    // A throw, a timeout, a dropped connection: the provider may or may not have acted. Never "failed".
    observed = { result: "unknown", providerStatus: "effect_threw" }
  } finally {
    beating = false
    clearInterval(timer)
    stop.signal.removeEventListener("abort", onStop)
  }

  const recorded = await recordAttemptResult(db, lease, admitted.attemptId, observed)
  if (!recorded.recorded) {
    // The attempt row stays `started`: lease expiry will classify it as unknown. Do not touch the run.
    return { outcome: "unknown", commandId: registered.commandId, recorded: false }
  }
  if (recorded.result === "succeeded" && observed.result === "succeeded") {
    if (pendingActionId) pendingActionIds.push(pendingActionId)
    return { outcome: "done", commandId: registered.commandId, providerRef: observed.providerRef, replayed: false, pendingActionId }
  }
  if (recorded.result === "rejected") return { outcome: "rejected", commandId: registered.commandId }
  return { outcome: "unknown", commandId: registered.commandId, recorded: true }
}
