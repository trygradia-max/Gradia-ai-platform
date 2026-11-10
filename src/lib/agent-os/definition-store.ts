import type { SupabaseClient } from "@supabase/supabase-js"

import {
  agentDefinitionDraftSchema,
  compileAgentDefinition,
  type AgentDefinitionDraft,
} from "@/lib/agent-os/definition"
import { resolveBlockedActivation } from "@/lib/agent-os/activation"
import {
  ACTIVATION_BLOCKERS,
  isActivationBlocker,
  type ActivationBlocker,
  type ActivationEligibilityDto,
  type ActivationEvidenceDto,
  type ActorRole,
  type AgentDetailDto,
  type AgentsHomeDto,
  type AgentSummaryDto,
  type BuilderResumeDto,
  type BuilderSteps,
  type DefinitionLifecycle,
  type DtoResult,
  type EvaluationDto,
  type MemoryPinDto,
  type RevisionDto,
  type RevisionRef,
  type ToolDecisionDto,
} from "@/lib/agent-os/definition-dto"
import { FOUNDER_PILOT_POLICY } from "@/lib/approved-commercial-catalog"
import { loadChannelReadiness } from "@/lib/data/channel-readiness"
import type { CommercialBillingDto } from "@/lib/commercial-billing"
import type { BillingRuntime } from "@/lib/commercial-billing-service"
import { policyDraftSchema, type PolicyDraft } from "@/lib/control-center/drafts"
import { ACTIONS, evaluatePolicy, modes, type Mode, type Operation } from "@/lib/control-center/policy"

/**
 * Persistence + evidence layer for immutable Gradia Agent definition revisions.
 *
 * Authority model: nothing in this module trusts the browser. The shop and actor are
 * supplied by a server action that derived them from the session; every writer is a
 * service-role-only database command that RE-VERIFIES a live owner of that exact shop.
 * Policy, memory, connector, evaluation and billing facts are loaded here, server-side,
 * and re-checked by the database under lock. Nothing is silently refreshed or guessed.
 */

export const ACTIVE_AGENT_LIMIT = FOUNDER_PILOT_POLICY.includedActiveAgents
const EVALUATION_PASS_THRESHOLD = 0.95

type Db = { service: SupabaseClient }

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export type DefinitionInput = Omit<AgentDefinitionDraft, "revision" | "lifecycle">

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Validates an owner-authored definition with the EXISTING schema. The caller never
 * supplies a revision number or lifecycle: those are assigned by the database, so a
 * stored revision can never claim to be active.
 */
export function parseDefinitionInput(
  raw: unknown
): { ok: true; definition: DefinitionInput } | { ok: false; code: "invalid_definition" } {
  if (!isPlainObject(raw) || "revision" in raw || "lifecycle" in raw) {
    return { ok: false, code: "invalid_definition" }
  }
  const parsed = agentDefinitionDraftSchema.safeParse({ ...raw, revision: 1, lifecycle: "draft" })
  if (!parsed.success) return { ok: false, code: "invalid_definition" }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { revision: _revision, lifecycle: _lifecycle, ...definition } = parsed.data
  return { ok: true, definition }
}

type RpcFailure = "forbidden" | "conflict" | "invalid" | "unavailable"
function rpcFailure(error: { code?: string }): RpcFailure {
  if (error.code === "42501") return "forbidden"
  if (error.code === "AD409") return "conflict"
  if (error.code === "22023") return "invalid"
  return "unavailable"
}

// ---------------------------------------------------------------------------
// Writers (service-role RPCs)
// ---------------------------------------------------------------------------

export type CreateRevisionResult =
  | { ok: true; outcome: "created" | "replayed"; revision: number; definitionHash: string; parentRevision: number | null }
  | {
      ok: false
      code:
        | "invalid_definition" | "forbidden" | "conflict" | "unavailable"
        | "agent_not_found" | "legacy_agent_enabled" | "parent_not_found" | "memory_not_selectable"
      sourceIds?: string[]
    }

/** Saves one immutable revision. Exact replay (same request id + content) returns the same revision. */
export async function createAgentDefinitionRevision(
  deps: Db,
  input: {
    shopId: string; actorId: string; agentId: string; requestId: string; definition: unknown; parentRevision?: number | null
    /** The latest revision the caller saw (null = none). Omitted = not enforced. */
    expectedLatest?: number | null
  }
): Promise<CreateRevisionResult> {
  const parsed = parseDefinitionInput(input.definition)
  if (!parsed.ok) return { ok: false, code: "invalid_definition" }
  const { data, error } = await deps.service.rpc("agent_definition_create_revision", {
    p_shop: input.shopId,
    p_actor: input.actorId,
    p_agent: input.agentId,
    p_request_id: input.requestId,
    p_definition: parsed.definition,
    p_parent: input.parentRevision ?? null,
    // Decided inside the RPC under the agent/state locks (NULL = not enforced, 0 = nothing saved yet).
    p_expected_latest: input.expectedLatest === undefined ? null : (input.expectedLatest ?? 0),
  })
  if (error) {
    const kind = rpcFailure(error)
    return { ok: false, code: kind === "invalid" ? "invalid_definition" : kind }
  }
  const row = (data ?? {}) as Record<string, unknown>
  if ((row.outcome === "created" || row.outcome === "replayed") && Number.isInteger(row.revision) && typeof row.definition_hash === "string") {
    return {
      ok: true,
      outcome: row.outcome,
      revision: row.revision as number,
      definitionHash: row.definition_hash,
      parentRevision: Number.isInteger(row.parent_revision) ? (row.parent_revision as number) : null,
    }
  }
  if (row.outcome === "blocked") {
    const code = row.code
    if (code === "stale_latest") return { ok: false, code: "conflict" }
    if (code === "agent_not_found" || code === "legacy_agent_enabled" || code === "parent_not_found" || code === "memory_not_selectable") {
      return {
        ok: false,
        code,
        ...(Array.isArray(row.source_ids) ? { sourceIds: row.source_ids.filter((v): v is string => typeof v === "string") } : {}),
      }
    }
  }
  return { ok: false, code: "unavailable" }
}

