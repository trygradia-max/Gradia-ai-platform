import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

import { hasVoice, includedCreditsThisPeriod, isPaid, shopTier } from "@/lib/entitlements"
import { tierSpec } from "@/lib/pricing"
import type { ShopRow } from "@/lib/types/database"
import { cleanup, INTEGRATION, seedShop, serviceClient, type Seeded } from "./_db"

/**
 * P0-013 — tier identity on real Postgres. Locks two properties the unit
 * suites (mocked Supabase) can't: the migration's DEFAULT/backfill actually
 * lands a real row on `core`, and a tier WRITE scoped by `.eq("id", …)` (the
 * exact pattern the Stripe webhook uses) cannot cross-contaminate another
 * shop's row.
 */

type TierFields = Pick<ShopRow, "id" | "plan" | "tier" | "voice_addon" | "trial_ends_at">

async function loadTierFields(sb: SupabaseClient, shopId: string): Promise<TierFields> {
  const { data, error } = await sb
    .from("shops")
    .select("id, plan, tier, voice_addon, trial_ends_at")
    .eq("id", shopId)
    .single()
  if (error || !data) throw new Error(`loadTierFields: ${error?.message}`)
  return data as TierFields
}

describe.skipIf(!INTEGRATION)("billing tier — real Postgres [integration]", () => {
  let sb: SupabaseClient
  let shopA: Seeded
  let shopB: Seeded

  beforeAll(async () => {
    sb = serviceClient()
    shopA = await seedShop(sb)
    shopB = await seedShop(sb)
  })

  afterAll(async () => {
    if (!sb) return
    await cleanup(sb, shopA)
    await cleanup(sb, shopB)
  })

  it("a freshly seeded shop backfills to core (migration default) — the grandfather rule", async () => {
    const row = await loadTierFields(sb, shopA.shopId)
    expect(row.tier).toBe("core")
  })

  it("a grandfathered pilot shop (plan=active, no Stripe subscription) keeps Core entitlements", async () => {
    // Pre-P0-013 pilot shops were hand-activated with no stripe_subscription_id.
    // The backfill must not have taken anything away from them.
    const { error } = await sb
      .from("shops")
      .update({ plan: "active" })
      .eq("id", shopA.shopId)
    expect(error).toBeNull()

    const row = await loadTierFields(sb, shopA.shopId)
    expect(isPaid(row)).toBe(true)
    expect(shopTier(row)).toBe("core")
    expect(hasVoice(row)).toBe(false)
    expect(includedCreditsThisPeriod(row)).toBe(tierSpec("core").includedCredits)
    expect(includedCreditsThisPeriod(row)).toBe(7000)
  })

  it("a tier write scoped by .eq('id', shopId) — the webhook's exact pattern — never touches another shop", async () => {
    const before = await loadTierFields(sb, shopB.shopId)
    expect(before.tier).toBe("core")

    const { error } = await sb
      .from("shops")
      .update({ tier: "operator", plan: "active" })
      .eq("id", shopA.shopId)
    expect(error).toBeNull()

    const [afterA, afterB] = await Promise.all([
      loadTierFields(sb, shopA.shopId),
      loadTierFields(sb, shopB.shopId),
    ])
    expect(afterA.tier).toBe("operator")
    // shop B is untouched — same tier, same plan as before A's write.
    expect(afterB).toEqual(before)
  })

  it("the tier CHECK constraint rejects a value outside core|pro|operator", async () => {
    const { error } = await sb
      .from("shops")
      .update({ tier: "enterprise" })
      .eq("id", shopB.shopId)
    expect(error).not.toBeNull()
    const row = await loadTierFields(sb, shopB.shopId)
    expect(row.tier).toBe("core") // rejected write, row unchanged
  })
})
