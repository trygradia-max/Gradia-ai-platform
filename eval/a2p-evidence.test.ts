import { describe, expect, it } from "vitest"
import {
  A2P_EVIDENCE_CEILING_HOURS,
  A2P_EVIDENCE_DEFAULT_MAX_AGE_HOURS,
  a2pEvidenceFresh,
  a2pEvidenceMaxAgeHours,
} from "@/lib/a2p-evidence"
import { a2pCheckFailureKind, smsGateForShop } from "@/lib/telephony-provider"
import { TwilioError } from "@/lib/twilio"

const now = new Date("2026-10-20T12:00:00Z")
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString()
const GRADIA = "+16175550142"
const approved = (a2p_verified_at: string | null) => ({ gradia_number_e164: GRADIA, a2p_status: "approved" as const, a2p_verified_at, byo_sms_verified: false })

describe("A2P evidence age", () => {
  it("defaults to 72 hours and accepts a shorter configured age", () => {
    expect(A2P_EVIDENCE_DEFAULT_MAX_AGE_HOURS).toBe(72)
    expect(a2pEvidenceMaxAgeHours({})).toBe(72)
    expect(a2pEvidenceMaxAgeHours({ A2P_EVIDENCE_MAX_AGE_HOURS: "24" })).toBe(24)
  })

  it("never exceeds the 7-day ceiling, and ignores nonsense", () => {
    expect(A2P_EVIDENCE_CEILING_HOURS).toBe(168)
    expect(a2pEvidenceMaxAgeHours({ A2P_EVIDENCE_MAX_AGE_HOURS: "100000" })).toBe(168)
    for (const bad of ["0", "-5", "soon", "", " "]) expect(a2pEvidenceMaxAgeHours({ A2P_EVIDENCE_MAX_AGE_HOURS: bad }), bad).toBe(72)
  })

  it("treats missing, unreadable, too-old and far-future times as stale", () => {
    expect(a2pEvidenceFresh(null, now, {})).toBe(false)
    expect(a2pEvidenceFresh("not a time", now, {})).toBe(false)
    expect(a2pEvidenceFresh(hoursAgo(73), now, {})).toBe(false)
    expect(a2pEvidenceFresh(hoursAgo(-1), now, {})).toBe(false) // an hour in the future
    expect(a2pEvidenceFresh(hoursAgo(71), now, {})).toBe(true)
    expect(a2pEvidenceFresh(hoursAgo(169), now, { A2P_EVIDENCE_MAX_AGE_HOURS: "100000" })).toBe(false)
  })
})

describe("the send gate needs fresh evidence for a Gradia number", () => {
  it("opens only for approved with a recent VERIFIED read", () => {
    expect(smsGateForShop(approved(hoursAgo(1)), GRADIA, now)).toEqual({ allowed: true })
  })

  it("holds approved texting as 'check overdue' when evidence is missing or stale, never as suspended", () => {
    for (const at of [null, hoursAgo(80)]) {
      const gate = smsGateForShop(approved(at), GRADIA, now)
      expect(gate).toEqual({ allowed: false, reason: expect.stringContaining("check overdue") })
      expect(gate.allowed ? "" : gate.reason).not.toContain("suspended")
    }
  })

  it("suspension closes immediately, whatever the evidence", () => {
    expect(smsGateForShop({ ...approved(hoursAgo(1)), a2p_status: "suspended" }, GRADIA, now).allowed).toBe(false)
  })

  it("makes no promise about review time while pending", () => {
    const gate = smsGateForShop({ ...approved(null), a2p_status: "pending" }, GRADIA, now)
    expect(gate.allowed ? "" : gate.reason).not.toMatch(/day/)
  })

  it("leaves a shop's own number on its attestation", () => {
    expect(smsGateForShop({ ...approved(null), byo_sms_verified: true }, "+19998887777", now).allowed).toBe(true)
  })
})

describe("check failure kinds are never carrier states", () => {
  it("separates an unreachable provider from a refusal", () => {
    expect(a2pCheckFailureKind(new TwilioError(503, "x"))).toBe("provider_unreachable")
    expect(a2pCheckFailureKind(new TwilioError(429, "x"))).toBe("provider_unreachable")
    expect(a2pCheckFailureKind(new TypeError("fetch failed"))).toBe("provider_unreachable")
    expect(a2pCheckFailureKind(new TwilioError(401, "x"))).toBe("provider_error")
    expect(a2pCheckFailureKind(new TwilioError(404, "x"))).toBe("provider_error")
  })
})