export type TrustedEvaluationInput = {
  shopId: string
  agentId: string
  revision: number
  definitionHash: string
  evaluationKey: string
  suiteVersion: string
  fixtureSetId: string
  fixtureHash: string
  passRate: number
  safetyPassed: boolean
  estimatedCredits: number
  costEvidence?: Record<string, unknown>
  completedAt: string
}

/**
 * The ONLY writer of evaluation evidence. It is deliberately not a server action and is
 * not exported from the actions module: it is for the trusted offline evaluator (a later
 * slice) and test fixtures. The database accepts it from the service role only and the
 * activation command never takes evaluation facts as input.
 */
export async function recordTrustedAgentEvaluation(
  deps: Db,
  input: TrustedEvaluationInput
): Promise<{ ok: true; outcome: "recorded" | "replayed"; evaluationId: string } | { ok: false; code: "forbidden" | "conflict" | "invalid" | "unavailable" | "revision_not_found" | "definition_hash_mismatch" | "agent_not_found" }> {
  const { data, error } = await deps.service.rpc("agent_definition_record_evaluation", {
    p_shop: input.shopId,
    p_agent: input.agentId,
    p_revision: input.revision,
    p_definition_hash: input.definitionHash,
    p_evaluation_key: input.evaluationKey,
    p_suite_version: input.suiteVersion,
    p_fixture_set_id: input.fixtureSetId,
    p_fixture_hash: input.fixtureHash,
    p_pass_rate: input.passRate,
    p_safety_passed: input.safetyPassed,
    p_estimated_credits: input.estimatedCredits,
    p_cost_evidence: input.costEvidence ?? {},
    p_completed_at: input.completedAt,
    p_source: "trusted_evaluator",
  })
  if (error) return { ok: false, code: rpcFailure(error) }
  const row = (data ?? {}) as Record<string, unknown>
  if ((row.outcome === "recorded" || row.outcome === "replayed") && typeof row.evaluation_id === "string") {
    return { ok: true, outcome: row.outcome, evaluationId: row.evaluation_id }
  }
  if (row.outcome === "blocked" && (row.code === "revision_not_found" || row.code === "definition_hash_mismatch" || row.code === "agent_not_found")) {
    return { ok: false, code: row.code }
  }
  return { ok: false, code: "unavailable" }
}

export type LifecycleChangeResult =
  | { ok: true; outcome: "changed" | "unchanged" }
  | { ok: false; code: "forbidden" | "unavailable" | "invalid" | "agent_not_found" | "no_active_definition" | "pointer_changed" | "invalid_transition" }

/** Owner-only pause/block. Resuming is a fresh activation with fresh evidence. */
export async function setAgentDefinitionLifecycle(
  deps: Db,
  input: { shopId: string; actorId: string; agentId: string; lifecycle: "paused" | "blocked"; reason: string; expectedPointer: number | null }
): Promise<LifecycleChangeResult> {
  const { data, error } = await deps.service.rpc("agent_definition_set_lifecycle", {
    p_shop: input.shopId,
    p_actor: input.actorId,
    p_agent: input.agentId,
    p_lifecycle: input.lifecycle,
    p_reason: input.reason,
    p_expected_pointer: input.expectedPointer,
  })
  if (error) {
    const kind = rpcFailure(error)
    return { ok: false, code: kind === "conflict" ? "unavailable" : kind }
  }
  const row = (data ?? {}) as Record<string, unknown>
  if (row.outcome === "changed" || row.outcome === "unchanged") return { ok: true, outcome: row.outcome }
  if (row.outcome === "blocked" && (row.code === "agent_not_found" || row.code === "no_active_definition" || row.code === "pointer_changed" || row.code === "invalid_transition")) {
    return { ok: false, code: row.code }
  }
  return { ok: false, code: "unavailable" }
}

// ---------------------------------------------------------------------------
// Evidence loading (server-side only)
// ---------------------------------------------------------------------------

class Unavailable extends Error {}
function ok<T>(res: { data: T | null; error: unknown }, what: string): T {
  if (res.error || res.data === null) throw new Unavailable(what)
  return res.data
}

type AgentRow = { id: string; name: string; enabled: boolean }
type StateRow = {
  agent_id: string
  lifecycle: DefinitionLifecycle
  active_revision: number | null
  latest_revision: number
  lifecycle_reason: string | null
  version: number
}
type RevisionRow = {
  agent_id: string
  revision: number
  parent_revision: number | null
  schema_version: number
  definition: unknown
  definition_hash: string
  authored_by: string
  created_at: string
}
type EvaluationRow = {
  id: string
  revision: number
  suite_version: string
  fixture_set_id: string
  fixture_hash: string
  pass_rate: number | string
  safety_passed: boolean
  estimated_credits: number
  completed_at: string
  source: "trusted_evaluator"
}

const toRef = (row: Pick<RevisionRow, "revision" | "definition_hash" | "created_at" | "parent_revision">): RevisionRef => ({
  revision: row.revision,
  definitionHash: row.definition_hash,
  createdAt: row.created_at,
  parentRevision: row.parent_revision,
})

async function actorRole(deps: Db, shopId: string, actorId: string): Promise<ActorRole | null> {
  const { data, error } = await deps.service.rpc("agent_definition_actor_role", { p_shop: shopId, p_actor: actorId })
  if (error) throw new Unavailable("role")
  return data === "owner" || data === "manager" || data === "staff" ? data : null
}

type PolicyContext = { revision: number; draft: PolicyDraft; locationId: string }

async function loadPolicy(deps: Db, shopId: string): Promise<PolicyContext | null> {
  const active = await deps.service.from("control_policy_active").select("revision").eq("shop_id", shopId).maybeSingle()
  if (active.error) throw new Unavailable("policy")
  if (!active.data) return null
  const [history, location] = await Promise.all([
    deps.service.from("control_policy_history").select("definition,location_id").eq("shop_id", shopId).eq("revision", active.data.revision).maybeSingle(),
    deps.service.from("shop_locations").select("id").eq("shop_id", shopId).maybeSingle(),
  ])
  if (history.error || location.error) throw new Unavailable("policy")
  const parsed = policyDraftSchema.safeParse(history.data?.definition)
  if (!parsed.success || !location.data || history.data?.location_id !== location.data.id) return null
  return { revision: active.data.revision as number, draft: parsed.data, locationId: location.data.id as string }
}

