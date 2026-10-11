import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), user: vi.fn(), client: vi.fn() }))
vi.mock("@/lib/shop", () => ({ requireUser: mocks.user }))
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.client }))
import { updateLeadQualification } from "@/app/actions/lead-qualification"
import { loadLeadQualification, loadLeadQualificationHistory, loadLeadQualifications } from "@/lib/data/lead-qualification"
import {
  qualificationCommandSchema, qualificationFieldsSchema, qualificationQuestionsSchema, qualificationRefusal,
  unknownQualificationFields, type QualificationFields,
} from "@/lib/lead-qualification"
import { teamCommandSchema } from "@/lib/team-permissions"

const id = "00000000-0000-4000-8000-000000000001", other = "00000000-0000-4000-8000-000000000002"
const known = { status: "reported" as const, source: "customer" as const, evidence_revision: null }
const filled = (): QualificationFields => ({
  service: { ...known, service_id: id, text: "Full detail" },
  vehicle_condition: { ...known, text: "Light swirl marks" },
  timing: { ...known, earliest: "2026-10-20", latest: "2026-10-31", text: null },
  location: { ...known, type: "mobile", area: "Fictional north side" },
  constraints: { ...known, items: ["Gate code needed"] },
})
const input = () => ({ shopId: id, workflowId: id, commandId: other, revision: 0, customerId: id, vehicleId: null, reviewState: "in_progress", fields: filled(), openQuestions: [] })
const snapshot = (patch: Record<string, unknown> = {}) => ({
  workflow_id: id, channel: "synthetic", last_received_at: "2026-10-09T00:00:00+00:00",
  identity: { state: "identity_linked", customer_id: id, customer_name: "Fictional Lead", vehicle_id: null, vehicle_status: "unresolved", vehicle: null, evidence_revision: 1 },
  revision: 1, review_state: "in_progress", recorded_review_state: "in_progress", review_reasons: [], fields: filled(), open_questions: [],
  missing: ["vehicle"], completeness: "incomplete", updated_at: "2026-10-09T00:00:01+00:00",
  updated_by: { actor_id: id, label: "Owner", role: "owner" }, can_update: true, ...patch,
})
beforeEach(() => { vi.clearAllMocks(); mocks.user.mockResolvedValue({ id }); mocks.client.mockResolvedValue({ rpc: mocks.rpc }) })

describe("qualification document rules mirror the database", () => {
  it("accepts the all-unknown starting document and a fully known one", () => {
    expect(qualificationFieldsSchema.safeParse(unknownQualificationFields()).success).toBe(true)
    expect(qualificationFieldsSchema.safeParse(filled()).success).toBe(true)
  })
  it("never lets an absent or empty answer stand in for a known one", () => {
    const f = filled(), u = unknownQualificationFields()
    const bad: unknown[] = [
      { service: f.service, timing: f.timing, location: f.location, constraints: f.constraints },
      { ...f, extra: f.service },
      { ...f, service: { ...f.service, service_id: null, text: null } },
      { ...f, service: { ...u.service, text: "Detail" } },
      { ...f, service: { ...f.service, source: null } },
      { ...f, service: { ...f.service, status: "complete" } },
      { ...f, service: { ...f.service, source: "model" } },
      { ...f, service: { ...f.service, source: "intake" } },
      { ...f, service: { ...f.service, evidence_revision: 1 } },
      { ...f, service: { ...f.service, price_cents: 100 } },
      { ...f, vehicle_condition: { ...f.vehicle_condition, text: null } },
      { ...f, vehicle_condition: { ...f.vehicle_condition, text: " padded " } },
      { ...f, vehicle_condition: { ...f.vehicle_condition, text: "hidden\u0001control" } },
      { ...f, timing: { ...f.timing, earliest: "2026-02-31" } },
      { ...f, timing: { ...f.timing, earliest: "2026-11-02", latest: "2026-11-01" } },
      { ...f, timing: { ...f.timing, earliest: null, latest: null } },
      { ...f, location: { ...f.location, type: null } },
      { ...f, location: { ...u.location, area: "Somewhere" } },
      { ...f, constraints: { ...u.constraints, items: ["Gate code needed"] } },
      { ...f, constraints: { ...f.constraints, items: Array(11).fill("Fictional") } },
    ]
    for (const doc of bad) expect(qualificationFieldsSchema.safeParse(doc).success, JSON.stringify(doc).slice(0, 140)).toBe(false)
    // A known empty list is a real answer: "no constraints".
    expect(qualificationFieldsSchema.safeParse({ ...f, constraints: { ...f.constraints, items: [] } }).success).toBe(true)
  })
  it("questions need unique ids and an answer exactly when answered", () => {
    const q = { id, text: "Garage kept?", status: "open", answer: null }
    expect(qualificationQuestionsSchema.safeParse([q, { ...q, id: other, status: "answered", answer: "Yes" }, { ...q, id: "00000000-0000-4000-8000-000000000003", status: "dropped" }]).success).toBe(true)
    for (const bad of [[q, q], [{ ...q, answer: "Early" }], [{ ...q, status: "answered" }], [{ ...q, status: "closed" }], [{ ...q, id: "one" }], Array(21).fill(q)])
      expect(qualificationQuestionsSchema.safeParse(bad).success).toBe(false)
  })
  it("the command accepts no caller-supplied actor, role, shop authority or extra effect", () => {
    expect(qualificationCommandSchema.safeParse(input()).success).toBe(true)
    for (const patch of [{ actorId: id }, { actorRole: "owner" }, { reviewState: "complete" }, { revision: -1 }, { customerId: null }, { sendQuote: true }, { consent: true }])
      expect(qualificationCommandSchema.safeParse({ ...input(), ...patch }).success).toBe(false)
  })
})

