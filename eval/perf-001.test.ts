import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * PERF-001 — response-time fixes, locked.
 *
 *   1. Query-shape locks on the Home loaders (a counting Supabase stub, no
 *      DB): `loadTodayMoney` issues its independent reads in one batch and
 *      never per row; the Home lead feed asks for a small cap and the heat
 *      context fans out over that cap only.
 *   2. `capPipelineCards` keeps the newest N per stage, keeps totals over ALL
 *      cards (D-025 — the number stays true), and reports what it hid.
 *   3. `perfFetch()` is inert unless PERF_TIMING=1, and when on it logs the
 *      method + table only — never a query string.
 *   4. Source locks: request-scoped memo on user/shop resolution; the
 *      Approvals list keeps its cards memoized behind stable handlers; the
 *      seed tool is loopback-only; NO index migration ships with this ticket
 *      (every hot filter already used an index in the recorded plans).
 */

const ROOT = decodeURIComponent(new URL("../", import.meta.url).pathname)
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8")

// ---------- a counting Supabase stub ----------

type Call = { table: string; select?: string; limit?: number; inCol?: string; inLen?: number; createdAfterResolves: number }
const calls: Call[] = []
let resolves = 0
let tableData: Record<string, unknown[]> = {}

function builder(table: string) {
  const call: Call = { table, createdAfterResolves: resolves }
  calls.push(call)
  const b: Record<string, unknown> = {}
  const chain = () => b
  for (const m of ["eq", "neq", "gte", "lt", "lte", "order", "single", "maybeSingle", "or", "not", "is"]) b[m] = chain
  b.select = (cols?: string) => {
    call.select = cols
    return b
  }
  b.limit = (n: number) => {
    call.limit = n
    return b
  }
  b.in = (col: string, vals: unknown[]) => {
    call.inCol = col
    call.inLen = vals.length
    return b
  }
  b.then = (resolve: (v: unknown) => void) => {
    queueMicrotask(() => {
      resolves += 1
      const data = tableData[table] ?? []
      resolve({ data, error: null, count: data.length })
    })
  }
  return b
}

vi.mock("@/lib/shop", () => ({
  requireShop: async () => ({ id: "shop-a", name: "Shop A" }),
  getOptionalShop: async () => ({ id: "shop-a", name: "Shop A" }),
}))
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: (t: string) => builder(t), rpc: () => builder("rpc") }),
}))

beforeEach(() => {
  calls.length = 0
  resolves = 0
  tableData = {}
})

describe("PERF-001 §1 — Home loader query shapes", () => {
  it("loadTodayMoney: every independent read is in the first batch, follow-ups are one batch, nothing per row", async () => {
    const { loadTodayMoney } = await import("@/lib/data/today-money")
    tableData = {
      interactions: [{ metadata: { kind: "job_status", to: "completed", appointment_id: "a1" } }],
      leads: Array.from({ length: 30 }, (_, i) => ({ id: `l${i}`, status: "quoted", stage: "quote_sent", quote_id: `q${i}`, est_value_cents: 100, created_at: new Date().toISOString() })),
      automation_runs: Array.from({ length: 12 }, (_, i) => ({ lead_id: `l${i}`, status: "staged" })),
      quotes: [{ id: "q1", total_cents: 500 }],
      appointments: [{ quoted_amount_cents: 100, internal_note: null }],
    }
    await loadTodayMoney()
    const first = calls.filter((c) => c.createdAfterResolves === 0)
    // 8 independent reads issued before anything resolved (was 7 + a
    // sequential all-leads select before PERF-001).
    expect(first.length).toBe(8)
    expect(first.map((c) => c.table).sort()).toEqual(
      ["appointments", "automation_runs", "automation_runs", "interactions", "leads", "leads", "leads", "quotes"].sort()
    )
    // The follow-ups (completed jobs, live quotes, touched leads) are one
    // batch — all created after the same number of resolutions.
    const followUps = calls.filter((c) => c.createdAfterResolves > 0)
    expect(followUps.length).toBeGreaterThanOrEqual(3)
    expect(new Set(followUps.slice(0, 3).map((c) => c.createdAfterResolves)).size).toBe(1)
    // Bounded: never more than 12 queries regardless of row counts.
    expect(calls.length).toBeLessThanOrEqual(12)
  })

  it("listScoredLeadsForCurrentShop(cap): asks for the cap and fans the heat context out over the cap only", async () => {
    const { listScoredLeadsForCurrentShop } = await import("@/lib/data/leads")
    tableData = {
      leads: Array.from({ length: 8 }, (_, i) => ({ id: `l${i}`, customer_id: `c${i}`, customer_name: "x", phone: "1", status: "new", created_at: new Date().toISOString(), car_info: null, pin_notes: null })),
    }
    const rows = await listScoredLeadsForCurrentShop(8)
    expect(rows.length).toBe(8)
    const leadSelect = calls.find((c) => c.table === "leads")
    expect(leadSelect?.limit).toBe(8)
    for (const c of calls.filter((c) => c.inCol === "customer_id")) {
      expect(c.inLen).toBeLessThanOrEqual(8)
    }
    // Requests above the list ceiling are clamped, never unbounded.
    calls.length = 0
    tableData = { leads: [] }
    await listScoredLeadsForCurrentShop(10_000)
    expect(calls.find((c) => c.table === "leads")?.limit).toBe(500)
  })

  it("Home passes a small cap to the lead feed and links to the full list", () => {
    const page = read("src/app/(dashboard)/dashboard/page.tsx")
    expect(page).toMatch(/const HOME_LEAD_FEED_CAP = (\d+)/)
    const cap = Number(page.match(/const HOME_LEAD_FEED_CAP = (\d+)/)![1])
    expect(cap).toBeLessThanOrEqual(12)
    expect(page).toContain("listScoredLeadsForCurrentShop(HOME_LEAD_FEED_CAP)")
    expect(page).toContain("total={leadTotal}")
    expect(read("src/components/gradia/live-lead-feed.tsx")).toContain("STRINGS.pages.home.leadFeedSeeAll")
  })
})