type ConnectorReady = (connector: string) => boolean

/** Database-computed sha256 over the exact stored facts connector readiness derives from. */
async function readConnectorFingerprint(deps: Db, shopId: string): Promise<string> {
  const res = await deps.service.rpc("agent_definition_connector_fingerprint", { p_shop: shopId })
  if (res.error || typeof res.data !== "string" || res.data.length === 0) throw new Unavailable("readiness")
  return res.data
}

/**
 * Readiness plus the fingerprint of the evidence it was computed from. The fingerprint is
 * read before AND after the readiness reads; if the evidence moved in between, no
 * fingerprint is returned (`null`) and activation reports `connector_stale` instead of
 * binding to a mixed snapshot. The database rechecks the fingerprint at activation.
 */
async function loadConnectorReadiness(
  deps: Db,
  shopId: string,
  env: Record<string, string | undefined>
): Promise<{ ready: ConnectorReady; fingerprint: string | null }> {
  const before = await readConnectorFingerprint(deps, shopId)
  const [channels, calendar] = await Promise.all([
    loadChannelReadiness(deps.service, shopId, env),
    deps.service.from("shops").select("aurinko_access_token_enc,aurinko_account_id").eq("id", shopId).maybeSingle(),
  ])
  if (!channels.ok || calendar.error || !calendar.data) throw new Unavailable("readiness")
  const after = await readConnectorFingerprint(deps, shopId)
  const calendarReady = Boolean(calendar.data.aurinko_access_token_enc && calendar.data.aurinko_account_id)
  const ready: ConnectorReady = (connector) => {
    switch (connector) {
      case "sms": return channels.channels.texting.state === "ready"
      case "email": return channels.channels.email.state === "ready"
      case "voice": return channels.channels.calls.state === "ready"
      case "meta": return channels.channels.meta.state === "ready"
      case "calendar": return calendarReady
      // Platform-native surfaces have no external connector to fail.
      case "crm": case "internal": case "memory": case "website": return true
      default: return false
    }
  }
  return { ready, fingerprint: before === after ? before : null }
}

function strictest(values: readonly (Mode | null | undefined)[]): Mode | null {
  let selected: Mode | null = null
  for (const value of values) {
    if (!value) continue
    if (!selected || modes.indexOf(value) < modes.indexOf(selected)) selected = value
  }
  return selected
}

/**
 * Effective Control Center decision for each requested tool. A tool is a
 * description of what Gradia MAY do, never execution authority: the executor still
 * calls the policy engine with live actor, consent, evidence and approval facts.
 */
export function decideToolGrants(input: {
  shopId: string
  actorId: string
  policy: PolicyContext | null
  grants: AgentDefinitionDraft["tools"]
  connectorReady: ConnectorReady
}): ToolDecisionDto[] {
  const { policy } = input
  return input.grants.map((grant) => {
    const definition = ACTIONS[grant.operation]
    const base = { operation: grant.operation, connector: definition.connector, requestedMaximumMode: grant.maximumMode }
    if (!policy) return { ...base, effectiveMode: "off" as Mode, available: false, reasons: ["policy_unavailable"] }
    const ready = input.connectorReady(definition.connector)
    const draft = policy.draft
    const decision = evaluatePolicy({
      command: {
        id: "00000000-0000-4000-8000-000000000001",
        shopId: input.shopId,
        locationId: policy.locationId,
        operation: grant.operation,
        connector: definition.connector,
        intent: definition.initial === "read" ? "read" : "suggest",
        source: "agent",
        payloadHash: "0".repeat(64),
        stagedPolicyVersion: null,
      },
      policy: {
        shopId: input.shopId,
        locationId: policy.locationId,
        operation: grant.operation,
        connector: definition.connector,
        version: policy.revision,
        available: true,
        enabled: draft.enabled,
        workspaceDefault: draft.workspaceDefault,
        workspaceCeiling: draft.workspaceCeiling,
        connectorCeiling: draft.connectorCeilings[definition.connector] ?? "autonomous",
        actionGrant: draft.actionGrants[grant.operation] ?? null,
        locationCeiling: draft.locationCeiling,
        roleCeiling: draft.roleCeilings.owner ?? null,
        riskCeiling: strictest(Object.values(draft.riskCeilings)),
        exceptionCeiling: strictest(Object.values(draft.exceptionCeilings)),
      },
      actor: {
        id: input.actorId,
        shopId: input.shopId,
        locationId: policy.locationId,
        active: true,
        role: "owner",
        authorizedOperations: [grant.operation],
        discountLimit: 0,
      },
      facts: {
        tenantReferencesValid: true,
        safetyPassed: true,
        ready,
        setupVerified: ready,
        // Runtime re-verifies causation and discount authority per command.
        causalActionVerified: true,
        discountAmount: grant.operation === "quote.discount" ? 0 : null,
        approval: null,
      },
    })
    const effective = modes.indexOf(decision.mode) <= modes.indexOf(grant.maximumMode) ? decision.mode : grant.maximumMode
    return {
      ...base,
      effectiveMode: decision.allowed ? effective : "off",
      available: decision.allowed && effective !== "off",
      reasons: decision.reasons,
    }
  })
}

type PinRow = { source_id: string; memory_revision: number; content_hash: string }

