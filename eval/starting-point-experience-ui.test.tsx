// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { BaselineReadResult, StartingPointDto } from "@/lib/onboarding-baseline/dto"
import { buildStartingPoint } from "@/lib/onboarding-baseline/report"
import { validAnswers } from "./_baseline-fixtures"

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }))
const actions = vi.hoisted(() => ({ saveBaselineDraft: vi.fn(), submitBaselineAssessment: vi.fn(), getBaselineStartingPoint: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => nav }))
vi.mock("@/app/actions/onboarding-baseline", () => actions)

import { StartingPointExperience } from "@/components/gradia/starting-point/starting-point-experience"

const read = (over: Partial<BaselineReadResult> = {}): BaselineReadResult => ({
  role: "owner", pointer: { revision: 1, advanced_at: "2026-11-18T00:00:00Z" }, measurements: [], draft: null,
  revision: { revision: 1, catalog_version: "baseline.v1", answers: validAnswers(), reporting_period_start: "2026-08-20", reporting_period_end: "2026-11-17", supersedes_revision: null, submitted_at: "2026-11-18T15:00:00Z" },
  ...over,
})
const ready = (over: Partial<BaselineReadResult> = {}): StartingPointDto => buildStartingPoint(read(over))
const notStarted = (draft: BaselineReadResult["draft"] = null): StartingPointDto =>
  buildStartingPoint({ role: "owner", pointer: null, revision: null, measurements: [], draft })
const draftRow = (answers: Record<string, unknown>) => ({ draft_version: 4, catalog_version: "baseline.v1", answers, updated_by_role: "owner" as const, updated_at: "2026-11-18T10:00:00Z" })

beforeEach(() => {
  for (const fn of [...Object.values(nav), ...Object.values(actions)]) fn.mockReset()
})
afterEach(cleanup)

describe("written states, never a blank or a zero report", () => {
  it("shows a loading skeleton, then the result", async () => {
    let resolve: (v: StartingPointDto) => void = () => {}
    actions.getBaselineStartingPoint.mockReturnValue(new Promise((r) => { resolve = r }))
    render(<StartingPointExperience mode="wizard" onDone={vi.fn()} onSkip={vi.fn()} />)
    const busy = screen.getByRole("status", { name: /loading your starting point/i })
    expect(busy.getAttribute("aria-busy")).toBe("true")
    expect(screen.queryByText(/not measured yet/i)).toBeNull()
    resolve(notStarted())
    expect(await screen.findByRole("heading", { name: /where your shop starts today/i })).toBeTruthy()
    expect(screen.queryByRole("status", { name: /loading your starting point/i })).toBeNull()
  })

  it("says it could not load when the first read throws, and retries on request", async () => {
    const user = userEvent.setup()
    actions.getBaselineStartingPoint.mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(ready())
    render(<StartingPointExperience mode="page" />)
    const alert = await screen.findByRole("alert")
    expect(within(alert).getByText(/couldn’t load your starting point/i)).toBeTruthy()
    expect(within(alert).getByText(/not an empty result and nothing was changed/i)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/not measured yet|0 a month|0%/)
    await user.click(screen.getByRole("button", { name: /try again/i }))
    expect(await screen.findByText(/where your shop started/i)).toBeTruthy()
    expect(actions.getBaselineStartingPoint).toHaveBeenCalledTimes(2)
  })

  it("renders an unavailable DTO from the server as an error with a retry, not as a report", () => {
    render(<StartingPointExperience mode="page" initial={{ status: "unavailable" }} />)
    expect(screen.getByRole("alert")).toBeTruthy()
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy()
    expect(screen.queryByRole("article")).toBeNull()
  })

  it("renders permission denied for an account without access, with a way out", () => {
    render(<StartingPointExperience mode="page" initial={{ status: "forbidden" }} />)
    expect(screen.getByText(/you don’t have access to this/i)).toBeTruthy()
    expect(screen.getByText(/only the shop owner, or a manager the owner has delegated/i)).toBeTruthy()
    expect(screen.getByRole("link", { name: /back to home/i }).getAttribute("href")).toBe("/dashboard")
    expect(screen.queryByRole("article")).toBeNull()
  })

  it("moves to permission denied when access is revoked while answering", async () => {
    const user = userEvent.setup()
    actions.saveBaselineDraft.mockResolvedValue({ ok: false, code: "forbidden" })
    render(<StartingPointExperience mode="page" initial={notStarted()} />)
    await user.click(screen.getByRole("button", { name: /^start$/i }))
    await user.type(screen.getByRole("textbox", { name: /service bays or mobile crews/i }), "2")
    await user.click(screen.getByRole("button", { name: /save and continue/i }))
    expect(await screen.findByText(/you don’t have access to this/i)).toBeTruthy()
  })
})

