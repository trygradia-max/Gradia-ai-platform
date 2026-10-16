import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { EmployeeBuilder } from "@/components/gradia/employee-builder"
import { memorySnapshot } from "@/lib/super-agent/memory"
import type { EmployeeBrief, EmployeeDraft } from "@/lib/super-agent/brief"
import type { SavedMemoryRead } from "@/lib/super-agent/memory-store"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock("@/app/actions/super-agent", () => ({ prepareEmployee: vi.fn(), saveEmployeeDraft: vi.fn(), runEmployeeResearch: vi.fn(), cancelEmployeeResearch: vi.fn() }))
vi.mock("@/app/actions/super-agent-browser", () => ({ checkCloudBrowser: vi.fn() }))
vi.mock("@/app/actions/super-agent-memory", () => ({ readEmployeeMemory: vi.fn() }))

const brief: EmployeeBrief = { name: "Custom researcher", goal: "Compare suppliers for my detailing business", deliverable: "A sourced comparison", business_context: "Hours", steps: ["Read the notes"], connections_needed: [], questions: [] }
const draft: EmployeeDraft = { id: "draft-1", created_at: "2026-10-16T00:00:00.000Z", brief }
const read: SavedMemoryRead = { id: "read-1", draft_id: draft.id, detail: memorySnapshot([{ source_name: "Hours", content: "Open at 9." }]), created_at: draft.created_at }
const props = { drafts: [draft], runs: [], loadFailed: false, runLoadFailed: false, planningEnabled: false, planningCredits: null, researchEnabled: false }

describe("business-note read screen", () => {
  it("shows a saved read and hides it until the flag is on", () => {
    const html = renderToStaticMarkup(createElement(EmployeeBuilder, { ...props, memoryEnabled: true, memoryReads: [read] }))
    expect(html).toContain("Read saved notes")
    expect(html).toContain("does not publish a lesson")
    expect(html).toContain("Not published")
    expect(html).toContain("Hours")
    expect(html).toContain("Open at 9.")
    expect(html).toContain("did not publish")
    expect(html).not.toContain("Lesson published")
    const hidden = renderToStaticMarkup(createElement(EmployeeBuilder, props))
    expect(hidden).not.toContain("Read saved notes")
  })
})
