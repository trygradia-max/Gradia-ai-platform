import { describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

import {
  CaptureDeniedError,
  findCallCopilotCallId,
  readCaptureState,
  requireCaptureGrant,
} from "@/lib/call-copilot/capture-gate"
import {
  CALL_COPILOT_CAPTURE_PURPOSES,
  CALL_COPILOT_LIVE_PURPOSES,
  callCopilotEventSchema,
  parseCallCopilotEvent,
} from "@/lib/call-copilot/events"
import { CallCopilotIngressError, recordCallCopilotEvent } from "@/lib/call-copilot/ingress"
import { handleCallCopilotCallback, type CallCopilotProviderSeam } from "@/lib/call-copilot/provider-seam"

const SHOP = "11111111-1111-4111-8111-111111111111"
const CALL = "CA0123456789abcdef0123456789abcdef"
const DIGEST = "a".repeat(64)
const T = "2026-11-19T12:00:00.000Z"

const opened = { providerCallId: CALL, providerEventId: "e1", sequence: 1, occurredAt: T, kind: "call_opened", routeKind: "gradia_controlled_number" }
const consent = { providerCallId: CALL, providerEventId: "e4", sequence: 4, occurredAt: T, kind: "consent_granted", party: "caller", disclosureVersion: "d1", respondsToSequence: 3 }

function rpcDb(result: { data?: unknown; error?: { code?: string; message?: string; details?: string } | null }) {
  const rpc = vi.fn().mockResolvedValue({ data: result.data ?? null, error: result.error ?? null })
  return { db: { rpc } as unknown as SupabaseClient, rpc }
}

const state = (over: Record<string, unknown> = {}) => ({
  status: "active", reason: "capture_active", capture_permitted_now: true, derivation_permitted: true,
  call_ended: false, outcome_unknown: false, contiguous_through: 5, highest_sequence: 5, unresolved_gap: false,
  conflict_count: 0,
  intervals: [{ started_sequence: 5, started_at: T, ended_sequence: null, ended_at: null, end_reason: null }],
  gaps: [{ started_sequence: 1, started_at: T, ended_sequence: 5, ended_at: T, reason: "before_consent" }],
  ignored: [], ...over,
})

describe("Call Copilot event vocabulary", () => {
  it("accepts each documented event kind", () => {
    const kinds = [
      opened,
      { ...consent, kind: "disclosure_delivered", respondsToSequence: undefined },
      consent,
      { ...consent, kind: "consent_declined", respondsToSequence: undefined },
      { providerCallId: CALL, providerEventId: "p", sequence: 6, occurredAt: T, kind: "capture_paused", reason: "operator_request" },
      { providerCallId: CALL, providerEventId: "r", sequence: 7, occurredAt: T, kind: "capture_resumed" },
      { providerCallId: CALL, providerEventId: "s", sequence: 8, occurredAt: T, kind: "capture_stopped" },
      { providerCallId: CALL, providerEventId: "x", sequence: 9, occurredAt: T, kind: "call_ended" },
      { providerCallId: CALL, providerEventId: "u", sequence: 10, occurredAt: T, kind: "provider_outcome_unknown", reason: "provider_timeout" },
      { providerCallId: CALL, providerEventId: "a", sequence: 11, occurredAt: T, kind: "participant_added" },
    ]
    for (const k of kinds) expect(parseCallCopilotEvent(JSON.parse(JSON.stringify(k))), String(k.kind)).not.toBeNull()
  })

  it("is strict: content-shaped or unknown fields are refused, never stored", () => {
    for (const extra of [
      { transcript: "hi there" }, { audioUrl: "https://example.test/a.wav" }, { callerNumber: "+15555550100" },
      { callerName: "Pat" }, { note: "free text" }, { disclosureText: "This call is recorded" },
    ]) {
      expect(parseCallCopilotEvent({ ...opened, ...extra })).toBeNull()
    }
  })

  it("refuses an uncontrolled route, unknown party, unknown kind, bad sequence and bad time", () => {
    expect(parseCallCopilotEvent({ ...opened, routeKind: "personal_cell" })).toBeNull()
    expect(parseCallCopilotEvent({ ...consent, party: "bystander" })).toBeNull()
    expect(parseCallCopilotEvent({ ...opened, kind: "recording_started" })).toBeNull()
    expect(parseCallCopilotEvent({ ...opened, sequence: 0 })).toBeNull()
    expect(parseCallCopilotEvent({ ...opened, sequence: 5001 })).toBeNull()
    expect(parseCallCopilotEvent({ ...opened, occurredAt: "yesterday" })).toBeNull()
    expect(parseCallCopilotEvent({ ...opened, providerCallId: "short" })).toBeNull()
    expect(parseCallCopilotEvent(null)).toBeNull()
    expect(parseCallCopilotEvent("call_opened")).toBeNull()
  })

  it("a consent must cite the disclosure it answers; a decline may omit it", () => {
    expect(callCopilotEventSchema.safeParse({ ...consent, respondsToSequence: undefined }).success).toBe(false)
    expect(callCopilotEventSchema.safeParse({ ...consent, kind: "consent_declined", respondsToSequence: undefined }).success).toBe(true)
  })

  it("an unknown outcome must carry a reason code", () => {
    expect(parseCallCopilotEvent({ providerCallId: CALL, providerEventId: "u", sequence: 3, occurredAt: T, kind: "provider_outcome_unknown" })).toBeNull()
  })

  it("splits the purposes into live capture and work on captured content", () => {
    expect([...CALL_COPILOT_LIVE_PURPOSES]).toEqual(["recording", "transcription"])
    expect([...CALL_COPILOT_CAPTURE_PURPOSES]).toEqual(["recording", "transcription", "model_use", "summarization", "extraction", "crm_mutation"])
  })
})

describe("recordCallCopilotEvent", () => {
  it("passes the explicit shop and typed columns, never a payload shop", async () => {
    const { db, rpc } = rpcDb({ data: { outcome: "recorded", event_id: "22222222-2222-4222-8222-222222222222", call_id: "33333333-3333-4333-8333-333333333333", digest: DIGEST, status: "awaiting_consent", reason: "consent_not_established", capture_permitted_now: false } })
    const out = await recordCallCopilotEvent(db, { shopId: SHOP, provider: "twilio", event: opened })
    expect(out).toMatchObject({ outcome: "recorded", status: "awaiting_consent", capturePermittedNow: false })
    expect(rpc).toHaveBeenCalledWith("call_copilot_record_event", expect.objectContaining({
      p_shop_id: SHOP, p_provider: "twilio", p_provider_call_id: CALL, p_provider_event_id: "e1", p_sequence: 1,
      p_kind: "call_opened", p_route_kind: "gradia_controlled_number", p_party: null, p_responds_to_sequence: null,
    }))
  })

  it("maps consent fields", async () => {
    const { db, rpc } = rpcDb({ data: { outcome: "duplicate", event_id: "22222222-2222-4222-8222-222222222222", digest: DIGEST } })
    expect(await recordCallCopilotEvent(db, { shopId: SHOP, provider: "twilio", event: consent })).toMatchObject({ outcome: "duplicate" })
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_party: "caller", p_disclosure_version: "d1", p_responds_to_sequence: 3, p_kind: "consent_granted" })
  })

  it("surfaces conflict and foreign_call outcomes", async () => {
    expect(await recordCallCopilotEvent(rpcDb({ data: { outcome: "conflict", conflict_kind: "event_id_changed", digest: DIGEST } }).db, { shopId: SHOP, provider: "twilio", event: consent }))
      .toEqual({ outcome: "conflict", conflictKind: "event_id_changed", digest: DIGEST })
    expect(await recordCallCopilotEvent(rpcDb({ data: { outcome: "foreign_call" } }).db, { shopId: SHOP, provider: "twilio", event: consent }))
      .toEqual({ outcome: "foreign_call" })
  })

  it("never calls the database for an invalid shop, provider or event", async () => {
    const { db, rpc } = rpcDb({ data: {} })
    expect(await recordCallCopilotEvent(db, { shopId: "not-a-uuid", provider: "twilio", event: opened })).toEqual({ outcome: "invalid" })
    expect(await recordCallCopilotEvent(db, { shopId: SHOP, provider: "vapi" as never, event: opened })).toEqual({ outcome: "invalid" })
    expect(await recordCallCopilotEvent(db, { shopId: SHOP, provider: "twilio", event: { ...opened, transcript: "x" } })).toEqual({ outcome: "invalid" })
    expect(rpc).not.toHaveBeenCalled()
  })

  it("treats database shape refusals as invalid and every other failure as a thrown, retryable error", async () => {
    for (const code of ["23514", "22023"]) {
      expect(await recordCallCopilotEvent(rpcDb({ error: { code, message: "x" } }).db, { shopId: SHOP, provider: "twilio", event: opened })).toEqual({ outcome: "invalid" })
    }
    for (const code of ["57014", "08006", "XX000", undefined]) {
      await expect(recordCallCopilotEvent(rpcDb({ error: { code, message: "secret payload text" } }).db, { shopId: SHOP, provider: "twilio", event: opened }))
        .rejects.toBeInstanceOf(CallCopilotIngressError)
    }
  })

  it("does not echo database messages or payloads in the thrown error", async () => {
    try {
      await recordCallCopilotEvent(rpcDb({ error: { code: "XX000", message: "Key (provider_call_id)=(CA0123456789abcdef0123456789abcdef) already exists" } }).db, { shopId: SHOP, provider: "twilio", event: opened })
      throw new Error("expected a throw")
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(CALL)
    }
  })

  it("throws on an unreadable result rather than reporting acceptance", async () => {
    await expect(recordCallCopilotEvent(rpcDb({ data: { outcome: "accepted_maybe" } }).db, { shopId: SHOP, provider: "twilio", event: opened }))
      .rejects.toBeInstanceOf(CallCopilotIngressError)
    await expect(recordCallCopilotEvent(rpcDb({ data: null }).db, { shopId: SHOP, provider: "twilio", event: opened }))
      .rejects.toBeInstanceOf(CallCopilotIngressError)
  })
})

