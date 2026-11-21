import { describe, expect, it, vi } from "vitest"

import { reviewDetailSchema } from "@/lib/call-copilot/review-dto"
import { readCallReviewDetail, readCallReviewList } from "@/lib/call-copilot/review-read"
import { formatCallCursor, parseCallCursor } from "@/lib/call-review/cursor"
import { pickReviewWorkspace } from "@/lib/call-review/workspace"
import { CALL_ID, SHOP_ID, detail, vehicle } from "./_call-copilot-review-fixtures"

const db = (res: unknown) => ({ rpc: vi.fn(async () => res) }) as never
const dbOf = (client: { rpc: ReturnType<typeof vi.fn> }) => client as never

describe("review readers fail closed", () => {
  it("returns the parsed detail, and strips any field the DTO does not declare", async () => {
    const raw = { ...detail(), secret_column: "leak", proposals: [{ ...vehicle(2), internal: "x", staged: { ...vehicle(2).staged } }] }
    const r = await readCallReviewDetail(db({ data: raw, error: null }), { shopId: SHOP_ID, callId: CALL_ID })
    expect(r.status).toBe("ok")
    expect(JSON.stringify(r)).not.toMatch(/secret_column|"internal"/)
  })

  it("maps found:false to not_found, 42501 to forbidden, and everything else to unavailable", async () => {
    expect(await readCallReviewDetail(db({ data: { found: false }, error: null }), { shopId: SHOP_ID, callId: CALL_ID })).toEqual({ status: "not_found" })
    expect(await readCallReviewDetail(db({ data: null, error: { code: "42501" } }), { shopId: SHOP_ID, callId: CALL_ID })).toEqual({ status: "forbidden" })
    expect(await readCallReviewDetail(db({ data: null, error: { code: "57014" } }), { shopId: SHOP_ID, callId: CALL_ID })).toEqual({ status: "unavailable" })
    expect(await readCallReviewDetail(db({ data: { found: true }, error: null }), { shopId: SHOP_ID, callId: CALL_ID })).toEqual({ status: "unavailable" })
    expect(await readCallReviewDetail(db({ data: "not json {", error: null }), { shopId: SHOP_ID, callId: CALL_ID })).toEqual({ status: "unavailable" })
    const throwing = { rpc: vi.fn(async () => { throw new Error("network") }) }
    expect(await readCallReviewDetail(dbOf(throwing), { shopId: SHOP_ID, callId: CALL_ID })).toEqual({ status: "unavailable" })
  })

  it("rejects bad identifiers and revisions without calling the database", async () => {
    const c = { rpc: vi.fn() }
    expect(await readCallReviewDetail(dbOf(c), { shopId: "nope", callId: CALL_ID })).toEqual({ status: "unavailable" })
    expect(await readCallReviewDetail(dbOf(c), { shopId: SHOP_ID, callId: "nope" })).toEqual({ status: "unavailable" })
    expect(await readCallReviewDetail(dbOf(c), { shopId: SHOP_ID, callId: CALL_ID, revision: 0 })).toEqual({ status: "unavailable" })
    expect(await readCallReviewList(dbOf(c), { shopId: "nope" })).toEqual({ status: "unavailable" })
    expect(c.rpc).not.toHaveBeenCalled()
  })

  it("rejects an answer that carries an unknown enum, a malformed token or too many proposals", () => {
    const bad = (mut: (d: ReturnType<typeof detail>) => void) => { const d = detail(); mut(d); return reviewDetailSchema.safeParse(d).success }
    expect(bad(() => {})).toBe(true)
    expect(bad((d) => { (d.capture as { status: string }).status = "teleported" })).toBe(false)
    expect(bad((d) => { d.proposals[0]!.review_token = "short" })).toBe(false)
    expect(bad((d) => { d.proposals = Array.from({ length: 61 }, (_, i) => vehicle(i + 1)) })).toBe(false)
    expect(bad((d) => { (d.proposals[0]!.fields[0]!.citations[0] as { state: string }).state = "peek" })).toBe(false)
  })

  it("accepts the derived (hash-shaped, non-RFC) pending action id a real proposal carries", () => {
    const d = detail()
    d.proposals[0]!.action_id = "7f3c9a10-5be2-93d4-0a1b-2c3d4e5f6a7b"
    expect(reviewDetailSchema.safeParse(d).success).toBe(true)
    d.proposals[0]!.action_id = "not-an-id"
    expect(reviewDetailSchema.safeParse(d).success).toBe(false)
  })

  it("clamps the list page size and passes the cursor through", async () => {
    const c = { rpc: vi.fn(async () => ({ data: { viewer_role: "owner", can_approve: true, items: [], next_cursor: null }, error: null })) }
    await readCallReviewList(dbOf(c), { shopId: SHOP_ID, limit: 9999, before: { createdAt: "2026-11-20T15:00:00Z", id: CALL_ID } })
    expect(c.rpc).toHaveBeenCalledWith("call_copilot_review_list", { p_shop: SHOP_ID, p_limit: 25, p_before_created: "2026-11-20T15:00:00Z", p_before_id: CALL_ID })
    await readCallReviewList(dbOf(c), { shopId: SHOP_ID, limit: -3 })
    expect(c.rpc).toHaveBeenLastCalledWith("call_copilot_review_list", expect.objectContaining({ p_limit: 1, p_before_created: null }))
  })
})

describe("cursor and workspace selectors are never authority", () => {
  it("round-trips a valid cursor and treats anything else as no cursor", () => {
    const c = { createdAt: "2026-11-20T15:00:00.123456Z", id: CALL_ID }
    expect(parseCallCursor(formatCallCursor(c))).toEqual(c)
    for (const bad of [undefined, "", "x", `2026-13-45T99:00:00Z|${CALL_ID}`, "2026-11-20T15:00:00Z|nope", `2026-11-20T15:00:00Z|${CALL_ID}|extra`, "a".repeat(200), ["a", "b"]]) {
      expect(parseCallCursor(bad as never)).toBeNull()
    }
  })

  it("lists only manager workspaces with crm.read for the read-only team route", () => {
    const ws = [
      { id: "a", name: "A", role: "owner", capabilities: [], location_id: "l" },
      { id: "b", name: "B", role: "manager", capabilities: ["notes.write"], location_id: "l" },
      { id: "c", name: "C", role: "manager", capabilities: ["crm.read"], location_id: "l" },
      { id: "d", name: "D", role: "staff", capabilities: ["crm.read"], location_id: "l" },
    ] as never[]
    expect(pickReviewWorkspace(ws, undefined)?.id).toBe("c")
    expect(pickReviewWorkspace(ws, "c")?.id).toBe("c")
    expect(pickReviewWorkspace(ws, "b")).toBeNull()
    expect(pickReviewWorkspace(ws, "a")).toBeNull()
    expect(pickReviewWorkspace(ws, "d")).toBeNull()
    expect(pickReviewWorkspace([], undefined)).toBeNull()
  })
})
