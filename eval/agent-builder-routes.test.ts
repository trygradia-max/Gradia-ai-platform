import { readFileSync } from "node:fs"
import type { ReactElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type {
  ActivationEligibilityDto,
  AgentDetailDto,
  AgentsHomeDto,
  BuilderResumeDto,
  DtoResult,
  RevisionDto,
} from "@/lib/agent-os/definition-dto"
import type { MemoryCatalogDto } from "@/lib/agent-os/identity-store"
import type { AgentDefinitionDraft } from "@/lib/agent-os/definition-schema"

const actions = vi.hoisted(() => ({
  getAgentsHome: vi.fn(),
  getAgentDetail: vi.fn(),
  getBuilderResume: vi.fn(),
  getAgentRevision: vi.fn(),
  getActivationEligibility: vi.fn(),
  getSelectableMemory: vi.fn(),
  saveAgentDefinitionRevision: vi.fn(),
  activateAgentDefinitionRevision: vi.fn(),
  pauseOrBlockAgentDefinition: vi.fn(),
  createGradiaAgentIdentity: vi.fn(),
}))
vi.mock("@/app/actions/agent-definitions", () => actions)
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))

import AgentsPage from "@/app/(dashboard)/agents/page"
import AgentBuildPage from "@/app/(dashboard)/agents/build/page"
import AgentDetailPage from "@/app/(dashboard)/agents/[agentId]/page"
import RevisionPage from "@/app/(dashboard)/agents/[agentId]/revisions/[revision]/page"

const agentId = "00000000-0000-4000-8000-000000000004"
const render = async (element: Promise<ReactElement> | ReactElement) => renderToStaticMarkup(await element)

const definition: AgentDefinitionDraft = {
  schemaVersion: 1,
  key: "quote-follow-up-000000",
  revision: 2,
  lifecycle: "draft",
  job: { roleLabel: "Quote follow-up", goal: "Follow up with quiet quotes and draft a message.", expectedOutcomes: ["Every quiet quote gets a draft"], stopConditions: ["Customer asks to stop"] },
  knowledge: { sourceIds: [], includeShopKnowledge: true, includeCustomerMemory: false, maxResultsPerQuery: 4 },
  tools: [{ operation: "crm.read", maximumMode: "read" }],
  schedule: { kind: "manual" },
  limits: { maximumStepsPerRun: 5, maximumRuntimeSeconds: 60, maximumCreditsPerRun: 10, maximumRunsPerDay: 10, maximumConcurrentRuns: 1 },
  routing: { strategy: "cost_aware", semanticCache: false },
}
const ref = (revision: number) => ({ revision, definitionHash: String(revision).repeat(64).slice(0, 64), createdAt: "2026-11-08T12:00:00.000Z", parentRevision: revision > 1 ? revision - 1 : null })
const blocked = (blockers: ActivationEligibilityDto["blockers"]): ActivationEligibilityDto => ({
  eligible: false, alreadyActive: false, blockers,
  sources: { definitionHash: "2".repeat(64), schemaVersion: 1, policyRevision: 3, knowledgeRevision: 1, memoryPins: [], evaluationId: null, readyOperations: ["crm.read"], connectorFingerprint: "f".repeat(64), activeAgentCount: 0, activeAgentLimit: 2, expectedPointer: null },
  billingState: null,
})
const revisionDto = (over: Partial<RevisionDto> = {}): RevisionDto => ({
  ...ref(2), agentId, schemaVersion: 1, authoredBy: "user", definition, isActive: false, lifecycle: "draft", memoryPins: [],
  tools: [{ operation: "crm.read", connector: "crm", requestedMaximumMode: "read", effectiveMode: "read", available: true, reasons: [] }],
  limits: definition.limits, schedule: definition.schedule, evaluations: [], activation: null,
  eligibility: blocked(["evaluation_required"]), ...over,
})
const home = (over: Partial<AgentsHomeDto> = {}): AgentsHomeDto => ({
  role: "owner", canManage: true, activeAgentCount: 0, activeAgentLimit: 2,
  agents: [{ agentId, name: "Quote follow-up", governance: "governed", lifecycle: "draft", enabled: false, activeRevision: null, latestRevision: ref(2), hasUnactivatedDraft: true, lastConfirmedRun: null, needsReviewCount: 3 }],
  ...over,
})
const resume = (over: Partial<BuilderResumeDto> = {}): BuilderResumeDto => ({
  agentId, name: "Quote follow-up", governance: "governed", lifecycle: "draft", role: "owner", canEdit: true, editBlockedReason: null,
  latestRevision: { ...ref(2), definition, memoryPins: [] }, activeRevision: null,
  steps: { job: "complete", knowledge: "complete", tools: "complete", limits: "complete", schedule: "complete", test: "incomplete", activate: "blocked" },
  eligibility: blocked(["evaluation_required"]), ...over,
})
const detail = (over: Partial<AgentDetailDto> = {}): AgentDetailDto => ({
  agentId, name: "Quote follow-up", governance: "governed", lifecycle: "draft", enabled: false, role: "owner", canManage: true, lifecycleReason: null,
  activeRevision: null, revisions: [ref(2), ref(1)], ...over,
})
const catalog: DtoResult<MemoryCatalogDto> = { status: "ok", data: { sources: [{ sourceId: "00000000-0000-4000-8000-000000000101", name: "Shop prices", memoryRevision: 1, status: "selectable" }], truncated: false } }
const ok = <T,>(data: T): DtoResult<T> => ({ status: "ok", data })

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset()
  actions.getSelectableMemory.mockResolvedValue(catalog)
})

