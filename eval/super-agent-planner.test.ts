import { afterEach, describe, expect, it, vi } from "vitest"
import { employeeBriefSchema } from "@/lib/super-agent/brief"
import { planEmployee } from "@/lib/super-agent/planner"

const brief = { name: "Google helper", goal: "Improve my business visibility on Google", deliverable: "A prioritized list of improvements", business_context: "A mobile detailer", steps: ["Review the supplied business context"], connections_needed: ["Business website"], questions: ["Which city do you serve?"] }
const request = { goal: brief.goal, context: brief.business_context }
afterEach(() => vi.unstubAllEnvs())
describe("digital employee planning boundary", () => {
  it("rejects model-provided execution permissions and arbitrary extra fields", () => {
    expect(employeeBriefSchema.safeParse({ ...brief, tools: ["shell"], enabled: true }).success).toBe(false)
  })
  it("does not call a model for invalid input or a missing credential", async () => {
    const transport = vi.fn()
    await expect(planEmployee({ goal: "", context: "" }, transport)).rejects.toThrow()
    vi.stubEnv("ANTHROPIC_API_KEY", "")
    await expect(planEmployee(request, transport)).rejects.toThrow(/not connected/)
    expect(transport).not.toHaveBeenCalled()
  })
  it("returns a validated brief using only the brief tool, without browser or execution tools", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-test-key")
    const transport = vi.fn(async () => Response.json({ stop_reason: "tool_use", content: [{ type: "tool_use", name: "employee_brief", input: brief }] }))
    expect(await planEmployee(request, transport)).toEqual(brief)
    const call = transport.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(call[1].body))
    expect(body.tools.map((t: {name:string}) => t.name)).toEqual(["employee_brief"])
    expect(body.messages).toHaveLength(1)
  })
  it.each(["max_tokens", "pause_turn", "end_turn"])("refuses an unfinished or unexpected %s response", async stop_reason => {
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-test-key")
    await expect(planEmployee(request, async () => Response.json({ stop_reason, content: [{ type: "tool_use", name: "employee_brief", input: brief }] }))).rejects.toThrow(/incomplete/)
  })
  it("does not expose provider error bodies", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-test-key")
    await expect(planEmployee(request, async () => new Response("private upstream details", { status: 401 }))).rejects.toThrow("Gradia couldn't prepare the brief")
  })
  it("rejects oversized or ambiguous model output", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-test-key")
    for (const content of [[{ type: "tool_use", name: "employee_brief", input: { ...brief, steps: Array(9).fill("A step") } }], Array(2).fill({ type: "tool_use", name: "employee_brief", input: brief })]) {
      await expect(planEmployee(request, async () => Response.json({ stop_reason: "tool_use", content }))).rejects.toThrow(/incomplete/)
    }
  })
})