async function loadPins(deps: Db, shopId: string, agentId: string, revision: number): Promise<MemoryPinDto[]> {
  const pins = ok(
    await deps.service.from("agent_definition_memory_pins").select("source_id,memory_revision,content_hash")
      .eq("shop_id", shopId).eq("agent_id", agentId).eq("revision", revision).order("source_id"),
    "pins"
  ) as PinRow[]
  if (pins.length === 0) return []
  const ids = pins.map((p) => p.source_id)
  const [revisions, active, sources] = await Promise.all([
    deps.service.from("reviewed_memory_revisions").select("source_id,revision,state,content_hash,valid_from,valid_until,retention_until").eq("shop_id", shopId).in("source_id", ids),
    deps.service.from("reviewed_memory_active").select("source_id,revision").eq("shop_id", shopId).in("source_id", ids),
    deps.service.from("reviewed_memory_sources").select("id,source_name").eq("shop_id", shopId).in("id", ids),
  ])
  if (revisions.error || active.error || sources.error) throw new Unavailable("memory")
  const now = Date.now()
  return pins.map((pin) => {
    const row = (revisions.data ?? []).find((r) => r.source_id === pin.source_id && r.revision === pin.memory_revision)
    const current = (active.data ?? []).find((a) => a.source_id === pin.source_id)?.revision
    let status: MemoryPinDto["status"] = "current"
    if (!row || row.state === "revoked" || row.state === "deleted") status = "revoked"
    else if (row.state !== "published" || row.content_hash !== pin.content_hash) status = "changed"
    else if (current !== pin.memory_revision) status = "stale"
    else if (
      (row.valid_from && Date.parse(row.valid_from) > now) ||
      (row.valid_until && Date.parse(row.valid_until) <= now) ||
      (row.retention_until && Date.parse(row.retention_until) <= now)
    ) status = "expired"
    return {
      sourceId: pin.source_id,
      sourceName: (sources.data ?? []).find((s) => s.id === pin.source_id)?.source_name ?? null,
      memoryRevision: pin.memory_revision,
      contentHash: pin.content_hash,
      status,
    }
  })
}

const PIN_BLOCKER: Record<Exclude<MemoryPinDto["status"], "current">, ActivationBlocker> = {
  revoked: "memory_revoked",
  changed: "memory_changed",
  stale: "memory_stale",
  expired: "memory_expired",
}

function toEvaluationDto(row: EvaluationRow): EvaluationDto {
  return {
    id: row.id,
    suiteVersion: row.suite_version,
    fixtureSetId: row.fixture_set_id,
    fixtureHash: row.fixture_hash,
    passRate: Number(row.pass_rate),
    safetyPassed: row.safety_passed,
    estimatedCredits: row.estimated_credits,
    completedAt: row.completed_at,
    source: row.source,
  }
}

async function loadEvaluations(deps: Db, shopId: string, agentId: string, revision: number): Promise<EvaluationDto[]> {
  const rows = ok(
    await deps.service.from("agent_definition_evaluations")
      .select("id,revision,suite_version,fixture_set_id,fixture_hash,pass_rate,safety_passed,estimated_credits,completed_at,source")
      .eq("shop_id", shopId).eq("agent_id", agentId).eq("revision", revision)
      .order("completed_at", { ascending: false }).order("recorded_at", { ascending: false }),
    "evaluations"
  ) as EvaluationRow[]
  return rows.map(toEvaluationDto)
}

async function loadActivationEvidence(deps: Db, shopId: string, agentId: string, revision: number): Promise<ActivationEvidenceDto | null> {
  const rows = ok(
    await deps.service.from("agent_definition_events").select("actor_id,from_revision,evidence,created_at")
      .eq("shop_id", shopId).eq("agent_id", agentId).eq("kind", "activated").eq("revision", revision)
      .order("seq", { ascending: false }).limit(1),
    "activation"
  ) as { actor_id: string | null; from_revision: number | null; evidence: Record<string, unknown>; created_at: string }[]
  const row = rows[0]
  if (!row) return null
  const e = row.evidence ?? {}
  const str = (v: unknown) => (typeof v === "string" ? v : null)
  const num = (v: unknown) => (typeof v === "number" ? v : null)
  return {
    activatedAt: row.created_at,
    actorId: row.actor_id,
    fromRevision: row.from_revision,
    definitionHash: str(e.definition_hash),
    policyRevision: num(e.policy_revision),
    knowledgeRevision: num(e.knowledge_revision),
    evaluationId: str(e.evaluation_id),
    evaluationSuiteVersion: str(e.evaluation_suite_version),
    billingEvidenceId: str(e.billing_evidence_id),
    readyOperations: Array.isArray(e.ready_operations) ? e.ready_operations.filter((v): v is string => typeof v === "string") : [],
  }
}

export type RevisionContext = {
  shopId: string
  actorId: string
  role: ActorRole
  agent: AgentRow
  state: StateRow | null
  revision: RevisionRow
  definition: AgentDefinitionDraft | null
  pins: MemoryPinDto[]
  evaluations: EvaluationDto[]
  policy: PolicyContext | null
  knowledgeHead: number | null
  tools: ToolDecisionDto[]
  /** null = connector evidence moved while it was being read (never bound to a mixed snapshot). */
  connectorFingerprint: string | null
  activeAgentCount: number
}

async function loadAgent(deps: Db, shopId: string, agentId: string): Promise<AgentRow | null> {
  const res = await deps.service.from("custom_agents").select("id,name,enabled").eq("shop_id", shopId).eq("id", agentId).maybeSingle()
  if (res.error) throw new Unavailable("agent")
  return (res.data as AgentRow | null) ?? null
}

async function loadState(deps: Db, shopId: string, agentId: string): Promise<StateRow | null> {
  const res = await deps.service.from("agent_definition_state")
    .select("agent_id,lifecycle,active_revision,latest_revision,lifecycle_reason,version").eq("shop_id", shopId).eq("agent_id", agentId).maybeSingle()
  if (res.error) throw new Unavailable("state")
  return (res.data as StateRow | null) ?? null
}

async function loadRevisionRow(deps: Db, shopId: string, agentId: string, revision: number): Promise<RevisionRow | null> {
  const res = await deps.service.from("agent_definition_revisions")
    .select("agent_id,revision,parent_revision,schema_version,definition,definition_hash,authored_by,created_at")
    .eq("shop_id", shopId).eq("agent_id", agentId).eq("revision", revision).maybeSingle()
  if (res.error) throw new Unavailable("revision")
  return (res.data as RevisionRow | null) ?? null
}