describe("/agents (home)", () => {
  it("server-loads the home and renders each agent's lifecycle, revisions, confirmed run and review count", async () => {
    actions.getAgentsHome.mockResolvedValue(ok(home({ agents: [{ ...home().agents[0], lifecycle: "active", enabled: true, activeRevision: ref(1), lastConfirmedRun: { runId: "r", finishedAt: "2026-11-08T12:00:00.000Z" } }], activeAgentCount: 1 })))
    const html = await render(AgentsPage())
    expect(actions.getAgentsHome).toHaveBeenCalledTimes(1)
    expect(html).toContain("Your Gradia agents")
    expect(html).toContain("Create Gradia agent")
    expect(html).toContain(`href="/agents/${agentId}"`)
    expect(html).toContain(`href="/agents/${agentId}/revisions/1"`)
    expect(html).toContain(`href="/agents/${agentId}/revisions/2"`)
    expect(html).toContain("Governed")
    expect(html).toContain("Active")
    expect(html).toContain("Newer draft")
    expect(html).toMatch(/>1<\/span><span[^>]*> of <\/span><span[^>]*>2</)
    expect(html).not.toContain("No confirmed run yet")
  })

  it("never shows the planned public tiers or prices as purchasable", async () => {
    actions.getAgentsHome.mockResolvedValue(ok(home()))
    const html = await render(AgentsPage())
    expect(html).not.toMatch(/Core|Growth|Scale|\$\d|per month|\/month/)
  })

  it("a null review count is 'Unavailable', never zero; no run is 'No confirmed run yet' only on a successful read", async () => {
    actions.getAgentsHome.mockResolvedValue(ok(home({ agents: [{ ...home().agents[0], needsReviewCount: null, lastConfirmedRun: null }] })))
    const html = await render(AgentsPage())
    expect(html).toContain("Unavailable right now")
    expect(html).toContain("No confirmed run yet")
    expect(html).not.toMatch(/Needs your review<\/dt><dd[^>]*><span[^>]*>0</)
  })

  it("renders a written empty state with a create path for the owner", async () => {
    actions.getAgentsHome.mockResolvedValue(ok(home({ agents: [] })))
    const html = await render(AgentsPage())
    expect(html).toContain("No Gradia agents yet")
    expect(html).toContain('href="/agents/build"')
  })

  it("managers and staff can view but see no create or edit control", async () => {
    actions.getAgentsHome.mockResolvedValue(ok(home({ role: "manager", canManage: false })))
    const html = await render(AgentsPage())
    expect(html).not.toContain('href="/agents/build"')
    expect(html).not.toContain("Create Gradia agent")
    expect(html).toContain("Only the workspace owner can create or activate agents")
    expect(html).toContain("Quote follow-up")
  })

  it("forbidden and unavailable are their own states, never an empty list", async () => {
    actions.getAgentsHome.mockResolvedValue({ status: "forbidden" })
    const forbidden = await render(AgentsPage())
    expect(forbidden).toContain("don&#x27;t have access")
    expect(forbidden).not.toContain("No Gradia agents yet")
    actions.getAgentsHome.mockResolvedValue({ status: "unavailable", reason: "agents" })
    const unavailable = await render(AgentsPage())
    expect(unavailable).toContain("couldn&#x27;t load this right now")
    expect(unavailable).toContain('href="/agents"')
    expect(unavailable).toContain("Try again")
    expect(unavailable).not.toContain("No Gradia agents yet")
  })

  it("states the runtime limitation", async () => {
    actions.getAgentsHome.mockResolvedValue(ok(home()))
    expect(await render(AgentsPage())).toMatch(/not bound to a revision yet/)
  })
})

