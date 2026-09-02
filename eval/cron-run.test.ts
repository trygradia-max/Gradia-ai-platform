import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync, readdirSync } from "node:fs"

/**
 * P0-012 — the cron wrapper (lib/cron-run.ts): one failure = one alert +
 * failure stamp; success = success stamp, no alert; 401 = nothing. Plus the
 * two-way registration lock (vercel.json ↔ CRON_REGISTRY ↔ route files).
 */

const { sendOpsAlert, upsert } = vi.hoisted(() => ({
  sendOpsAlert: vi.fn<(input: Record<string, unknown>) => Promise<unknown>>(async () => ({
    delivered: true,
    reason: "delivered",
    channels: { webhook: "delivered", sms: "skipped" },
  })),
  upsert: vi.fn<(values: Record<string, unknown>, opts: { onConflict: string }) => Promise<{ error: { message: string } | null }>>(
    async () => ({ error: null })
  ),
}))
vi.mock("@/lib/alerts", () => ({ sendOpsAlert }))
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({ from: () => ({ upsert }) }),
}))

import {
  CRON_NAMES,
  CRON_REGISTRY,
  runCron,
  staleAfterMs,
  stampCronHeartbeat,
  summarizeCronHealth,
} from "@/lib/cron-run"

const req = () => new Request("http://localhost/api/cron/agents")

beforeEach(() => {
  sendOpsAlert.mockClear()
  upsert.mockClear()
  upsert.mockResolvedValue({ error: null })
})

describe("runCron", () => {
  it("healthy run → success stamp, no alert, response untouched", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const res = await runCron("agents", req(), async () => Response.json({ ok: true, n: 3 }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, n: 3 })
    expect(sendOpsAlert).not.toHaveBeenCalled()
    expect(upsert).toHaveBeenCalledTimes(1)
    const [values, opts] = upsert.mock.calls[0]
    expect(values).toMatchObject({ name: "agents", last_error: null })
    expect(values.last_success_at).toBeTruthy()
    expect(opts).toEqual({ onConflict: "name" })
  })

  it("handler throws → exactly one SEV-2 alert naming the cron, failure stamp, 500 JSON", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const boom = new Error("sweep exploded")
    const res = await runCron("reminders", req(), async () => { throw boom })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, error: "sweep exploded" })
    expect(sendOpsAlert).toHaveBeenCalledTimes(1)
    expect(sendOpsAlert).toHaveBeenCalledWith(expect.objectContaining({
      severity: "SEV-2",
      source: "cron/reminders",
      title: "Cron reminders failed",
      detail: "sweep exploded",
      error: boom,
    }))
    const values = upsert.mock.calls[0][0]
    expect(values).toMatchObject({ name: "reminders", last_error: "sweep exploded" })
    expect(values.last_failure_at).toBeTruthy()
  })

  it("handler returns its own 5xx → one alert with the body's error, status preserved", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const res = await runCron("voice-sync", req(), async () =>
      Response.json({ ok: false, error: "GRADIA_DASHBOARD_URL not configured" }, { status: 500 })
    )
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, error: "GRADIA_DASHBOARD_URL not configured" })
    expect(sendOpsAlert).toHaveBeenCalledTimes(1)
    expect(sendOpsAlert.mock.calls[0][0]).toMatchObject({ source: "cron/voice-sync", detail: "GRADIA_DASHBOARD_URL not configured" })
  })

  it("401 (auth refusal) → no stamp, no alert", async () => {
    const res = await runCron("agents", req(), async () => new Response("Unauthorized", { status: 401 }))
    expect(res.status).toBe(401)
    expect(sendOpsAlert).not.toHaveBeenCalled()
    expect(upsert).not.toHaveBeenCalled()
  })

  it("a heartbeat write failure never changes the cron's outcome", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    upsert.mockResolvedValueOnce({ error: { message: "relation missing" } })
    const res = await runCron("agents", req(), async () => Response.json({ ok: true }))
    expect(res.status).toBe(200)
    expect(error.mock.calls.some((c) => String(c[0]).includes("heartbeat stamp failed"))).toBe(true)
    upsert.mockRejectedValueOnce(new Error("network"))
    await expect(stampCronHeartbeat("agents", { ok: true })).resolves.toBeUndefined()
  })

  it("error text is truncated to 200 chars before it is stamped", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    await runCron("agents", req(), async () => { throw new Error("x".repeat(1000)) })
    const values = upsert.mock.calls[0][0]
    expect(String(values.last_error)).toHaveLength(200)
  })
})

