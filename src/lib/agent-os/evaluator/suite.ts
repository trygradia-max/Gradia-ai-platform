/**
 * Trusted governance-contract evaluation of ONE immutable Agent definition revision.
 *
 * What this is: a deterministic, offline, no-model, no-provider suite. It runs the exact stored
 * definition through the real policy engine (`decideToolGrants` -> `evaluatePolicy`) under a fixed
 * matrix of synthetic policies and connector states, and checks structural safety rules that the
 * definition itself can break. Same definition + same pins + same suite version => same result.
 *
 * What this is NOT: a measurement of model or prompt quality. No model is called, so `passRate`
 * is the fraction of governance-contract fixtures that held, not an answer-quality score. Model
 * quality evaluation is a separate, later suite that must ship under its own suite version.
 *
 * Pure: no database, network, clock or randomness. The orchestrator (`run.ts`) supplies the stored
 * definition and pins and is the only thing that records evidence.
 */
import { createHash } from "node:crypto"

import { initialPolicyDraft } from "@/lib/control-center/drafts"
import { ACTIONS, modes, type Mode, type Operation } from "@/lib/control-center/policy"
import { agentDefinitionDraftSchema, type AgentDefinitionDraft } from "@/lib/agent-os/definition-schema"
import { decideToolGrants } from "@/lib/agent-os/definition-store"

export const EVALUATION_SUITE_VERSION = "governance-contract-2026-11-11"
export const EVALUATION_FIXTURE_SET_ID = "governance-contract-fixtures-v1"

const SHOP = "00000000-0000-4000-8000-0000000000a1"
const ACTOR = "00000000-0000-4000-8000-0000000000a2"
const LOCATION = "00000000-0000-4000-8000-0000000000a3"
const rank = (m: Mode) => modes.indexOf(m)

type Policy = Parameters<typeof decideToolGrants>[0]["policy"]
const policyOf = (revision: number, draft: ReturnType<typeof initialPolicyDraft>): NonNullable<Policy> => ({ revision, draft, locationId: LOCATION })

/** Every tool the definition asks for, granted autonomy by an explicit owner grant: the loosest legal policy. */
const permissive = (def: AgentDefinitionDraft) =>
  policyOf(1, { ...initialPolicyDraft(), actionGrants: Object.fromEntries(def.tools.map(t => [t.operation, "autonomous" as const])) })
const approvalOnly = (def: AgentDefinitionDraft) =>
  policyOf(2, { ...initialPolicyDraft(), workspaceCeiling: "approval", actionGrants: Object.fromEntries(def.tools.map(t => [t.operation, "autonomous" as const])) })
const disabled = () => policyOf(3, { ...initialPolicyDraft(), enabled: false })

const decide = (def: AgentDefinitionDraft, policy: Policy, ready: boolean) =>
  decideToolGrants({ shopId: SHOP, actorId: ACTOR, policy, grants: def.tools, connectorReady: () => ready })

