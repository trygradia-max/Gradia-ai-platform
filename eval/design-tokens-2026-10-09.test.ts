import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const read = (rel: string) => readFileSync(rel, "utf8")

describe("2026-10-09 token and first-slice locks", () => {
  it("globals.css ships the founder charcoal / silver / violet tokens", () => {
    const css = read("src/app/globals.css")
    expect(css).toContain("--bg-canvas: #101217")
    expect(css).toContain("--bg-surface: #181b22")
    expect(css).toContain("--bg-raised: #222630")
    expect(css).toContain("--bg-hover: #2a303c")
    expect(css).toContain("--border-default: #303642")
    expect(css).toContain("--border-control: #64748b")
    expect(css).toContain("--text-primary: #f4f5f7")
    expect(css).toContain("--text-secondary: #a5adba")
    expect(css).toContain("--accent: #7c3aed")
    expect(css).toContain("--accent-hover: #6d28d9")
    expect(css).toContain("--accent-text: #a78bfa")
    expect(css).toContain("--primary-foreground: #ffffff")
    expect(css).toContain("--input: var(--border-control)")
    expect(css).toContain("--ring: var(--accent-text)")
    expect(css).toContain("--sidebar: var(--bg-surface)")
    expect(css).not.toContain("theme switch")
  })

  it("Home does not claim agents are watching when channels are off", () => {
    const hero = read("src/components/gradia/dashboard-hero.tsx")
    const copy = read("src/lib/strings.ts")
    expect(hero).not.toContain("agents watching")
    expect(hero).not.toContain("All ${channels.length} channels connected")
    expect(copy).toContain("channels connected")
    expect(hero).toContain("StatusPill")
  })

  it("KPI row does not draw decorative sparklines", () => {
    const kpis = read("src/components/gradia/kpi-row.tsx")
    expect(kpis).not.toContain("kpi-spark")
    expect(kpis).not.toContain("dynamic(")
  })

  it("opaque token pairs meet WCAG text and UI contrast floors", () => {
    const ratio = (fg: string, bg: string) => {
      const hex = (h: string) => {
        const n = parseInt(h.slice(1), 16)
        return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
      }
      const lin = (c: number) => {
        const s = c / 255
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }
      const lum = (h: string) => {
        const { r, g, b } = hex(h)
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
      }
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a)
      return (hi + 0.05) / (lo + 0.05)
    }
    expect(ratio("#f4f5f7", "#101217")).toBeGreaterThanOrEqual(4.5)
    expect(ratio("#f4f5f7", "#181b22")).toBeGreaterThanOrEqual(4.5)
    expect(ratio("#f4f5f7", "#222630")).toBeGreaterThanOrEqual(4.5)
    expect(ratio("#a5adba", "#101217")).toBeGreaterThanOrEqual(4.5)
    expect(ratio("#a5adba", "#181b22")).toBeGreaterThanOrEqual(4.5)
    expect(ratio("#a5adba", "#222630")).toBeGreaterThanOrEqual(4.5)
    expect(ratio("#ffffff", "#7c3aed")).toBeGreaterThanOrEqual(4.5)
    expect(ratio("#a78bfa", "#101217")).toBeGreaterThanOrEqual(3)
    expect(ratio("#64748b", "#222630")).toBeGreaterThanOrEqual(3)
    expect(ratio("#4ade80", "#181b22")).toBeGreaterThanOrEqual(4.5)
    expect(ratio("#fbbf24", "#181b22")).toBeGreaterThanOrEqual(4.5)
    expect(ratio("#fb7185", "#181b22")).toBeGreaterThanOrEqual(4.5)
  })

  it("activity filters are labelled as this-page display, not a database query", () => {
    const feed = read("src/components/gradia/activity-feed.tsx")
    expect(feed).toContain("ListToolbar")
    expect(feed).toContain("not the whole history")
    expect(feed).toContain('aria-pressed={filter === f}')
  })

  it("Team and Settings keep presentation wrappers with truthful pilot billing copy", () => {
    const team = read("src/app/team/page.tsx")
    const panel = read("src/app/team/team-panel.tsx")
    const delivery = read("src/app/team/delivery-reviews/page.tsx")
    const settings = read("src/app/(dashboard)/settings/page.tsx")
    const control = read("src/app/control-center/page.tsx")
    const billing = read("src/app/billing/page.tsx")
    const receptionist = read("src/app/(dashboard)/receptionist/page.tsx")
    expect(team).toContain("SectionHeader")
    expect(team).toContain("TeamChrome")
    expect(panel).toContain("min-h-11")
    expect(panel).toContain("border-border-control")
    expect(delivery).toContain("ReviewCard")
    expect(delivery).toContain("Pagination")
    expect(settings).not.toContain("text-muted-foreground/70")
    expect(control).toContain("SkipLink")
    expect(control).toContain("StatusPill")
    expect(billing).toContain("Your pilot terms are set with your Gradia contact")
    expect(billing).not.toContain("From $20/month")
    expect(billing).not.toContain("+$29")
    expect(receptionist).toContain("SectionHeader")
  })

  it("intake review reuses shared chrome and existing link actions only", () => {
    const queue = read("src/components/gradia/intake-review-queue.tsx")
    const page = read("src/app/intake/page.tsx")
    const historyPage = read("src/app/intake/[workflowId]/page.tsx")
    const identity = read("src/components/gradia/intake-identity-form.tsx")
    const vehicle = read("src/components/gradia/intake-vehicle-form.tsx")
    expect(queue).toContain("ReviewCard")
    expect(queue).toContain("StatusPill")
    expect(queue).toContain("Identity unresolved")
    expect(page).toContain("TeamChrome")
    expect(page).toContain("ListToolbar")
    expect(page).toContain("Pagination")
    expect(page).toContain("search_intake_customers")
    expect(page).toContain("does not select an identity or filter the intake queue")
    expect(historyPage).toContain("IntakeVehicleForm")
    expect(historyPage).toContain("TeamChrome")
    expect(identity).toContain("linkIntakeIdentity")
    expect(vehicle).toContain("linkIntakeVehicle")
    expect(queue).not.toContain("rejectIntake")
    expect(identity).not.toContain("createCustomer")
    expect(page).not.toContain("public-form")
  })

  it("login and onboarding keep labelled fields and 44px actions without new prices", () => {
    const login = read("src/components/gradia/login-form.tsx")
    const loginPage = read("src/app/login/page.tsx")
    const wizard = read("src/components/gradia/onboarding-wizard.tsx")
    const steps = read("src/components/gradia/onboarding-launch-steps.tsx")
    expect(login).toContain("FormField")
    expect(login).toContain("Work email")
    expect(login).toContain("min-h-11")
    expect(login).toContain("signInWithOtp")
    expect(login).toContain("signInWithOAuth")
    expect(loginPage).toContain("min-h-11")
    expect(wizard).toContain("FormField")
    expect(wizard).toContain("STRINGS.pages.onboarding.stepStatus(current)")
    expect(read("src/lib/strings.ts")).toContain("Step ${current} of 3")
    expect(wizard).toContain("fieldErrors")
    expect(wizard).toContain("saveShop")
    expect(steps).toContain("min-h-11")
    expect(steps).toContain("completeOnboarding")
    expect(steps).toContain("STRINGS.pages.onboarding.phoneOptionalBody")
    expect(read("src/lib/strings.ts")).toContain("+$29/month")
    expect(login).not.toContain("free trial")
    expect(wizard).not.toContain("free trial")
  })
})
