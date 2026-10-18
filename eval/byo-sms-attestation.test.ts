import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  BYO_SMS_ATTESTATION_STATEMENT_VERSION, byoSmsRefusal, byoSmsSetupStatus, type ByoSmsAttestationState,
} from "@/lib/byo-sms-attestation"
import { smsGateForShop } from "@/lib/telephony-provider"

const h = vi.hoisted(() => ({ rpc: vi.fn(), revalidate: vi.fn() }))
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc: h.rpc }) }))
vi.mock("@/lib/shop", () => ({ requireUser: async () => ({ id: "user" }) }))
vi.mock("next/cache", () => ({ revalidatePath: h.revalidate }))

import { attestByoSmsRegistration, getByoSmsAttestation, revokeByoSmsRegistration } from "@/app/actions/byo-sms-attestation"

const shopId = "00000000-0000-4000-8000-000000000001"
const phone = "+15555550123"
const MIGRATION = "supabase/migrations/20261015150000_byo_sms_attestation.sql"
const state = (patch: Partial<ByoSmsAttestationState> = {}): ByoSmsAttestationState => ({
  state: "confirmed", phone_e164: phone, current_statement_version: BYO_SMS_ATTESTATION_STATEMENT_VERSION,
  last_event: { event: "attested", source: "owner_attestation", phone_e164: phone, actor_user_id: shopId, statement_version: BYO_SMS_ATTESTATION_STATEMENT_VERSION, created_at: "2026-10-15T22:00:00.123456+00:00" },
  ...patch,
})
const attestInput = { shopId, phoneE164: phone, statementVersion: BYO_SMS_ATTESTATION_STATEMENT_VERSION, confirm: true }

beforeEach(() => { h.rpc.mockReset(); h.revalidate.mockReset() })

describe("attestByoSmsRegistration", () => {
  it("requires the explicit confirmation, the current statement and a real E.164 number before any database call", async () => {
    for (const [patch, field] of [
      [{ confirm: false }, "confirm"], [{ confirm: undefined }, "confirm"], [{ confirm: "true" }, "confirm"],
      [{ statementVersion: "2026-01-01" }, "statementVersion"], [{ phoneE164: "5555550123" }, "phoneE164"],
      [{ shopId: "nope" }, "shopId"], [{ extra: 1 }, "command"],
    ] as const) {
      expect(await attestByoSmsRegistration({ ...attestInput, ...patch })).toEqual({ ok: false, code: "invalid", field })
    }
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it("calls the owner-checked function with the shown number and statement version, and returns the recorded state", async () => {
    h.rpc.mockResolvedValue({ data: { ...state(), status: "attested" }, error: null })
    expect(await attestByoSmsRegistration(attestInput)).toEqual({ ok: true, status: "attested", attestation: state() })
    expect(h.rpc).toHaveBeenCalledWith("attest_byo_sms_registration", { p_shop: shopId, p_phone: phone, p_statement_version: BYO_SMS_ATTESTATION_STATEMENT_VERSION })
    expect(h.revalidate).toHaveBeenCalledWith("/settings")
  })

  it("never reports success unless the database confirms this exact number", async () => {
    for (const data of [{ ...state({ state: "unconfirmed" }), status: "attested" }, { ...state({ phone_e164: "+15555550999" }), status: "attested" }, { ok: true }, null]) {
      h.rpc.mockResolvedValueOnce({ data, error: null })
      expect(await attestByoSmsRegistration(attestInput)).toEqual({ ok: false, code: "not_confirmed" })
    }
    expect(h.revalidate).not.toHaveBeenCalled()
  })

  it("maps database refusals, and a thrown call is uncertain rather than a failure", async () => {
    for (const [error, code] of [
      [{ code: "42501", details: "forbidden" }, "forbidden"], [{ code: "PT409", details: "number_changed" }, "number_changed"],
      [{ code: "PT409", details: "gradia_number" }, "gradia_number"], [{ code: "PT409", details: "no_number" }, "no_number"],
      [{ code: "PT409", details: "not_own_account" }, "not_own_account"],
      [{ code: "PT409", details: "something_else" }, "not_confirmed"], [{ code: "XX000", details: null }, "not_confirmed"],
    ] as const) {
      h.rpc.mockResolvedValueOnce({ data: null, error })
      expect(await attestByoSmsRegistration(attestInput)).toEqual({ ok: false, code })
    }
    h.rpc.mockRejectedValueOnce(new Error("network"))
    expect(await attestByoSmsRegistration(attestInput)).toEqual({ ok: false, code: "uncertain" })
    expect(byoSmsRefusal({ code: "22023", details: "statement_version" })).toEqual({ ok: false, code: "invalid", field: "statementVersion" })
  })
})

describe("revokeByoSmsRegistration and getByoSmsAttestation", () => {
  it("revokes through the owner-checked function and never reports a still-confirmed number as revoked", async () => {
    const revoked = state({ state: "unconfirmed", last_event: { ...state().last_event!, event: "revoked", source: "owner_revocation", statement_version: null } })
    h.rpc.mockResolvedValueOnce({ data: { ...revoked, status: "revoked" }, error: null })
    expect(await revokeByoSmsRegistration({ shopId })).toEqual({ ok: true, status: "revoked", attestation: revoked })
    expect(h.rpc).toHaveBeenLastCalledWith("revoke_byo_sms_registration", { p_shop: shopId })
    h.rpc.mockResolvedValueOnce({ data: { ...state(), status: "revoked" }, error: null })
    expect(await revokeByoSmsRegistration({ shopId })).toEqual({ ok: false, code: "not_confirmed" })
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "42501", details: "forbidden" } })
    expect(await revokeByoSmsRegistration({ shopId })).toEqual({ ok: false, code: "forbidden" })
  })

  it("reads the state, and refuses a malformed shop id without a call", async () => {
    h.rpc.mockResolvedValueOnce({ data: state({ state: "unconfirmed", last_event: null }), error: null })
    expect(await getByoSmsAttestation({ shopId })).toEqual({ ok: true, attestation: state({ state: "unconfirmed", last_event: null }) })
    expect(h.rpc).toHaveBeenCalledWith("read_byo_sms_attestation", { p_shop: shopId })
    h.rpc.mockReset()
    expect(await getByoSmsAttestation({ shopId: 7 })).toEqual({ ok: false, code: "invalid", field: "shopId" })
    expect(h.rpc).not.toHaveBeenCalled()
  })
})

