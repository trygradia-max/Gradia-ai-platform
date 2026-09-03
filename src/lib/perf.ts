import { cache } from "react"

/**
 * PERF-001 — opt-in per-request query timing.
 *
 * When `PERF_TIMING=1` is set on the SERVER (never on by default, never in
 * Production config), every Supabase call made through `createClient()` is
 * timed and logged as one structured line:
 *
 *   [perf] req=<8 hex> n=<ordinal> <METHOD> <table|auth path> <ms>ms
 *
 * plus a `[perf] req=<id> done …` summary is NOT emitted (a React render has
 * no reliable "end" hook) — `scripts/perf-timing.mjs` aggregates the lines
 * per request id instead: query count, total DB ms, and the longest
 * sequential chain are the N+1 / waterfall evidence the ticket asks for.
 *
 * Privacy: only the method, the PostgREST table (or the auth endpoint name)
 * and the duration are logged. Query strings — which carry shop ids and
 * filter values — are never written.
 *
 * Request scoping uses React `cache()`, which is per server request inside a
 * React Server Components render (layout + page + every server component in
 * the tree share one id). Outside a render (route handlers, crons) `cache`
 * falls back to a fresh id per call, so a line is still attributable.
 */

export const PERF_TIMING_ENABLED = process.env.PERF_TIMING === "1"

type Collector = { id: string; n: number; startedAt: number }

const getCollector = cache((): Collector => ({
  id: Math.random().toString(16).slice(2, 10),
  n: 0,
  startedAt: Date.now(),
}))

/** Table name for a PostgREST URL, or the auth endpoint's last segment. */
function describe(url: string): string {
  try {
    const u = new URL(url)
    const parts = u.pathname.split("/").filter(Boolean)
    const restIdx = parts.indexOf("v1")
    if (parts[0] === "rest" && restIdx >= 0) {
      const table = parts[restIdx + 1] ?? "?"
      return table === "rpc" ? `rpc/${parts[restIdx + 2] ?? "?"}` : table
    }
    if (parts[0] === "auth") return `auth/${parts[parts.length - 1] ?? "?"}`
    return parts.slice(0, 2).join("/") || "/"
  } catch {
    return "?"
  }
}

/**
 * A `fetch` that times each call and logs it. Returned only when the flag is
 * on; callers pass `undefined` otherwise so the client uses the platform fetch.
 */
export function perfFetch(): typeof fetch | undefined {
  if (!PERF_TIMING_ENABLED) return undefined
  return async (input, init) => {
    const collector = getCollector()
    const n = ++collector.n
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    const method = init?.method ?? (typeof input !== "string" && !(input instanceof URL) ? input.method : "GET")
    const t0 = performance.now()
    try {
      return await fetch(input, init)
    } finally {
      const ms = Math.round(performance.now() - t0)
      const sinceStart = Date.now() - collector.startedAt
      console.info(
        `[perf] req=${collector.id} n=${n} t=${sinceStart} ${method} ${describe(url)} ${ms}ms`
      )
    }
  }
}