describe("/agents/build", () => {
  const page = (params: Record<string, string | string[] | undefined>) => AgentBuildPage({ searchParams: Promise.resolve(params) })

  it("awaits promise searchParams and starts with a bounded name for an owner", async () => {
    actions.getAgentsHome.mockResolvedValue(ok(home()))
    const html = await render(page({}))
    expect(html).toContain("Create a Gradia agent")
    expect(html).toContain("Agent name")
    expect(actions.getBuilderResume).not.toHaveBeenCalled()
  })

  it("a non-owner cannot start a new agent", async () => {
    actions.getAgentsHome.mockResolvedValue(ok(home({ role: "staff", canManage: false })))
    const html = await render(page({}))
    expect(html).toContain("Only the workspace owner can create agents")
    expect(html).not.toContain("Agent name")
  })

  it.each([["not-a-uuid"], ["../../etc/passwd"], [""], [`${agentId}x`], [["a", "b"]]])("rejects the malformed agent param %j without reading tenant data", async (agent) => {
    const html = await render(page({ agent: agent as never }))
    expect(html).toContain("That link isn&#x27;t valid")
    expect(actions.getBuilderResume).not.toHaveBeenCalled()
    expect(actions.getAgentsHome).not.toHaveBeenCalled()
  })

  it("loads the exact agent on every entry and renders all seven steps", async () => {
    actions.getBuilderResume.mockResolvedValue(ok(resume()))
    actions.getAgentRevision.mockResolvedValue(ok(revisionDto()))
    const html = await render(page({ agent: agentId, step: "tools" }))
    expect(actions.getBuilderResume).toHaveBeenCalledWith(agentId)
    expect(actions.getAgentRevision).toHaveBeenCalledWith(agentId, 2)
    for (const label of ["Job", "Knowledge", "Tools", "Limits", "Schedule", "Test", "Activate"]) expect(html).toContain(label)
    expect(html).toContain('aria-label="Builder steps"')
    expect(html).toContain('aria-current="step"')
    expect(html).toContain("Editing from revision 2")
  })

  it("falls back to the Job step for an unknown step", async () => {
    actions.getBuilderResume.mockResolvedValue(ok(resume({ latestRevision: null, eligibility: null })))
    const html = await render(page({ agent: agentId, step: "hacked" }))
    expect(html).toContain("Say what this agent is for")
    expect(html).toContain("No revision saved yet")
  })

  it("never activates, saves or tests while rendering any step", async () => {
    actions.getBuilderResume.mockResolvedValue(ok(resume()))
    actions.getAgentRevision.mockResolvedValue(ok(revisionDto()))
    for (const step of ["job", "knowledge", "tools", "limits", "schedule", "test", "activate"]) await render(page({ agent: agentId, step }))
    expect(actions.activateAgentDefinitionRevision).not.toHaveBeenCalled()
    expect(actions.saveAgentDefinitionRevision).not.toHaveBeenCalled()
    expect(actions.pauseOrBlockAgentDefinition).not.toHaveBeenCalled()
    expect(actions.createGradiaAgentIdentity).not.toHaveBeenCalled()
  })

  it("the Test step says the runner is unavailable and names the blocker", async () => {
    actions.getBuilderResume.mockResolvedValue(ok(resume()))
    actions.getAgentRevision.mockResolvedValue(ok(revisionDto()))
    const html = await render(page({ agent: agentId, step: "test" }))
    expect(html).toContain("Test runner not available yet")
    expect(html).toContain("evaluation_required")
    expect(html).toContain("No test evidence")
    expect(html).not.toMatch(/Safety passed|Pass rate/)
  })

  it("renders existing exact-revision evaluations without inventing any", async () => {
    actions.getBuilderResume.mockResolvedValue(ok(resume()))
    actions.getAgentRevision.mockResolvedValue(ok(revisionDto({ evaluations: [{ id: "e1", suiteVersion: "suite-9", fixtureSetId: "f", fixtureHash: "c".repeat(64), passRate: 0.97, safetyPassed: true, estimatedCredits: 4, completedAt: "2026-11-08T12:00:00.000Z", source: "trusted_evaluator" }] })))
    const html = await render(page({ agent: agentId, step: "test" }))
    expect(html).toContain("suite-9")
    expect(html).toContain("97%")
  })

  it("read-only for a manager: every field is disabled and there is no Save", async () => {
    actions.getBuilderResume.mockResolvedValue(ok(resume({ role: "manager", canEdit: false, editBlockedReason: "owner_required" })))
    actions.getAgentRevision.mockResolvedValue(ok(revisionDto()))
    const html = await render(page({ agent: agentId, step: "job" }))
    expect(html).toContain("Only the workspace owner can edit or activate agents")
    expect(html).toContain("<fieldset disabled")
    expect(html).not.toMatch(/>Save<\/button>/)
  })

  it("explains an enabled legacy agent must be turned off first", async () => {
    actions.getBuilderResume.mockResolvedValue(ok(resume({ governance: "legacy_unversioned", lifecycle: "legacy_unversioned", canEdit: false, editBlockedReason: "legacy_agent_enabled", latestRevision: null, eligibility: null })))
    const html = await render(page({ agent: agentId }))
    expect(html).toContain("legacy agent and it is turned on")
  })

  it("forbidden, not-found and unavailable agents get intentional states", async () => {
    actions.getBuilderResume.mockResolvedValue({ status: "forbidden" })
    expect(await render(page({ agent: agentId }))).toContain("don&#x27;t have access")
    actions.getBuilderResume.mockResolvedValue({ status: "unavailable", reason: "agent_not_found" })
    expect(await render(page({ agent: agentId }))).toContain("couldn&#x27;t find that")
    actions.getBuilderResume.mockResolvedValue({ status: "unavailable", reason: "db" })
    const html = await render(page({ agent: agentId, step: "limits" }))
    expect(html).toContain("couldn&#x27;t load this right now")
    expect(html).toContain(`href="/agents/build?agent=${agentId}&amp;step=limits"`)
  })

  it("an unreadable memory catalog is a warning, not an empty list", async () => {
    actions.getBuilderResume.mockResolvedValue(ok(resume()))
    actions.getAgentRevision.mockResolvedValue(ok(revisionDto()))
    actions.getSelectableMemory.mockResolvedValue({ status: "unavailable", reason: "memory" })
    const html = await render(page({ agent: agentId, step: "knowledge" }))
    expect(html).toContain("couldn&#x27;t load your reviewed knowledge")
    expect(html).not.toContain("You have no reviewed knowledge yet")
  })

  it("the Knowledge step lists current reviewed sources and no candidate text", async () => {
    actions.getBuilderResume.mockResolvedValue(ok(resume()))
    actions.getAgentRevision.mockResolvedValue(ok(revisionDto()))
    const html = await render(page({ agent: agentId, step: "knowledge" }))
    expect(html).toContain("Shop prices")
    expect(html).toContain("Reviewed and published")
    expect(html).toContain("not consent from a customer")
  })

  it("the Tools step separates requested maximums from what Gradia confirmed", async () => {
    actions.getBuilderResume.mockResolvedValue(ok(resume()))
    actions.getAgentRevision.mockResolvedValue(ok(revisionDto()))
    const html = await render(page({ agent: agentId, step: "tools" }))
    expect(html).toContain("requested maximum")
    expect(html).toContain("Confirmed by Gradia:")
    expect(html).toContain('href="/control-center"')
    expect(html).toContain("Not available yet")
    expect(html).toContain("Place phone calls")
  })

  it("Tools without a saved revision never claims availability", async () => {
    actions.getBuilderResume.mockResolvedValue(ok(resume({ latestRevision: null, eligibility: null })))
    const html = await render(page({ agent: agentId, step: "tools" }))
    expect(html).not.toContain("Confirmed by Gradia")
  })
})

