import type { SupabaseClient } from "@supabase/supabase-js"
import { createHash } from "node:crypto"

/**
 * Typed, fail-closed wrappers over the governed-run lifecycle functions
 * (`20261120103700_agent_run_step_lifecycle.sql`). This extends the existing scheduled-run claim
 * (`agent-runs.ts`); it is NOT a second executor and holds no provider code.
 *
 * Every wrapper treats a transport error, a missing field or an unexpected value as "not done":
 * an unverifiable answer is never read as permission, never as success, and never as "nothing
 * happened". Anything that could have reached a provider is reported as `unknown`, never `failed`.
 *
 * See docs/architecture/AGENT_RUN_LIFECYCLE.md for the exact semantics and limitations.
 */

type Db = SupabaseClient

/** What a worker holds while it owns one governed run. `attempt` is the lease fence. */
export type RunLease = { runId: string; workerId: string; attempt: number }

export type StepKind = "read" | "effect" | "decision"
export type CommandIntent = "stage" | "execute"
export type ControlKind = "pause" | "cancel" | "kill"
export type WaitKind = "approval" | "customer_reply" | "time_window" | "connector" | "dependency"

const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const str = (v: unknown): string | null => (typeof v === "string" ? v : null)
const strings = (v: unknown): string[] => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : [])

/** Stable hash of a command payload: key order never changes it, so a replay hashes identically. */
export function payloadHash(payload: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical)
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, canonical(v)]))
    }
    return value
  }
  return createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex")
}

async function call(db: Db, fn: string, args: Record<string, unknown>): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false }> {
  try {
    const { data, error } = await db.rpc(fn, args)
    if (error || data === null || typeof data !== "object") return { ok: false }
    return { ok: true, data: obj(data) }
  } catch {
    return { ok: false }
  }
}

// ---------------------------------------------------------------- heartbeat

export type HeartbeatResult =
  | { alive: true; control: ControlKind | null }
  | { alive: false; reason: string; control: ControlKind | null }

const asControl = (v: unknown): ControlKind | null => (v === "pause" || v === "cancel" || v === "kill" ? v : null)

/** Extends a LIVE lease. `alive: false` (including any error) means: stop, do nothing further. */
export async function heartbeatRun(db: Db, lease: RunLease, leaseSeconds = 120): Promise<HeartbeatResult> {
  const r = await call(db, "heartbeat_agent_run", { p_run: lease.runId, p_worker: lease.workerId, p_attempt: lease.attempt, p_lease_seconds: leaseSeconds })
  if (!r.ok || typeof r.data.alive !== "boolean") return { alive: false, reason: "heartbeat_unverifiable", control: null }
  if (r.data.alive === true) return { alive: true, control: asControl(r.data.control) }
  return { alive: false, reason: str(r.data.reason) ?? "run_not_owned", control: asControl(r.data.control) }
}

// -------------------------------------------------------------------- steps

export type BeginStepResult =
  | { outcome: "started" | "resumed" | "already_running"; stepId: string }
  | { outcome: "replay_done"; stepId: string }
  | { outcome: "refused"; reasons: string[] }

export async function beginStep(db: Db, lease: RunLease, step: { key: string; kind: StepKind }): Promise<BeginStepResult> {
  const r = await call(db, "begin_agent_run_step", { p_run: lease.runId, p_worker: lease.workerId, p_attempt: lease.attempt, p_step_key: step.key, p_kind: step.kind })
  if (!r.ok) return { outcome: "refused", reasons: ["lifecycle_unverifiable"] }
  const o = r.data.outcome
  const stepId = str(r.data.step_id)
  if ((o === "started" || o === "resumed" || o === "already_running") && stepId) return { outcome: o, stepId }
  if (o === "replay_done" && stepId) return { outcome: "replay_done", stepId }
  const reasons = strings(r.data.reasons)
  return { outcome: "refused", reasons: reasons.length > 0 ? reasons : ["lifecycle_unverifiable"] }
}

export async function finishStep(
  db: Db,
  lease: RunLease,
  step: { key: string; state: "succeeded" | "failed" | "skipped"; outcomeCode?: string; evidence?: Record<string, unknown> }
): Promise<boolean> {
  try {
    const { data, error } = await db.rpc("finish_agent_run_step", {
      p_run: lease.runId, p_worker: lease.workerId, p_attempt: lease.attempt, p_step_key: step.key, p_state: step.state,
      p_outcome_code: step.outcomeCode ?? null, p_evidence: step.evidence ?? {},
    })
    return !error && data === true
  } catch {
    return false
  }
}

// ----------------------------------------------------------------- commands

