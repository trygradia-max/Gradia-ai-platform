import { NextResponse, type NextRequest } from "next/server"

import { FEATURES } from "@/lib/features"
import { updateSession } from "@/lib/supabase/middleware"

// Next 16 renamed the `middleware` file convention to `proxy` (middleware is
// deprecated). Auth (Supabase session refresh) runs here as before, plus the
// MVP route gate below.
//
// Hidden-integration routes 404 when their flag is off, so a disabled surface
// looks genuinely absent. Gate, don't delete — flip the flag in features.ts to
// bring the route back. /api/stripe/webhook is intentionally NOT gated: the
// Phase-3 paywall reuses it.
const GATED_PREFIXES: ReadonlyArray<readonly [string, boolean]> = [
  [
    "/api/meta",
    FEATURES.integrations.instagram || FEATURES.integrations.facebook,
  ],
  ["/api/stripe/connect", FEATURES.integrations.payments],
]

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  for (const [prefix, enabled] of GATED_PREFIXES) {
    if (!enabled && pathname.startsWith(prefix)) {
      return new NextResponse("Not found", { status: 404 })
    }
  }
  return updateSession(request)
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
}
