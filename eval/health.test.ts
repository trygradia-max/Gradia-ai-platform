import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * P0-012 — GET /api/health: shape, status codes, degraded/down logic, and the
 * information-disclosure lock (no tenant data, no env names, no error text).
 */

type Row = { name: string; last_success_at: string | null; last_failure_at: string | null }
let dbResult: () => Promise<{ data: Row[] | null; error: { message: string } | null }>
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: () => ({ select: () => ({ limit: () => dbResult() }) }),
  }),
}))

import { GET } from "@/app/api/health/route"
import { resetAlertSeamForTests } from "@/lib/alerts"
import { CRON_NAMES } from "@/lib/cron-run"

beforeEach(() => {
  resetAlertSeamForTests()
  delete process.env.OPS_ALERT_WEBHOOK_URL
  dbResult = async () => ({ data: [], error: null })
})

function allKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.add(k)
      allKeys(v, out)
    }
  }
  return out
}

describe("GET /api/health", () => {
  it("healthy: 200, status ok, every registered cron listed, no-store", async () => {
    dbResult = async () => ({
      data: [{ name: "agents", last_success_at: new Date().toISOString(), last_failure_at: null }],
      error: null,
    })
    const res = await GET()
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    const body = await res.json()
    expect(body).toMatchObject({ status: "ok", ok: true, checks: { db: { ok: true } } })
    expect(typeof body.checks.db.latencyMs).toBe("number")
    expect(Object.keys(body.checks.crons).sort()).toEqual([...CRON_NAMES].sort())
    expect(body.checks.crons.agents).toMatchObject({ ok: true, stale: false })
    expect(body.checks.crons.reminders).toEqual({ lastSuccessAt: null, lastFailureAt: null, ok: null, stale: null })
    expect(body.checks.alerts).toMatchObject({ webhookConfigured: false, delivered: 0, failed: 0 })
  })

  it("database unreachable (error) → 503 down; timeout → 503 down", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    dbResult = async () => ({ data: null, error: { message: "connection refused" } })
    let res = await GET()
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ status: "down", ok: false, checks: { db: { ok: false, latencyMs: null } } })

    dbResult = () => new Promise(() => {}) // never resolves
    vi.useFakeTimers()
    const pending = GET()
    await vi.advanceTimersByTimeAsync(3_100)
    res = await pending
    vi.useRealTimers()
    expect(res.status).toBe(503)
  })

  it("a stale or failed cron → 200 degraded", async () => {
    dbResult = async () => ({
      data: [{ name: "reconcile", last_success_at: "2026-01-01T00:00:00Z", last_failure_at: null }],
      error: null,
    })
    let body = await (await GET()).json()
    expect(body.status).toBe("degraded")
    expect(body.checks.crons.reconcile.stale).toBe(true)

    const t = Date.now()
    dbResult = async () => ({
      data: [{ name: "agents", last_success_at: new Date(t - 60_000).toISOString(), last_failure_at: new Date(t).toISOString() }],
      error: null,
    })
    body = await (await GET()).json()
    expect(body.status).toBe("degraded")
    expect(body.checks.crons.agents.ok).toBe(false)
  })

  it("discloses nothing sensitive: no tenant fields, env names, versions or error text", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    dbResult = async () => ({ data: null, error: { message: "FATAL: password authentication failed for user postgres" } })
    const res = await GET()
    const text = await res.text()
    expect(text).not.toMatch(/password|postgres|FATAL/i)
    const keys = [...allKeys(JSON.parse(text))]
    expect(keys.sort()).toEqual(
      [
        "status", "ok", "at", "checks", "db", "latencyMs", "alerts",
        "webhookConfigured", "smsConfigured", "delivered", "failed", "suppressed", "invalid",
        "lastDeliveredAt", "lastFailureAt", "crons", ...CRON_NAMES,
        "lastSuccessAt", "stale",
      ].sort()
    )
    for (const k of keys) expect(k).not.toMatch(/shop|customer|email|phone|token|secret|env|version|error|url|key/i)
  })
})