describe("attestation invariants", () => {
  const sql = readFileSync(MIGRATION, "utf8")

  it("the TypeScript statement version is the one the database accepts and reports", () => {
    const versions = [...sql.matchAll(/'(\d{4}-\d{2}-\d{2})'/g)].map((m) => m[1])
    expect(new Set(versions)).toEqual(new Set([BYO_SMS_ATTESTATION_STATEMENT_VERSION]))
  })

  it("maps to the onboarding status vocabulary and is never Ready on the owner's word alone", () => {
    expect(byoSmsSetupStatus("no_number")).toBe("Not set up")
    expect(byoSmsSetupStatus("not_own_account")).toBe("Needs your details")
    expect(byoSmsSetupStatus("unconfirmed")).toBe("Needs your details")
    expect(byoSmsSetupStatus("confirmed")).toBe("Ready to test")
    expect(byoSmsSetupStatus("gradia_number")).toBeNull()
  })

  it("a Gradia number is never opened by the attestation flag", () => {
    const shop = { gradia_number_e164: "+15555550100", a2p_status: "pending" as const, byo_sms_verified: true }
    expect(smsGateForShop(shop, "+15555550100").allowed).toBe(false)
    expect(smsGateForShop({ ...shop, a2p_status: "rejected" }, "+15555550100").allowed).toBe(false)
    expect(smsGateForShop({ ...shop, byo_sms_verified: false }, phone).allowed).toBe(false)
    expect(smsGateForShop(shop, phone).allowed).toBe(true)
  })

  it("no application code writes byo_sms_verified: only the database attestation functions do", () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((e) => {
      const p = join(dir, e)
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(e) ? [p] : []
    })
    const readers: Record<string, true> = {
      "src/lib/types/database.ts": true, "src/lib/telephony-provider.ts": true, "src/app/api/cron/roi-receipt/route.ts": true,
      "src/lib/byo-sms-attestation.ts": true, // documentation only
      "src/lib/channel-readiness.ts": true,
      "src/lib/data/channel-readiness.ts": true,
    }
    const mentions = walk("src").filter((f) => readFileSync(f, "utf8").includes("byo_sms_verified"))
    expect(mentions.filter((f) => !readers[f.split("\\").join("/")])).toEqual([])
  })
})
