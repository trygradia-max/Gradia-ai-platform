import { createElement, type ReactNode } from "react"
import { readFileSync } from "node:fs"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, it, expect, vi } from "vitest"
import { WhisperInboxControls } from "@/components/gradia/whisper-inbox-controls"
import {
  WhisperConversationList,
  WhisperThreadView,
  WhisperWorkspaceUnavailable,
} from "@/components/gradia/whisper-inbox-presentation"
import ConversationsLoading from "@/app/conversations/loading"
import type { WhisperThread } from "@/lib/whisper-inbox"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock("@/app/actions/whisper-inbox", () => ({ updateWhisperInbox: vi.fn() }))

const id = "00000000-0000-4000-8000-000000000001"
const shopId = "00000000-0000-4000-8000-000000000010"
const thread: WhisperThread = {
  latest_id: id,
  revision: 1,
  state: "held",
  reason: "Review",
  assignee_id: null,
  can_manage: true,
  can_reply: true,
  customer_id: id,
  channel: "sms",
  customer: { name: "Synthetic", phone: "+15550000000", email: "fictional@example.test" },
  items: [],
  members: [{ id, name: "<script>private</script>" }],
  intakes: [],
  actions: [],
}

const render = (patch: Partial<WhisperThread> = {}) =>
  renderToStaticMarkup(
    createElement(WhisperInboxControls, {
      shopId,
      thread: { ...thread, ...patch },
      commands: { read: id, handoff: id, reply: id },
    })
  )

function uid(n: number) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
}

function labelsPointAtControls(html: string) {
  const labelIds = [...html.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)].map((match) => match[1])
  expect(labelIds.length).toBeGreaterThan(0)
  for (const labelId of labelIds) expect(html).toContain(`id="${labelId}"`)
  for (const match of html.matchAll(/aria-describedby="([^"]+)"/g)) {
    for (const describedId of match[1].split(" ")) expect(html).toContain(`id="${describedId}"`)
  }
}

describe("Whisper role-aware controls", () => {
  it("assigned staff get read acknowledgement without management or reply controls", () => {
    const html = render({ can_manage: false, can_reply: false })
    expect(html).toContain("Mark read for me")
    expect(html).not.toContain("Save handoff")
    expect(html).not.toContain("Queue draft")
    expect(html).not.toContain("Responsible operator")
  })
  it("authorized managers get handoff controls without owner-only approval staging", () => {
    const html = render({ can_reply: false })
    expect(html).toContain("Save handoff")
    expect(html).not.toContain("Queue draft")
    expect(html).toContain("&lt;script&gt;")
    expect(html).not.toContain("<script>")
    expect(html).toContain('value="held" selected=""')
    labelsPointAtControls(html)
  })
  it("missing destinations and voice history cannot expose usable send controls", () => {
    const html = render({ customer: { ...thread.customer, phone: null } })
    expect(html).toMatch(/<button disabled=""[^>]*>Queue draft in Approvals/)
    expect(html).toContain("No phone number is on file, so a draft cannot be queued.")
    const voice = render({ channel: "voice" })
    expect(voice).not.toContain("Queue draft")
    expect(voice).toContain("does not stage a call reply")
  })
  it("email discloses approval and threading limitations rather than promising delivery", () => {
    const html = render({ channel: "email" })
    expect(html).toContain("Subject")
    expect(html).toContain("Marketing consent is required")
    expect(html).toContain("not yet a provider-threaded reply")
    expect(html).toContain("Completion does not mean a message was delivered")
    expect(html).toContain("do not pause or cancel queued actions")
    expect(html).toContain("focus-visible:ring-3")
    labelsPointAtControls(html)
    expect(html).not.toContain("Delivered")
  })
})

