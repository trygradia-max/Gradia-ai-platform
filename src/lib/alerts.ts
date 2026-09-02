/**
 * Ops alert delivery seam (P0-012, decision D-042).
 *
 * The ONE way founder-facing operational signals leave the process:
 * `sendOpsAlert({ severity, source, title, detail, refs })`. Consumers today:
 * usage anomalies (`monitoring.ts`), the tenant-scope violation signal,
 * telephony reconciliation drift (`reconciliation.ts`), and every cron's
 * failure path (`cron-run.ts`). Later: payment notices (CLEANUP-001),
 * nightly eval failures (D-053).
 *
 * Destinations (env-configured, names only — values are secrets):
 *   OPS_ALERT_WEBHOOK_URL  — JSON webhook (the founder's Slack ops channel
 *                            incoming webhook per D-042; any receiver that
 *                            accepts `{ text }` works). Every severity.
 *   OPS_ALERT_SMS_TO/FROM  — SEV-0 / SEV-1 only, via the env Twilio master
 *                            account. Optional.
 * With nothing configured the seam logs (exactly the pre-P0-012 behavior)
 * and reports itself "unconfigured" on /api/health — the safe deploy and
 * rollback position.
 *
 * Contract:
 *  - NEVER throws and never blocks the caller's outcome (fail-open by
 *    design). Delivery failures are counted, logged loudly (status/name
 *    only — never the destination URL) and exposed on /api/health.
 *  - Bursts collapse: the same (severity, source, title) within
 *    DEDUPE_WINDOW_MS is suppressed after the first delivery. In-memory,
 *    therefore per-instance — a crashloop across N instances can still
 *    deliver up to N copies per window. Documented limitation.
 *  - Sentry cross-reference: an attached `error` is captured with the
 *    severity tag; SEV-0/1 without an error are captured as messages.
 *  - Input is validated and truncated so a malformed caller can neither
 *    crash the path nor flood the destination. Detail/refs must arrive
 *    already sanitized: no secrets, no raw payloads, no headers.
 *
 * This module deliberately does NOT import `lib/slack.ts` (the approvals
 * surface CLEANUP-001 deletes) — D-042 requires the ops path to stand alone.
 */

export type AlertSeverity = "SEV-0" | "SEV-1" | "SEV-2" | "SEV-3"

export const ALERT_SEVERITIES: readonly AlertSeverity[] = ["SEV-0", "SEV-1", "SEV-2", "SEV-3"]

export type OpsAlertInput = {
  severity: AlertSeverity
  /** Emitting module: "monitoring", "reconcile", "tenancy", "cron/<name>", … */
  source: string
  /** Short, stable headline. With severity + source it is the dedupe key. */
  title: string
  /** Human-readable context. Sanitized by the caller. Truncated at 2,000 chars. */
  detail?: string
  /** Structured refs: shop_id, provider ids, row ids, action taken, retryable. */
  refs?: Record<string, string | number | boolean | null | undefined>
  /** An exception to cross-reference in Sentry (captured with the severity tag). */
  error?: unknown
  /** Test/health probes only — skip the burst-dedupe window. */
  bypassDedupe?: boolean
}

export type ChannelOutcome = "delivered" | "failed" | "unconfigured" | "skipped"

export type AlertDeliveryResult = {
  delivered: boolean
  reason: "delivered" | "unconfigured" | "suppressed" | "invalid" | "failed"
  channels: { webhook: ChannelOutcome; sms: ChannelOutcome }
}

export type AlertSeamStatus = {
  webhookConfigured: boolean
  smsConfigured: boolean
  delivered: number
  failed: number
  suppressed: number
  invalid: number
  lastDeliveredAt: string | null
  lastFailureAt: string | null
}

export const DEDUPE_WINDOW_MS = 10 * 60_000
const DEDUPE_MAX_KEYS = 500
const FETCH_TIMEOUT_MS = 5_000
const MAX_TITLE = 200
const MAX_SOURCE = 64
const MAX_DETAIL = 2_000
const MAX_REFS = 20
const MAX_REF_VALUE = 200

type NormalizedAlert = {
  severity: AlertSeverity
  source: string
  title: string
  detail: string | null
  refs: Record<string, string>
  error: unknown
  bypassDedupe: boolean
}

const state = {
  delivered: 0,
  failed: 0,
  suppressed: 0,
  invalid: 0,
  lastDeliveredAt: null as string | null,
  lastFailureAt: null as string | null,
  recent: new Map<string, number>(),
}

function webhookUrl(): string | null {
  return process.env.OPS_ALERT_WEBHOOK_URL?.trim() || null
}