describe("PERF-001 §2 — capPipelineCards", () => {
  it("keeps the newest N per stage, totals over all, hidden reported", async () => {
    const { capPipelineCards } = await import("@/lib/data/pipeline")
    const card = (i: number, stage: "new" | "booked") => ({
      id: `l${i}`, customerId: null, name: "n", phone: "1", stage, stageEnteredAt: null, nextActionAt: null,
      createdAt: new Date(Date.now() - i * 1000).toISOString(), vehicle: null, interest: null, quoteId: null,
      quoteTotalCents: null, estValueCents: 100, source: null, lostReason: null, hasStagedSuggestion: false,
    })
    const cards = [...Array.from({ length: 70 }, (_, i) => card(i, "new")), ...Array.from({ length: 5 }, (_, i) => card(100 + i, "booked"))]
    const out = capPipelineCards(cards, 60)
    expect(out.cards.filter((c) => c.stage === "new").length).toBe(60)
    expect(out.cards.filter((c) => c.stage === "booked").length).toBe(5)
    // Newest survive (input order is newest-first).
    expect(out.cards.find((c) => c.stage === "new")?.id).toBe("l0")
    expect(out.cards.some((c) => c.id === "l69")).toBe(false)
    expect(out.totals.new).toEqual({ count: 70, valueCents: 7000 })
    expect(out.hidden.new).toEqual({ count: 10, valueCents: 1000 })
    expect(out.hidden.booked).toEqual({ count: 0, valueCents: 0 })
    expect(out.totals.lost).toEqual({ count: 0, valueCents: 0 })
  })

  it("the board adds the hidden remainder back into its column totals and says so", () => {
    const board = read("src/components/gradia/pipeline-board.tsx")
    expect(board).toContain("items.length + off.count")
    expect(board).toContain("STRINGS.pages.customers.pipelineOlder")
  })
})

describe("PERF-001 §3 — perfFetch is opt-in and never logs query strings", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it("flag off → undefined (client keeps the platform fetch)", async () => {
    vi.stubEnv("PERF_TIMING", "")
    vi.resetModules()
    const { perfFetch } = await import("@/lib/perf")
    expect(perfFetch()).toBeUndefined()
  })

  it("flag on → one line per call with method + table, no query string, no shop id", async () => {
    vi.stubEnv("PERF_TIMING", "1")
    vi.resetModules()
    const { perfFetch } = await import("@/lib/perf")
    const timed = perfFetch()
    expect(typeof timed).toBe("function")
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("[]"))
    await timed!("http://127.0.0.1:54321/rest/v1/leads?select=*&shop_id=eq.11111111-2222-3333-4444-555555555555", { method: "GET" })
    await timed!("http://127.0.0.1:54321/auth/v1/user")
    const lines = info.mock.calls.map((c) => String(c[0]))
    expect(lines[0]).toMatch(/^\[perf\] req=\w+ n=1 t=\d+ GET leads \d+ms$/)
    expect(lines[1]).toMatch(/ auth\/user \d+ms$/)
    expect(lines.join("\n")).not.toMatch(/select=|shop_id|1111/)
  })
})

describe("PERF-001 §4 — source locks", () => {
  it("user + shop resolution is request-memoized", () => {
    const shop = read("src/lib/shop.ts")
    expect(shop).toMatch(/import \{ cache \} from "react"/)
    expect(shop).toMatch(/const getCurrentUser = cache\(/)
    expect(shop).toMatch(/export const getOptionalShop = cache\(/)
    expect(shop).toMatch(/export const listShopsForCurrentUser = cache\(/)
    expect(read("src/lib/data/channels.ts")).toMatch(/export const getChannelStatusForCurrentShop = cache\(/)
  })

  it("ApprovalCard is memoized behind referentially stable handlers", () => {
    const list = read("src/components/gradia/approvals-list.tsx")
    expect(list).toMatch(/const ApprovalCard = React\.memo\(function ApprovalCard\(/)
    expect(list).toMatch(/const handleDecision = React\.useCallback\(/)
    expect(list).toMatch(/const handleOverride = React\.useCallback\(/)
    // Position-only layout animation: siblings slide, framer never re-measures every card.
    expect(list).toContain('layout={reduce ? false : "position"}')
    // The queue is paged (12 cards + "Show N more"); the header keeps the true count.
    expect(list).toMatch(/const APPROVALS_PAGE = 12/)
    expect(list).toContain("STRINGS.pages.approvals.showMore(remaining)")
  })

  it("no index migration ships with PERF-001 (plans showed no scan to fix)", () => {
    expect(existsSync(join(ROOT, "supabase/migrations/20260902120000_perf_001_indexes.sql"))).toBe(false)
  })

  it("the perf tools exist and the seed refuses non-loopback databases", () => {
    expect(existsSync(join(ROOT, "scripts/perf-timing.mjs"))).toBe(true)
    const seed = read("scripts/perf-seed.mjs")
    expect(seed).toMatch(/127\.0\.0\.1.*localhost/)
    expect(seed).toMatch(/Refusing non-loopback/)
    expect(seed).not.toMatch(/allow-remote"\)/)
  })
})
