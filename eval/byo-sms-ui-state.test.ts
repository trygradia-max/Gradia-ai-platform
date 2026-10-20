import { beforeEach, describe, expect, it, vi } from "vitest"
import { isValidElement, type ReactElement } from "react"
import { ByoSmsAttestationCard } from "@/components/gradia/byo-sms-attestation-card"
const h = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, attest: vi.fn(), read: vi.fn(), revoke: vi.fn(), refresh: vi.fn() }))
vi.mock("react", async load => ({
  ...await load<typeof import("react")>(),
  useState: (initial: unknown) => {
    const i = h.cursor++; if (!(i in h.values)) h.values[i] = initial
    return [h.values[i], (next: unknown) => { h.values[i] = typeof next === "function" ? next(h.values[i]) : next }]
  },
  useRef: (initial: unknown) => { const i = h.cursor++; if (!(i in h.values)) h.values[i] = { current: initial }; return h.values[i] },
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh }) }))
vi.mock("@/app/actions/byo-sms-attestation", () => ({ attestByoSmsRegistration: h.attest, getByoSmsAttestation: h.read, revokeByoSmsRegistration: h.revoke }))
const state = { state: "unconfirmed" as const, phone_e164: "+15555550100", current_statement_version: "2026-10-16", last_event: null }
function elements(node: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<Record<string, unknown>>(node)) return []
  return [node, ...elements(node.props.children)]
}
function render() { h.cursor = 0; return elements(ByoSmsAttestationCard({ shopId: "00000000-0000-4000-8000-000000000001", initial: { ok: true, attestation: state } })) }
function checkbox() { return render().find(n => n.props.type === "checkbox")! }
function button() { return render().find(n => n.props.children === "Confirm texting registration")! }
function check() { (checkbox().props.onChange as (e: unknown) => void)({ target: { checked: true } }) }
function click() { (button().props.onClick as () => void)() }
beforeEach(() => { h.values = []; h.cursor = 0; vi.resetAllMocks() })
describe("own-number confirmation reconciliation", () => {
  it("blocks duplicate commands while reading an uncertain result", async () => {
    let finish!: (v: unknown) => void
    h.attest.mockResolvedValue({ ok: false, code: "uncertain" })
    h.read.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    check(); click(); click()
    await vi.waitFor(() => expect(h.read).toHaveBeenCalledOnce())
    expect(h.attest).toHaveBeenCalledOnce()
    finish({ ok: true, attestation: { ...state, state: "confirmed" } })
    await vi.waitFor(() => expect(render().some(n => n.props.children === "Withdraw confirmation")).toBe(true))
    expect(render().some(n => n.props.type === "checkbox")).toBe(false)
  })
  it("requires a fresh confirmation after the number changes", async () => {
    h.attest.mockResolvedValue({ ok: false, code: "number_changed" })
    h.read.mockResolvedValue({ ok: true, attestation: { ...state, phone_e164: "+15555550101" } })
    check(); click()
    await vi.waitFor(() => expect(h.read).toHaveBeenCalledOnce())
    expect(checkbox().props.checked).toBe(false)
    expect(button().props.disabled).toBe(true)
    check(); click()
    await vi.waitFor(() => expect(h.attest).toHaveBeenCalledTimes(2))
    expect(h.attest.mock.calls[1][0].phoneE164).toBe("+15555550101")
  })
  it("removes write controls after a lost response until a fresh read", async () => {
    h.attest.mockRejectedValue(new Error("lost response"))
    check(); click()
    await vi.waitFor(() => expect(render().some(n => n.props.type === "checkbox")).toBe(false))
    expect(h.refresh).not.toHaveBeenCalled()
  })
})
