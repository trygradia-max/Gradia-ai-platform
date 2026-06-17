import { describe, it, expect } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

import { resolveFreeformAudience } from "@/lib/agent-audience"
import type { FreeformPlan, ShopRow } from "@/lib/types/database"

/**
 * Integration of the TCPA win-back gate into the audience resolver
 * (GRADIA_CUSTOMER_RECOVERY_SPEC §3.2). Proves the recovered_customers segment
 * resolves only EBR-eligible recipients for SMS, falls back to email otherwise,
 * and that do_not_contact is a hard block on EVERY customer outreach.
 */

const DAY = 86_400_000
const monthsAgo = (n: number) => new Date(Date.now() - n * 30 * DAY).toISOString()

type Cust = Record<string, unknown>

/** Table-aware Supabase double: customers query returns the seeded rows; every
 *  interactions sub-query (active/inbound/cooldown/opt-out) returns empty. */
function makeMock(customers: Cust[]): SupabaseClient {
  function chain(table: string): unknown {
    const result =
      table === "customers"
        ? { data: customers, error: null }
        : { data: [], error: null }
    const proxy: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === "then")
          return (res: (v: unknown) => unknown) => Promise.resolve(result).then(res)
        return () => proxy
      },
    })
    return proxy
  }
  return { from: (t: string) => chain(t) } as unknown as SupabaseClient
}

const SHOP = { id: "shop1", name: "Pristine" } as unknown as ShopRow

const cust = (over: Cust): Cust => ({
  id: "c",
  name: "Someone",
  phone: "+14155550100",
  email: "someone@x.com",
  vehicle_make: null,
  vehicle_model: null,
  vehicle_year: null,
  last_visit_at: null,
  last_transaction_at: monthsAgo(3),
  sms_opted_out_at: null,
  do_not_contact: false,
  source: "import",
  ...over,
})

const plan = (over: Partial<FreeformPlan>): FreeformPlan => ({
  entity: "customers",
  channel: "sms",
  filters: { recovered_only: true },
  message_intent: "win back",
  max_recipients: 50,
  cooldown_days: 30,
  ...over,
})

describe("recovered_customers segment — SMS is EBR-gated", () => {
  it("keeps only the within-18-month customer for an SMS win-back", async () => {
    const supabase = makeMock([
      cust({ id: "recent", last_transaction_at: monthsAgo(3) }),
      cust({ id: "stale", last_transaction_at: monthsAgo(24) }),
      cust({ id: "optedout", sms_opted_out_at: monthsAgo(1) }),
      cust({ id: "blocked", do_not_contact: true }),
    ])
    const res = await resolveFreeformAudience(supabase, SHOP, plan({ channel: "sms" }))
    expect(res.targets.map((t) => t.customerId)).toEqual(["recent"])
    expect(res.stats.skipped_ineligible).toBe(3)
  })

  it("an email win-back reaches the stale + opted-out ones, never the blocked", async () => {
    const supabase = makeMock([
      cust({ id: "recent", last_transaction_at: monthsAgo(3) }),
      cust({ id: "stale", last_transaction_at: monthsAgo(24) }),
      cust({ id: "optedout", sms_opted_out_at: monthsAgo(1) }),
      cust({ id: "blocked", do_not_contact: true }),
    ])
    const res = await resolveFreeformAudience(supabase, SHOP, plan({ channel: "email" }))
    expect(res.targets.map((t) => t.customerId).sort()).toEqual([
      "optedout",
      "recent",
      "stale",
    ])
    expect(res.stats.skipped_ineligible).toBe(1) // only the blocked one
  })
})

describe("do_not_contact is universal (even outside the recovered segment)", () => {
  it("blocks a do_not_contact customer on a normal (non-recovered) SMS campaign", async () => {
    const supabase = makeMock([
      cust({ id: "ok", do_not_contact: false, source: "inbound_sms" }),
      cust({ id: "blocked", do_not_contact: true, source: "inbound_sms" }),
    ])
    const res = await resolveFreeformAudience(
      supabase,
      SHOP,
      plan({ channel: "sms", filters: {} }) // no recovered_only
    )
    expect(res.targets.map((t) => t.customerId)).toEqual(["ok"])
    expect(res.stats.skipped_ineligible).toBe(1)
  })
})
