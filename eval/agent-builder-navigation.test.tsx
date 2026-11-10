// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createElement, type AnchorHTMLAttributes } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ActivationEligibilityDto, BuilderResumeDto, DtoResult } from "@/lib/agent-os/definition-dto"
import type { MemoryCatalogDto } from "@/lib/agent-os/identity-store"
import type { AgentDefinitionDraft } from "@/lib/agent-os/definition-schema"

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), clicked: [] as string[] }))
const actions = vi.hoisted(() => ({
  saveAgentDefinitionRevision: vi.fn(),
  getActivationEligibility: vi.fn(),
  activateAgentDefinitionRevision: vi.fn(),
}))
vi.mock("@/app/actions/agent-definitions", () => actions)
vi.mock("next/navigation", () => ({ useRouter: () => nav }))
// Next's Link has its own client router; an anchor keeps what matters: the caller's onClick runs
// first, and jsdom has no navigation. The guard's decision is visible through event.defaultPrevented
// and the router.push spy.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => createElement("a", { ...rest, href }, children),
}))

import { DefinitionBuilder } from "@/components/agents/definition-builder"

const agentId = "00000000-0000-4000-8000-000000000004"
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
  sources: { definitionHash: "2".repeat(64), schemaVersion: 1, policyRevision: 3, knowledgeRevision: 1, memoryPins: [], evaluationId: null, readyOperations: [], connectorFingerprint: "f".repeat(64), activeAgentCount: 0, activeAgentLimit: 2, expectedPointer: null },
  billingState: null,
})
const resume: BuilderResumeDto = {
  agentId, name: "Quote follow-up", governance: "governed", lifecycle: "draft", role: "owner", canEdit: true, editBlockedReason: null,
  latestRevision: { ...ref(2), definition, memoryPins: [] }, activeRevision: null,
  steps: { job: "complete", knowledge: "complete", tools: "complete", limits: "complete", schedule: "complete", test: "incomplete", activate: "blocked" },
  eligibility: blocked(["evaluation_required"]),
}
const emptyCatalog: DtoResult<MemoryCatalogDto> = { status: "ok", data: { sources: [], truncated: false } }

function mount(step: "job" | "knowledge" | "tools" | "activate" = "job") {
  return render(createElement(DefinitionBuilder, { resume, initialStep: step, catalog: emptyCatalog, confirmedTools: null, evaluations: [] }))
}
const user = () => userEvent.setup()
const goal = () => screen.getByLabelText(/^Goal/) as HTMLTextAreaElement
const stepButton = (label: RegExp) => screen.getAllByRole("button", { name: label })[0]

beforeEach(() => {
  // jsdom reports an un-intercepted anchor click as "not implemented: navigation". That is the point
  // of the unguarded cases, so only that message is silenced.
  const original = console.error.bind(console)
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    if (/Not implemented: navigation/.test(String(args[0]))) return
    original(...(args as []))
  })
  nav.push.mockReset()
  actions.getActivationEligibility.mockResolvedValue({ status: "ok", data: blocked(["policy_unavailable", "knowledge_review_required"]) })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("every link that can leave the builder passes through the unsaved-change guard", () => {
  it("an edited form followed by the Control Center link asks first and does not navigate", async () => {
    const u = user()
    mount("job")
    await u.type(goal(), " Also mention deposits.")
    await u.click(stepButton(/^3\. Tools/))
    await u.click(await screen.findByRole("link", { name: "Open Control Center" }))
    expect(nav.push).not.toHaveBeenCalled()
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Leave without saving?")).toBeTruthy()
  })

  it("Keep editing keeps the edits and the page; Leave and discard then goes to exactly that link", async () => {
    const u = user()
    mount("job")
    await u.type(goal(), " Edited.")
    await u.click(stepButton(/^3\. Tools/))
    await u.click(screen.getByRole("link", { name: "Check connections" }))
    await u.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Keep editing" }))
    expect(nav.push).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    await u.click(stepButton(/^1\. Job/))
    expect(goal().value).toContain("Edited.")

    await u.click(stepButton(/^3\. Tools/))
    await u.click(screen.getByRole("link", { name: "Open Control Center" }))
    await u.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Leave and discard" }))
    expect(nav.push).toHaveBeenCalledTimes(1)
    expect(nav.push).toHaveBeenCalledWith("/control-center")
  })

  it("the Knowledge step's Settings link is guarded", async () => {
    const u = user()
    mount("job")
    await u.type(goal(), " x")
    await u.click(stepButton(/^2\. Knowledge/))
    await u.click(await screen.findByRole("link", { name: "Settings" }))
    expect(nav.push).not.toHaveBeenCalled()
    expect(await screen.findByRole("dialog")).toBeTruthy()
  })

  it("the header link back to the agent is guarded", async () => {
    const u = user()
    mount("job")
    await u.type(goal(), " x")
    await u.click(screen.getByRole("link", { name: /Quote follow-up/ }))
    expect(nav.push).not.toHaveBeenCalled()
    await u.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Leave and discard" }))
    expect(nav.push).toHaveBeenCalledWith(`/agents/${agentId}`)
  })

  it("an action link rendered inside a blocker on the Activate step is guarded", async () => {
    const u = user()
    mount("job")
    await u.type(goal(), " x")
    await u.click(stepButton(/^7\. Activate/))
    const link = await screen.findByRole("link", { name: "Open Control Center" })
    await u.click(link)
    expect(nav.push).not.toHaveBeenCalled()
    expect(await screen.findByRole("dialog")).toBeTruthy()
  })

  it("a blocker's 'Go to Knowledge' keeps the unsaved edits instead of reloading the page", async () => {
    const u = user()
    mount("job")
    await u.type(goal(), " kept")
    await u.click(stepButton(/^7\. Activate/))
    await u.click(await screen.findByRole("button", { name: "Go to Knowledge" }))
    expect(nav.push).not.toHaveBeenCalled()
    expect(screen.queryByRole("dialog")).toBeNull()
    await u.click(stepButton(/^1\. Job/))
    expect(goal().value).toContain("kept")
  })

  it("with no unsaved edits the link is left alone (not intercepted) and no dialog opens", async () => {
    mount("tools")
    const link = screen.getByRole("link", { name: "Open Control Center" })
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })
    link.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("a new-tab click (Ctrl/Cmd) never discards edits and is not intercepted", async () => {
    const u = user()
    mount("job")
    await u.type(goal(), " x")
    await u.click(stepButton(/^3\. Tools/))
    const link = screen.getByRole("link", { name: "Open Control Center" })
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ctrlKey: true })
    link.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(nav.push).not.toHaveBeenCalled()
    // The same link, plainly clicked with edits present, is intercepted.
    const plain = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })
    link.dispatchEvent(plain)
    expect(plain.defaultPrevented).toBe(true)
  })
})
