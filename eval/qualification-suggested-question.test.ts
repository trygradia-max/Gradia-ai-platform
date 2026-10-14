import { describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import {
  QualificationNextQuestion,
  QualificationReview,
} from "@/components/gradia/qualification-review"
import {
  unknownQualificationFields,
  type LeadQualification,
} from "@/lib/lead-qualification"

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

function reviewHtml(data: LeadQualification) {
  return renderToStaticMarkup(
    createElement(QualificationReview, {
      shopId: id,
      commandId: other,
      services: [],
      history: { ok: true, data: { revision: 0, items: [] } },
      result: { ok: true, data },
    })
  )
}

describe("suggested next question card is read-only and accurate", () => {
  it("suggests the first unknown field with its basis and no send control", () => {
    const html = renderToStaticMarkup(
      createElement(QualificationNextQuestion, { qualification: record() })
    )
    expect(html).toContain("Suggested next question")
    expect(html).toContain("Which service are you interested in?")
    expect(html).toContain("About: Service.")
    expect(html).toContain("Derived from revision 0")
    expect(html).toContain("evidence revision 1")
    expect(html).toContain("Read-only suggestion")
    expect(html).toContain("nothing is sent")
    expect(html).not.toContain("<button")
    expect(html).not.toContain("<form")
    expect(html).not.toContain("Send")
  })

  it("repeats the reviewer open question verbatim instead of a field question", () => {
    const html = renderToStaticMarkup(
      createElement(QualificationNextQuestion, {
        qualification: record({
          open_questions: [
            { id: other, text: "Is the vehicle garage kept?", status: "open", answer: null },
          ],
        }),
      })
    )
    expect(html).toContain("Is the vehicle garage kept?")
    expect(html).toContain("About: Open question.")
    expect(html).not.toContain("Which service are you interested in?")
  })

  it("shows review-required reasons and no customer-facing question when stale", () => {
    const html = renderToStaticMarkup(
      createElement(QualificationNextQuestion, {
        qualification: record({
          revision: 1,
          review_state: "needs_review",
          recorded_review_state: "reviewed",
          review_reasons: ["new_evidence", "vehicle_changed"],
        }),
      })
    )
    expect(html).toContain("Suggested next question")
    expect(html).toContain("Review required")
    expect(html).toContain("A new submission arrived after this record was saved.")
    expect(html).toContain("The vehicle link or details changed since this record was saved.")
    expect(html).toContain("Derived from revision 1")
    expect(html).not.toContain("Which service are you interested in?")
    expect(html).not.toContain("<button")
  })

  it("reports an unconfirmed vehicle link for intake review without asking the customer", () => {
    const filled = record()
    const known = { status: "reported" as const, source: "customer" as const, evidence_revision: null }
    filled.fields = {
      service: { ...known, service_id: id, text: "Full detail" },
      vehicle_condition: { ...known, text: "Light swirl marks" },
      timing: { ...known, earliest: "2026-10-20", latest: "2026-10-31", text: null },
      location: { status: "confirmed" as const, source: "staff" as const, evidence_revision: null, type: "shop" as const, area: null },
      constraints: { ...known, items: [] },
    }
    filled.identity = {
      ...filled.identity,
      vehicle_id: null,
      vehicle_status: "unresolved",
      vehicle: null,
    }
    filled.missing = []
    filled.completeness = "incomplete"
    const html = renderToStaticMarkup(
      createElement(QualificationNextQuestion, { qualification: filled })
    )
    expect(html).toContain("Review required")
    expect(html).toContain("Vehicle is not confirmed.")
    expect(html).toContain("customer is never asked")
  })

  it("states complete without claiming quote or booking readiness", () => {
    const known = { status: "reported" as const, source: "customer" as const, evidence_revision: null }
    const html = renderToStaticMarkup(
      createElement(QualificationNextQuestion, {
        qualification: record({
          fields: {
            service: { ...known, service_id: id, text: "Full detail" },
            vehicle_condition: { ...known, text: "Light swirl marks" },
            timing: { ...known, earliest: "2026-10-20", latest: "2026-10-31", text: null },
            location: { status: "confirmed" as const, source: "staff" as const, evidence_revision: null, type: "shop" as const, area: null },
            constraints: { ...known, items: [] },
          },
          missing: [],
          completeness: "complete",
        }),
      })
    )
    expect(html).toContain("Complete")
    expect(html).toContain("Nothing is missing from the record.")
    expect(html).toContain("not a quote or booking ready state")
    expect(html).not.toContain("<button")
  })

  it("renders the suggestion for read-only managers and never on a failed load", () => {
    const html = reviewHtml(record({ can_update: false }))
    expect(html).toContain("Suggested next question")
    expect(html).toContain("Which service are you interested in?")
    expect(html).toContain("Read only")
    expect(html).not.toContain("Send")
    const failed = renderToStaticMarkup(
      createElement(QualificationReview, {
        shopId: id,
        commandId: other,
        services: [],
        history: { ok: false },
        result: { ok: false },
      })
    )
    expect(failed).not.toContain("Suggested next question")
  })
})
