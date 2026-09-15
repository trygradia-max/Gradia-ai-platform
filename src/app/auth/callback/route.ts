import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"

// Authentication redirects must never derive authority from request headers or URLs.
const PRODUCTION_ORIGIN = "https://gradia-ai-platform.vercel.app"
const DEFAULT_PATH = "/dashboard"

function safeDestination(next: string | null, callback: URL): URL {
  const fallback = new URL(DEFAULT_PATH, PRODUCTION_ORIGIN)
  if (!next) return fallback
  let decoded = next
  try {
    // Inspect each encoding layer before URL normalization can hide separators.
    for (let depth = 0; depth < 8; depth++) {
      if (!decoded.startsWith("/") || decoded.startsWith("//") ||
          decoded.includes("\\") || [...decoded].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return fallback
      const path = decoded.split(/[?#]/, 1)[0]
      if (path.split("/").some(segment => segment === "." || segment === "..")) return fallback
      const candidate = new URL(decoded, PRODUCTION_ORIGIN)
      if (candidate.origin !== PRODUCTION_ORIGIN || candidate.username || candidate.password) return fallback
      // Do not propagate credentials through next's query, fragment or path.
      const sensitive = /(?:code|token|secret|password|authorization|state|error_description)/i
      for (const key of candidate.searchParams.keys()) if (sensitive.test(key)) return fallback
      if (sensitive.test(candidate.hash)) return fallback
      for (const [key, value] of callback.searchParams) {
        if (key !== "next" && sensitive.test(key) && value && decoded.includes(value)) return fallback
      }
      if (!decoded.includes("%")) return new URL(next, PRODUCTION_ORIGIN)
      decoded = decodeURIComponent(decoded)
    }
  } catch {
    // Malformed or excessively nested encodings fail closed without logging input.
  }
  return fallback
}

export async function GET(request: Request) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) {
    return NextResponse.redirect(new URL("/login?error=config", PRODUCTION_ORIGIN))
  }

  const callback = new URL(request.url)
  const { searchParams } = callback
  const code = searchParams.get("code")
  const destination = safeDestination(searchParams.get("next"), callback)

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

  return NextResponse.redirect(new URL("/login?error=auth", PRODUCTION_ORIGIN))
}
