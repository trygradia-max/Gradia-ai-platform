import { readFileSync } from "node:fs"
import { describe, it, expect } from "vitest"

import { mockSupabase } from "./_lib"
import { pushLeadToCrm } from "@/lib/crm-provider"
import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * CRM connector seam (NEXT-4). The seam + Jobber/Housecall Pro adapters were
 * already built; these lock the NEXT-4 acceptance: CSV import lands customers
 * through the SAME seam as lead/booking approvals, the seam is safe (best-effort,
 * no-op) for the CRM-less majority, and adding a vendor is an adapter — one
 * entry in PROVIDERS, no call-site changes.
 */

function read(rel: string): string {
  return readFileSync(new URL(`../src/${rel}`, import.meta.url), "utf8")
}

describe("CSV import is on the CRM seam", () => {
  it("the recovery approve action pushes through pushLeadToCrm", () => {
    const src = read("app/actions/recovery.ts")
    expect(src).toContain("pushLeadToCrm")
  })

  it("approvals push leads + bookings through the seam, not a vendor directly", () => {
    const src = read("lib/approvals.ts")
    expect(src).toContain("pushLeadToCrm")
    expect(src).toContain("pushBookingToCrm")
    // Vendor modules must not be imported at the call site — they live behind
    // the seam (crm-provider.ts is the only importer).
    expect(src).not.toContain("jobber-push")
    expect(src).not.toContain("housecallpro-push")
  })
})

describe("adding a vendor is an adapter, not a rebuild", () => {
  it("every provider in PROVIDERS supplies both push functions", () => {
    const src = read("lib/crm-provider.ts")
    // Both adapters registered the same way — a new vendor is one more entry.
    for (const fn of [
      "pushLeadToJobber",
      "pushBookingToJobber",
      "pushLeadToHousecallPro",
      "pushBookingToHousecallPro",
    ]) {
      expect(src).toContain(fn)
    }
    expect(src).toContain("PROVIDERS")
  })
})

describe("the seam is safe for a CRM-less shop", () => {
  it("pushLeadToCrm resolves without throwing when no CRM is connected", async () => {
    // Every provider short-circuits inside loadShopIfConnected (no tokens →
    // returns) and the seam wraps each push best-effort, so this never throws.
    const supabase = mockSupabase({ data: [], error: null }) as SupabaseClient
    await expect(
      pushLeadToCrm({
        supabase,
        shopId: "shop-1",
        customerId: "cust-1",
        customerName: "Marcus Webb",
        phone: "+14155550142",
        email: "marcus@gmail.com",
      })
    ).resolves.toBeUndefined()
  })
})