describe("first time, resume, completed and update", () => {
  it("opens a first-time owner on the explanation, and the update link goes straight to the questions", () => {
    render(<StartingPointExperience mode="page" initial={notStarted()} />)
    expect(screen.getByRole("button", { name: /^start$/i })).toBeTruthy()
    cleanup()
    render(<StartingPointExperience mode="page" initial={notStarted()} startInQuiz />)
    expect(screen.getByRole("heading", { level: 2, name: "Your team" })).toBeTruthy()
  })

  it("offers to continue a server draft for someone who has not submitted yet", async () => {
    const user = userEvent.setup()
    render(<StartingPointExperience mode="page" initial={notStarted(draftRow({ active_operators: { state: "value", value: 3, unit: "count" } }))} />)
    expect(screen.getByText(/answers you saved earlier are waiting/i)).toBeTruthy()
    await user.click(screen.getByRole("button", { name: /continue where you left off/i }))
    expect((screen.getByRole("textbox", { name: /how many people actively work on jobs/i }) as HTMLInputElement).value).toBe("3")
  })

  it("shows the saved report when one exists, and an update starts from those answers", async () => {
    const user = userEvent.setup()
    render(<StartingPointExperience mode="page" initial={ready()} />)
    expect(screen.getByRole("article")).toBeTruthy()
    expect(screen.getByText(/revision 1, saved nov 18, 2026\. question set baseline\.v1/i)).toBeTruthy()
    await user.click(screen.getByRole("button", { name: /update starting point/i }))
    expect(screen.getByRole("heading", { level: 2, name: /review your starting point/i })).toBeTruthy()
    expect(screen.getByText(/saves revision 2\. Revision 1 stays on file/i)).toBeTruthy()
    // Leaving the update without changes returns to the report.
    await user.click(screen.getByRole("button", { name: /^back$/i }))
    await user.click(screen.getByRole("button", { name: /^back$/i }))
    await user.click(screen.getByRole("button", { name: /^back$/i }))
    await user.click(screen.getByRole("button", { name: /^back$/i }))
    await user.click(screen.getByRole("button", { name: /^back$/i }))
    await user.click(screen.getByRole("button", { name: /^back$/i }))
    expect(screen.getByRole("article")).toBeTruthy()
  })

  it("points to an unfinished update draft next to the report", async () => {
    const user = userEvent.setup()
    render(<StartingPointExperience mode="page" initial={ready({ draft: draftRow({ ...validAnswers(), service_bays: { state: "value", value: 9, unit: "count" } }) })} />)
    expect(screen.getByText(/unfinished update saved as a draft/i)).toBeTruthy()
    await user.click(screen.getByRole("button", { name: /continue the draft/i }))
    expect(screen.getByText("9")).toBeTruthy() // the draft's answer, not the revision's
  })

  it("confirms a submission, reloads the saved report and leaves the update address", async () => {
    const user = userEvent.setup()
    actions.submitBaselineAssessment.mockResolvedValue({ ok: true, data: { revision: 2, kind: "superseded", supersedesRevision: 1 } })
    actions.getBaselineStartingPoint.mockResolvedValue(ready())
    render(<StartingPointExperience mode="page" initial={ready()} startInQuiz />)
    await user.click(screen.getByRole("button", { name: /save starting point/i }))
    expect(await screen.findByText(/starting point saved as revision 2/i)).toBeTruthy()
    expect(actions.submitBaselineAssessment).toHaveBeenCalledWith({ answers: validAnswers(), expectedBaseline: 1, expectedDraftVersion: null })
    expect(actions.getBaselineStartingPoint).toHaveBeenCalledTimes(1)
    expect(nav.replace).toHaveBeenCalledWith("/starting-point")
    expect(nav.refresh).toHaveBeenCalled()
    expect(screen.getByRole("article")).toBeTruthy()
  })

  it("reloads the latest server state after a conflict and restarts from it", async () => {
    const user = userEvent.setup()
    actions.submitBaselineAssessment.mockResolvedValue({ ok: false, code: "conflict" })
    actions.getBaselineStartingPoint.mockResolvedValue(ready({ draft: draftRow({ ...validAnswers(), service_bays: { state: "value", value: 7, unit: "count" } }) }))
    render(<StartingPointExperience mode="page" initial={ready()} startInQuiz />)
    await user.click(screen.getByRole("button", { name: /save starting point/i }))
    await user.click(await screen.findByRole("button", { name: /reload the latest/i }))
    await waitFor(() => expect(actions.getBaselineStartingPoint).toHaveBeenCalledTimes(1))
    expect(await screen.findByText("7")).toBeTruthy() // the newer draft now on screen
    expect(screen.queryByText(/changed somewhere else/i)).toBeNull()
  })
})

