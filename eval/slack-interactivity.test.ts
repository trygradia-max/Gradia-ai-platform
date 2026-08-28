import { afterEach, describe, expect, it, vi } from "vitest"

import * as approvals from "@/lib/approvals"
import { FEATURES } from "@/lib/features"

/**
 * P0-011 (audit C-2) — the Slack interactivity route. Two locked properties:
 *
 * 1. STRUCTURAL DORMANCY (D-026): with FEATURES.slackApprovals=false the
 *    route 404s before reading the body — the flag used to gate only card
 *    sending while the callback stayed live.
 * 2. TENANT BINDING: the button's pendingId is never authorization. The shop
 *    comes from the pending row's stored slack_channel + slack_message_ts —
 *    the card WE posted — matched against the callback's container. A row
 *    with no stored ref, or a mismatched container, is refused with zero
 *    writes and a structured tenant-scope log.
 */

vi.mock("@/lib/approvals", () => ({
  executeApproval: vi.fn(async () => ({
    ok: true,
    status: "already_decided",
  })),
  markEditRequested: vi.fn(async () => ({
    ok: true,
    status: "already_decided",
  })),
}))
vi.mock("@/lib/slack", () => ({
  verifySlackSignature: vi.fn(() => true),
  replaceOriginalMessage: vi.fn(async () => undefined),
  bookingApprovedBlocks: vi.fn(() => []),
  bookingEditRequestedBlocks: vi.fn(() => []),
  emailApprovedBlocks: vi.fn(() => []),
  emailEditRequestedBlocks: vi.fn(() => []),
  leadApprovedBlocks: vi.fn(() => []),
  leadEditRequestedBlocks: vi.fn(() => []),
  noteApprovedBlocks: vi.fn(() => []),
  noteEditRequestedBlocks: vi.fn(() => []),
  smsApprovedBlocks: vi.fn(() => []),
  smsEditRequestedBlocks: vi.fn(() => []),
}))

const pendingRows = new Map<
  string,
  { id: string; shop_id: string; slack_channel: string | null; slack_message_ts: string | null }
>()

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: vi.fn(() => ({
    from: () => ({
      select: () => {
        const filters: Record<string, unknown> = {}
        const builder = {
          eq(col: string, val: unknown) {
            filters[col] = val
            return builder
          },
          async maybeSingle() {
            const row = pendingRows.get(String(filters.id))
            if (!row) return { data: null, error: null }
            if (
              "slack_channel" in filters &&
              (row.slack_channel !== filters.slack_channel ||
                row.slack_message_ts !== filters.slack_message_ts)
            ) {
              return { data: null, error: null }
            }
            return { data: row, error: null }
          },
        }
        return builder
      },
    }),
  })),
}))

import { POST } from "@/app/api/slack/interactivity/route"

const mockedExecute = vi.mocked(approvals.executeApproval)

function slackRequest(body: {
  pendingId: string
  channelId?: string
  messageTs?: string
}): Request {
  const payload = {
    type: "block_actions",
    user: { id: "U123" },
    actions: [{ action_id: "approve_lead", value: body.pendingId }],
    container: {
      channel_id: body.channelId ?? "C-A",
      message_ts: body.messageTs ?? "111.222",
    },
    response_url: "https://hooks.slack.example/respond",
  }
  return new Request("http://localhost/api/slack/interactivity", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `payload=${encodeURIComponent(JSON.stringify(payload))}`,
  })
}

afterEach(() => {
  vi.clearAllMocks()
  pendingRows.clear()
})

describe("slack interactivity — structural dormancy (D-026)", () => {
  it("404s while FEATURES.slackApprovals is off, before any processing", async () => {
    expect(FEATURES.slackApprovals).toBe(false)
    const res = await POST(slackRequest({ pendingId: "pa-1" }))
    expect(res.status).toBe(404)
    expect(mockedExecute).not.toHaveBeenCalled()
  })
})

describe("slack interactivity — tenant binding (C-2), flag forced on", () => {
  // The flag is a compile-time const; these tests exercise the binding path
  // by flipping it on the frozen object for the duration of the test.
  const flip = () => {
    const features = FEATURES as unknown as Record<string, unknown>
    const original = features.slackApprovals
    features.slackApprovals = true
    return () => {
      features.slackApprovals = original
    }
  }

  it("refuses a pendingId whose row has no matching stored message ref", async () => {
    const restore = flip()
    try {
      pendingRows.set("pa-foreign", {
        id: "pa-foreign",
        shop_id: "shop-B",
        slack_channel: null,
        slack_message_ts: null,
      })
      const res = await POST(slackRequest({ pendingId: "pa-foreign" }))
      expect(res.status).toBe(404)
      expect(mockedExecute).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it("refuses when the callback container mismatches the stored ref", async () => {
    const restore = flip()
    try {
      pendingRows.set("pa-1", {
        id: "pa-1",
        shop_id: "shop-A",
        slack_channel: "C-A",
        slack_message_ts: "999.000",
      })
      const res = await POST(
        slackRequest({ pendingId: "pa-1", messageTs: "111.222" })
      )
      expect(res.status).toBe(404)
      expect(mockedExecute).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it("passes the BOUND row's shop into the claim on a container match", async () => {
    const restore = flip()
    try {
      pendingRows.set("pa-1", {
        id: "pa-1",
        shop_id: "shop-A",
        slack_channel: "C-A",
        slack_message_ts: "111.222",
      })
      const res = await POST(slackRequest({ pendingId: "pa-1" }))
      expect(res.status).toBe(200)
      expect(mockedExecute).toHaveBeenCalledTimes(1)
      expect(mockedExecute.mock.calls[0][1]).toBe("pa-1")
      expect(mockedExecute.mock.calls[0][2]).toBe("shop-A")
    } finally {
      restore()
    }
  })

  it("refuses a callback with no container context", async () => {
    const restore = flip()
    try {
      const payload = {
        type: "block_actions",
        user: { id: "U123" },
        actions: [{ action_id: "approve_lead", value: "pa-1" }],
        response_url: "https://hooks.slack.example/respond",
      }
      const res = await POST(
        new Request("http://localhost/api/slack/interactivity", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: `payload=${encodeURIComponent(JSON.stringify(payload))}`,
        })
      )
      expect(res.status).toBe(400)
      expect(mockedExecute).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })
})
