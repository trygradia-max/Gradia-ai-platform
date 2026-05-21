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

function appOrigin(): string {
  try {
    return new URL(dashboardUrl()).origin
  } catch {
    return "http://localhost:3000"
  }
}

function pendingActionUrl(pendingActionId: string): string {
  return `${appOrigin()}/approvals/${pendingActionId}`
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
  /** Optional one-liner about recent touchpoints on other channels. */
  crossChannelHint?: string | null
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

  if (p.crossChannelHint?.trim()) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `:link: ${escapeMrkdwn(p.crossChannelHint.trim())}`,
        },
      ],
    })
  }

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
  blocks: Block[],
  opts?: { pendingActionId?: string }
): Promise<void> {
  // Prefer chat.postMessage when a bot token + default channel are
  // configured — it returns a message ts so dashboard-side decisions
  // can later chat.update the card instead of leaving it stale.
  // Falls back to the incoming-webhook path for shops that haven't
  // upgraded.
  const botToken = process.env.SLACK_BOT_TOKEN?.trim()
  const channelId = process.env.SLACK_DEFAULT_CHANNEL_ID?.trim()
  if (botToken && channelId) {
    const result = await chatPostMessage({
      botToken,
      channelId,
      text,
      blocks,
    })
    if (result && opts?.pendingActionId) {
      await storeSlackRef({
        pendingActionId: opts.pendingActionId,
        channelId: result.channel,
        ts: result.ts,
      })
    }
    return
  }

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

async function chatPostMessage(input: {
  botToken: string
  channelId: string
  text: string
  blocks: Block[]
}): Promise<{ ts: string; channel: string } | null> {
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=utf-8",
        Authorization: `Bearer ${input.botToken}`,
      },
      body: JSON.stringify({
        channel: input.channelId,
        text: input.text,
        blocks: input.blocks,
      }),
    })
    const json = (await res.json()) as {
      ok?: boolean
      error?: string
      ts?: string
      channel?: string
    }
    if (!json.ok || !json.ts || !json.channel) {
      console.error("[slack] chat.postMessage failed:", json.error ?? json)
      return null
    }
    return { ts: json.ts, channel: json.channel }
  } catch (err) {
    console.error("[slack] chat.postMessage threw:", err)
    return null
  }
}

async function storeSlackRef(input: {
  pendingActionId: string
  channelId: string
  ts: string
}): Promise<void> {
  // Lazy import to keep slack.ts free of supabase coupling for callers
  // that just want webhook posts (BI chat, Stripe paid notices, etc.).
  const { createServiceClient } = await import("@/lib/supabase/service")
  const supabase = createServiceClient()
  const { error } = await supabase
    .from("pending_actions")
    .update({
      slack_channel: input.channelId,
      slack_message_ts: input.ts,
    })
    .eq("id", input.pendingActionId)
  if (error) {
    console.error("[slack] failed to store slack ref:", error)
  }
}

/**
 * Minimal "decided" card we swap onto the original approval message
 * when the operator decides from the Gradia dashboard. We don't try
 * to echo every field here — the rich per-type "approved" blocks
 * still get rendered when the decision happens via the Slack
 * interactivity route. Dashboard decisions just collapse the original
 * card to a status header + "Open Gradia" link so it stops looking
 * like there's still work to do.
 */
