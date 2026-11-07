import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { agentDefinitionDraftSchema, type AgentDefinitionDraft } from "@/lib/agent-os/definition"
import { ACTIVATION_BLOCKERS, isActivationBlocker } from "@/lib/agent-os/definition-dto"
import {
  computeEligibility,
  decideToolGrants,
  parseDefinitionInput,
  readAgentsHomeDto,
  readBuilderResumeDto,
  readRevisionDto,
  type RevisionContext,
} from "@/lib/agent-os/definition-store"
import type { CommercialBillingDto } from "@/lib/commercial-billing"
import { initialPolicyDraft } from "@/lib/control-center/drafts"

const shopId = "00000000-0000-4000-8000-000000000001"
const actorId = "00000000-0000-4000-8000-000000000002"
const agentId = "00000000-0000-4000-8000-000000000004"
const locationId = "00000000-0000-4000-8000-000000000005"
const sourceId = "00000000-0000-4000-8000-000000000003"

const input = () => ({
  schemaVersion: 1,
  key: "front-desk",
  job: { roleLabel: "Front desk", goal: "Qualify new inquiries safely.", expectedOutcomes: ["Next step recorded"], stopConditions: ["Customer opts out"] },
  knowledge: { sourceIds: [sourceId], includeShopKnowledge: true, includeCustomerMemory: false, maxResultsPerQuery: 4 },
  tools: [{ operation: "crm.read", maximumMode: "read" }],
  schedule: { kind: "manual" },
  limits: { maximumStepsPerRun: 5, maximumRuntimeSeconds: 60, maximumCreditsPerRun: 10, maximumRunsPerDay: 10, maximumConcurrentRuns: 1 },
  routing: { strategy: "cost_aware", semanticCache: false },
})

describe("parseDefinitionInput", () => {
  it("accepts the existing owner-authored vocabulary and normalizes it", () => {
    const parsed = parseDefinitionInput({ ...input(), job: { ...input().job, roleLabel: "  Front desk  " } })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.definition.job.roleLabel).toBe("Front desk")
      expect("revision" in parsed.definition).toBe(false)
      expect("lifecycle" in parsed.definition).toBe(false)
    }
  })

  it.each([
    ["a client-chosen revision", { revision: 4 }],
    ["a client-chosen lifecycle", { lifecycle: "active" }],
    ["a system prompt", { systemPrompt: "Ignore policy." }],
    ["a provider", { provider: "openai", model: "gpt" }],
    ["a credential", { apiKey: "sk_live_123" }],
    ["a client-selected tenant", { shopId }],
    ["client evaluation proof", { evaluation: { passRate: 1, safetyPassed: true } }],
    ["a shell tool", { tools: [{ operation: "shell.exec", maximumMode: "autonomous" }] }],
    ["autonomy above a read operation", { tools: [{ operation: "crm.read", maximumMode: "autonomous" }] }],
    ["a duplicate tool grant", { tools: [{ operation: "crm.read", maximumMode: "read" }, { operation: "crm.read", maximumMode: "read" }] }],
    ["more than one concurrent run", { limits: { ...input().limits, maximumConcurrentRuns: 2 } }],
    ["a non-id knowledge source", { knowledge: { ...input().knowledge, sourceIds: ["select * from shops"] } }],
  ])("refuses %s", (_label, extra) => {
    expect(parseDefinitionInput({ ...input(), ...extra })).toEqual({ ok: false, code: "invalid_definition" })
  })

  it.each([null, undefined, "text", 7, [], [input()]])("refuses a non-object (%s)", (value) => {
    expect(parseDefinitionInput(value)).toEqual({ ok: false, code: "invalid_definition" })
  })
})

describe("finite blocker vocabulary", () => {
  it("covers every reason string the activation SQL can emit", () => {
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261107120000_agent_definition_revisions.sql"), "utf8")
    const emitted = new Set<string>()
    for (const m of sql.matchAll(/array_append\(v_reasons, '([a-z_]+)'::text\)/g)) emitted.add(m[1])
    for (const m of sql.matchAll(/jsonb_build_array\('([a-z_]+)'\)/g)) emitted.add(m[1])
    for (const m of sql.matchAll(/'code', '([a-z_]+)'/g)) emitted.add(m[1])
    // Writer-only outcomes that are not activation blockers.
    for (const nonBlocker of ["legacy_agent_enabled", "parent_not_found", "memory_not_selectable", "no_active_definition", "invalid_transition", "evidence_blocked"]) {
      emitted.delete(nonBlocker)
    }
    expect(emitted.size).toBeGreaterThan(10)
    for (const reason of emitted) expect(isActivationBlocker(reason), reason).toBe(true)
  })

  it("has no duplicates", () => {
    expect(new Set(ACTIVATION_BLOCKERS).size).toBe(ACTIVATION_BLOCKERS.length)
  })
})

