/**
 * The only path that flips `shops.voice_live`.
 *
 * Security audit run-1 (residual of finding #6): `voice_live` is a server-written column
 * (`shops_protected_columns_guard`). The launch gate used to run in the server action and then
 * write through the OWNER'S session, so a direct PostgREST PATCH skipped the gate entirely.
 * Now the browser role cannot write the column at all; this function re-verifies everything
 * with the service client and performs the write as one conditional statement:
 *
 *  1. The shop id and the user id come from the owner session (`requireShop()` / `requireUser()`
 *     in the action). Nothing the browser sends picks the shop or the target value's authority.
 *  2. Ownership is RE-READ by id AND owner_id with the service client (a stale or swapped
 *     session context cannot reach another tenant's row).
 *  3. Going live requires the add-on and the launch gate (number, assistant, completed test
 *     call), evaluated on that fresh row, AND the same conditions are repeated in the UPDATE's
 *     WHERE clause, so a concurrent change between the read and the write (add-on ended,
 *     assistant cleared by a trusted writer) writes nothing instead of going live.
 *  4. Pausing (live = false) needs only ownership: it is always safe and always allowed.
 *
 * No provider is contacted here.
 */
import type { SupabaseClient } from "@supabase/supabase-js"

import { voiceLaunchGate } from "@/lib/voice-launch-gate"

export type SetVoiceLiveResult = { ok: true } | { ok: false; error: string }

const GATE_LABELS: Record<string, string> = {
  number: "connect your business number",
  assistant: "save the receptionist",
  test_call: "do a test call",
}

const ADDON_ERROR =
  "The Voice Receptionist is part of the +$29/mo add-on — add it in Billing first."

export async function setVoiceLiveForOwner(input: {
  /** Service-role client. Never the owner's session client. */
  service: SupabaseClient
  /** From the signed-in session. */
  userId: string
  /** From the signed-in owner's active shop. */
  shopId: string
  live: boolean
}): Promise<SetVoiceLiveResult> {
  const { service, userId, shopId, live } = input

  const { data: shop, error: readError } = await service
    .from("shops")
    .select("id, voice_addon, vapi_assistant_id, vapi_phone_number_id, voice_test_called_at")
    .eq("id", shopId)
    .eq("owner_id", userId)
    .maybeSingle()
  if (readError) return { ok: false, error: "Couldn't update the receptionist — try again." }
  if (!shop) return { ok: false, error: "Finish onboarding first." }

  if (!live) {
    const { error } = await service
      .from("shops")
      .update({ voice_live: false })
      .eq("id", shopId)
      .eq("owner_id", userId)
    if (error) return { ok: false, error: "Couldn't update the receptionist — try again." }
    return { ok: true }
  }

  if (!shop.voice_addon) return { ok: false, error: ADDON_ERROR }
  const gate = voiceLaunchGate(shop)
  if (!gate.ready) {
    return {
      ok: false,
      error: `Almost there — first ${gate.missing.map((m) => GATE_LABELS[m]).join(", then ")}.`,
    }
  }

  // The gate again, atomically, in the write itself.
  const { data: updated, error } = await service
    .from("shops")
    .update({ voice_live: true })
    .eq("id", shopId)
    .eq("owner_id", userId)
    .eq("voice_addon", true)
    .not("vapi_assistant_id", "is", null)
    .not("vapi_phone_number_id", "is", null)
    .not("voice_test_called_at", "is", null)
    .select("id")
  if (error) return { ok: false, error: "Couldn't update the receptionist — try again." }
  if (!updated || updated.length === 0) {
    return { ok: false, error: "Something changed while going live — check the setup and try again." }
  }
  return { ok: true }
}
