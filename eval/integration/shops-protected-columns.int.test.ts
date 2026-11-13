import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { INTEGRATION_WITH_SESSION, anonClient, cleanup, ownerSessionClient, seedShop, serviceClient, type Seeded } from "./_db"

// Security audit run-1, findings #2, #5, #8 (one root cause): a signed-in owner could write
// billing/entitlement, voice-enforcement and Gradia/Twilio identity columns on their own
// shops row through PostgREST. shops_protected_columns_guard now refuses that in the
// database. Real Postgres on the disposable stack; nothing leaves the machine.
const h = vi.hoisted(() => ({ shopId: "", ownerId: "", client: null as unknown }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "localhost:3000" }), cookies: async () => ({ set: vi.fn(), get: vi.fn() }) }))
vi.mock("@/lib/shop", () => ({
  requireUser: async () => ({ id: h.ownerId }),
  requireShop: async () => ({ id: h.shopId, name: "Fictional Detail Co" }),
  getOptionalShop: async () => ({ id: h.shopId, name: "Fictional Detail Co" }),
  ACTIVE_SHOP_COOKIE: "gradia_active_shop",
}))
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.client }))
vi.mock("@/lib/supabase/service", async () => ({ createServiceClient: (await import("./_db")).serviceClient }))
vi.mock("@/lib/stripe", async original => ({
  ...await original<typeof import("@/lib/stripe")>(),
  getConnectedAccount: vi.fn(async () => ({ charges_enabled: true, details_submitted: true })),
}))
import { saveVoiceMinutesBudget } from "@/app/actions/voice-builder"
import { disconnectStripe } from "@/app/actions/shop"
import { refreshStripeAccountStatus } from "@/app/actions/stripe-connect"
import { markVoiceStale } from "@/lib/voice-provider"

const PASSWORD = "Synthetic-password-123!"
const rnd = () => Math.random().toString(36).slice(2, 10)
const e164 = () => "+1555" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0")
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString()

/** Every protected column: the value the server writes, and a different value an owner might forge. */
type Case = { col: string; server: () => unknown; forged: () => unknown; cleared?: unknown }
const CASES: Case[] = [
  { col: "plan", server: () => "active", forged: () => "past_due", cleared: undefined },
  { col: "voice_addon", server: () => true, forged: () => false },
  { col: "voice_addon_ended_at", server: () => iso(-1000), forged: () => iso(9999), cleared: null },
  { col: "stripe_subscription_id", server: () => "sub_" + rnd(), forged: () => "sub_" + rnd(), cleared: null },
  { col: "credit_period_start", server: () => iso(-86_400_000), forged: () => iso(86_400_000) },
  { col: "stripe_account_id", server: () => "acct_" + rnd(), forged: () => "acct_" + rnd(), cleared: null },
  { col: "stripe_charges_enabled", server: () => true, forged: () => false },
  { col: "voice_minutes_budget", server: () => 10, forged: () => 20, cleared: null },
  { col: "gradia_number_e164", server: () => e164(), forged: () => e164(), cleared: null },
  { col: "gradia_number_sid", server: () => "PN" + rnd(), forged: () => "PN" + rnd(), cleared: null },
  { col: "twilio_subaccount_sid", server: () => "AC" + rnd(), forged: () => "AC" + rnd(), cleared: null },
  { col: "twilio_subaccount_token_enc", server: () => "enc:" + rnd(), forged: () => "enc:" + rnd(), cleared: null },
  { col: "number_purchase_claim", server: () => randomUUID(), forged: () => randomUUID(), cleared: null },
  { col: "number_purchase_claimed_at", server: () => iso(-1000), forged: () => iso(5000), cleared: null },
]
/** Server-written columns the owner may not even set from their default (vapi_stale is special-cased below). */
const FORGE_FROM_DEFAULT: Record<string, unknown> = {
  plan: "active", voice_addon: true, voice_addon_ended_at: iso(), stripe_subscription_id: "sub_forged",
  credit_period_start: iso(86_400_000), stripe_account_id: "acct_forged", stripe_charges_enabled: true,
  voice_minutes_budget: 5, gradia_number_e164: "+15550000001", gradia_number_sid: "PNforged",
  twilio_subaccount_sid: "ACforged", twilio_subaccount_token_enc: "enc:forged",
  number_purchase_claim: "00000000-0000-4000-8000-000000000001", number_purchase_claimed_at: iso(),
}