describe("inside the onboarding wizard", () => {
  it("lets a new shop skip, and says nothing else in setup depends on it", async () => {
    const user = userEvent.setup()
    const onSkip = vi.fn()
    actions.getBaselineStartingPoint.mockResolvedValue(notStarted())
    render(<StartingPointExperience mode="wizard" onSkip={onSkip} onDone={vi.fn()} />)
    await user.click(await screen.findByRole("button", { name: /skip for now/i }))
    expect(onSkip).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/nothing else in setup depends on it/i)).toBeTruthy()
    expect(actions.saveBaselineDraft).not.toHaveBeenCalled()
  })

  it("shows an already-completed starting point as done, with the report one click away", async () => {
    const user = userEvent.setup()
    const onDone = vi.fn()
    actions.getBaselineStartingPoint.mockResolvedValue(ready())
    render(<StartingPointExperience mode="wizard" onSkip={vi.fn()} onDone={onDone} />)
    expect(await screen.findByRole("heading", { name: /your starting point is saved/i })).toBeTruthy()
    expect(screen.getByText(/revision 1 is on file/i)).toBeTruthy()
    await user.click(screen.getByRole("button", { name: /continue setup/i }))
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it("continues setup after a successful save", async () => {
    const user = userEvent.setup()
    const onDone = vi.fn()
    actions.getBaselineStartingPoint.mockResolvedValueOnce(ready()).mockResolvedValueOnce(ready())
    actions.submitBaselineAssessment.mockResolvedValue({ ok: true, data: { revision: 2, kind: "superseded", supersedesRevision: 1 } })
    render(<StartingPointExperience mode="wizard" onSkip={vi.fn()} onDone={onDone} />)
    await user.click(await screen.findByRole("button", { name: /^update starting point$/i }))
    await user.click(screen.getByRole("button", { name: /save starting point/i }))
    expect(await screen.findByText(/starting point saved as revision 2/i)).toBeTruthy()
    await user.click(screen.getByRole("button", { name: /continue setup/i }))
    expect(onDone).toHaveBeenCalled()
    expect(nav.replace).not.toHaveBeenCalled() // the wizard stays put
  })
})
