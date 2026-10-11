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
})
