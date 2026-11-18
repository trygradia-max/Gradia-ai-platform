// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { validAnswers } from "./_baseline-fixtures"

const actions = vi.hoisted(() => ({ saveBaselineDraft: vi.fn(), submitBaselineAssessment: vi.fn(), getBaselineStartingPoint: vi.fn() }))
vi.mock("@/app/actions/onboarding-baseline", () => actions)

import { StartingPointQuiz, type QuizSeed } from "@/components/gradia/starting-point/starting-point-quiz"

const draft = (answers: Record<string, unknown>, draftVersion = 3) => ({
  draftVersion, catalogVersion: "baseline.v1", updatedByRole: "owner" as const, updatedAt: "2026-11-18T10:00:00Z", answers,
})
const seed = (over: Partial<QuizSeed> = {}): QuizSeed => ({ role: "owner", baselineRevision: null, draft: null, revisionAnswers: null, ...over })

const handlers = () => ({ onReload: vi.fn(), onSubmitted: vi.fn(), onFinishLater: vi.fn(), onSkip: vi.fn(), onBackStep: vi.fn(), onCancel: vi.fn(), onForbidden: vi.fn() })
function mount(s: QuizSeed, over: { startAt?: "intro" | "quiz"; mode?: "page" | "wizard" } = {}) {
  const h = handlers()
  render(<StartingPointQuiz seed={s} mode={over.mode ?? "page"} startAt={over.startAt ?? "intro"} {...h} />)
  return h
}
const button = (name: RegExp | string) => screen.getByRole("button", { name })

beforeEach(() => {
  actions.saveBaselineDraft.mockReset()
  actions.submitBaselineAssessment.mockReset()
  actions.saveBaselineDraft.mockResolvedValue({ ok: true, data: { draftVersion: 1 } })
})
afterEach(cleanup)

describe("intro", () => {
  it("explains the purpose in operator language without promising results or suggesting numbers", () => {
    mount(seed())
    const text = document.body.textContent ?? ""
    expect(text).toContain("Gradia is the AI operations system for automotive service businesses")
    expect(text).toContain("establishes where your shop starts")
    expect(text).toContain("measure operational change honestly over time")
    expect(text).toContain("I’m not sure” is always a fine answer")
    expect(text).toContain("not a grade or a promise")
    expect(text).toContain("does not ask for revenue, payroll, customer lists or passwords")
    for (const banned of ["increase", "boost", "guarantee", "ROI", "save you", "!"]) expect(text, banned).not.toContain(banned)
    expect(screen.getByRole("heading", { level: 2, name: /where your shop starts today/i })).toBeTruthy()
  })
  it("offers Skip and Back only inside the onboarding wizard", async () => {
    mount(seed(), { mode: "page" })
    expect(screen.queryByRole("button", { name: /skip for now/i })).toBeNull()
    cleanup()
    const h = mount(seed(), { mode: "wizard" })
    await userEvent.setup().click(button(/skip for now/i))
    expect(h.onSkip).toHaveBeenCalledTimes(1)
    await userEvent.setup().click(button(/^back$/i))
    expect(h.onBackStep).toHaveBeenCalledTimes(1)
  })
})