describe("database refusals map to contract outcomes without leaking database text", () => {
  it.each([
    [{ code: "22023", details: "fields.timing.latest", message: "private" }, { ok: false, code: "invalid", field: "fields.timing.latest" }],
    [{ code: "22023", details: "DROP TABLE; --", message: "private" }, { ok: false, code: "invalid", field: "command" }],
    [{ code: "42501", details: null, message: "private" }, { ok: false, code: "forbidden" }],
    [{ code: "42501", details: "customer_unavailable" }, { ok: false, code: "reference_unavailable", reference: "customer" }],
    [{ code: "42501", details: "vehicle_unavailable" }, { ok: false, code: "reference_unavailable", reference: "vehicle" }],
    [{ code: "42501", details: "service_unavailable" }, { ok: false, code: "reference_unavailable", reference: "service" }],
    [{ code: "PT409", details: "revision_conflict" }, { ok: false, code: "revision_conflict" }],
    [{ code: "PT409", details: "command_conflict" }, { ok: false, code: "command_conflict" }],
    [{ code: "PT409", details: "identity_review_required" }, { ok: false, code: "identity_review_required" }],
    [{ code: "PT409", details: "customer_changed" }, { ok: false, code: "customer_changed" }],
    [{ code: "PT409", details: "vehicle_changed" }, { ok: false, code: "vehicle_changed" }],
    [{ code: "PT409", details: "something_else" }, { ok: false, code: "not_confirmed" }],
    [{ code: "P0001", details: "private", message: "Injected failure" }, { ok: false, code: "not_confirmed" }],
    [{}, { ok: false, code: "not_confirmed" }],
  ])("%#", (error, expected) => {
    expect(qualificationRefusal(error)).toEqual(expected)
  })
})