export type RegisterCommandInput = {
  stepKey: string
  commandKey: string
  operation: string
  intent: CommandIntent
  /** Anything that defines the effect (recipient, body, price...). Hashed; never stored. */
  payload: unknown
  credits?: number
  /** Required when the command executes a human-approved action. */
  pendingActionId?: string
  approvalRequired?: boolean
  /** One live command per business object per agent across runs (e.g. `followup:lead:<id>`). */
  dedupeKey?: string
}

export type RegisterCommandResult =
  | { outcome: "registered" | "existing"; commandId: string; state: string; idempotencyKey: string; providerRef: string | null }
  | { outcome: "refused"; reasons: string[] }

export async function registerCommand(db: Db, lease: RunLease, input: RegisterCommandInput): Promise<RegisterCommandResult> {
  const r = await call(db, "register_agent_command", {
    p_run: lease.runId, p_worker: lease.workerId, p_attempt: lease.attempt, p_step_key: input.stepKey,
    p_command_key: input.commandKey, p_operation: input.operation, p_intent: input.intent,
    p_payload_hash: payloadHash(input.payload), p_credits: input.credits ?? 0,
    p_pending_action: input.pendingActionId ?? null, p_approval_required: input.approvalRequired ?? false,
    p_dedupe_key: input.dedupeKey ?? null,
  })
  if (!r.ok) return { outcome: "refused", reasons: ["lifecycle_unverifiable"] }
  const o = r.data.outcome
  const commandId = str(r.data.command_id)
  const key = str(r.data.idempotency_key)
  if ((o === "registered" || o === "existing") && commandId && key) {
    return { outcome: o, commandId, state: str(r.data.state) ?? "pending", idempotencyKey: key, providerRef: str(r.data.provider_ref) }
  }
  const reasons = strings(r.data.reasons)
  return { outcome: "refused", reasons: reasons.length > 0 ? reasons : ["lifecycle_unverifiable"] }
}

export type PreEffectCheck = { name: string; status: "pass" | "fail" | "unknown" | "not_applicable"; code?: string; revision?: number }

export type BeginAttemptResult =
  | { outcome: "started"; attemptId: string; attemptNumber: number; idempotencyKey: string; commandId: string }
  | { outcome: "replay_succeeded"; commandId: string; providerRef: string | null }
  | { outcome: "refused"; reasons: string[]; commandId: string | null }

export async function beginCommandAttempt(db: Db, lease: RunLease, commandId: string, checks: PreEffectCheck[]): Promise<BeginAttemptResult> {
  const r = await call(db, "begin_agent_command_attempt", {
    p_run: lease.runId, p_worker: lease.workerId, p_attempt: lease.attempt, p_command: commandId, p_checks: checks,
  })
  if (!r.ok) return { outcome: "refused", reasons: ["lifecycle_unverifiable"], commandId }
  const o = r.data.outcome
  const attemptId = str(r.data.attempt_id)
  const key = str(r.data.idempotency_key)
  if (o === "started" && attemptId && key && Number.isInteger(r.data.attempt_number)) {
    return { outcome: "started", attemptId, attemptNumber: r.data.attempt_number as number, idempotencyKey: key, commandId }
  }
  if (o === "replay_succeeded") return { outcome: "replay_succeeded", commandId, providerRef: str(r.data.provider_ref) }
  const reasons = strings(r.data.reasons)
  return { outcome: "refused", reasons: reasons.length > 0 ? reasons : ["lifecycle_unverifiable"], commandId }
}

export type ProviderCancelState = "confirmed_cancelled" | "not_cancellable" | "unknown"
export type AttemptResult =
  | { result: "succeeded"; providerRef: string; providerStatus?: string; cancel?: ProviderCancelState; evidence?: Record<string, unknown> }
  /** The provider DEFINITIVELY refused before any effect. Anything ambiguous must be `unknown`. */
  | { result: "rejected"; providerStatus?: string; cancel?: ProviderCancelState; evidence?: Record<string, unknown> }
  | { result: "unknown"; providerStatus?: string; cancel?: ProviderCancelState; evidence?: Record<string, unknown> }

export type RecordResultOutcome =
  | { recorded: true; result: "succeeded" | "rejected" | "unknown"; runState: string }
  | { recorded: false; reason: string }

export async function recordAttemptResult(db: Db, lease: RunLease, attemptId: string, result: AttemptResult): Promise<RecordResultOutcome> {
  const r = await call(db, "record_agent_attempt_result", {
    p_run: lease.runId, p_worker: lease.workerId, p_attempt: lease.attempt, p_attempt_id: attemptId, p_result: result.result,
    p_provider_ref: result.result === "succeeded" ? result.providerRef : null,
    p_provider_status: result.providerStatus ?? null, p_evidence: result.evidence ?? {}, p_cancel_state: result.cancel ?? null,
  })
  if (!r.ok) return { recorded: false, reason: "lifecycle_unverifiable" }
  if (r.data.outcome === "recorded" && (r.data.state === "succeeded" || r.data.state === "rejected" || r.data.state === "unknown")) {
    return { recorded: true, result: r.data.state, runState: str(r.data.run_state) ?? "running" }
  }
  return { recorded: false, reason: str(r.data.reason) ?? "not_recorded" }
}