function smsConfig(): { to: string; from: string } | null {
  const to = process.env.OPS_ALERT_SMS_TO?.trim()
  const from = process.env.OPS_ALERT_SMS_FROM?.trim()
  return to && from ? { to, from } : null
}

function normalize(input: OpsAlertInput): NormalizedAlert | null {
  if (!input || typeof input !== "object") return null
  if (!ALERT_SEVERITIES.includes(input.severity)) return null
  const source = typeof input.source === "string" ? input.source.trim() : ""
  const title = typeof input.title === "string" ? input.title.trim() : ""
  if (!source || source.length > MAX_SOURCE || !title) return null
  const refs: Record<string, string> = {}
  if (input.refs && typeof input.refs === "object") {
    for (const [k, v] of Object.entries(input.refs).slice(0, MAX_REFS)) {
      if (v === undefined) continue
      refs[k.slice(0, 64)] = String(v).slice(0, MAX_REF_VALUE)
    }
  }
  return {
    severity: input.severity,
    source,
    title: title.slice(0, MAX_TITLE),
    detail:
      typeof input.detail === "string" && input.detail.trim()
        ? input.detail.trim().slice(0, MAX_DETAIL)
        : null,
    refs,
    error: input.error,
    bypassDedupe: input.bypassDedupe === true,
  }
}

const SEVERITY_ICON: Record<AlertSeverity, string> = {
  "SEV-0": ":rotating_light:",
  "SEV-1": ":warning:",
  "SEV-2": ":large_orange_diamond:",
  "SEV-3": ":information_source:",
}

/** The webhook text body — Slack-friendly plain text, no markup required. */
export function formatAlertText(alert: Omit<NormalizedAlert, "error" | "bypassDedupe">, at: string): string {
  const lines = [`${SEVERITY_ICON[alert.severity]} [${alert.severity}] ${alert.source} — ${alert.title}`]
  if (alert.detail) lines.push(alert.detail)
  const refs = Object.entries(alert.refs)
  if (refs.length > 0) lines.push(refs.map(([k, v]) => `${k}=${v}`).join(" · "))
  lines.push(`at ${at} · gradia`)
  return lines.join("\n")
}

/** SEV-0/1 SMS: severity + source + title only — never detail, never refs. */
export function formatAlertSms(alert: Pick<NormalizedAlert, "severity" | "source" | "title">): string {
  return `Gradia ${alert.severity} ${alert.source}: ${alert.title}`.slice(0, 160)
}

function dedupeKey(a: NormalizedAlert): string {
  return `${a.severity}|${a.source}|${a.title}`
}

function isSuppressed(key: string, now: number): boolean {
  const last = state.recent.get(key)
  if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return true
  // Bounded memory: drop expired keys, then the oldest if still over cap.
  if (state.recent.size >= DEDUPE_MAX_KEYS) {
    for (const [k, t] of state.recent) {
      if (now - t >= DEDUPE_WINDOW_MS) state.recent.delete(k)
    }
    if (state.recent.size >= DEDUPE_MAX_KEYS) {
      const oldest = state.recent.keys().next().value
      if (oldest !== undefined) state.recent.delete(oldest)
    }
  }
  state.recent.set(key, now)
  return false
}

async function sentryHook(alert: NormalizedAlert): Promise<void> {
  const wantsSentry = alert.error !== undefined || alert.severity === "SEV-0" || alert.severity === "SEV-1"
  if (!wantsSentry) return
  try {
    const Sentry = await import("@sentry/nextjs")
    const tags = { severity: alert.severity, source: alert.source, ops_alert: "true" }
    if (alert.error !== undefined) {
      Sentry.captureException(alert.error, { tags, extra: { title: alert.title } })
    } else {
      Sentry.captureMessage(`[${alert.severity}] ${alert.source} — ${alert.title}`, {
        level: "error",
        tags,
      })
    }
  } catch (err) {
    // Sentry is best-effort; the seam must not depend on it.
    console.error("[alerts] sentry hook failed:", err instanceof Error ? err.name : "error")
  }
}

async function deliverWebhook(url: string, text: string): Promise<ChannelOutcome> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    })
    if (!res.ok) {
      // Status only — the destination URL is a secret and never logged.
      console.error(`[alerts] webhook delivery failed: HTTP ${res.status}`)
      return "failed"
    }
    return "delivered"
  } catch (err) {
    const name = err instanceof Error ? err.name : "error"
    console.error(`[alerts] webhook delivery failed: ${name === "AbortError" ? "timeout" : name}`)
    return "failed"
  } finally {
    clearTimeout(timer)
  }
}

