import { describe, it, expect } from "vitest"

import {
  appendStageHistory,
  nextActionAt,
  PIPELINE_STAGES,
  STAGE_TIMER_MINUTES,
  stageFromLegacyStatus,
} from "@/lib/pipeline"

/**
 * C2 — pipeline model locks: the 6 stages, the stage-timer defaults
 * (spec §C1.2), legacy-status fallback (pre-migration tolerance), and
 * history append semantics. Stage moves are code-driven; no model ever
 * picks a stage (locked principle #1).
 */

describe("stage model", () => {
  it("ships exactly the six spec stages, in board order", () => {
    expect(PIPELINE_STAGES.map((s) => s.key)).toEqual([
      "new",
      "needs_quote",
      "quote_sent",
      "follow_up",
      "booked",
      "lost",
    ])
  })

  it("timer defaults: new 5min · needs_quote same-day · quote_sent 2d · follow_up 4d", () => {
    expect(STAGE_TIMER_MINUTES.new).toBe(5)
    expect(STAGE_TIMER_MINUTES.needs_quote).toBe(8 * 60)
    expect(STAGE_TIMER_MINUTES.quote_sent).toBe(2 * 24 * 60)
    expect(STAGE_TIMER_MINUTES.follow_up).toBe(4 * 24 * 60)
    // Terminal stages never nag.
    expect(STAGE_TIMER_MINUTES.booked).toBeNull()
    expect(STAGE_TIMER_MINUTES.lost).toBeNull()
  })

  it("nextActionAt applies the timer from stage entry", () => {
    const from = new Date("2026-07-09T12:00:00Z")
    expect(nextActionAt("new", from)).toBe("2026-07-09T12:05:00.000Z")
    expect(nextActionAt("quote_sent", from)).toBe("2026-07-11T12:00:00.000Z")
    expect(nextActionAt("booked", from)).toBeNull()
  })
})

describe("stageFromLegacyStatus — pre-migration fallback", () => {
  it("maps the production lead_status values per resolved decision #1", () => {
    expect(stageFromLegacyStatus("new")).toBe("new")
    expect(stageFromLegacyStatus("quoted")).toBe("quote_sent")
    expect(stageFromLegacyStatus("booked")).toBe("booked")
    expect(stageFromLegacyStatus(null)).toBe("new")
  })
})

describe("appendStageHistory", () => {
  it("appends and tolerates malformed prior history", () => {
    const entry = {
      from: "new" as const,
      to: "quote_sent" as const,
      at: "2026-07-09T12:00:00Z",
      by: "system" as const,
    }
    expect(appendStageHistory([], entry)).toEqual([entry])
    expect(appendStageHistory("garbage", entry)).toEqual([entry])
    expect(appendStageHistory(null, entry)).toEqual([entry])
    const twice = appendStageHistory(appendStageHistory([], entry), {
      ...entry,
      from: "quote_sent",
      to: "booked",
    })
    expect(twice).toHaveLength(2)
    expect(twice[1].to).toBe("booked")
  })
})
