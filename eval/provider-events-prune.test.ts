import { describe, it, expect, vi, beforeEach, afterAll } from "vitest"
import { readFileSync } from "node:fs"

/**
 * P0-005A — provider_events retention/pruning: unit tier.
 *
 * Locks (1) the retention policy constants against the provider retry-horizon
 * floor, (2) the cron route's fail-closed auth + bounded batch loop + error
 * surface (service client mocked — the real RPC is proven in
 * eval/integration/provider-events-prune.int.test.ts), (3) the cron
 * registration, and (4) the migration's structural guarantees (SKIP LOCKED,
 * floors, `processing` never in a DELETE, service-role-only EXECUTE).
 */

const rpc = vi.fn()
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({ rpc }),
}))

import { GET } from "@/app/api/cron/provider-events-prune/route"
import {
  PROVIDER_EVENT_RETENTION,
  formatPruneRunLog,
  pruneRunWarnings,
  runProviderEventPruning,
  type PruneBatchReport,
} from "@/lib/provider-events-retention"

const SECRET = "unit-cron-secret"
const ORIGINAL_SECRET = process.env.CRON_SECRET

function report(over: Partial<PruneBatchReport> = {}): PruneBatchReport {
  return {
    completed_pruned: 0,
    failed_pruned: 0,
    completed_expired_remaining: 0,
    failed_expired_remaining: 0,
    oldest_completed_at: null,
    oldest_failed_at: null,
    processing_rows: 0,
    attempts_over_cap: 0,
    oversized_metadata: 0,
    completed_retention_days: PROVIDER_EVENT_RETENTION.completedDays,
    failed_retention_days: PROVIDER_EVENT_RETENTION.failedDays,
    batch_size: PROVIDER_EVENT_RETENTION.batchSize,
    ...over,
  }
}

function req(auth?: string) {
  return new Request("http://localhost/api/cron/provider-events-prune", {
    headers: auth ? { authorization: auth } : {},
  })
}

beforeEach(() => {
  rpc.mockReset()
  process.env.CRON_SECRET = SECRET
})

afterAll(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = ORIGINAL_SECRET
})

describe("retention policy constants (ADR-001 C2 addendum)", () => {
  it("floor is at least 2× the longest provider retry horizon (Stripe ≈ 3 days)", () => {
    expect(PROVIDER_EVENT_RETENTION.floorDays).toBeGreaterThanOrEqual(7)
  })
  it("completed window ≥ floor, failed window ≥ completed window", () => {
    expect(PROVIDER_EVENT_RETENTION.completedDays).toBeGreaterThanOrEqual(
      PROVIDER_EVENT_RETENTION.floorDays
    )
    expect(PROVIDER_EVENT_RETENTION.failedDays).toBeGreaterThanOrEqual(
      PROVIDER_EVENT_RETENTION.completedDays
    )
  })
  it("a run is bounded: finite batches of bounded size", () => {
    expect(PROVIDER_EVENT_RETENTION.maxBatchesPerRun).toBeGreaterThanOrEqual(1)
    expect(PROVIDER_EVENT_RETENTION.batchSize).toBeGreaterThanOrEqual(1)
    expect(PROVIDER_EVENT_RETENTION.batchSize).toBeLessThanOrEqual(50_000)
  })
})

