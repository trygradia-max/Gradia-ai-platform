import type { SupabaseClient } from "@supabase/supabase-js"
import { describe, expect, it, vi } from "vitest"

import {
  correctCommercialUsage,
  readCommercialUsagePreview,
  recognizeCommercialUsage,
} from "@/lib/commercial-usage-service"

const SHOP = "11111111-1111-4111-8111-111111111111"
const REC = "44444444-4444-4444-8444-444444444444"

const client = (result: { data?: unknown; error?: { code?: string; message?: string } | null }) => {
  const rpc = vi.fn().mockResolvedValue({ data: result.data ?? null, error: result.error ?? null })
  return { client: { rpc } as unknown as SupabaseClient, rpc }
}

const outcome = (patch: Record<string, unknown> = {}) => ({
  kind: "outcome" as const,
  shopId: SHOP,
  metric: "qualified_lead" as const,
  workflowKey: "lead:1",
  sourceRef: "lead:1",
  outcome: { state: "confirmed", humanCompleted: false },
  recognizedAt: "2026-11-02T10:00:00Z",
  ...patch,
})

describe("recognizeCommercialUsage", () => {
  it("never reaches the database for a non-billable outcome", async () => {
    const { client: c, rpc } = client({ data: { id: REC, replayed: false } })
    for (const state of ["draft", "proposal", "escalation", "failure", "unknown"]) {
      const result = await recognizeCommercialUsage(c, outcome({ outcome: { state, humanCompleted: false } }))
      expect(result).toEqual({ ok: false, reason: "not_billable", detail: state })
    }
    const human = await recognizeCommercialUsage(c, outcome({ outcome: { state: "confirmed", humanCompleted: true } }))
    expect(human).toMatchObject({ ok: false, reason: "not_billable", detail: "human_completed" })
    expect(rpc).not.toHaveBeenCalled()
  })

  it("rejects malformed input before any database call", async () => {
    const { client: c, rpc } = client({})
    expect(await recognizeCommercialUsage(c, { ...outcome(), metric: "agent_run" } as never)).toMatchObject({
      ok: false,
      reason: "invalid",
    })
    expect(rpc).not.toHaveBeenCalled()
  })

  it("returns the recognition id and replay flag", async () => {
    const { client: c, rpc } = client({ data: { id: REC, replayed: true } })
    expect(await recognizeCommercialUsage(c, outcome())).toEqual({ ok: true, id: REC, replayed: true })
    expect(rpc).toHaveBeenCalledWith("commercial_recognize_usage", expect.objectContaining({ p_shop: SHOP }))
  })

  it.each([
    ["CB409", "conflict"],
    ["CB422", "not_billable"],
    ["42501", "forbidden"],
    ["22023", "invalid"],
    ["08006", "failed"],
    [undefined, "failed"],
  ])("maps database code %s to %s, and a transport failure is never success", async (code, reason) => {
    const { client: c } = client({ error: { code, message: "x" } })
    expect(await recognizeCommercialUsage(c, outcome())).toMatchObject({ ok: false, reason })
  })

  it("treats a malformed database answer as failed", async () => {
    const { client: c } = client({ data: { id: "nope" } })
    expect(await recognizeCommercialUsage(c, outcome())).toEqual({ ok: false, reason: "failed" })
  })
})

describe("correctCommercialUsage", () => {
  const input = {
    shopId: SHOP,
    recognitionId: REC,
    quantity: "1",
    reason: "recognized_in_error" as const,
    correctionRef: "review-1",
  }
  it("sends a deterministic key and maps over-correction to conflict", async () => {
    const ok = client({ data: { id: REC, replayed: false } })
    expect(await correctCommercialUsage(ok.client, input)).toEqual({ ok: true, id: REC, replayed: false })
    const first = ok.rpc.mock.calls[0][1].p_idempotency_key
    await correctCommercialUsage(ok.client, input)
    expect(ok.rpc.mock.calls[1][1].p_idempotency_key).toBe(first)

    const conflict = client({ error: { code: "CB409" } })
    expect(await correctCommercialUsage(conflict.client, input)).toMatchObject({ ok: false, reason: "conflict" })
  })
  it("rejects invalid corrections before the database", async () => {
    const { client: c, rpc } = client({})
    expect(await correctCommercialUsage(c, { ...input, quantity: "0.0000001" })).toMatchObject({ reason: "invalid" })
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe("readCommercialUsagePreview", () => {
  const window = { shopId: SHOP, windowStart: "2026-11-01T00:00:00Z", windowEnd: "2026-12-01T00:00:00Z" }

  it("never turns a failed or forbidden read into an empty/zero preview", async () => {
    expect(await readCommercialUsagePreview(client({ error: { code: "42501" } }).client, window)).toEqual({
      status: "forbidden",
    })
    expect(await readCommercialUsagePreview(client({ error: { code: "XX000" } }).client, window)).toEqual({
      status: "unavailable",
      reason: "read_failed",
    })
    expect(await readCommercialUsagePreview(client({ data: { facts: "bad" } }).client, window)).toEqual({
      status: "unavailable",
      reason: "malformed_evidence",
    })
  })

  it("refuses a window that is not an explicit UTC instant pair, without calling the database", async () => {
    const { client: c, rpc } = client({})
    for (const windowStart of ["2026-11-01", "2026-11-01T00:00:00", "2026-11-01T00:00:00-05:00"]) {
      expect(await readCommercialUsagePreview(c, { ...window, windowStart })).toEqual({
        status: "unavailable",
        reason: "invalid_window",
      })
    }
    expect(rpc).not.toHaveBeenCalled()
  })

  it("builds the deterministic preview from the evidence DTO", async () => {
    const { client: c } = client({
      data: {
        as_of: "2026-12-02T00:00:00Z",
        prior_workflow_metrics: {},
        corrections: [],
        facts: [
          {
            id: REC,
            catalog_version: "2026-11-03.v1",
            metric: "confirmed_appointment",
            quantity: "1.000000",
            workflow_key: "lead:1",
            wholesale_unit_cost_cents: null,
            wholesale_basis: null,
            recognized_at: "2026-11-05T10:00:00+00:00",
            recorded_at: "2026-11-05T10:00:01+00:00",
          },
        ],
      },
    })
    const read = await readCommercialUsagePreview(c, window)
    expect(read.status).toBe("ready")
    if (read.status === "ready" && read.preview.state === "ok") {
      expect(read.preview.usage.totalCents).toBe(1000)
    } else {
      throw new Error("expected an ok preview")
    }
  })
})
