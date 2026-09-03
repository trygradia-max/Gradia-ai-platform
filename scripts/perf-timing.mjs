// PERF-001 — response-time sampler (manual tool, not a CI gate).
//
// Hits each dashboard route N times with an owner session cookie and prints
// p50 / p75 / p95 time-to-first-byte and full-response time. Optionally
// aggregates the server's `[perf]` query log (PERF_TIMING=1 on the server,
// stdout redirected to a file) into queries-per-request and DB time.
//
//   PERF_COOKIE='sb-...-auth-token=...' node scripts/perf-timing.mjs \
//     --base http://localhost:3100 --samples 20 \
//     [--routes /dashboard,/approvals,/customers,/conversations,/settings] \
//     [--server-log /tmp/next-perf.log]
//
// The cookie is the browser's document.cookie after signing in (the
// @supabase/ssr auth cookies are readable by the page). Nothing here writes
// to any environment; it only reads.

const args = process.argv.slice(2)
const opt = (flag, fallback) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : fallback
}

const BASE = (opt("--base", "http://localhost:3100")).replace(/\/$/, "")
const SAMPLES = Number.parseInt(opt("--samples", "20"), 10)
const ROUTES = opt(
  "--routes",
  "/dashboard,/approvals,/customers,/conversations,/settings"
).split(",")
const SERVER_LOG = opt("--server-log", null)
const COOKIE = process.env.PERF_COOKIE
if (!COOKIE) {
  console.error("PERF_COOKIE is required (the signed-in browser's document.cookie).")
  process.exit(1)
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return { p50: pct(s, 50), p75: pct(s, 75), p95: pct(s, 95), min: s[0], max: s[s.length - 1] }
}

async function sample(route) {
  const t0 = performance.now()
  const res = await fetch(BASE + route, {
    headers: { cookie: COOKIE, accept: "text/html" },
    redirect: "manual",
  })
  const ttfb = performance.now() - t0
  const body = await res.text()
  const total = performance.now() - t0
  return { status: res.status, ttfb, total, bytes: body.length, serverTiming: res.headers.get("server-timing") }
}

async function readLogSize() {
  if (!SERVER_LOG) return 0
  const { statSync } = await import("node:fs")
  try {
    return statSync(SERVER_LOG).size
  } catch {
    return 0
  }
}

async function analyzeLog(fromByte) {
  if (!SERVER_LOG) return null
  const { readFileSync } = await import("node:fs")
  const text = readFileSync(SERVER_LOG, "utf8").slice(fromByte)
  const byReq = new Map()
  for (const line of text.split("\n")) {
    const m = line.match(/\[perf\] req=(\w+) n=(\d+) t=(\d+) (\w+) (\S+) (\d+)ms/)
    if (!m) continue
    const [, req, , t, method, target, ms] = m
    if (!byReq.has(req)) byReq.set(req, [])
    byReq.get(req).push({ t: Number(t), method, target, ms: Number(ms) })
  }
  const reqs = [...byReq.values()]
  if (reqs.length === 0) return { requests: 0 }
  const counts = reqs.map((q) => q.length)
  const dbMs = reqs.map((q) => q.reduce((s, x) => s + x.ms, 0))
  // Longest sequential chain ≈ the span from first query start to last query end.
  const span = reqs.map((q) => Math.max(...q.map((x) => x.t + x.ms)) - Math.min(...q.map((x) => x.t)))
  const targets = new Map()
  for (const q of reqs) for (const x of q) {
    const cur = targets.get(x.target) ?? { n: 0, ms: 0 }
    cur.n += 1
    cur.ms += x.ms
    targets.set(x.target, cur)
  }
  const topTargets = [...targets.entries()]
    .sort((a, b) => b[1].ms - a[1].ms)
    .slice(0, 8)
    .map(([target, v]) => `${target}×${(v.n / reqs.length).toFixed(1)} ${Math.round(v.ms / reqs.length)}ms`)
  return {
    requests: reqs.length,
    queriesPerRequest: stats(counts),
    dbMsPerRequest: stats(dbMs),
    querySpanMs: stats(span),
    topTargets,
  }
}

const results = []
for (const route of ROUTES) {
  // Warm once so the first sample is not a cold module load.
  await sample(route)
  const logFrom = await readLogSize()
  const runs = []
  for (let i = 0; i < SAMPLES; i++) runs.push(await sample(route))
  const bad = runs.filter((r) => r.status !== 200)
  if (bad.length) {
    console.error(`${route}: ${bad.length}/${runs.length} non-200 (${bad[0].status}) — cookie invalid or route redirected`)
  }
  const ttfb = stats(runs.map((r) => r.ttfb))
  const total = stats(runs.map((r) => r.total))
  const log = await analyzeLog(logFrom)
  results.push({ route, ttfb, total, bytes: runs[0].bytes, log })
}

const r = (n) => String(Math.round(n)).padStart(5)
console.log(`\nbase=${BASE} samples=${SAMPLES}\n`)
console.log("route            ttfb p50   p75   p95 | total p50   p75 | html KB | q/req  db ms/req  span ms")
for (const x of results) {
  const q = x.log && x.log.requests
    ? `${x.log.queriesPerRequest.p50.toString().padStart(4)}   ${r(x.log.dbMsPerRequest.p50)}     ${r(x.log.querySpanMs.p50)}`
    : "   —"
  console.log(
    `${x.route.padEnd(16)} ${r(x.ttfb.p50)} ${r(x.ttfb.p75)} ${r(x.ttfb.p95)} |     ${r(x.total.p50)} ${r(x.total.p75)} | ${String(Math.round(x.bytes / 1024)).padStart(6)} | ${q}`
  )
}
for (const x of results) {
  if (x.log?.topTargets?.length) console.log(`\n${x.route} top queries (per request avg): ${x.log.topTargets.join(" · ")}`)
}
