import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * B-14 — daily navigation is five screens plus Settings.
 * Pipeline is its own page. Approvals and Activity are Chief of Staff
 * sections. The inbox does not host Ask Gradia.
 */

const ROOT = decodeURIComponent(new URL("../", import.meta.url).pathname)
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8")

describe("B-14 navigation", () => {
  const sidebar = read("src/components/gradia/app-sidebar.tsx")

  it("names the five daily screens and pins only Settings", () => {
    for (const label of [
      "Chief of Staff",
      "Inbox",
      "Pipeline",
      "Customers",
      "Calendar",
      "Settings",
    ]) {
      expect(sidebar).toContain(`label: "${label}"`)
    }
    expect(sidebar).not.toContain('label: "Home"')
    expect(sidebar).not.toContain('label: "Approvals"')
    expect(sidebar).not.toContain('label: "Activity"')
    expect(sidebar).not.toContain('label: "Conversations"')
    expect(sidebar).not.toContain('label: "Receptionist"')
    expect(sidebar).not.toContain('label: "Numbers & Billing"')
    expect(sidebar).toContain('badge={item.href === "/dashboard" ? approvalsCount : 0}')
  })

  it("splits pipeline, customers, and quotes onto their own routes", () => {
    const customers = read("src/app/(dashboard)/customers/page.tsx")
    const pipeline = read("src/app/(dashboard)/pipeline/page.tsx")
    expect(customers).not.toContain("PipelineBoard")
    expect(customers).toContain('redirect("/pipeline")')
    expect(customers).toContain('redirect("/customers/quotes")')
    expect(pipeline).toContain("PipelineBoard")
    expect(read("src/app/(dashboard)/customers/quotes/page.tsx")).toContain("QuotesList")
    expect(read("src/components/gradia/quote-builder.tsx")).not.toContain("tab=quotes")
  })

  it("folds Approvals and Activity into Chief of Staff and keeps the inbox to threads", () => {
    const home = read("src/app/(dashboard)/dashboard/page.tsx")
    expect(home).toContain('id="needs-you"')
    expect(home).toContain('id="activity"')
    expect(read("src/app/(dashboard)/approvals/page.tsx")).toContain(
      'redirect("/dashboard#needs-you")'
    )
    expect(read("src/app/(dashboard)/activity/page.tsx")).toContain(
      'redirect("/dashboard#activity")'
    )
    const inbox = read("src/app/(dashboard)/conversations/page.tsx")
    expect(inbox).toContain("ConversationThreads")
    expect(inbox).not.toContain("BiChat")
    expect(read("src/app/(dashboard)/settings/page.tsx")).toContain('href="/receptionist"')
    expect(read("src/app/(dashboard)/settings/page.tsx")).toContain('href="/billing"')
  })
})