export function dashboardDecidedBlocks(input: {
  headline: string
  summary: string
  approverEmail?: string | null
}): Block[] {
  const who = input.approverEmail?.trim() || "an operator"
  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: input.headline,
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: escapeMrkdwn(input.summary),
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Decided by ${escapeMrkdwn(who)} via the dashboard · <${dashboardUrl()}|Open Gradia>`,
        },
      ],
    },
  ]
}

/**
 * Updates the Slack card we originally posted for a pending action.
 * No-op when SLACK_BOT_TOKEN isn't set or the pending row has no
 * slack_message_ts (because it was posted via incoming webhook).
 *
 * Used by the dashboard approve/reject/edit flows so cards don't go
 * stale when an operator decides outside Slack.
 */
export async function updateSlackForPending(input: {
  pendingActionId: string
  text: string
  blocks: Block[]
}): Promise<void> {
  const botToken = process.env.SLACK_BOT_TOKEN?.trim()
  if (!botToken) return

  const { createServiceClient } = await import("@/lib/supabase/service")
  const supabase = createServiceClient()
  const { data } = await supabase
    .from("pending_actions")
    .select("slack_channel, slack_message_ts")
    .eq("id", input.pendingActionId)
    .maybeSingle()
  const row =
    (data as {
      slack_channel: string | null
      slack_message_ts: string | null
    } | null) ?? null
  if (!row?.slack_channel || !row.slack_message_ts) return

  try {
    const res = await fetch("https://slack.com/api/chat.update", {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=utf-8",
        Authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify({
        channel: row.slack_channel,
        ts: row.slack_message_ts,
        text: input.text,
        blocks: input.blocks,
      }),
    })
    const json = (await res.json()) as { ok?: boolean; error?: string }
    if (!json.ok) {
      console.error("[slack] chat.update failed:", json.error ?? json)
    }
  } catch (err) {
    console.error("[slack] chat.update threw:", err)
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
    approvalRequestBlocks(p),
    { pendingActionId: p.pendingActionId }
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
    noteApprovalRequestBlocks(p),
    { pendingActionId: p.pendingActionId }
  )
}

export type BookingApprovalPayload = {
  pendingActionId: string
  customerName: string
  phone: string
  service: string | null
  carInfo: string | null
  startIso: string
  durationMinutes: number
  timezone: string | null
  /** Optional one-liner about recent touchpoints on other channels. */
  crossChannelHint?: string | null
}

function formatBookingWhen(
  startIso: string,
  durationMinutes: number,
  timezone: string | null
): string {
  const start = new Date(startIso)
  if (Number.isNaN(start.getTime())) return startIso
  const opts: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone ?? undefined,
    timeZoneName: timezone ? "short" : undefined,
  }
  return `${new Intl.DateTimeFormat("en-US", opts).format(start)} · ${durationMinutes} min`
}

function bookingFieldBlocks(p: BookingApprovalPayload): Block[] {
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
          text: `*Service*\n${dashOr(p.service, "Not specified")}`,
        },
        {
          type: "mrkdwn",
          text: `*Vehicle*\n${dashOr(p.carInfo, "Not specified")}`,
        },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*When*\n${escapeMrkdwn(
          formatBookingWhen(p.startIso, p.durationMinutes, p.timezone)
        )}`,
      },
    },
  ]
}

function bookingApprovalRequestBlocks(p: BookingApprovalPayload): Block[] {
  const blocks: Block[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "Approval needed: Booking",
        emoji: true,
      },
    },
    ...bookingFieldBlocks(p),
  ]
  if (p.crossChannelHint?.trim()) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `:link: ${escapeMrkdwn(p.crossChannelHint.trim())}`,
        },
      ],
    })
  }
  blocks.push(
    {
      type: "actions",
      block_id: "booking_approval",
      elements: [
        {
          type: "button",
          action_id: "approve_lead",
          text: { type: "plain_text", text: "Approve & book", emoji: true },
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
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Gradia · we'll put it on our calendar once you approve",
        },
      ],
    }
  )
  return blocks
}

export async function sendBookingApprovalRequest(
  p: BookingApprovalPayload
): Promise<void> {
  await postWebhook(
    `Booking request · ${p.customerName.trim() || "new lead"}`,
    bookingApprovalRequestBlocks(p),
    { pendingActionId: p.pendingActionId }
  )
}

