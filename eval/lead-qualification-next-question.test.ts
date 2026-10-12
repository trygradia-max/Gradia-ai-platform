import { describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { readFileSync } from "node:fs"
import { loadNextQualificationQuestion } from "@/lib/data/lead-qualification"
import {
  proposeNextQualificationQuestion, qualificationSchema, unknownQualificationFields,
  type LeadQualification, type QualificationFields,
} from "@/lib/lead-qualification"

const id = "00000000-0000-4000-8000-000000000001", other = "00000000-0000-4000-8000-000000000002"
const known = { status: "reported" as const, source: "customer" as const, evidence_revision: null }
const filled = (): QualificationFields => ({
  service: { ...known, service_id: id, text: "Full detail" },
  vehicle_condition: { ...known, text: "Light swirl marks" },
  timing: { ...known, earliest: "2026-10-20", latest: "2026-10-31", text: null },
  location: { ...known, type: "shop", area: null },
  constraints: { ...known, items: [] },
})
const linked = { state: "identity_linked", customer_id: id, customer_name: "Fictional Lead", vehicle_id: id, vehicle_status: "confirmed", vehicle: { year: 2021, make: "Fictional", model: "Coupe", color: null }, evidence_revision: 3 }
const record = (patch: Record<string, unknown> = {}): LeadQualification => qualificationSchema.parse({
  workflow_id: id, channel: "synthetic", last_received_at: "2026-10-09T00:00:00+00:00", identity: linked,
  revision: 4, review_state: "in_progress", recorded_review_state: "in_progress", review_reasons: [], fields: filled(), open_questions: [],
  missing: [], completeness: "complete", updated_at: "2026-10-09T00:00:01+00:00",
  updated_by: { actor_id: id, label: "Owner", role: "owner" }, can_update: true, ...patch,
})
const unknown = unknownQualificationFields()
const basis = { workflow_id: id, revision: 4, evidence_revision: 3 }

describe("next qualification question is a suggestion derived from the record", () => {
  it("asks for the first unknown field in the documented order, one at a time", () => {
    const fields = filled()
    const steps: [string, QualificationFields][] = [
      ["service", unknown],
      ["vehicle_condition", { ...unknown, service: fields.service }],
      ["timing", { ...unknown, service: fields.service, vehicle_condition: fields.vehicle_condition }],
      ["location", { ...fields, location: unknown.location, constraints: unknown.constraints }],
      ["constraints", { ...fields, constraints: unknown.constraints }],
    ]
    for (const [target, value] of steps) {
      const next = proposeNextQualificationQuestion(record({ fields: value }))
      expect(next).toMatchObject({ kind: "question", delivery: "none", target, question_id: null, basis })
      expect(next.kind === "question" && next.text.length > 0 && next.text.length <= 500).toBe(true)
    }
  })
  it("starts with the service when nothing has been recorded", () => {
    const fresh = record({ revision: 0, review_state: "not_started", recorded_review_state: null, fields: unknown, updated_at: null, updated_by: null })
    expect(proposeNextQualificationQuestion(fresh)).toMatchObject({ target: "service", basis: { ...basis, revision: 0 } })
  })
  it("treats a known empty constraint list as an answer, and complete as nothing more", () => {
    expect(proposeNextQualificationQuestion(record())).toEqual({ kind: "none", reason: "complete", basis })
    expect(proposeNextQualificationQuestion(record({ fields: { ...filled(), constraints: { ...known, status: "confirmed", source: "staff", items: [] } } }))).toMatchObject({ kind: "none" })
  })
  it("offers the reviewer's own open question first, verbatim, and skips answered and dropped ones", () => {
    const third = "00000000-0000-4000-8000-000000000003"
    const open_questions = [
      { id, text: "Was it repainted?", status: "answered", answer: "No" },
      { id: third, text: "Any pets in the car?", status: "dropped", answer: null },
      { id: other, text: "Is the vehicle garage kept?", status: "open", answer: null },
    ]
    const expected = { kind: "question", delivery: "none", target: "open_question", question_id: other, text: "Is the vehicle garage kept?", basis }
    expect(proposeNextQualificationQuestion(record({ open_questions }))).toEqual(expected)
    expect(proposeNextQualificationQuestion(record({ open_questions, fields: unknown }))).toEqual(expected)
    const settled = open_questions.slice(0, 2)
    expect(proposeNextQualificationQuestion(record({ open_questions: settled }))).toMatchObject({ kind: "none" })
    expect(proposeNextQualificationQuestion(record({ open_questions: settled, fields: { ...filled(), timing: unknown.timing } }))).toMatchObject({ target: "timing" })
  })
  it("returns the review requirement, not a question, while identity is unresolved or evidence is stale", () => {
    const review = { ...linked, state: "identity_review", customer_id: null, customer_name: null, vehicle_id: null, vehicle_status: "unresolved", vehicle: null }
    expect(proposeNextQualificationQuestion(record({ identity: review, fields: unknown }))).toEqual({ kind: "review_required", reasons: ["identity_in_review"], basis })
    expect(proposeNextQualificationQuestion(record({ identity: review, review_state: "needs_review", review_reasons: ["identity_in_review", "new_evidence"] })))
      .toEqual({ kind: "review_required", reasons: ["identity_in_review", "new_evidence"], basis })
    for (const reason of ["customer_changed", "vehicle_changed", "new_evidence"])
      expect(proposeNextQualificationQuestion(record({ review_state: "needs_review", review_reasons: [reason], fields: unknown, open_questions: [{ id, text: "Open?", status: "open", answer: null }] })))
        .toEqual({ kind: "review_required", reasons: [reason], basis })
  })
  it("never asks the customer for a vehicle link; it reports it once nothing else is missing", () => {
    const identity = { ...linked, vehicle_id: null, vehicle_status: "unresolved", vehicle: null }
    expect(proposeNextQualificationQuestion(record({ identity, fields: unknown }))).toMatchObject({ kind: "question", target: "service" })
    expect(proposeNextQualificationQuestion(record({ identity }))).toEqual({ kind: "review_required", reasons: ["vehicle_unlinked"], basis })
  })
  it("is deterministic and leaves the record untouched", () => {
    const q = record({ fields: unknown }), before = JSON.stringify(q)
    expect(proposeNextQualificationQuestion(q)).toEqual(proposeNextQualificationQuestion(q))
    expect(JSON.stringify(q)).toBe(before)
  })
})

describe("loading the suggestion reads once and writes nothing", () => {
  it("derives the suggestion from one verified read and calls no other operation", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: record({ fields: unknown }), error: null })
    const from = vi.fn()
    const result = await loadNextQualificationQuestion({ rpc, from } as unknown as SupabaseClient, id, id)
    expect(result).toMatchObject({ ok: true, data: { kind: "question", target: "service", delivery: "none" } })
    expect(rpc.mock.calls).toEqual([["read_lead_qualification", { p_shop: id, p_workflow: id }]])
    expect(from).not.toHaveBeenCalled()
  })
  it("selects by the caller's shop and workflow and repeats identically", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: record({ fields: unknown }), error: null })
    const db = { rpc } as unknown as SupabaseClient
    expect(await loadNextQualificationQuestion(db, other, id)).toEqual(await loadNextQualificationQuestion(db, other, id))
    expect(rpc.mock.calls).toEqual(Array(2).fill(["read_lead_qualification", { p_shop: other, p_workflow: id }]))
  })
  it("never reports a failed, refused or malformed read as nothing to ask", async () => {
    for (const reply of [{ data: null, error: { code: "42501" } }, { data: { workflow_id: id }, error: null }]) {
      const rpc = vi.fn().mockResolvedValue(reply)
      expect(await loadNextQualificationQuestion({ rpc } as unknown as SupabaseClient, id, id)).toEqual({ ok: false })
    }
    const rpc = vi.fn().mockRejectedValue(new Error("offline"))
    expect(await loadNextQualificationQuestion({ rpc } as unknown as SupabaseClient, id, id)).toEqual({ ok: false })
    expect(await loadNextQualificationQuestion({ rpc } as unknown as SupabaseClient, "not-an-id", id)).toEqual({ ok: false })
  })
  it("has no path to a message, an approval, a model or a provider", () => {
    const source = ["src/lib/lead-qualification.ts", "src/lib/data/lead-qualification.ts"].map((file) => readFileSync(file, "utf8")).join("\n")
    expect(source).not.toMatch(/pending_actions|send_sms|send_email|twilio|aurinko|ai-service|anthropic|drafter|\.insert\(|\.update\(|\.upsert\(/i)
    expect(source.match(/\.rpc\("([a-z_]+)"/g)).toEqual(['.rpc("read_lead_qualification"', '.rpc("list_lead_qualifications"', '.rpc("read_lead_qualification_history"'])
  })
})
