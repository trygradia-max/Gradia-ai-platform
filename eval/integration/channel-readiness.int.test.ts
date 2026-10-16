import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { loadChannelReadiness } from "@/lib/data/channel-readiness"
import { INTEGRATION, serviceClient, seedShop, cleanup, type Seeded } from "./_db"

// Readiness from real rows. Disposable stack only; no provider is called.
const ENV = { VAPI_API_KEY: "x", TWILIO_ACCOUNT_SID: "x", TWILIO_AUTH_TOKEN: "x", AURINKO_CLIENT_ID: "x", AURINKO_CLIENT_SECRET: "x", META_APP_SECRET: "x", META_WEBHOOK_VERIFY_TOKEN: "x" }

describe.skipIf(!INTEGRATION)("channel readiness from stored evidence", () => {
  let db: SupabaseClient, a: Seeded, b: Seeded
  beforeAll(async () => { db = serviceClient(); a = await seedShop(db); b = await seedShop(db) })
  afterAll(async () => { for (const s of [a, b]) if (s) await cleanup(db, s) })

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
