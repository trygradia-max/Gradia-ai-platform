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
  it("asks for the first missing item in a fixed order, one at a time", () => {
    const fields = filled()
    const steps: [string, () => Record<string, unknown>][] = [
      ["service", () => ({ fields: unknown })],
      ["vehicle", () => ({ fields: { ...unknown, service: fields.service }, identity: { ...linked, vehicle_id: null, vehicle_status: "unresolved", vehicle: null } })],
      ["timing", () => ({ fields: { ...unknown, service: fields.service } })],
      ["vehicle_condition", () => ({ fields: { ...unknown, service: fields.service, timing: fields.timing } })],
      ["location", () => ({ fields: { ...fields, location: unknown.location, constraints: unknown.constraints } })],
      ["constraints", () => ({ fields: { ...fields, constraints: unknown.constraints } })],
    ]
    for (const [target, patch] of steps) {
      const next = proposeNextQualificationQuestion(record(patch()))
      expect(next).toMatchObject({ kind: "question", delivery: "none", target, question_id: null, basis })
      expect(next.kind === "question" && next.text.length > 0 && next.text.length <= 500).toBe(true)
    }
  })
  it("treats a vehicle link that needs review as missing", () => {
    expect(proposeNextQualificationQuestion(record({ identity: { ...linked, vehicle_status: "needs_review", vehicle: null } }))).toMatchObject({ target: "vehicle" })
  })
  it("starts with the service when nothing has been recorded", () => {
    const fresh = record({ revision: 0, review_state: "not_started", recorded_review_state: null, fields: unknown, updated_at: null, updated_by: null })
    expect(proposeNextQualificationQuestion(fresh)).toMatchObject({ target: "service", basis: { ...basis, revision: 0 } })
  })
  it("does not treat a known empty constraint list as unasked", () => {
    expect(proposeNextQualificationQuestion(record())).toEqual({ kind: "none", reason: "complete" })
  })
  it("offers the reviewer's own open question verbatim once the fields are known", () => {
    const open_questions = [
      { id, text: "Was it repainted?", status: "answered", answer: "No" },
      { id: other, text: "Is the vehicle garage kept?", status: "open", answer: null },
    ]
    expect(proposeNextQualificationQuestion(record({ open_questions }))).toEqual({
      kind: "question", delivery: "none", target: "open_question", question_id: other, text: "Is the vehicle garage kept?", basis,
    })
    expect(proposeNextQualificationQuestion(record({ open_questions, fields: { ...filled(), timing: unknown.timing } }))).toMatchObject({ target: "timing" })
  })
  it("proposes nothing while identity is unresolved or the record is not current", () => {
    const review = { ...linked, state: "identity_review", customer_id: null, customer_name: null, vehicle_id: null, vehicle_status: "unresolved", vehicle: null }
    expect(proposeNextQualificationQuestion(record({ identity: review, fields: unknown }))).toEqual({ kind: "none", reason: "identity_review_required" })
    for (const reason of ["customer_changed", "vehicle_changed", "new_evidence", "identity_in_review"])
      expect(proposeNextQualificationQuestion(record({ review_state: "needs_review", review_reasons: [reason], fields: unknown }))).toEqual({ kind: "none", reason: "needs_review" })
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
