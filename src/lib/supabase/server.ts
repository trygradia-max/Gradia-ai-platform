import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"

import { getSupabasePublicConfig } from "@/lib/env"
import { perfFetch } from "@/lib/perf"

export async function createClient() {
  const cookieStore = await cookies()
  const { url, anonKey } = getSupabasePublicConfig()
  // PERF-001: opt-in query timing (PERF_TIMING=1) — undefined otherwise, so
  // the client keeps the platform fetch and nothing changes in Production.
  const timedFetch = perfFetch()

  return createServerClient(url, anonKey, {
    ...(timedFetch ? { global: { fetch: timedFetch } } : {}),
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          )
        } catch {
          // Called from a Server Component; middleware will refresh the session.
        }
      },
    },
  })
}