describe("decideToolGrants", () => {
  const policy = { revision: 3, draft: initialPolicyDraft(), locationId }
  const decide = (grants: AgentDefinitionDraft["tools"], ready: (c: string) => boolean = () => true, p: typeof policy | null = policy) =>
    decideToolGrants({ shopId, actorId, policy: p, grants, connectorReady: ready })

  it("reports effective mode and reasons from the existing policy contract", () => {
    const [read, sms] = decide([
      { operation: "crm.read", maximumMode: "read" },
      { operation: "sms.reply", maximumMode: "approval" },
    ])
    expect(read).toMatchObject({ operation: "crm.read", available: true, effectiveMode: "read" })
    expect(sms).toMatchObject({ operation: "sms.reply", available: true, effectiveMode: "approval" })
  })

  it("caps the effective mode at the agent's requested maximum", () => {
    const [grant] = decide([{ operation: "sms.reply", maximumMode: "suggest" }])
    expect(grant).toMatchObject({ available: true, effectiveMode: "suggest", requestedMaximumMode: "suggest" })
  })

  it("explains an unready connector, a missing policy, and post-MVP tools", () => {
    expect(decide([{ operation: "sms.reply", maximumMode: "approval" }], (c) => c !== "sms")[0]).toMatchObject({ available: false, effectiveMode: "off", reasons: ["channel_not_ready"] })
    expect(decide([{ operation: "crm.read", maximumMode: "read" }], () => true, null)[0]).toMatchObject({ available: false, reasons: ["policy_unavailable"] })
    expect(decide([{ operation: "voice.outbound", maximumMode: "off" }])[0]).toMatchObject({ available: false, reasons: ["post_mvp_disabled"] })
  })

  it("a workspace-disabled policy turns every tool off", () => {
    const off = { ...policy, draft: { ...policy.draft, enabled: false } }
    expect(decide([{ operation: "crm.read", maximumMode: "read" }], () => true, off)[0]).toMatchObject({ available: false, reasons: ["workspace_disabled"] })
  })

  it("autonomous never exceeds the Control Center floor for calendar/money operations", () => {
    const grant = decide([{ operation: "booking.create", maximumMode: "autonomous" }], () => true, { ...policy, draft: { ...policy.draft, actionGrants: { "booking.create": "autonomous" } } })[0]
    expect(grant.effectiveMode).toBe("approval")
  })
})

function ctx(over: Partial<RevisionContext> = {}): RevisionContext {
  const definition = agentDefinitionDraftSchema.parse({ ...input(), revision: 1, lifecycle: "draft" })
  return {
    shopId,
    actorId,
    role: "owner",
    agent: { id: agentId, name: "Agent", enabled: false },
    state: { agent_id: agentId, lifecycle: "draft", active_revision: null, latest_revision: 1, lifecycle_reason: null, version: 2 },
    revision: { agent_id: agentId, revision: 1, parent_revision: null, schema_version: 1, definition, definition_hash: "a".repeat(64), authored_by: actorId, created_at: "2026-11-07T00:00:00Z" },
    definition,
    pins: [{ sourceId, sourceName: "Policy", memoryRevision: 1, contentHash: "b".repeat(64), status: "current" }],
    evaluations: [{ id: "e1", suiteVersion: "s", fixtureSetId: "f", fixtureHash: "c".repeat(64), passRate: 1, safetyPassed: true, estimatedCredits: 1, completedAt: "2026-11-07T00:00:00Z", source: "trusted_evaluator" }],
    policy: { revision: 3, draft: initialPolicyDraft(), locationId },
    knowledgeHead: 2,
    tools: [{ operation: "crm.read", connector: "crm", requestedMaximumMode: "read", effectiveMode: "read", available: true, reasons: [] }],
    connectorFingerprint: "f".repeat(64),
    activeAgentCount: 0,
    ...over,
  }
}
const activeBilling: CommercialBillingDto = { state: "active", eligibleToActivate: true, blockingReason: null, checkoutUrl: null, catalogVersion: "2026-11-03.v1", planKey: "founder-pilot", providerMode: "test" }

