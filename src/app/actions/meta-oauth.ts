"use server"

import { cookies } from "next/headers"
import { revalidatePath } from "next/cache"

import { encryptSecret } from "@/lib/crypto"
import { subscribePageWebhook, type MetaPageCandidate } from "@/lib/meta-oauth"
import { requireShop } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"

const PICKER_COOKIE = "meta_oauth_picker"

export type MetaPagePickerOption = {
  pageId: string
  pageName: string
  hasInstagram: boolean
  instagramHandle: string | null
}

/**
 * Reads the short-lived picker cookie set by the OAuth callback and
 * returns just the user-facing fields (no tokens). Used by the IG /
 * FB settings card to render a "pick which Page to connect" list when
 * the operator's Meta account manages more than one.
 */
export async function getPendingMetaPages(): Promise<MetaPagePickerOption[]> {
  const cookieStore = await cookies()
  const raw = cookieStore.get(PICKER_COOKIE)?.value
  if (!raw) return []
  try {
    const decoded = decodeURIComponent(raw)
    const parsed = JSON.parse(decoded) as MetaPageCandidate[]
    return parsed.map((p) => ({
      pageId: p.pageId,
      pageName: p.pageName,
      hasInstagram: Boolean(p.instagramBusinessAccountId),
      instagramHandle: p.instagramHandle,
    }))
  } catch {
    return []
  }
}

export type ConnectMetaPageResult =
  | { ok: true; hasInstagram: boolean }
  | { ok: false; error: string }

/**
 * Connects the chosen Page from the picker cookie to the current shop.
 * Resolves the full MetaPageCandidate (with token) from the cookie's
 * stash and runs the same connect-to-shop logic the single-page path
 * runs inline in the OAuth callback.
 */
export async function connectMetaPage(input: {
  pageId: string
}): Promise<ConnectMetaPageResult> {
  await requireShop()
  const cookieStore = await cookies()
  const raw = cookieStore.get(PICKER_COOKIE)?.value
  if (!raw) {
    return {
      ok: false,
      error: "The picker timed out — reconnect to start again.",
    }
  }

  let candidates: MetaPageCandidate[]
  try {
    candidates = JSON.parse(decodeURIComponent(raw)) as MetaPageCandidate[]
  } catch {
    cookieStore.delete(PICKER_COOKIE)
    return {
      ok: false,
      error: "Couldn't read the picker payload — reconnect to start again.",
    }
  }

  const page = candidates.find((c) => c.pageId === input.pageId)
  if (!page) {
    return {
      ok: false,
      error: "That Page isn't in the current picker — try reconnecting.",
    }
  }

  // Subscribe before persisting — see the matching note in the
  // /api/meta/auth/callback route.
  try {
    await subscribePageWebhook({
      pageId: page.pageId,
      pageAccessToken: page.pageAccessToken,
    })
  } catch (err) {
    console.error("[connectMetaPage] subscribe failed:", err)
    return {
      ok: false,
      error: "Meta didn't accept the webhook subscription — try again.",
    }
  }

  let encryptedToken: string
  try {
    const enc = encryptSecret(page.pageAccessToken)
    if (!enc) {
      return {
        ok: false,
        error: "Couldn't encrypt the access token — flag the engineer.",
      }
    }
    encryptedToken = enc
  } catch (err) {
    console.error("[connectMetaPage] encrypt failed:", err)
    return {
      ok: false,
      error: "Couldn't encrypt the access token — flag the engineer.",
    }
  }

  const shop = await requireShop()
  const supabase = await createClient()
  const update: Record<string, string | null> = {
    facebook_page_id: page.pageId,
    facebook_page_name: page.pageName,
    facebook_page_access_token_enc: encryptedToken,
  }
  if (page.instagramBusinessAccountId) {
    update.instagram_page_id = page.pageId
    update.instagram_business_account_id = page.instagramBusinessAccountId
    update.instagram_account_handle =
      page.instagramHandle?.replace(/^@/, "") ?? null
    update.instagram_page_access_token_enc = encryptedToken
  }

  const { error } = await supabase
    .from("shops")
    .update(update)
    .eq("id", shop.id)

  if (error) {
    return { ok: false, error: error.message }
  }

  // Clear the picker now that the pick is committed.
  cookieStore.delete(PICKER_COOKIE)
  revalidatePath("/settings")
  return {
    ok: true,
    hasInstagram: Boolean(page.instagramBusinessAccountId),
  }
}

/**
 * Cancels the picker — drops the cookie and clears the state so the
 * settings page goes back to the "Connect via Facebook" CTA. Used
 * when the operator picks "none of these."
 */
export async function dismissMetaPagePicker(): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.delete(PICKER_COOKIE)
  revalidatePath("/settings")
}
