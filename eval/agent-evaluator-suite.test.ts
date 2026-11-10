import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

import type { AgentDefinitionDraft } from "@/lib/agent-os/definition-schema"
import {
  EVALUATION_FIXTURE_SET_ID,
  EVALUATION_SUITE_VERSION,
  FIXTURES,
  FIXTURE_SET_HASH,
  evaluateDefinition,
  type Fixture,
} from "@/lib/agent-os/evaluator/suite"

const SRC = "00000000-0000-4000-8000-000000000101"
const definition = (over: Partial<AgentDefinitionDraft> = {}): AgentDefinitionDraft => ({
  schemaVersion: 1,
  key: "quote-follow-up-000000",
  revision: 1,
  lifecycle: "draft",
  job: { roleLabel: "Quote follow-up", goal: "Follow up with quiet quotes and draft a message.", expectedOutcomes: ["Every quiet quote gets a draft"], stopConditions: ["Customer asks to stop"] },
  knowledge: { sourceIds: [], includeShopKnowledge: false, includeCustomerMemory: false, maxResultsPerQuery: 4 },
  tools: [{ operation: "crm.read", maximumMode: "read" }],
  schedule: { kind: "manual" },
  limits: { maximumStepsPerRun: 5, maximumRuntimeSeconds: 60, maximumCreditsPerRun: 10, maximumRunsPerDay: 10, maximumConcurrentRuns: 1 },
  routing: { strategy: "cost_aware", semanticCache: false },
  ...over,
})
const run = (def: AgentDefinitionDraft, pinned: string[] = def.knowledge.sourceIds) => evaluateDefinition({ definition: def, pinnedSourceIds: pinned })
const failedIds = (def: AgentDefinitionDraft, pinned?: string[]) => run(def, pinned).failed.map((f) => f.id)

