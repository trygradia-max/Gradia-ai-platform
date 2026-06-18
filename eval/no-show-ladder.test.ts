import { describe, it, expect } from "vitest"

import {
  buildConfirmSms,
  looksLikeConfirm,
  noShowLadderState,
  BACKFILL_CUTOFF_HOURS,
  CONFIRM_LEAD_HOURS,
  type LadderAppointment,
} from "@/lib/no-show-ladder"
import { looksOptedOut } from "@/lib/agent-audience"

/**
 * No-show ladder windows + transitions (NEXT-2). Pure decision logic — the
 * cron stages on "stage_confirm", the owner nudge shows on "awaiting_confirm".
 */

const NOW = Date.parse("2026-06-18T12:00:00Z")
const inHours = (h: number) => new Date(NOW + h * 3_600_000).toISOString()

const appt = (over: Partial<LadderAppointment>): LadderAppointment => ({
  scheduled_at: inHours(36),
  confirmed_at: null,
  confirm_pending_action_id: null,
  ...over,
})

describe("noShowLadderState", () => {
  it("stages the confirm once inside the confirm lead window", () => {
    expect(noShowLadderState(appt({ scheduled_at: inHours(CONFIRM_LEAD_HOURS - 1) }), NOW)).toBe(
      "stage_confirm"
    )
  })

  it("does nothing while the appointment is still too far out", () => {
    expect(noShowLadderState(appt({ scheduled_at: inHours(CONFIRM_LEAD_HOURS + 5) }), NOW)).toBe(
      "none"
    )
  })

  it("does not re-stage once the confirm text has gone out", () => {
    expect(
      noShowLadderState(
        appt({ scheduled_at: inHours(30), confirm_pending_action_id: "pa-1" }),
        NOW
      )
    ).toBe("none")
  })

  it("is confirmed once the customer replied yes", () => {
    expect(
      noShowLadderState(
        appt({ scheduled_at: inHours(30), confirmed_at: inHours(-2) }),
        NOW
      )
    ).toBe("confirmed")
  })

  it("flags awaiting_confirm when imminent and still unconfirmed", () => {
    expect(
      noShowLadderState(appt({ scheduled_at: inHours(BACKFILL_CUTOFF_HOURS - 2) }), NOW)
    ).toBe("awaiting_confirm")
  })

  it("a confirmed imminent appointment is not at risk", () => {
    expect(
      noShowLadderState(
        appt({ scheduled_at: inHours(6), confirmed_at: inHours(-10) }),
        NOW
      )
    ).toBe("confirmed")
  })

  it("ignores past / in-progress appointments", () => {
    expect(noShowLadderState(appt({ scheduled_at: inHours(-1) }), NOW)).toBe("none")
    expect(noShowLadderState(appt({ scheduled_at: "not a date" }), NOW)).toBe("none")
  })
})

describe("buildConfirmSms", () => {
  it("is deterministic, asks for YES, and signs with the shop", () => {
    const body = buildConfirmSms({
      shopName: "Pristine Detailing",
      customerName: "Marcus Webb",
      service: "Ceramic Coating",
      whenText: "on Sat, Mar 4 at 9:00 AM",
    })
    expect(body).toContain("Marcus")
    expect(body).toContain("Ceramic Coating")
    expect(body).toContain("on Sat, Mar 4 at 9:00 AM")
    expect(body).toMatch(/reply yes/i)
    expect(body).toContain("— Pristine Detailing")
  })

  it("handles a missing name/service gracefully", () => {
    const body = buildConfirmSms({
      shopName: "Pristine",
      customerName: null,
      service: null,
      whenText: "on Sat",
    })
    expect(body).toContain("there")
    expect(body).toMatch(/reply yes/i)
  })
})

describe("looksLikeConfirm", () => {
  it("catches common confirmations", () => {
    for (const msg of ["YES", "yes!", "yep", "confirmed", "sounds good", "ok see you", "I'll be there"]) {
      expect(looksLikeConfirm(msg), msg).toBe(true)
    }
  })

  it("does not treat a STOP/opt-out as a confirm (STOP wins)", () => {
    // The inbound handler checks looksOptedOut first; this documents the contract.
    expect(looksOptedOut("STOP")).toBe(true)
    expect(looksLikeConfirm("no thanks, please cancel")).toBe(false)
  })
})
