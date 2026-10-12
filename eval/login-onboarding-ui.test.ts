import { describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { LoginForm } from "@/components/gradia/login-form"

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}))

describe("login presentation", () => {
  it("labels the email field, keeps 44px actions, and does not invent a password or trial", () => {
    const html = renderToStaticMarkup(createElement(LoginForm))
    expect(html).toContain("Work email")
    expect(html).toContain('for="email"')
    expect(html).toContain("Continue with Google")
    expect(html).toContain("Email me a link")
    expect(html).toContain("min-h-11")
    expect(html).not.toContain('type="password"')
    expect(html).not.toContain("free trial")
    expect(html).not.toContain("$99")
  })
})
