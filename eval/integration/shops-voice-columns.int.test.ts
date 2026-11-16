import { randomBytes } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { INTEGRATION_WITH_SESSION, anonClient, cleanup, ownerSessionClient, seedShop, serviceClient, type Seeded } from "./_db"

// Security audit run-1, residual of finding #6. A signed-in owner could write the voice provider
// identity and launch-gate columns of their own shops row through PostgREST. They are now
// server-written (shops_protected_columns_guard). Real Postgres on the disposable stack; the Vapi
// and Twilio seams are mocks, nothing leaves the machine.
process.env.ENCRYPTION_KEY = randomBytes(32).toString("hex")

const h = vi.hoisted(() => ({
  vapi: {
    seq: 0,
    createAssistant: null as unknown as ReturnType<typeof vi.fn>,
    updateAssistant: null as unknown as ReturnType<typeof vi.fn>,
    importTwilioNumber: null as unknown as ReturnType<typeof vi.fn>,
  },
}))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/lib/vapi", async original => {
  const real = await original<typeof import("@/lib/vapi")>()
  h.vapi.createAssistant = vi.fn(async () => ({ id: `asst_mock_${++h.vapi.seq}` }))
  h.vapi.updateAssistant = vi.fn(async (id: string) => ({ id }))
  h.vapi.importTwilioNumber = vi.fn(async () => ({ phoneNumberId: `pn_mock_${++h.vapi.seq}` }))
  return { ...real, createAssistant: h.vapi.createAssistant, updateAssistant: h.vapi.updateAssistant, importTwilioNumber: h.vapi.importTwilioNumber }
})
vi.mock("@/lib/twilio", async original => ({
  ...await original<typeof import("@/lib/twilio")>(),
  getIncomingPhoneNumberConfig: vi.fn(async () => ({ smsUrl: "https://example.test/api/twilio/sms" })),
  setNumberSmsWebhook: vi.fn(async () => undefined),
}))
import { setVoiceLiveForOwner } from "@/lib/voice-live"
import { attachVoiceNumber, markVoiceStale, startVoiceTestCall, syncVoiceAssistant } from "@/lib/voice-provider"
import { encryptSecret } from "@/lib/crypto"
import type { ShopRow } from "@/lib/types/database"

const PASSWORD = "Synthetic-password-123!"
const rnd = () => Math.random().toString(36).slice(2, 10)
const VOICE_COLS = ["vapi_assistant_id", "vapi_phone_number_id", "voice_live", "voice_test_called_at", "vapi_server_secret_enc"] as const
const GATE_READY = { voice_addon: true, vapi_assistant_id: "", vapi_phone_number_id: "", voice_test_called_at: "" }

