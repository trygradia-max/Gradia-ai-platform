import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { INTEGRATION_WITH_SESSION, serviceClient, ownerSessionClient, anonClient, seedShop, cleanup, type Seeded } from "./_db"
import {
  BYO_SMS_ATTESTATION_STATEMENT_VERSION as VERSION, byoSmsAttestResponseSchema, byoSmsAttestationStateSchema,
  byoSmsRefusal, byoSmsRevokeResponseSchema,
} from "@/lib/byo-sms-attestation"
import { smsGateForShop } from "@/lib/telephony-provider"

// Disposable stack only. Synthetic shops and numbers; nothing is sent and no provider is called.
let db: SupabaseClient, owner: SupabaseClient, manager: SupabaseClient, staff: SupabaseClient, foreignOwner: SupabaseClient
let shop: Seeded, managerSeed: Seeded, staffSeed: Seeded, foreign: Seeded
const OWN_NUMBER = "+15555550142"
const GRADIA_NUMBER = "+15555550100"

const attest = (client: SupabaseClient, phone = OWN_NUMBER, version: string = VERSION) =>
  client.rpc("attest_byo_sms_registration", { p_shop: shop.shopId, p_phone: phone, p_statement_version: version })
const revoke = (client: SupabaseClient) => client.rpc("revoke_byo_sms_registration", { p_shop: shop.shopId })
const read = (client: SupabaseClient) => client.rpc("read_byo_sms_attestation", { p_shop: shop.shopId })
const refusal = (r: { error: { code?: string; details?: string | null } | null }) => r.error ? byoSmsRefusal(r.error) : { ok: true }
const shopRow = async () => (await db.from("shops").select("twilio_phone_number,gradia_number_e164,a2p_status,byo_sms_verified").eq("id", shop.shopId).single()).data!
const history = async () => (await db.from("byo_sms_attestations").select("*").eq("shop_id", shop.shopId).order("created_at")).data!
const setShop = async (values: Record<string, unknown>) => expect((await db.from("shops").update(values).eq("id", shop.shopId)).error).toBeNull()
/** The send-time gate, evaluated on the stored row exactly as the executor does. */
const gateOpen = async () => { const s = await shopRow(); return smsGateForShop(s, s.twilio_phone_number).allowed }