async function countActive(deps: Db, shopId: string): Promise<number> {
  const res = await deps.service.from("custom_agents").select("id", { count: "exact", head: true }).eq("shop_id", shopId).eq("enabled", true)
  if (res.error || res.count === null) throw new Unavailable("active_count")
  return res.count
}

async function loadRevisionContext(
  deps: Db & { env?: Record<string, string | undefined> },
  input: { shopId: string; actorId: string; agentId: string; revision: number; role: ActorRole; agent: AgentRow; state: StateRow | null }
): Promise<RevisionContext | null> {
  const revision = await loadRevisionRow(deps, input.shopId, input.agentId, input.revision)
  if (!revision) return null
  const parsed = agentDefinitionDraftSchema.safeParse(revision.definition)
  const [pins, evaluations, policy, head, activeAgentCount, connectors] = await Promise.all([
    loadPins(deps, input.shopId, input.agentId, input.revision),
    loadEvaluations(deps, input.shopId, input.agentId, input.revision),
    loadPolicy(deps, input.shopId),
    deps.service.from("reviewed_memory_heads").select("revision").eq("shop_id", input.shopId).maybeSingle(),
    countActive(deps, input.shopId),
    loadConnectorReadiness(deps, input.shopId, deps.env ?? process.env),
  ])
  if (head.error) throw new Unavailable("memory_head")
  const definition = parsed.success ? parsed.data : null
  return {
    shopId: input.shopId,
    actorId: input.actorId,
    role: input.role,
    agent: input.agent,
    state: input.state,
    revision,
    definition,
    pins,
    evaluations,
    policy,
    knowledgeHead: (head.data?.revision as number | undefined) ?? null,
    tools: definition ? decideToolGrants({ shopId: input.shopId, actorId: input.actorId, policy, grants: definition.tools, connectorReady: connectors.ready }) : [],
    connectorFingerprint: connectors.fingerprint,
    activeAgentCount,
  }
}

// ---------------------------------------------------------------------------
// Eligibility (pure over loaded evidence)
// ---------------------------------------------------------------------------

const BILLING_PASSTHROUGH = new Set<string>(ACTIVATION_BLOCKERS)

/** `billing` is display evidence; the database re-checks entitlement in the activation transaction. */
export function computeEligibility(ctx: RevisionContext, billing: CommercialBillingDto | null): ActivationEligibilityDto {
  const blockers = new Set<ActivationBlocker>()
  const base = { billingState: billing?.state ?? null }
  if (ctx.role !== "owner") blockers.add("owner_activation_required")
  if (!ctx.state) blockers.add("definition_not_found")
  if (ctx.revision.schema_version !== 1) blockers.add("unsupported_schema")
  if (ctx.connectorFingerprint === null) blockers.add("connector_stale")
  if (!ctx.definition) {
    blockers.add("invalid_definition")
    return { ...base, eligible: false, alreadyActive: false, blockers: [...blockers].sort(), sources: null }
  }

  const alreadyActive = ctx.state?.lifecycle === "active" && ctx.state.active_revision === ctx.revision.revision && ctx.agent.enabled
  const latestEvaluation = ctx.evaluations[0] ?? null
  const readyOperations = ctx.tools.filter((t) => t.available).map((t) => t.operation)

  const compiled = compileAgentDefinition(
    { ...ctx.definition, lifecycle: "active" },
    {
      shopId: ctx.shopId,
      actorId: ctx.actorId,
      actorRole: ctx.role,
      policyVersion: ctx.policy?.revision ?? 0,
      knowledgeRevision: ctx.knowledgeHead ?? 1,
      reviewedKnowledgeSourceIds: ctx.pins.filter((p) => p.status === "current").map((p) => p.sourceId),
      readyOperations,
      evaluation: latestEvaluation
        ? {
            suiteVersion: latestEvaluation.suiteVersion,
            definitionRevision: ctx.revision.revision,
            passedAt: latestEvaluation.completedAt,
            passRate: latestEvaluation.passRate,
            safetyPassed: latestEvaluation.safetyPassed,
          }
        : null,
    }
  )
  if (!compiled.ready) {
    for (const reason of compiled.reasons) {
      // Replaced by the finer-grained per-tool / per-memory blockers below.
      if (reason === "tool_not_ready" || reason === "knowledge_review_required") continue
      if (isActivationBlocker(reason)) blockers.add(reason)
    }
  }
  for (const tool of ctx.tools) {
    if (tool.available) continue
    blockers.add(tool.reasons.includes("channel_not_ready") ? "tool_not_ready" : tool.reasons.includes("policy_unavailable") ? "policy_unavailable" : "tool_policy_blocked")
  }
  for (const pin of ctx.pins) if (pin.status !== "current") blockers.add(PIN_BLOCKER[pin.status])
  const pinned = new Set(ctx.pins.map((p) => p.sourceId))
  if (ctx.definition.knowledge.sourceIds.some((id) => !pinned.has(id))) blockers.add("knowledge_review_required")
  if (latestEvaluation && latestEvaluation.passRate < EVALUATION_PASS_THRESHOLD) blockers.add("quality_evaluation_failed")

  if (billing) {
    if (!ctx.agent.enabled && ctx.activeAgentCount >= ACTIVE_AGENT_LIMIT) blockers.add("active_agent_limit_reached")
    if (!billing.eligibleToActivate) {
      const reason = billing.blockingReason
      blockers.add(reason && BILLING_PASSTHROUGH.has(reason) && isActivationBlocker(reason) ? reason : "billing_state_unavailable")
    }
  }

  const sorted = [...blockers].sort()
  return {
    ...base,
    eligible: !alreadyActive && sorted.length === 0,
    alreadyActive,
    blockers: sorted,
    sources: {
      definitionHash: ctx.revision.definition_hash,
      schemaVersion: ctx.revision.schema_version,
      policyRevision: ctx.policy?.revision ?? null,
      knowledgeRevision: ctx.knowledgeHead ?? 1,
      memoryPins: ctx.pins.map((p) => ({ sourceId: p.sourceId, memoryRevision: p.memoryRevision, contentHash: p.contentHash })),
      evaluationId: latestEvaluation?.id ?? null,
      readyOperations,
      connectorFingerprint: ctx.connectorFingerprint,
      activeAgentCount: ctx.activeAgentCount,
      activeAgentLimit: ACTIVE_AGENT_LIMIT,
      expectedPointer: ctx.state?.active_revision ?? null,
    },
  }
}