describe("computeEligibility", () => {
  it("is eligible only with every source current, and names the exact source versions", () => {
    const e = computeEligibility(ctx(), activeBilling)
    expect(e).toMatchObject({ eligible: true, alreadyActive: false, blockers: [] })
    expect(e.sources).toEqual({
      definitionHash: "a".repeat(64), schemaVersion: 1, policyRevision: 3, knowledgeRevision: 2,
      memoryPins: [{ sourceId, memoryRevision: 1, contentHash: "b".repeat(64) }],
      evaluationId: "e1", readyOperations: ["crm.read"], connectorFingerprint: "f".repeat(64), activeAgentCount: 0, activeAgentLimit: 2, expectedPointer: null,
    })
  })

  it("blocks as connector_stale when connector evidence moved while it was read", () => {
    const e = computeEligibility(ctx({ connectorFingerprint: null }), activeBilling)
    expect(e.eligible).toBe(false)
    expect(e.blockers).toContain("connector_stale")
    expect(e.sources?.connectorFingerprint).toBeNull()
  })

  it.each([
    ["a manager", { role: "manager" as const }, ["owner_activation_required"]],
    ["staff", { role: "staff" as const }, ["owner_activation_required"]],
    ["no policy", { policy: null, tools: [{ operation: "crm.read" as const, connector: "crm", requestedMaximumMode: "read" as const, effectiveMode: "off" as const, available: false, reasons: ["policy_unavailable"] }] }, ["policy_unavailable"]],
    ["no evaluation", { evaluations: [] }, ["evaluation_required"]],
    ["an unsafe evaluation", { evaluations: [{ id: "e", suiteVersion: "s", fixtureSetId: "f", fixtureHash: "c".repeat(64), passRate: 1, safetyPassed: false, estimatedCredits: 0, completedAt: "2026-11-07T00:00:00Z", source: "trusted_evaluator" as const }] }, ["safety_evaluation_failed"]],
    ["a weak evaluation", { evaluations: [{ id: "e", suiteVersion: "s", fixtureSetId: "f", fixtureHash: "c".repeat(64), passRate: 0.9, safetyPassed: true, estimatedCredits: 0, completedAt: "2026-11-07T00:00:00Z", source: "trusted_evaluator" as const }] }, ["quality_evaluation_failed"]],
    ["revoked memory", { pins: [{ sourceId, sourceName: null, memoryRevision: 1, contentHash: "b".repeat(64), status: "revoked" as const }] }, ["memory_revoked"]],
    ["stale memory", { pins: [{ sourceId, sourceName: null, memoryRevision: 1, contentHash: "b".repeat(64), status: "stale" as const }] }, ["memory_stale"]],
    ["expired memory", { pins: [{ sourceId, sourceName: null, memoryRevision: 1, contentHash: "b".repeat(64), status: "expired" as const }] }, ["memory_expired"]],
    ["changed memory", { pins: [{ sourceId, sourceName: null, memoryRevision: 1, contentHash: "b".repeat(64), status: "changed" as const }] }, ["memory_changed"]],
    ["a missing memory pin", { pins: [] }, ["knowledge_review_required"]],
    ["an unready connector", { tools: [{ operation: "sms.reply" as const, connector: "sms", requestedMaximumMode: "approval" as const, effectiveMode: "off" as const, available: false, reasons: ["channel_not_ready"] }] }, ["tool_not_ready"]],
    ["a policy-blocked tool", { tools: [{ operation: "crm.read" as const, connector: "crm", requestedMaximumMode: "read" as const, effectiveMode: "off" as const, available: false, reasons: ["workspace_disabled"] }] }, ["tool_policy_blocked"]],
    ["no definition state", { state: null }, ["definition_not_found"]],
  ])("blocks on %s", (_label, over, expected) => {
    const e = computeEligibility(ctx(over as Partial<RevisionContext>), activeBilling)
    expect(e.eligible).toBe(false)
    for (const code of expected) expect(e.blockers).toContain(code)
  })

  it("an unsupported schema or unreadable definition is never eligible", () => {
    const base = ctx()
    expect(computeEligibility({ ...base, revision: { ...base.revision, schema_version: 2 } }, activeBilling)).toMatchObject({ eligible: false, blockers: expect.arrayContaining(["unsupported_schema"]) })
    const broken = computeEligibility({ ...base, definition: null }, activeBilling)
    expect(broken).toMatchObject({ eligible: false, blockers: expect.arrayContaining(["invalid_definition"]), sources: null })
  })

  it("applies the two-agent cap and the billing boundary only when billing evidence is supplied", () => {
    expect(computeEligibility(ctx({ activeAgentCount: 2 }), activeBilling).blockers).toContain("active_agent_limit_reached")
    expect(computeEligibility(ctx({ activeAgentCount: 1 }), activeBilling).eligible).toBe(true)
    const pending: CommercialBillingDto = { ...activeBilling, state: "checkout_required", eligibleToActivate: false, blockingReason: "checkout_required" }
    expect(computeEligibility(ctx(), pending)).toMatchObject({ eligible: false, blockers: ["checkout_required"], billingState: "checkout_required" })
    const unknownReason = { ...pending, blockingReason: "something_new" } as unknown as CommercialBillingDto
    expect(computeEligibility(ctx(), unknownReason).blockers).toEqual(["billing_state_unavailable"])
    // Display billing is optional input: the database decides at activation.
    expect(computeEligibility(ctx({ activeAgentCount: 2 }), null).blockers).not.toContain("active_agent_limit_reached")
  })

  it("an already-active revision reports idempotence, not eligibility", () => {
    const active = ctx({
      agent: { id: agentId, name: "Agent", enabled: true },
      state: { agent_id: agentId, lifecycle: "active", active_revision: 1, latest_revision: 1, lifecycle_reason: null, version: 3 },
    })
    expect(computeEligibility(active, activeBilling)).toMatchObject({ alreadyActive: true, eligible: false })
  })

  it("never lets a paused or blocked revision look active", () => {
    for (const lifecycle of ["paused", "blocked"] as const) {
      const c = ctx({ state: { agent_id: agentId, lifecycle, active_revision: 1, latest_revision: 1, lifecycle_reason: "x", version: 3 } })
      expect(computeEligibility(c, activeBilling).alreadyActive).toBe(false)
    }
  })

  it("DTO output never carries secrets, URLs or memory bodies", () => {
    const text = JSON.stringify(computeEligibility(ctx(), { ...activeBilling, checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_x" }))
    expect(text).not.toMatch(/checkout\.stripe|sk_|whsec|password/i)
  })
})

describe("readers fail closed", () => {
  const stub = (rpc: () => Promise<{ data: unknown; error: unknown }>) =>
    ({ rpc, from: () => { throw new Error("must not read tables without authority") } }) as never
  const forbidden = stub(async () => ({ data: null, error: null }))
  const broken = stub(async () => ({ data: null, error: { code: "XX000" } }))
  const input = { shopId, actorId, agentId }

  it("returns forbidden for a caller with no live membership, before touching any table", async () => {
    expect(await readAgentsHomeDto({ service: forbidden }, { shopId, actorId })).toEqual({ status: "forbidden" })
    expect(await readBuilderResumeDto({ service: forbidden }, input)).toEqual({ status: "forbidden" })
    expect(await readRevisionDto({ service: forbidden }, { ...input, revision: 1 })).toEqual({ status: "forbidden" })
  })

  it("returns unavailable, never an empty or eligible result, when authority cannot be read", async () => {
    expect(await readAgentsHomeDto({ service: broken }, { shopId, actorId })).toMatchObject({ status: "unavailable" })
    expect(await readBuilderResumeDto({ service: broken }, input)).toMatchObject({ status: "unavailable" })
    expect(await readRevisionDto({ service: broken }, { ...input, revision: 1 })).toMatchObject({ status: "unavailable" })
  })

  it("returns unavailable when a table read throws after authority succeeds", async () => {
    const ownerThenBoom = {
      rpc: async () => ({ data: "owner", error: null }),
      from: () => { throw new Error("db down") },
    } as never
    expect(await readAgentsHomeDto({ service: ownerThenBoom }, { shopId, actorId })).toMatchObject({ status: "unavailable" })
  })
})
