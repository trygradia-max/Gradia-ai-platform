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
import { cookies, headers } from "next/headers"

import { buildAuthorizeUrl } from "@/lib/aurinko"
import { requireShop } from "@/lib/shop"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const STATE_COOKIE = "aurinko_oauth_state"
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

export async function GET() {
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

  const origin = await resolveOrigin()
  const authorizeUrl = buildAuthorizeUrl({
    returnUrl: `${origin}/api/aurinko/auth/callback`,
    state: nonce,
  })

  redirect(authorizeUrl)
}