// ----------------------------------------------------------------- control

export type RequestControlResult =
  | { outcome: "requested" | "acknowledged" | "unchanged"; control: ControlKind; state: string }
  | { outcome: "already_terminal"; state: string }
  | { outcome: "not_found" }
  | { outcome: "forbidden" }
  | { outcome: "unavailable" }

/**
 * A human (owner, or manager for pause) or the system asks a governed run to stop. `requested` means a
 * live worker has been asked and will acknowledge at a safe boundary; `acknowledged` means the database
 * already applied it (no live worker, or kill). Requested is NOT stopped.
 */
export async function requestRunControl(
  db: Db,
  input: { shopId: string; runId: string; kind: ControlKind; reason: string } & ({ actorId: string; system?: false } | { actorId?: null; system: true })
): Promise<RequestControlResult> {
  try {
    const { data, error } = await db.rpc("request_agent_run_control", {
      p_shop: input.shopId, p_actor: input.actorId ?? null, p_run: input.runId, p_kind: input.kind, p_reason: input.reason, p_system: input.system === true,
    })
    if (error) return error.code === "42501" ? { outcome: "forbidden" } : { outcome: "unavailable" }
    const o = obj(data)
    const control = asControl(o.control)
    if ((o.outcome === "requested" || o.outcome === "acknowledged" || o.outcome === "unchanged") && control && typeof o.state === "string") {
      return { outcome: o.outcome, control, state: o.state }
    }
    if (o.outcome === "already_terminal" && typeof o.state === "string") return { outcome: "already_terminal", state: o.state }
    if (o.outcome === "not_found") return { outcome: "not_found" }
    return { outcome: "unavailable" }
  } catch {
    return { outcome: "unavailable" }
  }
}

export async function acknowledgeControl(db: Db, lease: RunLease, ack: "pause" | "cancel"): Promise<{ acknowledged: true; state: "paused" | "cancelled" } | { acknowledged: false; reason: string }> {
  const r = await call(db, "acknowledge_agent_run_control", { p_run: lease.runId, p_worker: lease.workerId, p_attempt: lease.attempt, p_ack: ack })
  if (r.ok && r.data.outcome === "acknowledged" && (r.data.state === "paused" || r.data.state === "cancelled")) {
    return { acknowledged: true, state: r.data.state }
  }
  return { acknowledged: false, reason: r.ok ? (str(r.data.reason) ?? "refused") : "lifecycle_unverifiable" }
}

export async function resumePausedRun(db: Db, input: { shopId: string; actorId: string; runId: string }): Promise<"resumed" | "not_paused" | "not_found" | "forbidden" | "unavailable"> {
  try {
    const { data, error } = await db.rpc("resume_paused_agent_run", { p_shop: input.shopId, p_actor: input.actorId, p_run: input.runId })
    if (error) return error.code === "42501" ? "forbidden" : "unavailable"
    const o = obj(data).outcome
    return o === "resumed" || o === "not_paused" || o === "not_found" ? o : "unavailable"
  } catch {
    return "unavailable"
  }
}

// -------------------------------------------------------------------- waits

export type WaitSpec = {
  kind: WaitKind
  reason: string
  dueAt?: Date
  ownerUserId?: string
  escalateAt?: Date
  escalateTo?: "owner" | "manager"
  ref?: { kind: "pending_action" | "customer"; id: string }
}

export async function parkWait(db: Db, lease: RunLease, stepKey: string, wait: WaitSpec): Promise<{ waiting: true; waitId: string } | { waiting: false; reasons: string[] }> {
  const r = await call(db, "park_agent_run_wait", {
    p_run: lease.runId, p_worker: lease.workerId, p_attempt: lease.attempt, p_step_key: stepKey, p_kind: wait.kind, p_reason: wait.reason,
    p_due_at: wait.dueAt?.toISOString() ?? null, p_owner: wait.ownerUserId ?? null, p_escalate_at: wait.escalateAt?.toISOString() ?? null,
    p_escalate_to: wait.escalateTo ?? null, p_ref_kind: wait.ref?.kind ?? "none", p_ref_id: wait.ref?.id ?? null,
  })
  if (r.ok && r.data.outcome === "waiting" && str(r.data.wait_id)) return { waiting: true, waitId: str(r.data.wait_id)! }
  const reasons = r.ok ? strings(r.data.reasons) : []
  return { waiting: false, reasons: reasons.length > 0 ? reasons : ["lifecycle_unverifiable"] }
}

