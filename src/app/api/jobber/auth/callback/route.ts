/**
 * Jobber OAuth callback:
 *   1. Verify the state cookie set on /start.
 *   2. Exchange the code for access + refresh tokens.
 *   3. Read account info (verifies the token works + gives us a
 *      display name for the settings card).
 *   4. Encrypt both tokens at rest and persist to the shop row.
 *   5. Redirect to /settings with a status flag for the UI.
 */

import { cookies } from "next/headers"

import { encryptSecret } from "@/lib/crypto"
import {
  exchangeAuthorizationCode,
  fetchAccountInfo,
} from "@/lib/jobber"
import { finishOauth } from "@/lib/oauth-popup"
import { requireShop } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const STATE_COOKIE = "jobber_oauth_state"

function settingsRedirect(status: string): string {
  const params = new URLSearchParams({ jobber: status })
  return `/settings?${params.toString()}`
}

async function buildRedirectUri(request: Request): Promise<string> {
  const configured = process.env.GRADIA_DASHBOARD_URL?.trim()
  if (configured) {
    try {
      const u = new URL(configured)
      return `${u.origin}/api/jobber/auth/callback`
    } catch {
      // fall through
    }
  }
  const here = new URL(request.url)
  return `${here.origin}/api/jobber/auth/callback`
}

export async function GET(request: Request) {
  const shop = await requireShop()

  const url = new URL(request.url)
  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  const oauthError = url.searchParams.get("error")

  if (oauthError) {
    console.warn("[jobber callback] provider returned error:", oauthError)
    return finishOauth(settingsRedirect("denied"))
  }
  if (!code || !state) {
    return finishOauth(settingsRedirect("missing_params"))
  }

  const cookieStore = await cookies()
  const cookieNonce = cookieStore.get(STATE_COOKIE)?.value
  cookieStore.delete(STATE_COOKIE)

  if (!cookieNonce || cookieNonce !== state) {
    console.warn("[jobber callback] state nonce mismatch")
    return finishOauth(settingsRedirect("state_mismatch"))
  }

  const redirectUri = await buildRedirectUri(request)

  let tokens
  try {
    tokens = await exchangeAuthorizationCode({ code, redirectUri })
  } catch (err) {
    console.error("[jobber callback] token exchange failed:", err)
    return finishOauth(settingsRedirect("token_exchange_failed"))
  }

  let account
  try {
    account = await fetchAccountInfo(tokens.accessToken)
  } catch (err) {
    console.error("[jobber callback] account fetch failed:", err)
    return finishOauth(settingsRedirect("account_fetch_failed"))
  }

  let accessEnc: string | null
  let refreshEnc: string | null
  try {
    accessEnc = encryptSecret(tokens.accessToken)
    refreshEnc = tokens.refreshToken
      ? encryptSecret(tokens.refreshToken)
      : null
  } catch (err) {
    console.error("[jobber callback] token encryption failed:", err)
    return finishOauth(settingsRedirect("save_failed"))
  }

  const supabase = await createClient()
  const { error: updateErr } = await supabase
    .from("shops")
    .update({
      jobber_account_id: account.id,
      jobber_account_name: account.name,
      jobber_access_token_enc: accessEnc,
      jobber_refresh_token_enc: refreshEnc,
      jobber_token_expires_at: tokens.expiresAt,
    })
    .eq("id", shop.id)
  if (updateErr) {
    console.error("[jobber callback] shop update failed:", updateErr)
    return finishOauth(settingsRedirect("save_failed"))
  }

  return finishOauth(settingsRedirect("ok"))
}
