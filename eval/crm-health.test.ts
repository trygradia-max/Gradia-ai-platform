import { describe, it, expect } from "vitest"

import {
  findDuplicateClusters,
  normalizeName,
  type CustomerLite,
} from "@/lib/crm-health"

/**
 * Tier 1 — pure. Locks the CRM-cleanup engine: name normalization and the
 * duplicate clustering that powers the "5 Sarahs" merge.
 */

const cust = (id: string, name: string | null, extra: Partial<CustomerLite> = {}): CustomerLite => ({
  id,
  name,
  phone: null,
  email: null,
  vehicle: null,
  last_visit_at: null,
  ...extra,
})

describe("normalizeName", () => {
  it("lowercases, strips punctuation, collapses whitespace", () => {
    expect(normalizeName("  Sarah   J. ")).toBe("sarah j")
    expect(normalizeName("SARAH")).toBe(normalizeName("sarah"))
    expect(normalizeName(null)).toBe("")
  })
})

describe("findDuplicateClusters", () => {
  it("groups same-name records into clusters of 2+, largest first", () => {
    const customers = [
      cust("1", "Sarah", { vehicle: "Tesla Model 3" }),
      cust("2", "sarah", { vehicle: "Honda Civic" }),
      cust("3", "Sarah ", { phone: "+15551112222" }),
      cust("4", "Mike", { phone: "+15553334444" }),
      cust("5", "Mike", { email: "mike@x.com" }),
      cust("6", "Dana"), // unique → not a cluster
    ]
    const clusters = findDuplicateClusters(customers)
    expect(clusters).toHaveLength(2)
    expect(clusters[0].key).toBe("sarah") // 3 records, largest first
    expect(clusters[0].members).toHaveLength(3)
    expect(clusters[1].key).toBe("mike")
  })

  it("skips records with no usable name", () => {
    const clusters = findDuplicateClusters([cust("1", null), cust("2", "")])
    expect(clusters).toEqual([])
  })
})
