/**
 * Slack helpers for the HITL approval flow (server-only).
 * - sendLeadApprovalRequest: posts an Approve / Edit card via incoming webhook
 * - verifySlackSignature: HMAC-SHA256 verification of interactivity callbacks
 * - replaceOriginalMessage: updates the original card after a button click
 */

import { createHmac, timingSafeEqual } from "node:crypto"

import type { LeadStatus } from "@/lib/types/database"

const DEFAULT_DASHBOARD = "http://localhost:3000/dashboard"

function dashboardUrl(): string {
  return process.env.GRADIA_DASHBOARD_URL?.trim() || DEFAULT_DASHBOARD
}

function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function dashOr(value: string | null | undefined, emptyLabel: string): string {
  const t = value?.trim()
  if (!t) {
    return `_${emptyLabel}_`
  }
  return escapeMrkdwn(t)
}

export type LeadApprovalPayload = {
  pendingActionId: string
  customerName: string
  phone: string
  carInfo: string | null
  pinNotes: string | null
  status: LeadStatus
}

type Block = Record<string, unknown>

function leadFieldBlocks(p: {
  customerName: string
  phone: string
  carInfo: string | null
  status: string
}): Block[] {
  return [
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Customer*\n${dashOr(p.customerName, "Not provided")}`,
        },
        {
          type: "mrkdwn",
          text: `*Phone*\n${dashOr(p.phone, "Not provided")}`,
        },
      ],
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Vehicle*\n${dashOr(p.carInfo, "Not specified")}`,
        },
        { type: "mrkdwn", text: `*Status*\n${escapeMrkdwn(p.status)}` },
      ],
    },
  ]
}

