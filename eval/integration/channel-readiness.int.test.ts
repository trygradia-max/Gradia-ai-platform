import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { loadChannelReadiness } from "@/lib/data/channel-readiness"
import { INTEGRATION, serviceClient, seedShop, cleanup, type Seeded } from "./_db"

// Readiness from real rows. Disposable stack only; no provider is called.
const ENV = { VAPI_API_KEY: "x", TWILIO_ACCOUNT_SID: "x", TWILIO_AUTH_TOKEN: "x", AURINKO_CLIENT_ID: "x", AURINKO_CLIENT_SECRET: "x", META_APP_SECRET: "x", META_WEBHOOK_VERIFY_TOKEN: "x" }

describe.skipIf(!INTEGRATION)("channel readiness from stored evidence", () => {
  let db: SupabaseClient, a: Seeded, b: Seeded, c: Seeded
  beforeAll(async () => { db = serviceClient(); a = await seedShop(db); b = await seedShop(db); c = await seedShop(db) })
  afterAll(async () => { for (const s of [a, b, c]) if (s) await cleanup(db, s) })

  it("a new shop is not set up on any channel", async () => {
    const r = await loadChannelReadiness(db, a.shopId, ENV)
    expect(r.ok && Object.values(r.channels).map(c => c.state)).toEqual(["not_set_up", "not_set_up", "not_set_up", "not_set_up"])
  })

  it("reads each channel's own gate from the shop row", async () => {
    const n = "+1555" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0")
    expect((await db.from("shops").update({
      twilio_phone_number: n, gradia_number_e164: n, a2p_status: "pending",
      vapi_assistant_id: "asst-synthetic", aurinko_access_token_enc: "synthetic-enc", aurinko_account_id: 4242,
    }).eq("id", a.shopId)).error).toBeNull()
    const r = await loadChannelReadiness(db, a.shopId, ENV)
    if (!r.ok) throw new Error(r.error)
    expect(r.channels.texting).toMatchObject({ state: "in_progress", reasons: ["registration_pending"] })
    expect(r.channels.calls).toMatchObject({ state: "action_needed", reasons: ["no_voice_number", "no_test_call", "voice_addon_inactive"] })
    expect(r.channels.email).toMatchObject({ state: "limited", reasons: ["inbound_not_subscribed"] })
  })

  it("an own number is at most ready_to_test, and never counts without the shop's own Twilio account", async () => {
    const n = "+1555" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0")
    const texting = async () => {
      const r = await loadChannelReadiness(db, c.shopId, ENV)
      if (!r.ok) throw new Error(r.error)
      return r.channels.texting
    }
    // Service role writes the flag directly here only to simulate an attested row;
    // credentials are synthetic placeholders, never decrypted.
    expect((await db.from("shops").update({ twilio_phone_number: n, byo_sms_verified: true }).eq("id", c.shopId)).error).toBeNull()
    expect(await texting()).toMatchObject({ state: "action_needed", reasons: ["not_own_account"] })
    expect((await db.from("shops").update({ twilio_account_sid_enc: "synthetic-sid-enc", twilio_auth_token_enc: "synthetic-token-enc" }).eq("id", c.shopId)).error).toBeNull()
    expect((await db.from("shops").update({ byo_sms_verified: true }).eq("id", c.shopId)).error).toBeNull()
    expect(await texting()).toMatchObject({ state: "ready_to_test", reasons: ["byo_owner_attested"] })
    expect((await db.from("shops").update({ twilio_auth_token_enc: null }).eq("id", c.shopId)).error).toBeNull()
    expect(await texting()).toMatchObject({ state: "action_needed", reasons: ["not_own_account"] })
  })

  it("counts only this shop's Meta pages", async () => {
    const page = "fictional-page-" + Math.floor(Math.random() * 1e9)
    expect((await db.from("meta_lead_page_bindings").insert({ page_id: page, shop_id: b.shopId })).error).toBeNull()
    const mine = await loadChannelReadiness(db, a.shopId, ENV), theirs = await loadChannelReadiness(db, b.shopId, ENV)
    expect(mine.ok && mine.channels.meta.state).toBe("not_set_up")
    expect(theirs.ok && theirs.channels.meta).toMatchObject({ state: "limited", reasons: ["page_subscription_unverified"] })
  })

  it("a shop that can't be read is an error, never 'not set up'", async () => {
    expect(await loadChannelReadiness(db, "00000000-0000-4000-8000-000000000000", ENV)).toEqual({ ok: false, error: "Couldn't check channel readiness. Try again." })
  })
})
