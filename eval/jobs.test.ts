import { describe, it, expect } from "vitest"

import {
  armMaintenanceSchedule,
  canTransition,
  CLOSE_AFTER_PAID_HOURS,
  JOB_STATUSES,
  JOB_TRANSITIONS,
  maintenanceIntervalMonths,
  nextActionsFor,
} from "@/lib/jobs"
import type { JobStatus } from "@/lib/types/database"

/**
 * C4a — job status machine locks. Every status is reachable from booked,
 * the money tail is one-way, on_hold resumes, and completed arms the
 * maintenance clock per service category.
 */

describe("status machine shape", () => {
  it("ships the 8 spec statuses in flow order", () => {
    expect(JOB_STATUSES.map((s) => s.key)).toEqual([
      "booked",
      "confirmed",
      "checked_in",
      "in_progress",
      "on_hold",
      "completed",
      "paid",
      "closed",
    ])
  })

  it("every status is reachable from booked", () => {
    const reached = new Set<JobStatus>(["booked"])
    const queue: JobStatus[] = ["booked"]
    while (queue.length) {
      const cur = queue.shift()!
      for (const next of JOB_TRANSITIONS[cur]) {
        if (!reached.has(next)) {
          reached.add(next)
          queue.push(next)
        }
      }
    }
    for (const s of JOB_STATUSES.map((x) => x.key)) {
      expect(reached.has(s), `${s} must be reachable`).toBe(true)
    }
  })

  it("the money tail is one-way and closed is terminal", () => {
    expect(canTransition("completed", "in_progress")).toBe(false)
    expect(canTransition("paid", "completed")).toBe(false)
    expect(nextActionsFor("closed")).toEqual([])
    expect(canTransition("paid", "closed")).toBe(true)
  })

  it("on_hold pauses live work and resumes", () => {
    for (const from of ["booked", "confirmed", "checked_in", "in_progress"] as JobStatus[]) {
      expect(canTransition(from, "on_hold"), `${from} → on_hold`).toBe(true)
    }
    expect(canTransition("on_hold", "in_progress")).toBe(true)
    expect(canTransition("on_hold", "completed")).toBe(true)
    // Money states can't be "held".
    expect(canTransition("paid", "on_hold")).toBe(false)
  })

  it("no skipping straight from booked to completed", () => {
    expect(canTransition("booked", "completed")).toBe(false)
    expect(canTransition("booked", "paid")).toBe(false)
  })
})

describe("maintenance clock (completed side effect)", () => {
  const completedAt = new Date("2026-07-09T18:00:00Z")

  it("intervals come from service category with a 6-month default", () => {
    expect(maintenanceIntervalMonths("protection")).toBe(12)
    expect(maintenanceIntervalMonths("wash")).toBe(1)
    expect(maintenanceIntervalMonths(null)).toBe(6)
    expect(maintenanceIntervalMonths("unheard-of")).toBe(6)
  })

  it("arms one entry per service with next_due_at pushed out", () => {
    const schedule = armMaintenanceSchedule(
      [],
      [
        { id: "svc-coat", category: "protection" },
        { id: "svc-wash", category: "wash" },
      ],
      completedAt
    )
    expect(schedule).toHaveLength(2)
    const coating = schedule.find((e) => e.service_id === "svc-coat")!
    expect(coating.interval_months).toBe(12)
    expect(coating.next_due_at).toBe("2027-07-09T18:00:00.000Z")
  })

  it("re-completing the same service resets its clock, keeps others", () => {
    const prior = armMaintenanceSchedule(
      [],
      [{ id: "svc-coat", category: "protection" }],
      new Date("2026-01-01T00:00:00Z")
    )
    const next = armMaintenanceSchedule(
      prior,
      [{ id: "svc-int", category: "interior" }],
      completedAt
    )
    expect(next).toHaveLength(2)
    expect(next.find((e) => e.service_id === "svc-coat")!.next_due_at).toBe(
      "2027-01-01T00:00:00.000Z"
    )
    expect(next.find((e) => e.service_id === "svc-int")!.interval_months).toBe(6)
  })

  it("tolerates malformed prior schedules", () => {
    const schedule = armMaintenanceSchedule("garbage", [{ id: "s", category: null }], completedAt)
    expect(schedule).toHaveLength(1)
  })
})

describe("close sweep constant", () => {
  it("closes 48h after paid (spec §C4)", () => {
    expect(CLOSE_AFTER_PAID_HOURS).toBe(48)
  })
})
