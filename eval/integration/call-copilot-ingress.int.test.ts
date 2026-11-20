import { randomBytes } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

import { persistCallRecord } from "@/lib/call-records"
import {
  CaptureDeniedError,
  findCallCopilotCallId,
  readCaptureState,
  requireCaptureGrant,
} from "@/lib/call-copilot/capture-gate"
import { CALL_COPILOT_CAPTURE_PURPOSES, type CallCopilotCapturePurpose } from "@/lib/call-copilot/events"
import { recordCallCopilotEvent, type CallCopilotIngressResult } from "@/lib/call-copilot/ingress"
import {
  INTEGRATION_WITH_SESSION,
  anonClient,
  cleanup,
  ownerSessionClient,
  seedShop,
  serviceClient,
  type Seeded,
} from "./_db"

const PASSWORD = "Synthetic-password-123!"
const BASE = Date.now() - 20 * 60 * 1000
const at = (s: number) => new Date(BASE + s * 1000).toISOString()
const newCallId = () => `CA${randomBytes(16).toString("hex")}`

type Ev = Record<string, unknown>
const open = (c: string, seq = 1, s = 0): Ev => ({
  providerCallId: c, providerEventId: `${c}-${seq}`, sequence: seq, occurredAt: at(s),
  kind: "call_opened", routeKind: "gradia_controlled_number", operatorRegion: "US-OR", callerRegion: "US-WA",
})
const disclose = (c: string, seq: number, party: "operator" | "caller", s: number, v = "d1"): Ev => ({
  providerCallId: c, providerEventId: `${c}-${seq}`, sequence: seq, occurredAt: at(s),
  kind: "disclosure_delivered", party, disclosureVersion: v,
})
const grant = (c: string, seq: number, party: "operator" | "caller", resp: number, s: number, v = "d1"): Ev => ({
  providerCallId: c, providerEventId: `${c}-${seq}`, sequence: seq, occurredAt: at(s),
  kind: "consent_granted", party, disclosureVersion: v, respondsToSequence: resp,
})
const decline = (c: string, seq: number, party: "operator" | "caller", resp: number | undefined, s: number, v = "d1"): Ev => ({
  providerCallId: c, providerEventId: `${c}-${seq}`, sequence: seq, occurredAt: at(s),
  kind: "consent_declined", party, disclosureVersion: v, ...(resp ? { respondsToSequence: resp } : {}),
})
const simple = (c: string, seq: number, kind: string, s: number, reason?: string): Ev => ({
  providerCallId: c, providerEventId: `${c}-${seq}`, sequence: seq, occurredAt: at(s), kind, ...(reason ? { reason } : {}),
})

/** open, both disclosed, both granted. Capture becomes active at sequence 5. */
const consenting = (c: string): Ev[] => [
  open(c), disclose(c, 2, "operator", 1), disclose(c, 3, "caller", 2),
  grant(c, 4, "operator", 2, 3), grant(c, 5, "caller", 3, 4),
]

/** consenting, pause (6), a refused resume (7), fresh consent (8-11), resume (12). */
const pauseResume = (c: string): Ev[] => [
  ...consenting(c),
  simple(c, 6, "capture_paused", 10, "operator_request"),
  simple(c, 7, "capture_resumed", 20),
  disclose(c, 8, "operator", 21, "d2"), disclose(c, 9, "caller", 22, "d2"),
  grant(c, 10, "operator", 8, 23, "d2"), grant(c, 11, "caller", 9, 24, "d2"),
  simple(c, 12, "capture_resumed", 25),
]

/** Operator heard and consented to d1, caller heard and consented to d2: each consent is individually valid. */
const mismatched = (c: string): Ev[] => [
  open(c), disclose(c, 2, "operator", 1, "d1"), disclose(c, 3, "caller", 2, "d2"),
  grant(c, 4, "operator", 2, 3, "d1"), grant(c, 5, "caller", 3, 4, "d2"),
]

/** consenting on d1, pause (6), then FRESH but mismatched consent (operator d2, caller d3) and a resume (11). */
const mismatchedResume = (c: string): Ev[] => [
  ...consenting(c),
  simple(c, 6, "capture_paused", 10, "operator_request"),
  disclose(c, 7, "operator", 21, "d2"), disclose(c, 8, "caller", 22, "d3"),
  grant(c, 9, "operator", 7, 23, "d2"), grant(c, 10, "caller", 8, 24, "d3"),
  simple(c, 11, "capture_resumed", 25),
]

/** One caller declines after the operator already consented; a later "grant" must not matter. */
const declined = (c: string): Ev[] => [
  open(c), disclose(c, 2, "operator", 1), disclose(c, 3, "caller", 2),
  grant(c, 4, "operator", 2, 3), decline(c, 5, "caller", 3, 4), grant(c, 6, "caller", 3, 5),
]

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function shuffled<T>(items: T[], rand: () => number): T[] {
  const a = [...items]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}
function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items]
  return items.flatMap((x, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((p) => [x, ...p]))
}