describe.skipIf(!INTEGRATION_WITH_SESSION)("voice identity and launch-gate columns are server-written", () => {
  let db: SupabaseClient
  let a: Seeded, b: Seeded
  let ownerA: SupabaseClient
  const extra: Seeded[] = []

  const row = async (id = a.shopId) => (await db.from("shops").select("*").eq("id", id).single()).data as Record<string, unknown>
  const voiceState = async (id = a.shopId) => {
    const r = await row(id)
    return Object.fromEntries(VOICE_COLS.map(c => [c, r[c]]))
  }
  const serverSet = async (patch: Record<string, unknown>, id = a.shopId) =>
    expect((await db.from("shops").update(patch).eq("id", id)).error).toBeNull()
  const resetAll = async () => {
    for (const id of [a.shopId, b.shopId]) {
      await serverSet({ vapi_assistant_id: null, vapi_phone_number_id: null, voice_live: false, voice_test_called_at: null, vapi_server_secret_enc: null, vapi_stale: false, voice_addon: false }, id)
    }
  }
  const refused = (error: { code?: string; details?: string; hint?: string } | null, col?: string) => {
    expect(error).not.toBeNull()
    expect(error?.code).toBe("42501")
    expect(error?.details).toBe("server_written")
    if (col) expect(error?.hint).toBe(col)
  }
  const gateReady = (tag = rnd()) => ({ ...GATE_READY, vapi_assistant_id: `asst_${tag}`, vapi_phone_number_id: `pn_${tag}`, voice_test_called_at: new Date().toISOString() })

  beforeAll(async () => {
    db = serviceClient()
    a = await seedShop(db, { password: PASSWORD })
    b = await seedShop(db, { password: PASSWORD })
    ownerA = await ownerSessionClient(a.email, PASSWORD)
  })
  afterAll(async () => {
    for (const s of [...extra, a, b]) if (s) await cleanup(db, s)
  })

  describe("the reproduced primitive: an owner JWT PATCH/INSERT through PostgREST", () => {
    it("UPDATE of all five columns at once is refused atomically and the row is unchanged", async () => {
      await resetAll()
      const before = await row()
      const res = await ownerA.from("shops").update({
        name: "Renamed in the same forged patch", vapi_assistant_id: "asst_FOREIGN", vapi_phone_number_id: "pn_FOREIGN",
        voice_live: true, voice_test_called_at: new Date().toISOString(), vapi_server_secret_enc: "enc:chosen-by-owner",
      }).eq("id", a.shopId).select("id")
      refused(res.error)
      const after = await row()
      expect(after).toEqual(before)
      expect(await voiceState()).toEqual({ vapi_assistant_id: null, vapi_phone_number_id: null, voice_live: false, voice_test_called_at: null, vapi_server_secret_enc: null })
    })

    for (const col of VOICE_COLS) {
      it(`${col}: forging, changing and clearing are each refused with the column as the hint`, async () => {
        await resetAll()
        const forged: Record<string, unknown> = {
          vapi_assistant_id: "asst_FORGED", vapi_phone_number_id: "pn_FORGED", voice_live: true,
          voice_test_called_at: new Date().toISOString(), vapi_server_secret_enc: "enc:forged",
        }
        // Forge from the default.
        refused((await ownerA.from("shops").update({ [col]: forged[col] }).eq("id", a.shopId)).error, col)
        expect((await row())[col]).toEqual(col === "voice_live" ? false : null)
        // Trusted server writes a real value; the owner can neither change nor clear it.
        const real: Record<string, unknown> = {
          vapi_assistant_id: "asst_" + rnd(), vapi_phone_number_id: "pn_" + rnd(), voice_live: true,
          voice_test_called_at: new Date(Date.now() - 5000).toISOString(), vapi_server_secret_enc: "enc:" + rnd(),
        }
        await serverSet({ [col]: real[col] })
        const stored = (await row())[col]
        const other: Record<string, unknown> = { ...forged, vapi_assistant_id: "asst_OTHER", voice_live: false }
        refused((await ownerA.from("shops").update({ [col]: other[col] }).eq("id", a.shopId)).error, col)
        expect((await row())[col]).toEqual(stored)
        if (col !== "voice_live") {
          refused((await ownerA.from("shops").update({ [col]: null }).eq("id", a.shopId)).error, col)
          expect((await row())[col]).toEqual(stored)
        }
        // Re-sending the identical stored value is not a change.
        expect((await ownerA.from("shops").update({ [col]: stored }).eq("id", a.shopId)).error).toBeNull()
      })
    }

    it("an owner cannot pause voice_live directly either (pausing goes through the server action)", async () => {
      await resetAll()
      await serverSet({ voice_live: true })
      refused((await ownerA.from("shops").update({ voice_live: false }).eq("id", a.shopId)).error, "voice_live")
      expect((await row()).voice_live).toBe(true)
    })

    it("an upsert on the existing id cannot launder a voice column in", async () => {
      await resetAll()
      const res = await ownerA.from("shops").upsert({ id: a.shopId, name: "Upserted", owner_id: a.ownerId, voice_live: true, vapi_assistant_id: "asst_UP" }, { onConflict: "id" })
      refused(res.error)
      const after = await row()
      expect(after.voice_live).toBe(false)
      expect(after.vapi_assistant_id).toBeNull()
      expect(after.name).not.toBe("Upserted")
    })

    it("the earlier guards are untouched: plan, number and stale-flag rules still hold", async () => {
      await resetAll()
      refused((await ownerA.from("shops").update({ plan: "active" }).eq("id", a.shopId)).error, "plan")
      refused((await ownerA.from("shops").update({ twilio_phone_number: "+15550001111" }).eq("id", a.shopId)).error)
      await serverSet({ vapi_stale: true })
      refused((await ownerA.from("shops").update({ vapi_stale: false }).eq("id", a.shopId)).error, "vapi_stale")
      await serverSet({ vapi_stale: false })
    })
  })

  describe("cross-tenant denial", () => {
    it("owner A's JWT cannot read-modify or write any voice column of shop B", async () => {
      await resetAll()
      await serverSet({ vapi_assistant_id: "asst_B_REAL", voice_live: true }, b.shopId)
      const before = await voiceState(b.shopId)
      const res = await ownerA.from("shops").update({ voice_live: false, vapi_assistant_id: "asst_HIJACK", vapi_server_secret_enc: "enc:x" }).eq("id", b.shopId).select("id")
      // Row security hides B's row from A: no rows touched (and the guard would refuse them anyway).
      expect(res.error ? res.error.code : res.data?.length).toSatisfy((v: unknown) => v === 0 || v === "42501")
      expect(await voiceState(b.shopId)).toEqual(before)
    })

    it("an owner cannot INSERT a second shop for another owner carrying a voice identity", async () => {
      const res = await ownerA.from("shops").insert({ name: "Not mine " + rnd(), owner_id: b.ownerId, vapi_assistant_id: "asst_NM", voice_live: true })
      expect(res.error).not.toBeNull()
    })

    it("the unique index still stops a second shop holding a provider-assigned assistant id", async () => {
      await resetAll()
      await serverSet({ vapi_assistant_id: "asst_shared_" + a.shopId }, a.shopId)
      const dup = await db.from("shops").update({ vapi_assistant_id: "asst_shared_" + a.shopId }).eq("id", b.shopId)
      expect(dup.error?.code).toBe("23505")
      expect((await row(b.shopId)).vapi_assistant_id).toBeNull()
    })

    it("anon cannot write any voice column", async () => {
      const res = await anonClient().from("shops").update({ voice_live: true }).eq("id", a.shopId).select("id")
      expect(res.data ?? []).toEqual([])
      expect((await row()).voice_live).toBe(false)
    })
  })

  describe("INSERT: a new shop cannot be born live or holding a provider identity", () => {
    it("an owner creating a shop with only safe fields gets every voice default", async () => {
      const user = await seedShop(db, { password: PASSWORD }); extra.push(user)
      const session = await ownerSessionClient(user.email, PASSWORD)
      const ins = await session.from("shops").insert({ name: "Second Location", owner_id: user.ownerId, location: "Fictional City", settings: { onboarding_done: false } }).select("*").single()
      expect(ins.error).toBeNull()
      expect(ins.data).toMatchObject({ vapi_assistant_id: null, vapi_phone_number_id: null, voice_live: false, voice_test_called_at: null, vapi_server_secret_enc: null })
      await db.from("shops").delete().eq("id", ins.data!.id)
    })

    const forgedOnInsert: Record<string, unknown> = {
      vapi_assistant_id: "asst_BORN", vapi_phone_number_id: "pn_BORN", voice_live: true,
      voice_test_called_at: new Date().toISOString(), vapi_server_secret_enc: "enc:born",
    }
    for (const [col, value] of Object.entries(forgedOnInsert)) {
      it(`${col}: a non-default value on INSERT is refused and no row is created`, async () => {
        const user = await seedShop(db, { password: PASSWORD }); extra.push(user)
        const session = await ownerSessionClient(user.email, PASSWORD)
        const name = "Forged " + col + " " + rnd()
        refused((await session.from("shops").insert({ name, owner_id: user.ownerId, [col]: value })).error, col)
        expect((await db.from("shops").select("id").eq("name", name)).data).toEqual([])
      })
    }

    it("explicit defaults on INSERT (voice_live=false, nulls) are allowed: they are not a forgery", async () => {
      const user = await seedShop(db, { password: PASSWORD }); extra.push(user)
      const session = await ownerSessionClient(user.email, PASSWORD)
      const res = await session.from("shops").insert({ name: "Explicit defaults", owner_id: user.ownerId, voice_live: false, vapi_assistant_id: null, vapi_phone_number_id: null, voice_test_called_at: null, vapi_server_secret_enc: null }).select("id").single()
      expect(res.error).toBeNull()
      await db.from("shops").delete().eq("id", res.data!.id)
    })

    it("a service-role INSERT may create a shop with voice identity (provisioning/seed path)", async () => {
      const user = await seedShop(db, { password: PASSWORD }); extra.push(user)
      const res = await db.from("shops").insert({ name: "Provisioned", owner_id: user.ownerId, voice_live: true, vapi_assistant_id: "asst_prov_" + rnd() }).select("voice_live,vapi_assistant_id").single()
      expect(res.error).toBeNull()
      expect(res.data?.voice_live).toBe(true)
    })
  })

  describe("legitimate owner settings still save through the owner session", () => {
    it("voice_config, name, settings and credit_limit save; voice columns are untouched by that save", async () => {
      await resetAll()
      const res = await ownerA.from("shops").update({
        name: "Renamed Shop", voice_config: { greeting: "Hello", tone: "warm" }, credit_limit: 4321, settings: { onboarding_done: true },
      }).eq("id", a.shopId).select("*").single()
      expect(res.error).toBeNull()
      expect(res.data).toMatchObject({ name: "Renamed Shop", voice_config: { greeting: "Hello", tone: "warm" }, credit_limit: 4321 })
      expect(await voiceState()).toEqual({ vapi_assistant_id: null, vapi_phone_number_id: null, voice_live: false, voice_test_called_at: null, vapi_server_secret_enc: null })
    })

    it("markVoiceStale still works from the owner session (menu, knowledge and hours edits raise it)", async () => {
      await resetAll()
      await serverSet({ vapi_assistant_id: "asst_" + rnd() })
      await markVoiceStale(ownerA, a.shopId)
      expect((await row()).vapi_stale).toBe(true)
    })
  })

  describe("setVoiceLiveForOwner: the session-derived, owner-reverified server seam", () => {
    const go = (live: boolean, who: { userId: string; shopId: string } = { userId: a.ownerId, shopId: a.shopId }) =>
      setVoiceLiveForOwner({ service: db, ...who, live })

    it("refuses to go live until the add-on, assistant, number and test call exist; nothing is written", async () => {
      await resetAll()
      const addon = await go(true)
      expect(addon).toMatchObject({ ok: false })
      expect((addon as { error: string }).error).toMatch(/add-on/)
      await serverSet({ voice_addon: true })
      const gate = await go(true)
      expect((gate as { error: string }).error).toMatch(/connect your business number.*save the receptionist.*do a test call/)
      expect((await row()).voice_live).toBe(false)
      await serverSet({ vapi_assistant_id: "asst_" + rnd(), vapi_phone_number_id: "pn_" + rnd() })
      expect((await go(true) as { error: string }).error).toMatch(/do a test call/)
      expect((await row()).voice_live).toBe(false)
    })

    it("goes live once the gate is met, and pauses on request", async () => {
      await resetAll()
      await serverSet(gateReady())
      expect(await go(true)).toEqual({ ok: true })
      expect((await row()).voice_live).toBe(true)
      expect(await go(false)).toEqual({ ok: true })
      expect((await row()).voice_live).toBe(false)
    })

    it("cross-tenant: owner A's user id with shop B's id reads no row, writes nothing, and says finish onboarding", async () => {
      await resetAll()
      await serverSet(gateReady(), b.shopId)
      const res = await go(true, { userId: a.ownerId, shopId: b.shopId })
      expect(res).toEqual({ ok: false, error: "Finish onboarding first." })
      expect((await row(b.shopId)).voice_live).toBe(false)
      const pause = await go(false, { userId: a.ownerId, shopId: b.shopId })
      expect(pause).toEqual({ ok: false, error: "Finish onboarding first." })
    })

    it("cross-tenant pause cannot switch another shop off", async () => {
      await resetAll()
      await serverSet({ ...gateReady(), voice_live: true }, b.shopId)
      await go(false, { userId: a.ownerId, shopId: b.shopId })
      expect((await row(b.shopId)).voice_live).toBe(true)
    })

    it("the gate is also inside the UPDATE: a shop whose add-on ends between read and write does not go live", async () => {
      await resetAll()
      await serverSet(gateReady())
      // Revoke the add-on right after the seam's ownership read (maybeSingle) resolves, before its conditional write.
      type Fn = (...args: unknown[]) => unknown
      const hook = (target: object): object => new Proxy(target, {
        get(t, prop, receiver) {
          const value = Reflect.get(t, prop, receiver)
          if (typeof value !== "function") return value
          if (prop === "then") return (value as Fn).bind(t)
          if (prop === "maybeSingle") {
            return async () => {
              const out = await (value as Fn).call(t)
              await db.from("shops").update({ voice_addon: false }).eq("id", a.shopId)
              return out
            }
          }
          return (...args: unknown[]) => {
            const out = (value as Fn).apply(t, args)
            return out && typeof out === "object" ? hook(out) : out
          }
        },
      })
      const patched = { from: (table: string) => hook(db.from(table)) } as unknown as SupabaseClient
      const res = await setVoiceLiveForOwner({ service: patched, userId: a.ownerId, shopId: a.shopId, live: true })
      expect(res.ok).toBe(false)
      expect((await row()).voice_live).toBe(false)
      expect((await row()).voice_addon).toBe(false)
    })
  })

  describe("trusted service writers still write every voice column", () => {
    it("syncVoiceAssistant creates the assistant, persists its id and a per-shop encrypted secret, clears stale", async () => {
      await resetAll()
      await serverSet({ vapi_stale: true, voice_addon: true })
      const shop = (await row()) as unknown as ShopRow
      const res = await syncVoiceAssistant({ supabase: db, shop, origin: "https://example.test" })
      expect(res.ok).toBe(true)
      const after = await row()
      expect(after.vapi_assistant_id).toMatch(/^asst_mock_/)
      expect(typeof after.vapi_server_secret_enc).toBe("string")
      expect(after.vapi_server_secret_enc).not.toBe("")
      expect(after.vapi_stale).toBe(false)
    })

    it("a second sync PATCHes the stored assistant (the id the server stored is the one it updates)", async () => {
      const before = await row()
      const res = await syncVoiceAssistant({ supabase: db, shop: before as unknown as ShopRow, origin: "https://example.test" })
      expect(res.ok).toBe(true)
      expect(h.vapi.updateAssistant).toHaveBeenLastCalledWith(before.vapi_assistant_id, expect.anything())
      expect((await row()).vapi_assistant_id).toBe(before.vapi_assistant_id)
    })

    it("attachVoiceNumber stores the provider number id it was just handed", async () => {
      await serverSet({ gradia_number_e164: "+16175550123", gradia_number_sid: "PN" + rnd(), twilio_subaccount_sid: "AC" + rnd(), twilio_subaccount_token_enc: encryptSecret("tok") })
      const shop = (await row()) as unknown as ShopRow
      const res = await attachVoiceNumber({ supabase: db, shop, origin: "https://example.test" })
      expect(res.ok).toBe(true)
      expect((await row()).vapi_phone_number_id).toMatch(/^pn_mock_/)
    })

    it("startVoiceTestCall stamps voice_test_called_at after a (mock) successful call", async () => {
      const shop = (await row()) as unknown as ShopRow
      const placeCall = vi.fn(async () => ({ callId: "call_mock" }))
      const res = await startVoiceTestCall({
        supabase: db, shop, placeCall,
        authorization: { toNumber: "+16175550142" } as unknown as Parameters<typeof startVoiceTestCall>[0]["authorization"],
      })
      expect(res.ok).toBe(true)
      expect((await row()).voice_test_called_at).not.toBeNull()
    })

    it("the launch gate then opens through the seam; the Stripe path switches it off with the service client", async () => {
      await serverSet({ voice_addon: true })
      expect(await setVoiceLiveForOwner({ service: db, userId: a.ownerId, shopId: a.shopId, live: true })).toEqual({ ok: true })
      expect((await row()).voice_live).toBe(true)
      // stripe webhook: add-on cancelled -> voice_live=false, vapi_stale=true
      await serverSet({ voice_addon: false, voice_live: false, vapi_stale: true })
      const after = await row()
      expect(after.voice_live).toBe(false)
      expect(after.vapi_stale).toBe(true)
    })
  })

  describe("rollback", () => {
    it("a service writer that fails mid-update leaves the row exactly as it was (unique violation on the assistant id)", async () => {
      await resetAll()
      await serverSet({ vapi_assistant_id: "asst_held_" + a.shopId }, a.shopId)
      await serverSet({ vapi_stale: true }, b.shopId)
      const before = await row(b.shopId)
      // The same single UPDATE syncVoiceAssistant issues: new assistant id + clear stale.
      const res = await db.from("shops").update({ vapi_assistant_id: "asst_held_" + a.shopId, vapi_stale: false }).eq("id", b.shopId)
      expect(res.error?.code).toBe("23505")
      expect(await row(b.shopId)).toEqual(before)
    })

    it("a refused owner PATCH rolls back its safe fields too (name in the same statement is not saved)", async () => {
      await resetAll()
      const before = await row()
      refused((await ownerA.from("shops").update({ name: "Half saved?", voice_test_called_at: new Date().toISOString() }).eq("id", a.shopId)).error, "voice_test_called_at")
      expect((await row()).name).toBe(before.name)
    })
  })
})