describe("governance-contract evaluation suite", () => {
  it("passes a sound definition: every fixture holds, safety passes, and it is labeled as governance, not quality", () => {
    const r = run(definition())
    expect(r.failed).toEqual([])
    expect(r).toMatchObject({ passRate: 1, safetyPassed: true, passed: FIXTURES.length, total: FIXTURES.length })
    expect(r.suiteVersion).toBe(EVALUATION_SUITE_VERSION)
    expect(r.fixtureSetId).toBe(EVALUATION_FIXTURE_SET_ID)
    expect(r.fixtureHash).toBe(FIXTURE_SET_HASH)
    expect(r.costEvidence).toMatchObject({ basis: "definition_limit", modelCalls: 0 })
    expect(r.estimatedCredits).toBe(10)
  })

  it("is deterministic: the same definition always yields the identical result", () => {
    const def = definition({ tools: [{ operation: "sms.followup", maximumMode: "approval" }], job: { roleLabel: "Follow up", goal: "Follow up politely with quiet leads.", expectedOutcomes: ["Reply received"], stopConditions: ["Customer says STOP"] } })
    expect(JSON.stringify(run(def))).toBe(JSON.stringify(run(def)))
  })

  it("covers sound tool sets across the whole operation vocabulary", () => {
    const def = definition({
      tools: [
        { operation: "crm.read", maximumMode: "read" },
        { operation: "draft.private", maximumMode: "suggest" },
        { operation: "quote.send", maximumMode: "autonomous" },
        { operation: "booking.create", maximumMode: "autonomous" },
        { operation: "sms.reply", maximumMode: "approval" },
      ],
      job: { roleLabel: "Front desk", goal: "Answer leads and prepare quotes for approval.", expectedOutcomes: ["Leads answered"], stopConditions: ["Customer asks to stop messages"] },
    })
    const r = run(def)
    // quote.send / booking.create asked for autonomy: the policy engine floors them, so the definition still passes.
    expect(r.failed).toEqual([])
  })

  describe("negative controls: each rule can actually fail", () => {
    it("outbound customer messaging with no opt-out stop condition fails safety", () => {
      const def = definition({ tools: [{ operation: "sms.nurture", maximumMode: "approval" }], job: { roleLabel: "Nurture", goal: "Nurture quiet leads with texts.", expectedOutcomes: ["Reply received"], stopConditions: ["Budget is spent"] } })
      const r = run(def)
      expect(failedIds(def)).toEqual(["outbound-messaging-has-stop-condition"])
      expect(r.safetyPassed).toBe(false)
      expect(r.passRate).toBeLessThan(1)
    })

    it("recognises genuine opt-out wording", () => {
      for (const stop of ["Customer replies STOP", "They opt out", "Customer unsubscribes? unsubscribe now", "Do not contact again"]) {
        const def = definition({ tools: [{ operation: "email.nurture", maximumMode: "approval" }], job: { roleLabel: "Nurture", goal: "Nurture quiet leads by email.", expectedOutcomes: ["Reply received"], stopConditions: [stop] } })
        expect(failedIds(def), stop).toEqual([])
      }
    })

    it("a post-MVP tool fails safety", () => {
      const def = definition({ tools: [{ operation: "voice.outbound", maximumMode: "off" }] })
      expect(failedIds(def)).toContain("post-mvp-tools-absent")
      expect(run(def).safetyPassed).toBe(false)
    })

    it("pins that differ from the selected sources fail safety (missing, extra, or wrong)", () => {
      const def = definition({ knowledge: { sourceIds: [SRC], includeShopKnowledge: false, includeCustomerMemory: false, maxResultsPerQuery: 4 } })
      expect(failedIds(def, [])).toEqual(["memory-pins-match-sources"])
      expect(failedIds(def, [SRC, "00000000-0000-4000-8000-000000000202"])).toEqual(["memory-pins-match-sources"])
      expect(failedIds(def, ["00000000-0000-4000-8000-000000000202"])).toEqual(["memory-pins-match-sources"])
      expect(failedIds(def, [SRC])).toEqual([])
    })

    it("a secret/provider/prompt-shaped key anywhere fails safety", () => {
      const def = { ...definition(), job: { ...definition().job, api_key: "x" } } as unknown as AgentDefinitionDraft
      expect(failedIds(def)).toEqual(expect.arrayContaining(["no-secret-or-provider-keys", "schema-strict"]))
    })

    it("out-of-bounds limits fail safety", () => {
      const def = definition({ limits: { maximumStepsPerRun: 31, maximumRuntimeSeconds: 60, maximumCreditsPerRun: 10, maximumRunsPerDay: 10, maximumConcurrentRuns: 1 } })
      expect(failedIds(def)).toContain("limits-bounded")
    })

    it("an interval agent allowed more runs per day than its interval can use is a quality failure, not a safety one", () => {
      const def = definition({ schedule: { kind: "interval", everyMinutes: 720 }, limits: { maximumStepsPerRun: 5, maximumRuntimeSeconds: 60, maximumCreditsPerRun: 10, maximumRunsPerDay: 50, maximumConcurrentRuns: 1 } })
      const r = run(def)
      expect(r.failed.map((f) => f.id)).toEqual(["interval-schedule-is-affordable"])
      expect(r.safetyPassed).toBe(true)
      expect(r.passRate).toBeLessThan(1)
    })
  })

  it("a fixture that throws counts as a failure, never a pass", () => {
    const boom: Fixture = { id: "boom", safety: true, description: "throws", run: () => { throw new Error("x") } }
    const r = evaluateDefinition({ definition: definition(), pinnedSourceIds: [] }, [boom])
    expect(r).toMatchObject({ passed: 0, total: 1, passRate: 0, safetyPassed: false })
    expect(r.failed[0]).toMatchObject({ id: "boom", safety: true })
  })

  it("an empty fixture set can never pass", () => {
    const r = evaluateDefinition({ definition: definition(), pinnedSourceIds: [] }, [])
    expect(r).toMatchObject({ total: 0, passRate: 0, safetyPassed: false })
  })

  it("the fixture-set hash binds ids, safety flags and descriptions", () => {
    expect(FIXTURE_SET_HASH).toMatch(/^[0-9a-f]{64}$/)
    expect(new Set(FIXTURES.map((f) => f.id)).size).toBe(FIXTURES.length)
    expect(FIXTURES.some((f) => f.safety)).toBe(true)
  })

  it("never reaches a model, provider, network, clock or randomness", () => {
    for (const file of ["src/lib/agent-os/evaluator/suite.ts"]) {
      const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
      expect(code, file).not.toMatch(/fetch\(|anthropic|openai|@ai-sdk|process\.env|Date\.now|new Date\(|Math\.random|randomUUID|createServiceClient|supabase/i)
    }
  })

  it("the orchestrator takes ids only and writes only through the trusted evaluation seam", () => {
    const source = readFileSync("src/lib/agent-os/evaluator/run.ts", "utf8")
    expect(source).toMatch(/input: \{ shopId: string; actorId: string; agentId: string; revision: number \}/)
    expect(source).toContain("recordTrustedAgentEvaluation(")
    expect(source).not.toMatch(/\.insert\(|\.upsert\(|\.update\(|\.delete\(/)
    expect(source).not.toMatch(/fetch\(|anthropic|openai|@ai-sdk/i)
  })
})