describe.skipIf(!INTEGRATION_WITH_SESSION)("Call Copilot ingress and consent evidence under actual Postgres", () => {
  let db: SupabaseClient
  let a: Seeded
  let b: Seeded
  let ownerA: SupabaseClient

  const feed = async (shopId: string, events: Ev[]) => {
    const out: CallCopilotIngressResult[] = []
    for (const event of events) out.push(await recordCallCopilotEvent(db, { shopId, provider: "twilio", event }))
    return out
  }
  const callIdOf = async (shopId: string, c: string) => {
    const id = await findCallCopilotCallId(db, { shopId, provider: "twilio", providerCallId: c })
    expect(id).not.toBeNull()
    return id as string
  }
  const denied = async (shopId: string, callId: string, purpose: CallCopilotCapturePurpose, atIso?: string) => {
    try {
      await requireCaptureGrant(db, { shopId, callId, purpose, at: atIso })
    } catch (e) {
      expect(e).toBeInstanceOf(CaptureDeniedError)
      return (e as CaptureDeniedError).reason
    }
    throw new Error(`gate allowed ${purpose}`)
  }
  const eventCount = async (callId: string) => {
    const { count, error } = await db.from("call_copilot_events").select("*", { count: "exact", head: true }).eq("call_id", callId)
    expect(error).toBeNull()
    return count ?? 0
  }

  beforeAll(async () => {
    db = serviceClient()
    a = await seedShop(db, { password: PASSWORD })
    b = await seedShop(db, { password: PASSWORD })
    ownerA = await ownerSessionClient(a.email, PASSWORD)
  })
  afterAll(async () => {
    if (a) await cleanup(db, a)
    if (b) await cleanup(db, b)
  })

  describe("all-party consent", () => {
    it("captures only after BOTH parties heard the disclosure and consented", async () => {
      const c = newCallId()
      const r = await feed(a.shopId, consenting(c))
      expect(r.map((x) => x.outcome)).toEqual(Array(5).fill("recorded"))
      expect(r.slice(0, 4).every((x) => x.outcome === "recorded" && !x.capturePermittedNow)).toBe(true)
      expect(r[4]).toMatchObject({ outcome: "recorded", status: "active", capturePermittedNow: true })

      const callId = await callIdOf(a.shopId, c)
      const state = await readCaptureState(db, { shopId: a.shopId, callId })
      expect(state).toMatchObject({ status: "active", capturePermittedNow: true, derivationPermitted: true, unresolvedGap: false, conflictCount: 0 })
      expect(state.intervals).toHaveLength(1)
      expect(state.gaps).toEqual([expect.objectContaining({ reason: "before_consent", endedSequence: 5 })])
      for (const purpose of CALL_COPILOT_CAPTURE_PURPOSES) {
        const grantOut = await requireCaptureGrant(db, { shopId: a.shopId, callId, purpose })
        expect(grantOut).toMatchObject({ shopId: a.shopId, callId, purpose })
      }
    })

    it.each([
      ["operator only", (c: string) => [open(c), disclose(c, 2, "operator", 1), disclose(c, 3, "caller", 2), grant(c, 4, "operator", 2, 3)]],
      ["caller only", (c: string) => [open(c), disclose(c, 2, "operator", 1), disclose(c, 3, "caller", 2), grant(c, 4, "caller", 3, 3)]],
      ["no disclosure to the caller", (c: string) => [open(c), disclose(c, 2, "operator", 1), grant(c, 3, "operator", 2, 2)]],
      ["call opened, nothing else", (c: string) => [open(c)]],
    ])("missing consent (%s) makes every capture purpose impossible", async (_name, build) => {
      const c = newCallId()
      await feed(a.shopId, build(c))
      const callId = await callIdOf(a.shopId, c)
      const state = await readCaptureState(db, { shopId: a.shopId, callId })
      expect(state).toMatchObject({ status: "awaiting_consent", capturePermittedNow: false, derivationPermitted: false })
      for (const purpose of CALL_COPILOT_CAPTURE_PURPOSES) {
        expect(await denied(a.shopId, callId, purpose)).toMatch(/consent_not_established|no_consented_capture/)
      }
    })

    it("a consent that cites a different version, party or missing disclosure is recorded but ineffective", async () => {
      const c = newCallId()
      await feed(a.shopId, [
        open(c), disclose(c, 2, "operator", 1, "d1"), disclose(c, 3, "caller", 2, "d1"),
        grant(c, 4, "operator", 2, 3, "d2"), // wrong version
        grant(c, 5, "caller", 2, 4, "d1"), // cites the operator's disclosure
        grant(c, 6, "operator", 4, 5, "d1"), // cites a consent, not a disclosure
      ])
      const callId = await callIdOf(a.shopId, c)
      const state = await readCaptureState(db, { shopId: a.shopId, callId })
      expect(state.status).toBe("awaiting_consent")
      expect(state.capturePermittedNow).toBe(false)
      expect(state.ignored.map((i) => i.reason)).toEqual(Array(3).fill("consent_without_valid_disclosure"))
      expect(await denied(a.shopId, callId, "recording")).toBe("consent_not_established")
    })

    it("both parties must consent to the SAME disclosure version: operator on d1 and caller on d2 never activates capture", async () => {
      const c = newCallId()
      const out = await feed(a.shopId, mismatched(c))
      expect(out.every((x) => x.outcome === "recorded" && !x.capturePermittedNow)).toBe(true)
      expect(out[4]).toMatchObject({ status: "awaiting_consent", capturePermittedNow: false })
      const callId = await callIdOf(a.shopId, c)
      const state = await readCaptureState(db, { shopId: a.shopId, callId })
      expect(state).toMatchObject({ status: "awaiting_consent", reason: "consent_not_established", capturePermittedNow: false, derivationPermitted: false })
      expect(state.intervals).toHaveLength(0)
      // each consent was individually valid, so the refusal is the version mismatch and nothing else
      expect(state.ignored).toEqual([])
      for (const purpose of CALL_COPILOT_CAPTURE_PURPOSES) {
        expect(await denied(a.shopId, callId, purpose)).toMatch(/consent_not_established|no_consented_capture/)
      }
    })

    it("the mismatch is not order-sensitive: caller on d2 first, operator on d1 second never activates either", async () => {
      const c = newCallId()
      await feed(a.shopId, [
        open(c), disclose(c, 2, "caller", 1, "d2"), disclose(c, 3, "operator", 2, "d1"),
        grant(c, 4, "caller", 2, 3, "d2"), grant(c, 5, "operator", 3, 4, "d1"),
      ])
      const state = await readCaptureState(db, { shopId: a.shopId, callId: await callIdOf(a.shopId, c) })
      expect(state).toMatchObject({ status: "awaiting_consent", capturePermittedNow: false, derivationPermitted: false })
    })

    it.each([
      ["d1", "d1"],
      ["2026-11-19-b", "2026-11-19-b"],
    ])("matching versions still activate (%s / %s)", async (vo, vc) => {
      const c = newCallId()
      const out = await feed(a.shopId, [
        open(c), disclose(c, 2, "operator", 1, vo), disclose(c, 3, "caller", 2, vc),
        grant(c, 4, "operator", 2, 3, vo), grant(c, 5, "caller", 3, 4, vc),
      ])
      expect(out.slice(0, 4).every((x) => x.outcome === "recorded" && !x.capturePermittedNow)).toBe(true)
      expect(out[4]).toMatchObject({ status: "active", capturePermittedNow: true })
      const callId = await callIdOf(a.shopId, c)
      await requireCaptureGrant(db, { shopId: a.shopId, callId, purpose: "recording" })
    })

    it("a mismatch is repaired only when one party validly consents to the other's version; then capture activates", async () => {
      const c = newCallId()
      const out = await feed(a.shopId, [
        ...mismatched(c), // operator d1, caller d2: no capture
        disclose(c, 6, "caller", 5, "d1"), // the caller is now told d1
        grant(c, 7, "caller", 6, 6, "d1"), // and consents to d1: both on d1
      ])
      expect(out.slice(0, 6).every((x) => x.outcome === "recorded" && !x.capturePermittedNow)).toBe(true)
      expect(out[6]).toMatchObject({ status: "active", capturePermittedNow: true })
      const state = await readCaptureState(db, { shopId: a.shopId, callId: await callIdOf(a.shopId, c) })
      expect(state.intervals).toHaveLength(1)
      expect(state.intervals[0]).toMatchObject({ startedSequence: 7 })
    })

    it("a party's later consent to a different version replaces its earlier one rather than pairing with a stale answer", async () => {
      const c = newCallId()
      // operator d1, caller d2; the caller then moves to d3, which still is not the operator's d1.
      await feed(a.shopId, [
        ...mismatched(c),
        disclose(c, 6, "caller", 5, "d3"), grant(c, 7, "caller", 6, 6, "d3"),
      ])
      const state = await readCaptureState(db, { shopId: a.shopId, callId: await callIdOf(a.shopId, c) })
      expect(state).toMatchObject({ status: "awaiting_consent", capturePermittedNow: false, derivationPermitted: false })
    })

    it("a decline is final: nothing re-enables capture or any derived use", async () => {
      const c = newCallId()
      await feed(a.shopId, declined(c))
      const callId = await callIdOf(a.shopId, c)
      const state = await readCaptureState(db, { shopId: a.shopId, callId })
      expect(state).toMatchObject({ status: "declined", reason: "consent_declined", capturePermittedNow: false, derivationPermitted: false })
      for (const purpose of CALL_COPILOT_CAPTURE_PURPOSES) {
        expect(await denied(a.shopId, callId, purpose)).toBe("consent_declined")
      }
    })

    it("a decline that arrives first (without a disclosure reference) is still honoured", async () => {
      const c = newCallId()
      await feed(a.shopId, [open(c), decline(c, 2, "caller", undefined, 1)])
      const callId = await callIdOf(a.shopId, c)
      expect((await readCaptureState(db, { shopId: a.shopId, callId })).status).toBe("declined")
    })

    it("stopping capture ends the consented interval; captured content stays eligible, live audio does not", async () => {
      const c = newCallId()
      await feed(a.shopId, [...consenting(c), simple(c, 6, "capture_stopped", 10, "operator_request"), simple(c, 7, "call_ended", 12)])
      const callId = await callIdOf(a.shopId, c)
      const state = await readCaptureState(db, { shopId: a.shopId, callId })
      expect(state).toMatchObject({ status: "stopped", capturePermittedNow: false, derivationPermitted: true, callEnded: true })
      expect(state.intervals[0]).toMatchObject({ endReason: "stopped", endedSequence: 6 })
      expect(await denied(a.shopId, callId, "recording")).toBe("operator_request")
      await requireCaptureGrant(db, { shopId: a.shopId, callId, purpose: "summarization" })
      // nothing can restart a stopped call
      await feed(a.shopId, [disclose(c, 8, "operator", 13, "d3"), disclose(c, 9, "caller", 14, "d3"), grant(c, 10, "operator", 8, 15, "d3"), grant(c, 11, "caller", 9, 16, "d3"), simple(c, 12, "capture_resumed", 17)])
      expect((await readCaptureState(db, { shopId: a.shopId, callId })).capturePermittedNow).toBe(false)
    })

    it("an unknown provider outcome ends capture, is never reported as complete, and later events cannot revive it", async () => {
      const c = newCallId()
      await feed(a.shopId, [...consenting(c), simple(c, 6, "provider_outcome_unknown", 10, "provider_timeout")])
      const callId = await callIdOf(a.shopId, c)
      const state = await readCaptureState(db, { shopId: a.shopId, callId })
      expect(state).toMatchObject({ status: "unknown_outcome", reason: "provider_timeout", outcomeUnknown: true, callEnded: false, capturePermittedNow: false })
      expect(state.gaps.at(-1)).toMatchObject({ reason: "provider_outcome_unknown", endedAt: null })
      expect(await denied(a.shopId, callId, "transcription")).toBe("provider_timeout")
    })

    it("an extra participant ends capture: all-party consent cannot cover someone who was never asked", async () => {
      const c = newCallId()
      await feed(a.shopId, [...consenting(c), simple(c, 6, "participant_added", 10, "conference_join")])
      const callId = await callIdOf(a.shopId, c)
      const state = await readCaptureState(db, { shopId: a.shopId, callId })
      expect(state).toMatchObject({ status: "uncertain", reason: "unconsented_participant", capturePermittedNow: false })
      expect(await denied(a.shopId, callId, "recording")).toBe("unconsented_participant")
    })

    it("a clock that runs backwards fails closed", async () => {
      const c = newCallId()
      await feed(a.shopId, [...consenting(c), simple(c, 6, "capture_paused", 1)])
      const callId = await callIdOf(a.shopId, c)
      const state = await readCaptureState(db, { shopId: a.shopId, callId })
      expect(state).toMatchObject({ status: "uncertain", reason: "time_regression", capturePermittedNow: false, derivationPermitted: false })
    })
  })

  describe("pause, resume and explicit gaps", () => {
    it("pause voids consent, records the gap, and resume needs fresh disclosure and consent from both parties", async () => {
      const c = newCallId()
      const out = await feed(a.shopId, pauseResume(c))
      expect(out.every((x) => x.outcome === "recorded")).toBe(true)
      // after the pause (6) and the refused resume (7) capture is NOT active
      expect(out[5]).toMatchObject({ status: "paused", capturePermittedNow: false })
      expect(out[6]).toMatchObject({ status: "paused", capturePermittedNow: false })
      expect(out[10]).toMatchObject({ status: "paused", capturePermittedNow: false }) // both fresh consents, not yet resumed
      expect(out[11]).toMatchObject({ status: "active", capturePermittedNow: true })

      const callId = await callIdOf(a.shopId, c)
      const state = await readCaptureState(db, { shopId: a.shopId, callId })
      expect(state.intervals).toHaveLength(2)
      expect(state.intervals[0]).toMatchObject({ startedSequence: 5, endedSequence: 6, endReason: "paused" })
      expect(state.intervals[1]).toMatchObject({ startedSequence: 12, endedSequence: null })
      expect(state.gaps.map((g) => g.reason)).toEqual(["before_consent", "paused"])
      expect(state.gaps[1]).toMatchObject({ startedSequence: 6, endedSequence: 12 })
      expect(state.ignored).toEqual([{ sequence: 7, reason: "resume_without_fresh_consent" }])
    })

    it("resume after a pause with fresh consent on DIFFERENT versions stays off until the parties match", async () => {
      const c = newCallId()
      const out = await feed(a.shopId, mismatchedResume(c))
      expect(out[4]).toMatchObject({ status: "active", capturePermittedNow: true }) // the original d1/d1 consent
      expect(out[5]).toMatchObject({ status: "paused", capturePermittedNow: false })
      for (const r of out.slice(6)) expect(r).toMatchObject({ status: "paused", capturePermittedNow: false })
      const callId = await callIdOf(a.shopId, c)
      let state = await readCaptureState(db, { shopId: a.shopId, callId })
      expect(state).toMatchObject({ status: "paused", capturePermittedNow: false })
      expect(state.ignored).toEqual([{ sequence: 11, reason: "resume_without_fresh_consent" }])
      expect(state.intervals).toHaveLength(1)
      expect(await denied(a.shopId, callId, "recording")).toBe("paused")

      // repair: the caller is told d2 and consents to it; the earlier refused resume does not count, a new one does
      await feed(a.shopId, [disclose(c, 12, "caller", 26, "d2"), grant(c, 13, "caller", 12, 27, "d2")])
      state = await readCaptureState(db, { shopId: a.shopId, callId })
      expect(state).toMatchObject({ status: "paused", capturePermittedNow: false }) // consent alone never resumes
      await feed(a.shopId, [simple(c, 14, "capture_resumed", 28)])
      state = await readCaptureState(db, { shopId: a.shopId, callId })
      expect(state).toMatchObject({ status: "active", capturePermittedNow: true })
      expect(state.intervals).toHaveLength(2)
      expect(state.intervals[1]).toMatchObject({ startedSequence: 14 })
      expect(state.ignored).toEqual([{ sequence: 11, reason: "resume_without_fresh_consent" }])
    })

    it("resume cannot pair one party's fresh consent with the other party's voided pre-pause consent", async () => {
      const c = newCallId()
      await feed(a.shopId, [
        ...consenting(c), // d1 / d1, active
        simple(c, 6, "capture_paused", 10),
        disclose(c, 7, "operator", 11, "d2"), grant(c, 8, "operator", 7, 12, "d2"), // only the operator is fresh, on d2
        simple(c, 9, "capture_resumed", 13),
      ])
      const state = await readCaptureState(db, { shopId: a.shopId, callId: await callIdOf(a.shopId, c) })
      expect(state).toMatchObject({ status: "paused", capturePermittedNow: false })
      expect(state.ignored).toEqual([{ sequence: 9, reason: "resume_without_fresh_consent" }])
    })

    it("uncaptured time can never be backfilled, live or derived", async () => {
      const c = newCallId()
      await feed(a.shopId, pauseResume(c))
      const callId = await callIdOf(a.shopId, c)
      const inGap = at(15)
      const insideFirst = at(6)
      const insideSecond = at(30)
      expect(await denied(a.shopId, callId, "extraction", inGap)).toBe("outside_captured_interval")
      expect(await denied(a.shopId, callId, "crm_mutation", at(2))).toBe("outside_captured_interval") // before consent
      await requireCaptureGrant(db, { shopId: a.shopId, callId, purpose: "extraction", at: insideFirst })
      await requireCaptureGrant(db, { shopId: a.shopId, callId, purpose: "extraction", at: insideSecond })
      expect(await denied(a.shopId, callId, "recording", inGap)).toBe("before_capture_interval")
      await requireCaptureGrant(db, { shopId: a.shopId, callId, purpose: "recording" })
    })

    it("a pause with no resume leaves capture off and the gap open", async () => {
      const c = newCallId()
      await feed(a.shopId, [...consenting(c), simple(c, 6, "capture_paused", 10)])
      const callId = await callIdOf(a.shopId, c)
      const state = await readCaptureState(db, { shopId: a.shopId, callId })
      expect(state).toMatchObject({ status: "paused", capturePermittedNow: false, derivationPermitted: true })
      expect(state.gaps.at(-1)).toMatchObject({ reason: "paused", endedAt: null })
      expect(await denied(a.shopId, callId, "recording")).toBe("paused")
      // consent given BEFORE the pause cannot satisfy a resume
      await feed(a.shopId, [simple(c, 7, "capture_resumed", 11)])
      expect((await readCaptureState(db, { shopId: a.shopId, callId })).capturePermittedNow).toBe(false)
    })
  })

  describe("idempotent replay and changed replay", () => {
    it("an exact replay is a duplicate, sequential or concurrent, and stores one row", async () => {
      const c = newCallId()
      await feed(a.shopId, consenting(c))
      const callId = await callIdOf(a.shopId, c)
      const again = await feed(a.shopId, consenting(c))
      expect(again.every((x) => x.outcome === "duplicate")).toBe(true)
      const burst = await Promise.all(Array.from({ length: 12 }, () => recordCallCopilotEvent(db, { shopId: a.shopId, provider: "twilio", event: grant(c, 5, "caller", 3, 4) })))
      expect(burst.every((x) => x.outcome === "duplicate")).toBe(true)
      expect(await eventCount(callId)).toBe(5)
      expect((await readCaptureState(db, { shopId: a.shopId, callId })).status).toBe("active")
    })

    it("concurrent first deliveries of the same new event record exactly once", async () => {
      const c = newCallId()
      const burst = await Promise.all(Array.from({ length: 16 }, () => recordCallCopilotEvent(db, { shopId: a.shopId, provider: "twilio", event: open(c) })))
      expect(burst.filter((x) => x.outcome === "recorded")).toHaveLength(1)
      expect(burst.filter((x) => x.outcome === "duplicate")).toHaveLength(15)
      expect(await eventCount(await callIdOf(a.shopId, c))).toBe(1)
    })

    it("a changed replay conflicts, stores nothing new, and fails the whole call closed", async () => {
      const c = newCallId()
      await feed(a.shopId, consenting(c))
      const callId = await callIdOf(a.shopId, c)
      const changed = await recordCallCopilotEvent(db, { shopId: a.shopId, provider: "twilio", event: grant(c, 5, "caller", 3, 400) })
      expect(changed).toMatchObject({ outcome: "conflict", conflictKind: "event_id_changed" })
      expect(await eventCount(callId)).toBe(5)
      const state = await readCaptureState(db, { shopId: a.shopId, callId })
      expect(state).toMatchObject({ status: "uncertain", reason: "conflicting_replay", capturePermittedNow: false, derivationPermitted: false, conflictCount: 1 })
      for (const purpose of CALL_COPILOT_CAPTURE_PURPOSES) expect(await denied(a.shopId, callId, purpose)).toBe("conflicting_replay")
      // repeating the same changed replay does not pile up conflicts
      await recordCallCopilotEvent(db, { shopId: a.shopId, provider: "twilio", event: grant(c, 5, "caller", 3, 400) })
      expect((await readCaptureState(db, { shopId: a.shopId, callId })).conflictCount).toBe(1)
    })

    it("a different event claiming an already-used sequence conflicts and fails the call closed", async () => {
      const c = newCallId()
      await feed(a.shopId, consenting(c))
      const callId = await callIdOf(a.shopId, c)
      const reused = await recordCallCopilotEvent(db, { shopId: a.shopId, provider: "twilio", event: { ...decline(c, 5, "caller", 3, 4), providerEventId: `${c}-other` } })
      expect(reused).toMatchObject({ outcome: "conflict", conflictKind: "sequence_reused" })
      expect(await eventCount(callId)).toBe(5)
      expect((await readCaptureState(db, { shopId: a.shopId, callId })).capturePermittedNow).toBe(false)
    })

    it("a conflict cannot revive a declined call's status (decline stays the more specific denial)", async () => {
      const c = newCallId()
      await feed(a.shopId, declined(c))
      await recordCallCopilotEvent(db, { shopId: a.shopId, provider: "twilio", event: decline(c, 5, "caller", 3, 400) })
      const callId = await callIdOf(a.shopId, c)
      expect((await readCaptureState(db, { shopId: a.shopId, callId })).status).toBe("declined")
    })
  })

  describe("reordered callbacks cannot manufacture consent", () => {
    /** The oracle: the in-order state after each prefix. */
    async function inOrderTimeline(events: Ev[]) {
      const c = events[0].providerCallId as string
      const timeline: { permitted: boolean; status: string }[] = [{ permitted: false, status: "none" }]
      for (const e of events) {
        const r = await recordCallCopilotEvent(db, { shopId: a.shopId, provider: "twilio", event: e })
        if (r.outcome !== "recorded") throw new Error("oracle feed failed")
        timeline.push({ permitted: r.capturePermittedNow, status: r.status })
      }
      return { timeline, final: await readCaptureState(db, { shopId: a.shopId, callId: await callIdOf(a.shopId, c) }) }
    }

    /** Re-key an event set onto a fresh call id so permutations do not collide. */
    const rekey = (events: Ev[], c: string): Ev[] => events.map((e) => ({
      ...e, providerCallId: c, providerEventId: `${c}-${e.sequence}`,
    }))

    async function checkOrder(template: Ev[], order: number[], timeline: { permitted: boolean }[]) {
      const c = newCallId()
      const evs = rekey(template, c)
      const arrived = new Set<number>()
      for (const idx of order) {
        const r = await recordCallCopilotEvent(db, { shopId: a.shopId, provider: "twilio", event: evs[idx] })
        expect(r.outcome).toBe("recorded")
        arrived.add(evs[idx].sequence as number)
        let contiguous = 0
        while (arrived.has(contiguous + 1)) contiguous++
        const hasGap = Math.max(...arrived) > contiguous
        const expected = hasGap ? false : timeline[contiguous].permitted
        if (r.outcome === "recorded") {
          // never granted unless the in-order timeline had granted at exactly this logical point
          expect(r.capturePermittedNow, `arrival ${[...arrived].join(",")}`).toBe(expected)
          if (hasGap) expect(r.status).toBe("uncertain")
        }
      }
      return readCaptureState(db, { shopId: a.shopId, callId: await callIdOf(a.shopId, c) })
    }

    it("every arrival order of the five consent events is safe at every step and converges on the in-order result", async () => {
      const template = consenting("template-call-x")
      const { timeline, final } = await inOrderTimeline(rekey(template, newCallId()))
      expect(timeline.map((t) => t.permitted)).toEqual([false, false, false, false, false, true])
      const norm = (s: Awaited<ReturnType<typeof readCaptureState>>) => JSON.stringify({ ...s, ignored: s.ignored })
      for (const perm of permutations([0, 1, 2, 3, 4])) {
        const state = await checkOrder(template, perm, timeline)
        expect(norm(state)).toBe(norm(final))
      }
    }, 240_000)

    it("a decline can never be outrun: no arrival order of the decline scenario ever permits capture", async () => {
      const template = declined("template-call-x")
      const { timeline } = await inOrderTimeline(rekey(template, newCallId()))
      expect(timeline.every((t) => !t.permitted)).toBe(true)
      const rand = mulberry32(20261119)
      for (let i = 0; i < 40; i++) {
        const state = await checkOrder(template, shuffled([0, 1, 2, 3, 4, 5], rand), timeline)
        expect(state).toMatchObject({ status: "declined", capturePermittedNow: false, derivationPermitted: false })
      }
    }, 240_000)

    it("mismatched versions: all 120 arrival orders of the five consent events never permit capture at any step", async () => {
      const template = mismatched("template-call-x")
      const { timeline, final } = await inOrderTimeline(rekey(template, newCallId()))
      expect(timeline.every((t) => !t.permitted)).toBe(true)
      expect(final).toMatchObject({ status: "awaiting_consent", capturePermittedNow: false, derivationPermitted: false })
      const norm = (st: Awaited<ReturnType<typeof readCaptureState>>) => JSON.stringify(st)
      for (const perm of permutations([0, 1, 2, 3, 4])) {
        const state = await checkOrder(template, perm, timeline)
        expect(norm(state)).toBe(norm(final))
        expect(state.capturePermittedNow).toBe(false)
      }
    }, 240_000)

    it("the repaired mismatch activates only when the repair arrives, in any arrival order", async () => {
      const template = [
        ...mismatched("template-call-x"),
        disclose("template-call-x", 6, "caller", 5, "d1"), grant("template-call-x", 7, "caller", 6, 6, "d1"),
      ]
      const { timeline, final } = await inOrderTimeline(rekey(template, newCallId()))
      expect(timeline.map((t) => t.permitted)).toEqual([false, false, false, false, false, false, false, true])
      expect(final).toMatchObject({ status: "active", capturePermittedNow: true })
      const rand = mulberry32(20261120)
      for (let i = 0; i < 30; i++) {
        const state = await checkOrder(template, shuffled(template.map((_, k) => k), rand), timeline)
        expect(state).toMatchObject({ status: "active", capturePermittedNow: true })
        expect(state.intervals).toEqual(final.intervals)
      }
    }, 240_000)

    it("mismatched fresh consent after a pause never resumes capture, in any arrival order", async () => {
      const template = mismatchedResume("template-call-x")
      const { timeline, final } = await inOrderTimeline(rekey(template, newCallId()))
      expect(timeline.map((t) => t.permitted)).toEqual([false, false, false, false, false, true, false, false, false, false, false, false])
      expect(final).toMatchObject({ status: "paused", capturePermittedNow: false })
      const rand = mulberry32(11)
      for (let i = 0; i < 40; i++) {
        const state = await checkOrder(template, shuffled(template.map((_, k) => k), rand), timeline)
        expect(state).toMatchObject({ status: "paused", capturePermittedNow: false })
        expect(state.intervals).toEqual(final.intervals)
        expect(state.ignored).toEqual(final.ignored)
      }
    }, 300_000)

    it("pause/resume arrives in any order without ever permitting capture the in-order call would not", async () => {
      const template = pauseResume("template-call-x")
      const { timeline, final } = await inOrderTimeline(rekey(template, newCallId()))
      expect(final).toMatchObject({ status: "active" })
      const rand = mulberry32(7)
      for (let i = 0; i < 30; i++) {
        const state = await checkOrder(template, shuffled(template.map((_, k) => k), rand), timeline)
        expect(state.status).toBe("active")
        expect(state.intervals).toEqual(final.intervals)
        expect(state.gaps).toEqual(final.gaps)
      }
    }, 300_000)

    it("concurrent delivery of the five consent events, in a shuffled order, converges on active capture", async () => {
      for (let round = 0; round < 5; round++) {
        const c = newCallId()
        const events = shuffled(consenting(c), mulberry32(round + 1))
        const out = await Promise.all(events.map((event) => recordCallCopilotEvent(db, { shopId: a.shopId, provider: "twilio", event })))
        expect(out.every((x) => x.outcome === "recorded")).toBe(true)
        const state = await readCaptureState(db, { shopId: a.shopId, callId: await callIdOf(a.shopId, c) })
        expect(state).toMatchObject({ status: "active", capturePermittedNow: true, unresolvedGap: false })
      }
    }, 60_000)

    it("a missing sequence keeps the call uncertain (and capture off) until it arrives", async () => {
      const c = newCallId()
      const evs = consenting(c)
      await feed(a.shopId, [evs[0], evs[1], evs[3], evs[4]]) // sequence 3 (caller disclosure) is missing
      const callId = await callIdOf(a.shopId, c)
      expect(await readCaptureState(db, { shopId: a.shopId, callId })).toMatchObject({ status: "uncertain", reason: "sequence_gap", capturePermittedNow: false, unresolvedGap: true })
      expect(await denied(a.shopId, callId, "recording")).toBe("sequence_gap")
      expect(await denied(a.shopId, callId, "summarization")).toBe("sequence_gap")
      await feed(a.shopId, [evs[2]])
      expect(await readCaptureState(db, { shopId: a.shopId, callId })).toMatchObject({ status: "active", capturePermittedNow: true })
    })
  })

  describe("tenant isolation and forged call ids", () => {
    it("another shop cannot adopt, read, gate or write to a call id it does not own", async () => {
      const c = newCallId()
      await feed(a.shopId, consenting(c))
      const callId = await callIdOf(a.shopId, c)
      const before = await eventCount(callId)

      const forged = await recordCallCopilotEvent(db, { shopId: b.shopId, provider: "twilio", event: open(c) })
      expect(forged).toEqual({ outcome: "foreign_call" })
      const forgedConsent = await recordCallCopilotEvent(db, { shopId: b.shopId, provider: "twilio", event: grant(c, 6, "caller", 3, 9) })
      expect(forgedConsent).toEqual({ outcome: "foreign_call" })
      expect(await eventCount(callId)).toBe(before)

      expect(await findCallCopilotCallId(db, { shopId: b.shopId, provider: "twilio", providerCallId: c })).toBeNull()
      expect(await readCaptureState(db, { shopId: b.shopId, callId })).toMatchObject({ status: "unknown_call", capturePermittedNow: false, derivationPermitted: false })
      for (const purpose of CALL_COPILOT_CAPTURE_PURPOSES) expect(await denied(b.shopId, callId, purpose)).toBe("call_not_found")
      const { count } = await db.from("call_copilot_events").select("*", { count: "exact", head: true }).eq("shop_id", b.shopId)
      expect(count).toBe(0)
      // shop A is unaffected
      expect((await readCaptureState(db, { shopId: a.shopId, callId })).status).toBe("active")
    })

    it("two shops racing for one new call id: exactly one wins, the other writes nothing", async () => {
      const c = newCallId()
      const out = await Promise.all([
        ...Array.from({ length: 6 }, () => recordCallCopilotEvent(db, { shopId: a.shopId, provider: "twilio", event: open(c) })),
        ...Array.from({ length: 6 }, () => recordCallCopilotEvent(db, { shopId: b.shopId, provider: "twilio", event: open(c) })),
      ])
      const winners = new Set<string>()
      for (const [i, r] of out.entries()) {
        if (r.outcome === "recorded") winners.add(i < 6 ? "a" : "b")
      }
      expect(winners.size).toBe(1)
      const { data } = await db.from("call_copilot_calls").select("shop_id").eq("provider_call_id", c)
      expect(data).toHaveLength(1)
      const loser = winners.has("a") ? "b" : "a"
      expect(out.slice(loser === "a" ? 0 : 6, loser === "a" ? 6 : 12).every((r) => r.outcome === "foreign_call")).toBe(true)
    })

    it("a direct cross-shop write that bypasses the function is refused by the database", async () => {
      const c = newCallId()
      await feed(a.shopId, [open(c)])
      const callId = await callIdOf(a.shopId, c)
      // Even the service role cannot attach b's event to a's call (no direct write privilege; the composite key would refuse it too).
      const { error } = await db.from("call_copilot_events").insert({
        shop_id: b.shopId, call_id: callId, sequence: 2, provider_event_id: "x2", kind: "call_ended", occurred_at: at(5),
        payload_digest: "a".repeat(64),
      })
      expect(error).not.toBeNull()
    })
  })

  describe("append-only evidence and privileges", () => {
    it("the service role cannot write, edit or delete the ledger directly; the function is the only door", async () => {
      const c = newCallId()
      await feed(a.shopId, consenting(c))
      const callId = await callIdOf(a.shopId, c)
      const direct = await db.from("call_copilot_events").insert({
        shop_id: a.shopId, call_id: callId, sequence: 6, provider_event_id: "direct", kind: "call_ended", occurred_at: at(9), payload_digest: "b".repeat(64),
      })
      expect(direct.error?.code).toBe("42501")
      expect((await db.from("call_copilot_events").update({ reason: "edited_reason" }).eq("call_id", callId)).error?.code).toBe("42501")
      expect((await db.from("call_copilot_events").delete().eq("call_id", callId)).error?.code).toBe("42501")
      expect((await db.from("call_copilot_calls").delete().eq("id", callId)).error?.code).toBe("42501")
      expect((await db.from("call_copilot_conflicts").insert({ shop_id: a.shopId, call_id: callId })).error?.code).toBe("42501")
      expect(await eventCount(callId)).toBe(5)
    })

    it("browser roles cannot read or call anything: not an owner session, not anon", async () => {
      const c = newCallId()
      await feed(a.shopId, consenting(c))
      const callId = await callIdOf(a.shopId, c)
      for (const client of [ownerA, anonClient()]) {
        for (const table of ["call_copilot_calls", "call_copilot_events", "call_copilot_conflicts"]) {
          const r = await client.from(table).select("id").limit(1)
          expect(r.error?.code, table).toBe("42501")
        }
        expect((await client.rpc("call_copilot_capture_state", { p_shop_id: a.shopId, p_call_id: callId })).error?.code).toBe("42501")
        expect((await client.rpc("call_copilot_assert_capture", { p_shop_id: a.shopId, p_call_id: callId, p_purpose: "recording" })).error?.code).toBe("42501")
        const w = await client.rpc("call_copilot_record_event", {
          p_shop_id: a.shopId, p_provider: "twilio", p_provider_call_id: newCallId(), p_provider_event_id: "e1", p_sequence: 1, p_kind: "call_opened",
          p_party: null, p_disclosure_version: null, p_responds_to_sequence: null, p_route_kind: "gradia_controlled_number",
          p_operator_region: null, p_caller_region: null, p_reason: null, p_occurred_at: at(0),
        })
        expect(w.error?.code).toBe("42501")
      }
    })
  })

  describe("content-free, closed vocabulary", () => {
    it.each([
      ["a transcript field", { ...open("CA-invalid-1"), transcript: "hello" }],
      ["a phone number", { ...open("CA-invalid-1"), callerNumber: "+15555550100" }],
      ["an unknown kind", { ...open("CA-invalid-1"), kind: "recording_started" }],
      ["an unknown party", { ...disclose("CA-invalid-1", 2, "operator", 1), party: "third_party" }],
      ["sequence zero", { ...open("CA-invalid-1"), sequence: 0 }],
      ["an uncontrolled route", { ...open("CA-invalid-1"), routeKind: "personal_cell" }],
      ["a consent without the disclosure it answers", { ...grant("CA-invalid-1", 3, "operator", 2, 1), respondsToSequence: undefined }],
      ["a non-numeric time", { ...open("CA-invalid-1"), occurredAt: "yesterday" }],
    ])("rejects %s and writes nothing", async (_name, event) => {
      expect(await recordCallCopilotEvent(db, { shopId: a.shopId, provider: "twilio", event })).toEqual({ outcome: "invalid" })
      expect(await findCallCopilotCallId(db, { shopId: a.shopId, provider: "twilio", providerCallId: "CA-invalid-1" })).toBeNull()
    })

    it("the database refuses malformed shapes even when the adapter is bypassed, leaving no call row", async () => {
      const c = newCallId()
      const base = {
        p_shop_id: a.shopId, p_provider: "twilio", p_provider_call_id: c, p_provider_event_id: "e1", p_sequence: 2,
        p_kind: "consent_granted", p_party: "operator", p_disclosure_version: "d1", p_responds_to_sequence: null,
        p_route_kind: null, p_operator_region: null, p_caller_region: null, p_reason: null, p_occurred_at: at(0),
      }
      expect((await db.rpc("call_copilot_record_event", base)).error?.code).toBe("23514")
      expect((await db.rpc("call_copilot_record_event", { ...base, p_party: "someone", p_responds_to_sequence: 1 })).error?.code).toBe("23514")
      expect((await db.rpc("call_copilot_record_event", { ...base, p_kind: "call_opened", p_sequence: 1, p_party: null, p_disclosure_version: null, p_route_kind: "gradia_controlled_number", p_occurred_at: new Date(Date.now() + 86_400_000).toISOString() })).error?.code).toBe("22023")
      expect((await db.rpc("call_copilot_record_event", { ...base, p_provider: "vapi" })).error?.code).toBe("23514")
      expect(await findCallCopilotCallId(db, { shopId: a.shopId, provider: "twilio", providerCallId: c })).toBeNull()
    })

    it("an unknown capture purpose is refused by the gate", async () => {
      const c = newCallId()
      await feed(a.shopId, consenting(c))
      const callId = await callIdOf(a.shopId, c)
      const r = await db.rpc("call_copilot_assert_capture", { p_shop_id: a.shopId, p_call_id: callId, p_purpose: "listen_live" })
      expect(r.error?.code).toBe("22023")
    })
  })

  describe("existing receptionist call records", () => {
    it("are untouched: the receptionist capture path keeps working beside a Copilot call", async () => {
      const c = newCallId()
      await feed(a.shopId, consenting(c))
      const legacyId = `legacy-${randomBytes(6).toString("hex")}`
      await persistCallRecord(db, { shopId: a.shopId, vapiCallId: legacyId, summary: "Receptionist summary", endedReason: "customer-ended-call", durationSeconds: 42 })
      await persistCallRecord(db, { shopId: a.shopId, vapiCallId: legacyId, summary: "Updated by a retry", durationSeconds: 43 })
      const { data, error } = await db.from("call_records").select("summary, duration_seconds").eq("shop_id", a.shopId).eq("vapi_call_id", legacyId)
      expect(error).toBeNull()
      expect(data).toEqual([{ summary: "Updated by a retry", duration_seconds: 43 }])
      // and the Copilot ledger did not learn about it
      expect(await eventCount(await callIdOf(a.shopId, c))).toBe(5)
    })
  })

  describe("lifecycle", () => {
    it("deleting a shop removes its evidence (the append-only guard allows only the tenant cascade)", async () => {
      const tmp = await seedShop(db)
      const c = newCallId()
      await feed(tmp.shopId, [...consenting(c), simple(c, 6, "call_ended", 10)])
      await recordCallCopilotEvent(db, { shopId: tmp.shopId, provider: "twilio", event: grant(c, 5, "caller", 3, 400) })
      const callId = await callIdOf(tmp.shopId, c)
      expect(await eventCount(callId)).toBe(6)
      await cleanup(db, tmp)
      for (const table of ["call_copilot_calls", "call_copilot_events", "call_copilot_conflicts"]) {
        const { count } = await db.from(table).select("*", { count: "exact", head: true }).eq("shop_id", tmp.shopId)
        expect(count, table).toBe(0)
      }
    })
  })
})