export function bookingApprovedBlocks(p: {
  pendingActionId: string
  customerName: string
  phone: string
  service: string | null
  carInfo: string | null
  startIso: string
  durationMinutes: number
  timezone: string | null
  approverSlackId: string
}): Block[] {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: "Booking confirmed", emoji: true },
    },
    ...bookingFieldBlocks({
      pendingActionId: p.pendingActionId,
      customerName: p.customerName,
      phone: p.phone,
      service: p.service,
      carInfo: p.carInfo,
      startIso: p.startIso,
      durationMinutes: p.durationMinutes,
      timezone: p.timezone,
    }),
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Approved by <@${p.approverSlackId}> · on our calendar · <${dashboardUrl()}|Open Gradia>`,
        },
      ],
    },
  ]
}

export type ChargeApprovalPayload = {
  pendingActionId: string
  customerName: string
  customerEmail: string
  amountCents: number
  description: string
}

function formatMoney(cents: number): string {
  const dollars = cents / 100
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(dollars)
}

function chargeFieldBlocks(p: ChargeApprovalPayload): Block[] {
  return [
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Customer*\n${dashOr(p.customerName, "Unknown")}`,
        },
        {
          type: "mrkdwn",
          text: `*Email*\n${dashOr(p.customerEmail, "Missing — edit to add")}`,
        },
      ],
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Amount*\n${formatMoney(p.amountCents)}`,
        },
        {
          type: "mrkdwn",
          text: `*For*\n${dashOr(p.description, "Detailing service")}`,
        },
      ],
    },
  ]
}

function chargeApprovalRequestBlocks(p: ChargeApprovalPayload): Block[] {
  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `Approval needed: Charge ${formatMoney(p.amountCents)}`,
        emoji: true,
      },
    },
    ...chargeFieldBlocks(p),
    {
      type: "actions",
      block_id: "charge_approval",
      elements: [
        {
          type: "button",
          action_id: "approve_lead",
          text: {
            type: "plain_text",
            text: `Approve & send invoice`,
            emoji: true,
          },
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
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Gradia · Stripe emails the customer a hosted-payment link the moment you approve",
        },
      ],
    },
  ]
}

export async function sendChargeApprovalRequest(
  p: ChargeApprovalPayload
): Promise<void> {
  await postWebhook(
    `Approval needed · charge ${p.customerName.trim() || p.customerEmail} ${formatMoney(p.amountCents)}`,
    chargeApprovalRequestBlocks(p),
    { pendingActionId: p.pendingActionId }
  )
}

export function chargeApprovedBlocks(p: {
  pendingActionId: string
  customerName: string
  customerEmail: string
  amountCents: number
  description: string
  invoiceUrl: string | null
  approverSlackId: string
}): Block[] {
  const blocks: Block[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `Invoice sent · ${formatMoney(p.amountCents)}`,
        emoji: true,
      },
    },
    ...chargeFieldBlocks({
      pendingActionId: p.pendingActionId,
      customerName: p.customerName,
      customerEmail: p.customerEmail,
      amountCents: p.amountCents,
      description: p.description,
    }),
  ]

  if (p.invoiceUrl) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Invoice link* (Stripe-hosted)\n<${p.invoiceUrl}|Open invoice>`,
      },
    })
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Approved by <@${p.approverSlackId}> · customer emailed · <${dashboardUrl()}|Open Gradia>`,
      },
    ],
  })

  return blocks
}

export async function sendPaymentReceivedNotice(input: {
  customerName: string | null
  customerEmail: string | null
  amountCents: number
  invoiceNumber: string | null
  invoiceUrl: string | null
}): Promise<void> {
  const target =
    input.customerName?.trim() ||
    input.customerEmail?.trim() ||
    "a customer"
  const amount = formatMoney(input.amountCents)
  const blocks: Block[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `Paid · ${amount}`,
        emoji: true,
      },
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Customer*\n${escapeMrkdwn(target)}`,
        },
        {
          type: "mrkdwn",
          text: `*Invoice*\n${dashOr(input.invoiceNumber, "unnamed")}`,
        },
      ],
    },
  ]
  if (input.invoiceUrl) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `<${input.invoiceUrl}|Open the invoice in Stripe>`,
      },
    })
  }
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: "Gradia · funds landed on our connected account",
      },
    ],
  })
  await postWebhook(`Paid · ${target} · ${amount}`, blocks)
}

