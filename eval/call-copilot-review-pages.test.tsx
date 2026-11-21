import { renderToStaticMarkup } from "react-dom/server"
import type { ReactElement } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { CALL_ID, SHOP_ID, detail, vehicle } from "./_call-copilot-review-fixtures"

const mocks = vi.hoisted(() => ({ requireShop: vi.fn(), requireUser: vi.fn(), createClient: vi.fn(), rpc: vi.fn() }))
vi.mock("@/lib/shop", () => ({ requireShop: mocks.requireShop, requireUser: mocks.requireUser, getOptionalShop: vi.fn() }))
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), notFound: () => { throw new Error("NEXT_NOT_FOUND") } }))
vi.mock("@/app/actions/call-copilot-review", () => ({ approveCallProposal: vi.fn(), approveSelectedCallProposals: vi.fn(), dismissCallProposal: vi.fn() }))

import ListPage from "@/app/(dashboard)/calls/copilot/page"
import DetailPage from "@/app/(dashboard)/calls/copilot/[callId]/page"
import TeamList from "@/app/team/calls/page"
import TeamDetail from "@/app/team/calls/[callId]/page"

const html = async (el: Promise<ReactElement>) => renderToStaticMarkup(await el)
const listOf = (items: unknown[], next: unknown = null) => ({ viewer_role: "owner", can_approve: true, items, next_cursor: next })
const row = { call_id: CALL_ID, created_at: "2026-11-20T15:00:00Z", capture_status: "ended", capture_reason: "call_ended", call_ended: true, outcome_unknown: false, unresolved_gap: false, latest_revision: 1, coverage_status: "complete", proposals: { total: 1, awaiting: 1, review_only: 0, decided: 0 } }

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset()
  mocks.requireShop.mockResolvedValue({ id: SHOP_ID, name: "Test shop" })
  mocks.requireUser.mockResolvedValue({ id: "u" })
  mocks.createClient.mockResolvedValue({ rpc: mocks.rpc })
})

describe("owner list page", () => {
  const page = (sp: Record<string, string> = {}) => html(ListPage({ searchParams: Promise.resolve(sp) }) as never)

  it("reads only through the review function for the session's shop", async () => {
    mocks.rpc.mockResolvedValue({ data: listOf([row]), error: null })
    const out = await page()
    expect(mocks.rpc).toHaveBeenCalledWith("call_copilot_review_list", { p_shop: SHOP_ID, p_limit: 20, p_before_created: null, p_before_id: null })
    expect(out).toContain(`/calls/copilot/${CALL_ID}`)
    expect(out).toContain("1 waiting on you")
  })

  it("writes the empty state, the error state and the no-access state; never a blank page", async () => {
    mocks.rpc.mockResolvedValue({ data: listOf([]), error: null })
    expect(await page()).toContain("No calls to review yet")
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "57014" } })
    const err = await page()
    expect(err).toContain("Calls could not be loaded")
    expect(err).toContain('role="alert"')
    expect(err).not.toContain("No calls to review yet")
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "42501" } })
    expect(await page()).toContain("don&#x27;t have access")
  })

  it("ignores a hand-edited cursor and uses a valid one for the next page link", async () => {
    mocks.rpc.mockResolvedValue({ data: listOf([row], { created_at: "2026-11-20T14:00:00Z", id: CALL_ID }), error: null })
    const out = await page({ before: "garbage" })
    expect(mocks.rpc).toHaveBeenLastCalledWith("call_copilot_review_list", expect.objectContaining({ p_before_created: null }))
    expect(out).toContain("/calls/copilot?before=")
    await page({ before: `2026-11-20T15:00:00Z|${CALL_ID}` })
    expect(mocks.rpc).toHaveBeenLastCalledWith("call_copilot_review_list", expect.objectContaining({ p_before_created: "2026-11-20T15:00:00Z", p_before_id: CALL_ID }))
  })
})

describe("owner detail page", () => {
  const page = (callId = CALL_ID) => html(DetailPage({ params: Promise.resolve({ callId }) }) as never)

  it("rejects a non-uuid call id with a 404 before any read", async () => {
    await expect(page("../../etc/passwd")).rejects.toThrow("NEXT_NOT_FOUND")
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it("renders the review, and a call that is not this shop's is an indistinguishable 'not in this shop'", async () => {
    mocks.rpc.mockResolvedValue({ data: detail({ proposals: [vehicle(2)] }), error: null })
    const out = await page()
    expect(mocks.rpc).toHaveBeenCalledWith("call_copilot_review_detail", { p_shop: SHOP_ID, p_call: CALL_ID, p_revision: null })
    expect(out).toContain("Add a vehicle to the customer")
    mocks.rpc.mockResolvedValue({ data: { found: false }, error: null })
    expect(await page()).toContain("That call isn&#x27;t in this shop")
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "42501" } })
    expect(await page()).toContain("That call isn&#x27;t in this shop")
  })

  it("an unreadable answer offers a refresh and NO approve control, and does not say all is clear", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "57014" } })
    const out = await page()
    expect(out).toContain("could not be verified just now")
    expect(out).toContain("Refresh")
    expect(out).not.toMatch(/>Approve</)
    expect(out).not.toContain("Evidence is complete and current")
    mocks.rpc.mockResolvedValue({ data: { found: true, nonsense: 1 }, error: null })
    expect(await page()).toContain("could not be verified just now")
  })
})

describe("manager (read-only) team pages", () => {
  const ws = { id: SHOP_ID, name: "Shop", role: "manager", capabilities: ["crm.read"], location_id: "l" }
  beforeEach(() => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "team_workspaces") return { data: [ws], error: null }
      if (name === "call_copilot_review_list") return { data: { ...listOf([row]), viewer_role: "manager", can_approve: false }, error: null }
      return { data: detail({ viewer_role: "manager", can_approve: false, proposals: [vehicle(2)] }), error: null }
    })
  })

  it("lists calls with links that keep the shop selector and render no approve control", async () => {
    const out = await html(TeamList({ searchParams: Promise.resolve({}) }) as never)
    expect(out).toContain(`/team/calls/${CALL_ID}?shop=${SHOP_ID}`)
    expect(out).toContain("Only the shop owner can approve")
  })

  it("shows the detail read-only", async () => {
    const out = await html(TeamDetail({ params: Promise.resolve({ callId: CALL_ID }), searchParams: Promise.resolve({ shop: SHOP_ID }) }) as never)
    expect(out).toContain("Add a vehicle to the customer")
    expect(out).not.toMatch(/>Approve</)
    expect(out).not.toMatch(/type="checkbox"/)
  })

  it("a user without a manager crm.read grant for that shop sees the no-access state and no data", async () => {
    mocks.rpc.mockImplementation(async (name: string) => (name === "team_workspaces" ? { data: [{ ...ws, capabilities: ["notes.write"] }], error: null } : { data: detail(), error: null }))
    const out = await html(TeamDetail({ params: Promise.resolve({ callId: CALL_ID }), searchParams: Promise.resolve({ shop: SHOP_ID }) }) as never)
    expect(out).toContain("have access")
    expect(mocks.rpc).not.toHaveBeenCalledWith("call_copilot_review_detail", expect.anything())
  })
})
