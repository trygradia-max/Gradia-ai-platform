import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { EmployeeBuilder } from "@/components/gradia/employee-builder"
import { EmployeeBrowserResult } from "@/components/gradia/employee-browser-result"
import { unavailableBrowserCheck } from "@/lib/super-agent/browser"
import type { EmployeeBrief, EmployeeDraft } from "@/lib/super-agent/brief"
import type { SavedBrowserCheck } from "@/lib/super-agent/browser-store"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock("@/app/actions/super-agent", () => ({ prepareEmployee: vi.fn(), saveEmployeeDraft: vi.fn(), runEmployeeResearch: vi.fn(), cancelEmployeeResearch: vi.fn() }))
vi.mock("@/app/actions/super-agent-browser", () => ({ checkCloudBrowser: vi.fn() }))

const brief: EmployeeBrief = { name: "Custom researcher", goal: "Compare suppliers for my detailing business", deliverable: "A sourced comparison", business_context: "https://parts.example/catalog", steps: ["Read the public catalog"], connections_needed: [], questions: [] }
const draft: EmployeeDraft = { id: "draft-1", created_at: "2026-10-16T00:00:00.000Z", brief }
const check: SavedBrowserCheck = { id: "check-1", draft_id: draft.id, status: "unavailable", detail: unavailableBrowserCheck(true), created_at: draft.created_at }
const props = { drafts: [draft], runs: [], loadFailed: false, runLoadFailed: false, planningEnabled: false, planningCredits: null, researchEnabled: false }

describe("cloud browser check screen", () => {
  it("shows a saved not-connected result and hides the check until it is enabled", () => {
    const html = renderToStaticMarkup(createElement(EmployeeBuilder, { ...props, browserEnabled: true, browserChecks: [check] }))
    expect(html).toContain("Cloud browser is not connected.")
    expect(html).toContain("Check cloud browser")
    expect(html).toContain("does not open a browser")
    expect(html).toContain("Not connected")
    expect(html).toContain("No browser session was started.")
    expect(html).toContain("No password was stored.")
    expect(html).toContain("This computer was not used.")
    expect(html).toContain("A named browser service was ignored.")
    expect(html).not.toContain("Browser session started")
    expect(html).not.toContain("Signed in")
    const hidden = renderToStaticMarkup(createElement(EmployeeBuilder, props))
    expect(hidden).not.toContain("Check cloud browser")
    const result = renderToStaticMarkup(createElement(EmployeeBrowserResult, { check }))
    expect(result).toContain("No isolated browser service is configured")
  })
})