export async function sendPaymentFailedNotice(input: {
  customerName: string | null
  customerEmail: string | null
  amountCents: number
  invoiceNumber: string | null
  invoiceUrl: string | null
}): Promise<void> {
  const target =
    input.customerName?.trim() ||
    input.customerEmail?.trim() ||
    "a customer"
  const amount = formatMoney(input.amountCents)
  const blocks: Block[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `Payment failed · ${amount}`,
        emoji: true,
      },
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Customer*\n${escapeMrkdwn(target)}`,
        },
        {
          type: "mrkdwn",
          text: `*Invoice*\n${dashOr(input.invoiceNumber, "unnamed")}`,
        },
      ],
    },
  ]
  if (input.invoiceUrl) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `<${input.invoiceUrl}|Reopen the invoice in Stripe>`,
      },
    })
  }
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: "Gradia · their card got declined or the invoice expired — worth a follow-up",
      },
    ],
  })
  await postWebhook(`Payment failed · ${target} · ${amount}`, blocks)
}

export async function sendPaymentRefundedNotice(input: {
  customerName: string | null
  customerEmail: string | null
  refundedAmountCents: number
  grossAmountCents: number
  fullyRefunded: boolean
  invoiceNumber: string | null
  invoiceUrl: string | null
}): Promise<void> {
  const target =
    input.customerName?.trim() ||
    input.customerEmail?.trim() ||
    "a customer"
  const refund = formatMoney(input.refundedAmountCents)
  const gross = formatMoney(input.grossAmountCents)
  const heading = input.fullyRefunded
    ? `Refunded · ${refund}`
    : `Partial refund · ${refund} of ${gross}`
  const blocks: Block[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: heading,
        emoji: true,
      },
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Customer*\n${escapeMrkdwn(target)}`,
        },
        {
          type: "mrkdwn",
          text: `*Invoice*\n${dashOr(input.invoiceNumber, "unnamed")}`,
        },
      ],
    },
  ]
  if (input.invoiceUrl) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `<${input.invoiceUrl}|Open the invoice in Stripe>`,
      },
    })
  }
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: input.fullyRefunded
          ? "Gradia · funds returned to the customer"
          : "Gradia · partial refund applied",
      },
    ],
  })
  await postWebhook(`${heading} · ${target}`, blocks)
}

export function chargeEditRequestedBlocks(p: {
  pendingActionId: string
  customerName: string
  customerEmail: string
  amountCents: number
  description: string
  approverSlackId: string
}): Block[] {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: "Edit requested", emoji: true },
    },
    ...chargeFieldBlocks({
      pendingActionId: p.pendingActionId,
      customerName: p.customerName,
      customerEmail: p.customerEmail,
      amountCents: p.amountCents,
      description: p.description,
    }),
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `<@${p.approverSlackId}> requested edits — <${pendingActionUrl(p.pendingActionId)}|open the editor in Gradia>.`,
        },
      ],
    },
  ]
}

