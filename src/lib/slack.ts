/**
 * Slack Incoming Webhooks (server-only).
 * Set SLACK_WEBHOOK_URL in .env.local — never use NEXT_PUBLIC_* for secrets.
 */

export type LeadAlertPayload = {
  customerName: string
  phone: string
  carInfo: string | null
}

const DEFAULT_DASHBOARD = "http://localhost:3001/dashboard"

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

/**
 * Sends a premium-styled new-lead alert (🚀 dashboard link, 📱 phone, 🚗 vehicle).
 * No-ops when SLACK_WEBHOOK_URL is unset. Throws only on Slack HTTP failures.
 */
export async function sendLeadAlert(payload: LeadAlertPayload): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL?.trim()
  if (!webhookUrl) {
    return
  }

  const link = dashboardUrl()
  const name = dashOr(payload.customerName, "Name not provided")
  const phone = dashOr(payload.phone, "Not provided")
  const car = dashOr(payload.carInfo, "Not specified")

  const body = {
    text: `🚀 New Gradia lead · ${payload.customerName.trim()} · ${payload.phone.trim()}`,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "🚀  New Gradia Lead",
          emoji: true,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "✨ *Gradia* · *Premium detailing* · Live lead capture",
          },
        ],
      },
      { type: "divider" },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            `*👤 Customer*\n${name}`,
            "",
            `*📱 Phone*\n${phone}`,
            "",
            `*🚗 Vehicle*\n${car}`,
          ].join("\n"),
        },
      },
      { type: "divider" },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*🔗 Dashboard*\n<${link}|*Open Gradia dashboard* →>`,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "_White-glove follow-up starts on the dashboard._",
          },
        ],
      },
    ],
  }

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json;charset=utf-8" },
    body: JSON.stringify(body),
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

