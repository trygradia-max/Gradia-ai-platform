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

function pathRequiresSession(pathname: string): boolean {
  if (pathname === "/") {
    return false
  }
  const protectedPrefixes = [
    "/dashboard",
    "/leads",
    "/schedule",
    "/settings",
    "/onboarding",
  ]
  return protectedPrefixes.some((p) => pathname.startsWith(p))
}