export type EmailApprovalPayload = {
  pendingActionId: string
  toEmail: string
  customerName: string | null
  subject: string
  body: string
  reason: string | null
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max).trim()}…`
}

function emailFieldBlocks(p: EmailApprovalPayload): Block[] {
  return [
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*To*\n${dashOr(
            p.customerName ? `${p.customerName} (${p.toEmail})` : p.toEmail,
            "Unknown"
          )}`,
        },
        {
          type: "mrkdwn",
          text: `*Reason*\n${dashOr(p.reason, "Not specified")}`,
        },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Subject*\n${dashOr(p.subject, "(no subject)")}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Body*\n${dashOr(truncate(p.body, 800), "(empty)")}`,
      },
    },
  ]
}

function emailApprovalRequestBlocks(p: EmailApprovalPayload): Block[] {
  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "Approval needed: Outbound email",
        emoji: true,
      },
    },
    ...emailFieldBlocks(p),
    {
      type: "actions",
      block_id: "email_approval",
      elements: [
        {
          type: "button",
          action_id: "approve_lead",
          text: { type: "plain_text", text: "Approve & send", emoji: true },
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
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Gradia · we'll send it from our connected inbox the moment you approve",
        },
      ],
    },
  ]
}

export async function sendEmailApprovalRequest(
  p: EmailApprovalPayload
): Promise<void> {
  await postWebhook(
    `Approval needed · email to ${p.customerName ?? p.toEmail}: ${truncate(p.subject, 60)}`,
    emailApprovalRequestBlocks(p),
    { pendingActionId: p.pendingActionId }
  )
}

export function emailApprovedBlocks(p: {
  pendingActionId: string
  toEmail: string
  customerName: string | null
  subject: string
  body: string
  reason: string | null
  approverSlackId: string
}): Block[] {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: "Email sent", emoji: true },
    },
    ...emailFieldBlocks({
      pendingActionId: p.pendingActionId,
      toEmail: p.toEmail,
      customerName: p.customerName,
      subject: p.subject,
      body: p.body,
      reason: p.reason,
    }),
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Approved by <@${p.approverSlackId}> · on its way · <${dashboardUrl()}|Open Gradia>`,
        },
      ],
    },
  ]
}

export function emailEditRequestedBlocks(p: {
  pendingActionId: string
  toEmail: string
  customerName: string | null
  subject: string
  body: string
  reason: string | null
  approverSlackId: string
}): Block[] {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: "Edit requested", emoji: true },
    },
    ...emailFieldBlocks({
      pendingActionId: p.pendingActionId,
      toEmail: p.toEmail,
      customerName: p.customerName,
      subject: p.subject,
      body: p.body,
      reason: p.reason,
    }),
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `<@${p.approverSlackId}> requested edits — <${pendingActionUrl(p.pendingActionId)}|open the editor in Gradia>.`,
        },
      ],
    },
  ]
}

export type SmsApprovalPayload = {
  pendingActionId: string
  toPhone: string
  customerName: string | null
  body: string
  reason: string | null
}

function smsFieldBlocks(p: SmsApprovalPayload): Block[] {
  return [
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*To*\n${dashOr(
            p.customerName ? `${p.customerName} (${p.toPhone})` : p.toPhone,
            "Unknown"
          )}`,
        },
        {
          type: "mrkdwn",
          text: `*Reason*\n${dashOr(p.reason, "Not specified")}`,
        },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Message*\n${dashOr(p.body, "(empty)")}`,
      },
    },
  ]
}

function smsApprovalRequestBlocks(p: SmsApprovalPayload): Block[] {
  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "Approval needed: Outbound SMS",
        emoji: true,
      },
    },
    ...smsFieldBlocks(p),
    {
      type: "actions",
      block_id: "sms_approval",
      elements: [
        {
          type: "button",
          action_id: "approve_lead",
          text: { type: "plain_text", text: "Approve & send", emoji: true },
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
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Gradia · we'll send it the moment you approve",
        },
      ],
    },
  ]
}

export async function sendSmsApprovalRequest(
  p: SmsApprovalPayload
): Promise<void> {
  const preview = p.body.slice(0, 60).replace(/\s+/g, " ")
  await postWebhook(
    `Approval needed · SMS to ${p.customerName ?? p.toPhone}: ${preview}`,
    smsApprovalRequestBlocks(p),
    { pendingActionId: p.pendingActionId }
  )
}

export type InstagramDmApprovalPayload = {
  pendingActionId: string
  recipientId: string
  customerName: string | null
  body: string
  reason: string | null
}