describe("a question page", () => {
  async function openFirstPage() {
    const user = userEvent.setup()
    const h = mount(seed())
    await user.click(button(/^start$/i))
    return { user, h }
  }

  it("has a labelled group per question, labelled controls, a named progressbar and a focused heading", async () => {
    await openFirstPage()
    const heading = screen.getByRole("heading", { level: 2, name: "Your team" })
    expect(document.activeElement).toBe(heading)
    expect(screen.getAllByRole("group").length).toBe(3)
    expect(screen.getByRole("group", { name: /how many people actively work on jobs/i })).toBeTruthy()
    for (const el of document.querySelectorAll<HTMLInputElement>("input, textarea")) {
      const named = (el.labels?.length ?? 0) > 0 || el.getAttribute("aria-label")
      expect(named, el.outerHTML).toBeTruthy()
    }
    const bar = screen.getByRole("progressbar", { name: /questions answered/i })
    expect(bar.getAttribute("aria-valuemin")).toBe("0")
    expect(bar.getAttribute("aria-valuemax")).toBe("21")
    expect(bar.getAttribute("aria-valuenow")).toBe("0")
    expect(screen.getByText(/page 1 of 6/i)).toBeTruthy()
  })

  it("starts empty: no pre-filled number, no placeholder, no pre-checked answer", async () => {
    await openFirstPage()
    for (const el of document.querySelectorAll<HTMLInputElement>("input[type=text]")) {
      expect(el.value).toBe("")
      expect(el.getAttribute("placeholder")).toBeNull()
    }
    for (const el of document.querySelectorAll<HTMLInputElement>("input[type=checkbox], input[type=radio]")) expect(el.checked).toBe(false)
  })

  it("lets a blank question pass without turning it into zero and writes nothing", async () => {
    const { user } = await openFirstPage()
    await user.click(button(/save and continue/i))
    expect(screen.getByRole("heading", { level: 2, name: "Inquiries and calls" })).toBeTruthy()
    expect(actions.saveBaselineDraft).not.toHaveBeenCalled()
  })

  it("refuses text that is not a number, names the question and does not save", async () => {
    const { user } = await openFirstPage()
    await user.type(screen.getByRole("textbox", { name: /how many people actively work on jobs/i }), "abc")
    await user.click(button(/save and continue/i))
    expect((await screen.findAllByRole("alert")).length).toBeGreaterThan(0)
    expect(screen.getByText(/1 answer needs attention/i)).toBeTruthy()
    expect(screen.getAllByText(/enter a number using digits/i).length).toBeGreaterThan(0)
    expect(screen.getByRole("textbox", { name: /how many people actively work on jobs/i }).getAttribute("aria-invalid")).toBe("true")
    expect(actions.saveBaselineDraft).not.toHaveBeenCalled()
    expect(screen.getByRole("heading", { level: 2, name: "Your team" })).toBeTruthy()
  })

  it("keeps 'I’m not sure' as unknown and an explicit 0 as zero, and saves only on the server's word", async () => {
    const { user } = await openFirstPage()
    await user.type(screen.getByRole("textbox", { name: /service bays or mobile crews/i }), "0")
    const group = screen.getByRole("group", { name: /how many people actively work on jobs/i })
    await user.click(within(group).getByRole("checkbox", { name: /i’m not sure/i }))
    expect(within(group).getByText(/saved as unknown/i)).toBeTruthy()
    expect(within(group).queryByRole("textbox")).toBeNull()

    let finish: (v: unknown) => void = () => {}
    actions.saveBaselineDraft.mockReturnValueOnce(new Promise((r) => { finish = r }))
    await user.click(button(/save and continue/i))
    expect(await screen.findByText("Saving…")).toBeTruthy()
    expect(screen.queryByText(/saved to your workspace/i)).toBeNull()
    finish({ ok: true, data: { draftVersion: 1 } })
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "Inquiries and calls" })).toBeTruthy())

    const payload = actions.saveBaselineDraft.mock.calls[0][0]
    expect(payload).toEqual({
      answers: { active_operators: { state: "unknown" }, service_bays: { state: "value", value: 0, unit: "count" } },
      expectedDraftVersion: null,
    })
    expect(JSON.stringify(payload)).not.toMatch(/shop|user|role|period/i)
  })

  it("chains the draft version so a later save is a compare-and-set on the last confirmed save", async () => {
    const { user } = await openFirstPage()
    await user.type(screen.getByRole("textbox", { name: /service bays or mobile crews/i }), "2")
    await user.click(button(/save and continue/i))
    await screen.findByRole("heading", { level: 2, name: "Inquiries and calls" })
    actions.saveBaselineDraft.mockResolvedValueOnce({ ok: true, data: { draftVersion: 2 } })
    await user.type(screen.getByRole("textbox", { name: /about how many calls come in/i }), "40")
    await user.click(button(/save and continue/i))
    await screen.findByRole("heading", { level: 2, name: "Bookings and follow-up" })
    expect(actions.saveBaselineDraft.mock.calls.map((c) => c[0].expectedDraftVersion)).toEqual([null, 1])
  })

  it("does not claim a save that failed, keeps the owner on the page and the answers on screen", async () => {
    const { user } = await openFirstPage()
    actions.saveBaselineDraft.mockResolvedValueOnce({ ok: false, code: "unavailable" })
    await user.type(screen.getByRole("textbox", { name: /service bays or mobile crews/i }), "2")
    await user.click(button(/save and continue/i))
    expect(await screen.findByText(/couldn’t save your answers/i)).toBeTruthy()
    expect(screen.queryByText(/saved to your workspace at/i)).toBeNull()
    expect(screen.getByRole("heading", { level: 2, name: "Your team" })).toBeTruthy()
    expect((screen.getByRole("textbox", { name: /service bays or mobile crews/i }) as HTMLInputElement).value).toBe("2")
  })

  it("offers a reload on conflict and never overwrites silently", async () => {
    const { user, h } = await openFirstPage()
    actions.saveBaselineDraft.mockResolvedValueOnce({ ok: false, code: "conflict" })
    await user.type(screen.getByRole("textbox", { name: /service bays or mobile crews/i }), "2")
    await user.click(button(/save and continue/i))
    expect(await screen.findByText(/changed somewhere else/i)).toBeTruthy()
    expect(screen.getByRole("heading", { level: 2, name: "Your team" })).toBeTruthy()
    await user.click(button(/reload the latest/i))
    expect(h.onReload).toHaveBeenCalledTimes(1)
    expect(actions.saveBaselineDraft).toHaveBeenCalledTimes(1)
  })

  it("hands control back when the database refuses the account mid-flow", async () => {
    const { user, h } = await openFirstPage()
    actions.saveBaselineDraft.mockResolvedValueOnce({ ok: false, code: "forbidden" })
    await user.type(screen.getByRole("textbox", { name: /service bays or mobile crews/i }), "2")
    await user.click(button(/save and continue/i))
    await waitFor(() => expect(h.onForbidden).toHaveBeenCalledTimes(1))
  })

  it("clears the figure when the unit changes, so 30 as a count never becomes 30 as a percent", async () => {
    const { user } = await openFirstPage()
    await user.click(button(/save and continue/i)) // team
    await screen.findByRole("heading", { level: 2, name: "Inquiries and calls" })
    await user.click(button(/save and continue/i)) // inquiries -> bookings
    await screen.findByRole("heading", { level: 2, name: "Bookings and follow-up" })
    const group = screen.getByRole("group", { name: /confirmed appointments/i })
    await user.type(within(group).getByRole("textbox"), "30")
    await user.click(within(group).getByRole("radio", { name: /a percent of inquiries/i }))
    expect((within(group).getByRole("textbox") as HTMLInputElement).value).toBe("")
    expect(within(group).getByText(/from 0 to 100/i)).toBeTruthy()
  })

  it("keeps a range a range and asks for both ends", async () => {
    const { user } = await openFirstPage()
    await user.click(button(/save and continue/i))
    await screen.findByRole("heading", { level: 2, name: "Inquiries and calls" })
    const group = screen.getByRole("group", { name: /first reply/i })
    await user.click(within(group).getByRole("button", { name: /it varies/i }))
    await user.type(within(group).getByLabelText(/^from$/i), "30")
    await user.click(button(/save and continue/i))
    expect((await screen.findAllByText(/enter both ends of the range/i)).length).toBeGreaterThan(0)
    expect(actions.saveBaselineDraft).not.toHaveBeenCalled()
  })

  it("shows a live total for the source mix and rejects a mix that is not 100%", async () => {
    const { user } = await openFirstPage()
    await user.click(button(/save and continue/i))
    await screen.findByRole("heading", { level: 2, name: "Inquiries and calls" })
    const group = screen.getByRole("group", { name: /where do those inquiries come from/i })
    await user.type(within(group).getByLabelText(/website form/i), "60")
    await user.type(within(group).getByLabelText(/phone call/i), "30")
    expect(within(group).getByText(/total so far: 90%/i)).toBeTruthy()
    await user.click(button(/save and continue/i))
    expect(await screen.findAllByText(/add up to exactly 100%/i)).toBeTruthy()
    expect(actions.saveBaselineDraft).not.toHaveBeenCalled()
  })

  it("flags a cross-question contradiction instead of saving it", async () => {
    const { user } = await openFirstPage()
    await user.click(button(/save and continue/i))
    await screen.findByRole("heading", { level: 2, name: "Inquiries and calls" })
    await user.type(screen.getByRole("textbox", { name: /about how many calls come in/i }), "10")
    await user.type(screen.getByRole("textbox", { name: /go unanswered/i }), "11")
    await user.click(button(/save and continue/i))
    expect(await screen.findAllByText(/can’t be more than the calls you said come in/i)).toBeTruthy()
    expect(actions.saveBaselineDraft).not.toHaveBeenCalled()
  })

  it("lets an owner save and finish later, only after the server confirms", async () => {
    const { user, h } = await openFirstPage()
    await user.type(screen.getByRole("textbox", { name: /service bays or mobile crews/i }), "2")
    await user.click(button(/save and finish later/i))
    await waitFor(() => expect(h.onFinishLater).toHaveBeenCalledTimes(1))
    expect(actions.saveBaselineDraft).toHaveBeenCalledTimes(1)
  })
})