describe.skipIf(!INTEGRATION_WITH_SESSION)("owner attestation of a bring-your-own number's A2P registration", () => {
  beforeAll(async () => {
    db = serviceClient()
    const password = randomUUID()
    shop = await seedShop(db, { password }); managerSeed = await seedShop(db, { password })
    staffSeed = await seedShop(db, { password }); foreign = await seedShop(db, { password })
    owner = await ownerSessionClient(shop.email, password)
    manager = await ownerSessionClient(managerSeed.email, password)
    staff = await ownerSessionClient(staffSeed.email, password)
    foreignOwner = await ownerSessionClient(foreign.email, password)
    for (const [client, seed, role, capabilities] of [
      [manager, managerSeed, "manager", ["crm.read", "leads.qualify", "approvals.messages"]],
      [staff, staffSeed, "staff", []],
    ] as const) {
      const invite = await owner.rpc("team_invite", { p_shop: shop.shopId, p_email: seed.email, p_name: "Fictional Member", p_role: role, p_capabilities: capabilities })
      expect(invite.error).toBeNull()
      expect((await client.rpc("team_accept_invite", { p_token: invite.data.token })).error).toBeNull()
    }
  })
  afterAll(async () => { for (const s of [shop, managerSeed, staffSeed, foreign]) if (s) await cleanup(db, s) })
  beforeEach(async () => {
    await setShop({ twilio_phone_number: OWN_NUMBER, gradia_number_e164: null, a2p_status: "unregistered" })
    if ((await shopRow()).byo_sms_verified) expect((await revoke(owner)).error).toBeNull()
  })

  it("the owner attests the number they were shown: the gate opens and who, when, which number and statement are recorded once", async () => {
    expect(byoSmsAttestationStateSchema.parse((await read(owner)).data).state).toBe("unconfirmed")
    expect(await gateOpen()).toBe(false)
    const before = (await history()).length
    const r = await attest(owner)
    expect(r.error).toBeNull()
    const body = byoSmsAttestResponseSchema.parse(r.data)
    expect(body).toMatchObject({ status: "attested", state: "confirmed", phone_e164: OWN_NUMBER, current_statement_version: VERSION })
    expect(body.last_event).toMatchObject({ event: "attested", source: "owner_attestation", phone_e164: OWN_NUMBER, actor_user_id: shop.ownerId, statement_version: VERSION })
    expect(await gateOpen()).toBe(true)
    const rows = await history()
    expect(rows).toHaveLength(before + 1)
    expect(rows.at(-1)).toMatchObject({ event: "attested", actor_user_id: shop.ownerId, phone_e164: OWN_NUMBER, statement_version: VERSION })
    // Exact and concurrent retries write nothing new.
    const [x, y] = await Promise.all([attest(owner), attest(owner)])
    expect([x.error, y.error]).toEqual([null, null])
    expect([x.data.status, y.data.status]).toEqual(["already_attested", "already_attested"])
    expect(await history()).toHaveLength(before + 1)
  })

  it("managers, staff, other shops' owners and anonymous callers can neither attest, revoke nor read", async () => {
    for (const client of [manager, staff, foreignOwner]) {
      expect(refusal(await attest(client))).toEqual({ ok: false, code: "forbidden" })
      expect(refusal(await read(client))).toEqual({ ok: false, code: "forbidden" })
    }
    expect((await attest(anonClient())).error).not.toBeNull()
    expect((await shopRow()).byo_sms_verified).toBe(false)
    expect((await attest(owner)).error).toBeNull()
    for (const client of [manager, staff, foreignOwner]) {
      expect(refusal(await revoke(client))).toEqual({ ok: false, code: "forbidden" })
      expect((await client.from("byo_sms_attestations").select("id").eq("shop_id", shop.shopId)).data).toEqual([])
    }
    expect((await revoke(anonClient())).error).not.toBeNull()
    expect((await shopRow()).byo_sms_verified).toBe(true)
  })

  it("a signed-in owner can't set the flag or forge history directly; other shop edits still work", async () => {
    const direct = await owner.from("shops").update({ byo_sms_verified: true }).eq("id", shop.shopId)
    expect(direct.error).toMatchObject({ code: "42501", details: "attestation_required" })
    expect((await shopRow()).byo_sms_verified).toBe(false)
    const created = await owner.from("shops").insert({ name: "Fictional Second Shop", owner_id: shop.ownerId, byo_sms_verified: true })
    expect(created.error).toMatchObject({ code: "42501", details: "attestation_required" })
    expect((await owner.from("shops").update({ name: "Fictional Renamed Shop" }).eq("id", shop.shopId)).error).toBeNull()
    expect((await owner.from("byo_sms_attestations").insert({ shop_id: shop.shopId, event: "attested", source: "owner_attestation", phone_e164: OWN_NUMBER, statement_version: VERSION })).error).not.toBeNull()
    expect((await attest(owner)).error).toBeNull()
    expect((await owner.from("shops").update({ byo_sms_verified: false }).eq("id", shop.shopId)).error).toMatchObject({ details: "attestation_required" })
    const rows = await owner.from("byo_sms_attestations").select("*").eq("shop_id", shop.shopId)
    expect(rows.error).toBeNull()
    expect(rows.data!.length).toBeGreaterThan(0)
    expect((await db.from("byo_sms_attestations").update({ phone_e164: "+15555550999" }).eq("id", rows.data![0].id)).error).not.toBeNull()
  })

  it("refuses a different number than shown, no number, a Gradia number, and a stale statement", async () => {
    expect(refusal(await attest(owner, "+15555550999"))).toEqual({ ok: false, code: "number_changed" })
    expect(refusal(await attest(owner, OWN_NUMBER, "2026-01-01"))).toEqual({ ok: false, code: "invalid", field: "statementVersion" })
    await setShop({ twilio_phone_number: null })
    expect(refusal(await attest(owner))).toEqual({ ok: false, code: "no_number" })
    expect(byoSmsAttestationStateSchema.parse((await read(owner)).data).state).toBe("no_number")
    await setShop({ twilio_phone_number: GRADIA_NUMBER, gradia_number_e164: GRADIA_NUMBER, a2p_status: "pending" })
    expect(refusal(await attest(owner, GRADIA_NUMBER))).toEqual({ ok: false, code: "gradia_number" })
    expect(byoSmsAttestationStateSchema.parse((await read(owner)).data).state).toBe("gradia_number")
    expect(await gateOpen()).toBe(false)
    expect((await shopRow()).byo_sms_verified).toBe(false)
  })

  it("changing the sending number by any writer clears the attestation and records why; re-saving the same number does not", async () => {
    expect((await attest(owner)).error).toBeNull()
    await setShop({ twilio_phone_number: OWN_NUMBER })
    expect((await shopRow()).byo_sms_verified).toBe(true)
    await setShop({ twilio_phone_number: "+15555550143" })
    expect(await shopRow()).toMatchObject({ byo_sms_verified: false, twilio_phone_number: "+15555550143" })
    expect(await gateOpen()).toBe(false)
    expect((await history()).at(-1)).toMatchObject({ event: "cleared", source: "number_changed", phone_e164: OWN_NUMBER, actor_user_id: null })
    const state = byoSmsAttestationStateSchema.parse((await read(owner)).data)
    expect(state).toMatchObject({ state: "unconfirmed", phone_e164: "+15555550143", last_event: { event: "cleared" } })
    // Moving onto a Gradia number clears it too, so the A2P gate alone applies.
    await setShop({ twilio_phone_number: OWN_NUMBER })
    expect((await attest(owner)).error).toBeNull()
    await setShop({ twilio_phone_number: GRADIA_NUMBER, gradia_number_e164: GRADIA_NUMBER, a2p_status: "pending" })
    expect((await shopRow()).byo_sms_verified).toBe(false)
    expect(await gateOpen()).toBe(false)
  })

  it("the owner revokes: texts are held again, who and when are recorded, and a repeat writes nothing", async () => {
    expect((await attest(owner)).error).toBeNull()
    const before = (await history()).length
    const r = await revoke(owner)
    expect(r.error).toBeNull()
    expect(byoSmsRevokeResponseSchema.parse(r.data)).toMatchObject({ status: "revoked", state: "unconfirmed", last_event: { event: "revoked", source: "owner_revocation", actor_user_id: shop.ownerId, phone_e164: OWN_NUMBER, statement_version: null } })
    expect(await gateOpen()).toBe(false)
    expect((await revoke(owner)).data.status).toBe("already_revoked")
    expect(await history()).toHaveLength(before + 1)
  })

})
