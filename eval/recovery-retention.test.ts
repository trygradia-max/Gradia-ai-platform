import { describe, it, expect } from "vitest"

import {
  planRetention,
  RETENTION_DAYS,
  STALE_HOURS,
  type RetentionJob,
} from "@/lib/recovery/retention"

/**
 * Retention policy (GRADIA_CUSTOMER_RECOVERY_SPEC §1.2 acceptance — "raw uploads
 * deleted post-retention; test the job"). Pure decision logic.
 */

const NOW = Date.parse("2026-06-16T12:00:00Z")
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString()
const hoursAgo = (n: number) => new Date(NOW - n * 3_600_000).toISOString()

const job = (over: Partial<RetentionJob>): RetentionJob => ({
  id: "j",
  status: "ready",
  created_at: daysAgo(1),
  updated_at: daysAgo(1),
  ...over,
})

describe("planRetention", () => {
  it("purges bodies for jobs past the retention window", () => {
    const plan = planRetention(
      [job({ id: "old", created_at: daysAgo(RETENTION_DAYS + 1), updated_at: daysAgo(RETENTION_DAYS + 1) })],
      NOW
    )
    expect(plan.toPurge).toEqual(["old"])
    expect(plan.toFail).toEqual([])
  })

  it("purges failed jobs immediately, regardless of age", () => {
    const plan = planRetention(
      [job({ id: "failed", status: "failed", created_at: hoursAgo(1), updated_at: hoursAgo(1) })],
      NOW
    )
    expect(plan.toPurge).toEqual(["failed"])
  })

  it("fails AND purges an in-progress job idle past the stale window", () => {
    const plan = planRetention(
      [job({ id: "stuck", status: "extracting", updated_at: hoursAgo(STALE_HOURS + 1) })],
      NOW
    )
    expect(plan.toFail).toEqual(["stuck"])
    expect(plan.toPurge).toEqual(["stuck"])
  })

  it("leaves a fresh job awaiting confirmation alone", () => {
    const plan = planRetention(
      [job({ id: "pending", status: "estimating", created_at: hoursAgo(1), updated_at: hoursAgo(1) })],
      NOW
    )
    expect(plan.toFail).toEqual([])
    expect(plan.toPurge).toEqual([])
  })

  it("leaves a recent, completed job alone (its bodies were purged on done)", () => {
    const plan = planRetention([job({ id: "done", status: "ready" })], NOW)
    expect(plan.toPurge).toEqual([])
  })

  it("partitions a mixed set without double-counting", () => {
    const plan = planRetention(
      [
        job({ id: "fresh", status: "estimating", updated_at: hoursAgo(1) }),
        job({ id: "stuck", status: "extracting", updated_at: hoursAgo(STALE_HOURS + 2) }),
        job({ id: "failed", status: "failed" }),
        job({ id: "old", status: "ready", created_at: daysAgo(RETENTION_DAYS + 5), updated_at: daysAgo(RETENTION_DAYS + 5) }),
      ],
      NOW
    )
    expect(plan.toFail).toEqual(["stuck"])
    expect(plan.toPurge.sort()).toEqual(["failed", "old", "stuck"])
  })
})
