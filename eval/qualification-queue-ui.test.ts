import { describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { readFileSync } from "node:fs"

import { QualificationReview } from "@/components/gradia/qualification-review"
import {
  QualificationQueueQuestion,
  buildStageCommand,
  type QualificationQueueThreads,
} from "@/components/gradia/qualification-queue"
import {
  proposeNextQualificationQuestion,
  unknownQualificationFields,
  type LeadQualification,
} from "@/lib/lead-qualification"
import { qualificationStageOutcome } from "@/lib/qualification-review"

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

const smsThreads: QualificationQueueThreads = {
  sms: { latestId: other, revision: 4, destination: "+15555550111" },
  email: null,
}
const emailThreads: QualificationQueueThreads = {
  sms: null,
  email: { latestId: other, revision: 2, destination: "lead@example.test" },
}
const noThreads: QualificationQueueThreads = { sms: null, email: null }

function queueHtml(
  qualification: LeadQualification,
  threads: QualificationQueueThreads | null,
  isOwner: boolean
) {
  return renderToStaticMarkup(
    createElement(QualificationQueueQuestion, {
      shopId: id,
      workflowId: id,
      qualification,
      threads,
      isOwner,
    })
  )
}

describe("queue for approval review step", () => {
  it("shows an editable review with the actual channel and recipient", () => {
    const html = queueHtml(record(), smsThreads, true)
    expect(html).toContain("Queue for approval")
    expect(html).toContain("Text message")
    expect(html).toContain("To +15555550111 (as reviewed)")
    expect(html).toContain("Which service are you interested in?")
    expect(html).toContain("Message (editable)")
    expect(html).toContain("qualification revision 0")
    expect(html).toContain("evidence revision 1")
    expect(html).toContain("Queue for approval")
    expect(html).not.toContain("will send")
    expect(html).not.toContain("Send the text")
    expect(html).not.toContain("<form")
  })

  it("requires a subject on email and offers only available channels", () => {
    const html = queueHtml(record(), emailThreads, true)
    expect(html).toContain("Email")
    expect(html).toContain("Subject (required for email)")
    expect(html).toContain("To lead@example.test (as reviewed)")
    expect(html).not.toContain("Text message")
  })

  it("gives managers no queue control, even with qualify grants", () => {
    const html = queueHtml(record({ can_update: true }), smsThreads, false)
    expect(html).toContain("Owner only")
    expect(html).toContain("is not permission to")
    expect(html).not.toContain("Queue for approval</button")
    expect(html).not.toContain("<textarea")
    expect(html).not.toContain("<input")
  })

  it("refuses website-only leads without inventing a first-message path", () => {
    const html = queueHtml(record(), noThreads, true)
    expect(html).toContain("No usable conversation to queue into")
    expect(html).toContain("website-only lead cannot receive a first message from here")
    expect(html).toContain("never sends")
    expect(html).not.toContain("Queue for approval</button")
  })

  it("reports unreadable threads without queueing blind", () => {
    const html = queueHtml(record(), null, true)
    expect(html).toContain("No usable conversation to queue into")
    expect(html).toContain("could not be loaded")
    expect(html).not.toContain("Queue for approval</button")
  })

  it("renders no queue step for stale or complete records", () => {
    const stale = queueHtml(
      record({ review_state: "needs_review", review_reasons: ["new_evidence"] }),
      smsThreads,
      true
    )
    expect(stale).not.toContain("Queue for approval")
    const known = {
      status: "reported" as const,
      source: "customer" as const,
      evidence_revision: null,
    }
    const complete = queueHtml(
      record({
        fields: {
          service: { ...known, service_id: id, text: "Full detail" },
          vehicle_condition: { ...known, text: "Swirls" },
          timing: { ...known, earliest: "2026-10-20", latest: "2026-10-31", text: null },
          location: {
            status: "confirmed" as const,
            source: "staff" as const,
            evidence_revision: null,
            type: "shop" as const,
            area: null,
          },
          constraints: { ...known, items: [] },
        },
        missing: [],
        completeness: "complete",
      }),
      smsThreads,
      true
    )
    expect(complete).not.toContain("Queue for approval")
  })

  it("appears inside the review screen behind the suggestion card", () => {
    const html = renderToStaticMarkup(
      createElement(QualificationReview, {
        shopId: id,
        commandId: other,
        services: [],
        history: { ok: true, data: { revision: 0, items: [] } },
        result: { ok: true, data: record() },
        threads: smsThreads,
        isOwner: true,
      })
    )
    expect(html).toContain("Suggested next question")
    expect(html).toContain("Queue for approval")
    expect(html).toContain("To +15555550111 (as reviewed)")
  })
})

describe("staging command identity", () => {
  it("copies basis, target and question id verbatim and edits only wording", () => {
    const q = record()
    const suggestion = proposeNextQualificationQuestion(q)
    if (suggestion.kind !== "question") throw new Error("expected a question")
    const command = buildStageCommand({
      shopId: id,
      workflowId: id,
      commandId: other,
      suggestion,
      channel: "sms",
      thread: smsThreads.sms!,
      body: "Which service did you have in mind?",
      subject: "ignored for sms",
    })
    expect(command).toMatchObject({
      shopId: id,
      workflowId: id,
      commandId: other,
      basis: { revision: 0, evidence_revision: 1 },
      target: "service",
      questionId: null,
      channel: "sms",
      conversation: { latestId: other, revision: 4 },
      message: {
        body: "Which service did you have in mind?",
        subject: "",
        destination: "+15555550111",
      },
    })
  })

  it("keeps email subjects and open-question ids", () => {
    const q = record({
      open_questions: [
        { id: other, text: "Is it garage kept?", status: "open", answer: null },
      ],
    })
    const suggestion = proposeNextQualificationQuestion(q)
    if (suggestion.kind !== "question") throw new Error("expected a question")
    const command = buildStageCommand({
      shopId: id,
      workflowId: id,
      commandId: other,
      suggestion,
      channel: "email",
      thread: emailThreads.email!,
      body: "Is it garage kept?",
      subject: "A quick question",
    })
    expect(command.target).toBe("open_question")
    expect(command.questionId).toBe(other)
    expect(command.message.subject).toBe("A quick question")
    expect(command.conversation).toEqual({ latestId: other, revision: 2 })
  })
})

describe("staging refusal guidance", () => {
  it("retries only the uncertain outcome with the same id", () => {
    const uncertain = qualificationStageOutcome({ ok: false, code: "uncertain" })
    expect(uncertain.retrySame).toBe(true)
    expect(uncertain.reload).toBe(false)
    for (
      const code of [
        "qualification_changed",
        "review_required",
        "question_resolved",
        "conversation_changed",
        "recipient_changed",
        "not_confirmed",
        "command_conflict",
      ] as const
    ) {
      const mapped = qualificationStageOutcome({ ok: false, code })
      expect(mapped.retrySame).toBe(false)
      expect(mapped.reload).toBe(true)
    }
  })

  it("hides the control for non-owners and points at Approvals for duplicates", () => {
    expect(
      qualificationStageOutcome({ ok: false, code: "forbidden" }).hideControl
    ).toBe(true)
    const pending = qualificationStageOutcome({ ok: false, code: "question_pending" })
    expect(pending.description).toContain("Approvals")
    expect(pending.reload).toBe(false)
    expect(
      qualificationStageOutcome({ ok: false, code: "contact_blocked" }).description
    ).toContain("no override")
    expect(
      qualificationStageOutcome({ ok: false, code: "channel_unavailable" }).description
    ).toContain("Settings")
  })

  it("maps every refusal without raw backend text", () => {
    for (
      const code of [
        "forbidden",
        "policy_blocked",
        "command_conflict",
        "qualification_changed",
        "review_required",
        "question_resolved",
        "question_pending",
        "contact_blocked",
        "channel_unavailable",
        "conversation_changed",
        "recipient_changed",
        "not_confirmed",
        "uncertain",
      ] as const
    ) {
      const mapped = qualificationStageOutcome({ ok: false, code })
      expect(mapped.title.length).toBeGreaterThan(0)
      expect(mapped.description.length).toBeGreaterThan(0)
    }
    const invalid = qualificationStageOutcome({ ok: false, code: "invalid", field: "message" })
    expect(invalid.description).toContain("message")
    expect(invalid.reload).toBe(true)
  })

  it("adds no second executor, RPC, or send path", () => {
    const source = [
      "src/components/gradia/qualification-queue.tsx",
      "src/app/intake/[workflowId]/page.tsx",
    ]
      .map((file) => readFileSync(file, "utf8"))
      .join("\n")
    // The screen stages only through the existing server action; it never
    // names the staging RPC, the Whisper command, or any database write of
    // its own (the page's only `.update(` is a pre-existing sha256 hash call).
    expect(source).not.toContain("stage_qualification_question")
    expect(source).not.toMatch(/whisper_command|\.from\([^)]*\)\s*\.\s*(insert|update|upsert|delete)\s*\(|supabase\s*\.\s*rpc\s*\(\s*"stage|cron|setInterval|twilio|aurinko|anthropic/i)
    expect(source).toContain("stageQualificationQuestion")
    expect(source).toContain("read_whisper_thread")
    expect(source).not.toContain("Send the text")
  })
})
