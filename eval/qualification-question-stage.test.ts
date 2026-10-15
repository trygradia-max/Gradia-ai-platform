import { describe, expect, it } from "vitest"
import { qualificationQuestionStageRefusal, qualificationQuestionStageSchema, qualificationQuestionStagedSchema } from "@/lib/lead-qualification"

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const command = (patch: Record<string, unknown> = {}) => ({
  shopId: id(1), workflowId: id(2), commandId: id(3),
  basis: { revision: 1, evidence_revision: 1 }, target: "timing", questionId: null, channel: "sms",
  conversation: { latestId: id(4), revision: 0 },
  message: { body: "When would you like to bring it in?", subject: "", destination: "+15555550123" }, ...patch,
})
const field = (input: unknown) => {
  const r = qualificationQuestionStageSchema.safeParse(input)
  return r.success ? "ok" : String(r.error.issues[0]?.path[0])
}

describe("qualification question staging command", () => {
  it("accepts a proposed field question and an open question by id", () => {
    expect(field(command())).toBe("ok")
    expect(field(command({ target: "open_question", questionId: id(5) }))).toBe("ok")
    expect(field(command({ basis: { revision: 0, evidence_revision: null } }))).toBe("ok")
  })
  it("requires a question id exactly for open questions", () => {
    expect(field(command({ target: "open_question" }))).toBe("target")
    expect(field(command({ questionId: id(5) }))).toBe("target")
    expect(field(command({ target: "price" }))).toBe("target")
  })
  it("enforces channel message rules and refuses unknown keys", () => {
    expect(field(command({ channel: "voice" }))).toBe("channel")
    expect(field(command({ message: { body: " ", subject: "", destination: "+15555550123" } }))).toBe("message")
    expect(field(command({ message: { body: "x".repeat(1601), subject: "", destination: "+15555550123" } }))).toBe("message")
    expect(field(command({ message: { body: "Hi", subject: "Subject", destination: "+15555550123" } }))).toBe("message")
    expect(field(command({ channel: "email", message: { body: "Hi", subject: "", destination: "lead@example.test" } }))).toBe("message")
    expect(field(command({ channel: "email", message: { body: "Hi", subject: "Your request", destination: "lead@example.test" } }))).toBe("ok")
    expect(field({ ...command(), customerId: id(9) })).not.toBe("ok")
    expect(field(command({ basis: { revision: 1, evidence_revision: 1, extra: 1 } }))).toBe("basis")
  })
})

describe("qualification question staging refusals", () => {
  const map = (code: string, details: string | null = null) => qualificationQuestionStageRefusal({ code, details })
  it("maps every documented conflict and never echoes database text", () => {
    for (const c of ["command_conflict", "qualification_changed", "review_required", "question_resolved", "question_pending", "contact_blocked", "channel_unavailable", "conversation_changed", "recipient_changed"])
      expect(map("PT409", c)).toEqual({ ok: false, code: c })
    expect(map("PT409", "Recipient changed")).toEqual({ ok: false, code: "not_confirmed" })
    expect(map("42501", "policy_blocked")).toEqual({ ok: false, code: "policy_blocked" })
    expect(map("42501", "anything")).toEqual({ ok: false, code: "forbidden" })
    expect(map("22023", "target")).toEqual({ ok: false, code: "invalid", field: "target" })
    expect(map("22023", "fields.secret")).toEqual({ ok: false, code: "invalid", field: "command" })
    expect(map("XX000", "boom")).toEqual({ ok: false, code: "not_confirmed" })
  })
  it("rejects a reply that is not a staged question", () => {
    const ok = { status: "queued", action_id: id(3), workflow_id: id(2), channel: "sms", qualification: { workflow_id: id(2), revision: 1, evidence_revision: 1, target: "timing", question_id: null } }
    expect(qualificationQuestionStagedSchema.safeParse(ok).success).toBe(true)
    expect(qualificationQuestionStagedSchema.safeParse({ ...ok, status: "sent" }).success).toBe(false)
    expect(qualificationQuestionStagedSchema.safeParse({ ...ok, extra: true }).success).toBe(false)
  })
})
