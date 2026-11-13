import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { INTEGRATION_WITH_SESSION, anonClient, cleanup, ownerSessionClient, seedShop, serviceClient, type Seeded } from "./_db"
import { VOICE_TEST_CALL_LIMITS, runVoiceTestCall, type VoiceTestCallDeps } from "@/lib/voice-test-call"

// Security audit run-1, finding #6. Real Postgres on the disposable stack: the atomic
// voice_test_call_claim function (concurrency, interval, hour/day ceilings, in-DB entitlement
// recheck, tenant scoping, grants) and the full guard against a real shops/usage/auth stack with
// a MOCK provider call. Nothing leaves the machine; Vapi is never contacted.
const PASSWORD = "Synthetic-password-123!"
const PHONE_DIGITS = "16175550142"
const L = VOICE_TEST_CALL_LIMITS
const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString()

describe.skipIf(!INTEGRATION_WITH_SESSION)("voice test call guard (real Postgres)", () => {
  let sb: SupabaseClient
  let a: Seeded
  let b: Seeded
  const placeCall = vi.fn(async () => ({ callId: "call_mock" }))

  const claim = (shopId: string, userId: string, last4 = "0142") =>
    sb.rpc("voice_test_call_claim", {
      p_shop_id: shopId, p_user_id: userId, p_destination_last4: last4,
      p_min_interval_seconds: L.minIntervalSeconds, p_inflight_seconds: L.inflightSeconds,
      p_hour_limit: L.perHour, p_day_limit: L.perDay,
    })
  const attempts = async (shopId: string) =>
    ((await sb.from("voice_test_call_attempts").select("*").eq("shop_id", shopId).order("created_at")).data ?? []) as Record<string, unknown>[]
  const reset = async (shopId: string) => {
    await sb.from("voice_test_call_attempts").delete().eq("shop_id", shopId)
    await sb.from("usage_events").delete().eq("shop_id", shopId)
  }
  const setShop = async (id: string, patch: Record<string, unknown>) => {
    const { error } = await sb.from("shops").update(patch).eq("id", id)
    expect(error).toBeNull()
  }
  const depsFor = (): VoiceTestCallDeps => ({
    service: sb,
    getAuthUser: async (id) => {
      const { data, error } = await sb.auth.admin.getUserById(id)
      if (error) throw error
      return data.user
    },
    placeCall,
    now: () => new Date(),
  })
  const run = (s: Seeded) => runVoiceTestCall({ userId: s.ownerId, shopId: s.shopId }, depsFor())

  beforeAll(async () => {
    sb = serviceClient()
    a = await seedShop(sb, { password: PASSWORD })
    b = await seedShop(sb, { password: PASSWORD })
    for (const s of [a, b]) {
      await setShop(s.shopId, {
        plan: "active", voice_addon: true, vapi_assistant_id: `asst_${s.shopId}`, vapi_phone_number_id: `pn_${s.shopId}`,
        gradia_number_e164: "+16175550999", vapi_stale: false,
      })
    }
    const { error } = await sb.auth.admin.updateUserById(a.ownerId, { phone: PHONE_DIGITS, phone_confirm: true })
    expect(error).toBeNull()
  })
  afterAll(async () => {
    if (!sb) return
    await reset(a.shopId); await reset(b.shopId)
    await cleanup(sb, a); await cleanup(sb, b)
  })

  describe("claim function", () => {
    it("is not callable or readable by anon or a signed-in owner (service role only)", async () => {
      const owner = await ownerSessionClient(a.email, PASSWORD)
      for (const client of [anonClient(), owner]) {
        const res = await client.rpc("voice_test_call_claim", {
          p_shop_id: a.shopId, p_user_id: a.ownerId, p_destination_last4: "0142",
          p_min_interval_seconds: 0, p_inflight_seconds: 1, p_hour_limit: 1000, p_day_limit: 1000,
        })
        expect(res.error).not.toBeNull()
        expect(res.data).toBeNull()
        const read = await client.from("voice_test_call_attempts").select("*")
        expect(read.error !== null || (read.data ?? []).length === 0).toBe(true)
        const write = await client.from("voice_test_call_attempts").insert({ shop_id: a.shopId, user_id: a.ownerId, destination_last4: "0142" })
        expect(write.error).not.toBeNull()
      }
      expect(await attempts(a.shopId)).toHaveLength(0)
    })

    it("allows one claim, then refuses an in-flight replay", async () => {
      await reset(a.shopId)
      const first = await claim(a.shopId, a.ownerId)
      expect(first.error).toBeNull()
      expect(first.data).toMatchObject({ ok: true })
      const replay = await claim(a.shopId, a.ownerId)
      expect(replay.data).toMatchObject({ ok: false, reason: "in_progress" })
      expect(await attempts(a.shopId)).toHaveLength(1)
    })

    it("lets exactly one of many truly concurrent claims through", async () => {
      await reset(a.shopId)
      const results = await Promise.all(Array.from({ length: 12 }, () => claim(a.shopId, a.ownerId)))
      const oks = results.filter((r) => (r.data as { ok: boolean } | null)?.ok === true)
      expect(oks).toHaveLength(1)
      expect(results.every((r) => r.error === null)).toBe(true)
      expect(results.filter((r) => !(r.data as { ok: boolean }).ok).every((r) => ["in_progress", "too_soon"].includes((r.data as { reason: string }).reason))).toBe(true)
      expect(await attempts(a.shopId)).toHaveLength(1)
    })

    it("enforces the minimum interval once the attempt finished, then releases it", async () => {
      await reset(a.shopId)
      await sb.from("voice_test_call_attempts").insert({ shop_id: a.shopId, user_id: a.ownerId, destination_last4: "0142", status: "dispatched", created_at: ago(L.minIntervalSeconds - 20) })
      expect((await claim(a.shopId, a.ownerId)).data).toMatchObject({ ok: false, reason: "too_soon" })
      await reset(a.shopId)
      await sb.from("voice_test_call_attempts").insert({ shop_id: a.shopId, user_id: a.ownerId, destination_last4: "0142", status: "dispatched", created_at: ago(L.minIntervalSeconds + 5) })
      expect((await claim(a.shopId, a.ownerId)).data).toMatchObject({ ok: true })
    })

    it("an abandoned in-flight claim stops blocking after the in-flight window", async () => {
      await reset(a.shopId)
      await sb.from("voice_test_call_attempts").insert({ shop_id: a.shopId, user_id: a.ownerId, destination_last4: "0142", status: "claimed", created_at: ago(L.inflightSeconds + 5) })
      expect((await claim(a.shopId, a.ownerId)).data).toMatchObject({ ok: true })
    })

    it("caps attempts per hour and per day, counting failed and aborted ones", async () => {
      await reset(a.shopId)
      const statuses = ["failed", "aborted", "dispatched"]
      await sb.from("voice_test_call_attempts").insert(
        statuses.map((status, i) => ({ shop_id: a.shopId, user_id: a.ownerId, destination_last4: "0142", status, created_at: ago(120 + i * 60) }))
      )
      expect(statuses.length).toBe(L.perHour)
      expect((await claim(a.shopId, a.ownerId)).data).toMatchObject({ ok: false, reason: "rate_limited" })

      await reset(a.shopId)
      await sb.from("voice_test_call_attempts").insert(
        Array.from({ length: L.perDay }, (_, i) => ({
          shop_id: a.shopId, user_id: a.ownerId, destination_last4: "0142", status: "dispatched",
          created_at: ago(4000 + Math.floor(i / 2) * 4000),
        }))
      )
      expect((await claim(a.shopId, a.ownerId)).data).toMatchObject({ ok: false, reason: "rate_limited" })
    })

    it("rechecks entitlement under the shop row lock", async () => {
      await reset(b.shopId)
      for (const patch of [{ plan: "free" }, { plan: "past_due" }, { voice_addon: false }]) {
        const before = { plan: "active", voice_addon: true }
        await setShop(b.shopId, patch)
        expect((await claim(b.shopId, b.ownerId)).data).toMatchObject({ ok: false, reason: "not_entitled" })
        await setShop(b.shopId, before)
      }
      expect(await attempts(b.shopId)).toHaveLength(0)
    })

    it("is tenant-scoped: another user's id never claims against a shop", async () => {
      await reset(a.shopId); await reset(b.shopId)
      expect((await claim(a.shopId, b.ownerId)).data).toMatchObject({ ok: false, reason: "not_found" })
      expect((await claim(b.shopId, a.ownerId)).data).toMatchObject({ ok: false, reason: "not_found" })
      expect(await attempts(a.shopId)).toHaveLength(0)
      expect(await attempts(b.shopId)).toHaveLength(0)
    })

    it("rejects nonsensical limits", async () => {
      const res = await sb.rpc("voice_test_call_claim", {
        p_shop_id: a.shopId, p_user_id: a.ownerId, p_destination_last4: "0142",
        p_min_interval_seconds: 0, p_inflight_seconds: 0, p_hour_limit: 1, p_day_limit: 1,
      })
      expect(res.error).not.toBeNull()
    })
  })

  describe("full guard with a mocked provider", () => {
    it("places one bounded call to the verified phone and records it", async () => {
      await reset(a.shopId); placeCall.mockClear()
      expect(await run(a)).toEqual({ ok: true })
      expect(placeCall).toHaveBeenCalledTimes(1)
      expect(placeCall).toHaveBeenCalledWith({ assistantId: `asst_${a.shopId}`, phoneNumberId: `pn_${a.shopId}`, toNumber: `+${PHONE_DIGITS}` })
      const rows = await attempts(a.shopId)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ status: "dispatched", destination_last4: "0142" })
      expect(rows[0].finished_at).toBeTruthy()
      const shop = (await sb.from("shops").select("voice_test_called_at").eq("id", a.shopId).single()).data
      expect(shop?.voice_test_called_at).toBeTruthy()
    })

    it("five concurrent requests reach the provider once", async () => {
      await reset(a.shopId); placeCall.mockClear()
      const results = await Promise.all(Array.from({ length: 5 }, () => run(a)))
      expect(results.filter((r) => r.ok)).toHaveLength(1)
      expect(placeCall).toHaveBeenCalledTimes(1)
    })

    it("never reaches the provider for a shop with no verified phone, free plan or exhausted minutes", async () => {
      placeCall.mockClear(); await reset(b.shopId)
      // b's owner has no confirmed phone.
      expect(await run(b)).toMatchObject({ ok: false, reason: "no_verified_phone" })
      // Give b a verified phone, then break entitlement / budget one at a time.
      await sb.auth.admin.updateUserById(b.ownerId, { phone: "12125550111", phone_confirm: true })
      await setShop(b.shopId, { plan: "free" })
      expect(await run(b)).toMatchObject({ ok: false, reason: "not_entitled" })
      await setShop(b.shopId, { plan: "active" })
      await sb.from("usage_events").insert({ shop_id: b.shopId, kind: "voice_minute", quantity: 60 })
      expect(await run(b)).toMatchObject({ ok: false, reason: "budget_exhausted" })
      expect(placeCall).not.toHaveBeenCalled()
      expect(await attempts(b.shopId)).toHaveLength(0)
    })

    it("a cross-tenant attempt cannot ring or consume another shop's quota", async () => {
      await reset(a.shopId); await reset(b.shopId); placeCall.mockClear()
      expect(await runVoiceTestCall({ userId: b.ownerId, shopId: a.shopId }, depsFor())).toMatchObject({ ok: false, reason: "not_found" })
      expect(placeCall).not.toHaveBeenCalled()
      expect(await attempts(a.shopId)).toHaveLength(0)
    })
  })
})
