import { describe, it, expect, vi, beforeEach, afterAll } from "vitest"

/**
 * P0-012 — the ops alert seam (lib/alerts.ts): unit tier.
 * Fail-open, self-reporting, burst-deduped, Sentry cross-referenced,
 * destination-secret never logged. Network + Twilio + Sentry are mocked.
 */

const captureException = vi.fn()
const captureMessage = vi.fn()
vi.mock("@sentry/nextjs", () => ({ captureException, captureMessage }))

const sendOutboundSms = vi.fn(async () => ({ messageSid: "SM1", status: "queued" }))
const resolveTwilioCredentials = vi.fn(() => ({ accountSid: "ACenv", authToken: "tok", source: "env" as const }))
vi.mock("@/lib/twilio", () => ({ sendOutboundSms, resolveTwilioCredentials }))

import {
  DEDUPE_WINDOW_MS,
  alertSeamStatus,
  formatAlertSms,
  formatAlertText,
  resetAlertSeamForTests,
  sendOpsAlert,
  sendTestOpsAlert,
} from "@/lib/alerts"

const WEBHOOK = "https://hooks.example.test/services/T000/B000/SECRETPART"
const ENV_KEYS = ["OPS_ALERT_WEBHOOK_URL", "OPS_ALERT_SMS_TO", "OPS_ALERT_SMS_FROM"] as const
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))

const fetchMock = vi.fn()
vi.stubGlobal("fetch", fetchMock)

function okResponse() {
  return new Response("ok", { status: 200 })
}

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
  fetchMock.mockReset()
  captureException.mockReset()
  captureMessage.mockReset()
  sendOutboundSms.mockClear()
  resetAlertSeamForTests()
  vi.useRealTimers()
})

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  vi.unstubAllGlobals()
})

describe("unconfigured (the rollback position)", () => {
  it("logs, returns unconfigured, never throws, never fetches", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const res = await sendOpsAlert({ severity: "SEV-2", source: "monitoring", title: "t" })
    expect(res).toEqual({
      delivered: false,
      reason: "unconfigured",
      channels: { webhook: "unconfigured", sms: "unconfigured" },
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(warn.mock.calls.some((c) => String(c[0]).startsWith("[alerts] SEV-2 monitoring — t"))).toBe(true)
    expect(alertSeamStatus()).toMatchObject({ webhookConfigured: false, smsConfigured: false, delivered: 0, failed: 0 })
    warn.mockRestore()
  })
})

describe("webhook delivery", () => {
  it("posts a text payload carrying severity, source, title, detail and refs", async () => {
    process.env.OPS_ALERT_WEBHOOK_URL = WEBHOOK
    fetchMock.mockResolvedValueOnce(okResponse())
    vi.spyOn(console, "error").mockImplementation(() => {})
    const res = await sendOpsAlert({
      severity: "SEV-1",
      source: "reconcile",
      title: "Drift",
      detail: "shop A 4.2%",
      refs: { shops: 1, action: "none", retryable: false },
    })
    expect(res.delivered).toBe(true)
    expect(res.channels).toEqual({ webhook: "delivered", sms: "unconfigured" })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(WEBHOOK)
    const body = JSON.parse(String(init.body)) as { text: string }
    expect(body.text).toContain("[SEV-1] reconcile — Drift")
    expect(body.text).toContain("shop A 4.2%")
    expect(body.text).toContain("shops=1")
    expect(body.text).toContain("retryable=false")
    expect(alertSeamStatus()).toMatchObject({ delivered: 1, failed: 0, lastFailureAt: null })
    expect(alertSeamStatus().lastDeliveredAt).not.toBeNull()
  })

  it("destination returns 500 → fail-open: no throw, counted, and the URL is never logged", async () => {
    process.env.OPS_ALERT_WEBHOOK_URL = WEBHOOK
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }))
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const res = await sendOpsAlert({ severity: "SEV-0", source: "tenancy", title: "violation" })
    expect(res).toMatchObject({ delivered: false, reason: "failed", channels: { webhook: "failed" } })
    expect(alertSeamStatus()).toMatchObject({ delivered: 0, failed: 1 })
    const logged = error.mock.calls.map((c) => c.map(String).join(" ")).join("\n")
    expect(logged).toContain("webhook delivery failed: HTTP 500")
    expect(logged).not.toContain("SECRETPART")
    expect(logged).not.toContain("hooks.example.test")
    error.mockRestore()
  })

  it("network failure / timeout → fail-open, counted, name only in the log", async () => {
    process.env.OPS_ALERT_WEBHOOK_URL = WEBHOOK
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("connect ECONNREFUSED " + WEBHOOK), { name: "TypeError" }))
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const res = await sendOpsAlert({ severity: "SEV-2", source: "cron/agents", title: "Cron agents failed" })
    expect(res.reason).toBe("failed")
    const logged = error.mock.calls.map((c) => c.map(String).join(" ")).join("\n")
    expect(logged).toContain("webhook delivery failed: TypeError")
    expect(logged).not.toContain("SECRETPART")
    error.mockRestore()
  })
})

