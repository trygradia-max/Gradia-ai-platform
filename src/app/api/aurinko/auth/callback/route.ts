/**
 * Aurinko OAuth callback:
 *   1. Verify state nonce against the HttpOnly cookie set on /start.
 *   2. Exchange the code for an account access token.
 *   3. Read account info, create the /email/messages webhook subscription,
 *      and persist everything to the shop row.
 *   4. Redirect to /settings with a success or error flag for the UI.
 */

import { cookies, headers } from "next/headers"

import {
  createMessagesSubscription,
  exchangeAuthCode,
  getAccount,
} from "@/lib/aurinko"
import { encryptSecret } from "@/lib/crypto"
import { finishOauth } from "@/lib/oauth-popup"
import { requireShop } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const STATE_COOKIE = "aurinko_oauth_state"

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

const NEXT_COOKIE = "aurinko_oauth_next"

/** Lands on the wizard step (when the flow started there) or /settings. */
function settingsRedirect(status: "ok" | string, next?: string | null): string {
  if (next && next.startsWith("/") && !next.startsWith("//")) {
    return next
  }
  const params = new URLSearchParams({ email: status })
  return `/settings?${params.toString()}`
}

export async function GET(request: Request) {
  const shop = await requireShop()

  const url = new URL(request.url)
  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  const error = url.searchParams.get("error")

  if (error) {
    console.warn("[aurinko callback] provider returned error:", error)
    return finishOauth(settingsRedirect("denied"))
  }

  if (!code || !state) {
    return finishOauth(settingsRedirect("missing_params"))
  }

  const cookieStore = await cookies()
  const cookieNonce = cookieStore.get(STATE_COOKIE)?.value
  cookieStore.delete(STATE_COOKIE)
  const nextPath = cookieStore.get(NEXT_COOKIE)?.value ?? null
  cookieStore.delete(NEXT_COOKIE)

  if (!cookieNonce || cookieNonce !== state) {
    console.warn("[aurinko callback] state nonce mismatch")
    return finishOauth(settingsRedirect("state_mismatch"))
  }

  let token
  try {
    token = await exchangeAuthCode(code)
  } catch (err) {
    console.error("[aurinko callback] token exchange failed:", err)
    return finishOauth(settingsRedirect("token_exchange_failed"))
  }

  let account
  try {
    account = await getAccount(token.accessToken)
  } catch (err) {
    console.error("[aurinko callback] account fetch failed:", err)
    return finishOauth(settingsRedirect("account_fetch_failed"))
  }

  const origin = await resolveOrigin()
  const notificationUrl = `${origin}/api/aurinko/webhook`

  let subscription
  try {
    subscription = await createMessagesSubscription(
      token.accessToken,
      notificationUrl
    )
  } catch (err) {
    console.error("[aurinko callback] subscription create failed:", err)
    return finishOauth(settingsRedirect("subscription_failed"))
  }

  let encryptedToken: string | null
  try {
    encryptedToken = encryptSecret(token.accessToken)
  } catch (err) {
    console.error("[aurinko callback] token encryption failed:", err)
    return finishOauth(settingsRedirect("save_failed"))
  }

  const supabase = await createClient()
  const { error: updateErr } = await supabase
    .from("shops")
    .update({
      aurinko_account_id: account.id,
      aurinko_account_email: account.email,
      aurinko_access_token_enc: encryptedToken,
      aurinko_token_expires_at: token.expiresAt,
      aurinko_subscription_id: subscription.id,
    })
    .eq("id", shop.id)

  if (updateErr) {
    console.error("[aurinko callback] shop update failed:", updateErr)
    return finishOauth(settingsRedirect("save_failed"))
  }

  return finishOauth(settingsRedirect("ok", nextPath))
}
