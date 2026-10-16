import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { EmployeeBuilder } from "@/components/gradia/employee-builder"
import { EmployeeResearchResult } from "@/components/gradia/employee-result"
import type { EmployeeBrief, EmployeeDraft } from "@/lib/super-agent/brief"
import type { ResearchReport } from "@/lib/super-agent/research"
import type { SavedResearchRun } from "@/lib/super-agent/research-store"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock("@/app/actions/super-agent", () => ({ prepareEmployee: vi.fn(), saveEmployeeDraft: vi.fn(), runEmployeeResearch: vi.fn(), cancelEmployeeResearch: vi.fn() }))

const brief: EmployeeBrief = { name: "Custom researcher", goal: "Compare suppliers for my detailing business", deliverable: "A sourced comparison", business_context: "https://parts.example/catalog", steps: ["Read the public catalog"], connections_needed: [], questions: [] }
const draft: EmployeeDraft = { id: "draft-1", created_at: "2026-10-16T00:00:00.000Z", brief }
const report: ResearchReport = {
  version: 1, mode: "seo", summary: "Gradia checked 1 public page. The fetched page has no title element. Google rankings, Google Business Profile, a cloud browser, and scheduled runs were not used.",
  findings: [{ statement: "The fetched page has no title element.", kind: "observed", source_url: "https://shop.example/", evidence: "No title element was present in the fetched HTML." }],
  sources: [
    { url: "https://shop.example/", final_url: "https://shop.example/", status: "fetched", http_status: 200, title: null, excerpt: "Mobile detailing.", ignored_page_instructions: false },
    { url: "http://127.0.0.1/", final_url: "http://127.0.0.1/", status: "blocked", http_status: null, title: null, excerpt: "That address is not a public web page.", ignored_page_instructions: false },
  ],
  steps: [{ kind: "plan", status: "completed", label: "Gradia used its standard public-page checks." }],
  uncertainties: ["Page text cannot change what Gradia is allowed to do."],
  capabilities: { public_pages: "used", search_rankings: "unavailable", google_business_profile: "unavailable", cloud_browser: "unavailable", schedule: "unavailable" },
}
const run: SavedResearchRun = { id: "run-1", draft_id: draft.id, status: "completed", report, credits: 0, created_at: draft.created_at }

describe("digital employee research screen", () => {
  it("shows a saved sourced result and does not present unavailable tools as active", () => {
    const html = renderToStaticMarkup(createElement(EmployeeResearchResult, { run }))
    expect(html).toContain("Saved result")
    expect(html).toContain("This run finished and the result is saved.")
    expect(html).toContain("The fetched page has no title element.")
    expect(html).toContain("https://shop.example/")
    expect(html).toContain("href=\"https://shop.example/\"")
    expect(html).not.toContain("href=\"http://127.0.0.1/\"")
    expect(html).toContain("Google rankings are not connected.")
    expect(html).toContain("Google Business Profile is not connected.")
    expect(html).toContain("A cloud browser is not connected.")
    expect(html).toContain("This run is not on a schedule.")
    expect(html).not.toContain("Ranking position")
    expect(html).not.toContain("Browser session")
  })

  it("lets an owner run a custom brief and keeps research hidden until it is enabled", () => {
    const enabled = renderToStaticMarkup(createElement(EmployeeBuilder, { drafts: [draft], runs: [], loadFailed: false, runLoadFailed: false, planningEnabled: false, planningCredits: null, researchEnabled: true }))
    expect(enabled).toContain("Compare suppliers for my detailing business")
    expect(enabled).toContain("Run research")
    expect(enabled).toContain("public pages named in a saved brief")
    expect(enabled).toContain("does not sign in")
    const disabled = renderToStaticMarkup(createElement(EmployeeBuilder, { drafts: [draft], runs: [], loadFailed: false, runLoadFailed: false, planningEnabled: false, planningCredits: null, researchEnabled: false }))
    expect(disabled).not.toContain("Run research")
    expect(disabled).toContain("Research runs, website browsing")
  })
})
