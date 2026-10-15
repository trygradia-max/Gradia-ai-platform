import { describe, it, expect, vi } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { IntakeReviewQueue } from "@/components/gradia/intake-review-queue"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

const id = "00000000-0000-4000-8000-000000000001"

describe("intake review presentation", () => {
  it("escapes submitted text and explains unresolved identity without action buttons", () => {
    const html = renderToStaticMarkup(
      createElement(IntakeReviewQueue, {
        shopId: id,
        result: {
          ok: true,
          queue: {
            total: 1,
            items: [
              {
                id,
                channel: "website_form",
                provider: "website_form",
                state: "identity_review",
                revision: 1,
                event_count: 1,
                last_received_at: "2026-10-02T18:00:00Z",
                payload: { message: "<script>alert(1)</script>", phone: "+15555550111" },
              },
            ],
          },
        },
      })
    )
    expect(html).toContain("&lt;script&gt;")
    expect(html).not.toContain("<script>")
    expect(html).toContain("Identity unresolved")
    expect(html).toContain("does not create a customer")
    expect(html).not.toContain("<button")
    expect(html).not.toContain("<form")
    expect(html).not.toContain("Reject")
    expect(html).not.toContain("Defer")
  })

  it("distinguishes failed loading from an empty queue", () => {
    const failed = renderToStaticMarkup(
      createElement(IntakeReviewQueue, { shopId: id, result: { ok: false } })
    )
    expect(failed).toContain('role="alert"')
    expect(failed).not.toContain("No unresolved intake.")
    const empty = renderToStaticMarkup(
      createElement(IntakeReviewQueue, {
        shopId: id,
        result: { ok: true, queue: { total: 0, items: [] } },
      })
    )
    expect(empty).toContain("No unresolved intake.")
    expect(empty).not.toContain('role="alert"')
  })

  it("explains Meta missing contact details and links compact cards to the correct workspace", () => {
    const html = renderToStaticMarkup(
      createElement(IntakeReviewQueue, {
        shopId: id,
        compact: true,
        result: {
          ok: true,
          queue: {
            total: 1,
            items: [
              {
                id,
                channel: "meta",
                provider: "meta_lead_ads",
                state: "identity_review",
                revision: 1,
                event_count: 1,
                last_received_at: "2026-10-02T18:00:00Z",
                payload: { leadgen_id: "secret-provider-id" },
              },
            ],
          },
        },
      })
    )
    expect(html).toContain("Contact details have not been retrieved")
    expect(html).not.toContain("secret-provider-id")
    expect(html).toContain(`/intake?shop=${id}`)
  })

  it("shows owner linking only when customer choices were loaded", () => {
    const html = renderToStaticMarkup(
      createElement(IntakeReviewQueue, {
        shopId: id,
        customers: [
          {
            id,
            name: "Alex",
            phone: "+15555550111",
            email: null,
            updated_at: "2026-10-02T18:00:00Z",
          },
        ],
        result: {
          ok: true,
          queue: {
            total: 1,
            items: [
              {
                id,
                channel: "sms",
                provider: "twilio",
                state: "identity_review",
                revision: 1,
                event_count: 1,
                last_received_at: "2026-10-02T18:00:00Z",
                payload: { phone: "+15555550111" },
              },
            ],
          },
        },
      })
    )
    expect(html).toContain("<form")
    expect(html).toContain("Confirm identity link")
    expect(html).toContain("Choose explicitly")
    expect(html).not.toContain("Reject")
  })
})
