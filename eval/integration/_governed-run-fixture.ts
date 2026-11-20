import { randomUUID } from "node:crypto"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { expect } from "vitest"

import {
  activateAgentDefinition,
  createAgentDefinitionRevision,
  setAgentDefinitionLifecycle,
} from "@/lib/agent-os/definition-store"
import { runTrustedEvaluation } from "@/lib/agent-os/evaluator/run"
import { COMMERCIAL_CATALOG_VERSION, FOUNDER_PILOT_PRICE } from "@/lib/commercial-billing"
import { initialPolicyDraft } from "@/lib/control-center/drafts"
import type { PreEffectCheck } from "@/lib/agent-os/run-lifecycle"
import { assertDisposableTarget, cleanup, ownerSessionClient, seedShop, stagePending, type Seeded } from "./_db"

/**
 * Real-Postgres fixture for governed (versioned definition) runs: a shop with an ACTIVE Control Center
 * policy, reviewed Founder Pilot billing evidence, an agent whose revision passed the REAL trusted
 * evaluator and was activated, and helpers to claim windows and drive the lifecycle RPCs.
 */
export const PW = "Synthetic-password-123!"

export function resilientService(): SupabaseClient {
  assertDisposableTarget()
  const fetchWithRetry: typeof fetch = async (input, init) => {
    let last: Response | undefined
    for (let i = 0; i < 4; i++) {
      try {
        const res = await fetch(input, init)
        if (res.status !== 502 && res.status !== 503) return res
        last = res
      } catch (e) {
        if (i === 3) throw e
      }
      await new Promise((r) => setTimeout(r, 200 * (i + 1)))
    }
    return last!
  }
  return createClient(process.env.SUPABASE_TEST_URL!, process.env.SUPABASE_TEST_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchWithRetry },
  })
}

let seq = 0
export const uniq = () => `${Date.now().toString(36)}${(++seq).toString(36)}`

export async function transient<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown
  for (let i = 0; i < 4; i++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      if (!/invalid response was received from the upstream server|createUser failed|sign-in failed|statement timeout/i.test(String((e as Error)?.message))) throw e
      await new Promise((r) => setTimeout(r, 250 * (i + 1)))
    }
  }
  throw last
}

export type World = { shop: Seeded; owner: SupabaseClient; policyRevision: number }

