import { beforeEach, describe, expect, it, vi } from "vitest"
import { isValidElement, type ReactElement } from "react"
import { EmployeeBuilder } from "@/components/gradia/employee-builder"
import { memorySnapshot } from "@/lib/super-agent/memory"
import type { EmployeeBrief, EmployeeDraft } from "@/lib/super-agent/brief"

const h = vi.hoisted(() => ({ state: [] as unknown[], cursor: 0, read: vi.fn(), refresh: vi.fn() }))
vi.mock("react", async load => ({
  ...await load<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = h.cursor++
    if (!(index in h.state)) h.state[index] = typeof initial === "function" ? (initial as () => unknown)() : initial
    return [h.state[index], (next: unknown) => { h.state[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(h.state[index]) : next }]
  },
  useRef: (initial: unknown) => {
    const index = h.cursor++
    if (!(index in h.state)) h.state[index] = { current: initial }
    return h.state[index]
  },
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh }) }))
vi.mock("@/app/actions/super-agent", () => ({ prepareEmployee: vi.fn(), saveEmployeeDraft: vi.fn(), runEmployeeResearch: vi.fn(), cancelEmployeeResearch: vi.fn() }))
vi.mock("@/app/actions/super-agent-browser", () => ({ checkCloudBrowser: vi.fn() }))
vi.mock("@/app/actions/super-agent-memory", () => ({ readEmployeeMemory: h.read }))

const brief: EmployeeBrief = { name: "Custom researcher", goal: "Compare suppliers for my detailing business", deliverable: "A sourced comparison", business_context: "Hours", steps: ["Read the notes"], connections_needed: [], questions: [] }
const draft: EmployeeDraft = { id: "draft-1", created_at: "2026-10-16T00:00:00.000Z", brief }
function elements(node: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<Record<string, unknown>>(node)) return []
  return [node, ...elements(node.props.children)]
}
function render() {
  h.cursor = 0
  return elements(EmployeeBuilder({ drafts: [draft], runs: [], loadFailed: false, runLoadFailed: false, planningEnabled: false, planningCredits: null, researchEnabled: false, memoryEnabled: true }))
}
function button(label: string) {
  return render().find(node => typeof node.props.onClick === "function" && node.props.children === label)
}
beforeEach(() => { h.state = []; h.cursor = 0; vi.resetAllMocks() })

describe("business-note read retries", () => {
  it("refuses a second click and retries the same id", async () => {
    h.read.mockImplementationOnce(() => new Promise(() => {}))
    const click = button("Read saved notes")?.props.onClick as () => void
    click(); click()
    expect(h.read).toHaveBeenCalledOnce()
    h.state = []; h.read.mockReset()
    h.read.mockResolvedValueOnce({ ok: false, error: "The read could not be saved. Retry this same read." })
    ;(button("Read saved notes")?.props.onClick as () => void)()
    await vi.waitFor(() => expect(button("Retry this note read")).toBeDefined())
    h.read.mockResolvedValueOnce({ ok: true, replayed: true, read: { id: "read-1", draft_id: draft.id, detail: memorySnapshot([]), created_at: draft.created_at } })
    ;(button("Retry this note read")?.props.onClick as () => void)()
    await vi.waitFor(() => expect(h.read).toHaveBeenCalledTimes(2))
    expect(h.read.mock.calls[1][0]).toEqual(h.read.mock.calls[0][0])
  })
})
