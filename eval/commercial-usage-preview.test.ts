import { describe, expect, it } from "vitest"

import {
  APPROVED_COMMERCIAL_CATALOG_VERSION,
  FOUNDER_APPROVED_COMMERCIAL_CATALOG,
  FOUNDER_PILOT_POLICY,
} from "@/lib/approved-commercial-catalog"
import {
  previewCommercialPeriod,
  type CommercialPeriodPreview,
  type EvidenceCorrection,
  type EvidenceFact,
  type PreviewInput,
} from "@/lib/commercial-usage-preview"

const START = "2026-11-01T00:00:00Z"
const END = "2026-12-01T00:00:00Z"
let counter = 0
const id = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`
const T = (day: number, hour = 12) => `2026-11-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00Z`

const outcomeFact = (
  metric: string,
  workflowKey: string,
  patch: Partial<EvidenceFact> = {}
): EvidenceFact => ({
  id: id(),
  catalogVersion: APPROVED_COMMERCIAL_CATALOG_VERSION,
  metric,
  quantity: "1",
  workflowKey,
  wholesaleUnitCostCents: null,
  wholesaleBasis: null,
  recognizedAt: T(5),
  recordedAt: T(5),
  ...patch,
})
const providerFact = (
  metric: "inbound_voice_agent_minute" | "sms_segment",
  quantity: string,
  cost: string | null,
  patch: Partial<EvidenceFact> = {}
): EvidenceFact => ({
  id: id(),
  catalogVersion: APPROVED_COMMERCIAL_CATALOG_VERSION,
  metric,
  quantity,
  workflowKey: null,
  wholesaleUnitCostCents: cost,
  wholesaleBasis: cost === null ? null : "provider_reported",
  recognizedAt: T(6),
  recordedAt: T(6),
  ...patch,
})

const preview = (
  facts: EvidenceFact[],
  extra: Partial<PreviewInput> = {},
  corrections: EvidenceCorrection[] = []
): CommercialPeriodPreview =>
  previewCommercialPeriod({
    catalog: FOUNDER_APPROVED_COMMERCIAL_CATALOG,
    planKey: FOUNDER_PILOT_POLICY.planKey,
    windowStart: START,
    windowEnd: END,
    asOf: "2026-12-02T00:00:00Z",
    facts,
    corrections,
    priorWorkflowMetrics: {},
    ...extra,
  })

function ok(result: CommercialPeriodPreview) {
  if (result.state !== "ok") throw new Error(`expected ok, got ${JSON.stringify(result)}`)
  return result
}
const line = (result: CommercialPeriodPreview, metric: string) =>
  ok(result).usage.lines.find((l) => l.metric === metric)!

describe("exact approved metrics only", () => {
  it("fails closed on historical, unknown or unapproved evidence instead of ignoring it", () => {
    for (const metric of ["voice_minute", "agent_run", "message", "number_monthly", ""]) {
      const result = preview([providerFact("sms_segment", "1", null, { metric })])
      expect(result.state).toBe("invalid")
    }
    expect(preview([outcomeFact("qualified_lead", "w", { catalogVersion: "2025-01-01.v1" })]).state).toBe("invalid")
    expect(preview([outcomeFact("qualified_lead", "")]).state).toBe("invalid")
    expect(preview([outcomeFact("qualified_lead", "w", { quantity: "2" })]).state).toBe("invalid")
    const dup = outcomeFact("qualified_lead", "w")
    expect(preview([dup, dup]).state).toBe("invalid")
  })

  it("refuses a catalog whose rates are not exactly the approved metrics", () => {
    const catalog = structuredClone(FOUNDER_APPROVED_COMMERCIAL_CATALOG)
    catalog.plans[0].payg.rates.pop()
    expect(preview([], { catalog }).state).toBe("invalid")
  })
})

describe("highest-value-only digital outcome per workflow", () => {
  it("charges one appointment and is identical for every event order", () => {
    const facts = [
      outcomeFact("standard_digital_outcome", "wf-1", { recognizedAt: T(3) }),
      outcomeFact("qualified_lead", "wf-1", { recognizedAt: T(4) }),
      outcomeFact("confirmed_appointment", "wf-1", { recognizedAt: T(5) }),
    ]
    const permutations = [
      [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
    ].map((order) => JSON.stringify(preview(order.map((i) => facts[i]))))
    expect(new Set(permutations).size).toBe(1)
    const result = ok(preview(facts))
    expect(result.usage.totalCents).toBe(1000)
    expect(line(result, "confirmed_appointment").billedQuantity).toBe("1")
    expect(line(result, "qualified_lead").recognizedQuantity).toBe("0")
    expect(line(result, "standard_digital_outcome").recognizedQuantity).toBe("0")
    expect(result.usage.excluded.map((e) => e.reason).sort()).toEqual([
      "lower_value_same_workflow",
      "lower_value_same_workflow",
    ])
  })

  it("counts the same metric twice in one workflow once, and separate workflows separately", () => {
    const result = ok(
      preview([
        outcomeFact("qualified_lead", "wf-1"),
        outcomeFact("qualified_lead", "wf-1", { recognizedAt: T(7) }),
        outcomeFact("qualified_lead", "wf-2"),
      ])
    )
    expect(line(result, "qualified_lead").billedQuantity).toBe("2")
    expect(result.usage.totalCents).toBe(1000)
    expect(result.usage.excluded.map((e) => e.reason)).toEqual(["duplicate_same_metric"])
  })

  it("does not charge a workflow whose highest outcome was already recognized earlier", () => {
    const result = ok(
      preview([outcomeFact("standard_digital_outcome", "wf-old")], {
        priorWorkflowMetrics: { "wf-old": "confirmed_appointment" },
      })
    )
    expect(result.usage.totalCents).toBe(0)
    expect(result.usage.excluded[0].reason).toBe("already_recognized_earlier_period")
  })

  it("refuses to guess when a workflow's outcome is upgraded in a later period", () => {
    const result = preview([outcomeFact("confirmed_appointment", "wf-up")], {
      priorWorkflowMetrics: { "wf-up": "standard_digital_outcome" },
    })
    expect(result.state).toBe("conflict")
    expect(JSON.stringify(result)).not.toContain("totalCents")
  })
})

describe("allowances, fixed rates and dynamic markup floors", () => {
  it("includes 100 standard outcomes and charges $1.00 for the 101st", () => {
    const hundred = Array.from({ length: 100 }, (_, i) => outcomeFact("standard_digital_outcome", `s-${i}`))
    expect(ok(preview(hundred)).usage.totalCents).toBe(0)
    const extra = outcomeFact("standard_digital_outcome", "s-100", { recognizedAt: T(20) })
    const result = ok(preview([...hundred, extra]))
    expect(result.usage.totalCents).toBe(100)
    const billed = line(result, "standard_digital_outcome").evidence.filter((e) => e.billedQuantity !== "0")
    expect(billed.map((e) => e.factId)).toEqual([extra.id])
  })

  it("charges qualified leads $5 and appointments $10 with no allowance", () => {
    const result = ok(preview([outcomeFact("qualified_lead", "a"), outcomeFact("confirmed_appointment", "b")]))
    expect(result.usage.totalCents).toBe(1500)
  })

  it("voice: the $0.35 floor binds below cost 14 cents, cost/0.40 above it", () => {
    // 13.74 * 2.5 = 34.35 < 35 -> floor; 120 minutes, 100 included, 20 billed at 35 = 700.
    expect(ok(preview([providerFact("inbound_voice_agent_minute", "120", "13.74")])).usage.totalCents).toBe(700)
    // 20 * 2.5 = 50 -> 20 billed at 50 = 1000.
    expect(ok(preview([providerFact("inbound_voice_agent_minute", "120", "20")])).usage.totalCents).toBe(1000)
    // 14.5 * 2.5 = 36.25; 3 billed -> 108.75 -> rounds up to 109.
    const result = ok(preview([providerFact("inbound_voice_agent_minute", "103", "14.5")]))
    expect(result.usage.totalCents).toBe(109)
    expect(line(result, "inbound_voice_agent_minute").evidence[0].retailUnitCents).toBe("36.25")
  })

  it("SMS: no allowance; the 5 cent floor binds below 1.67 cents, cost x3 above it", () => {
    expect(ok(preview([providerFact("sms_segment", "10", "1.33")])).usage.totalCents).toBe(50)
    expect(ok(preview([providerFact("sms_segment", "10", "2")])).usage.totalCents).toBe(60)
  })

  it("applies fractional quantities exactly", () => {
    // 100.5 minutes: 0.5 billed at 100 cents (cost 40 * 2.5) = 50.
    expect(ok(preview([providerFact("inbound_voice_agent_minute", "100.5", "40")])).usage.totalCents).toBe(50)
  })

  it("consumes the allowance in recognition order across facts, ties broken by id", () => {
    const first = providerFact("inbound_voice_agent_minute", "60", "10", { recognizedAt: T(2) })
    const second = providerFact("inbound_voice_agent_minute", "60", "40", { recognizedAt: T(3) })
    const result = ok(preview([second, first]))
    // 60 free, then 40 free + 20 billed at the SECOND fact's own floor/markup (40*2.5 = 100).
    expect(result.usage.totalCents).toBe(2000)
    expect(line(result, "inbound_voice_agent_minute").evidence.map((e) => e.factId)).toEqual([first.id, second.id])
  })

  it("keeps provider usage distinct from digital outcomes", () => {
    const result = ok(
      preview([providerFact("inbound_voice_agent_minute", "5", "10"), providerFact("sms_segment", "3", "1")])
    )
    expect(line(result, "standard_digital_outcome").recognizedQuantity).toBe("0")
    expect(line(result, "inbound_voice_agent_minute").recognizedQuantity).toBe("5")
    expect(line(result, "sms_segment").recognizedQuantity).toBe("3")
    expect(result.usage.totalCents).toBe(15)
  })
})

describe("missing wholesale evidence is unavailable, never zero", () => {
  it("marks billable voice or SMS overage with unknown cost unavailable", () => {
    const voice = preview([providerFact("inbound_voice_agent_minute", "101", null)])
    expect(voice.state).toBe("unavailable")
    const sms = preview([providerFact("sms_segment", "1", null)])
    expect(sms.state).toBe("unavailable")
    for (const result of [voice, sms]) {
      expect(JSON.stringify(result)).not.toContain("totalCents")
      expect(JSON.stringify(result)).not.toContain("chargeCents")
    }
    if (voice.state === "unavailable") {
      expect(voice.reasons[0]).toMatchObject({ code: "wholesale_evidence_missing", metric: "inbound_voice_agent_minute" })
    }
  })

  it("does not need cost for minutes fully covered by the allowance", () => {
    const result = ok(preview([providerFact("inbound_voice_agent_minute", "100", null)]))
    expect(result.usage.totalCents).toBe(0)
  })

  it("an explicit zero cost is a real value and still honors the floor", () => {
    expect(ok(preview([providerFact("sms_segment", "2", "0")])).usage.totalCents).toBe(10)
  })
})

describe("one combined monthly cap", () => {
  it("allows exactly the cap and refuses one cent over, charging nothing", () => {
    const ten = Array.from({ length: 10 }, (_, i) => outcomeFact("confirmed_appointment", `a-${i}`))
    expect(ok(preview(ten)).usage.totalCents).toBe(10_000)
    const over = preview([...ten, providerFact("sms_segment", "1", "1")])
    expect(over.state).toBe("cap_exceeded")
    if (over.state === "cap_exceeded") {
      expect(over.usage.projectedCents).toBe(10_005)
      expect(over.usage.capCents).toBe(10_000)
    }
    expect(JSON.stringify(over)).not.toContain("totalCents")
  })

  it("is combined across metrics: each below the cap, together above it", () => {
    const appointments = Array.from({ length: 6 }, (_, i) => outcomeFact("confirmed_appointment", `a-${i}`)) // 6000
    const voice = providerFact("inbound_voice_agent_minute", "200", "20") // 100 billed * 50 = 5000
    expect(ok(preview(appointments)).usage.totalCents).toBe(6000)
    expect(ok(preview([voice])).usage.totalCents).toBe(5000)
    expect(preview([...appointments, voice]).state).toBe("cap_exceeded")
  })
})

describe("compensating corrections", () => {
  it("reduces billed quantity and excludes a fully voided outcome", () => {
    const voice = providerFact("inbound_voice_agent_minute", "120", "20")
    const appt = outcomeFact("confirmed_appointment", "wf")
    const result = ok(
      preview([voice, appt], {}, [
        { id: id(), recognitionId: voice.id, quantity: "20", reason: "provider_adjustment", recordedAt: T(8) },
        { id: id(), recognitionId: appt.id, quantity: "1", reason: "not_confirmed", recordedAt: T(8) },
      ])
    )
    expect(result.usage.totalCents).toBe(0)
    expect(result.usage.excluded.map((e) => e.reason)).toEqual(["fully_corrected"])
  })

  it("flags over-correction as a conflict, never a negative charge", () => {
    const voice = providerFact("inbound_voice_agent_minute", "5", "20")
    const result = preview([voice], {}, [
      { id: id(), recognitionId: voice.id, quantity: "3", reason: "duplicate", recordedAt: T(8) },
      { id: id(), recognitionId: voice.id, quantity: "3", reason: "duplicate", recordedAt: T(9) },
    ])
    expect(result.state).toBe("conflict")
  })

  it("ignores corrections and facts recorded after the as-of instant", () => {
    const voice = providerFact("inbound_voice_agent_minute", "120", "20")
    const late = providerFact("inbound_voice_agent_minute", "10", "20", { recordedAt: "2026-12-10T00:00:00Z" })
    const result = ok(
      preview([voice, late], { asOf: "2026-12-02T00:00:00Z" }, [
        { id: id(), recognitionId: voice.id, quantity: "20", reason: "duplicate", recordedAt: "2026-12-05T00:00:00Z" },
      ])
    )
    expect(result.usage.totalCents).toBe(1000)
  })
})

describe("half-open UTC window", () => {
  it("includes the start instant, excludes the end instant, and never double-counts at rollover", () => {
    const atStart = providerFact("sms_segment", "1", "1", { recognizedAt: START })
    const atEnd = providerFact("sms_segment", "1", "1", { recognizedAt: END })
    const november = ok(preview([atStart, atEnd]))
    expect(line(november, "sms_segment").evidence.map((e) => e.factId)).toEqual([atStart.id])
    const december = ok(preview([atStart, atEnd], { windowStart: END, windowEnd: "2026-12-31T00:00:00Z" }))
    expect(line(december, "sms_segment").evidence.map((e) => e.factId)).toEqual([atEnd.id])
    const total =
      Number(line(november, "sms_segment").recognizedQuantity) +
      Number(line(december, "sms_segment").recognizedQuantity)
    expect(total).toBe(2)
  })

  it("rejects malformed, inverted, non-UTC or over-long windows", () => {
    expect(preview([], { windowEnd: START }).state).toBe("invalid")
    expect(preview([], { windowStart: "2026-11-01T00:00:00" }).state).toBe("invalid")
    expect(preview([], { windowStart: "2026-11-01T00:00:00-05:00" }).state).toBe("invalid")
    expect(preview([], { windowEnd: "2027-03-01T00:00:00Z" }).state).toBe("invalid")
  })
})

describe("subscription visibility and honest unavailability", () => {
  it("shows base and seat pricing but never an invoice total or guessed seat proration", () => {
    const result = ok(preview([]))
    expect(result.subscription).toMatchObject({
      planKey: "founder-pilot",
      baseCents: 19_900,
      includedSeats: 3,
      extraSeatCents: 3_900,
      seatProration: { state: "seat_proration_unavailable" },
      invoiceTotal: { state: "unavailable", reason: "seat_proration_unavailable" },
    })
    expect(JSON.stringify(result)).not.toContain("invoiceTotalCents")
    expect(result.usage.totalCents).toBe(0) // an empty period is explicitly zero USAGE, not an invoice claim
  })

  it("is deterministic regardless of input ordering", () => {
    const facts = [
      providerFact("sms_segment", "4", "1.2", { recognizedAt: T(9) }),
      providerFact("inbound_voice_agent_minute", "130", "12", { recognizedAt: T(3) }),
      outcomeFact("qualified_lead", "x", { recognizedAt: T(4) }),
      outcomeFact("standard_digital_outcome", "y", { recognizedAt: T(2) }),
    ]
    expect(JSON.stringify(preview([...facts].reverse()))).toBe(JSON.stringify(preview(facts)))
  })

  it("unavailable, invalid and conflict results never carry a charge field", () => {
    const results = [
      preview([providerFact("sms_segment", "1", null)]),
      preview([outcomeFact("agent_run", "w")]),
      preview([outcomeFact("confirmed_appointment", "w")], { priorWorkflowMetrics: { w: "standard_digital_outcome" } }),
    ]
    expect(results.map((r) => r.state)).toEqual(["unavailable", "invalid", "conflict"])
    for (const result of results) {
      const json = JSON.stringify(result)
      expect(json).not.toMatch(/totalCents|chargeCents|projectedCents/)
    }
  })
})