describe("Whisper conversation list presentation", () => {
  const longPreview = `${"A".repeat(80)}<script>alert(1)</script>${"B".repeat(80)}`
  const item = {
    id,
    customer_id: id,
    customer_name: "Synthetic & <script>name</script>",
    channel: "sms" as const,
    preview: longPreview,
    created_at: "2026-10-05T15:00:00.000Z",
    unread: true,
    notified: true,
    state: "needs_reply" as const,
    assignee: "Owner fallback",
  }

  function list(
    data: { unidentified: number; notifications: number; items: Array<typeof item> } | null,
    page = 1
  ) {
    return renderToStaticMarkup(
      createElement(WhisperConversationList, {
        shops: [
          { id: shopId, name: "North & <script>shop</script>" },
          { id, name: "Second shop" },
        ],
        shopId,
        page,
        data,
      })
    )
  }

  it("escapes names, wraps long previews, and keeps paging at the existing 20-row window", () => {
    const items = Array.from({ length: 21 }, (_, index) => ({
      ...item,
      id: uid(index + 1),
      customer_id: uid(index + 1),
    }))
    const html = list({ unidentified: 2, notifications: 1, items })
    expect(html).toContain("&lt;script&gt;")
    expect(html).not.toContain("<script>")
    expect(html).toContain("overflow-wrap:anywhere")
    expect(html).toContain("Skip to conversations")
    expect(html).toContain('aria-current="page"')
    expect(html).toContain("New handoff")
    expect(html).toContain("Unread")
    expect(html).toContain("Needs reply")
    expect(html).toContain("Recorded")
    expect(html).toContain("role=\"alert\"")
    expect(html).toContain("role=\"status\"")
    expect(html).toContain("They have not been combined into one customer thread.")
    expect(html).toContain("Manager email notifications are disabled.")
    expect(html).toContain(`href="/intake?shop=${shopId}"`)
    expect(html.match(/href="\/conversations\/00000000/g)).toHaveLength(20)
    expect(html).toContain(`href="/conversations?shop=${shopId}&amp;page=2"`)
    expect(html.indexOf("Skip to conversations")).toBeLessThan(html.indexOf("Synthetic"))
    expect(html).not.toContain("Delivered")
  })

  it("distinguishes a failed load from an empty page", () => {
    const failed = list(null)
    expect(failed).toContain("Conversations could not be loaded. This is not an empty inbox.")
    expect(failed).toContain('role="alert"')
    expect(failed).not.toContain("No visible conversations on this page.")
    const empty = list({ unidentified: 0, notifications: 0, items: [] }, 2)
    expect(empty).toContain("No visible conversations on this page.")
    expect(empty).not.toContain("could not be loaded")
    expect(empty).not.toContain('role="status"')
    expect(empty).toContain("Page 2")
    expect(empty).toContain("Previous")
    expect(empty).not.toContain("Next")
  })

  it("states when the workspace itself is unavailable", () => {
    const html = renderToStaticMarkup(createElement(WhisperWorkspaceUnavailable))
    expect(html).toContain("Conversation workspace unavailable.")
    expect(html).toContain('href="/team"')
    expect(html).toContain('role="alert"')
  })
})

describe("Whisper thread presentation", () => {
  const occurred = "2026-10-04T12:00:00.000Z"
  const recorded = "2026-10-05T12:00:00.000Z"
  const message = {
    id,
    role: "customer" as const,
    content: `${"C".repeat(90)}<script>drop</script>`,
    created_at: recorded,
    occurred_at: occurred,
  }

  function view(
    patch: Partial<WhisperThread> | null,
    page = 1,
    controls?: ReactNode
  ) {
    return renderToStaticMarkup(
      createElement(WhisperThreadView, {
        listHref: `/conversations?shop=${shopId}`,
        refreshHref: `/conversations/${id}?shop=${shopId}&channel=sms`,
        page,
        thread: patch === null ? null : { ...thread, items: [message], ...patch },
        shopId,
        customerId: id,
        controls,
      })
    )
  }

  it("shows occurrence time, late recording, wrapped text, and owner links only", () => {
    const html = view({
      customer: { ...thread.customer, name: "Synthetic <script>customer</script>" },
      intakes: [{ id: uid(3), vehicle_id: uid(4) }],
      actions: [{ id: uid(5), status: "approved", result_id: null }],
      items: [
        message,
        { ...message, id: uid(6), role: "gradia", content: "Staged draft", created_at: occurred, occurred_at: occurred },
        { ...message, id: uid(7), role: "system", content: "System note", created_at: occurred, occurred_at: occurred },
      ],
    })
    expect(html).toContain("&lt;script&gt;")
    expect(html).not.toContain("<script>")
    expect(html).toContain("overflow-wrap:anywhere")
    expect(html).toContain(`dateTime="${occurred}"`)
    expect(html).toContain(`dateTime="${recorded}"`)
    expect(html).toContain("Customer")
    expect(html).toContain("Gradia")
    expect(html).toContain("System")
    expect(html).toContain(`href="/customers/${id}"`)
    expect(html).toContain(`href="/intake/${uid(3)}?shop=${shopId}"`)
    expect(html).toContain(`href="/approvals/${uid(5)}"`)
    expect(html).toContain("execution unconfirmed; review, do not resend")
    expect(html).toContain("Vehicle reference")
    expect(html).toContain("Skip to conversation")
    expect(html.indexOf("Skip to conversation")).toBeLessThan(html.indexOf("Message history"))
  })

  it("keeps held, empty, unavailable, and older-page states distinct", () => {
    const held = view({ reason: "", state: "held", items: [] })
    expect(held).toContain(
      "Execution is unconfirmed. Review approval and provider evidence; never automatically resend."
    )
    expect(held).toContain("No messages on this page.")
    const unavailable = view(null)
    expect(unavailable).toContain("Conversation unavailable. Check access and refresh.")
    expect(unavailable).not.toContain("No messages on this page.")
    expect(unavailable).toContain("Refresh conversation")
    const staff = view({ can_reply: false, can_manage: false, actions: [], intakes: [] })
    expect(staff).not.toContain("Customer record")
    expect(staff).not.toContain("/approvals/")
    const older = view(
      {
        items: Array.from({ length: 21 }, (_, index) => ({
          ...message,
          id: uid(index + 20),
          created_at: occurred,
          occurred_at: occurred,
        })),
      },
      2
    )
    expect(older).toContain("Newer messages")
    expect(older).toContain("Older messages")
    expect(older).toContain("Read, handoff and draft controls stay on the newest messages.")
    expect(older.match(/<time /g)).toHaveLength(20)
    const confirmed = view({
      state: "completed",
      actions: [{ id: uid(8), status: "approved", result_id: uid(9) }],
    })
    expect(confirmed).not.toContain("execution unconfirmed")
    expect(confirmed).toContain("Completed by operator")
    expect(confirmed).not.toContain("Delivered")
  })
})

describe("Whisper loading and server boundaries", () => {
  it("announces loading without presenting an empty inbox", () => {
    const html = renderToStaticMarkup(createElement(ConversationsLoading))
    expect(html).toContain("Loading conversations")
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('aria-hidden="true"')
    expect(html).not.toContain("No visible conversations")
    expect(html).not.toContain("Queue draft")
  })

  it("leaves queries, revisions, and command identity in the server pages", () => {
    const list = readFileSync("src/app/conversations/page.tsx", "utf8")
    const threadPage = readFileSync("src/app/conversations/[customerId]/page.tsx", "utf8")
    const controls = readFileSync("src/components/gradia/whisper-inbox-controls.tsx", "utf8")
    expect(list).toContain('db.rpc("list_whisper_threads"')
    expect(list).toContain("p_offset: (page - 1) * 20")
    expect(list).toContain("FEATURES.askGradiaPage && active?.id === shop.id")
    expect(threadPage).toContain('db.rpc("read_whisper_thread"')
    expect(threadPage).toContain("p_offset: (page - 1) * 20")
    expect(threadPage).toContain("t && page === 1")
    expect(threadPage).toContain("randomUUID()")
    expect(threadPage).toContain('createHash("sha256")')
    expect(controls).not.toContain("randomUUID")
    expect(controls).toContain("commandId: commands[operation]")
    expect(controls).toContain("assignee_id: assignee || null")
    expect(controls).toContain("run(\"reply\", { body, subject, destination })")
    expect(controls).toContain('run("read", {})')
  })
})
