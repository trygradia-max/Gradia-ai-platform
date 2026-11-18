import { readFileSync, readdirSync } from "node:fs"
import { createElement, type ReactElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { BaselineReadResult, MeasurementRow, StartingPointDto } from "@/lib/onboarding-baseline/dto"
import { buildStartingPoint } from "@/lib/onboarding-baseline/report"
import { unk, validAnswers } from "./_baseline-fixtures"

const baseline = vi.hoisted(() => ({ getBaselineStartingPoint: vi.fn(), saveBaselineDraft: vi.fn(), submitBaselineAssessment: vi.fn() }))
const agents = vi.hoisted(() => ({ getAgentsHome: vi.fn() }))
vi.mock("@/app/actions/onboarding-baseline", () => baseline)
vi.mock("@/app/actions/agent-definitions", () => agents)
vi.mock("@/app/actions/onboarding", () => ({ completeOnboarding: vi.fn(), saveOnboardingProgress: vi.fn() }))
vi.mock("@/app/actions/shop", () => ({ saveShop: vi.fn() }))
vi.mock("@/app/actions/working-hours", () => ({ saveWorkingHours: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }))

import StartingPointPage from "@/app/(dashboard)/starting-point/page"
import AgentsPage from "@/app/(dashboard)/agents/page"
import { OnboardingWizard } from "@/components/gradia/onboarding-wizard"
import { StartingPointReport } from "@/components/gradia/starting-point/starting-point-report"
import { StartingPointAgentsNotice, StartingPointStatusCard } from "@/components/gradia/starting-point/starting-point-status-card"
import { WIZARD_STEP_ORDER, deriveWizardStep, readSavedWizardStep } from "@/lib/onboarding"

const src = (rel: string) => readFileSync(rel, "utf8")
const html = async (el: ReactElement | Promise<ReactElement>) => renderToStaticMarkup(await el)

const read = (over: Partial<BaselineReadResult> = {}): BaselineReadResult => ({
  role: "owner", pointer: { revision: 2, advanced_at: "2026-11-18T00:00:00Z" }, measurements: [], draft: null,
  revision: { revision: 2, catalog_version: "baseline.v1", answers: validAnswers(), reporting_period_start: "2026-08-20", reporting_period_end: "2026-11-17", supersedes_revision: 1, submitted_at: "2026-11-18T15:00:00Z" },
  ...over,
})
const ready = (over: Partial<BaselineReadResult> = {}) => {
  const dto = buildStartingPoint(read(over))
  if (dto.status !== "ready") throw new Error("expected ready")
  return dto
}
const notStarted = (withDraft = false): StartingPointDto =>
  buildStartingPoint({ role: "owner", pointer: null, revision: null, measurements: [], draft: withDraft ? { draft_version: 1, catalog_version: "baseline.v1", answers: {}, updated_by_role: "owner", updated_at: "2026-11-18T10:00:00Z" } : null })

beforeEach(() => {
  for (const fn of [...Object.values(baseline), ...Object.values(agents)]) fn.mockReset()
})

describe("report: evidence labels, measured vs estimated, no unsupported claims", () => {
  it("labels owner estimates, calculated figures and missing figures, with period, revision and version", () => {
    const out = renderToStaticMarkup(createElement(StartingPointReport, { dto: ready() }))
    expect(out).toContain("Revision 2, saved Nov 18, 2026. Question set baseline.v1.")
    expect(out).toContain("Your answers describe Aug 20, 2026 to Nov 17, 2026.")
    expect(out).toContain("Replaces revision 1, which stays on file.")
    for (const section of ["Response", "Booking", "Follow-up", "Operating load"]) expect(out).toContain(`>${section}</h3>`)
    expect(out).toContain("Owner estimate")
    expect(out).toContain("Calculated by Gradia from your answers.")
    expect(out).toContain("Your normal period, estimated for Aug 20, 2026 to Nov 17, 2026")
    expect(out).toContain("30 min to 4 hr") // a range stays a range
    expect(out).toContain("0 a month") // an explicit zero stays zero
    expect(out).toContain("Not measured yet") // missing is words, not a number
    expect(out).toContain("Not sure") // unknown is words, not a number
    expect(out).toContain("Gradia has not measured any of it yet")
    expect(out).toContain("What the labels mean")
    for (const label of ["Owner estimate", "Connected", "Observed by Gradia", "Not sure"]) expect(out).toContain(label)
  })

  it("separates measured evidence from estimates when evidence is attached", () => {
    const row: MeasurementRow = {
      id: "m1", metric_key: "inquiry_volume", definition_version: "v1", evidence_class: "gradia_observed", value: 100, unit: "count",
      window_start: "2026-09-01T00:00:00Z", window_end: "2026-10-01T00:00:00Z", source_system: null, source_ref: "interactions", formula_version: null, inputs: [],
    }
    const out = renderToStaticMarkup(createElement(StartingPointReport, { dto: ready({ measurements: [row] }) }))
    expect(out).toContain("Observed by Gradia")
    expect(out).toContain("Measured Sep 1, 2026 to Oct 1, 2026")
    expect(out).toContain("Some figures below are measured")
    expect(out).not.toContain("Gradia has not measured any of it yet")
  })

  it("shows unknown as 'Not sure' with the reason, never as a number", () => {
    const out = renderToStaticMarkup(createElement(StartingPointReport, { dto: ready({ revision: { ...read().revision!, answers: { ...validAnswers(), cancellations_no_shows_per_month: unk } } }) }))
    expect(out).toContain("You weren’t sure, so there is nothing to show. Gradia does not fill the gap.")
  })

  it("makes no claim about ROI, savings, revenue, improvement or causation", () => {
    const full = renderToStaticMarkup(createElement(StartingPointReport, { dto: ready() })).toLowerCase()
    expect(full).toContain("this report makes no claim about improvement, savings or revenue")
    // The disclaimer itself names what is not claimed; everything else must be free of those words.
    const out = full.replace(/this report makes no claim about improvement, savings or revenue\./, "")
    for (const banned of ["roi", "you saved", "savings", "revenue gained", "increased", "improved by", "because of gradia", "% better", "score"]) expect(out, banned).not.toContain(banned)
    expect(full).toContain("not comparable")
  })

  it("uses semantic structure: one article, named sections, definition lists, and icon+text status", () => {
    const out = renderToStaticMarkup(createElement(StartingPointReport, { dto: ready() }))
    expect(out).toContain('<article aria-labelledby="starting-point-report-title"')
    expect((out.match(/<section aria-labelledby=/g) ?? []).length).toBe(6)
    expect(out).toContain("<dl")
    expect(out).toContain('aria-hidden="true"') // decorative icons are hidden from assistive tech; every label is also text
    expect(out).toContain("<details")
  })
})

describe("status card: one entry point that tells the truth", () => {
  const card = (dto: StartingPointDto) => renderToStaticMarkup(createElement(StartingPointStatusCard, { dto }))
  it("invites an owner who has not started, with a link to the canonical route", () => {
    const out = card(notStarted())
    expect(out).toContain('href="/starting-point"')
    expect(out).toContain("Set your starting point")
    expect(out).toContain("Not started")
  })
  it("offers to finish a saved draft", () => {
    const out = card(notStarted(true))
    expect(out).toContain("Finish your starting point")
    expect(out).toContain("In progress")
    expect(out).toContain("Continue where you left off")
  })
  it("links an owner who finished to the report, naming the revision", () => {
    const out = card(ready())
    expect(out).toContain("Starting point, revision 2")
    expect(out).toContain('href="/starting-point"')
    expect(out).toContain("Saved")
  })
  it("says so when the status cannot be read, and shows nothing to an account without access", () => {
    expect(card({ status: "unavailable" })).toContain("Starting point status isn’t available right now")
    expect(card({ status: "forbidden" })).toBe("")
  })
  it("shows the Agent OS notice only while no starting point exists", () => {
    const notice = (dto: StartingPointDto) => renderToStaticMarkup(createElement(StartingPointAgentsNotice, { dto }))
    expect(notice(notStarted())).toContain('href="/starting-point"')
    expect(notice(ready())).toBe("")
    expect(notice({ status: "unavailable" })).toBe("")
    expect(notice({ status: "forbidden" })).toBe("")
  })
})

describe("navigation: one canonical route, reachable from the real flows", () => {
  const home = { role: "owner", canManage: true, activeAgentCount: 0, activeAgentLimit: 2, agents: [] }
  it("Agents home shows the notice while not started, and not once a starting point exists", async () => {
    agents.getAgentsHome.mockResolvedValue({ status: "ok", data: home })
    baseline.getBaselineStartingPoint.mockResolvedValue(notStarted())
    expect(await html(AgentsPage())).toContain('href="/starting-point"')
    baseline.getBaselineStartingPoint.mockResolvedValue(ready())
    expect(await html(AgentsPage())).not.toContain("/starting-point")
  })
  it("Agents home still renders when the baseline read fails, and still shows its own states", async () => {
    agents.getAgentsHome.mockResolvedValue({ status: "ok", data: home })
    baseline.getBaselineStartingPoint.mockRejectedValue(new Error("down"))
    expect(await html(AgentsPage())).toContain("Your Gradia agents")
    agents.getAgentsHome.mockResolvedValue({ status: "unavailable", reason: "x" })
    expect(await html(AgentsPage())).toContain("We couldn&#x27;t load this right now")
  })
  it("Home and Settings read the same session-derived status and render the shared card", () => {
    for (const rel of ["src/app/(dashboard)/dashboard/page.tsx", "src/app/(dashboard)/settings/page.tsx"]) {
      const s = src(rel)
      expect(s, rel).toContain("getBaselineStartingPoint()")
      expect(s, rel).toContain("StartingPointStatusCard")
      expect(s, rel).toContain('status: "unavailable"') // a failed read is a written state, never silent
    }
    expect(src("src/app/(dashboard)/settings/page.tsx")).toContain('{ id: "starting-point", label: "Starting point" }')
    expect(src("src/app/(dashboard)/settings/page.tsx")).toContain('<section id="starting-point">')
  })
  it("adds no competing navigation: the sidebar IA is unchanged and no legacy or duplicate route exists", () => {
    expect(src("src/components/gradia/app-sidebar.tsx")).not.toContain("starting-point")
    const routes = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? [e.name, ...routes(`${dir}/${e.name}`)] : []))
    const all = routes("src/app")
    expect(all.filter((r) => /starting|baseline|assessment|quiz/i.test(r))).toEqual(["starting-point"])
    expect(src("src/components/gradia/page-title.tsx")).toContain('["/starting-point", "Starting point"]')
  })
  it("the page is session-derived: it reads through the action with no shop argument, and `?revise=1` opens the questions", async () => {
    baseline.getBaselineStartingPoint.mockResolvedValue(notStarted())
    const out = await html(StartingPointPage({ searchParams: Promise.resolve({ revise: "1" }) }))
    expect(baseline.getBaselineStartingPoint).toHaveBeenCalledWith()
    expect(out).toContain("<h1")
    expect(out).toContain("Where your shop starts today")
    expect(out).toContain("Your team")
    baseline.getBaselineStartingPoint.mockResolvedValue(notStarted())
    const intro = await html(StartingPointPage({ searchParams: Promise.resolve({}) }))
    expect(intro).toContain("Start")
    expect(intro).not.toContain("Save and continue")
  })
  it("the page renders each failure as a written state", async () => {
    baseline.getBaselineStartingPoint.mockResolvedValue({ status: "forbidden" })
    expect(await html(StartingPointPage({ searchParams: Promise.resolve({}) }))).toContain("You don’t have access to this")
    baseline.getBaselineStartingPoint.mockResolvedValue({ status: "unavailable" })
    const out = await html(StartingPointPage({ searchParams: Promise.resolve({}) }))
    expect(out).toContain("We couldn’t load your starting point")
    expect(out).not.toContain("Not measured yet")
  })
  it("a loading file exists and uses skeletons, not a spinner", () => {
    const s = src("src/app/(dashboard)/starting-point/loading.tsx")
    expect(s).toContain("Skeleton")
    expect(s).toContain('aria-busy="true"')
    expect(s).not.toMatch(/Loader2|animate-spin/)
  })
})

