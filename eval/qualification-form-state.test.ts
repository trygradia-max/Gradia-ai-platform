import { beforeEach, describe, expect, it, vi } from "vitest"
import { isValidElement, type ReactElement } from "react"
import { QualificationForm } from "@/components/gradia/qualification-form"
import { QualificationReview } from "@/components/gradia/qualification-review"
import { qualificationSchema, unknownQualificationFields } from "@/lib/lead-qualification"

const harness = vi.hoisted(() => ({ state: [] as unknown[], cursor: 0, submit: vi.fn(), refresh: vi.fn() }))
vi.mock("react", async (load) => ({
  ...await load<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = harness.cursor++
    if (!(index in harness.state)) harness.state[index] = initial
    return [harness.state[index], (next: unknown) => {
      harness.state[index] = typeof next === "function" ? next(harness.state[index]) : next
    }]
  },
  useTransition: () => [false, (fn: () => Promise<void>) => fn()],
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: harness.refresh }) }))
vi.mock("@/app/actions/lead-qualification", () => ({ updateLeadQualification: harness.submit }))
const id = "00000000-0000-4000-8000-000000000001"
const record = () => qualificationSchema.parse({
  workflow_id: id, channel: "synthetic", last_received_at: "2026-10-13T00:00:00+00:00",
  identity: { state: "identity_linked", customer_id: id, customer_name: "Demo", vehicle_id: null, vehicle_status: "unresolved", vehicle: null, evidence_revision: 1 },
  revision: 0, review_state: "not_started", recorded_review_state: null, review_reasons: [],
  fields: unknownQualificationFields(), open_questions: [], missing: [], completeness: "incomplete",
  updated_at: null, updated_by: null, can_update: true,
})
function render() {
  harness.cursor = 0
  return QualificationForm({ shopId: id, commandId: id, qualification: record(), services: [] })
}
function elements(node: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<Record<string, unknown>>(node)) return []
  return [node, ...elements(node.props.children)]
}
async function save() { await render().props.onSubmit({ preventDefault() {} }) }
beforeEach(() => { harness.state = []; harness.cursor = 0; vi.clearAllMocks() })
describe("qualification save state", () => {
  it.each(["response", "transport"])("holds edits and retries the identical submission after uncertain %s", async (kind) => {
    if (kind === "transport") harness.submit.mockRejectedValueOnce(new Error("lost response"))
    else harness.submit.mockResolvedValueOnce({ ok: false, code: "uncertain" })
    await save()
    const controls = elements(render()).filter((node) => "disabled" in node.props)
    expect(controls.filter((node) => node.props.type !== "submit").every((node) => node.props.disabled === true)).toBe(true)
    expect(controls.find((node) => node.props.type === "submit")?.props.disabled).toBe(false)
    harness.submit.mockResolvedValueOnce({ ok: true, status: "already_recorded" })
    await save()
    expect(harness.submit.mock.calls[1][0]).toEqual(harness.submit.mock.calls[0][0])
    expect(harness.refresh).toHaveBeenCalledOnce()
    await save()
    expect(harness.submit).toHaveBeenCalledTimes(2)
  })
  it("retains the draft and refuses further submissions after revision conflict", async () => {
    harness.submit.mockResolvedValueOnce({ ok: false, code: "revision_conflict" })
    await save()
    expect(elements(render()).some((node) => node.props.type === "submit")).toBe(false)
    await save()
    expect(harness.submit).toHaveBeenCalledOnce()
  })
  it("remounts the editor only when the server record changes", () => {
    const q = record()
    const editor = (revision: number, evidence: number, commandId: string) => elements(QualificationReview({
      shopId: id, commandId, services: [], history: null,
      result: { ok: true, data: { ...q, revision, identity: { ...q.identity, evidence_revision: evidence } } },
    })).find((node) => node.type === QualificationForm)!.key
    expect(editor(0, 1, id)).toBe(editor(0, 1, "another-command"))
    expect(editor(1, 1, id)).not.toBe(editor(0, 1, id))
    expect(editor(0, 2, id)).not.toBe(editor(0, 1, id))
  })
})
