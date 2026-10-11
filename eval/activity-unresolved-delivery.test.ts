import { beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"

type Reply = { data: unknown; error: unknown }
const tables = vi.hoisted(() => ({ replies: {} as Record<string, Reply>, filters: [] as string[] }))
vi.mock("@/lib/shop", () => ({ getOptionalShop: async () => ({ id: "shop", name: "Synthetic" }) }))
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from(table: string) {
      const chain: Record<string, unknown> = {}
      for (const m of ["select", "eq", "in", "order", "limit", "not"])
        chain[m] = (...args: unknown[]) => { if (m === "not") tables.filters.push(`${table}.not(${args.join(",")})`); return chain }
      chain.then = (resolve: (r: Reply) => unknown) => resolve(tables.replies[table] ?? { data: [], error: null })
      return chain
    },
  }),
}))
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: ReactNode }) => createElement("a", { href }, children) }))
import { actionTitle, listActivityFeed, resolveActionOutcome, type ActivityFeedItem } from "@/lib/data/activity"
import { listRecentAgentActivity } from "@/lib/data/pending-actions"
import { ActivityFeed } from "@/components/gradia/activity-feed"

// The rows only: the filter chips above the list legitimately say "Handled".
const rows = (html: string) => html.slice(html.indexOf("<ul"))
const at = "2026-10-10T00:00:00Z"
const action = (id: string, patch: Record<string, unknown> = {}) => ({ id, action_type: "send_sms", payload: { body: "Fictional text" }, status: "approved", result_id: null, decided_at: at, created_at: at, ...patch })
beforeEach(() => { tables.replies = {}; tables.filters = [] })

describe("an approval is not a result", () => {
  const done = "2026-10-10T00:00:05Z"
  it.each([
    // [type, status, result, claim, claimsReadable, expected]
    ["send_sms", "approved", null, null, true, "unresolved"],
    ["send_sms", "approved", null, { completed_at: null }, true, "unresolved"],
    ["send_sms", "approved", "r", { completed_at: null }, true, "unresolved"],
    ["send_sms", "approved", null, { completed_at: done }, true, "unresolved"],
    ["send_sms", "pending", null, { completed_at: null }, true, "unresolved"],
    ["send_email", "rejected", null, { completed_at: null }, true, "unresolved"],
    ["send_email", "approved", "r", null, false, "unresolved"],
    ["book_appointment", "approved", null, null, true, "unresolved"],
    ["create_lead", "approved", null, null, true, "unresolved"],
    ["send_sms", "expired", "r", null, true, "unresolved"],
    ["send_sms", "approved", "r", { completed_at: done }, true, "handled"],
    ["send_sms", "approved", "r", null, true, "handled"],
    ["book_appointment", "approved", "r", null, false, "handled"],
    ["send_sms", "pending", null, null, true, "needs-you"],
    ["send_email", "edit_requested", null, null, true, "needs-you"],
    ["send_sms", "rejected", null, null, true, "dropped"],
  ] as const)("%s %s result=%s claim=%j readable=%s → %s", (type, status, result_id, claim, claimsReadable, expected) => {
    expect(resolveActionOutcome(type, { status, result_id, claim, claimsReadable })).toBe(expected)
  })
  it("never narrates an unconfirmed action in the past tense", () => {
    expect(actionTitle("send_sms", {}, "approved", "unresolved")).toBe("Text to a customer — delivery not confirmed")
    expect(actionTitle("send_email", { customer_name: "Fictional Lead" }, "approved", "unresolved")).toBe("Email to Fictional Lead — delivery not confirmed")
    expect(actionTitle("book_appointment", {}, "approved", "unresolved")).toBe("Booking for a customer — result not confirmed")
    for (const type of ["send_sms", "send_email", "book_appointment", "reschedule_appointment", "cancel_appointment", "create_lead", "create_quote"] as const)
      expect(actionTitle(type, {}, "approved", "unresolved")).not.toMatch(/Texted|Emailed|Booked|Logged|Handled|Saved/)
    expect(actionTitle("send_sms", {}, "approved", "handled")).toBe("Texted a customer")
  })
})

