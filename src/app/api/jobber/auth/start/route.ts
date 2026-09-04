/**
 * Initiates the Jobber OAuth flow. Mirrors the Aurinko start route:
 *   1. Require a logged-in user with a shop.
 *   2. Drop a CSRF nonce into an HttpOnly cookie; pass it as `state`.
 *   3. Redirect to Jobber's hosted authorize URL.
 *
 * The callback verifies the state cookie before exchanging the code.
 */

import { randomBytes } from "node:crypto"
import { redirect } from "next/navigation"
import { cookies } from "next/headers"

import { buildAuthorizeUrl } from "@/lib/jobber"
import { resolveInteractiveOrigin } from "@/lib/request-origin"
import { requireShop } from "@/lib/shop"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const STATE_COOKIE = "jobber_oauth_state"
const STATE_COOKIE_MAX_AGE_SECONDS = 60 * 10 // 10 minutes

export async function GET(request: Request) {
  await requireShop()

  if (!process.env.JOBBER_CLIENT_ID?.trim()) {
    return new Response("Jobber is not configured on this server yet.", {
      status: 500,
    })
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

  const origin = resolveInteractiveOrigin(request)
  const authorizeUrl = buildAuthorizeUrl({
    redirectUri: `${origin}/api/jobber/auth/callback`,
    state: nonce,
  })

  redirect(authorizeUrl)
}