describe("/agents/[agentId]", () => {
  const page = (id: string) => AgentDetailPage({ params: Promise.resolve({ agentId: id }) })

  it("awaits promise params and rejects a malformed id before reading", async () => {
    expect(await render(page("nope"))).toContain("That link isn&#x27;t valid")
    expect(actions.getAgentDetail).not.toHaveBeenCalled()
  })

  it("renders a draft agent: latest draft, history links, no pause control, not deletable", async () => {
    actions.getAgentDetail.mockResolvedValue(ok(detail()))
    const html = await render(page(agentId))
    expect(actions.getAgentDetail).toHaveBeenCalledWith(agentId)
    expect(html).toContain("Draft")
    expect(html).toContain("Newer draft")
    expect(html).toContain(`href="/agents/${agentId}/revisions/2"`)
    expect(html).toContain(`href="/agents/${agentId}/revisions/1"`)
    expect(html).toContain("Continue in builder")
    expect(html).not.toContain("Pause agent")
    expect(html).toContain("can&#x27;t be deleted")
  })

  it("renders an active agent with owner pause/block controls, and marks superseded revisions", async () => {
    actions.getAgentDetail.mockResolvedValue(ok(detail({ lifecycle: "active", enabled: true, activeRevision: revisionDto({ ...ref(2), isActive: true, lifecycle: "active" }) })))
    const html = await render(page(agentId))
    expect(html).toContain("Active definition: revision 2")
    expect(html).toContain("Pause agent")
    expect(html).toContain("Block agent")
    expect(html).toContain("Superseded")
  })

  it("a manager sees the agent but no pause, block or edit controls", async () => {
    actions.getAgentDetail.mockResolvedValue(ok(detail({ role: "manager", canManage: false, lifecycle: "active", enabled: true, activeRevision: revisionDto({ isActive: true }) })))
    const html = await render(page(agentId))
    expect(html).not.toContain("Pause agent")
    expect(html).not.toContain("Block agent")
    expect(html).not.toContain("Continue in builder")
    expect(html).toContain("Only the workspace owner can edit or activate")
  })

  it.each([["paused"], ["blocked"]] as const)("shows the %s reason and says resume is a fresh activation", async (lifecycle) => {
    actions.getAgentDetail.mockResolvedValue(ok(detail({ lifecycle, lifecycleReason: "Customer complaint under review", activeRevision: revisionDto({ isActive: true }) })))
    const html = await render(page(agentId))
    expect(html).toContain("Customer complaint under review")
    expect(html).toContain("activate a revision again")
    expect(html).not.toContain("Resume agent")
  })

  it("explains a legacy agent honestly, including the enabled case", async () => {
    actions.getAgentDetail.mockResolvedValue(ok(detail({ governance: "legacy_unversioned", lifecycle: "legacy_unversioned", enabled: true, revisions: [] })))
    const html = await render(page(agentId))
    expect(html).toContain("This is a legacy agent")
    expect(html).toContain("turned on")
    expect(html).toContain("Define this agent")
  })

  it("forbidden / not found / unavailable are intentional states", async () => {
    actions.getAgentDetail.mockResolvedValue({ status: "forbidden" })
    expect(await render(page(agentId))).toContain("don&#x27;t have access")
    actions.getAgentDetail.mockResolvedValue({ status: "unavailable", reason: "agent_not_found" })
    expect(await render(page(agentId))).toContain("couldn&#x27;t find that")
    actions.getAgentDetail.mockResolvedValue({ status: "unavailable", reason: "x" })
    expect(await render(page(agentId))).toContain("Try again")
  })
})

