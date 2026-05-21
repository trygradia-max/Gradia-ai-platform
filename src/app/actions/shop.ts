"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { deleteSubscription } from "@/lib/aurinko"
import { encryptSecret, tryDecryptSecret } from "@/lib/crypto"
import { createClient } from "@/lib/supabase/server"
import { getOptionalShop, requireUser } from "@/lib/shop"
import type { ShopRow } from "@/lib/types/database"

const saveShopSchema = z.object({
  name: z.string().min(1, "Shop name is required").max(120),
  location: z.string().max(200).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
})

export type SaveShopResult =
  | { ok: true; shop: ShopRow }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> }

/**
 * Idempotent upsert. Creates the shop on first call, updates it on
 * subsequent calls. Used by the onboarding wizard for step 1 and (later)
 * the settings page for ongoing edits.
 */
export async function saveShop(
  input: z.infer<typeof saveShopSchema>
): Promise<SaveShopResult> {
  const parsed = saveShopSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: "Please check the form.",
      fieldErrors: parsed.error.flatten().fieldErrors as Record<
        string,
        string[]
      >,
    }
  }

  const user = await requireUser()
  const supabase = await createClient()
  const existing = await getOptionalShop()

  const fields = {
    name: parsed.data.name.trim(),
    location: parsed.data.location?.trim() || null,
    phone: parsed.data.phone?.trim() || null,
  }

  if (existing) {
    const { data, error } = await supabase
      .from("shops")
      .update(fields)
      .eq("id", existing.id)
      .select("*")
      .single()

    if (error || !data) {
      return { ok: false, error: error?.message ?? "Could not update shop." }
    }

    revalidatePath("/", "layout")
    return { ok: true, shop: data as ShopRow }
  }

  const { data, error } = await supabase
    .from("shops")
    .insert({ ...fields, owner_id: user.id, settings: {} })
    .select("*")
    .single()

  if (error || !data) {
    return { ok: false, error: error?.message ?? "Could not create shop." }
  }

  revalidatePath("/", "layout")
  return { ok: true, shop: data as ShopRow }
}

const saveVapiAssistantSchema = z.object({
  vapi_assistant_id: z.string().trim().max(120).nullable(),
})

export type SaveVapiAssistantResult =
  | { ok: true; shop: ShopRow }
  | { ok: false; error: string }

/**
 * Connects a shop to its Vapi assistant. The webhook resolves the shop
 * by matching the incoming call's assistantId against this column, so
 * each shop's calls route to their own brain.
 */
export async function saveVapiAssistantId(
  input: z.infer<typeof saveVapiAssistantSchema>
): Promise<SaveVapiAssistantResult> {
  const parsed = saveVapiAssistantSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: "Assistant ID is too long." }
  }

  await requireUser()
  const existing = await getOptionalShop()
  if (!existing) {
    return { ok: false, error: "Finish onboarding first." }
  }

  const supabase = await createClient()
  const value = parsed.data.vapi_assistant_id?.trim() || null

  const { data, error } = await supabase
    .from("shops")
    .update({ vapi_assistant_id: value })
    .eq("id", existing.id)
    .select("*")
    .single()

  if (error || !data) {
    // 23505 = unique_violation — another shop already claimed this assistant.
    if (error?.code === "23505") {
      return {
        ok: false,
        error: "That assistant is already connected to another shop.",
      }
    }
    return { ok: false, error: error?.message ?? "Could not save." }
  }

  revalidatePath("/settings")
  return { ok: true, shop: data as ShopRow }
}

const saveTwilioSchema = z.object({
  twilio_phone_number: z
    .string()
    .trim()
    .nullable()
    .refine(
      (v) => v === null || v === "" || /^\+\d{8,15}$/.test(v),
      "Use E.164 format (e.g. +15551234567)."
    ),
})

export type SaveTwilioResult =
  | { ok: true; shop: ShopRow }
  | { ok: false; error: string }

/**
 * Connects the shop to the Twilio phone number they own. Pilot model
 * uses one global Twilio account in env vars — this only records the
 * number, no auth tokens stored per shop.
 */
