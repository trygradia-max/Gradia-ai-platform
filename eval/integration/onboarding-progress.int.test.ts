import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { INTEGRATION_WITH_SESSION, cleanup, ownerSessionClient, seedShop, serviceClient, type Seeded } from "./_db"

const h = vi.hoisted(() => ({ shopId: "", client: null as unknown }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/lib/shop", () => ({ requireUser: async () => ({ id: "owner" }), requireShop: async () => ({ id: h.shopId }) }))
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.client }))
import { completeOnboarding, saveOnboardingProgress } from "@/app/actions/onboarding"

describe.skipIf(!INTEGRATION_WITH_SESSION)("onboarding progress preserves concurrent business settings", () => {
  let db: SupabaseClient, owner: SupabaseClient, fixture: Seeded
  beforeAll(async () => {
    db = serviceClient(); fixture = await seedShop(db, { password: "Synthetic-password-123!" })
    owner = await ownerSessionClient(fixture.email, "Synthetic-password-123!")
    h.shopId = fixture.shopId; h.client = owner
  })
  afterAll(async () => { if (fixture) await cleanup(db, fixture) })
  it("saves and resumes steps without losing unrelated settings", async () => {
    expect((await db.from("shops").update({ settings: { onboarding_done: false, business_kind: "general", custom_rule: "retain" } }).eq("id", fixture.shopId)).error).toBeNull()
    expect(await saveOnboardingProgress({ step: 3, numberSkipped: true })).toEqual({ ok: true })
    expect((await owner.from("shops").select("settings").eq("id", fixture.shopId).single()).data?.settings).toMatchObject({ onboarding_step: 3, onboarding_number_skipped: true, business_kind: "general", custom_rule: "retain" })
    expect(await completeOnboarding()).toEqual({ ok: true })
  })
  it("refuses a stale save instead of overwriting a concurrent rule change", async () => {
    h.client = { from: (table: string) => {
      const query = owner.from(table)
      return { select: (columns: string) => ({ eq: (key: string, value: string) => ({ single: async () => {
        const read = await query.select(columns).eq(key, value).single()
        expect((await db.from("shops").update({ settings: { ...((read.data as unknown as { settings: Record<string, unknown> } | null)?.settings ?? {}), custom_rule: "newer rule" } }).eq("id", fixture.shopId)).error).toBeNull()
        return read
      } }) }), update: (patch: Record<string, unknown>) => owner.from(table).update(patch) }
    } }
    expect(await saveOnboardingProgress({ step: 2 })).toMatchObject({ ok: false, error: expect.stringContaining("Settings changed") })
    expect((await owner.from("shops").select("settings").eq("id", fixture.shopId).single()).data?.settings.custom_rule).toBe("newer rule")
    h.client = owner
  })
})
