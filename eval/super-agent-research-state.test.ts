import { beforeEach, describe, expect, it, vi } from "vitest"
import { isValidElement, type ReactElement } from "react"
import { EmployeeBuilder } from "@/components/gradia/employee-builder"
import type { EmployeeBrief, EmployeeDraft } from "@/lib/super-agent/brief"

const h = vi.hoisted(() => ({ state: [] as unknown[], cursor: 0, run: vi.fn(), cancel: vi.fn(), refresh: vi.fn() }))
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
vi.mock("@/app/actions/super-agent", () => ({ prepareEmployee: vi.fn(), saveEmployeeDraft: vi.fn(), runEmployeeResearch: h.run, cancelEmployeeResearch: h.cancel }))
vi.mock("@/app/actions/super-agent-browser", () => ({ checkCloudBrowser: vi.fn() }))

const brief: EmployeeBrief = { name: "Custom researcher", goal: "Compare suppliers for my detailing business", deliverable: "A sourced comparison", business_context: "https://parts.example/catalog", steps: ["Read the public catalog"], connections_needed: [], questions: [] }
const draft: EmployeeDraft = { id: "draft-1", created_at: "2026-10-16T00:00:00.000Z", brief }
function elements(node: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<Record<string, unknown>>(node)) return []
  return [node, ...elements(node.props.children)]
}
function render() {
  h.cursor = 0
  return elements(EmployeeBuilder({ drafts: [draft], runs: [], loadFailed: false, runLoadFailed: false, planningEnabled: false, planningCredits: null, researchEnabled: true }))
}
function button(label: string) {
  return render().find(node => typeof node.props.onClick === "function" && node.props.children === label)
}
beforeEach(() => { h.state = []; h.cursor = 0; vi.resetAllMocks() })

describe("research run retries", () => {
  it("refuses a second click while a run is outstanding", () => {
    h.run.mockImplementation(() => new Promise(() => {}))
    const click = button("Run research")?.props.onClick as () => void
    click(); click()
    expect(h.run).toHaveBeenCalledOnce()
  })

  it("retries the same run id after an uncertain result", async () => {
    h.run.mockResolvedValueOnce({ ok: false, error: "The result could not be saved. Retry this same run." })
    ;(button("Run research")?.props.onClick as () => void)()
    await vi.waitFor(() => expect(button("Retry this same run")).toBeDefined())
    h.run.mockResolvedValueOnce({ ok: true, replayed: true, run: { id: "run-1", draft_id: draft.id, status: "completed", report: {}, credits: 0, created_at: draft.created_at } })
    ;(button("Retry this same run")?.props.onClick as () => void)()
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(2))
    expect(h.run.mock.calls[1][0]).toEqual(h.run.mock.calls[0][0])
  })

  it("asks to stop the outstanding run id", async () => {
    h.run.mockImplementation(() => new Promise(() => {}))
    ;(button("Run research")?.props.onClick as () => void)()
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledOnce())
    ;(button("Stop")?.props.onClick as () => void)()
    expect(h.cancel).toHaveBeenCalledWith({ id: h.run.mock.calls[0][0].id })
  })
})
