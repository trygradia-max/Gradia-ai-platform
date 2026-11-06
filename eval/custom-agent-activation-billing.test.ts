import { beforeEach, describe, expect, it, vi } from "vitest"

import { COMMERCIAL_CATALOG_VERSION, FOUNDER_PILOT_PRICE } from "@/lib/commercial-billing"

// ---- doubles (no network, no database) ----
const SHOP = "00000000-0000-4000-8000-0000000000a1"
const USER = "00000000-0000-4000-8000-0000000000b1"

type Row = { id: string; enabled: boolean }
const state = {
  rows: [] as Row[],
  updates: [] as { enabled: boolean; id?: string }[],
  inserts: [] as Record<string, unknown>[],
  rpcCalls: [] as string[],
  snapshot: null as unknown,
  runtime: { ok: false, reason: "billing_unconfigured" } as unknown,
  runtimeCalls: 0,
}

function builder(table: string) {
  const filters: Record<string, unknown> = {}
  let mode: "select" | "count" | "update" | "insert" = "select"
  let patch: { enabled: boolean } | null = null
  const run = () => {
    if (table !== "custom_agents") throw new Error(`unexpected table ${table}`)
    if (mode === "update") {
      state.updates.push({ enabled: patch!.enabled, id: filters.id as string })
      return { error: null }
    }
    const rows = state.rows.filter((r) => (filters.id === undefined || r.id === filters.id) && (filters.enabled === undefined || r.enabled === filters.enabled))
    return mode === "count" ? { count: rows.length, error: null } : { data: rows[0] ?? null, error: null }
  }
  const api: Record<string, unknown> = {
    select(_cols: string, opts?: { count?: string }) { if (opts?.count) mode = "count"; return api },
    update(p: { enabled: boolean }) { mode = "update"; patch = p; return api },
    insert(values: Record<string, unknown>) {
      mode = "insert"
      state.inserts.push(values)
      return { select: () => ({ single: async () => ({ data: { id: "new", ...values }, error: null }) }) }
    },
    eq(col: string, value: unknown) { filters[col] = value; return api },
    maybeSingle: async () => run(),
    then(resolve: (v: unknown) => unknown) { return Promise.resolve(run()).then(resolve) },
  }
  return api
}

const supabase = {
  from: (table: string) => builder(table),
  rpc: async (name: string) => {
    state.rpcCalls.push(name)
    if (name === "commercial_billing_read") return { data: state.snapshot, error: null }
    return { data: null, error: { code: "XX000", message: "unexpected rpc in unit test" } }
  },
}

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/lib/shop", () => ({
  requireUser: async () => ({ id: USER }),
  requireShop: async () => ({ id: SHOP, name: "Test Shop" }),
}))
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => supabase }))
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => supabase }))
vi.mock("@/lib/commercial-billing-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/commercial-billing-service")>()
  return {
    ...actual,
    resolveBillingRuntime: () => {
      state.runtimeCalls += 1
      return state.runtime
    },
  }
})

import { saveCustomAgent, setCustomAgentEnabled } from "@/app/actions/custom-agents"
import { FOUNDER_PILOT_POLICY } from "@/lib/approved-commercial-catalog"

const activeSnapshot = () => ({
  shop_id: SHOP,
  account: {
    state: "active", state_reason: null, catalog_version: COMMERCIAL_CATALOG_VERSION, plan_key: "founder-pilot",
    provider_mode: "test", has_platform_customer: true, version: 4,
  },
  attempt: null,
  evidence: {
    id: "00000000-0000-4000-8000-0000000000e1", derived_state: "active", provider_status: "active",
    catalog_version: COMMERCIAL_CATALOG_VERSION, plan_key: "founder-pilot", price_lookup_key: FOUNDER_PILOT_PRICE.lookupKey,
    evidence_source: "signed_webhook", livemode: false,
  },
})

beforeEach(() => {
  state.rows = []
  state.updates = []
  state.inserts = []
  state.rpcCalls = []
  state.runtimeCalls = 0
  state.snapshot = { shop_id: SHOP, account: null }
  state.runtime = { ok: false, reason: "billing_unconfigured" }
})

const plan = {
  name: "Quote follow-up after 7 days",
  short_description: "We nudge quoted leads who went quiet.",
  trigger: { kind: "schedule", schedule_summary: "every day at 9am" },
  audience: { entity: "leads", filters_summary: ["still in quoted status", "older than 7 days"] },
  action: { kind: "draft_sms", intent_summary: "a warm nudge to come back and book if they're still interested" },
  prerequisites_needed: ["Twilio number connected"],
  human_in_the_loop_note: "Every outbound message still lands as an approval card before it sends.",
  recipe: { id: "lead_followup_sms", params: { status: "quoted", min_lead_age_days: 7, no_inbound_within_days: 3 } },
  schedule: { cadence: "daily", hour_of_day: 14 },
} as never