describe("/agents/[agentId]/revisions/[revision]", () => {
  const page = (rawAgent: string, revision: string) => RevisionPage({ params: Promise.resolve({ agentId: rawAgent, revision }) })

  it.each([["1.5"], ["0"], ["-1"], ["abc"], ["01"], ["1e3"]])("rejects the malformed revision %j before reading", async (revision) => {
    expect(await render(page(agentId, revision))).toContain("That link isn&#x27;t valid")
    expect(actions.getAgentRevision).not.toHaveBeenCalled()
  })

  it("rejects a malformed agent id", async () => {
    expect(await render(page("zzz", "1"))).toContain("That link isn&#x27;t valid")
    expect(actions.getAgentRevision).not.toHaveBeenCalled()
  })

  it("renders the exact revision read-only, with hash, blockers and a way to create a new revision", async () => {
    actions.getAgentRevision.mockResolvedValue(ok(revisionDto({ ...ref(1) })))
    actions.getAgentDetail.mockResolvedValue(ok(detail()))
    const html = await render(page(agentId, "1"))
    expect(actions.getAgentRevision).toHaveBeenCalledWith(agentId, 1)
    expect(html).toContain("Revision 1")
    expect(html).toContain("Read-only")
    expect(html).toContain("Quote follow-up")
    expect(html).toContain("Testing is not available yet")
    expect(html).toContain("Revision 2 is the latest")
    expect(html).toContain(`href="/agents/build?agent=${agentId}"`)
    expect(html).toContain("Definition hash 1111")
    expect(html).not.toMatch(/<input|<textarea|<select|>Save<|>Save &/)
  })

  it("offers no edit link to a manager", async () => {
    actions.getAgentRevision.mockResolvedValue(ok(revisionDto()))
    actions.getAgentDetail.mockResolvedValue(ok(detail({ role: "staff", canManage: false })))
    const html = await render(page(agentId, "2"))
    expect(html).not.toContain(`href="/agents/build?agent=${agentId}"`)
  })

  it("reports a missing revision and an unreadable one differently", async () => {
    actions.getAgentDetail.mockResolvedValue(ok(detail()))
    actions.getAgentRevision.mockResolvedValue({ status: "unavailable", reason: "revision_not_found" })
    expect(await render(page(agentId, "9"))).toContain("couldn&#x27;t find that")
    actions.getAgentRevision.mockResolvedValue({ status: "unavailable", reason: "memory" })
    expect(await render(page(agentId, "9"))).toContain("couldn&#x27;t load this right now")
    actions.getAgentRevision.mockResolvedValue({ status: "forbidden" })
    expect(await render(page(agentId, "9"))).toContain("don&#x27;t have access")
  })
})

