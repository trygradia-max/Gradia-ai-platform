"use server"

import { revalidatePath } from "next/cache"

import {
  byoSmsAttestResponseSchema, byoSmsAttestSchema, byoSmsAttestationStateSchema, byoSmsRefusal,
  byoSmsRevokeResponseSchema, byoSmsShopSchema, splitStatus,
  type ByoSmsAttestResult, type ByoSmsReadResult, type ByoSmsRevokeResult,
} from "@/lib/byo-sms-attestation"
import { requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"

const FIELDS = ["shopId", "phoneE164", "statementVersion", "confirm"] as const
function invalidField(path: PropertyKey | undefined) {
  return FIELDS.find((f) => f === path) ?? "command"
}

/**
 * Session client only, for all three: PostgreSQL rechecks that the caller is the
 * account owner (never a manager or staff member) and the shop id is only a
 * selector. Nothing here sends a text or calls a provider.
 */

/** The current attestation for the shop's sending number. Owner only. */
export async function getByoSmsAttestation(input: unknown): Promise<ByoSmsReadResult> {
  const parsed = byoSmsShopSchema.safeParse(input)
  if (!parsed.success) return { ok: false, code: "invalid", field: invalidField(parsed.error.issues[0]?.path[0]) }
  await requireUser()
  const db = await createClient()
  try {
    const result = await db.rpc("read_byo_sms_attestation", { p_shop: parsed.data.shopId })
    if (result.error) return byoSmsRefusal(result.error).code === "forbidden" ? { ok: false, code: "forbidden" } : { ok: false, code: "not_confirmed" }
    const state = byoSmsAttestationStateSchema.safeParse(result.data)
    return state.success ? { ok: true, attestation: state.data } : { ok: false, code: "not_confirmed" }
  } catch {
    return { ok: false, code: "uncertain" }
  }
}

/**
 * The owner confirms the number they were shown is registered for A2P 10DLC,
 * against the current statement version. Records who and when, under the shop
 * lock. Confirming a confirmed number writes nothing. A changed number refuses
 * (`number_changed`): re-read and show the owner the new number.
 */
export async function attestByoSmsRegistration(input: unknown): Promise<ByoSmsAttestResult> {
  const parsed = byoSmsAttestSchema.safeParse(input)
  if (!parsed.success) return { ok: false, code: "invalid", field: invalidField(parsed.error.issues[0]?.path[0]) }
  await requireUser()
  const c = parsed.data
  const db = await createClient()
  try {
    const result = await db.rpc("attest_byo_sms_registration", {
      p_shop: c.shopId, p_phone: c.phoneE164, p_statement_version: c.statementVersion,
    })
    if (result.error) return byoSmsRefusal(result.error)
    const data = byoSmsAttestResponseSchema.safeParse(result.data)
    if (!data.success || data.data.state !== "confirmed" || data.data.phone_e164 !== c.phoneE164) return { ok: false, code: "not_confirmed" }
    revalidatePath("/settings")
    return { ok: true, ...splitStatus(data.data) }
  } catch {
    return { ok: false, code: "uncertain" }
  }
}

/** The owner withdraws the confirmation; texts from the number are held again at send. */
export async function revokeByoSmsRegistration(input: unknown): Promise<ByoSmsRevokeResult> {
  const parsed = byoSmsShopSchema.safeParse(input)
  if (!parsed.success) return { ok: false, code: "invalid", field: invalidField(parsed.error.issues[0]?.path[0]) }
  await requireUser()
  const db = await createClient()
  try {
    const result = await db.rpc("revoke_byo_sms_registration", { p_shop: parsed.data.shopId })
    if (result.error) return byoSmsRefusal(result.error).code === "forbidden" ? { ok: false, code: "forbidden" } : { ok: false, code: "not_confirmed" }
    const data = byoSmsRevokeResponseSchema.safeParse(result.data)
    if (!data.success || data.data.state === "confirmed") return { ok: false, code: "not_confirmed" }
    revalidatePath("/settings")
    return { ok: true, ...splitStatus(data.data) }
  } catch {
    return { ok: false, code: "uncertain" }
  }
}