export function createGovernedFixture(db: SupabaseClient) {
  const seeded: Seeded[] = []

  const newUser = async (): Promise<Seeded> => {
    const s = await transient(() => seedShop(db, { password: PW }))
    seeded.push(s)
    return s
  }

  async function addMember(shopId: string, user: Seeded, role: "owner" | "manager" | "staff", active = true) {
    const r = await db
      .from("shop_memberships")
      .upsert({ shop_id: shopId, user_id: user.ownerId, role, capabilities: [], active, display_name: role }, { onConflict: "shop_id,user_id" })
    expect(r.error).toBeNull()
  }

  async function activeBilling(shop: Seeded) {
    const begin = await db.rpc("commercial_checkout_begin", {
      p_shop: shop.shopId, p_actor: shop.ownerId, p_catalog_version: COMMERCIAL_CATALOG_VERSION,
      p_plan_key: "founder-pilot", p_lookup_key: FOUNDER_PILOT_PRICE.lookupKey, p_return_target: "agents", p_fingerprint: "a".repeat(64),
    })
    expect(begin.error).toBeNull()
    const attempt = (begin.data as { attempt_id: string }).attempt_id
    const customer = `cus_Fake${uniq().replace(/[^A-Za-z0-9]/g, "")}`
    const bound = await db.rpc("commercial_checkout_bind_customer", { p_shop: shop.shopId, p_actor: shop.ownerId, p_attempt: attempt, p_customer: customer })
    expect(bound.error).toBeNull()
    const ev = await db.rpc("commercial_subscription_apply_evidence", {
      p_shop: shop.shopId, p_subscription: `sub_Fake${uniq().replace(/[^A-Za-z0-9]/g, "")}`, p_customer: customer, p_status: "active",
      p_catalog_version: COMMERCIAL_CATALOG_VERSION, p_plan_key: "founder-pilot", p_lookup_key: FOUNDER_PILOT_PRICE.lookupKey,
      p_source: "signed_webhook", p_event_id: `evt_fake_${uniq()}`, p_event_created_at: new Date(Date.now() - 60_000).toISOString(),
      p_livemode: false, p_attempt: attempt,
    })
    expect(ev.error).toBeNull()
  }

  const world = (): Promise<World> => transient(async () => {
    const shop = await newUser()
    const owner = await ownerSessionClient(shop.email, PW)
    const current = await owner.from("control_policy_drafts").select("revision").eq("shop_id", shop.shopId).single()
    const save = await owner.rpc("save_control_policy_draft", { p_shop: shop.shopId, p_expected_revision: current.data!.revision, p_definition: initialPolicyDraft() })
    if (save.error) throw save.error
    const act = await owner.rpc("activate_control_policy", { p_shop: shop.shopId, p_revision: save.data, p_expected_active: null })
    if (act.error) throw act.error
    await activeBilling(shop)
    return { shop, owner, policyRevision: act.data as number }
  })

  async function newAgent(shop: Seeded): Promise<string> {
    return transient(async () => {
      const { data, error } = await db
        .from("custom_agents")
        .insert({ shop_id: shop.shopId, owner_id: shop.ownerId, name: `Synthetic agent ${uniq()}`, problem_text: "Synthetic", config: {}, enabled: false })
        .select("id")
        .single()
      if (error) throw new Error(error.message)
      return data!.id as string
    })
  }

  const definition = (over: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    key: `agent-${uniq()}`,
    job: { roleLabel: "Quote follow-up", goal: "Follow up on open quotes politely.", expectedOutcomes: ["Quote answered"], stopConditions: ["Customer says stop"] },
    knowledge: { sourceIds: [] as string[], includeShopKnowledge: false, includeCustomerMemory: false, maxResultsPerQuery: 4 },
    tools: [
      { operation: "crm.read", maximumMode: "read" },
      { operation: "crm.edit", maximumMode: "approval" },
      { operation: "pipeline.change", maximumMode: "approval" },
    ],
    schedule: { kind: "interval", everyMinutes: 60 },
    limits: { maximumStepsPerRun: 6, maximumRuntimeSeconds: 120, maximumCreditsPerRun: 50, maximumRunsPerDay: 24, maximumConcurrentRuns: 1 },
    routing: { strategy: "cost_aware", semanticCache: false },
    ...over,
  })

  /** An ACTIVE governed agent whose revision was evaluated by the REAL trusted evaluator. */
  async function governed(w: World, over: Record<string, unknown> = {}) {
    const agent = await newAgent(w.shop)
    const saved = await createAgentDefinitionRevision({ service: db }, {
      shopId: w.shop.shopId, actorId: w.shop.ownerId, agentId: agent, requestId: randomUUID(), definition: definition(over), parentRevision: null,
    })
    if (!saved.ok) throw new Error(`save failed: ${saved.code}`)
    const ev = await runTrustedEvaluation({ service: db }, { shopId: w.shop.shopId, actorId: w.shop.ownerId, agentId: agent, revision: saved.revision })
    expect(ev.ok).toBe(true)
    const act = await activateAgentDefinition({ service: db }, {
      shopId: w.shop.shopId, actorId: w.shop.ownerId, agentId: agent, revision: saved.revision, expectedHash: saved.definitionHash, expectedPointer: null,
    })
    expect(act).toEqual({ ok: true, outcome: "activated", revision: saved.revision })
    return { agent, rev: saved }
  }

  const pauseDefinition = (w: World, agentId: string, pointer: number) =>
    setAgentDefinitionLifecycle({ service: db }, { shopId: w.shop.shopId, actorId: w.shop.ownerId, agentId, lifecycle: "paused", reason: "Test hold", expectedPointer: pointer })

  type Claimed = { outcome: string; run_id: string; attempt: number; shop_id?: string; reasons?: string[]; state?: string }
  /** Claims a fresh window and returns the lease a worker would hold. */
  async function claimWindow(agentId: string, key = `window-${uniq()}`, leaseSeconds = 60) {
    const worker = randomUUID()
    const r = await db.rpc("claim_scheduled_agent_run", { p_agent: agentId, p_trigger_key: key, p_worker: worker, p_lease_seconds: leaseSeconds })
    expect(r.error).toBeNull()
    const c = r.data as Claimed
    return { ...c, worker, lease: { runId: c.run_id, workerId: worker, attempt: c.attempt } }
  }

  const expireLease = async (runId: string) => {
    const r = await db.from("custom_agent_runs").update({ lease_expires_at: new Date(Date.now() - 1000).toISOString() }).eq("id", runId)
    expect(r.error).toBeNull()
  }
  const runRow = async (runId: string) => (await db.from("custom_agent_runs").select("*").eq("id", runId).single()).data!
  const rows = async (table: string, runId: string) => (await db.from(table).select("*").eq("run_id", runId)).data ?? []
  const eventKinds = async (runId: string) => ((await db.from("agent_run_events").select("kind").eq("run_id", runId).order("id")).data ?? []).map((e) => e.kind as string)

  /** The six passing checks the application would hand over. */
  const allPass = (over: Record<string, PreEffectCheck["status"]> = {}): PreEffectCheck[] =>
    ["policy", "consent", "readiness", "approval", "budget", "grants"].map((name) => ({
      name,
      status: over[name] ?? (name === "consent" || name === "approval" ? "not_applicable" : "pass"),
    }))

  const stageApproval = (shop: Seeded, payload: Record<string, unknown> = { to: "synthetic" }) => stagePending(db, shop.shopId, shop.ownerId, "add_note", payload)

  const finish = (lease: { runId: string; workerId: string; attempt: number }, state = "skipped") =>
    db.rpc("finish_scheduled_agent_run", { p_run: lease.runId, p_worker: lease.workerId, p_attempt: lease.attempt, p_state: state, p_fired: state === "succeeded" })

  const done = async () => {
    for (const s of seeded) await cleanup(db, s).catch(() => undefined)
  }

  return {
    seeded, newUser, addMember, world, newAgent, definition, governed, pauseDefinition, claimWindow, expireLease, runRow, rows,
    eventKinds, allPass, stageApproval, finish, done,
  }
}