export async function saveTwilioNumber(
  input: z.infer<typeof saveTwilioSchema>
): Promise<SaveTwilioResult> {
  const parsed = saveTwilioSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error:
        parsed.error.issues[0]?.message ??
        "That doesn't look like a valid phone number.",
    }
  }

  await requireUser()
  const existing = await getOptionalShop()
  if (!existing) {
    return { ok: false, error: "Finish onboarding first." }
  }

  const supabase = await createClient()
  const value = parsed.data.twilio_phone_number?.trim() || null

  const { data, error } = await supabase
    .from("shops")
    .update({ twilio_phone_number: value })
    .eq("id", existing.id)
    .select("*")
    .single()

  if (error || !data) {
    if (error?.code === "23505") {
      return {
        ok: false,
        error: "That number is already connected to another shop.",
      }
    }
    return { ok: false, error: error?.message ?? "Could not save." }
  }

  revalidatePath("/settings")
  return { ok: true, shop: data as ShopRow }
}

export type DisconnectStripeResult =
  | { ok: true; shop: ShopRow }
  | { ok: false; error: string }

/**
 * "Disconnects" Stripe from Gradia's side — clears the stored
 * connected-account id and the charges-enabled flag. The Stripe account
 * itself isn't deleted (the shop owner keeps full control of it on
 * Stripe's side). To fully sever access, the owner has to revoke
 * Gradia in their Stripe Dashboard → Connected accounts.
 */
export async function disconnectStripe(): Promise<DisconnectStripeResult> {
  await requireUser()
  const existing = await getOptionalShop()
  if (!existing) {
    return { ok: false, error: "Finish onboarding first." }
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from("shops")
    .update({
      stripe_account_id: null,
      stripe_charges_enabled: false,
    })
    .eq("id", existing.id)
    .select("*")
    .single()

  if (error || !data) {
    return { ok: false, error: error?.message ?? "Could not disconnect." }
  }

  revalidatePath("/settings")
  return { ok: true, shop: data as ShopRow }
}

export type DisconnectSmsResult =
  | { ok: true; shop: ShopRow }
  | { ok: false; error: string }

export async function disconnectSms(): Promise<DisconnectSmsResult> {
  await requireUser()
  const existing = await getOptionalShop()
  if (!existing) {
    return { ok: false, error: "Finish onboarding first." }
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from("shops")
    .update({ twilio_phone_number: null })
    .eq("id", existing.id)
    .select("*")
    .single()

  if (error || !data) {
    return { ok: false, error: error?.message ?? "Could not disconnect." }
  }

  revalidatePath("/settings")
  return { ok: true, shop: data as ShopRow }
}

const saveInstagramSchema = z.object({
  instagram_business_account_id: z
    .string()
    .trim()
    .min(1, "Business account ID is required.")
    .max(80),
  instagram_page_id: z
    .string()
    .trim()
    .min(1, "Facebook Page ID is required.")
    .max(80),
  instagram_page_access_token: z
    .string()
    .trim()
    .min(20, "Page access token looks too short."),
  instagram_account_handle: z
    .string()
    .trim()
    .max(80)
    .optional()
    .nullable(),
})

export type SaveInstagramResult =
  | { ok: true; shop: ShopRow }
  | { ok: false; error: string }

export async function saveInstagramCredentials(
  input: z.infer<typeof saveInstagramSchema>
): Promise<SaveInstagramResult> {
  const parsed = saveInstagramSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    }
  }

  await requireUser()
  const existing = await getOptionalShop()
  if (!existing) {
    return { ok: false, error: "Finish onboarding first." }
  }

  let encryptedToken: string | null
  try {
    encryptedToken = encryptSecret(parsed.data.instagram_page_access_token)
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? `Encryption failed: ${err.message}`
          : "Encryption failed.",
    }
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from("shops")
    .update({
      instagram_business_account_id: parsed.data.instagram_business_account_id,
      instagram_page_id: parsed.data.instagram_page_id,
      instagram_page_access_token_enc: encryptedToken,
      instagram_account_handle:
        parsed.data.instagram_account_handle?.replace(/^@/, "") || null,
    })
    .eq("id", existing.id)
    .select("*")
    .single()

  if (error || !data) {
    if (error?.code === "23505") {
      return {
        ok: false,
        error: "Another shop is already connected to that Facebook Page.",
      }
    }
    return { ok: false, error: error?.message ?? "Could not save." }
  }

  revalidatePath("/settings")
  return { ok: true, shop: data as ShopRow }
}

const saveFacebookSchema = z.object({
  facebook_page_id: z
    .string()
    .trim()
    .min(1, "Facebook Page ID is required.")
    .max(80),
  facebook_page_access_token: z
    .string()
    .trim()
    .min(20, "Page access token looks too short."),
  facebook_page_name: z.string().trim().max(120).optional().nullable(),
})

