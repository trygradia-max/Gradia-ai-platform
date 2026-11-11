/**
 * Initiates the Aurinko OAuth flow:
 *   1. Require a logged-in user with a shop (we'll bind the connection to
 *      whichever shop the session resolves on the callback).
 *   2. Generate a random nonce, drop it in an HttpOnly cookie, and pass
 *      the same value back as the `state` parameter. The callback verifies
 *      they match before exchanging the code (CSRF protection).
 *   3. Redirect to Aurinko's hosted authorize URL.
 */

import { randomBytes } from "node:crypto"
import { redirect } from "next/navigation"
import { cookies } from "next/headers"

import { buildAuthorizeUrl } from "@/lib/aurinko"
import { resolveInteractiveOrigin } from "@/lib/request-origin"
import { safeInternalPath } from "@/lib/safe-internal-path"
import { requireShop } from "@/lib/shop"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const STATE_COOKIE = "aurinko_oauth_state"
const NEXT_COOKIE = "aurinko_oauth_next"
const STATE_COOKIE_MAX_AGE_SECONDS = 60 * 10 // 10 minutes

export async function GET(request: Request) {
  await requireShop()

  if (!process.env.AURINKO_CLIENT_ID?.trim()) {
    return new Response(
      "Aurinko is not configured on this server yet.",
      { status: 500 }
    )
  }

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

  // Where to land after the callback (the onboarding wizard passes
  // ?next=/onboarding?step=5 so the owner returns mid-flow). Strict
  // same-origin paths only (see safeInternalPath); the callback revalidates,
  // consumes and clears the cookie. A missing or rejected value clears any
  // stale cookie from an earlier attempt so it cannot leak into this flow.
  const next = safeInternalPath(new URL(request.url).searchParams.get("next"))
  if (!next) {
    cookieStore.delete(NEXT_COOKIE)
  } else {
    cookieStore.set({
      name: NEXT_COOKIE,
      value: next,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: STATE_COOKIE_MAX_AGE_SECONDS,
    })
  }

  const origin = resolveInteractiveOrigin(request)
  const authorizeUrl = buildAuthorizeUrl({
    returnUrl: `${origin}/api/aurinko/auth/callback`,
    state: nonce,
  })

  redirect(authorizeUrl)
}