type Authorized = { role: ActorRole; agent: AgentRow; state: StateRow | null }

async function authorize(
  deps: Db,
  input: { shopId: string; actorId: string; agentId: string }
): Promise<{ result: "ok"; value: Authorized } | { result: "forbidden" } | { result: "not_found" }> {
  const role = await actorRole(deps, input.shopId, input.actorId)
  if (!role) return { result: "forbidden" }
  const agent = await loadAgent(deps, input.shopId, input.agentId)
  if (!agent) return { result: "not_found" }
  const state = await loadState(deps, input.shopId, input.agentId)
  return { result: "ok", value: { role, agent, state } }
}

async function contextFor(
  deps: Db & { env?: Record<string, string | undefined> },
  input: { shopId: string; actorId: string; agentId: string; revision: number },
  auth: Authorized
): Promise<RevisionContext | null> {
  return loadRevisionContext(deps, { ...input, ...auth })
}

const unavailable = (reason: string): { status: "unavailable"; reason: string } => ({ status: "unavailable", reason })

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export type ActivateDefinitionResult =
  | { ok: true; outcome: "activated" | "already_active"; revision: number }
  | { ok: false; code: ActivationBlocker | "forbidden"; reasons: ActivationBlocker[]; billing: CommercialBillingDto | null }

export type ActivationDeps = Db & {
  env?: Record<string, string | undefined>
  /** Present in production: lets a missing entitlement hand back the server-created Checkout. */
  handoff?: { sessionClient: SupabaseClient; runtime: BillingRuntime }
}

function blocked(reasons: ActivationBlocker[], billing: CommercialBillingDto | null = null): ActivateDefinitionResult {
  return { ok: false, code: reasons[0] ?? "evidence_unavailable", reasons, billing }
}

/**
 * Activates ONE exact immutable revision. Evidence is compiled from server-loaded facts
 * only; the browser supplies the revision it is looking at, the hash it saw and the
 * pointer it saw (optimistic binding, not authority). The database re-verifies and
 * composes the merged commercial activation in the same transaction.
 */
export async function activateAgentDefinition(
  deps: ActivationDeps,
  input: { shopId: string; actorId: string; agentId: string; revision: number; expectedHash: string; expectedPointer: number | null }
): Promise<ActivateDefinitionResult> {
  try {
    const auth = await authorize(deps, input)
    if (auth.result === "forbidden") return { ok: false, code: "forbidden", reasons: ["owner_activation_required"], billing: null }
    if (auth.result === "not_found") return blocked(["agent_not_found"])
    if (auth.value.role !== "owner") return blocked(["owner_activation_required"])
    if (!auth.value.state) return blocked(["definition_not_found"])
    const ctx = await contextFor(deps, input, auth.value)
    if (!ctx) return blocked(["revision_not_found"])
    if (ctx.revision.definition_hash !== input.expectedHash) return blocked(["definition_hash_mismatch"])
    if ((ctx.state?.active_revision ?? null) !== input.expectedPointer) return blocked(["pointer_changed"])

    // Billing and the cap are decided by the database transaction, not by a display read.
    const eligibility = computeEligibility(ctx, null)
    if (!eligibility.alreadyActive && eligibility.blockers.length > 0) return blocked(eligibility.blockers)

    const { data, error } = await deps.service.rpc("agent_definition_activate", {
      p_shop: input.shopId,
      p_actor: input.actorId,
      p_agent: input.agentId,
      p_revision: input.revision,
      p_expected_hash: input.expectedHash,
      p_expected_pointer: input.expectedPointer,
      p_policy_revision: ctx.policy?.revision ?? 0,
      p_knowledge_revision: ctx.knowledgeHead ?? 1,
      p_ready_operations: eligibility.sources?.readyOperations ?? [],
      p_connector_fingerprint: ctx.connectorFingerprint,
    })
    if (error) return error.code === "42501" ? { ok: false, code: "forbidden", reasons: ["owner_activation_required"], billing: null } : blocked(["evidence_unavailable"])
    const row = (data ?? {}) as { outcome?: unknown; code?: unknown; reasons?: unknown }
    if (row.outcome === "activated" || row.outcome === "already_active") {
      return { ok: true, outcome: row.outcome, revision: input.revision }
    }
    if (row.outcome !== "blocked") return blocked(["evidence_unavailable"])

    const reasons = (Array.isArray(row.reasons) ? row.reasons : []).filter(isActivationBlocker)
    const code = typeof row.code === "string" ? row.code : null
    if (code === "billing_not_active" || code === "active_agent_limit_reached" || code === "catalog_mismatch") {
      if (code === "billing_not_active" && deps.handoff) {
        const decision = await resolveBlockedActivation(
          { sessionClient: deps.handoff.sessionClient, service: deps.service, runtime: deps.handoff.runtime },
          { shopId: input.shopId, actorId: input.actorId },
          code
        )
        const mapped: ActivationBlocker = isActivationBlocker(decision.code) ? decision.code : "billing_state_unavailable"
        return { ok: false, code: mapped, reasons: [mapped], billing: decision.billing }
      }
      return blocked([code])
    }
    return blocked(reasons.length > 0 ? reasons : isActivationBlocker(code) ? [code] : ["evidence_unavailable"])
  } catch {
    return blocked(["evidence_unavailable"])
  }
}

// ---------------------------------------------------------------------------
// DTO readers
// ---------------------------------------------------------------------------

function presentLifecycle(state: StateRow | null): DefinitionLifecycle | "legacy_unversioned" {
  return state ? state.lifecycle : "legacy_unversioned"
}

