import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"

// Authentication redirects must never derive authority from request headers or URLs.
const PRODUCTION_ORIGIN = "https://gradia-ai-platform.vercel.app"
const DEFAULT_PATH = "/dashboard"

// Off Vercel, the operator-configured loopback dashboard is the only origin
// that may replace production. A non-loopback value does not.
function loopbackDashboardOrigin(): string | null {
  if (process.env.VERCEL === "1") return null
  const raw = process.env.GRADIA_DASHBOARD_URL?.trim() ?? ""
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.username || url.password) return null
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return null
    return url.origin
  } catch {
    return null
  }
}

// Opt-in is deployment-local. VERCEL_URL is server/platform configuration, never
// request authority. Restrict it to this project's generated deployment hostnames.
function trustedOrigin(): string | null {
  const mode = process.env.GRADIA_PRIVATE_REVIEW_AUTH
  if (mode && mode !== "0") {
    const host = process.env.VERCEL_URL ?? ""
    if (mode !== "1" || process.env.VERCEL !== "1" ||
        !/^gradia-ai-platform-[a-z0-9]+-gradia1\.vercel\.app$/.test(host)) return null
    return `https://${host}`
  }
  return loopbackDashboardOrigin() ?? PRODUCTION_ORIGIN
}

function safeDestination(next: string | null, callback: URL, origin: string): URL {
  const fallback = new URL(DEFAULT_PATH, origin)
  if (!next) return fallback
  let decoded = next
  try {
    // Inspect each encoding layer before URL normalization can hide separators.
    for (let depth = 0; depth < 8; depth++) {
      if (!decoded.startsWith("/") || decoded.startsWith("//") ||
          decoded.includes("\\") || [...decoded].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return fallback
      const path = decoded.split(/[?#]/, 1)[0]
      if (path.split("/").some(segment => segment === "." || segment === "..")) return fallback
      const candidate = new URL(decoded, origin)
      if (candidate.origin !== origin || candidate.username || candidate.password) return fallback
      // Do not propagate credentials through next's query, fragment or path.
      const sensitive = /(?:code|token|secret|password|authorization|state|error_description)/i
      for (const key of candidate.searchParams.keys()) if (sensitive.test(key)) return fallback
      if (sensitive.test(candidate.hash)) return fallback
      for (const [key, value] of callback.searchParams) {
        if (key !== "next" && sensitive.test(key) && value && decoded.includes(value)) return fallback
      }
      if (!decoded.includes("%")) return new URL(next, origin)
      decoded = decodeURIComponent(decoded)
    }
  } catch {
    // Malformed or excessively nested encodings fail closed without logging input.
  }
  return fallback
}

export async function GET(request: Request) {
  const origin = trustedOrigin()
  if (!origin) {
    return new Response("Authentication configuration unavailable", {
      status: 503, headers: { "Cache-Control": "no-store" },
    })
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) {
    return NextResponse.redirect(new URL("/login?error=config", origin))
  }

  const callback = new URL(request.url)
  const { searchParams } = callback
  const code = searchParams.get("code")
  const destination = safeDestination(searchParams.get("next"), callback, origin)

  if (code) {
    const cookieStore = await cookies()
    const supabase = createServerClient(url, anonKey, {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          )
        },
      },
    })

    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      return NextResponse.redirect(destination)
    }
  }

  return NextResponse.redirect(new URL("/login?error=auth", origin))
}
