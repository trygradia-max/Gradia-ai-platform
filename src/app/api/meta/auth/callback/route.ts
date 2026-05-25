/**
 * Returns from Meta's OAuth dialog.
 *
 * Happy path:
 *   1. Verify the CSRF state cookie matches the `state` param.
 *   2. Exchange `code` → short-lived user token → long-lived user
 *      token (60-day).
 *   3. List the user's Pages (each comes with its own Page Access
 *      Token + optionally an IG Business Account).
 *   4. If exactly one Page → wire it up to this shop immediately,
 *      subscribe the webhook, redirect to /settings#{channel}?meta=ok.
 *   5. If multiple Pages → stash the candidates in a short-lived
 *      cookie and redirect to /settings#{channel}?meta=pick so the
 *      page picker UI in the relevant settings card can render.
 *   6. If zero Pages → /settings?meta=no_pages.
 *
 * Failure paths bounce back to /settings?meta=<status> with a code
 * the StripeSettingsCard-style status banner can render.
 */

import { redirect } from "next/navigation"
import { cookies, headers } from "next/headers"
import type { NextRequest } from "next/server"

import {
  exchangeCodeForUserToken,
  exchangeForLongLivedUserToken,
  listUserPages,
  subscribePageWebhook,
  type MetaPageCandidate,
} from "@/lib/meta-oauth"
import { encryptSecret } from "@/lib/crypto"
import { requireShop } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const STATE_COOKIE = "meta_oauth_state"
const CHANNEL_COOKIE = "meta_oauth_channel"
const PICKER_COOKIE = "meta_oauth_picker"
const PICKER_COOKIE_MAX_AGE_SECONDS = 60 * 10 // 10 min

type Channel = "instagram" | "facebook"

function statusRedirect(channel: Channel, code: string): never {
  redirect(`/settings?meta=${encodeURIComponent(code)}#${channel}`)
}

async function resolveOrigin(): Promise<string> {
  const configured = process.env.GRADIA_DASHBOARD_URL?.trim()
  if (configured) {
    try {
      return new URL(configured).origin
    } catch {
      // fall through
    }
  }
  const h = await headers()
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000"
  const proto =
    h.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https")
  return `${proto}://${host}`
}

export async function GET(request: NextRequest) {
  const cookieStore = await cookies()
  const channel: Channel =
    cookieStore.get(CHANNEL_COOKIE)?.value === "instagram"
      ? "instagram"
      : "facebook"

  // Always clear OAuth-leg cookies on the way back out.
  function clearStartCookies() {
    cookieStore.delete(STATE_COOKIE)
    cookieStore.delete(CHANNEL_COOKIE)
  }

  const url = request.nextUrl
  const code = url.searchParams.get("code")
  const stateParam = url.searchParams.get("state")
  const errorParam = url.searchParams.get("error")

  if (errorParam) {
    clearStartCookies()
    statusRedirect(channel, "denied")
  }
  if (!code || !stateParam) {
    clearStartCookies()
    statusRedirect(channel, "missing_params")
  }

  const expectedState = cookieStore.get(STATE_COOKIE)?.value
  if (!expectedState || expectedState !== stateParam) {
    clearStartCookies()
    statusRedirect(channel, "state_mismatch")
  }

  // Bind to the current shop — the OAuth dialog assumes the operator
  // is already signed into Gradia in this browser.
  let shopId: string
  try {
    const shop = await requireShop()
    shopId = shop.id
  } catch {
    clearStartCookies()
    statusRedirect(channel, "not_signed_in")
  }

  // 1. Exchange the code for a short-lived user token, then upgrade.
  const origin = await resolveOrigin()
  let longLivedUserToken: string
  try {
    const shortLived = await exchangeCodeForUserToken({
      code: code!,
      redirectUri: `${origin}/api/meta/auth/callback`,
    })
    longLivedUserToken = await exchangeForLongLivedUserToken(shortLived)
  } catch (err) {
    console.error("[meta/auth/callback] token exchange failed:", err)
    clearStartCookies()
    statusRedirect(channel, "token_exchange_failed")
  }

  // 2. List the user's Pages.
  let pages: MetaPageCandidate[]
  try {
    pages = await listUserPages(longLivedUserToken!)
  } catch (err) {
    console.error("[meta/auth/callback] page listing failed:", err)
    clearStartCookies()
    statusRedirect(channel, "page_list_failed")
  }

  if (pages!.length === 0) {
    clearStartCookies()
    statusRedirect(channel, "no_pages")
  }

  // 3a. Single-page happy path: wire up immediately.
  if (pages!.length === 1) {
    const result = await connectPageToShop({
      shopId: shopId!,
      page: pages![0],
    })
    clearStartCookies()
    if (!result.ok) {
      statusRedirect(channel, result.code)
    }
    statusRedirect(channel, "ok")
  }

  // 3b. Multi-page case: stash candidates (minus secrets) for the
  //     picker UI, save tokens in a HttpOnly cookie keyed by a short
  //     id we can look up on the picker submit.
  cookieStore.set({
    name: PICKER_COOKIE,
    value: encodeURIComponent(JSON.stringify(pages!)),
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: PICKER_COOKIE_MAX_AGE_SECONDS,
  })
  clearStartCookies()
  statusRedirect(channel, "pick")
}

type ConnectResult =
  | { ok: true }
  | { ok: false; code: "save_failed" | "subscribe_failed" }

async function connectPageToShop(input: {
  shopId: string
  page: MetaPageCandidate
}): Promise<ConnectResult> {
  // 1. Subscribe our app to the Page's webhook. If this fails we
  //    don't save — saving a token without webhook delivery would
  //    silently break inbound DMs.
  try {
    await subscribePageWebhook({
      pageId: input.page.pageId,
      pageAccessToken: input.page.pageAccessToken,
    })
  } catch (err) {
    console.error("[meta/auth/callback] subscribe failed:", err)
    return { ok: false, code: "subscribe_failed" }
  }

  // 2. Persist. We encrypt the Page Access Token at rest. The same
  //    token works for both FB Page DMs and IG DMs on the linked IG
  //    account, so we save it under both columns — disconnect from
  //    either card stays surgical to that channel.
  let encryptedToken: string
  try {
    const enc = encryptSecret(input.page.pageAccessToken)
    if (!enc) {
      return { ok: false, code: "save_failed" }
    }
    encryptedToken = enc
  } catch (err) {
    console.error("[meta/auth/callback] encrypt failed:", err)
    return { ok: false, code: "save_failed" }
  }

  const supabase = await createClient()
  const update: Record<string, string | null> = {
    facebook_page_id: input.page.pageId,
    facebook_page_name: input.page.pageName,
    facebook_page_access_token_enc: encryptedToken,
  }
  if (input.page.instagramBusinessAccountId) {
    update.instagram_page_id = input.page.pageId
    update.instagram_business_account_id =
      input.page.instagramBusinessAccountId
    update.instagram_account_handle =
      input.page.instagramHandle?.replace(/^@/, "") ?? null
    update.instagram_page_access_token_enc = encryptedToken
  }

  const { error } = await supabase
    .from("shops")
    .update(update)
    .eq("id", input.shopId)

  if (error) {
    console.error("[meta/auth/callback] persist failed:", error)
    return { ok: false, code: "save_failed" }
  }

  return { ok: true }
}