function instagramFieldBlocks(p: InstagramDmApprovalPayload): Block[] {
  return [
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*To*\n${dashOr(
            p.customerName ? `${p.customerName} (IG ${p.recipientId})` : `IG ${p.recipientId}`,
            "Unknown"
          )}`,
        },
        {
          type: "mrkdwn",
          text: `*Reason*\n${dashOr(p.reason, "Not specified")}`,
        },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Message*\n${dashOr(p.body, "(empty)")}`,
      },
    },
  ]
}

function instagramApprovalRequestBlocks(
  p: InstagramDmApprovalPayload
): Block[] {
  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "Approval needed: Outbound IG DM",
        emoji: true,
      },
    },
    ...instagramFieldBlocks(p),
    {
      type: "actions",
      block_id: "instagram_dm_approval",
      elements: [
        {
          type: "button",
          action_id: "approve_lead",
          text: { type: "plain_text", text: "Approve & send", emoji: true },
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
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Gradia · sends from our connected IG page the moment you approve",
        },
      ],
    },
  ]
}

export async function sendInstagramDmApprovalRequest(
  p: InstagramDmApprovalPayload
): Promise<void> {
  const preview = p.body.slice(0, 60).replace(/\s+/g, " ")
  await postWebhook(
    `Approval needed · IG DM to ${p.customerName ?? p.recipientId}: ${preview}`,
    instagramApprovalRequestBlocks(p),
    { pendingActionId: p.pendingActionId }
  )
}

export function instagramDmApprovedBlocks(p: {
  pendingActionId: string
  recipientId: string
  customerName: string | null
  body: string
  reason: string | null
  approverSlackId: string
}): Block[] {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: "IG DM sent", emoji: true },
    },
    ...instagramFieldBlocks({
      pendingActionId: p.pendingActionId,
      recipientId: p.recipientId,
      customerName: p.customerName,
      body: p.body,
      reason: p.reason,
    }),
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Approved by <@${p.approverSlackId}> · on its way · <${dashboardUrl()}|Open Gradia>`,
        },
      ],
    },
  ]
}

export function instagramDmEditRequestedBlocks(p: {
  pendingActionId: string
  recipientId: string
  customerName: string | null
  body: string
  reason: string | null
  approverSlackId: string
}): Block[] {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: "Edit requested", emoji: true },
    },
    ...instagramFieldBlocks({
      pendingActionId: p.pendingActionId,
      recipientId: p.recipientId,
      customerName: p.customerName,
      body: p.body,
      reason: p.reason,
    }),
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `<@${p.approverSlackId}> requested edits — <${pendingActionUrl(p.pendingActionId)}|open the editor in Gradia>.`,
        },
      ],
    },
  ]
}

export type FacebookDmApprovalPayload = {
  pendingActionId: string
  recipientId: string
  customerName: string | null
  body: string
  reason: string | null
}

function facebookFieldBlocks(p: FacebookDmApprovalPayload): Block[] {
  return [
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*To*\n${dashOr(
            p.customerName ? `${p.customerName} (FB ${p.recipientId})` : `FB ${p.recipientId}`,
            "Unknown"
          )}`,
        },
        {
          type: "mrkdwn",
          text: `*Reason*\n${dashOr(p.reason, "Not specified")}`,
        },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Message*\n${dashOr(p.body, "(empty)")}`,
      },
    },
  ]
}

function facebookApprovalRequestBlocks(
  p: FacebookDmApprovalPayload
): Block[] {
  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "Approval needed: Outbound FB DM",
        emoji: true,
      },
    },
    ...facebookFieldBlocks(p),
    {
      type: "actions",
      block_id: "facebook_dm_approval",
      elements: [
        {
          type: "button",
          action_id: "approve_lead",
          text: { type: "plain_text", text: "Approve & send", emoji: true },
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
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Gradia · sends from our connected Facebook page the moment you approve",
        },
      ],
    },
  ]
}

export async function sendFacebookDmApprovalRequest(
  p: FacebookDmApprovalPayload
): Promise<void> {
  const preview = p.body.slice(0, 60).replace(/\s+/g, " ")
  await postWebhook(
    `Approval needed · FB DM to ${p.customerName ?? p.recipientId}: ${preview}`,
    facebookApprovalRequestBlocks(p),
    { pendingActionId: p.pendingActionId }
  )
}

export function facebookDmApprovedBlocks(p: {
  pendingActionId: string
  recipientId: string
  customerName: string | null
  body: string
  reason: string | null
  approverSlackId: string
}): Block[] {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: "FB DM sent", emoji: true },
    },
    ...facebookFieldBlocks({
      pendingActionId: p.pendingActionId,
      recipientId: p.recipientId,
      customerName: p.customerName,
      body: p.body,
      reason: p.reason,
    }),
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Approved by <@${p.approverSlackId}> · on its way · <${dashboardUrl()}|Open Gradia>`,
        },
      ],
    },
  ]
}

