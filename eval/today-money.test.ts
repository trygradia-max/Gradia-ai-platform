import { describe, it, expect } from "vitest"

import { summarizeAttribution } from "@/lib/data/today-money"
import type { CrmStage } from "@/lib/types/database"

/**
 * C8 — attribution math locks (under-claim discipline). Only automation-
 * touched leads that are NOW booked AND carry a real quote total count.
 * No estimates, ever.
 */

describe("summarizeAttribution", () => {
  const stageById = new Map<string, CrmStage>([
    ["lead-booked", "booked"],
    ["lead-open", "quote_sent"],
    ["lead-booked-noquote", "booked"],
  ])
  const quoteCents = new Map<string, number>([
    ["lead-booked", 70000],
    ["lead-open", 20000],
    // lead-booked-noquote deliberately absent
  ])

  it("counts only booked + quote-backed leads, deduped across runs", () => {
    const result = summarizeAttribution(
      [
        { lead_id: "lead-booked" },
        { lead_id: "lead-booked" }, // touched twice → counted once
        { lead_id: "lead-open" }, // not booked → excluded
        { lead_id: "lead-booked-noquote" }, // booked but no quote $ → excluded
        { lead_id: null }, // no lead → excluded
      ],
      stageById,
      quoteCents
    )
    expect(result).toEqual({ bookedCount: 1, bookedCents: 70000 })
  })

  it("claims nothing when nothing qualifies", () => {
    expect(summarizeAttribution([], stageById, quoteCents)).toEqual({
      bookedCount: 0,
      bookedCents: 0,
    })
    expect(
      summarizeAttribution([{ lead_id: "lead-open" }], stageById, quoteCents)
    ).toEqual({ bookedCount: 0, bookedCents: 0 })
  })
})