const OUTBOUND_CUSTOMER_MESSAGING = new Set<Operation>([
  "sms.reply", "sms.qualify", "sms.nurture", "sms.confirm", "sms.remind", "sms.followup",
  "email.reply", "email.qualify", "email.nurture", "email.confirm", "email.remind", "email.followup",
])
const STOP_WORDING = /\b(stop|opt[- ]?out|unsubscribe|do not contact|don'?t contact|no further contact|dnc)\b/i
const FORBIDDEN_KEY = /(api[_-]?key|secret|password|token|credential|system[_-]?prompt|provider|bearer)/i

export type FixtureInput = { definition: AgentDefinitionDraft; pinnedSourceIds: string[] }
export type FixtureResult = { pass: boolean; detail?: string }
export type Fixture = {
  id: string
  /** A failed safety fixture sets `safetyPassed = false`, which activation never accepts. */
  safety: boolean
  description: string
  run: (input: FixtureInput) => FixtureResult
}

const ok = (): FixtureResult => ({ pass: true })
const fail = (detail: string): FixtureResult => ({ pass: false, detail })

function keysOf(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach(v => keysOf(v, out))
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { out.push(k); keysOf(v, out) }
  return out
}

export const FIXTURES: readonly Fixture[] = [
  {
    id: "schema-strict",
    safety: true,
    description: "The stored document parses under the strict definition schema (no unknown or unsafe field).",
    run: ({ definition }) => (agentDefinitionDraftSchema.safeParse(definition).success ? ok() : fail("definition does not parse")),
  },
  {
    id: "no-secret-or-provider-keys",
    safety: true,
    description: "No key anywhere in the definition names a credential, secret, provider or system prompt.",
    run: ({ definition }) => {
      const bad = keysOf(definition).find(k => FORBIDDEN_KEY.test(k))
      return bad ? fail(`forbidden key ${bad}`) : ok()
    },
  },
  {
    id: "post-mvp-tools-absent",
    safety: true,
    description: "The definition requests no post-MVP tool (outbound voice, campaign send).",
    run: ({ definition }) => {
      const bad = definition.tools.find(t => t.operation === "voice.outbound" || t.operation === "campaign.send")
      return bad ? fail(`${bad.operation} is not available`) : ok()
    },
  },
  {
    id: "no-tool-exceeds-request",
    safety: true,
    description: "Under the loosest legal policy no tool's effective mode exceeds the maximum the definition asked for.",
    run: ({ definition }) => {
      for (const d of decide(definition, permissive(definition), true)) {
        if (rank(d.effectiveMode) > rank(d.requestedMaximumMode)) return fail(`${d.operation} ${d.effectiveMode} > ${d.requestedMaximumMode}`)
      }
      return ok()
    },
  },
  {
    id: "money-and-calendar-never-autonomous",
    safety: true,
    description: "Hard-approval operations (quotes, bookings, discounts, memory publication, merges) are never autonomous, even with an explicit autonomy grant.",
    run: ({ definition }) => {
      for (const d of decide(definition, permissive(definition), true)) {
        if (ACTIONS[d.operation].hardApproval && d.effectiveMode === "autonomous") return fail(`${d.operation} autonomous`)
      }
      return ok()
    },
  },
  {
    id: "read-and-draft-tools-never-write",
    safety: true,
    description: "Read and private-draft operations never rise above read/suggest under any policy.",
    run: ({ definition }) => {
      for (const d of decide(definition, permissive(definition), true)) {
        const initial = ACTIONS[d.operation].initial
        if ((initial === "read" || initial === "suggest") && rank(d.effectiveMode) > rank(initial)) return fail(`${d.operation} above ${initial}`)
      }
      return ok()
    },
  },
  {
    id: "approval-ceiling-holds",
    safety: true,
    description: "A workspace approval ceiling holds every tool at approval or below.",
    run: ({ definition }) => {
      for (const d of decide(definition, approvalOnly(definition), true)) {
        if (rank(d.effectiveMode) > rank("approval")) return fail(`${d.operation} ${d.effectiveMode} above the approval ceiling`)
      }
      return ok()
    },
  },
  {
    id: "unready-connector-denies",
    safety: true,
    description: "Every tool is unavailable while its connector is not ready, even under the loosest policy.",
    run: ({ definition }) => {
      const bad = decide(definition, permissive(definition), false).find(d => d.available)
      return bad ? fail(`${bad.operation} available without a ready connector`) : ok()
    },
  },
  {
    id: "no-policy-denies",
    safety: true,
    description: "With no active Control Center policy every tool is unavailable and off.",
    run: ({ definition }) => {
      const bad = decide(definition, null, true).find(d => d.available || d.effectiveMode !== "off")
      return bad ? fail(`${bad.operation} usable without a policy`) : ok()
    },
  },
  {
    id: "disabled-policy-denies",
    safety: true,
    description: "A disabled workspace policy turns every tool off.",
    run: ({ definition }) => {
      const bad = decide(definition, disabled(), true).find(d => d.available || d.effectiveMode !== "off")
      return bad ? fail(`${bad.operation} usable under a disabled policy`) : ok()
    },
  },
  {
    id: "outbound-messaging-has-stop-condition",
    safety: true,
    description: "A definition that can message customers names an opt-out/stop rule among its stop conditions.",
    run: ({ definition }) => {
      if (!definition.tools.some(t => OUTBOUND_CUSTOMER_MESSAGING.has(t.operation))) return ok()
      return definition.job.stopConditions.some(c => STOP_WORDING.test(c)) ? ok() : fail("customer messaging without an opt-out stop condition")
    },
  },
  {
    id: "memory-pins-match-sources",
    safety: true,
    description: "The reviewed-memory pins saved with the revision are exactly the sources the definition selects.",
    run: ({ definition, pinnedSourceIds }) => {
      const want = [...new Set(definition.knowledge.sourceIds)].sort()
      const have = [...new Set(pinnedSourceIds)].sort()
      return want.length === have.length && want.every((id, i) => id === have[i]) ? ok() : fail("pins differ from selected sources")
    },
  },
  {
    id: "limits-bounded",
    safety: true,
    description: "Run limits are inside the platform bounds and one run at a time.",
    run: ({ definition: { limits: l } }) =>
      l.maximumStepsPerRun >= 1 && l.maximumStepsPerRun <= 30 && l.maximumRuntimeSeconds >= 5 && l.maximumRuntimeSeconds <= 900 &&
      l.maximumCreditsPerRun >= 0 && l.maximumRunsPerDay >= 1 && l.maximumRunsPerDay <= 1_440 && l.maximumConcurrentRuns === 1
        ? ok()
        : fail("limits outside platform bounds"),
  },
  {
    id: "job-is-checkable",
    safety: false,
    description: "The job states at least one checkable outcome and one stop condition.",
    run: ({ definition: { job } }) =>
      job.expectedOutcomes.some(o => o.trim().length >= 3) && job.stopConditions.some(c => c.trim().length >= 3) ? ok() : fail("job has no checkable outcome or stop condition"),
  },
  {
    id: "interval-schedule-is-affordable",
    safety: false,
    description: "A scheduled agent's daily run allowance does not exceed what its interval can ever use.",
    run: ({ definition: { schedule, limits } }) => {
      if (schedule.kind !== "interval") return ok()
      const maxPerDay = Math.floor(1_440 / schedule.everyMinutes) || 1
      return limits.maximumRunsPerDay <= Math.max(maxPerDay, 1) ? ok() : fail(`allows ${limits.maximumRunsPerDay} runs/day but the interval gives at most ${maxPerDay}`)
    },
  },
]

/** Identity of the fixture set (ids, safety flag, description, suite version). Stored with the evidence. */
export const FIXTURE_SET_HASH = createHash("sha256")
  .update(JSON.stringify({ suite: EVALUATION_SUITE_VERSION, set: EVALUATION_FIXTURE_SET_ID, fixtures: FIXTURES.map(f => [f.id, f.safety, f.description]) }))
  .digest("hex")

export type EvaluationOutcome = {
  suiteVersion: string
  fixtureSetId: string
  fixtureHash: string
  total: number
  passed: number
  /** passed / total, 4 decimal places. Governance-contract fixtures only; not a model-quality score. */
  passRate: number
  safetyPassed: boolean
  failed: { id: string; safety: boolean; detail: string }[]
  estimatedCredits: number
  costEvidence: Record<string, unknown>
}

export function evaluateDefinition(input: FixtureInput, fixtures: readonly Fixture[] = FIXTURES): EvaluationOutcome {
  const failed: EvaluationOutcome["failed"] = []
  let passed = 0
  for (const fixture of fixtures) {
    let result: FixtureResult
    try {
      result = fixture.run(input)
    } catch {
      // A fixture that cannot run is a failure, never a pass.
      result = fail("fixture could not run")
    }
    if (result.pass) passed += 1
    else failed.push({ id: fixture.id, safety: fixture.safety, detail: result.detail ?? "failed" })
  }
  const total = fixtures.length
  const limits = input.definition.limits
  return {
    suiteVersion: EVALUATION_SUITE_VERSION,
    fixtureSetId: EVALUATION_FIXTURE_SET_ID,
    fixtureHash: FIXTURE_SET_HASH,
    total,
    passed,
    passRate: total === 0 ? 0 : Math.round((passed / total) * 10_000) / 10_000,
    safetyPassed: !failed.some(f => f.safety) && total > 0,
    failed,
    estimatedCredits: limits.maximumCreditsPerRun,
    costEvidence: {
      basis: "definition_limit",
      maximumCreditsPerRun: limits.maximumCreditsPerRun,
      maximumRunsPerDay: limits.maximumRunsPerDay,
      modelCalls: 0,
    },
  }
}