describe("onboarding wizard: Starting point follows the business profile", () => {
  const shop = {
    id: "shop", name: "North Shore", location: "Boston", phone: null,
    settings: { business_kind: "general" as const, onboarding_step: 4 as const },
    twilio_phone_number: null, gradia_number_e164: null, voice_addon: false, voice_live: false,
  }
  const wizard = (initialStep: 1 | 2 | 3 | 4) =>
    renderToStaticMarkup(createElement(OnboardingWizard, { initialShop: shop as never, initialStep, a2pState: { status: "none", failureReason: null, business: null }, voiceOptions: [], vapiConfigured: false }))

  it("orders the steps business, starting point, number, help while ids stay stable", () => {
    expect(WIZARD_STEP_ORDER).toEqual([1, 4, 2, 3])
    expect(wizard(1)).toContain("Step 1 of 4")
    expect(wizard(4)).toContain("Step 2 of 4")
    expect(wizard(2)).toContain("Step 3 of 4")
    expect(wizard(3)).toContain("Step 4 of 4")
    const out = wizard(4)
    const labels = ["Your business", "Starting point", "Your number", "Your help"].map((l) => out.indexOf(`aria-label="${l}`))
    expect(labels.every((i) => i > -1)).toBe(true)
    expect([...labels].sort((a, b) => a - b)).toEqual(labels)
    expect(out).toContain('aria-current="step"')
  })
  it("renders the shared experience in the Starting point step (loading until the server answers)", () => {
    const out = wizard(4)
    expect(out).toContain("Loading your starting point")
    expect(out).toContain('aria-busy="true"')
  })
  it("keeps every previously saved place meaningful and accepts the new one", () => {
    expect(readSavedWizardStep({ onboarding_step: 1 })).toBe(1)
    expect(readSavedWizardStep({ onboarding_step: 2 })).toBe(2)
    expect(readSavedWizardStep({ onboarding_step: 3 })).toBe(3)
    expect(readSavedWizardStep({ onboarding_step: 4 })).toBe(4)
    expect(readSavedWizardStep({ onboarding_step: 5 })).toBeNull()
    expect(deriveWizardStep({ twilio_phone_number: null, settings: { onboarding_step: 4 } })).toBe(4)
    expect(deriveWizardStep({ twilio_phone_number: null, settings: { onboarding_step: 2 } })).toBe(2)
    expect(deriveWizardStep({ twilio_phone_number: null, settings: {} })).toBe(2) // unchanged for shops with no saved place
  })
  it("persists the Starting point as the place after the business is saved", () => {
    const s = src("src/app/actions/shop.ts")
    expect((s.match(/onboarding_step: 4/g) ?? []).length).toBe(2)
    expect(s).not.toContain("onboarding_step: 2")
    expect(src("src/app/actions/onboarding.ts")).toContain("z.literal(4)")
    expect(src("src/app/onboarding/page.tsx")).toContain("requested === 4")
  })
})

