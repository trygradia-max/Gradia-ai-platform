import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import {
  APPROVED_COMMERCIAL_CATALOG_VERSION,
  FOUNDER_APPROVED_COMMERCIAL_CATALOG,
} from "@/lib/approved-commercial-catalog"
import {
  COMMERCIAL_METRICS,
  OUTCOME_RANK,
  buildCorrectionIdempotencyKey,
  buildRecognitionIdempotencyKey,
  correctionInputSchema,
  evaluateOutcomeEvidence,
  isCommercialMetric,
  platformBillingScope,
  recognitionInputSchema,
  toRecognitionRpcParams,
} from "@/lib/commercial-usage"

const SHOP = "11111111-1111-4111-8111-111111111111"
const LEDGER = "22222222-2222-4222-8222-222222222222"
const KEY_SHAPE = /^[A-Za-z0-9_.:-]{16,200}$/

const outcome = (patch: Record<string, unknown> = {}) => ({
  kind: "outcome" as const,
  shopId: SHOP,
  metric: "confirmed_appointment" as const,
  workflowKey: "lead:abc",
  sourceRef: "appointment:1",
  outcome: { state: "confirmed", humanCompleted: false },
  recognizedAt: "2026-11-02T10:00:00Z",
  ...patch,
})
const voice = (patch: Record<string, unknown> = {}) => ({
  kind: "provider_usage" as const,
  shopId: SHOP,
  metric: "inbound_voice_agent_minute" as const,
  usageEventId: LEDGER,
  sourceRef: "vapi-call-1",
  quantity: "3",
  direction: "inbound" as const,
  recognizedAt: "2026-11-02T10:00:00Z",
  ...patch,
})

describe("approved metrics", () => {
  it("are exactly the five catalog metrics and nothing historical", () => {
    expect([...COMMERCIAL_METRICS].sort()).toEqual(
      FOUNDER_APPROVED_COMMERCIAL_CATALOG.plans[0].payg.rates.map((rate) => rate.metric).sort()
    )
    for (const historical of ["agent_run", "message", "voice_minute", "number_monthly", "email_send", "bi_answer", ""]) {
      expect(isCommercialMetric(historical)).toBe(false)
    }
    expect(isCommercialMetric(undefined)).toBe(false)
  })

  it("orders outcomes standard < qualified lead < confirmed appointment", () => {
    expect(OUTCOME_RANK.standard_digital_outcome).toBeLessThan(OUTCOME_RANK.qualified_lead)
    expect(OUTCOME_RANK.qualified_lead).toBeLessThan(OUTCOME_RANK.confirmed_appointment)
  })
})

describe("outcome evidence is fail-closed", () => {
  it("bills only an explicitly confirmed outcome no human had to finish", () => {
    expect(evaluateOutcomeEvidence({ state: "confirmed", humanCompleted: false })).toEqual({ billable: true })
  })

  it.each([
    ["draft", false, "draft"],
    ["proposal", false, "proposal"],
    ["escalation", false, "escalation"],
    ["failure", false, "failure"],
    ["unknown", false, "unknown"],
    ["confirmed", true, "human_completed"],
    ["confirmed", undefined, "human_completion_unknown"],
    [undefined, false, "unrecognised_state"],
    ["booked-ish", false, "unrecognised_state"],
  ])("refuses state %s humanCompleted %s", (state, humanCompleted, reason) => {
    expect(evaluateOutcomeEvidence({ state, humanCompleted })).toEqual({ billable: false, reason })
  })
})

describe("recognition input contract", () => {
  it("accepts a confirmed outcome and an inbound voice fact", () => {
    expect(recognitionInputSchema.safeParse(outcome()).success).toBe(true)
    expect(recognitionInputSchema.safeParse(voice()).success).toBe(true)
  })

  it("rejects historical kinds, unknown fields, outbound voice and malformed values", () => {
    expect(recognitionInputSchema.safeParse(voice({ metric: "voice_minute" })).success).toBe(false)
    expect(recognitionInputSchema.safeParse(outcome({ metric: "agent_run" })).success).toBe(false)
    expect(recognitionInputSchema.safeParse(outcome({ extra: 1 })).success).toBe(false)
    expect(recognitionInputSchema.safeParse(voice({ direction: "outbound" })).success).toBe(false)
    expect(recognitionInputSchema.safeParse(voice({ quantity: "-1" })).success).toBe(false)
    expect(recognitionInputSchema.safeParse(voice({ quantity: "1.1234567" })).success).toBe(false)
    expect(recognitionInputSchema.safeParse(voice({ recognizedAt: "2026-11-02T10:00:00" })).success).toBe(false)
    expect(recognitionInputSchema.safeParse(voice({ shopId: "not-a-uuid" })).success).toBe(false)
    expect(recognitionInputSchema.safeParse(outcome({ workflowKey: "  " })).success).toBe(false)
  })

  it("SMS segments may be outbound; wholesale absent stays absent, never zero", () => {
    const parsed = recognitionInputSchema.parse(
      voice({ metric: "sms_segment", direction: "outbound", quantity: "2" })
    )
    const params = toRecognitionRpcParams(parsed)
    expect(params.p_wholesale_unit_cost_cents).toBeNull()
    expect(params.p_wholesale_basis).toBeNull()
  })

  it("maps to exact RPC arguments with the approved catalog version", () => {
    const params = toRecognitionRpcParams(recognitionInputSchema.parse(outcome()))
    expect(params).toMatchObject({
      p_shop: SHOP,
      p_catalog_version: APPROVED_COMMERCIAL_CATALOG_VERSION,
      p_metric: "confirmed_appointment",
      p_quantity: 1,
      p_source_kind: "workflow_outcome",
      p_source_usage_event_id: null,
      p_workflow_key: "lead:abc",
      p_wholesale_unit_cost_cents: null,
      p_evidence: { outcome_state: "confirmed", human_completed: false },
    })
    const provider = toRecognitionRpcParams(
      recognitionInputSchema.parse(
        voice({ wholesale: { unitCostCents: "13.74", basis: "provider_reported" } })
      )
    )
    expect(provider).toMatchObject({
      p_source_kind: "usage_event",
      p_source_usage_event_id: LEDGER,
      p_workflow_key: null,
      p_wholesale_unit_cost_cents: "13.74",
      p_wholesale_basis: "provider_reported",
      p_evidence: { direction: "inbound" },
    })
  })

  it("normalizes recognition time so a retry presents an identical fact", () => {
    const a = recognitionInputSchema.parse(outcome({ recognizedAt: "2026-11-02T10:00:00Z" }))
    const b = recognitionInputSchema.parse(outcome({ recognizedAt: "2026-11-02T10:00:00.000+00:00" }))
    expect(toRecognitionRpcParams(a).p_recognized_at).toBe(toRecognitionRpcParams(b).p_recognized_at)
  })
})