describe("Home and Activity feed", () => {
  it("the reported fixture: an approved text with no execution result is unresolved, not handled", async () => {
    tables.replies.pending_actions = { data: [action("a1")], error: null }
    const [item] = await listActivityFeed()
    expect(item).toMatchObject({ id: "action:a1", title: "Text to a customer — delivery not confirmed", outcome: "unresolved", href: "/approvals/a1" })
    const html = rows(renderToStaticMarkup(createElement(ActivityFeed, { items: [item] })))
    expect(html).toContain("Not confirmed"); expect(html).toContain("delivery not confirmed"); expect(html).toContain('href="/approvals/a1"'); expect(html).toContain("Review what happened")
    expect(html).not.toContain("Texted"); expect(html).not.toMatch(/>Handled</)
  })
  it("separates confirmed, claimed-but-unfinished, staged and dropped actions", async () => {
    tables.replies.pending_actions = { data: [
      action("sent", { result_id: "r1" }), action("claimed", { result_id: "r2" }), action("returned", { status: "pending" }),
      action("staged", { status: "pending" }), action("dropped", { status: "rejected" }), action("booked", { action_type: "book_appointment", result_id: "r3" }),
    ], error: null }
    tables.replies.service_proof_consumptions = { data: [
      { action_id: "sent", completed_at: at }, { action_id: "claimed", completed_at: null }, { action_id: "returned", completed_at: null },
    ], error: null }
    const byId = Object.fromEntries((await listActivityFeed()).map((i) => [i.id.replace("action:", ""), i]))
    expect(Object.fromEntries(Object.entries(byId).map(([k, v]) => [k, v.outcome]))).toEqual({ sent: "handled", claimed: "unresolved", returned: "unresolved", staged: "needs-you", dropped: "dropped", booked: "handled" })
    expect(byId.sent.title).toBe("Texted a customer"); expect(byId.sent.href).toBeNull()
    expect(byId.returned).toMatchObject({ title: "Text to a customer — delivery not confirmed", href: "/approvals/returned" })
    expect(byId.staged).toMatchObject({ title: "Staged a text to a customer", href: "/approvals" })
  })
  it("when sending claims cannot be read, no message is reported as sent", async () => {
    tables.replies.pending_actions = { data: [action("sms", { result_id: "r1" }), action("lead", { action_type: "create_lead", result_id: "r2" })], error: null }
    tables.replies.service_proof_consumptions = { data: null, error: { message: "private" } }
    const byId = Object.fromEntries((await listActivityFeed()).map((i) => [i.id, i.outcome]))
    expect(byId).toEqual({ "action:sms": "unresolved", "action:lead": "handled" })
  })
  it("an outcome this build does not recognise is never drawn as handled", () => {
    const base: ActivityFeedItem = { id: "x", kind: "action", at, title: "Fictional row", detail: null, because: null, outcome: "handled", href: null }
    const future = { ...base, id: "y", outcome: "something-new" } as unknown as ActivityFeedItem
    const html = rows(renderToStaticMarkup(createElement(ActivityFeed, { items: [future] })))
    expect(rows(renderToStaticMarkup(createElement(ActivityFeed, { items: [base] })))).toMatch(/>Handled</)
    expect(html).toContain("Not confirmed"); expect(html).not.toMatch(/>Handled</)
  })
})

describe("completed agent actions list", () => {
  it("only asks for actions with a recorded result and drops unfinished or unverifiable sends", async () => {
    tables.replies.pending_actions = { data: [action("done", { result_id: "r1" }), action("claimed", { result_id: "r2" }), action("lead", { action_type: "create_lead", result_id: "r3" })], error: null }
    tables.replies.service_proof_consumptions = { data: [{ action_id: "done", completed_at: at }, { action_id: "claimed", completed_at: null }], error: null }
    expect((await listRecentAgentActivity()).map((i) => i.id)).toEqual(["done", "lead"])
    expect(tables.filters).toContain("pending_actions.not(result_id,is,)")
    tables.replies.service_proof_consumptions = { data: null, error: { message: "private" } }
    expect((await listRecentAgentActivity()).map((i) => i.id)).toEqual(["lead"])
  })
})