describe("summarizeCronHealth (pure)", () => {
  const now = Date.parse("2026-09-01T12:00:00Z")
  it("never-ran → ok null / stale null; fresh success → ok true, not stale; old success → stale", () => {
    const h = summarizeCronHealth(
      [
        { name: "agents", last_success_at: "2026-09-01T11:30:00Z", last_failure_at: null },
        { name: "reconcile", last_success_at: "2026-08-20T08:00:00Z", last_failure_at: null },
      ],
      now
    )
    expect(h.reminders).toEqual({ lastSuccessAt: null, lastFailureAt: null, ok: null, stale: null })
    expect(h.agents).toMatchObject({ ok: true, stale: false })
    expect(h.reconcile).toMatchObject({ ok: true, stale: true })
  })
  it("last run failed after last success → ok false; a later success clears it", () => {
    const failed = summarizeCronHealth(
      [{ name: "agents", last_success_at: "2026-09-01T10:00:00Z", last_failure_at: "2026-09-01T11:00:00Z" }],
      now
    )
    expect(failed.agents.ok).toBe(false)
    const cleared = summarizeCronHealth(
      [{ name: "agents", last_success_at: "2026-09-01T11:30:00Z", last_failure_at: "2026-09-01T11:00:00Z" }],
      now
    )
    expect(cleared.agents.ok).toBe(true)
  })
  it("stale threshold is 2× period + 10 min grace", () => {
    expect(staleAfterMs("automations")).toBe(2 * 5 * 60_000 + 10 * 60_000)
    expect(staleAfterMs("roi-receipt")).toBe(2 * 7 * 24 * 60 * 60_000 + 10 * 60_000)
  })
})

describe("registration lock (vercel.json ↔ CRON_REGISTRY ↔ route files)", () => {
  const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as {
    crons: { path: string; schedule: string }[]
  }
  const cronDir = new URL("../src/app/api/cron/", import.meta.url)

  it("every vercel.json cron is in the registry and vice versa", () => {
    const registered = vercel.crons.map((c) => c.path.replace("/api/cron/", "")).sort()
    expect(registered).toEqual([...CRON_NAMES].sort())
  })

  it("every cron route runs through runCron with its own name", () => {
    const dirs = readdirSync(cronDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
    expect(dirs).toEqual([...CRON_NAMES].sort())
    for (const name of dirs) {
      const src = readFileSync(new URL(`${name}/route.ts`, cronDir), "utf8")
      expect(src, `${name}: must export GET via runCron`).toContain(`runCron("${name}", request, handle)`)
      expect(src, `${name}: no second GET export`).not.toMatch(/export async function GET/)
    }
  })

  it("registry periods match the schedules' cadence class", () => {
    for (const c of vercel.crons) {
      const name = c.path.replace("/api/cron/", "") as keyof typeof CRON_REGISTRY
      const period = CRON_REGISTRY[name].periodMinutes
      if (c.schedule.startsWith("*/")) expect(period).toBe(Number(c.schedule.slice(2).split(" ")[0]))
      else if (/^\d+ \* \* \* \*$/.test(c.schedule)) expect(period).toBe(60)
      else if (/^\d+ \d+ \* \* \*$/.test(c.schedule)) expect(period).toBe(24 * 60)
      else if (/^\d+ \d+ \* \* \d$/.test(c.schedule)) expect(period).toBe(7 * 24 * 60)
      else throw new Error(`unrecognised schedule ${c.schedule} for ${name}`)
    }
  })
})
