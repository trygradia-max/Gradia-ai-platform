import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8")

/**
 * Source locks for the signed-in acceptance findings that are pure presentation. Each one was
 * reproduced in a real browser (axe wcag2aa, bounding-box overlap) before it was fixed.
 */
describe("signed-in acceptance: presentation locks", () => {
  it("topbar: the right cluster is content-sized below 2xl and the pills never wrap or shrink into the composer", () => {
    const shell = read("src/components/gradia/app-shell.tsx")
    expect(shell).toContain("lg:grid-cols-[minmax(10rem,1fr)_minmax(12rem,28rem)_auto]")
    expect(shell).toContain("2xl:grid-cols-[minmax(0,1fr)_minmax(0,28rem)_minmax(0,1fr)]")
    // The old symmetric template at lg let a ~340px cluster overflow a ~136-264px column.
    expect(shell).not.toMatch(/\blg:grid-cols-\[minmax\(0,1fr\)_minmax\(0,28rem\)_minmax\(0,1fr\)\]/)
    const setup = read("src/components/gradia/setup-progress-pill.tsx")
    expect(setup).toContain("whitespace-nowrap")
    expect(setup).toContain("2xl:inline")
    expect(setup).not.toContain("md:inline")
    expect(read("src/components/gradia/usage-pill.tsx")).toContain("shrink-0 items-center gap-1.5 whitespace-nowrap")
  })

  it("calendar: today's date uses the AA-safe accent text token, never raw primary on the dark canvas", () => {
    const week = read("src/components/gradia/calendar-week.tsx")
    expect(week).not.toContain('"text-primary"')
    expect(week.match(/isToday \? "text-accent-text" : "text-foreground"/g)).toHaveLength(2)
  })

  it("billing: the page has a level-1 heading", () => {
    expect(read("src/app/billing/page.tsx")).toMatch(/<CardTitle role="heading" aria-level=\{1\}/)
  })
})
