import { describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { readFileSync } from "node:fs"

import {
  WebsiteIntakeCard,
  websiteIntakeCreateCommand,
  websiteIntakeUpdateCommand,
} from "@/components/gradia/website-intake-card"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

const shopId = "00000000-0000-4000-8000-000000000001"
const formA = "00000000-0000-4000-8000-000000000011"
const formB = "00000000-0000-4000-8000-000000000012"

const enabledForm = {
  id: formA,
  shop_id: shopId,
  allowed_origin: "https://www.example.com",
  enabled: true,
  revision: 3,
}
const disabledForm = {
  id: formB,
  shop_id: shopId,
  allowed_origin: "https://shop.example.com",
  enabled: false,
  revision: 1,
}

function cardHtml(initial: Parameters<typeof WebsiteIntakeCard>[0]["initial"]) {
  return renderToStaticMarkup(
    createElement(WebsiteIntakeCard, { shopId, initial })
  )
}

describe("website intake setup presentation", () => {
  it("shows origin, state and revision per form with explicit enable/disable actions", () => {
    const html = cardHtml({ ok: true, forms: [enabledForm, disabledForm] })
    expect(html).toContain("Website intake")
    expect(html).toContain("https://www.example.com")
    expect(html).toContain("https://shop.example.com")
    expect(html).toContain("Enabled")
    expect(html).toContain("Disabled")
    expect(html).toContain("Revision 3")
    expect(html).toContain("Revision 1")
    expect(html).toContain(`POST /api/intake/public-form/${formA}`)
    expect(html).toContain("Edit origin")
    expect(html.match(/>Enable</g)?.length).toBe(1)
    expect(html.match(/>Disable</g)?.length).toBe(1)
  })

  it("starts with no forms and states new forms begin disabled", () => {
    const html = cardHtml({ ok: true, forms: [] })
    expect(html).toContain("No website forms yet")
    expect(html).toContain("new forms start disabled")
    expect(html).toContain("New forms always start disabled")
    expect(html).toContain("Add form (starts disabled)")
    expect(html).toContain("New form origin")
    expect(html).not.toContain("Revision")
  })

  it("denies non-owners without form controls", () => {
    const html = cardHtml({ ok: false })
    expect(html).toContain("Website intake")
    expect(html).toContain("Owner access is required")
    expect(html).toContain("an earlier save may have completed")
    // The only button is the help tooltip trigger — no form actions.
    expect(html.match(/<button/g)?.length).toBe(1)
    expect(html).toContain('aria-label="About Website intake"')
    expect(html).not.toContain("<input")
    expect(html).not.toContain("Add form")
    expect(html).not.toContain(">Enable<")
    expect(html).not.toContain(">Save<")
  })

  it("describes submissions honestly without inferring consent or identity", () => {
    const html = cardHtml({ ok: true, forms: [disabledForm] })
    expect(html).toContain("identity review")
    expect(html).toContain("unverified text")
    expect(html).toContain("is not consent")
    expect(html).not.toContain("will send")
    expect(html).not.toContain("automatically")
    expect(html).not.toContain("ready to quote")
  })

  it("labels every control for keyboard and assistive use", () => {
    const html = cardHtml({ ok: true, forms: [enabledForm] })
    expect(html).toContain("New form origin")
    expect(html).toContain("website-intake-new-origin")
    expect(html).toContain("Edit origin")
    expect(html).toContain("Add form (starts disabled)")
    // Every input carries an id with a matching label `for`.
    const ids = [...html.matchAll(/<input[^>]*id="([^"]+)"/g)].map((m) => m[1])
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) {
      expect(html).toContain(`for="${id}"`)
    }
  })

  it("uses fluid layout without fixed pixel widths", () => {
    const source = readFileSync(
      "src/components/gradia/website-intake-card.tsx",
      "utf8"
    )
    expect(source).not.toMatch(/w-\[\d+px\]|min-w-\[\d+px\]|max-w-\[\d+px\]/)
  })
})

describe("website intake command contract", () => {
  it("creates disabled at revision zero with a fresh id", () => {
    const first = websiteIntakeCreateCommand("https://www.example.com ")
    const second = websiteIntakeCreateCommand("https://www.example.com")
    expect(first.origin).toBe("https://www.example.com")
    expect(first.enabled).toBe(false)
    expect(first.revision).toBe(0)
    expect(first.formId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
    expect(second.formId).not.toBe(first.formId)
  })

  it("edits against the shown revision with an explicit enabled value", () => {
    expect(websiteIntakeUpdateCommand(disabledForm, { enabled: true })).toEqual({
      formId: formB,
      origin: "https://shop.example.com",
      enabled: true,
      revision: 1,
    })
    expect(
      websiteIntakeUpdateCommand(enabledForm, { origin: "https://new.example.com " })
    ).toEqual({
      formId: formA,
      origin: "https://new.example.com",
      enabled: true,
      revision: 3,
    })
    expect(websiteIntakeUpdateCommand(enabledForm, {})).toEqual({
      formId: formA,
      origin: "https://www.example.com",
      enabled: true,
      revision: 3,
    })
  })

  it("refreshes before another command and never silently retries", () => {
    const source = readFileSync(
      "src/components/gradia/website-intake-card.tsx",
      "utf8"
    )
    // Both success and failure paths re-read configuration first.
    expect(source).toContain("await listPublicIntakeForms(shopId)")
    expect(source).not.toMatch(/setTimeout|setInterval/)
    // No second executor, RPC, or storage write lives in this surface.
    expect(source).not.toMatch(/\.rpc\(|\.insert\(|\.update\(|\.upsert\(|localStorage|pending_actions/i)
    expect(source).toContain("Review the current revision before trying again")
  })
})