describe("update action", () => {
  it("validates before any session or database work and names the failing field", async () => {
    const f = filled()
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ workflowId: "bad" }, "command"], [{ actorId: id }, "command"], [{ revision: -1 }, "command"],
      [{ fields: { ...f, timing: { ...f.timing, earliest: "soon" } } }, "fields.timing.earliest"],
      [{ fields: { ...f, constraints: { ...f.constraints, items: ["ok", ""] } } }, "fields.constraints.items"],
      [{ openQuestions: [{ id: "one", text: "Q", status: "open", answer: null }] }, "open_questions.id"],
    ]
    for (const [patch, field] of cases) expect(await updateLeadQualification({ ...input(), ...patch })).toEqual({ ok: false, code: "invalid", field })
    expect(mocks.user).not.toHaveBeenCalled(); expect(mocks.client).not.toHaveBeenCalled()
  })
  it("sends one session RPC with exactly the reviewed binding and returns the verified record", async () => {
    mocks.rpc.mockResolvedValue({ data: { ...snapshot(), status: "recorded" }, error: null })
    const result = await updateLeadQualification(input())
    expect(result).toMatchObject({ ok: true, status: "recorded", qualification: { revision: 1, review_state: "in_progress" } })
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("update_lead_qualification", {
      p_shop: id, p_workflow: id, p_command: other, p_revision: 0, p_customer: id, p_vehicle: null,
      p_review_state: "in_progress", p_fields: filled(), p_open_questions: [],
    })
    mocks.rpc.mockResolvedValue({ data: { ...snapshot(), status: "already_recorded" }, error: null })
    expect(await updateLeadQualification(input())).toMatchObject({ ok: true, status: "already_recorded" })
  })
  it.each([
    [{ data: null, error: { code: "PT409", details: "revision_conflict", message: "private" } }, { ok: false, code: "revision_conflict" }],
    [{ data: null, error: { code: "42501", details: null, message: "private" } }, { ok: false, code: "forbidden" }],
    [{ data: { ...snapshot(), status: "sent" }, error: null }, { ok: false, code: "not_confirmed" }],
    [{ data: { ...snapshot({ workflow_id: other }), status: "recorded" }, error: null }, { ok: false, code: "not_confirmed" }],
    [{ data: { status: "recorded" }, error: null }, { ok: false, code: "not_confirmed" }],
    [{ data: null, error: null }, { ok: false, code: "not_confirmed" }],
  ])("fails closed on a refusal or an unverifiable acknowledgement %#", async (reply, expected) => {
    mocks.rpc.mockResolvedValue(reply)
    const result = await updateLeadQualification(input())
    expect(result).toEqual(expected); expect(JSON.stringify(result)).not.toContain("private")
  })
  it("reports an uncertain result once and never retries", async () => {
    mocks.rpc.mockRejectedValue(new Error("private network detail"))
    expect(await updateLeadQualification(input())).toEqual({ ok: false, code: "uncertain" }); expect(mocks.rpc).toHaveBeenCalledTimes(1)
  })
})

describe("read loaders", () => {
  const db = (reply: unknown) => ({ rpc: vi.fn(async () => reply) }) as unknown as SupabaseClient
  it("validate selectors before any lookup", async () => {
    const client = db({ data: snapshot(), error: null })
    expect(await loadLeadQualification(client, "bad", id)).toEqual({ ok: false })
    expect(await loadLeadQualifications(client, id, -1)).toEqual({ ok: false })
    expect(await loadLeadQualificationHistory(client, id, id, 100001)).toEqual({ ok: false })
    expect(client.rpc).not.toHaveBeenCalled()
  })
  it("never report a failed, denied or malformed read as an empty qualification", async () => {
    for (const reply of [{ data: null, error: { code: "42501" } }, { data: null, error: null }, { data: { ...snapshot(), review_state: "done" }, error: null }, { data: { ...snapshot(), fields: {} }, error: null }])
      expect(await loadLeadQualification(db(reply), id, id)).toEqual({ ok: false })
    const thrown = { rpc: vi.fn(async () => { throw new Error("private") }) } as unknown as SupabaseClient
    expect(await loadLeadQualification(thrown, id, id)).toEqual({ ok: false })
    expect(await loadLeadQualifications(db({ data: { items: [{ workflow_id: id }], can_update: true }, error: null }), id)).toEqual({ ok: false })
    expect(await loadLeadQualificationHistory(db({ data: { revision: 0 }, error: null }), id, id)).toEqual({ ok: false })
  })
  it("return verified data for well-formed replies", async () => {
    expect(await loadLeadQualification(db({ data: snapshot(), error: null }), id, id)).toMatchObject({ ok: true, data: { revision: 1 } })
    const { fields: _fields, open_questions: _questions, can_update: _can, ...summary } = snapshot()
    void _fields; void _questions; void _can
    expect(await loadLeadQualifications(db({ data: { items: [summary], can_update: false }, error: null }), id)).toMatchObject({ ok: true, data: { can_update: false } })
    expect(await loadLeadQualificationHistory(db({ data: { revision: 0, items: [] }, error: null }), id, id)).toEqual({ ok: true, data: { revision: 0, items: [] } })
  })
})

it("lead qualification is a manager-only grant that requires the customer view grant", () => {
  const member = { operation: "member", shopId: id, memberId: id, active: true }
  expect(teamCommandSchema.safeParse({ ...member, role: "manager", capabilities: ["crm.read", "leads.qualify"] }).success).toBe(true)
  expect(teamCommandSchema.safeParse({ ...member, role: "manager", capabilities: ["leads.qualify"] }).success).toBe(false)
  expect(teamCommandSchema.safeParse({ ...member, role: "staff", capabilities: ["crm.read", "leads.qualify"] }).success).toBe(false)
})