describe("deterministic idempotency identity", () => {
  it("is stable per business fact and independent of evidence, time or quantity wording", () => {
    const base = buildRecognitionIdempotencyKey(recognitionInputSchema.parse(outcome()))
    const again = buildRecognitionIdempotencyKey(
      recognitionInputSchema.parse(outcome({ recognizedAt: "2026-11-03T00:00:00Z", sourceRef: "other", evidence: { a: 1 } }))
    )
    expect(again).toBe(base)
    expect(base).toMatch(KEY_SHAPE)
  })

  it("differs by metric, workflow and ledger row", () => {
    const keys = new Set([
      buildRecognitionIdempotencyKey(recognitionInputSchema.parse(outcome())),
      buildRecognitionIdempotencyKey(recognitionInputSchema.parse(outcome({ metric: "qualified_lead" }))),
      buildRecognitionIdempotencyKey(recognitionInputSchema.parse(outcome({ workflowKey: "lead:other" }))),
      buildRecognitionIdempotencyKey(recognitionInputSchema.parse(voice())),
      buildRecognitionIdempotencyKey(
        recognitionInputSchema.parse(voice({ usageEventId: "33333333-3333-4333-8333-333333333333" }))
      ),
    ])
    expect(keys.size).toBe(5)
    for (const key of keys) expect(key).toMatch(KEY_SHAPE)
  })

  it("derives correction keys from the recognition and the caller's stable reference", () => {
    const parse = (ref: string) =>
      correctionInputSchema.parse({
        shopId: SHOP,
        recognitionId: LEDGER,
        quantity: "1",
        reason: "recognized_in_error",
        correctionRef: ref,
      })
    expect(buildCorrectionIdempotencyKey(parse("r1"))).toBe(buildCorrectionIdempotencyKey(parse("r1")))
    expect(buildCorrectionIdempotencyKey(parse("r1"))).not.toBe(buildCorrectionIdempotencyKey(parse("r2")))
    expect(buildCorrectionIdempotencyKey(parse("r1"))).toMatch(KEY_SHAPE)
  })
})

describe("platform billing is separate from Stripe Connect invoicing", () => {
  it("never treats a Connect envelope as platform billing", () => {
    expect(platformBillingScope({ id: "evt_1", account: "acct_connected" })).toBe("connect")
    expect(platformBillingScope({ id: "evt_1" })).toBe("platform")
    expect(platformBillingScope({ id: "evt_1", account: null })).toBe("platform")
    expect(platformBillingScope({})).toBe("unknown")
    expect(platformBillingScope(null)).toBe("unknown")
  })

  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      return statSync(path).isDirectory() ? walk(path) : [path]
    })

  it("keeps Stripe webhook and Connect code from reaching commercial usage state", () => {
    const stripeFiles = walk("src/app/api/stripe").filter((file) => /\.(ts|tsx)$/.test(file))
    expect(stripeFiles.length).toBeGreaterThan(0)
    for (const file of stripeFiles) {
      const source = readFileSync(file, "utf8")
      expect(source, file).not.toMatch(/commercial-usage|commercial_recognize_usage|commercial_correct_usage|commercial_usage_read/)
    }
    // The platform path keeps ignoring Connect envelopes.
    const webhook = readFileSync("src/app/api/stripe/webhook/route.ts", "utf8")
    expect(webhook).toMatch(/if \(event\.account\) \{\s*return Response\.json\(\{ ok: true, ignored: "connect event on platform billing path" \}\)/)
  })

  it("commercial usage modules do not call Stripe at all", () => {
    for (const file of [
      "src/lib/commercial-usage.ts",
      "src/lib/commercial-usage-preview.ts",
      "src/lib/commercial-usage-service.ts",
    ]) {
      const source = readFileSync(file, "utf8")
      expect(source, file).not.toMatch(/from "stripe"|@\/lib\/stripe"|api\.stripe\.com|fetch\(/)
    }
  })
})