describe("route files keep the Build 2 contract", () => {
  const read = (path: string) => readFileSync(path, "utf8")

  it("replaces both legacy aliases and keeps the legacy receptionist routes", () => {
    expect(read("src/app/(dashboard)/agents/page.tsx")).not.toContain("receptionist/page")
    expect(read("src/app/(dashboard)/agents/build/page.tsx")).not.toContain("receptionist/build/page")
    expect(read("src/app/(dashboard)/receptionist/page.tsx")).toContain("export default async function AgentsPage")
    expect(read("src/app/(dashboard)/receptionist/build/page.tsx")).toContain("AgentBuilder")
  })

  it("pages await promise params and never read tenant data from a client effect", () => {
    expect(read("src/app/(dashboard)/agents/[agentId]/page.tsx")).toMatch(/await params/)
    expect(read("src/app/(dashboard)/agents/[agentId]/revisions/[revision]/page.tsx")).toMatch(/await params/)
    expect(read("src/app/(dashboard)/agents/build/page.tsx")).toMatch(/await searchParams/)
    const clients = ["new-agent-form", "definition-builder", "builder-steps", "lifecycle-controls"].map((n) => read(`src/components/agents/${n}.tsx`))
    for (const source of clients) {
      expect(source.startsWith('"use client"')).toBe(true)
      expect(source).not.toMatch(/getAgentsHome|getAgentDetail|getBuilderResume|getAgentRevision|getSelectableMemory/)
    }
  })

  it("only the Activate readiness refresh reads from the client, through the exact-revision action", () => {
    const builder = read("src/components/agents/definition-builder.tsx")
    expect(builder.match(/getActivationEligibility\(/g)?.length).toBe(1)
  })

  it("uses only Build 1 actions and no legacy planner, saveCustomAgent or model call", () => {
    for (const file of ["definition-builder", "builder-steps", "new-agent-form", "lifecycle-controls", "agents-home-view", "agent-detail-view", "agent-parts"]) {
      const source = read(`src/components/agents/${file}.tsx`)
      expect(source, file).not.toMatch(/saveCustomAgent|planAgent|previewCustomAgentPlan|setCustomAgentEnabled|deleteCustomAgent|anthropic|openai|stripe\.com\/v1/i)
    }
  })

  it("every route has a loading skeleton and the segment has an error boundary", () => {
    for (const path of ["agents/loading.tsx", "agents/build/loading.tsx", "agents/[agentId]/loading.tsx", "agents/[agentId]/revisions/[revision]/loading.tsx", "agents/error.tsx"]) {
      expect(() => read(`src/app/(dashboard)/${path}`)).not.toThrow()
    }
    expect(read("src/app/(dashboard)/agents/error.tsx")).toContain("unstable_retry")
  })

  it("the a11y floor: labelled nav, dialogs via the shared Dialog, semantic headings, no raw hex", () => {
    const sources = ["definition-builder", "builder-steps", "agent-parts", "agents-home-view", "agent-detail-view", "lifecycle-controls"].map((n) => read(`src/components/agents/${n}.tsx`)).join("\n")
    expect(sources).toContain('aria-label="Builder steps"')
    expect(sources).toContain('aria-current={current ? "step" : undefined}')
    expect(sources).toContain("ConfirmDialog")
    expect(sources).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(sources).not.toMatch(/animate-|transition-all|framer-motion/)
  })
})
