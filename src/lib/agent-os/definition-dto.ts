import type { Mode, Operation } from "@/lib/control-center/policy"
import type { AgentDefinitionDraft } from "@/lib/agent-os/definition"

/**
 * Serializable DTOs for Cursor's seven-step builder and the /agents pages.
 * Every read is an envelope: a failed or forbidden read is NEVER an empty list and
 * NEVER eligible. Nothing here carries a provider name, secret, raw prompt, raw
 * tool schema, memory body or Stripe URL.
 */

export type DtoResult<T> =
  | { status: "ok"; data: T }
  | { status: "forbidden" }
  | { status: "unavailable"; reason: string }

export type DefinitionLifecycle = "draft" | "active" | "paused" | "blocked"
export type AgentGovernance = "governed" | "legacy_unversioned"
export type ActorRole = "owner" | "manager" | "staff"

/** Finite activation / eligibility blockers. Cursor keys copy off these codes. */
export const ACTIVATION_BLOCKERS = [
  // authority + identity
  "owner_activation_required", "agent_not_found", "definition_not_found", "revision_not_found",
  "invalid_definition", "invalid_scope", "unsupported_schema",
  // exact-revision binding
  "definition_hash_mismatch", "pointer_changed",
  // policy
  "policy_unavailable", "policy_stale",
  // memory
  "knowledge_unavailable", "knowledge_stale", "knowledge_review_required",
  "memory_revoked", "memory_changed", "memory_stale", "memory_expired",
  // tools + limits
  "tool_not_ready", "tool_policy_blocked", "post_mvp_tool_disabled", "limits_invalid",
  // evaluation
  "evaluation_required", "safety_evaluation_failed", "quality_evaluation_failed", "invalid_evaluation_time",
  // entitlement + billing (from the merged commercial boundary)
  "active_agent_limit_reached", "catalog_mismatch", "billing_not_active", "billing_state_unavailable",
  "checkout_required", "checkout_in_progress", "checkout_completed_awaiting_evidence",
  "subscription_past_due", "subscription_canceled", "subscription_incomplete", "subscription_unknown",
  "reconciliation_required", "billing_unconfigured", "billing_misconfigured", "owner_required",
  // loaders
  "evidence_unavailable", "evidence_blocked",
] as const
export type ActivationBlocker = (typeof ACTIVATION_BLOCKERS)[number]
const blockerSet: ReadonlySet<string> = new Set(ACTIVATION_BLOCKERS)
export const isActivationBlocker = (value: unknown): value is ActivationBlocker =>
  typeof value === "string" && blockerSet.has(value)

export type RevisionRef = {
  revision: number
  definitionHash: string
  createdAt: string
  parentRevision: number | null
}

export type StepStatus = "complete" | "incomplete" | "attention" | "blocked"
export type BuilderStepKey = "job" | "knowledge" | "tools" | "limits" | "schedule" | "test" | "activate"
export type BuilderSteps = Record<BuilderStepKey, StepStatus>

export type MemoryPinDto = {
  sourceId: string
  sourceName: string | null
  memoryRevision: number
  contentHash: string
  /** Live state of the pinned revision. Anything but `current` blocks activation. */
  status: "current" | "revoked" | "changed" | "stale" | "expired"
}

export type ToolDecisionDto = {
  operation: Operation
  connector: string
  requestedMaximumMode: Mode
  /** Effective Control Center mode, capped by the requested maximum. */
  effectiveMode: Mode
  available: boolean
  /** Finite machine reasons from the existing policy contract. */
  reasons: string[]
}

export type EvaluationDto = {
  id: string
  suiteVersion: string
  fixtureSetId: string
  fixtureHash: string
  passRate: number
  safetyPassed: boolean
  estimatedCredits: number
  completedAt: string
  source: "trusted_evaluator"
}

export type ActivationEvidenceDto = {
  activatedAt: string
  actorId: string | null
  fromRevision: number | null
  definitionHash: string | null
  policyRevision: number | null
  knowledgeRevision: number | null
  evaluationId: string | null
  evaluationSuiteVersion: string | null
  billingEvidenceId: string | null
  readyOperations: string[]
}

export type EligibilitySources = {
  definitionHash: string
  schemaVersion: number
  policyRevision: number | null
  knowledgeRevision: number | null
  memoryPins: { sourceId: string; memoryRevision: number; contentHash: string }[]
  evaluationId: string | null
  readyOperations: string[]
  activeAgentCount: number
  activeAgentLimit: number
  expectedPointer: number | null
}

export type ActivationEligibilityDto = {
  eligible: boolean
  /** This exact revision is already the active pointer (idempotent; nothing to do). */
  alreadyActive: boolean
  blockers: ActivationBlocker[]
  sources: EligibilitySources | null
  /** Billing display state only; never a URL. */
  billingState: string | null
}

export type AgentSummaryDto = {
  agentId: string
  name: string
  governance: AgentGovernance
  /** `legacy_unversioned` agents never report a definition lifecycle. */
  lifecycle: DefinitionLifecycle | "legacy_unversioned"
  enabled: boolean
  activeRevision: RevisionRef | null
  latestRevision: RevisionRef | null
  /** A newer immutable revision exists than the one that is active. */
  hasUnactivatedDraft: boolean
  lastConfirmedRun: { runId: string; finishedAt: string } | null
  /** null = could not be determined; never silently 0. */
  needsReviewCount: number | null
}

export type AgentsHomeDto = {
  role: ActorRole
  canManage: boolean
  activeAgentCount: number
  activeAgentLimit: number
  agents: AgentSummaryDto[]
}

export type BuilderResumeDto = {
  agentId: string
  name: string
  governance: AgentGovernance
  lifecycle: DefinitionLifecycle | "legacy_unversioned"
  role: ActorRole
  canEdit: boolean
  /** Why a new revision cannot be saved, when it cannot. */
  editBlockedReason: "owner_required" | "legacy_agent_enabled" | null
  latestRevision: (RevisionRef & { definition: AgentDefinitionDraft; memoryPins: MemoryPinDto[] }) | null
  activeRevision: RevisionRef | null
  steps: BuilderSteps
  eligibility: ActivationEligibilityDto | null
}

export type RevisionDto = RevisionRef & {
  agentId: string
  schemaVersion: number
  authoredBy: string
  definition: AgentDefinitionDraft
  isActive: boolean
  lifecycle: DefinitionLifecycle | "legacy_unversioned"
  memoryPins: MemoryPinDto[]
  tools: ToolDecisionDto[]
  limits: AgentDefinitionDraft["limits"]
  schedule: AgentDefinitionDraft["schedule"]
  evaluations: EvaluationDto[]
  activation: ActivationEvidenceDto | null
  eligibility: ActivationEligibilityDto
}

export type AgentDetailDto = {
  agentId: string
  name: string
  governance: AgentGovernance
  lifecycle: DefinitionLifecycle | "legacy_unversioned"
  enabled: boolean
  role: ActorRole
  canManage: boolean
  lifecycleReason: string | null
  activeRevision: RevisionDto | null
  revisions: RevisionRef[]
}