/** `/agents`: every agent, truthful about legacy and unavailable states. */
export async function readAgentsHomeDto(
  deps: Db,
  input: { shopId: string; actorId: string }
): Promise<DtoResult<AgentsHomeDto>> {
  try {
    const role = await actorRole(deps, input.shopId, input.actorId)
    if (!role) return { status: "forbidden" }
    const agents = ok(
      await deps.service.from("custom_agents").select("id,name,enabled").eq("shop_id", input.shopId).order("created_at", { ascending: true }),
      "agents"
    ) as AgentRow[]
    const states = ok(
      await deps.service.from("agent_definition_state").select("agent_id,lifecycle,active_revision,latest_revision,lifecycle_reason,version").eq("shop_id", input.shopId),
      "states"
    ) as StateRow[]
    const refs = ok(
      await deps.service.from("agent_definition_revisions").select("agent_id,revision,parent_revision,definition_hash,created_at").eq("shop_id", input.shopId).order("revision", { ascending: false }),
      "revisions"
    ) as Pick<RevisionRow, "agent_id" | "revision" | "parent_revision" | "definition_hash" | "created_at">[]

    // Exact per-agent value from the database (newest confirmed run), never a recent-window guess.
    // A failed read makes the whole home unavailable instead of reporting "no confirmed run".
    const lastRun = new Map<string, { runId: string; finishedAt: string }>()
    await Promise.all(
      agents.map(async (agent) => {
        const res = await deps.service
          .from("custom_agent_runs")
          .select("id,finished_at")
          .eq("shop_id", input.shopId)
          .eq("agent_id", agent.id)
          .eq("state", "succeeded")
          .eq("fired", true)
          .not("finished_at", "is", null)
          .order("finished_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(1)
        if (res.error) throw new Unavailable("runs")
        const row = res.data?.[0]
        if (row?.finished_at) lastRun.set(agent.id, { runId: row.id as string, finishedAt: row.finished_at as string })
      })
    )
    const review = await countNeedsReview(deps, input.shopId)

    const items: AgentSummaryDto[] = agents.map((agent) => {
      const state = states.find((s) => s.agent_id === agent.id) ?? null
      const own = refs.filter((r) => r.agent_id === agent.id)
      const active = state?.active_revision != null ? own.find((r) => r.revision === state.active_revision) ?? null : null
      const latest = own[0] ?? null
      return {
        agentId: agent.id,
        name: agent.name,
        governance: state ? "governed" : "legacy_unversioned",
        lifecycle: presentLifecycle(state),
        enabled: agent.enabled,
        activeRevision: active ? toRef(active) : null,
        latestRevision: latest ? toRef(latest) : null,
        hasUnactivatedDraft: Boolean(latest && (!active || latest.revision > active.revision)),
        lastConfirmedRun: lastRun.get(agent.id) ?? null,
        needsReviewCount: review === null ? null : review.get(agent.id) ?? 0,
      }
    })
    return {
      status: "ok",
      data: {
        role,
        canManage: role === "owner",
        activeAgentCount: agents.filter((a) => a.enabled).length,
        activeAgentLimit: ACTIVE_AGENT_LIMIT,
        agents: items,
      },
    }
  } catch (e) {
    return unavailable(e instanceof Unavailable ? e.message : "unavailable")
  }
}

const PAGE = 500
/** Hard ceiling on pages; beyond it completeness cannot be proven, so the count is unavailable (null). */
const MAX_PAGES = 200

/**
 * Pending approvals per agent, complete or null. Pages through EVERY run that produced
 * approvals (stable keyset on id), then checks which of those approvals are still pending.
 * Anything short of a full scan returns null, never a definitive zero.
 */
async function countNeedsReview(deps: Db, shopId: string): Promise<Map<string, number> | null> {
  const byAction = new Map<string, string>()
  let cursor: string | null = null
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) return null
    let query = deps.service
      .from("custom_agent_runs")
      .select("id,agent_id,pending_action_ids")
      .eq("shop_id", shopId)
      .not("pending_action_ids", "eq", "{}")
      .order("id", { ascending: true })
      .limit(PAGE)
    if (cursor) query = query.gt("id", cursor)
    const runs = await query
    if (runs.error) return null
    const rows = runs.data ?? []
    for (const r of rows) for (const id of (r.pending_action_ids as string[] | null) ?? []) byAction.set(id, r.agent_id)
    if (rows.length < PAGE) break
    cursor = rows[rows.length - 1].id as string
  }
  const counts = new Map<string, number>()
  const ids = [...byAction.keys()]
  for (let i = 0; i < ids.length; i += 200) {
    const pending = await deps.service.from("pending_actions").select("id").eq("shop_id", shopId).eq("status", "pending").in("id", ids.slice(i, i + 200))
    if (pending.error) return null
    for (const p of pending.data ?? []) {
      const agent = byAction.get(p.id)
      if (agent) counts.set(agent, (counts.get(agent) ?? 0) + 1)
    }
  }
  return counts
}

function computeSteps(ctx: RevisionContext | null, eligibility: ActivationEligibilityDto | null): BuilderSteps {
  if (!ctx || !ctx.definition || !eligibility) {
    return { job: "incomplete", knowledge: "incomplete", tools: "incomplete", limits: "incomplete", schedule: "incomplete", test: "incomplete", activate: "incomplete" }
  }
  const latest = ctx.evaluations[0] ?? null
  const limitsOk = !eligibility.blockers.includes("limits_invalid")
  return {
    job: "complete",
    knowledge: ctx.pins.every((p) => p.status === "current") ? "complete" : "attention",
    tools: ctx.tools.every((t) => t.available) ? "complete" : "attention",
    limits: limitsOk ? "complete" : "attention",
    schedule: "complete",
    test: !latest ? "incomplete" : latest.safetyPassed && latest.passRate >= EVALUATION_PASS_THRESHOLD ? "complete" : "attention",
    activate: eligibility.alreadyActive ? "complete" : eligibility.eligible ? "incomplete" : "blocked",
  }
}

export type ReadDeps = Db & {
  env?: Record<string, string | undefined>
  billing?: (shopId: string) => Promise<CommercialBillingDto>
}

