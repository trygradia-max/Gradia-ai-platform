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
    expect(hero).not.toContain("agents watching")
    expect(hero).toContain("channels connected")
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

  it("Team and Settings keep presentation wrappers without new billing copy", () => {
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
    expect(billing).toContain("From $20/month")
    expect(billing).toContain("+$29")
    expect(receptionist).toContain("SectionHeader")
  })
})
