/**
 * Kicks off the Meta (Facebook + Instagram) OAuth flow.
 *
 * 1. Require a logged-in shop.
 * 2. Generate a random nonce, drop it in an HttpOnly cookie, and pass
 *    the same value back as the `state` parameter. The callback
 *    verifies they match before exchanging the code (CSRF protection).
 * 3. Stash which channel kicked off the flow (instagram | facebook)
 *    in a second cookie so the callback knows which settings card to
 *    bounce the operator back to.
 * 4. Redirect to Meta's hosted OAuth dialog.
 */

import { randomBytes } from "node:crypto"
import { redirect } from "next/navigation"
import { cookies, headers } from "next/headers"
import type { NextRequest } from "next/server"

import { buildAuthorizeUrl } from "@/lib/meta-oauth"
import { requireShop } from "@/lib/shop"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const STATE_COOKIE = "meta_oauth_state"
const CHANNEL_COOKIE = "meta_oauth_channel"
const STATE_COOKIE_MAX_AGE_SECONDS = 60 * 10 // 10 minutes

async function resolveOrigin(): Promise<string> {
  const configured = process.env.GRADIA_DASHBOARD_URL?.trim()
  if (configured) {
    try {
      return new URL(configured).origin
    } catch {
      // fall through to header-based detection
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
  await requireShop()

  if (
    !process.env.META_APP_ID?.trim() ||
    !process.env.META_APP_SECRET?.trim()
  ) {
    return new Response(
      "Meta isn't configured on this server yet.",
      { status: 500 }
    )
  }

  // ?channel=instagram | facebook — defaults to facebook since a
  // Page connection always covers FB DMs and may include IG.
  const channelParam = request.nextUrl.searchParams.get("channel")
  const channel =
    channelParam === "instagram" ? "instagram" : "facebook"

  const nonce = randomBytes(24).toString("hex")
  const cookieStore = await cookies()
  cookieStore.set({
    name: STATE_COOKIE,
    value: nonce,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: STATE_COOKIE_MAX_AGE_SECONDS,
  })
  cookieStore.set({
    name: CHANNEL_COOKIE,
    value: channel,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: STATE_COOKIE_MAX_AGE_SECONDS,
  })

  const origin = await resolveOrigin()
  const authorizeUrl = buildAuthorizeUrl({
    redirectUri: `${origin}/api/meta/auth/callback`,
    state: nonce,
  })

  redirect(authorizeUrl)
}
