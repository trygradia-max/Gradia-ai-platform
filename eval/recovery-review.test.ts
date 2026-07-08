import { describe, it, expect } from "vitest"

import {
  candidateToCustomerInput,
  candidateVehicle,
  mergePatch,
  shapeReviewCandidate,
  type RecoveredCustomerInput,
} from "@/lib/recovery/review"
import type { RecoveryExtraction } from "@/lib/recovery/extract"

/**
 * Review shaping + the customer-write payload (NEXT-3 §3.1). Pure — locks how
 * approved candidates become CRM rows, including the never-overwrite merge rule.
 */

const ext = (over: Partial<RecoveryExtraction>): RecoveryExtraction => ({
  name: "Marcus Webb",
  phones: ["(415) 555-0142"],
  emails: ["marcus@gmail.com"],
  vehicle: null,
  services_mentioned: [],
  last_interaction_at: null,
  direction: "completed",
  confidence: 0.9,
  ...over,
})

describe("shapeReviewCandidate", () => {
  it("merges member extractions — vehicle, latest date, union of services", () => {
    const byId = new Map<string, RecoveryExtraction>([
      ["r1", ext({ vehicle: null, last_interaction_at: "2025-01-01", services_mentioned: ["ceramic"] })],
      ["r2", ext({ vehicle: "2021 Tesla Model 3", last_interaction_at: "2026-03-04", services_mentioned: ["polish"] })],
    ])
    const c = shapeReviewCandidate(
      { names: ["Marcus Webb"], phones: ["(415) 555-0142"], emails: ["marcus@gmail.com"], members: ["r1", "r2"], nameConflict: false },
      { kind: "new" },
      byId
    )
    expect(c.key).toBe("r1")
    expect(c.vehicle).toBe("2021 Tesla Model 3")
    expect(c.lastTransactionAt).toBe("2026-03-04")
    expect(c.servicesMentioned.sort()).toEqual(["ceramic", "polish"])
  })
})

describe("candidateToCustomerInput", () => {
  it("parses the vehicle (write-through flat columns) and stamps source=import", () => {
    const input = candidateToCustomerInput({
      name: "Marcus Webb",
      phones: ["(415) 555-0142"],
      emails: ["marcus@gmail.com"],
      vehicle: "2021 Tesla Model 3, white",
      lastTransactionAt: "2026-03-04",
    })
    expect(input.source).toBe("import")
    expect(input.phone).toBe("(415) 555-0142")
    expect(input.vehicle_make).toBe("Tesla")
    expect(input.vehicle_year).toBe(2021)
    expect(input.last_transaction_at).toBe("2026-03-04")
  })
})

describe("candidateVehicle", () => {
  it("parses the vehicle string for the vehicles-table upsert", () => {
    const v = candidateVehicle({ vehicle: "2021 Tesla Model 3, white" })
    expect(v.make).toBe("Tesla")
    expect(v.model).toBe("Model 3")
    expect(v.year).toBe(2021)
    expect(v.color).toBe("White")
  })

  it("returns all-null for an empty vehicle string", () => {
    expect(candidateVehicle({ vehicle: null })).toEqual({
      make: null,
      model: null,
      year: null,
      color: null,
    })
  })
})

describe("mergePatch — never overwrites the owner's data", () => {
  const input: RecoveredCustomerInput = {
    name: "Marcus Webb",
    phone: "(415) 555-0142",
    email: "new@gmail.com",
    vehicle_make: "Tesla",
    vehicle_model: "Model 3",
    vehicle_year: 2021,
    vehicle_color: "white",
    source: "import",
    last_transaction_at: "2026-03-04",
  }

  it("fills only empty fields, advances last_transaction_at, stamps source if blank", () => {
    const existing = {
      name: "Marcus Webb",
      phone: "(415) 555-0142",
      email: null, // empty → filled
      vehicle_make: null,
      vehicle_model: null,
      vehicle_year: null,
      vehicle_color: null,
      last_transaction_at: "2025-01-01", // older → advanced
      source: null, // blank → stamped
    }
    const patch = mergePatch(existing, input)
    expect(patch.email).toBe("new@gmail.com")
    expect(patch.vehicle_make).toBe("Tesla")
    expect(patch.last_transaction_at).toBe("2026-03-04")
    expect(patch.source).toBe("import")
    // Does NOT touch fields the owner already has.
    expect(patch).not.toHaveProperty("name")
    expect(patch).not.toHaveProperty("phone")
  })

  it("leaves a fully-populated, more-recent record untouched", () => {
    const existing = {
      name: "Marcus W",
      phone: "415-555-0142",
      email: "owner@gmail.com",
      vehicle_make: "Tesla",
      vehicle_model: "Model 3",
      vehicle_year: 2021,
      vehicle_color: "black",
      last_transaction_at: "2026-06-01", // newer than the import
      source: "inbound_sms",
    }
    expect(mergePatch(existing, input)).toEqual({})
  })
})
