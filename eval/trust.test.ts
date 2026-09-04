import { describe, it, expect } from "vitest"

import type { SupabaseClient } from "@supabase/supabase-js"

import {
  getAutonomyRecommendations,
  getTrustStats,
  type ActionTrust,
} from "@/lib/trust"
import type { PendingActionType, ShopRow } from "@/lib/types/database"

/**
 * Tier 1 — pure. Locks earned-autonomy (L6): which action types get an
 * autopilot offer. Floors (money/calendar) are never eligible; offers require
 * Package 2, enough volume, and a high unedited rate.
 */

const stat = (
  actionType: PendingActionType,
  unedited: number,
  edited: number,
  rejected: number
): ActionTrust => {
  const decisions = unedited + edited + rejected
  return {
    actionType,
    approvedUnedited: unedited,
    approvedEdited: edited,
    rejected,
    decisions,
    uneditedRate: decisions ? unedited / decisions : 0,
  }
}

const pkg2 = (settings: Record<string, unknown> = {}) =>
  ({ settings, plan: "active", tier: "pro", voice_addon: false }) as Pick<
    ShopRow,
    "settings" | "plan" | "tier" | "voice_addon"
  >

describe("getAutonomyRecommendations", () => {
  it("offers an action with strong volume + unedited rate", () => {
    const recs = getAutonomyRecommendations(pkg2(), [stat("send_sms", 19, 1, 0)])
    expect(recs.map((r) => r.actionType)).toEqual(["send_sms"])
    expect(recs[0].label).toBe("texts")
    expect(recs[0].uneditedRate).toBeCloseTo(0.95)
  })

  it("never offers a money/calendar floor action, even with a perfect record", () => {
    const recs = getAutonomyRecommendations(pkg2(), [stat("book_appointment", 50, 0, 0)])
    expect(recs).toEqual([])
  })

  it("requires an autonomy tier (no offers for a Core shop)", () => {
    const core = { settings: {}, plan: "active", tier: "core", voice_addon: false } as Pick<
      ShopRow,
      "settings" | "plan" | "tier" | "voice_addon"
    >
    expect(getAutonomyRecommendations(core, [stat("send_sms", 40, 0, 0)])).toEqual([])
  })

  it("holds back below the volume floor or the unedited-rate threshold", () => {
    expect(getAutonomyRecommendations(pkg2(), [stat("send_email", 5, 0, 0)])).toEqual([]) // too few
    expect(getAutonomyRecommendations(pkg2(), [stat("add_note", 12, 8, 0)])).toEqual([]) // 60% edited
  })

  it("doesn't re-offer an action already on autopilot", () => {
    const shop = pkg2({ autonomy: { default: "suggest", overrides: { send_sms: "autonomous" } } })
    expect(getAutonomyRecommendations(shop, [stat("send_sms", 40, 0, 0)])).toEqual([])
  })
})

/** Mock returning canned pending_actions rows; ignores filter chains. */
function mockSupabase(rows: unknown[]): SupabaseClient {
  const proxy: unknown = new Proxy(() => {}, {
    get(_t, prop) {
      if (prop === "then")
        return (res: (v: unknown) => unknown) =>
          Promise.resolve({ data: rows, error: null }).then(res)
      return () => proxy
    },
  })
  return { from: () => proxy } as unknown as SupabaseClient
}

describe("getTrustStats", () => {
  it("aggregates resolutions per action type", async () => {
    const supabase = mockSupabase([
      { action_type: "send_sms", resolution: "approved_unedited" },
      { action_type: "send_sms", resolution: "approved_unedited" },
      { action_type: "send_sms", resolution: "approved_edited" },
      { action_type: "send_sms", resolution: "rejected" },
      { action_type: "send_email", resolution: "approved_unedited" },
    ])
    const stats = await getTrustStats(supabase, "shop-1")
    const sms = stats.find((s) => s.actionType === "send_sms")!
    expect(sms.approvedUnedited).toBe(2)
    expect(sms.approvedEdited).toBe(1)
    expect(sms.rejected).toBe(1)
    expect(sms.decisions).toBe(4)
    expect(sms.uneditedRate).toBeCloseTo(0.5)
  })
})