describe("agent activation boundary (billing)", () => {
  it("creating a draft never requests billing", async () => {
    const saved = await saveCustomAgent({ problem_text: "Follow up on old quotes", config: plan })
    expect(saved.ok).toBe(true)
    // A draft is saved disabled and billing is never consulted.
    expect(state.inserts).toHaveLength(1)
    expect(state.inserts[0].enabled).toBe(false)
    expect(state.runtimeCalls).toBe(0)
    expect(state.rpcCalls).toEqual([])
  })

  it("first activation requests billing and, with billing unconfigured, does not activate", async () => {
    state.rows = [{ id: "a1", enabled: false }]
    const result = await setCustomAgentEnabled({ agent_id: "a1", enabled: true })
    expect(result).toMatchObject({ ok: false, blocked: { proceed: false, code: "billing_unconfigured" } })
    expect(state.updates).toEqual([])
    expect(state.runtimeCalls).toBe(1)
  })

  it("activates only when reviewed active evidence exists, then runs the existing update", async () => {
    state.rows = [{ id: "a1", enabled: false }]
    state.runtime = { ok: true, stripe: {}, returnOrigin: "https://app.gradia.example" }
    state.snapshot = activeSnapshot()
    expect(await setCustomAgentEnabled({ agent_id: "a1", enabled: true })).toEqual({ ok: true })
    expect(state.updates).toEqual([{ enabled: true, id: "a1" }])
  })

  it("a pending, past-due or mismatched subscription never reaches the update", async () => {
    state.rows = [{ id: "a1", enabled: false }]
    state.runtime = { ok: true, stripe: {}, returnOrigin: "https://app.gradia.example" }
    for (const mutate of [
      (s: ReturnType<typeof activeSnapshot>) => { s.account.state = "past_due" },
      (s: ReturnType<typeof activeSnapshot>) => { s.account.state = "canceled" },
      (s: ReturnType<typeof activeSnapshot>) => { s.account.state = "unknown" },
      (s: ReturnType<typeof activeSnapshot>) => { s.account.catalog_version = "2025-01-01.v1" },
      (s: ReturnType<typeof activeSnapshot>) => { s.evidence.evidence_source = "browser_redirect" },
    ]) {
      const snap = activeSnapshot()
      mutate(snap)
      state.snapshot = snap
      const result = await setCustomAgentEnabled({ agent_id: "a1", enabled: true })
      expect(result.ok).toBe(false)
    }
    expect(state.updates).toEqual([])
  })

  it("a read failure fails closed", async () => {
    state.rows = [{ id: "a1", enabled: false }]
    state.runtime = { ok: true, stripe: {}, returnOrigin: "https://app.gradia.example" }
    state.snapshot = { not: "a snapshot" }
    const result = await setCustomAgentEnabled({ agent_id: "a1", enabled: true })
    expect(result).toMatchObject({ ok: false, blocked: { code: "billing_state_unavailable" } })
    expect(state.updates).toEqual([])
  })

  it("the active-agent entitlement still holds with an active subscription", async () => {
    expect(FOUNDER_PILOT_POLICY.includedActiveAgents).toBe(2)
    state.rows = [{ id: "a1", enabled: true }, { id: "a2", enabled: true }, { id: "a3", enabled: false }]
    state.runtime = { ok: true, stripe: {}, returnOrigin: "https://app.gradia.example" }
    state.snapshot = activeSnapshot()
    const result = await setCustomAgentEnabled({ agent_id: "a3", enabled: true })
    expect(result).toMatchObject({ ok: false, blocked: { code: "active_agent_limit_reached" } })
    expect(state.updates).toEqual([])
    expect(state.rpcCalls).toEqual([]) // refused before billing was even read
  })

  it("the second agent is allowed under the limit", async () => {
    state.rows = [{ id: "a1", enabled: true }, { id: "a2", enabled: false }]
    state.runtime = { ok: true, stripe: {}, returnOrigin: "https://app.gradia.example" }
    state.snapshot = activeSnapshot()
    expect(await setCustomAgentEnabled({ agent_id: "a2", enabled: true })).toEqual({ ok: true })
  })

  it("turning an agent off is never gated by billing", async () => {
    state.rows = [{ id: "a1", enabled: true }]
    expect(await setCustomAgentEnabled({ agent_id: "a1", enabled: false })).toEqual({ ok: true })
    expect(state.updates).toEqual([{ enabled: false, id: "a1" }])
    expect(state.runtimeCalls).toBe(0)
    expect(state.rpcCalls).toEqual([])
  })

  it("re-enabling an already-enabled agent is a no-op that is not re-gated", async () => {
    state.rows = [{ id: "a1", enabled: true }]
    expect(await setCustomAgentEnabled({ agent_id: "a1", enabled: true })).toEqual({ ok: true })
    expect(state.rpcCalls).toEqual([])
  })

  it("an agent that is not in this workspace is not found and not gated", async () => {
    state.rows = []
    const result = await setCustomAgentEnabled({ agent_id: "someone-elses", enabled: true })
    expect(result).toEqual({ ok: false, error: "Agent not found." })
    expect(state.updates).toEqual([])
  })
})
