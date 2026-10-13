import { describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { QualificationLockedNotice } from "@/components/gradia/qualification-form"
import { QualificationList } from "@/components/gradia/qualification-list"
import { QualificationReview } from "@/components/gradia/qualification-review"
import { unknownQualificationFields, type LeadQualification } from "@/lib/lead-qualification"
import { qualificationSaveOutcome } from "@/lib/qualification-review"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

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

describe("qualification review presentation", () => {
  it("renders unknown fields as unknown and does not coerce them to yes, no, or empty defaults", () => {
    const html = renderToStaticMarkup(
      createElement(QualificationReview, {
        shopId: id,
        commandId: other,
        services: [],
        history: { ok: true, data: { revision: 0, items: [] } },
        result: { ok: true, data: record() },
      })
    )
    expect(html).toContain("Unknown")
    expect(html).toContain("No source — this value is unknown.")
    expect(html).toContain("Unknown — nobody has asked. This is not “no constraints”.")
    expect(html).not.toContain("Yes")
    expect(html).not.toContain("No constraints")
    expect(html).not.toContain('type="checkbox"')
  })

  it("shows provenance for a known field", () => {
    const fields = unknownQualificationFields()
    fields.service = {
      status: "reported",
      source: "intake",
      evidence_revision: 2,
      service_id: null,
      text: "Ceramic coating",
    }
    const html = renderToStaticMarkup(
      createElement(QualificationReview, {
        shopId: id,
        commandId: other,
        services: [],
        history: { ok: true, data: { revision: 1, items: [] } },
        result: {
          ok: true,
          data: record({
            revision: 1,
            review_state: "in_progress",
            recorded_review_state: "in_progress",
            fields,
            missing: ["vehicle_condition", "timing", "location", "constraints"],
            updated_at: "2026-10-09T16:00:00+00:00",
            updated_by: { actor_id: id, label: "Owner", role: "owner" },
          }),
        },
      })
    )
    expect(html).toContain("Ceramic coating")
    expect(html).toContain("Source: Intake submission · evidence revision 2")
    expect(html).toContain("Owner (owner)")
    expect(html).toContain("Unknown")
  })

  it("shows stale records with review reasons and does not call them current", () => {
    const html = renderToStaticMarkup(
      createElement(QualificationReview, {
        shopId: id,
        commandId: other,
        services: [],
        history: { ok: true, data: { revision: 1, items: [] } },
        result: {
          ok: true,
          data: record({
            revision: 1,
            review_state: "needs_review",
            recorded_review_state: "reviewed",
            review_reasons: ["new_evidence", "vehicle_changed"],
            updated_at: "2026-10-09T16:00:00+00:00",
            updated_by: { actor_id: id, label: "Owner", role: "owner" },
          }),
        },
      })
    )
    expect(html).toContain("This qualification is stale.")
    expect(html).toContain("A new submission arrived after this record was saved.")
    expect(html).toContain("The vehicle link or details changed since this record was saved.")
    expect(html).toContain("Needs review")
  })

  it("requires a fresh load after a revision conflict and does not offer a silent overwrite", () => {
    const html = renderToStaticMarkup(
      createElement(QualificationLockedNotice, {
        result: { ok: false, code: "revision_conflict" },
      })
    )
    expect(html).toContain("Someone saved this record since you loaded it.")
    expect(html).toContain("Do not retry this save")
    expect(html).not.toContain("Save qualification")
    const copy = qualificationSaveOutcome({ ok: false, code: "revision_conflict" })
    expect(copy.reload).toBe(true)
    expect(copy.retrySame).toBe(false)
  })

  it("keeps staff and read-only managers from seeing save controls", () => {
    const html = renderToStaticMarkup(
      createElement(QualificationReview, {
        shopId: id,
        commandId: other,
        services: [],
        history: { ok: true, data: { revision: 0, items: [] } },
        result: { ok: true, data: record({ can_update: false }) },
      })
    )
    expect(html).toContain("Read only")
    expect(html).toContain("Saving is unavailable")
    expect(html).not.toContain("Save qualification")
    expect(html).not.toContain("<form")
  })

  it("does not treat a failed qualification load as an empty record", () => {
    const html = renderToStaticMarkup(
      createElement(QualificationReview, {
        shopId: id,
        commandId: other,
        services: [],
        history: { ok: false },
        result: { ok: false },
      })
    )
    expect(html).toContain('role="alert"')
    expect(html).toContain("Qualification could not be loaded")
    expect(html).toContain("This does not mean there is no record")
    expect(html).not.toContain("Not started")
    expect(html).not.toContain("No qualification records")
  })

  it("shows list permission copy and stale cards without inventing empty-looking answers", () => {
    const failed = renderToStaticMarkup(
      createElement(QualificationList, { shopId: id, result: { ok: false } })
    )
    expect(failed).toContain("Qualification could not be loaded")
    expect(failed).not.toContain("No qualification records")
    const html = renderToStaticMarkup(
      createElement(QualificationList, {
        shopId: id,
        result: {
          ok: true,
          data: {
            can_update: false,
            items: [
              {
                workflow_id: id,
                channel: "website_form",
                last_received_at: "2026-10-09T15:02:11+00:00",
                identity: {
                  state: "identity_linked",
                  customer_id: id,
                  customer_name: "Fictional Lead",
                  vehicle_id: null,
                  vehicle_status: "unresolved",
                  vehicle: null,
                  evidence_revision: 1,
                },
                revision: 1,
                review_state: "needs_review",
                recorded_review_state: "in_progress",
                review_reasons: ["customer_changed"],
                missing: ["timing"],
                completeness: "incomplete",
                updated_at: "2026-10-09T16:00:00+00:00",
                updated_by: { actor_id: id, label: "Morgan", role: "manager" },
              },
            ],
          },
        },
      })
    )
    expect(html).toContain("Your grant is read-only")
    expect(html).toContain("View qualification")
    expect(html).not.toContain("Review qualification")
    expect(html).toContain("Stale:")
    expect(html).toContain("The linked customer changed since this record was saved.")
    expect(html).toContain(`/intake/${id}?shop=${id}#qualification`)
  })
})