describe.skipIf(!INTEGRATION_WITH_SESSION)("shops protected columns are server-written", () => {
  let db: SupabaseClient
  let a: Seeded, b: Seeded
  let ownerA: SupabaseClient, ownerB: SupabaseClient
  const extra: Seeded[] = []

  const row = async (id = a.shopId) => (await db.from("shops").select("*").eq("id", id).single()).data as Record<string, unknown>
  const serverSet = async (patch: Record<string, unknown>, id = a.shopId) =>
    expect((await db.from("shops").update(patch).eq("id", id)).error).toBeNull()
  /** Reset every protected column on shop A to its default, as service_role. */
  const resetA = () => serverSet({
    plan: "free", voice_addon: false, voice_addon_ended_at: null, stripe_subscription_id: null,
    stripe_account_id: null, stripe_charges_enabled: false, vapi_stale: false, voice_minutes_budget: null,
    gradia_number_e164: null, gradia_number_sid: null, twilio_subaccount_sid: null,
    twilio_subaccount_token_enc: null, number_purchase_claim: null, number_purchase_claimed_at: null,
    credit_period_start: iso(-3_600_000),
  })
  const refused = (error: { code?: string; details?: string; hint?: string } | null, col?: string) => {
    expect(error).not.toBeNull()
    expect(error?.code).toBe("42501")
    expect(error?.details).toBe("server_written")
    if (col) expect(error?.hint).toBe(col)
  }

  beforeAll(async () => {
    db = serviceClient()
    a = await seedShop(db, { password: PASSWORD })
    b = await seedShop(db, { password: PASSWORD })
    ownerA = await ownerSessionClient(a.email, PASSWORD)
    ownerB = await ownerSessionClient(b.email, PASSWORD)
    h.shopId = a.shopId; h.ownerId = a.ownerId; h.client = ownerA
  })
  afterAll(async () => {
    for (const s of [...extra, a, b]) if (s) await cleanup(db, s)
  })

  describe("UPDATE: authenticated owner is refused for every protected column", () => {
    for (const c of CASES) {
      it(`${c.col}: forging, changing and clearing are all refused and the row is unchanged`, async () => {
        await resetA()
        // 1. Forge from the default.
        const fromDefault = FORGE_FROM_DEFAULT[c.col]
        let before = await row()
        refused((await ownerA.from("shops").update({ [c.col]: fromDefault }).eq("id", a.shopId)).error, c.col)
        expect((await row())[c.col]).toEqual(before[c.col])
        // 2. Trusted server writes a real value; the owner cannot change it...
        await serverSet({ [c.col]: c.server() })
        before = await row()
        refused((await ownerA.from("shops").update({ [c.col]: c.forged() }).eq("id", a.shopId)).error, c.col)
        expect((await row())[c.col]).toEqual(before[c.col])
        // 3. ...or clear it.
        if (c.cleared !== undefined) {
          refused((await ownerA.from("shops").update({ [c.col]: c.cleared }).eq("id", a.shopId)).error, c.col)
          expect((await row())[c.col]).toEqual(before[c.col])
        }
        // 4. Re-sending the identical stored value is not a change.
        expect((await ownerA.from("shops").update({ [c.col]: before[c.col] }).eq("id", a.shopId)).error).toBeNull()
      })
    }

    it("a safe field cannot carry a protected change with it: the whole PATCH is refused atomically", async () => {
      await resetA()
      const before = await row()
      const res = await ownerA.from("shops").update({ name: "Renamed by forged patch", plan: "active", voice_addon: true }).eq("id", a.shopId)
      refused(res.error)
      const after = await row()
      expect(after.name).toBe(before.name)
      expect(after.plan).toBe("free")
      expect(after.voice_addon).toBe(false)
    })

    it("an upsert on the existing id cannot launder a protected value in", async () => {
      await resetA()
      const res = await ownerA.from("shops").upsert({ id: a.shopId, name: "Upserted", owner_id: a.ownerId, plan: "active", credit_period_start: iso(9999) }, { onConflict: "id" })
      refused(res.error)
      const after = await row()
      expect(after.plan).toBe("free")
      expect(after.name).not.toBe("Upserted")
    })

    it("the texting-number guard from the earlier migration is untouched", async () => {
      const res = await ownerA.from("shops").update({ twilio_phone_number: e164() }).eq("id", a.shopId)
      expect(res.error?.code).toBe("42501")
      expect(res.error?.details).toBe("server_written")
    })
  })

  describe("vapi_stale: only the owner-side CLEAR is refused", () => {
    it("owner may raise it (markVoiceStale from menu, knowledge and hours edits) and re-send true", async () => {
      await resetA()
      await serverSet({ vapi_assistant_id: "asst_" + rnd() })
      h.client = ownerA
      await markVoiceStale(ownerA, a.shopId)
      expect((await row()).vapi_stale).toBe(true)
      expect((await ownerA.from("shops").update({ vapi_stale: true }).eq("id", a.shopId)).error).toBeNull()
      expect((await row()).vapi_stale).toBe(true)
    })

    it("owner cannot clear it, alone or inside a larger PATCH; the row stays stale", async () => {
      await serverSet({ vapi_stale: true })
      refused((await ownerA.from("shops").update({ vapi_stale: false }).eq("id", a.shopId)).error, "vapi_stale")
      refused((await ownerA.from("shops").update({ vapi_stale: false, voice_live: true }).eq("id", a.shopId)).error, "vapi_stale")
      const after = await row()
      expect(after.vapi_stale).toBe(true)
      expect(after.voice_live).toBe(false)
    })

    it("owner may leave a non-stale flag false and raise it, but the clear after is refused", async () => {
      await serverSet({ vapi_stale: false })
      expect((await ownerA.from("shops").update({ vapi_stale: false }).eq("id", a.shopId)).error).toBeNull()
      expect((await ownerA.from("shops").update({ vapi_stale: true }).eq("id", a.shopId)).error).toBeNull()
      refused((await ownerA.from("shops").update({ vapi_stale: false }).eq("id", a.shopId)).error, "vapi_stale")
    })

    it("service role clears it (the voice sync does exactly this)", async () => {
      await serverSet({ vapi_stale: true })
      await serverSet({ vapi_stale: false })
      expect((await row()).vapi_stale).toBe(false)
    })
  })

  describe("INSERT: a new shop cannot be born entitled", () => {
    it("an owner creates a shop with only safe fields and gets the defaults", async () => {
      const user = await seedShop(db, { password: PASSWORD }); extra.push(user)
      const session = await ownerSessionClient(user.email, PASSWORD)
      const ins = await session.from("shops").insert({ name: "Second Location", owner_id: user.ownerId, location: "Fictional City", phone: "+15551230000", settings: { onboarding_done: false } }).select("*").single()
      expect(ins.error).toBeNull()
      expect(ins.data).toMatchObject({
        plan: "free", voice_addon: false, voice_addon_ended_at: null, stripe_subscription_id: null, stripe_account_id: null,
        stripe_charges_enabled: false, vapi_stale: false, voice_minutes_budget: null, gradia_number_e164: null,
        gradia_number_sid: null, twilio_subaccount_sid: null, twilio_subaccount_token_enc: null,
        number_purchase_claim: null, number_purchase_claimed_at: null, credit_limit: 1000,
      })
      await db.from("shops").delete().eq("id", ins.data!.id)
    })

    const insertForged: Record<string, unknown> = { ...FORGE_FROM_DEFAULT, vapi_stale: true }
    for (const [col, value] of Object.entries(insertForged)) {
      it(`${col}: a non-default value on INSERT is refused and no row is created`, async () => {
        const user = await seedShop(db, { password: PASSWORD }); extra.push(user)
        const session = await ownerSessionClient(user.email, PASSWORD)
        const name = "Forged " + col + " " + rnd()
        const res = await session.from("shops").insert({ name, owner_id: user.ownerId, [col]: value })
        refused(res.error, col)
        expect((await db.from("shops").select("id").eq("name", name)).data).toEqual([])
      })
    }

    it("plan explicitly set to the default is allowed (it is not a forgery)", async () => {
      const user = await seedShop(db, { password: PASSWORD }); extra.push(user)
      const session = await ownerSessionClient(user.email, PASSWORD)
      const res = await session.from("shops").insert({ name: "Explicit free", owner_id: user.ownerId, plan: "free", voice_addon: false }).select("id").single()
      expect(res.error).toBeNull()
      await db.from("shops").delete().eq("id", res.data!.id)
    })

    it("an owner cannot insert a shop for somebody else (tenant row security still applies)", async () => {
      const res = await ownerA.from("shops").insert({ name: "Not mine", owner_id: b.ownerId })
      expect(res.error).not.toBeNull()
      expect((await db.from("shops").select("id").eq("name", "Not mine")).data).toEqual([])
    })
  })

  describe("legitimate owner-editable settings still work", () => {
    it("name, contact fields, settings, voice config, voice_live and credit_limit save through the owner session", async () => {
      await resetA()
      const settings = { onboarding_done: true, business_kind: "detailing", custom: rnd() }
      const res = await ownerA.from("shops").update({
        name: "Renamed Shop", location: "New City", phone: "+15559998888", settings,
        voice_config: { greeting: "Hello", tone: "warm" }, voice_live: true, credit_limit: 4321,
        timezone: "America/Chicago", quiet_hours_start: 21, quiet_hours_end: 8,
      }).eq("id", a.shopId).select("*").single()
      expect(res.error).toBeNull()
      expect(res.data).toMatchObject({
        name: "Renamed Shop", location: "New City", phone: "+15559998888", settings, voice_live: true, credit_limit: 4321,
        timezone: "America/Chicago", quiet_hours_start: 21, quiet_hours_end: 8,
      })
      // Protected columns untouched by a normal save.
      expect(res.data).toMatchObject({ plan: "free", voice_addon: false, stripe_account_id: null, vapi_stale: false })
      await serverSet({ voice_live: false })
    })
  })

  describe("service role (Stripe, billing, voice, provisioning) still writes every protected column", () => {
    for (const c of CASES) {
      it(`${c.col}: set, change and clear as service_role`, async () => {
        await resetA()
        const v1 = c.server()
        await serverSet({ [c.col]: v1 })
        expect((await row())[c.col]).toEqual(c.col.endsWith("_at") || c.col === "credit_period_start" ? expect.any(String) : v1)
        if (c.cleared !== undefined) {
          await serverSet({ [c.col]: c.cleared })
          expect((await row())[c.col]).toBeNull()
        }
      })
    }

    it("a service-role INSERT can create a shop that is already on a paid plan (provisioning/seed path)", async () => {
      const user = await seedShop(db, { password: PASSWORD }); extra.push(user)
      const ins = await db.from("shops").insert({ name: "Service created", owner_id: user.ownerId, plan: "active", voice_addon: true, stripe_account_id: "acct_" + rnd() }).select("*").single()
      expect(ins.error).toBeNull()
      expect(ins.data).toMatchObject({ plan: "active", voice_addon: true })
      await db.from("shops").delete().eq("id", ins.data!.id)
    })

    it("the real owner actions that touch these columns work: budget, disconnect Stripe, refresh Stripe", async () => {
      await resetA()
      h.client = ownerA
      await serverSet({ stripe_account_id: "acct_" + rnd(), stripe_charges_enabled: false })

      expect(await saveVoiceMinutesBudget(45)).toEqual({ ok: true })
      expect((await row()).voice_minutes_budget).toBe(45)
      expect(await saveVoiceMinutesBudget(null)).toEqual({ ok: true })
      expect((await row()).voice_minutes_budget).toBeNull()

      expect(await refreshStripeAccountStatus()).toMatchObject({ ok: true, chargesEnabled: true })
      expect((await row()).stripe_charges_enabled).toBe(true)

      expect(await disconnectStripe()).toMatchObject({ ok: true })
      expect(await row()).toMatchObject({ stripe_account_id: null, stripe_charges_enabled: false })
    })
  })

  describe("tenant isolation is intact", () => {
    it("owner A cannot read or change owner B's shop, protected or not, and B's row is unchanged", async () => {
      await serverSet({ plan: "active", name: "Shop B original" }, b.shopId)
      const before = await row(b.shopId)
      expect((await ownerA.from("shops").select("*").eq("id", b.shopId)).data).toEqual([])
      for (const patch of [{ name: "Hijacked" }, { plan: "past_due" }, { vapi_stale: false }, { gradia_number_e164: e164() }]) {
        const res = await ownerA.from("shops").update(patch).eq("id", b.shopId).select("id")
        // Row security hides the row: either filtered to zero rows or refused; never applied.
        if (!res.error) expect(res.data).toEqual([])
      }
      expect(await row(b.shopId)).toEqual(before)
      // The mirror image: B's session does not reach A.
      const res = await ownerB.from("shops").update({ name: "B hijacks A" }).eq("id", a.shopId).select("id")
      if (!res.error) expect(res.data).toEqual([])
      expect((await row()).name).not.toBe("B hijacks A")
    })

    it("an unauthenticated (anon) client reads and writes nothing on shops", async () => {
      const anon = anonClient()
      expect((await anon.from("shops").select("id").eq("id", a.shopId)).data ?? []).toEqual([])
      const before = await row()
      const upd = await anon.from("shops").update({ plan: "active", name: "anon" }).eq("id", a.shopId).select("id")
      if (!upd.error) expect(upd.data).toEqual([])
      expect((await anon.from("shops").insert({ name: "anon shop", owner_id: a.ownerId, plan: "active" })).error).not.toBeNull()
      expect(await row()).toEqual(before)
    })
  })
})
