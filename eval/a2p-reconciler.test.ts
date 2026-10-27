import { afterEach, describe, expect, it, vi } from "vitest"
import { a2pBackoffMs, a2pReconcileSchedule, a2pReconcilerEnabled, reconcileA2pRegistrations } from "@/lib/a2p-reconciler"

const MIN = 60_000
const HOUR = 60 * MIN

describe("held A2P reconciler: flag, schedule and backoff", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

  it("is off unless the flag is exactly 'true'", () => {
    expect(a2pReconcilerEnabled({})).toBe(false)
    for (const v of ["1", "yes", "TRUE ", "false", ""]) expect(a2pReconcilerEnabled({ A2P_RECONCILER_ENABLED: v }), v).toBe(v.trim() === "true")
    expect(a2pReconcilerEnabled({ A2P_RECONCILER_ENABLED: "true" })).toBe(true)
  })

  it("off, a run reads nothing", async () => {
    const supabase = new Proxy({}, { get: () => { throw new Error("touched the database") } })
    expect(await reconcileA2pRegistrations({ supabase: supabase as never, origin: "https://gradia.test", env: {} })).toEqual({ enabled: false })
  })

  it("keeps every interval at or under a quarter of the evidence maximum age", () => {
    expect(a2pReconcileSchedule({})).toEqual({ pendingIntervalMs: HOUR, settledIntervalMs: 6 * HOUR, backoffBaseMs: 5 * MIN, backoffCapMs: 6 * HOUR })
    const short = a2pReconcileSchedule({ A2P_EVIDENCE_MAX_AGE_HOURS: "8" })
    expect(short.settledIntervalMs).toBe(2 * HOUR)
    expect(short.backoffCapMs).toBe(2 * HOUR)
    expect(short.pendingIntervalMs).toBe(HOUR)
  })

  it("backs off exponentially from 5 minutes to the cap", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((f) => a2pBackoffMs(f, {}) / MIN)).toEqual([5, 10, 20, 40, 80, 160, 320, 360])
    expect(a2pBackoffMs(30, {})).toBe(6 * HOUR)
  })

  it("the route refuses without the cron secret and is a no-op with the flag off", async () => {
    vi.stubEnv("CRON_SECRET", "synthetic-secret")
    vi.stubEnv("A2P_RECONCILER_ENABLED", "")
    vi.doMock("@/lib/supabase/service", () => ({ createServiceClient: () => { throw new Error("touched the database") } }))
    const { GET } = await import("@/app/api/internal/a2p-reconcile/route")
    expect((await GET(new Request("https://gradia.test/api/internal/a2p-reconcile"))).status).toBe(401)
    expect((await GET(new Request("https://gradia.test/x", { headers: { authorization: "Bearer wrong" } }))).status).toBe(401)
    const off = await GET(new Request("https://gradia.test/x", { headers: { authorization: "Bearer synthetic-secret" } }))
    expect(await off.json()).toEqual({ ok: true, enabled: false })
  })
})
