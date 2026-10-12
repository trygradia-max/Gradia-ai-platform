import { createElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import ThreadPage from "@/app/conversations/[customerId]/page"

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock("@/lib/shop", () => ({ requireUser: vi.fn() }))
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc }) }))
vi.mock("@/app/conversations/load-inbox", () => ({
  loadInboxIndex: async () => ({
    shop: { id: "00000000-0000-4000-8000-000000000010", name: "Synthetic" },
    shops: [], page: 1, data: null,
  }),
}))
vi.mock("@/components/gradia/inbox-frame", () => ({
  InboxFrame: ({ children }: { children: ReactNode }) => createElement("div", null, children),
}))
vi.mock("@/components/gradia/whisper-inbox-controls", () => ({
  WhisperInboxControls: () => createElement("button", null, "Mutation controls"),
}))

async function render(customerId = "00000000-0000-4000-8000-000000000001") {
  return renderToStaticMarkup(await ThreadPage({
    params: Promise.resolve({ customerId }),
    searchParams: Promise.resolve({
      shop: "00000000-0000-4000-8000-000000000010", channel: "email",
    }),
  }))
}

beforeEach(() => rpc.mockReset())

describe("thread read failure presentation", () => {
  it("reserves access guidance for a permission refusal", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "private detail" } })
    const html = await render()
    expect(html).toContain("Check access and refresh.")
    expect(html).not.toContain("private detail")
    expect(html).not.toContain("Mutation controls")
    expect(html).toContain("Refresh conversation")
  })

  it.each(["", "502", "PGRST000", "57014"])("offers retry for %s without alleging lost access", async (code) => {
    rpc.mockResolvedValue({ data: null, error: { code, message: "private gateway detail" } })
    const html = await render()
    expect(html).toContain("Conversation could not be loaded. Refresh to try again.")
    expect(html).not.toContain("Check access")
    expect(html).not.toContain("private gateway detail")
    expect(html).not.toContain("Mutation controls")
    expect(html).not.toContain("No messages on this page.")
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it("treats malformed success data as a load failure, not an empty thread", async () => {
    rpc.mockResolvedValue({ data: { unexpected: true }, error: null })
    const html = await render()
    expect(html).toContain("Conversation could not be loaded.")
    expect(html).not.toContain("Check access")
    expect(html).not.toContain("Mutation controls")
  })

  it("does not query an invalid thread identifier or claim a permission refusal", async () => {
    const html = await render("not-a-uuid")
    expect(rpc).not.toHaveBeenCalled()
    expect(html).toContain("Conversation could not be loaded.")
    expect(html).not.toContain("Check access")
  })
})
