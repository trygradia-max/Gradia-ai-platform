import { createServerClient } from "@supabase/ssr"
import { type NextRequest, NextResponse } from "next/server"

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request,
  })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) {
    return supabaseResponse
  }

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value)
        )
        supabaseResponse = NextResponse.next({
          request,
        })
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options)
        )
      },
    },
  })

  const path = request.nextUrl.pathname

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user && pathRequiresSession(path)) {
    const redirectUrl = request.nextUrl.clone()
    redirectUrl.pathname = "/login"
    // Only `next` is carried. The original query travels inside it, never as stray `/login` parameters.
    redirectUrl.search = ""
    redirectUrl.searchParams.set("next", `${path}${request.nextUrl.search}`)
    return NextResponse.redirect(redirectUrl)
  }

  if (user && path === "/login") {
    const redirectUrl = request.nextUrl.clone()
    redirectUrl.pathname = "/dashboard"
    redirectUrl.search = ""
    return NextResponse.redirect(redirectUrl)
  }

  return supabaseResponse
}

/**
 * Signed-in route prefixes. A signed-out visitor to any of these is redirected to
 * `/login?next=<path+query>` here, before render, so the original destination survives sign-in
 * (the callback still validates `next`). Pages also fail closed on their own; this gate exists so a
 * deep link keeps its return path instead of falling through `requireUser()` -> `/login` (no
 * `next`) or `requireShop()` -> `/onboarding` -> `/login?next=/onboarding`.
 *
 * Every page route is either listed here or in `PUBLIC_PAGE_PATHS`; `eval/proxy-auth-gate.test.ts`
 * fails when a new page route is added to neither.
 */
export const SIGNED_IN_PREFIXES = [
  "/dashboard",
  "/leads",
  "/schedule",
  "/settings",
  "/onboarding",
  "/agents",
  "/agent",
  "/approvals",
  "/activity",
  "/billing",
  "/calendar",
  "/calls",
  "/chat",
  "/control-center",
  "/conversations",
  "/customers",
  "/intake",
  "/receptionist",
  "/recovery",
  "/starting-point",
  "/team",
] as const

/** Page routes that are intentionally reachable while signed out. `/q/[token]` is a customer quote link. */
export const PUBLIC_PAGE_PATHS = ["/", "/login", "/how-it-works", "/q/[token]"] as const

export function pathRequiresSession(pathname: string): boolean {
  return SIGNED_IN_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}