describe("SMS channel (D-042: SEV-0/1 only)", () => {
  it("SEV-0 goes to SMS with severity/source/title only; SEV-2 skips SMS", async () => {
    process.env.OPS_ALERT_SMS_TO = "+15550001111"
    process.env.OPS_ALERT_SMS_FROM = "+15550002222"
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const sev0 = await sendOpsAlert({ severity: "SEV-0", source: "tenancy", title: "violation", detail: "SECRET-DETAIL" })
    expect(sev0.channels.sms).toBe("delivered")
    expect(sev0.channels.webhook).toBe("unconfigured")
    expect(sendOutboundSms).toHaveBeenCalledTimes(1)
    const call = sendOutboundSms.mock.calls[0] as unknown as [{ to: string; from: string; body: string }]
    expect(call[0].to).toBe("+15550001111")
    expect(call[0].body).toBe("Gradia SEV-0 tenancy: violation")
    expect(call[0].body).not.toContain("SECRET-DETAIL")

    const sev2 = await sendOpsAlert({ severity: "SEV-2", source: "monitoring", title: "spike" })
    expect(sev2.channels.sms).toBe("skipped")
    expect(sev2.reason).toBe("unconfigured") // no webhook, SMS not eligible → nothing configured for it
    expect(sendOutboundSms).toHaveBeenCalledTimes(1)
  })

  it("SMS send failure is fail-open and counted", async () => {
    process.env.OPS_ALERT_SMS_TO = "+15550001111"
    process.env.OPS_ALERT_SMS_FROM = "+15550002222"
    sendOutboundSms.mockRejectedValueOnce(new Error("twilio down"))
    vi.spyOn(console, "error").mockImplementation(() => {})
    const res = await sendOpsAlert({ severity: "SEV-1", source: "reconcile", title: "drift" })
    expect(res).toMatchObject({ delivered: false, reason: "failed", channels: { sms: "failed" } })
    expect(alertSeamStatus().failed).toBe(1)
  })
})

describe("burst dedupe", () => {
  it("same severity+source+title inside the window is suppressed after the first; different keys are not", async () => {
    process.env.OPS_ALERT_WEBHOOK_URL = WEBHOOK
    fetchMock.mockResolvedValue(okResponse())
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.useFakeTimers({ now: 1_700_000_000_000 })
    const a = () => sendOpsAlert({ severity: "SEV-2", source: "cron/reminders", title: "Cron reminders failed" })
    expect((await a()).reason).toBe("delivered")
    expect((await a()).reason).toBe("suppressed")
    expect((await a()).reason).toBe("suppressed")
    expect((await sendOpsAlert({ severity: "SEV-2", source: "cron/agents", title: "Cron agents failed" })).reason).toBe("delivered")
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(alertSeamStatus()).toMatchObject({ delivered: 2, suppressed: 2 })

    vi.setSystemTime(1_700_000_000_000 + DEDUPE_WINDOW_MS + 1)
    expect((await a()).reason).toBe("delivered")
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it("the built-in test alert bypasses dedupe", async () => {
    process.env.OPS_ALERT_WEBHOOK_URL = WEBHOOK
    fetchMock.mockResolvedValue(okResponse())
    vi.spyOn(console, "warn").mockImplementation(() => {})
    expect((await sendTestOpsAlert()).delivered).toBe(true)
    expect((await sendTestOpsAlert("again")).delivered).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe("validation + Sentry hook", () => {
  it("malformed input is rejected safely (no throw, no fetch, counted)", async () => {
    process.env.OPS_ALERT_WEBHOOK_URL = WEBHOOK
    vi.spyOn(console, "error").mockImplementation(() => {})
    for (const bad of [
      { severity: "SEV-9", source: "x", title: "t" },
      { severity: "SEV-1", source: "", title: "t" },
      { severity: "SEV-1", source: "x", title: "   " },
      null,
    ]) {
      const res = await sendOpsAlert(bad as never)
      expect(res.reason).toBe("invalid")
    }
    expect(fetchMock).not.toHaveBeenCalled()
    expect(alertSeamStatus().invalid).toBe(4)
  })

  it("truncates oversized detail/refs so a caller cannot flood the destination", async () => {
    process.env.OPS_ALERT_WEBHOOK_URL = WEBHOOK
    fetchMock.mockResolvedValueOnce(okResponse())
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const refs = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, "v".repeat(500)]))
    await sendOpsAlert({ severity: "SEV-3", source: "x", title: "t".repeat(1000), detail: "d".repeat(10_000), refs })
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as { text: string }
    expect(body.text.length).toBeLessThan(8_000)
  })

  it("an attached error is captured in Sentry with the severity tag; SEV-0/1 without one become messages; SEV-2/3 stay out", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const boom = new Error("boom")
    await sendOpsAlert({ severity: "SEV-2", source: "cron/agents", title: "Cron agents failed", error: boom })
    expect(captureException).toHaveBeenCalledWith(boom, expect.objectContaining({ tags: expect.objectContaining({ severity: "SEV-2", source: "cron/agents" }) }))
    await sendOpsAlert({ severity: "SEV-1", source: "reconcile", title: "drift" })
    expect(captureMessage).toHaveBeenCalledWith("[SEV-1] reconcile — drift", expect.objectContaining({ tags: expect.objectContaining({ severity: "SEV-1" }) }))
    captureMessage.mockClear()
    await sendOpsAlert({ severity: "SEV-3", source: "alerts", title: "quiet" })
    expect(captureMessage).not.toHaveBeenCalled()
  })

  it("formatters: text carries every field; SMS never carries detail and fits one segment", () => {
    const text = formatAlertText(
      { severity: "SEV-0", source: "tenancy", title: "T", detail: "D", refs: { row: "r1" } },
      "2026-09-01T00:00:00.000Z"
    )
    expect(text.split("\n")).toEqual([
      ":rotating_light: [SEV-0] tenancy — T",
      "D",
      "row=r1",
      "at 2026-09-01T00:00:00.000Z · gradia",
    ])
    const sms = formatAlertSms({ severity: "SEV-1", source: "reconcile", title: "x".repeat(300) })
    expect(sms.length).toBeLessThanOrEqual(160)
    expect(sms.startsWith("Gradia SEV-1 reconcile: ")).toBe(true)
  })
})
