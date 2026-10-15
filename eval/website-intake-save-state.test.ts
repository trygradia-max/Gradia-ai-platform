import { beforeEach, describe, expect, it, vi } from "vitest"
import { isValidElement, type ReactElement } from "react"
import { WebsiteIntakeCard } from "@/components/gradia/website-intake-card"

const h = vi.hoisted(() => ({ state: [] as unknown[], cursor: 0, save: vi.fn(), list: vi.fn() }))
vi.mock("react", async load => ({
  ...await load<typeof import("react")>(),
  useState: (initial: unknown) => {
    const i = h.cursor++
    if (!(i in h.state)) h.state[i] = initial
    return [h.state[i], (next: unknown) => { h.state[i] = typeof next === "function" ? next(h.state[i]) : next }]
  },
  useRef: (initial: unknown) => {
    const i = h.cursor++
    if (!(i in h.state)) h.state[i] = { current: initial }
    return h.state[i]
  },
}))
vi.mock("@/app/actions/public-intake-forms", () => ({ configurePublicIntakeForm: h.save, listPublicIntakeForms: h.list }))
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }))
const shopId = "00000000-0000-4000-8000-000000000001"
function elements(node: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<Record<string, unknown>>(node)) return []
  return [node, ...elements(node.props.children)]
}
function render() { h.cursor = 0; return elements(WebsiteIntakeCard({ shopId, initial: { ok: true, forms: [] } })) }
function typeOrigin() {
  const input = render().find(n => n.props.id === "website-intake-new-origin")!
  ;(input.props.onChange as (e: unknown) => void)({ target: { value: "https://example.test" } })
}
function add() { return render().find(n => Array.isArray(n.props.children) && n.props.children.includes("Add form (starts disabled)"))! }
function click() { (add().props.onClick as () => void)() }
beforeEach(() => { h.state = []; h.cursor = 0; vi.resetAllMocks() })
describe("website intake save reconciliation", () => {
  it("blocks repeat commands until the authenticated read finishes", async () => {
    let finish!: (value: unknown) => void
    h.save.mockResolvedValue({ ok: false, message: "Unconfirmed" })
    h.list.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    typeOrigin(); click(); click()
    await vi.waitFor(() => expect(h.list).toHaveBeenCalledOnce())
    expect(add().props.disabled).toBe(true)
    click(); expect(h.save).toHaveBeenCalledOnce()
    finish({ ok: true, forms: [] })
    await vi.waitFor(() => expect(add().props.disabled).toBe(false))
    click()
    await vi.waitFor(() => expect(h.save).toHaveBeenCalledTimes(2))
    expect(h.save.mock.calls[1][0]).toEqual(h.save.mock.calls[0][0])
  })
  it("removes mutation controls when reconciliation fails", async () => {
    h.save.mockRejectedValue(new Error("response lost"))
    h.list.mockResolvedValue({ ok: false })
    typeOrigin(); click()
    await vi.waitFor(() => expect(render().some(n => n.props.id === "website-intake-new-origin")).toBe(false))
    expect(h.save).toHaveBeenCalledOnce()
  })
  it("recognizes an uncertain create that committed and clears the add draft", async () => {
    h.save.mockResolvedValue({ ok: false, message: "Unconfirmed" })
    h.list.mockImplementation(async () => {
      const c = h.save.mock.calls[0][0]
      return { ok: true, forms: [{ id: c.formId, shop_id: shopId, allowed_origin: c.origin, revision: 1, enabled: false }] }
    })
    typeOrigin(); click()
    await vi.waitFor(() => expect(render().find(n => n.props.id === "website-intake-new-origin")?.props.value).toBe(""))
    expect(add().props.disabled).toBe(true)
    expect(h.save).toHaveBeenCalledOnce()
  })
})