export async function resolveWait(db: Db, waitId: string, resolution: "satisfied" | "expired", evidence: Record<string, unknown> = {}): Promise<"resolved" | "unchanged" | "refused" | "not_found" | "unavailable"> {
  const r = await call(db, "resolve_agent_run_wait", { p_wait: waitId, p_resolution: resolution, p_evidence: evidence })
  if (!r.ok) return "unavailable"
  const o = r.data.outcome
  return o === "resolved" || o === "unchanged" || o === "refused" || o === "not_found" ? o : "unavailable"
}

export type ResumeClaim =
  | {
      outcome: "claimed"
      lease: RunLease
      shopId: string
      agentId: string
      definitionSnapshot: unknown
      definitionRevision: number
      waitKind: string
      waitResolution: string
      waitRef: { kind: string; id: string | null }
    }
  | { outcome: "none" }

/** Claims one waiting run that is ready (approval decided, due, restart recovery). Throws on a broken answer. */
export async function claimResumableRun(db: Db, input: { workerId: string; leaseSeconds?: number; agentId?: string }): Promise<ResumeClaim> {
  const r = await call(db, "claim_resumable_agent_run", { p_worker: input.workerId, p_lease_seconds: input.leaseSeconds ?? 120, p_agent: input.agentId ?? null })
  if (!r.ok) throw new Error("[run-lifecycle] resume claim failed")
  if (r.data.outcome === "none") return { outcome: "none" }
  const d = r.data
  if (d.outcome === "claimed" && str(d.run_id) && str(d.shop_id) && str(d.agent_id) && Number.isInteger(d.attempt) && Number.isInteger(d.definition_revision)) {
    return {
      outcome: "claimed",
      lease: { runId: d.run_id as string, workerId: input.workerId, attempt: d.attempt as number },
      shopId: d.shop_id as string,
      agentId: d.agent_id as string,
      definitionSnapshot: d.definition_snapshot,
      definitionRevision: d.definition_revision as number,
      waitKind: str(d.wait_kind) ?? "restart_recovery",
      waitResolution: str(d.wait_resolution) ?? "resumed",
      waitRef: { kind: str(d.wait_ref_kind) ?? "none", id: str(d.wait_ref_id) },
    }
  }
  throw new Error("[run-lifecycle] resume claim returned an invalid response")
}

// ----------------------------------------------------- recovery, reconciliation

export type RecoverySweep = { recovered: Record<string, number>; escalated: number }

/** Restart recovery: classify every governed run whose lease expired. Safe from any number of instances. */
export async function recoverStaleRuns(db: Db, limit = 50): Promise<RecoverySweep> {
  const r = await call(db, "recover_stale_agent_runs", { p_limit: limit })
  if (!r.ok) throw new Error("[run-lifecycle] stale recovery failed")
  const recovered: Record<string, number> = {}
  for (const [k, v] of Object.entries(obj(r.data.recovered))) if (typeof v === "number") recovered[k] = v
  return { recovered, escalated: typeof r.data.escalated === "number" ? r.data.escalated : 0 }
}

export type ReconciliationResolution = "effect_confirmed" | "no_effect_confirmed" | "cannot_determine"

/** A person (owner or manager) records what actually happened to an unknown attempt, with a written note. */
export async function resolveReconciliation(
  db: Db,
  input: { shopId: string; actorId: string; commandId: string; resolution: ReconciliationResolution; note: string; providerRef?: string }
): Promise<{ outcome: "resolved" | "recorded_unresolved" | "not_unknown" | "not_found" | "forbidden" | "invalid" | "unavailable"; runState?: string }> {
  try {
    const { data, error } = await db.rpc("resolve_agent_command_reconciliation", {
      p_shop: input.shopId, p_actor: input.actorId, p_command: input.commandId, p_resolution: input.resolution,
      p_provider_ref: input.providerRef ?? null, p_evidence: { note: input.note },
    })
    if (error) return { outcome: error.code === "42501" ? "forbidden" : error.code === "22023" ? "invalid" : "unavailable" }
    const o = obj(data)
    if (o.outcome === "resolved" || o.outcome === "recorded_unresolved" || o.outcome === "not_unknown" || o.outcome === "not_found") {
      return { outcome: o.outcome, ...(str(o.run_state) ? { runState: str(o.run_state)! } : {}) }
    }
    return { outcome: "unavailable" }
  } catch {
    return { outcome: "unavailable" }
  }
}