async function deliverSms(
  alert: NormalizedAlert,
  cfg: { to: string; from: string }
): Promise<ChannelOutcome> {
  try {
    const { resolveTwilioCredentials, sendOutboundSms } = await import("@/lib/twilio")
    const creds = resolveTwilioCredentials(null)
    if (!creds) {
      console.error("[alerts] sms delivery skipped: Twilio env credentials not configured")
      return "unconfigured"
    }
    await sendOutboundSms({ from: cfg.from, to: cfg.to, body: formatAlertSms(alert), creds })
    return "delivered"
  } catch (err) {
    console.error(`[alerts] sms delivery failed: ${err instanceof Error ? err.name : "error"}`)
    return "failed"
  }
}

/**
 * Emit one ops alert. Never throws; never blocks the caller's outcome.
 * Always logs a `[alerts]` line (the floor); delivers to whatever is
 * configured; collapses bursts; cross-references Sentry.
 */
export async function sendOpsAlert(input: OpsAlertInput): Promise<AlertDeliveryResult> {
  try {
    const alert = normalize(input)
    if (!alert) {
      state.invalid += 1
      console.error("[alerts] invalid alert input ignored")
      return { delivered: false, reason: "invalid", channels: { webhook: "skipped", sms: "skipped" } }
    }
    const at = new Date().toISOString()
    const line = `[alerts] ${alert.severity} ${alert.source} — ${alert.title}${alert.detail ? ` — ${alert.detail}` : ""}`
    if (alert.severity === "SEV-0" || alert.severity === "SEV-1") console.error(line)
    else console.warn(line)

    await sentryHook(alert)

    if (!alert.bypassDedupe && isSuppressed(dedupeKey(alert), Date.now())) {
      state.suppressed += 1
      return { delivered: false, reason: "suppressed", channels: { webhook: "skipped", sms: "skipped" } }
    }

    const url = webhookUrl()
    const sms = smsConfig()
    const smsEligible = alert.severity === "SEV-0" || alert.severity === "SEV-1"
    if (!url && !(sms && smsEligible)) {
      return {
        delivered: false,
        reason: "unconfigured",
        channels: { webhook: "unconfigured", sms: sms ? "skipped" : "unconfigured" },
      }
    }

    const [webhook, smsOutcome] = await Promise.all([
      url ? deliverWebhook(url, formatAlertText(alert, at)) : Promise.resolve<ChannelOutcome>("unconfigured"),
      sms ? (smsEligible ? deliverSms(alert, sms) : Promise.resolve<ChannelOutcome>("skipped")) : Promise.resolve<ChannelOutcome>("unconfigured"),
    ])

    const delivered = webhook === "delivered" || smsOutcome === "delivered"
    const failed = webhook === "failed" || smsOutcome === "failed"
    if (delivered) {
      state.delivered += 1
      state.lastDeliveredAt = at
    }
    if (failed) {
      state.failed += 1
      state.lastFailureAt = at
    }
    return {
      delivered,
      reason: delivered ? "delivered" : "failed",
      channels: { webhook, sms: smsOutcome },
    }
  } catch (err) {
    state.failed += 1
    state.lastFailureAt = new Date().toISOString()
    console.error("[alerts] delivery crashed:", err instanceof Error ? err.name : "error")
    return { delivered: false, reason: "failed", channels: { webhook: "failed", sms: "failed" } }
  }
}

/** The built-in test alert (manual acceptance step 6 / POST /api/admin/alert-test). */
export function sendTestOpsAlert(note?: string): Promise<AlertDeliveryResult> {
  return sendOpsAlert({
    severity: "SEV-3",
    source: "alerts",
    title: "Test alert — delivery check",
    detail: note?.slice(0, 200) || "If you can read this, the founder ops channel is wired.",
    refs: { action: "none", retryable: false },
    bypassDedupe: true,
  })
}

/** Self-status for /api/health (counts + configured flags; per-instance). */
export function alertSeamStatus(): AlertSeamStatus {
  return {
    webhookConfigured: webhookUrl() !== null,
    smsConfigured: smsConfig() !== null,
    delivered: state.delivered,
    failed: state.failed,
    suppressed: state.suppressed,
    invalid: state.invalid,
    lastDeliveredAt: state.lastDeliveredAt,
    lastFailureAt: state.lastFailureAt,
  }
}

/** Tests only. */
export function resetAlertSeamForTests(): void {
  state.delivered = 0
  state.failed = 0
  state.suppressed = 0
  state.invalid = 0
  state.lastDeliveredAt = null
  state.lastFailureAt = null
  state.recent.clear()
}