function approvalRequestBlocks(p: LeadApprovalPayload): Block[] {
  const blocks: Block[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "Approval needed: New lead",
        emoji: true,
      },
    },
    ...leadFieldBlocks({
      customerName: p.customerName,
      phone: p.phone,
      carInfo: p.carInfo,
      status: p.status,
    }),
  ]

  if (p.pinNotes && p.pinNotes.trim()) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Notes*\n${escapeMrkdwn(p.pinNotes)}` },
    })
  }

  blocks.push({
    type: "actions",
    block_id: "lead_approval",
    elements: [
      {
        type: "button",
        action_id: "approve_lead",
        text: { type: "plain_text", text: "Approve", emoji: true },
        style: "primary",
        value: p.pendingActionId,
      },
      {
        type: "button",
        action_id: "edit_lead",
        text: { type: "plain_text", text: "Edit", emoji: true },
        value: p.pendingActionId,
      },
    ],
  })

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: "Gradia · awaiting your approval before saving",
      },
    ],
  })

  return blocks
}

async function postWebhook(
  text: string,
  blocks: Block[]
): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL?.trim()
  if (!webhookUrl) {
    return
  }

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json;charset=utf-8" },
    body: JSON.stringify({ text, blocks }),
  })

  const raw = await res.text()
  if (!res.ok || raw !== "ok") {
    throw new Error(
      raw.startsWith("{")
        ? `Slack error: ${raw}`
        : `Slack webhook failed (${res.status}): ${raw.slice(0, 200)}`
    )
  }
}

/**
 * Posts an Approve / Edit card via incoming webhook.
 * No-ops when SLACK_WEBHOOK_URL is unset. Throws only on Slack HTTP failures.
 */
export async function sendLeadApprovalRequest(
  p: LeadApprovalPayload
): Promise<void> {
  await postWebhook(
    `Approval needed · ${p.customerName.trim() || "new lead"}`,
    approvalRequestBlocks(p)
  )
}

export type NoteApprovalPayload = {
  pendingActionId: string
  content: string
  customerName: string | null
  phone: string | null
}

function noteApprovalRequestBlocks(p: NoteApprovalPayload): Block[] {
  const blocks: Block[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "Approval needed: Note from Whisper",
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Note*\n${dashOr(p.content, "(empty)")}`,
      },
    },
  ]

  if (p.customerName?.trim() || p.phone?.trim()) {
    blocks.push({
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*About*\n${dashOr(p.customerName, "Not specified")}`,
        },
        {
          type: "mrkdwn",
          text: `*Phone*\n${dashOr(p.phone, "Not specified")}`,
        },
      ],
    })
  }

  blocks.push({
    type: "actions",
    block_id: "note_approval",
    elements: [
      {
        type: "button",
        action_id: "approve_lead",
        text: { type: "plain_text", text: "Approve", emoji: true },
        style: "primary",
        value: p.pendingActionId,
      },
      {
        type: "button",
        action_id: "edit_lead",
        text: { type: "plain_text", text: "Edit", emoji: true },
        value: p.pendingActionId,
      },
    ],
  })

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: "Gradia · awaiting your approval before saving",
      },
    ],
  })

  return blocks
}

export async function sendNoteApprovalRequest(
  p: NoteApprovalPayload
): Promise<void> {
  const preview = p.content.slice(0, 60).replace(/\s+/g, " ")
  await postWebhook(
    `Approval needed · note: ${preview}`,
    noteApprovalRequestBlocks(p)
  )
}

/**
 * Verifies the X-Slack-Signature header against the raw POST body.
 * Rejects requests older than 5 minutes (replay protection).
 */
export function verifySlackSignature(input: {
  rawBody: string
  timestamp: string | null
  signature: string | null
}): boolean {
  const signingSecret = process.env.SLACK_SIGNING_SECRET?.trim()
  if (!signingSecret) {
    return false
  }
  if (!input.timestamp || !input.signature) {
    return false
  }

  const ts = Number.parseInt(input.timestamp, 10)
  if (!Number.isFinite(ts)) {
    return false
  }
  const ageSeconds = Math.abs(Date.now() / 1000 - ts)
  if (ageSeconds > 300) {
    return false
  }

  const expected =
    "v0=" +
    createHmac("sha256", signingSecret)
      .update(`v0:${input.timestamp}:${input.rawBody}`)
      .digest("hex")

  const a = Buffer.from(expected)
  const b = Buffer.from(input.signature)
  if (a.length !== b.length) {
    return false
  }

  try {
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/**
 * Replaces the original Slack message in-place via response_url.
 */
export async function replaceOriginalMessage(
  responseUrl: string,
  text: string,
  blocks: Block[]
): Promise<void> {
  await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json;charset=utf-8" },
    body: JSON.stringify({
      replace_original: true,
      text,
      blocks,
    }),
  })
}

export function leadApprovedBlocks(p: {
  customerName: string
  phone: string
  carInfo: string | null
  pinNotes: string | null
  status: string
  approverSlackId: string
}): Block[] {
  const blocks: Block[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "Lead approved", emoji: true },
    },
    ...leadFieldBlocks({
      customerName: p.customerName,
      phone: p.phone,
      carInfo: p.carInfo,
      status: p.status,
    }),
  ]

  if (p.pinNotes && p.pinNotes.trim()) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Notes*\n${escapeMrkdwn(p.pinNotes)}` },
    })
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Approved by <@${p.approverSlackId}> · saved to our pipeline · <${dashboardUrl()}|Open Gradia>`,
      },
    ],
  })

  return blocks
}

export function leadEditRequestedBlocks(p: {
  customerName: string
  phone: string
  carInfo: string | null
  status: string
  approverSlackId: string
}): Block[] {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: "Edit requested", emoji: true },
    },
    ...leadFieldBlocks({
      customerName: p.customerName,
      phone: p.phone,
      carInfo: p.carInfo,
      status: p.status,
    }),
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `<@${p.approverSlackId}> requested edits — reopen in <${dashboardUrl()}|Gradia> to revise.`,
        },
      ],
    },
  ]
}

export function noteApprovedBlocks(p: {
  content: string
  customerName: string | null
  phone: string | null
  approverSlackId: string
}): Block[] {
  const blocks: Block[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "Note saved", emoji: true },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Note*\n${dashOr(p.content, "(empty)")}`,
      },
    },
  ]

  if (p.customerName?.trim() || p.phone?.trim()) {
    blocks.push({
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*About*\n${dashOr(p.customerName, "Not specified")}`,
        },
        {
          type: "mrkdwn",
          text: `*Phone*\n${dashOr(p.phone, "Not specified")}`,
        },
      ],
    })
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Approved by <@${p.approverSlackId}> · saved to our memory · <${dashboardUrl()}|Open Gradia>`,
      },
    ],
  })

  return blocks
}

export function noteEditRequestedBlocks(p: {
  content: string
  customerName: string | null
  approverSlackId: string
}): Block[] {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: "Edit requested", emoji: true },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Note*\n${dashOr(p.content, "(empty)")}`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `<@${p.approverSlackId}> requested edits — reopen in <${dashboardUrl()}|Gradia> to revise.`,
        },
      ],
    },
  ]
}