describe("cron route auth (fails closed)", () => {
  it("401 when CRON_SECRET is not configured — and never touches the database", async () => {
    delete process.env.CRON_SECRET
    const res = await GET(req(`Bearer ${SECRET}`))
    expect(res.status).toBe(401)
    expect(rpc).not.toHaveBeenCalled()
  })
  it("401 on a missing or wrong bearer — no database call", async () => {
    expect((await GET(req())).status).toBe(401)
    expect((await GET(req("Bearer nope"))).status).toBe(401)
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe("cron route run", () => {
  it("calls the prune RPC with the policy defaults and reports the counts", async () => {
    rpc.mockResolvedValueOnce({
      data: report({
        completed_pruned: 12,
        failed_pruned: 1,
        oldest_completed_at: "2026-08-10T00:00:00Z",
        processing_rows: 2,
      }),
      error: null,
    })
    const res = await GET(req(`Bearer ${SECRET}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      ok: true,
      batches: 1,
      completedPruned: 12,
      failedPruned: 1,
      expiredRemaining: 0,
      oldestCompletedAt: "2026-08-10T00:00:00Z",
      processingRows: 2,
    })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith("prune_provider_events", {
      p_completed_retention_days: PROVIDER_EVENT_RETENTION.completedDays,
      p_failed_retention_days: PROVIDER_EVENT_RETENTION.failedDays,
      p_batch_size: PROVIDER_EVENT_RETENTION.batchSize,
    })
  })

  it("keeps batching while a batch was full, stops on the first partial batch", async () => {
    const size = PROVIDER_EVENT_RETENTION.batchSize
    rpc
      .mockResolvedValueOnce({ data: report({ completed_pruned: size }), error: null })
      .mockResolvedValueOnce({ data: report({ completed_pruned: size, failed_pruned: 3 }), error: null })
      .mockResolvedValueOnce({ data: report({ completed_pruned: 7 }), error: null })
    const res = await GET(req(`Bearer ${SECRET}`))
    const body = await res.json()
    expect(rpc).toHaveBeenCalledTimes(3)
    expect(body.batches).toBe(3)
    expect(body.completedPruned).toBe(size * 2 + 7)
    expect(body.failedPruned).toBe(3)
  })

  it("never exceeds maxBatchesPerRun even when every batch is full", async () => {
    const size = PROVIDER_EVENT_RETENTION.batchSize
    rpc.mockResolvedValue({ data: report({ completed_pruned: size }), error: null })
    const res = await GET(req(`Bearer ${SECRET}`))
    const body = await res.json()
    expect(rpc).toHaveBeenCalledTimes(PROVIDER_EVENT_RETENTION.maxBatchesPerRun)
    expect(body.batches).toBe(PROVIDER_EVENT_RETENTION.maxBatchesPerRun)
  })

  it("surfaces a database error as 500 (rows accumulate — the safe direction)", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "boom" } })
    const res = await GET(req(`Bearer ${SECRET}`))
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ ok: false })
  })
})

describe("run log + hardening warnings", () => {
  it("one info line carries counts and oldest-remaining; warnings only when thresholds trip", async () => {
    rpc.mockResolvedValueOnce({
      data: report({
        completed_pruned: 4,
        completed_expired_remaining: 2,
        failed_expired_remaining: 1,
        oldest_failed_at: "2026-06-01T00:00:00Z",
      }),
      error: null,
    })
    const summary = await runProviderEventPruning({ rpc } as never)
    const line = formatPruneRunLog(summary)
    expect(line).toContain("[cron/provider-events-prune]")
    expect(line).toContain("completed_pruned=4")
    expect(line).toContain("expired_remaining=3")
    expect(line).toContain("oldest_failed_at=2026-06-01T00:00:00Z")
    expect(pruneRunWarnings(summary)).toEqual([])

    rpc.mockResolvedValueOnce({
      data: report({ attempts_over_cap: 2, oversized_metadata: 1 }),
      error: null,
    })
    const noisy = await runProviderEventPruning({ rpc } as never)
    const warnings = pruneRunWarnings(noisy)
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toMatch(/exceed 25 attempts/)
    expect(warnings[1]).toMatch(/>4KB metadata/)
  })
})

describe("registration + migration structure (source-level locks)", () => {
  const vercel = JSON.parse(
    readFileSync(new URL("../vercel.json", import.meta.url), "utf8")
  ) as { crons: { path: string; schedule: string }[] }
  const migration = readFileSync(
    new URL("../supabase/migrations/20260901120000_provider_events_pruning.sql", import.meta.url),
    "utf8"
  )

  it("the prune cron is registered daily in vercel.json", () => {
    const entry = vercel.crons.find((c) => c.path === "/api/cron/provider-events-prune")
    expect(entry).toBeDefined()
    // Five fields, hour-of-day fixed, every day: a daily schedule.
    expect(entry?.schedule).toMatch(/^\d+ \d+ \* \* \*$/)
  })

  it("deletes are bounded, oldest-first and overlap-safe (LIMIT + FOR UPDATE SKIP LOCKED)", () => {
    // Statement positions only (the header comment mentions the clause too).
    const deletes = migration.match(/^\s+FOR UPDATE SKIP LOCKED$/gm) ?? []
    expect(deletes).toHaveLength(2)
    expect(migration).toMatch(/ORDER BY completed_at\s+LIMIT v_batch/)
    expect(migration).toMatch(/ORDER BY failed_at\s+LIMIT v_batch/)
  })

  it("`processing` rows are never a DELETE target — only a counted FILTER", () => {
    const mentions = migration.match(/status = 'processing'/g) ?? []
    expect(mentions).toHaveLength(1)
    expect(migration).toMatch(/count\(\*\) FILTER \(WHERE status = 'processing'\)/)
    // Every DELETE is re-guarded on the terminal status of the victim row.
    expect(migration).toMatch(/AND pe\.status = 'completed'/)
    expect(migration).toMatch(/AND pe\.status = 'failed'/)
  })

  it("retention floors are clamped in SQL, not just in TypeScript", () => {
    expect(migration).toMatch(/GREATEST\(COALESCE\(p_completed_retention_days, 30\), 7\)/)
    expect(migration).toMatch(/GREATEST\(COALESCE\(p_failed_retention_days, 90\), 7\)/)
    expect(PROVIDER_EVENT_RETENTION.floorDays).toBe(7)
  })

  it("the prune RPC is service-role only, like the claim lifecycle RPCs", () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.prune_provider_events\(integer, integer, integer\) FROM PUBLIC, anon, authenticated;/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.prune_provider_events\(integer, integer, integer\) TO service_role;/
    )
  })
})
