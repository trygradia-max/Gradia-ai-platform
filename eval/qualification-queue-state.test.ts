import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { isValidElement, type ReactElement } from "react"
import { QualificationQueueQuestion, type QualificationQueueThreads } from "@/components/gradia/qualification-queue"
import { unknownQualificationFields, type LeadQualification } from "@/lib/lead-qualification"
const h = vi.hoisted(() => ({ state: [] as unknown[], cursor: 0, submit: vi.fn(), refresh: vi.fn(), reload: vi.fn() }))
vi.mock("react", async load => ({
  ...await load<typeof import("react")>(),
  useState: (initial: unknown) => {
    const i = h.cursor++
    if (!(i in h.state)) h.state[i] = typeof initial === "function" ? initial() : initial
    return [h.state[i], (next: unknown) => { h.state[i] = typeof next === "function" ? next(h.state[i]) : next }]
  },
  useRef: (initial: unknown) => {
    const i = h.cursor++
    if (!(i in h.state)) h.state[i] = { current: initial }
    return h.state[i]
  },
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh }) }))
vi.mock("@/app/actions/lead-qualification", () => ({ stageQualificationQuestion: h.submit }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
const id = "00000000-0000-4000-8000-000000000001"
const other = "00000000-0000-4000-8000-000000000002"

function record(patch: Partial<LeadQualification> = {}): LeadQualification {
  return {
    workflow_id: id,
    channel: "website_form",
    last_received_at: "2026-10-09T15:02:11+00:00",
    identity: {
      state: "identity_linked",
      customer_id: id,
      customer_name: "Fictional Lead",
      vehicle_id: other,
      vehicle_status: "confirmed",
      vehicle: { year: 2021, make: "Fictional", model: "Coupe", color: null },
      evidence_revision: 1,
    },
    revision: 0,
    review_state: "not_started",
    recorded_review_state: null,
    review_reasons: [],
    fields: unknownQualificationFields(),
    open_questions: [],
    missing: ["service", "vehicle_condition", "timing", "location", "constraints"],
    completeness: "incomplete",
    updated_at: null,
    updated_by: null,
    can_update: true,
    ...patch,
  }
}

const smsThreads: QualificationQueueThreads = {
  sms: { latestId: other, revision: 4, destination: "+15555550111" },
  email: null,
}
function elements(node: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<Record<string, unknown>>(node)) return []
  return [node, ...elements(node.props.children)]
}
function render() {
  h.cursor = 0
  return elements(QualificationQueueQuestion({ shopId: id, workflowId: id, qualification: record(), threads: smsThreads, isOwner: true }))
}
function button(label: string) {
  return render().find(n => typeof n.props.onClick === "function" &&
    (n.props.children === label || Array.isArray(n.props.children) && n.props.children.includes(label)))!
}
function click(label: string) { (button(label).props.onClick as () => void)() }
beforeEach(() => { h.state = []; h.cursor = 0; vi.resetAllMocks(); vi.stubGlobal("window", { location: { reload: h.reload } }) })
afterEach(() => vi.unstubAllGlobals())
describe("qualification queue state", () => {
  it("freezes the full uncertain request and retries the identical payload", async () => {
    h.submit.mockResolvedValueOnce({ ok: false, code: "uncertain" })
    click("Queue for approval")
    await vi.waitFor(() => expect(button("Retry this same request")).toBeDefined())
    const body = render().find(n => n.props.id === "queue-body")!
    expect(body.props.disabled).toBe(true)
    // Even a stale event cannot change the submitted request used for retry.
    ;(body.props.onChange as (e: unknown) => void)({ target: { value: "Changed text" } })
    h.submit.mockResolvedValueOnce({ ok: true, status: "already_queued", actionId: id })
    click("Retry this same request")
    await vi.waitFor(() => expect(h.submit).toHaveBeenCalledTimes(2))
    expect(h.submit.mock.calls[1][0]).toEqual(h.submit.mock.calls[0][0])
  })
  it("synchronously refuses duplicate clicks while the action is outstanding", () => {
    h.submit.mockImplementation(() => new Promise(() => {}))
    const clickOld = button("Queue for approval").props.onClick as () => void
    clickOld(); clickOld()
    expect(h.submit).toHaveBeenCalledOnce()
  })
  it("keeps a stale form locked while requesting a full reload", async () => {
    h.submit.mockResolvedValue({ ok: false, code: "qualification_changed" })
    click("Queue for approval")
    await vi.waitFor(() => expect(button("Reload and start over")).toBeDefined())
    click("Reload and start over")
    expect(h.reload).toHaveBeenCalledOnce()
    expect(render().find(n => n.props.id === "queue-body")?.props.disabled).toBe(true)
    expect(button("Queue for approval")).toBeUndefined()
    expect(h.submit).toHaveBeenCalledOnce()
  })
})