describe("resume from the server draft", () => {
  it("rebuilds answers, offers to continue, and opens at the first page with a missing answer", async () => {
    const user = userEvent.setup()
    const answers = { ...validAnswers() }
    delete answers.confirmed_bookings
    mount(seed({ draft: draft(answers, 4) }))
    expect(screen.getByText(/answers you saved earlier are waiting/i)).toBeTruthy()
    await user.click(button(/continue where you left off/i))
    expect(screen.getByRole("heading", { level: 2, name: "Bookings and follow-up" })).toBeTruthy()
    // Saved answers are on screen where they belong.
    await user.click(button(/^back$/i))
    expect((screen.getByRole("textbox", { name: /about how many calls come in/i }) as HTMLInputElement).value).toBe("40")
    // Nothing changed, so continuing writes nothing and does not bump the draft version.
    await user.click(button(/save and continue/i))
    expect(actions.saveBaselineDraft).not.toHaveBeenCalled()
  })

  it("saves a later change against the draft version it resumed from", async () => {
    const user = userEvent.setup()
    mount(seed({ draft: draft({ calls_per_week: { state: "value", value: 5, unit: "count_per_week" } }, 7) }), { startAt: "quiz" })
    await user.type(screen.getByRole("textbox", { name: /how many people actively work on jobs/i }), "2")
    await user.click(button(/save and continue/i))
    expect(actions.saveBaselineDraft.mock.calls[0][0].expectedDraftVersion).toBe(7)
  })
})