export type SaveFacebookResult =
  | { ok: true; shop: ShopRow }
  | { ok: false; error: string }

export async function saveFacebookCredentials(
  input: z.infer<typeof saveFacebookSchema>
): Promise<SaveFacebookResult> {
  const parsed = saveFacebookSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    }
  }

  await requireUser()
  const existing = await getOptionalShop()
  if (!existing) {
    return { ok: false, error: "Finish onboarding first." }
  }

  let encryptedToken: string | null
  try {
    encryptedToken = encryptSecret(parsed.data.facebook_page_access_token)
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? `Encryption failed: ${err.message}`
          : "Encryption failed.",
    }
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from("shops")
    .update({
      facebook_page_id: parsed.data.facebook_page_id,
      facebook_page_access_token_enc: encryptedToken,
      facebook_page_name: parsed.data.facebook_page_name?.trim() || null,
    })
    .eq("id", existing.id)
    .select("*")
    .single()

  if (error || !data) {
    if (error?.code === "23505") {
      return {
        ok: false,
        error: "Another shop is already connected to that Facebook Page.",
      }
    }
    return { ok: false, error: error?.message ?? "Could not save." }
  }

  revalidatePath("/settings")
  return { ok: true, shop: data as ShopRow }
}

export type DisconnectFacebookResult =
  | { ok: true; shop: ShopRow }
  | { ok: false; error: string }

export async function disconnectFacebook(): Promise<DisconnectFacebookResult> {
  await requireUser()
  const existing = await getOptionalShop()
  if (!existing) {
    return { ok: false, error: "Finish onboarding first." }
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from("shops")
    .update({
      facebook_page_id: null,
      facebook_page_access_token_enc: null,
      facebook_page_name: null,
    })
    .eq("id", existing.id)
    .select("*")
    .single()

  if (error || !data) {
    return { ok: false, error: error?.message ?? "Could not disconnect." }
  }

  revalidatePath("/settings")
  return { ok: true, shop: data as ShopRow }
}

export type DisconnectInstagramResult =
  | { ok: true; shop: ShopRow }
  | { ok: false; error: string }

export async function disconnectInstagram(): Promise<DisconnectInstagramResult> {
  await requireUser()
  const existing = await getOptionalShop()
  if (!existing) {
    return { ok: false, error: "Finish onboarding first." }
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from("shops")
    .update({
      instagram_business_account_id: null,
      instagram_page_id: null,
      instagram_page_access_token_enc: null,
      instagram_account_handle: null,
    })
    .eq("id", existing.id)
    .select("*")
    .single()

  if (error || !data) {
    return { ok: false, error: error?.message ?? "Could not disconnect." }
  }

  revalidatePath("/settings")
  return { ok: true, shop: data as ShopRow }
}

export type DisconnectEmailResult =
  | { ok: true; shop: ShopRow }
  | { ok: false; error: string }

/**
 * Disconnects the shop's Aurinko email integration. Best-effort cleanup
 * on Aurinko's side, then nulls out the local credentials. The
 * subscription delete is fire-and-forget — if it fails, the local row is
 * still cleared so the UI reflects the disconnect.
 */
export async function disconnectEmail(): Promise<DisconnectEmailResult> {
  await requireUser()
  const existing = await getOptionalShop()
  if (!existing) {
    return { ok: false, error: "Finish onboarding first." }
  }

  const supabase = await createClient()
  const { data: current } = await supabase
    .from("shops")
    .select("aurinko_access_token_enc, aurinko_subscription_id")
    .eq("id", existing.id)
    .single()

  const row = current as
    | {
        aurinko_access_token_enc: string | null
        aurinko_subscription_id: string | null
      }
    | null

  const accessToken = tryDecryptSecret(row?.aurinko_access_token_enc)
  if (accessToken && row?.aurinko_subscription_id) {
    await deleteSubscription(accessToken, row.aurinko_subscription_id)
  }

  const { data, error } = await supabase
    .from("shops")
    .update({
      aurinko_account_id: null,
      aurinko_account_email: null,
      aurinko_access_token_enc: null,
      aurinko_subscription_id: null,
    })
    .eq("id", existing.id)
    .select("*")
    .single()

  if (error || !data) {
    return { ok: false, error: error?.message ?? "Could not disconnect." }
  }

  revalidatePath("/settings")
  return { ok: true, shop: data as ShopRow }
}