describe("capture gate", () => {
  const CALL_ID = "33333333-3333-4333-8333-333333333333"

  it("issues a frozen grant only when the database permits", async () => {
    const { db, rpc } = rpcDb({ data: state() })
    const g = await requireCaptureGrant(db, { shopId: SHOP, callId: CALL_ID, purpose: "transcription" })
    expect(g).toMatchObject({ shopId: SHOP, callId: CALL_ID, purpose: "transcription", at: null })
    expect(Object.isFrozen(g)).toBe(true)
    expect(rpc).toHaveBeenCalledWith("call_copilot_assert_capture", { p_shop_id: SHOP, p_call_id: CALL_ID, p_purpose: "transcription", p_at: null })
  })

  it("a database denial becomes CaptureDeniedError with the stated reason", async () => {
    const e = await requireCaptureGrant(rpcDb({ error: { code: "CC403", details: "consent_declined" } }).db, { shopId: SHOP, callId: CALL_ID, purpose: "model_use" }).catch((x) => x)
    expect(e).toBeInstanceOf(CaptureDeniedError)
    expect((e as CaptureDeniedError).reason).toBe("consent_declined")
  })

  it.each([
    ["a database error", { error: { code: "57014", message: "timeout" } }],
    ["no data", { data: null }],
    ["an unreadable answer", { data: { status: "active" } }],
    ["a permit that contradicts a live purpose", { data: state({ capture_permitted_now: false }) }],
  ])("fails closed on %s", async (_name, result) => {
    const e = await requireCaptureGrant(rpcDb(result as never).db, { shopId: SHOP, callId: CALL_ID, purpose: "recording" }).catch((x) => x)
    expect(e).toBeInstanceOf(CaptureDeniedError)
  })

  it("a derived purpose needs derivation_permitted, not live capture", async () => {
    const afterCall = state({ status: "ended", reason: "call_ended", capture_permitted_now: false, call_ended: true })
    await expect(requireCaptureGrant(rpcDb({ data: afterCall }).db, { shopId: SHOP, callId: CALL_ID, purpose: "summarization" })).resolves.toBeTruthy()
    await expect(requireCaptureGrant(rpcDb({ data: afterCall }).db, { shopId: SHOP, callId: CALL_ID, purpose: "recording" })).rejects.toBeInstanceOf(CaptureDeniedError)
    await expect(requireCaptureGrant(rpcDb({ data: state({ derivation_permitted: false }) }).db, { shopId: SHOP, callId: CALL_ID, purpose: "extraction" })).rejects.toBeInstanceOf(CaptureDeniedError)
  })

  it("passes a stated moment to the database", async () => {
    const { db, rpc } = rpcDb({ data: state() })
    await requireCaptureGrant(db, { shopId: SHOP, callId: CALL_ID, purpose: "extraction", at: T })
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_at: T })
  })

  it("reads state and maps intervals and explicit gaps", async () => {
    const s = await readCaptureState(rpcDb({ data: state() }).db, { shopId: SHOP, callId: CALL_ID })
    expect(s).toMatchObject({ status: "active", capturePermittedNow: true })
    expect(s.intervals[0]).toMatchObject({ startedSequence: 5, endedAt: null })
    expect(s.gaps[0]).toMatchObject({ reason: "before_consent", endedSequence: 5 })
    await expect(readCaptureState(rpcDb({ error: { code: "XX000" } }).db, { shopId: SHOP, callId: CALL_ID })).rejects.toThrow()
  })

  it("scopes the call lookup to the shop and provider", async () => {
    const eq = vi.fn()
    const chain: Record<string, unknown> = {}
    chain.select = vi.fn(() => chain); chain.eq = eq.mockImplementation(() => chain)
    chain.maybeSingle = vi.fn().mockResolvedValue({ data: { id: CALL_ID }, error: null })
    const db = { from: vi.fn(() => chain) } as unknown as SupabaseClient
    expect(await findCallCopilotCallId(db, { shopId: SHOP, provider: "twilio", providerCallId: CALL })).toBe(CALL_ID)
    expect(eq.mock.calls).toEqual([["shop_id", SHOP], ["provider", "twilio"], ["provider_call_id", CALL]])
  })
})