export function facebookDmEditRequestedBlocks(p: {
  pendingActionId: string
  recipientId: string
  customerName: string | null
  body: string
  reason: string | null
  approverSlackId: string
}): Block[] {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: "Edit requested", emoji: true },
    },
    ...facebookFieldBlocks({
      pendingActionId: p.pendingActionId,
      recipientId: p.recipientId,
      customerName: p.customerName,
      body: p.body,
      reason: p.reason,
    }),
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `<@${p.approverSlackId}> requested edits — <${pendingActionUrl(p.pendingActionId)}|open the editor in Gradia>.`,
        },
      ],
    },
  ]
}

export function smsApprovedBlocks(p: {
  pendingActionId: string
  toPhone: string
  customerName: string | null
  body: string
  reason: string | null
  approverSlackId: string
}): Block[] {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: "SMS sent", emoji: true },
    },
    ...smsFieldBlocks({
      pendingActionId: p.pendingActionId,
      toPhone: p.toPhone,
      customerName: p.customerName,
      body: p.body,
      reason: p.reason,
    }),
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Approved by <@${p.approverSlackId}> · on its way · <${dashboardUrl()}|Open Gradia>`,
        },
      ],
    },
  ]
}

export function smsEditRequestedBlocks(p: {
  pendingActionId: string
  toPhone: string
  customerName: string | null
  body: string
  reason: string | null
  approverSlackId: string
}): Block[] {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: "Edit requested", emoji: true },
    },
    ...smsFieldBlocks({
      pendingActionId: p.pendingActionId,
      toPhone: p.toPhone,
      customerName: p.customerName,
      body: p.body,
      reason: p.reason,
    }),
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `<@${p.approverSlackId}> requested edits — <${pendingActionUrl(p.pendingActionId)}|open the editor in Gradia>.`,
        },
      ],
    },
  ]
}

export function bookingEditRequestedBlocks(p: {
  pendingActionId: string
  customerName: string
  phone: string
  service: string | null
  carInfo: string | null
  startIso: string
  durationMinutes: number
  timezone: string | null
  approverSlackId: string
}): Block[] {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: "Edit requested", emoji: true },
    },
    ...bookingFieldBlocks({
      pendingActionId: p.pendingActionId,
      customerName: p.customerName,
      phone: p.phone,
      service: p.service,
      carInfo: p.carInfo,
      startIso: p.startIso,
      durationMinutes: p.durationMinutes,
      timezone: p.timezone,
    }),
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `<@${p.approverSlackId}> requested edits — <${pendingActionUrl(p.pendingActionId)}|open the editor in Gradia>.`,
        },
      ],
    },
  ]
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
  pendingActionId: string
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
          text: `<@${p.approverSlackId}> requested edits — <${pendingActionUrl(p.pendingActionId)}|open the editor in Gradia>.`,
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
  pendingActionId: string
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
          text: `<@${p.approverSlackId}> requested edits — <${pendingActionUrl(p.pendingActionId)}|open the editor in Gradia>.`,
        },
      ],
    },
  ]
}