describe("review and submit", () => {
  const completeDraft = () => seed({ draft: draft(validAnswers(), 5), baselineRevision: null })

  it("opens at Review when every required question is answered and reads answers back in plain words", () => {
    mount(completeDraft(), { startAt: "quiz" })
    expect(screen.getByRole("heading", { level: 2, name: /review your starting point/i })).toBeTruthy()
    expect(screen.getByText("30 min to 4 hr")).toBeTruthy()
    expect(screen.getAllByText("I’m not sure").length).toBe(2)
    expect(screen.getByText("A spreadsheet")).toBeTruthy()
    expect(screen.getByText(/records your starting point as revision 1/i)).toBeTruthy()
    expect(screen.queryByText(/still need an answer/i)).toBeNull()
  })

  it("lists unanswered required questions as needing an answer (not zero, not unknown) and refuses to submit", async () => {
    const user = userEvent.setup()
    const answers = { ...validAnswers() }
    delete answers.calls_per_week
    mount(seed({ draft: draft(answers) }), { startAt: "quiz" })
    // The draft opens at the page with the gap; walk to Review without answering (blank is allowed to pass).
    expect(screen.getByRole("heading", { level: 2, name: "Inquiries and calls" })).toBeTruthy()
    for (let i = 0; i < 3; i++) await user.click(button(/save and continue/i))
    await user.click(button(/review answers/i))
    expect(actions.saveBaselineDraft).not.toHaveBeenCalled()
    expect(screen.getByText(/1 question still needs an answer/i)).toBeTruthy()
    expect(screen.getByText("Needs an answer")).toBeTruthy()
    await user.click(button(/save starting point/i))
    expect(actions.submitBaselineAssessment).not.toHaveBeenCalled()
    expect(await screen.findByText(/1 answer needs attention/i)).toBeTruthy()
    // The summary jumps back to the exact question.
    await user.click(within(screen.getByRole("alert")).getByRole("button", { name: /about how many calls come in/i }))
    expect(screen.getByRole("heading", { level: 2, name: "Inquiries and calls" })).toBeTruthy()
  })

  it("submits as the owner with the confirmed draft version and nothing client-chosen", async () => {
    const user = userEvent.setup()
    actions.submitBaselineAssessment.mockResolvedValue({ ok: true, data: { revision: 1, kind: "submitted", supersedesRevision: null } })
    const h = mount(completeDraft(), { startAt: "quiz" })
    await user.click(button(/save starting point/i))
    await waitFor(() => expect(h.onSubmitted).toHaveBeenCalledWith(1))
    expect(actions.saveBaselineDraft).not.toHaveBeenCalled() // unchanged since the saved draft
    expect(actions.submitBaselineAssessment).toHaveBeenCalledWith({ answers: validAnswers(), expectedBaseline: null, expectedDraftVersion: 5 })
  })

  it("starts an update from the current revision, names the revision it will add, and sends the baseline it read", async () => {
    const user = userEvent.setup()
    actions.submitBaselineAssessment.mockResolvedValue({ ok: true, data: { revision: 3, kind: "superseded", supersedesRevision: 2 } })
    const h = mount(seed({ baselineRevision: 2, revisionAnswers: validAnswers() }), { startAt: "quiz" })
    expect(screen.getByRole("heading", { level: 2, name: /review your starting point/i })).toBeTruthy()
    expect(screen.getByText(/saves revision 3\. Revision 2 stays on file and nothing is overwritten/i)).toBeTruthy()
    await user.click(button(/save starting point/i))
    await waitFor(() => expect(h.onSubmitted).toHaveBeenCalledWith(3))
    expect(actions.submitBaselineAssessment).toHaveBeenCalledWith({ answers: validAnswers(), expectedBaseline: 2, expectedDraftVersion: null })
    expect(actions.saveBaselineDraft).not.toHaveBeenCalled() // an untouched update creates no draft
  })

  it("lets a delegated manager keep a draft for the owner but never submit", async () => {
    const user = userEvent.setup()
    mount(seed({ role: "manager", draft: draft(validAnswers(), 5) }), { startAt: "quiz" })
    expect(screen.getByText(/only the shop owner can save the starting point/i)).toBeTruthy()
    expect(screen.queryByRole("button", { name: /^save starting point$/i })).toBeNull()
    await user.click(button(/save draft for the owner/i))
    expect(await screen.findByText(/draft saved for the owner/i)).toBeTruthy()
    expect(actions.submitBaselineAssessment).not.toHaveBeenCalled()
  })

  it("does not claim a draft was saved when a manager changed nothing and none exists", async () => {
    const user = userEvent.setup()
    mount(seed({ role: "manager", baselineRevision: 2, revisionAnswers: validAnswers() }), { startAt: "quiz" })
    await user.click(button(/save draft for the owner/i))
    expect(await screen.findByText(/nothing has changed, so there is nothing to save/i)).toBeTruthy()
    expect(screen.queryByText(/draft saved for the owner/i)).toBeNull()
    expect(actions.saveBaselineDraft).not.toHaveBeenCalled()
    expect(actions.submitBaselineAssessment).not.toHaveBeenCalled()
  })

  it("saves a manager's edit as a draft against the version it started from", async () => {
    const user = userEvent.setup()
    mount(seed({ role: "manager", draft: draft(validAnswers(), 5) }), { startAt: "quiz" })
    await user.click(screen.getByRole("button", { name: /change: how many service bays/i }))
    const input = screen.getByRole("textbox", { name: /service bays or mobile crews/i })
    await user.clear(input)
    await user.type(input, "3")
    actions.saveBaselineDraft.mockResolvedValueOnce({ ok: true, data: { draftVersion: 6 } })
    await user.click(button(/save and continue/i)) // page 1 -> 2 saves the draft
    await waitFor(() => expect(actions.saveBaselineDraft).toHaveBeenCalledTimes(1))
    expect(actions.saveBaselineDraft.mock.calls[0][0].expectedDraftVersion).toBe(5)
    expect(actions.saveBaselineDraft.mock.calls[0][0].answers.service_bays).toEqual({ state: "value", value: 3, unit: "count" })
    expect(actions.submitBaselineAssessment).not.toHaveBeenCalled()
  })

  it("asks for a reload when the baseline or draft changed under the owner", async () => {
    const user = userEvent.setup()
    actions.submitBaselineAssessment.mockResolvedValue({ ok: false, code: "conflict" })
    const h = mount(completeDraft(), { startAt: "quiz" })
    await user.click(button(/save starting point/i))
    expect(await screen.findByText(/changed somewhere else/i)).toBeTruthy()
    expect(h.onSubmitted).not.toHaveBeenCalled()
    await user.click(button(/reload the latest/i))
    expect(h.onReload).toHaveBeenCalled()
  })

  it("shows a server rejection as questions to fix, never as success", async () => {
    const user = userEvent.setup()
    actions.submitBaselineAssessment.mockResolvedValue({ ok: false, code: "invalid", issues: [{ key: "calls_per_week", code: "out_of_range" }] })
    const h = mount(completeDraft(), { startAt: "quiz" })
    await user.click(button(/save starting point/i))
    expect(await screen.findByText(/1 answer needs attention/i)).toBeTruthy()
    expect(h.onSubmitted).not.toHaveBeenCalled()
  })

  it("says so when submitting could not reach the server", async () => {
    const user = userEvent.setup()
    actions.submitBaselineAssessment.mockResolvedValue({ ok: false, code: "unavailable" })
    const h = mount(completeDraft(), { startAt: "quiz" })
    await user.click(button(/save starting point/i))
    expect(await screen.findByText(/couldn’t save your answers/i)).toBeTruthy()
    expect(h.onSubmitted).not.toHaveBeenCalled()
  })
})