describe("provider seam orchestration", () => {
  const seam = (accepted: unknown): CallCopilotProviderSeam => ({ provider: "twilio", acceptCallback: async () => accepted as never })
  const req = new Request("https://example.test/hook", { method: "POST", body: "x" })

  it("writes nothing for a rejected callback", async () => {
    for (const reason of ["signature_invalid", "unbound_number", "uncontrolled_route", "malformed"] as const) {
      const { db, rpc } = rpcDb({ data: {} })
      expect(await handleCallCopilotCallback(db, seam({ accepted: false, reason }), req)).toEqual({ status: "rejected", reason })
      expect(rpc).not.toHaveBeenCalled()
    }
  })

  it("rejects a seam answer with an untrusted shop id or a non-list of events", async () => {
    const { db, rpc } = rpcDb({ data: {} })
    expect(await handleCallCopilotCallback(db, seam({ accepted: true, shopId: "'; drop table shops", events: [opened] }), req)).toEqual({ status: "rejected", reason: "malformed" })
    expect(await handleCallCopilotCallback(db, seam({ accepted: true, shopId: SHOP, events: "nope" }), req)).toEqual({ status: "rejected", reason: "malformed" })
    expect(rpc).not.toHaveBeenCalled()
  })

  it("applies each event through the ledger and uses the seam's provider and shop only", async () => {
    const { db, rpc } = rpcDb({ data: { outcome: "duplicate", event_id: "22222222-2222-4222-8222-222222222222", digest: DIGEST } })
    const out = await handleCallCopilotCallback(db, seam({ accepted: true, shopId: SHOP, events: [opened, { ...consent, shopId: "99999999-9999-4999-8999-999999999999" }] }), req)
    expect(out).toMatchObject({ status: "processed" })
    expect(rpc).toHaveBeenCalledTimes(1) // the second event carries an extra field and is refused as invalid
    expect(out.status === "processed" && out.results.map((r) => r.outcome)).toEqual(["duplicate", "invalid"])
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_shop_id: SHOP, p_provider: "twilio" })
  })

  it("lets a database failure propagate so the provider retries", async () => {
    const { db } = rpcDb({ error: { code: "57014" } })
    await expect(handleCallCopilotCallback(db, seam({ accepted: true, shopId: SHOP, events: [opened] }), req)).rejects.toBeInstanceOf(CallCopilotIngressError)
  })
})