async function billingFor(deps: ReadDeps, shopId: string): Promise<CommercialBillingDto | null> {
  if (!deps.billing) return null
  try { return await deps.billing(shopId) } catch { return null }
}

/** Builder resume: the exact latest immutable revision and each step's completion state. */
export async function readBuilderResumeDto(
  deps: ReadDeps,
  input: { shopId: string; actorId: string; agentId: string }
): Promise<DtoResult<BuilderResumeDto>> {
  try {
    const auth = await authorize(deps, input)
    if (auth.result === "forbidden") return { status: "forbidden" }
    if (auth.result === "not_found") return unavailable("agent_not_found")
    const { role, agent, state } = auth.value
    const governance = state ? "governed" : "legacy_unversioned"
    const editBlockedReason: BuilderResumeDto["editBlockedReason"] =
      role !== "owner" ? "owner_required" : !state && agent.enabled ? "legacy_agent_enabled" : null

    let ctx: RevisionContext | null = null
    let eligibility: ActivationEligibilityDto | null = null
    if (state && state.latest_revision > 0) {
      ctx = await contextFor(deps, { ...input, revision: state.latest_revision }, auth.value)
      if (!ctx) return unavailable("revision_missing")
      eligibility = computeEligibility(ctx, await billingFor(deps, input.shopId))
    }
    const refs = state?.active_revision != null ? await loadRevisionRow(deps, input.shopId, input.agentId, state.active_revision) : null
    return {
      status: "ok",
      data: {
        agentId: agent.id,
        name: agent.name,
        governance,
        lifecycle: presentLifecycle(state),
        role,
        canEdit: editBlockedReason === null,
        editBlockedReason,
        latestRevision: ctx && ctx.definition ? { ...toRef(ctx.revision), definition: ctx.definition, memoryPins: ctx.pins } : null,
        activeRevision: refs ? toRef(refs) : null,
        steps: computeSteps(ctx, eligibility),
        eligibility,
      },
    }
  } catch (e) {
    return unavailable(e instanceof Unavailable ? e.message : "unavailable")
  }
}

/** Immutable revision page: definition, memory, tool/policy reasons, evaluation and activation evidence. */
export async function readRevisionDto(
  deps: ReadDeps,
  input: { shopId: string; actorId: string; agentId: string; revision: number }
): Promise<DtoResult<RevisionDto>> {
  try {
    const auth = await authorize(deps, input)
    if (auth.result === "forbidden") return { status: "forbidden" }
    if (auth.result === "not_found") return unavailable("agent_not_found")
    const ctx = await contextFor(deps, input, auth.value)
    if (!ctx) return unavailable("revision_not_found")
    if (!ctx.definition) return unavailable("definition_unreadable")
    const [activation, billing] = await Promise.all([
      loadActivationEvidence(deps, input.shopId, input.agentId, input.revision),
      billingFor(deps, input.shopId),
    ])
    const eligibility = computeEligibility(ctx, billing)
    return {
      status: "ok",
      data: {
        ...toRef(ctx.revision),
        agentId: input.agentId,
        schemaVersion: ctx.revision.schema_version,
        authoredBy: ctx.revision.authored_by,
        definition: ctx.definition,
        isActive: ctx.state?.active_revision === input.revision && ctx.state.lifecycle === "active",
        lifecycle: presentLifecycle(ctx.state),
        memoryPins: ctx.pins,
        tools: ctx.tools,
        limits: ctx.definition.limits,
        schedule: ctx.definition.schedule,
        evaluations: ctx.evaluations,
        activation,
        eligibility,
      },
    }
  } catch (e) {
    return unavailable(e instanceof Unavailable ? e.message : "unavailable")
  }
}

/** Activation eligibility for one exact revision: finite blockers + exact source versions. */
export async function readActivationEligibility(
  deps: ReadDeps,
  input: { shopId: string; actorId: string; agentId: string; revision: number }
): Promise<DtoResult<ActivationEligibilityDto>> {
  try {
    const auth = await authorize(deps, input)
    if (auth.result === "forbidden") return { status: "forbidden" }
    if (auth.result === "not_found") return unavailable("agent_not_found")
    const ctx = await contextFor(deps, input, auth.value)
    if (!ctx) return unavailable("revision_not_found")
    return { status: "ok", data: computeEligibility(ctx, await billingFor(deps, input.shopId)) }
  } catch (e) {
    return unavailable(e instanceof Unavailable ? e.message : "unavailable")
  }
}

/** `/agents/[agentId]`: overview with the exact active revision and the revision list. */
export async function readAgentDetailDto(
  deps: ReadDeps,
  input: { shopId: string; actorId: string; agentId: string }
): Promise<DtoResult<AgentDetailDto>> {
  try {
    const auth = await authorize(deps, input)
    if (auth.result === "forbidden") return { status: "forbidden" }
    if (auth.result === "not_found") return unavailable("agent_not_found")
    const { role, agent, state } = auth.value
    const refs = ok(
      await deps.service.from("agent_definition_revisions").select("revision,parent_revision,definition_hash,created_at")
        .eq("shop_id", input.shopId).eq("agent_id", input.agentId).order("revision", { ascending: false }),
      "revisions"
    ) as Pick<RevisionRow, "revision" | "parent_revision" | "definition_hash" | "created_at">[]
    let active: RevisionDto | null = null
    if (state?.active_revision != null) {
      const dto = await readRevisionDto(deps, { ...input, revision: state.active_revision })
      if (dto.status !== "ok") return dto.status === "forbidden" ? dto : unavailable("active_revision_unreadable")
      active = dto.data
    }
    return {
      status: "ok",
      data: {
        agentId: agent.id,
        name: agent.name,
        governance: state ? "governed" : "legacy_unversioned",
        lifecycle: presentLifecycle(state),
        enabled: agent.enabled,
        role,
        canManage: role === "owner",
        lifecycleReason: state?.lifecycle_reason ?? null,
        activeRevision: active,
        revisions: refs.map(toRef),
      },
    }
  } catch (e) {
    return unavailable(e instanceof Unavailable ? e.message : "unavailable")
  }
}

export type { Operation }
