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
  writerArgs: [] as Record<string, unknown>[],
  writer: (() => ({ data: { outcome: "blocked", code: "billing_not_active" }, error: null })) as (
    a: Record<string, unknown>
  ) => { data: unknown; error: unknown },
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
  rpc: async (name: string, args?: Record<string, unknown>) => {
    state.rpcCalls.push(name)
    if (name === "commercial_billing_read") return { data: state.snapshot, error: null }
    if (name === "commercial_agent_activate") {
      state.writerArgs.push(args ?? {})
      return state.writer(args ?? {})
    }
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
  state.writerArgs = []
  state.writer = () => ({ data: { outcome: "blocked", code: "billing_not_active" }, error: null })
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
    expect(state.writerArgs).toEqual([{ p_shop: SHOP, p_actor: USER, p_agent: "a1" }])
  })

  it("never writes `enabled` itself and never sends an application-supplied count", async () => {
    state.rows = [{ id: "a1", enabled: false }]
    state.runtime = { ok: true, stripe: {}, returnOrigin: "https://app.gradia.example" }
    state.writer = () => ({ data: { outcome: "activated", code: null, active_count: 1 }, error: null })
    expect(await setCustomAgentEnabled({ agent_id: "a1", enabled: true })).toEqual({ ok: true })
    expect(state.updates).toEqual([]) // the database writer is the only enabling write
    expect(Object.keys(state.writerArgs[0]).sort()).toEqual(["p_actor", "p_agent", "p_shop"])
    expect(state.rows.length).toBe(1)
  })

  it("the database writer's refusals never become activation", async () => {
    state.runtime = { ok: true, stripe: {}, returnOrigin: "https://app.gradia.example" }
    const cases: [unknown, unknown, string][] = [
      [{ outcome: "blocked", code: "active_agent_limit_reached" }, null, "active_agent_limit_reached"],
      [{ outcome: "blocked", code: "agent_not_found" }, null, "agent_not_found"],
      [{ outcome: "blocked", code: "catalog_mismatch" }, null, "catalog_mismatch"],
      [{ outcome: "blocked", code: "something_new" }, null, "billing_state_unavailable"],
      [{ outcome: "activated-ish" }, null, "billing_state_unavailable"],
      [null, null, "billing_state_unavailable"],
      [null, { code: "42501", message: "Live owner of this workspace required" }, "owner_required"],
      [null, { code: "XX000", message: "boom" }, "billing_state_unavailable"],
    ]
    for (const [data, error, code] of cases) {
      state.writer = () => ({ data, error })
      const result = await setCustomAgentEnabled({ agent_id: "a1", enabled: true })
      expect(result, code).toMatchObject({ ok: false, blocked: { code } })
    }
    expect(state.updates).toEqual([])
  })

  it("billing_not_active hands back the server-created Checkout path, not an activation", async () => {
    state.runtime = { ok: true, stripe: {}, returnOrigin: "https://app.gradia.example" }
    state.snapshot = { shop_id: SHOP, account: null }
    state.writer = () => ({ data: { outcome: "blocked", code: "billing_not_active" }, error: null })
    const result = await setCustomAgentEnabled({ agent_id: "a1", enabled: true })
    expect(result.ok).toBe(false)
    expect(state.updates).toEqual([])
  })

  it("a display read that looks eligible cannot override a database refusal", async () => {
    state.runtime = { ok: true, stripe: {}, returnOrigin: "https://app.gradia.example" }
    state.snapshot = activeSnapshot()
    state.writer = () => ({ data: { outcome: "blocked", code: "billing_not_active" }, error: null })
    const result = await setCustomAgentEnabled({ agent_id: "a1", enabled: true })
    expect(result).toMatchObject({ ok: false, blocked: { code: "reconciliation_required", billing: { eligibleToActivate: false } } })
  })

  it("a service client that cannot be built fails closed", async () => {
    // billing_state_unavailable without any writer call
    const mod = await import("@/lib/agent-os/activation")
    const decision = await mod.authorizeAgentActivation(
      {
        sessionClient: supabase as never,
        serviceClient: () => {
          throw new Error("no service key")
        },
        runtime: { ok: false, reason: "billing_unconfigured" } as never,
      },
      { shopId: SHOP, actorId: USER, agentId: "a1", existing: { ready: true } }
    )
    expect(decision).toMatchObject({ proceed: false, code: "billing_state_unavailable" })
    expect(state.writerArgs).toEqual([])
  })

  it("existing readiness gates run before billing or the writer", async () => {
    const mod = await import("@/lib/agent-os/activation")
    const decision = await mod.authorizeAgentActivation(
      { sessionClient: supabase as never, serviceClient: () => supabase as never, runtime: { ok: false, reason: "billing_unconfigured" } as never },
      { shopId: SHOP, actorId: USER, agentId: "a1", existing: { ready: false, reasons: ["policy_not_reviewed"] } }
    )
    expect(decision).toMatchObject({ proceed: false, code: "existing_gate_blocked", billing: null, reasons: ["policy_not_reviewed"] })
    expect(state.writerArgs).toEqual([])
    expect(state.rpcCalls).toEqual([])
  })

  it("the entitlement is the database's number: Founder Pilot maximum is two", () => {
    expect(FOUNDER_PILOT_POLICY.includedActiveAgents).toBe(2)
  })

  it("turning an agent off is never gated by billing", async () => {
    state.rows = [{ id: "a1", enabled: true }]
    expect(await setCustomAgentEnabled({ agent_id: "a1", enabled: false })).toEqual({ ok: true })
    expect(state.updates).toEqual([{ enabled: false, id: "a1" }])
    expect(state.runtimeCalls).toBe(0)
    expect(state.rpcCalls).toEqual([])
  })

  it("an already-active agent is an idempotent no-op decided by the database", async () => {
    state.writer = () => ({ data: { outcome: "already_active", code: null }, error: null })
    expect(await setCustomAgentEnabled({ agent_id: "a1", enabled: true })).toEqual({ ok: true })
    expect(state.updates).toEqual([])
  })
})
