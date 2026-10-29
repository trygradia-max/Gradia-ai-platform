import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { OperationsOverviewBrief } from "@/components/gradia/operations-overview"
import type { OperationsOverview } from "@/lib/operations-queue-reader"

const observedAt = "2026-10-27T06:30:00.000Z"

function readyOverview({ hasMore = false, items = [] }: {
  hasMore?: boolean
  items?: Extract<OperationsOverview["queue"], { status: "ready" }>["items"]
} = {}): OperationsOverview {
  const needsReview = items.filter((item) => item.state === "needs_review")
  const unconfirmed = items.filter((item) => item.state === "outcome_unconfirmed")
  return {
    queue: {
      status: "ready",
      items,
      hasMore,
      countsInLoadedWindow: {
        needsReview: needsReview.length,
        outcomeUnconfirmed: unconfirmed.length,
      },
      observedAt,
      viewerRole: "manager",
      nextCursor: hasMore
        ? {
            observedAt,
            sourceKind: "pending_action",
            sourceId: "00000000-0000-4000-8000-000000000001",
          }
        : null,
    },
    brief: {
      status: "ready",
      observedAt,
      coverage: hasMore ? "partial" : "complete",
      countsInLoadedWindow: {
        needsReview: needsReview.length,
        outcomeUnconfirmed: unconfirmed.length,
      },
      sections: [
        { kind: "needs_review", countInLoadedWindow: needsReview.length, items: needsReview },
        {
          kind: "outcome_unconfirmed",
          countInLoadedWindow: unconfirmed.length,
          items: unconfirmed,
        },
      ],
    },
  }
}

function render(overview: OperationsOverview): string {
  return renderToStaticMarkup(createElement(OperationsOverviewBrief, { overview }))
}

describe("operations overview UI", () => {
  it("treats an unavailable read as an alert, never an empty all-clear", () => {
    const html = render({
      queue: {
        status: "unavailable",
        items: [],
        reason: "source_unavailable",
        observedAt,
        nextCursor: null,
      },
      brief: {
        status: "unavailable",
        observedAt,
        reason: "source_unavailable",
        sections: [],
      },
    })

    expect(html).toContain('role="alert"')
    expect(html).toContain("Work status could not be verified")
    expect(html).toContain("Nothing is assumed clear")
    expect(html).not.toContain("No permitted work is waiting")
  })

  it("renders a successful empty window separately with its observation time", () => {
    const html = render(readyOverview())

    expect(html).toContain("No permitted work is waiting in this view")
    expect(html).toContain('dateTime="2026-10-27T06:30:00.000Z"')
    expect(html).toContain("Oct 27, 2026, 6:30 AM UTC")
    expect(html).not.toContain('role="alert"')
  })

  it("preserves partial coverage, mixed-source provenance and uncertain outcomes", () => {
    const html = render(
      readyOverview({
        hasMore: true,
        items: [
          {
            workKey: "lead_workflow:one",
            state: "needs_review",
            observedAt,
            sources: [
              {
                kind: "pending_action",
                id: "00000000-0000-4000-8000-000000000001",
                actionType: "send_sms",
                href: "/team/approvals?shop=one",
              },
              {
                kind: "intake_workflow",
                id: "00000000-0000-4000-8000-000000000002",
                revision: 2,
                href: "/intake?shop=one",
              },
            ],
          },
          {
            workKey: "pending_action:two",
            state: "outcome_unconfirmed",
            observedAt: "2026-10-27T06:20:00.000Z",
            sources: [
              {
                kind: "pending_action",
                id: "00000000-0000-4000-8000-000000000003",
                actionType: "send_email",
                href: "/team/delivery-reviews?shop=one",
              },
            ],
          },
        ],
      })
    )

    expect(html).toContain("Counts describe this loaded window")
    expect(html).toContain("Partial view")
    expect(html).toContain("More permitted work exists beyond this view")
    expect(html).toContain("Needs review")
    expect(html).toContain("Outcome unconfirmed")
    expect(html).toContain('href="/team/approvals?shop=one"')
    expect(html).toContain("Review text message")
    expect(html).toContain('href="/intake?shop=one"')
    expect(html).toContain("Review intake evidence")
    expect(html).toContain('href="/team/delivery-reviews?shop=one"')
    expect(html).toContain("Open outcome evidence")
    expect(html).not.toMatch(/retry|resend|delivered|failed/i)
  })

  it("uses the authorized workspace loader and a skeleton loading state", () => {
    const root = decodeURIComponent(new URL("../", import.meta.url).pathname)
    const page = readFileSync(join(root, "src/app/team/page.tsx"), "utf8")
    const loading = readFileSync(join(root, "src/app/team/loading.tsx"), "utf8")

    expect(page).toContain("loadOperationsOverviewForWorkspace(workspace.id, { limit: 8 })")
    expect(page).not.toContain("loadOperationsOverviewForWorkspace(shop")
    expect(loading).toContain('@/components/ui/skeleton')
    expect(loading).not.toMatch(/animate-spin|Loader2/)
  })
})