describe("mobile, motion and privacy contracts", () => {
  const files = readdirSync("src/components/gradia/starting-point").map((f) => `src/components/gradia/starting-point/${f}`)
  const all = files.map((f) => [f, src(f)] as const)
  it("keeps tap targets at 44px, stacks actions on small screens and fields in one column", () => {
    const quiz = src("src/components/gradia/starting-point/starting-point-quiz.tsx")
    const field = src("src/components/gradia/starting-point/question-field.tsx")
    expect(quiz).toContain("min-h-11")
    expect(quiz).toContain("flex-col-reverse gap-3 sm:flex-row")
    expect(field).toContain("min-h-11")
    expect(field).toContain("h-11")
    expect(field).toContain("sm:grid-cols-2") // two columns only from the sm breakpoint up
    expect(field).toContain('inputMode={decimal ? "decimal" : "numeric"}') // numeric keypad on phones
    expect(field).toContain("min-w-0") // long labels wrap instead of forcing horizontal scroll
    for (const [f, s] of all) expect(s, f).not.toMatch(/w-\[(\d{3,})px\]|min-w-\[\d{3,}px\]/)
  })
  it("stays calm: no motion library, nothing that ignores reduced motion", () => {
    for (const [f, s] of all) {
      expect(s, f).not.toContain("framer-motion")
      expect(s, f).not.toMatch(/animate-(pulse|bounce|ping)/)
    }
    expect(src("src/components/gradia/starting-point/starting-point-quiz.tsx")).toContain("motion-reduce:transition-none")
  })
  it("adds no analytics or tracking and writes nothing to logs or browser storage", () => {
    const sources = [...all, ["src/app/actions/onboarding-baseline.ts", src("src/app/actions/onboarding-baseline.ts")] as const, ["page", src("src/app/(dashboard)/starting-point/page.tsx")] as const]
    for (const [f, s] of sources) {
      expect(s, f).not.toMatch(/gtag|posthog|segment|mixpanel|amplitude|plausible|datadog|fbq|analytics/i)
      expect(s, f).not.toMatch(/console\.(log|info|debug|warn|error)/)
      expect(s, f).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/)
    }
  })
  it("uses semantic tokens only: no raw hex colour in any new component", () => {
    for (const [f, s] of all) expect(s, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })
  it("never labels a draft as saved without the server's confirmation", () => {
    const quiz = src("src/components/gradia/starting-point/starting-point-quiz.tsx")
    const setSaved = [...quiz.matchAll(/setStatus\(\{ kind: "saved"/g)].length
    expect(setSaved).toBeGreaterThan(0)
    // every "saved" status is set only on a confirmed result (r.ok / persist() true)
    expect(quiz).toMatch(/if \(r\.ok\) \{[\s\S]{0,200}kind: "saved"/)
  })
})
