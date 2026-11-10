import { randomUUID } from "node:crypto"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  activateAgentDefinition,
  createAgentDefinitionRevision,
  recordTrustedAgentEvaluation,
  setAgentDefinitionLifecycle,
} from "@/lib/agent-os/definition-store"
import { runTrustedEvaluation } from "@/lib/agent-os/evaluator/run"
import { GOVERNED_EXECUTOR_ENABLED, governedWindowKey, runCustomAgent, runGovernedScheduledAgent } from "@/lib/agent-runtime"
import { COMMERCIAL_CATALOG_VERSION, FOUNDER_PILOT_PRICE } from "@/lib/commercial-billing"
import { initialPolicyDraft } from "@/lib/control-center/drafts"
import type { CustomAgentRow } from "@/lib/types/database"
import { INTEGRATION_WITH_SESSION, assertDisposableTarget, cleanup, ownerSessionClient, seedShop, type Seeded } from "./_db"

const PW = "Synthetic-password-123!"

function resilientService(): SupabaseClient {
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

let db: SupabaseClient
const seeded: Seeded[] = []
let seq = 0
const uniq = () => `${Date.now().toString(36)}${(++seq).toString(36)}`

async function transient<T>(fn: () => Promise<T>): Promise<T> {
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

async function newUser(): Promise<Seeded> {
  const s = await transient(() => seedShop(db, { password: PW }))
  seeded.push(s)
  return s
}
async function addMember(shopId: string, user: Seeded, role: string, active = true) {
  const r = await db
    .from("shop_memberships")
    .upsert({ shop_id: shopId, user_id: user.ownerId, role, capabilities: [], active, display_name: role }, { onConflict: "shop_id,user_id" })
  expect(r.error).toBeNull()
}

type World = {
  shop: Seeded
  owner: SupabaseClient
  policyRevision: number
}

/** A shop with an ACTIVE Control Center policy and reviewed, ACTIVE Founder Pilot evidence. */
const world = (opts: { billing?: boolean; policy?: boolean } = {}): Promise<World> => transient(() => worldOnce(opts))
async function worldOnce(opts: { billing?: boolean; policy?: boolean } = {}): Promise<World> {
  const shop = await newUser()
  const owner = await ownerSessionClient(shop.email, PW)
  if (opts.policy === false) {
    if (opts.billing !== false) await activeBilling(shop)
    return { shop, owner, policyRevision: 0 }
  }
  const current = await owner.from("control_policy_drafts").select("revision").eq("shop_id", shop.shopId).single()
  const save = await owner.rpc("save_control_policy_draft", { p_shop: shop.shopId, p_expected_revision: current.data!.revision, p_definition: initialPolicyDraft() })
  if (save.error) throw save.error
  const act = await owner.rpc("activate_control_policy", { p_shop: shop.shopId, p_revision: save.data, p_expected_active: null })
  if (act.error) throw act.error
  if (opts.billing !== false) await activeBilling(shop)
  return { shop, owner, policyRevision: act.data as number }
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

async function newAgent(shop: Seeded, enabled = false): Promise<string> {
  return transient(async () => {
    const { data, error } = await db
      .from("custom_agents")
      .insert({ shop_id: shop.shopId, owner_id: shop.ownerId, name: `Synthetic agent ${uniq()}`, problem_text: "Synthetic", config: {}, enabled })
      .select("id")
      .single()
    if (error) throw new Error(error.message)
    return data!.id as string
  })
}

const INTERVAL = { schedule: { kind: "interval", everyMinutes: 60 } }
const definition = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  key: `agent-${uniq()}`,
  job: { roleLabel: "Quote follow-up", goal: "Follow up on open quotes politely.", expectedOutcomes: ["Quote answered"], stopConditions: ["Customer says stop"] },
  knowledge: { sourceIds: [] as string[], includeShopKnowledge: false, includeCustomerMemory: false, maxResultsPerQuery: 4 },
  tools: [{ operation: "crm.read", maximumMode: "read" }],
  schedule: { kind: "manual" },
  limits: { maximumStepsPerRun: 5, maximumRuntimeSeconds: 120, maximumCreditsPerRun: 50, maximumRunsPerDay: 20, maximumConcurrentRuns: 1 },
  routing: { strategy: "cost_aware", semanticCache: false },
  ...over,
})

async function save(w: { shop: Seeded }, agentId: string, over: Record<string, unknown> = {}, parent: number | null = null) {
  const r = await createAgentDefinitionRevision({ service: db }, { shopId: w.shop.shopId, actorId: w.shop.ownerId, agentId, requestId: randomUUID(), definition: definition(over), parentRevision: parent })
  if (!r.ok) throw new Error(`save failed: ${r.code}`)
  return r
}
const evaluator = (w: { shop: Seeded }, agentId: string, revision: number, actorId = w.shop.ownerId, shopId = w.shop.shopId) =>
  runTrustedEvaluation({ service: db }, { shopId, actorId, agentId, revision })
const activate = (w: { shop: Seeded }, agentId: string, rev: { revision: number; definitionHash: string }, pointer: number | null = null) =>
  activateAgentDefinition({ service: db }, { shopId: w.shop.shopId, actorId: w.shop.ownerId, agentId, revision: rev.revision, expectedHash: rev.definitionHash, expectedPointer: pointer })
const pause = (w: { shop: Seeded }, agentId: string, pointer: number, lifecycle: "paused" | "blocked" = "paused") =>
  setAgentDefinitionLifecycle({ service: db }, { shopId: w.shop.shopId, actorId: w.shop.ownerId, agentId, lifecycle, reason: "Test hold", expectedPointer: pointer })

/** An ACTIVE governed agent whose revision was evaluated by the REAL trusted evaluator. */
async function governed(w: World, over: Record<string, unknown> = {}) {
  const agent = await newAgent(w.shop)
  const rev = await save(w, agent, { ...INTERVAL, ...over })
  const ev = await evaluator(w, agent, rev.revision)
  expect(ev.ok).toBe(true)
  const act = await activate(w, agent, rev)
  expect(act).toEqual({ ok: true, outcome: "activated", revision: rev.revision })
  return { agent, rev }
}

const claim = (agentId: string, key = `window-${uniq()}`, worker = randomUUID()) =>
  db.rpc("claim_scheduled_agent_run", { p_agent: agentId, p_trigger_key: key, p_worker: worker, p_lease_seconds: 60 })
type Claimed = { outcome: string; run_id: string; attempt: number; reasons?: string[]; governed?: boolean }
const claimed = async (agentId: string, key?: string) => {
  const worker = randomUUID()
  const r = await claim(agentId, key, worker)
  expect(r.error).toBeNull()
  return { ...(r.data as Claimed), worker }
}
const finish = (runId: string, worker: string, attempt = 1, state = "skipped") =>
  db.rpc("finish_scheduled_agent_run", { p_run: runId, p_worker: worker, p_attempt: attempt, p_state: state, p_fired: state === "succeeded" })
const assertCurrent = async (runId: string, worker: string, attempt = 1) => {
  const r = await db.rpc("assert_governed_run_current", { p_run: runId, p_worker: worker, p_attempt: attempt })
  expect(r.error).toBeNull()
  return r.data as { current: boolean; governed: boolean; reasons: string[] }
}
const runRow = async (runId: string) => (await db.from("custom_agent_runs").select("*").eq("id", runId).single()).data!
const runCount = async (agentId: string) => (await db.from("custom_agent_runs").select("id", { count: "exact", head: true }).eq("agent_id", agentId)).count
const stateOf = async (agentId: string) => (await db.from("agent_definition_state").select("*").eq("agent_id", agentId).single()).data!
const events = async (agentId: string) => (await db.from("agent_definition_events").select("*").eq("agent_id", agentId).order("seq")).data!

async function newPolicyRevision(x: World, active: number, ceiling: "approval" | "autonomous" = "approval") {
  const current = await x.owner.from("control_policy_drafts").select("revision").eq("shop_id", x.shop.shopId).single()
  const saveRes = await x.owner.rpc("save_control_policy_draft", { p_shop: x.shop.shopId, p_expected_revision: current.data!.revision, p_definition: { ...initialPolicyDraft(), workspaceCeiling: ceiling } })
  expect(saveRes.error).toBeNull()
  const act = await x.owner.rpc("activate_control_policy", { p_shop: x.shop.shopId, p_revision: saveRes.data, p_expected_active: active })
  expect(act.error).toBeNull()
  return act.data as number
}

async function publishMemory(owner: SupabaseClient, shopId: string, content = "Deposits are refundable up to 24 hours before service.") {
  const candidate = await owner.rpc("create_reviewed_memory_candidate", {
    p_shop: shopId, p_source_name: `Policy ${randomUUID()}`, p_content: content, p_chunks: [{ content, embedding: null }],
    p_source: null, p_expected_revision: null, p_valid_from: null, p_valid_until: null, p_retention_until: null,
  })
  expect(candidate.error).toBeNull()
  const c = candidate.data as { source_id: string; revision: number }
  expect((await owner.rpc("review_memory_revision", { p_shop: shopId, p_source: c.source_id, p_revision: c.revision })).error).toBeNull()
  expect((await owner.rpc("publish_memory_revision", { p_shop: shopId, p_source: c.source_id, p_revision: c.revision, p_expected_active: null })).error).toBeNull()
  return { sourceId: c.source_id, revision: c.revision }
}

describe.skipIf(!INTEGRATION_WITH_SESSION)("trusted evaluation and durable runtime binding [integration]", { timeout: 120_000 }, () => {
  let manager: Seeded, staff: Seeded, revoked: Seeded, stranger: Seeded
  let main: World, foreign: World

  beforeAll(async () => {
    db = resilientService()
    main = await world()
    foreign = await world()
    manager = await newUser()
    staff = await newUser()
    revoked = await newUser()
    stranger = await newUser()
    await addMember(main.shop.shopId, manager, "manager")
    await addMember(main.shop.shopId, staff, "staff")
    await addMember(main.shop.shopId, revoked, "staff", false)
  }, 180_000)

  afterAll(async () => {
    for (const s of seeded) await cleanup(db, s)
  })

  describe("trusted evaluator", () => {
    it("records real evidence for the exact revision, replays it, and lets activation use it", async () => {
      const x = await world()
      const agent = await newAgent(x.shop)
      const rev = await save(x, agent, INTERVAL)
      const first = await evaluator(x, agent, rev.revision)
      expect(first).toMatchObject({ ok: true, outcome: "recorded", evaluation: { revision: 1, definitionHash: rev.definitionHash, passRate: 1, safetyPassed: true, failedFixtures: [] } })
      const rows = (await db.from("agent_definition_evaluations").select("*").eq("agent_id", agent)).data!
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ source: "trusted_evaluator", revision: 1, definition_hash: rev.definitionHash, estimated_credits: 50 })
      expect(rows[0].cost_evidence).toMatchObject({ basis: "definition_limit", modelCalls: 0 })
      const again = await evaluator(x, agent, rev.revision)
      expect(again).toMatchObject({ ok: true, outcome: "replayed", evaluation: { evaluationId: rows[0].id } })
      expect((await db.from("agent_definition_evaluations").select("id").eq("agent_id", agent)).data).toHaveLength(1)
      expect(await activate(x, agent, rev)).toEqual({ ok: true, outcome: "activated", revision: 1 })
      expect((await events(agent)).find((e) => e.kind === "activated")!.evidence).toMatchObject({ evaluation_id: rows[0].id, evaluation_pass_rate: 1 })
    })

    it("concurrent evaluations of one revision record exactly one result", async () => {
      const x = await world()
      const agent = await newAgent(x.shop)
      const rev = await save(x, agent, INTERVAL)
      const results = await Promise.all(Array.from({ length: 6 }, () => evaluator(x, agent, rev.revision)))
      expect(results.every((r) => r.ok)).toBe(true)
      const ids = new Set(results.map((r) => (r.ok ? r.evaluation.evaluationId : "")))
      expect(ids.size).toBe(1)
      expect(results.filter((r) => r.ok && r.outcome === "recorded").length).toBeGreaterThanOrEqual(1)
      expect((await db.from("agent_definition_evaluations").select("id").eq("agent_id", agent)).data).toHaveLength(1)
    })

    it("a failing definition records its failure honestly and cannot be activated; a corrected revision can", async () => {
      const x = await world()
      const agent = await newAgent(x.shop)
      const bad = await save(x, agent, { ...INTERVAL, tools: [{ operation: "sms.nurture", maximumMode: "approval" }], job: { roleLabel: "Nurture", goal: "Nurture quiet leads with texts.", expectedOutcomes: ["Reply received"], stopConditions: ["Budget is spent"] } })
      const ev = await evaluator(x, agent, bad.revision)
      expect(ev).toMatchObject({ ok: true, evaluation: { safetyPassed: false, failedFixtures: [{ id: "outbound-messaging-has-stop-condition", safety: true }] } })
      expect(ev.ok && ev.evaluation.passRate).toBeLessThan(1)
      const refused = await activate(x, agent, bad)
      expect(refused).toMatchObject({ ok: false, reasons: expect.arrayContaining(["safety_evaluation_failed"]) })
      expect((await stateOf(agent)).lifecycle).toBe("draft")
      const good = await save(x, agent, { ...INTERVAL, tools: [{ operation: "sms.nurture", maximumMode: "approval" }], job: { roleLabel: "Nurture", goal: "Nurture quiet leads with texts.", expectedOutcomes: ["Reply received"], stopConditions: ["Customer replies STOP"] } }, 1)
      expect(await evaluator(x, agent, good.revision)).toMatchObject({ ok: true, evaluation: { safetyPassed: true, passRate: 1 } })
    })

    it("only a live owner of the exact shop can request an evaluation; other shops cannot reach the agent", async () => {
      const x = await world()
      const agent = await newAgent(x.shop)
      const rev = await save(x, agent, INTERVAL)
      for (const actor of [manager, staff, revoked, stranger]) {
        expect(await evaluator(x, agent, rev.revision, actor.ownerId, x.shop.shopId)).toEqual({ ok: false, code: "forbidden" })
      }
      // Another shop's owner naming this shop, or naming this agent from their own shop.
      expect(await evaluator(x, agent, rev.revision, foreign.shop.ownerId, x.shop.shopId)).toEqual({ ok: false, code: "forbidden" })
      expect(await evaluator({ shop: foreign.shop }, agent, rev.revision)).toEqual({ ok: false, code: "agent_not_found" })
      expect(await evaluator(x, agent, 99)).toEqual({ ok: false, code: "revision_not_found" })
      expect((await db.from("agent_definition_evaluations").select("id").eq("agent_id", agent)).data).toEqual([])
    })

    it("the evidence seam still refuses browser sessions and wrong hashes", async () => {
      const x = await world()
      const agent = await newAgent(x.shop)
      const rev = await save(x, agent, INTERVAL)
      const args = { p_shop: x.shop.shopId, p_agent: agent, p_revision: 1, p_definition_hash: rev.definitionHash, p_evaluation_key: "k", p_suite_version: "s", p_fixture_set_id: "f", p_fixture_hash: "a".repeat(64), p_pass_rate: 1, p_safety_passed: true, p_estimated_credits: 1, p_cost_evidence: {}, p_completed_at: new Date().toISOString(), p_source: "trusted_evaluator" }
      expect((await x.owner.rpc("agent_definition_record_evaluation", args)).error).not.toBeNull()
      expect(await recordTrustedAgentEvaluation({ service: db }, { shopId: x.shop.shopId, agentId: agent, revision: 1, definitionHash: "f".repeat(64), evaluationKey: "k", suiteVersion: "s", fixtureSetId: "f", fixtureHash: "a".repeat(64), passRate: 1, safetyPassed: true, estimatedCredits: 1, completedAt: new Date().toISOString() })).toMatchObject({ ok: false, code: "definition_hash_mismatch" })
    })
  })

  describe("a governed run is bound to exact evidence", () => {
    it("claims bind revision, hash, policy revision, memory pins, evaluation and the activation they rest on", async () => {
      const x = await world()
      const mem = await publishMemory(x.owner, x.shop.shopId)
      const { agent, rev } = await governed(x, { knowledge: { sourceIds: [mem.sourceId], includeShopKnowledge: true, includeCustomerMemory: false, maxResultsPerQuery: 4 } })
      const c = await claimed(agent)
      expect(c).toMatchObject({ outcome: "claimed", governed: true })
      const row = await runRow(c.run_id)
      const evaluation = (await db.from("agent_definition_evaluations").select("*").eq("agent_id", agent).single()).data!
      const activated = (await events(agent)).filter((e) => e.kind === "activated").at(-1)!
      const stored = (await db.from("agent_definition_revisions").select("definition,definition_hash").eq("agent_id", agent).eq("revision", 1).single()).data!
      expect(row).toMatchObject({
        shop_id: x.shop.shopId, agent_id: agent, state: "running", trigger_source: "schedule",
        definition_revision: 1, definition_hash: rev.definitionHash, policy_revision: x.policyRevision,
        knowledge_revision: activated.evidence.knowledge_revision, evaluation_id: evaluation.id,
        state_version: (await stateOf(agent)).version, activation_event_seq: activated.seq,
      })
      expect(row.memory_pins).toEqual([{ source_id: mem.sourceId, memory_revision: mem.revision, content_hash: expect.stringMatching(/^[0-9a-f]{64}$/) }])
      // The run executes the immutable revision, not the legacy config column.
      expect(row.definition_snapshot).toEqual(stored.definition)
      expect(row.definition_hash).toBe(stored.definition_hash)
    })

    it("window idempotency: a duplicate never executes, and concurrent claims of one window create exactly one run", async () => {
      const x = await world()
      const { agent } = await governed(x)
      const key = `win-${uniq()}`
      const first = await claimed(agent, key)
      expect(first.outcome).toBe("claimed")
      expect(await claimed(agent, key)).toMatchObject({ outcome: "active_duplicate", run_id: first.run_id })
      expect((await finish(first.run_id, first.worker)).data).toBe(true)
      expect(await claimed(agent, key)).toMatchObject({ outcome: "terminal_duplicate", run_id: first.run_id, state: "skipped" })
      // A finish is exactly-once: the same finish again changes nothing.
      expect((await finish(first.run_id, first.worker)).data).toBe(false)

      const racey = `race-${uniq()}`
      const results = await Promise.all(Array.from({ length: 8 }, () => claim(agent, racey)))
      const outcomes = results.map((r) => (r.data as Claimed).outcome)
      expect(outcomes.filter((o) => o === "claimed")).toHaveLength(1)
      expect(outcomes.filter((o) => o === "claimed" || o === "active_duplicate" || o === "refused")).toHaveLength(8)
      expect((await db.from("custom_agent_runs").select("id").eq("agent_id", agent).eq("trigger_key", racey)).data).toHaveLength(1)
    })

    it("refuses a stale policy, writes no row, and recovers only through fresh activation", async () => {
      const x = await world()
      const { agent, rev } = await governed(x)
      expect((await claimed(agent)).outcome).toBe("claimed")
      const before = await runCount(agent)
      const finishFirst = (await db.from("custom_agent_runs").select("id,worker_id").eq("agent_id", agent).single()).data!
      await finish(finishFirst.id, finishFirst.worker_id)
      await newPolicyRevision(x, x.policyRevision)
      expect(await claimed(agent)).toMatchObject({ outcome: "refused", reasons: ["policy_changed"] })
      expect(await runCount(agent)).toBe(before)
      // Resume = pause, then a fresh activation under the new policy.
      expect(await pause(x, agent, 1)).toEqual({ ok: true, outcome: "changed" })
      expect(await activate(x, agent, rev, 1)).toEqual({ ok: true, outcome: "activated", revision: 1 })
      expect((await claimed(agent)).outcome).toBe("claimed")
    })

    it("refuses stale and revoked pinned memory, and a newest evaluation that now fails", async () => {
      const x = await world()
      const mem = await publishMemory(x.owner, x.shop.shopId)
      const { agent, rev } = await governed(x, { knowledge: { sourceIds: [mem.sourceId], includeShopKnowledge: true, includeCustomerMemory: false, maxResultsPerQuery: 4 } })
      expect((await claimed(agent)).outcome).toBe("claimed")
      const run = (await db.from("custom_agent_runs").select("id,worker_id").eq("agent_id", agent).single()).data!
      await finish(run.id, run.worker_id)

      // Newer reviewed memory is published: the pin is stale, never silently refreshed.
      const next = await x.owner.rpc("create_reviewed_memory_candidate", { p_shop: x.shop.shopId, p_source_name: "ignored", p_content: "Deposits are refundable up to 48 hours before service.", p_chunks: [{ content: "Deposits are refundable up to 48 hours before service.", embedding: null }], p_source: mem.sourceId, p_expected_revision: mem.revision, p_valid_from: null, p_valid_until: null, p_retention_until: null })
      const n = next.data as { source_id: string; revision: number }
      expect((await x.owner.rpc("review_memory_revision", { p_shop: x.shop.shopId, p_source: n.source_id, p_revision: n.revision })).error).toBeNull()
      expect((await x.owner.rpc("publish_memory_revision", { p_shop: x.shop.shopId, p_source: n.source_id, p_revision: n.revision, p_expected_active: mem.revision })).error).toBeNull()
      const stale = await claimed(agent)
      expect(stale.outcome).toBe("refused")
      expect(stale.reasons).toEqual(expect.arrayContaining(["knowledge_changed", "memory_stale"]))

      // A newer evaluation that fails wins over the older passing one.
      const failing = await recordTrustedAgentEvaluation({ service: db }, { shopId: x.shop.shopId, agentId: agent, revision: 1, definitionHash: rev.definitionHash, evaluationKey: `regress-${uniq()}`, suiteVersion: "later-suite", fixtureSetId: "f", fixtureHash: "c".repeat(64), passRate: 0.5, safetyPassed: false, estimatedCredits: 1, completedAt: new Date().toISOString() })
      expect(failing.ok).toBe(true)
      expect((await claimed(agent)).reasons).toEqual(expect.arrayContaining(["safety_evaluation_failed", "quality_evaluation_failed"]))
      expect(await runCount(agent)).toBe(1)
    })

    it("a revoked pinned source refuses the claim", async () => {
      const x = await world()
      const mem = await publishMemory(x.owner, x.shop.shopId)
      const { agent } = await governed(x, { knowledge: { sourceIds: [mem.sourceId], includeShopKnowledge: true, includeCustomerMemory: false, maxResultsPerQuery: 4 } })
      expect((await x.owner.rpc("remove_memory_revision", { p_shop: x.shop.shopId, p_source: mem.sourceId, p_revision: mem.revision, p_expected_active: mem.revision })).error).toBeNull()
      const r = await claimed(agent)
      expect(r.outcome).toBe("refused")
      expect(r.reasons).toEqual(expect.arrayContaining(["memory_revoked"]))
    })

    it("enforces the definition's own limits: interval schedule, one run at a time, daily allowance", async () => {
      const x = await world()
      const manual = await governed(x, { schedule: { kind: "manual" } })
      expect(await claimed(manual.agent)).toMatchObject({ outcome: "refused", reasons: ["schedule_not_interval"] })

      const y = await world()
      const capped = await governed(y, { limits: { maximumStepsPerRun: 5, maximumRuntimeSeconds: 120, maximumCreditsPerRun: 50, maximumRunsPerDay: 1, maximumConcurrentRuns: 1 } })
      const one = await claimed(capped.agent)
      expect(one.outcome).toBe("claimed")
      expect(await claimed(capped.agent)).toMatchObject({ outcome: "refused", reasons: expect.arrayContaining(["concurrent_run_active"]) })
      expect((await finish(one.run_id, one.worker, 1, "succeeded")).data).toBe(true)
      expect(await claimed(capped.agent)).toMatchObject({ outcome: "refused", reasons: ["daily_limit_reached"] })
      expect(await runCount(capped.agent)).toBe(1)
    })

    it("paused and blocked definitions never claim, and neither does a disabled agent", async () => {
      const x = await world()
      const { agent } = await governed(x)
      expect(await pause(x, agent, 1)).toEqual({ ok: true, outcome: "changed" })
      expect(await claimed(agent)).toMatchObject({ outcome: "agent_unavailable" })
      expect(await pause(x, agent, 1, "blocked")).toEqual({ ok: true, outcome: "changed" })
      expect(await claimed(agent)).toMatchObject({ outcome: "agent_unavailable" })
      expect(await runCount(agent)).toBe(0)
    })
  })

  describe("re-verification, pointer change and finish", () => {
    it("assert is current while bound, then reports pointer_changed when another revision is activated", async () => {
      const x = await world()
      const { agent, rev } = await governed(x)
      const c = await claimed(agent)
      expect(await assertCurrent(c.run_id, c.worker)).toEqual({ current: true, governed: true, reasons: [] })
      expect(await assertCurrent(c.run_id, randomUUID())).toMatchObject({ current: false, reasons: ["run_not_owned"] })
      expect(await assertCurrent(c.run_id, c.worker, 2)).toMatchObject({ current: false, reasons: ["run_not_owned"] })

      const rev2 = await save(x, agent, { ...INTERVAL, job: { roleLabel: "Quote follow-up v2", goal: "Follow up on open quotes politely, version two.", expectedOutcomes: ["Quote answered"], stopConditions: ["Customer says stop"] } }, rev.revision)
      expect((await evaluator(x, agent, rev2.revision)).ok).toBe(true)
      expect(await activate(x, agent, rev2, 1)).toEqual({ ok: true, outcome: "activated", revision: 2 })
      expect(await assertCurrent(c.run_id, c.worker)).toEqual({ current: false, governed: true, reasons: ["pointer_changed"] })

      // The result is recorded as reported; the moved pointer is recorded beside it, write-once.
      expect((await finish(c.run_id, c.worker, 1, "succeeded")).data).toBe(true)
      const row = await runRow(c.run_id)
      expect(row).toMatchObject({ state: "succeeded", fired: true, definition_revision: 1, binding_at_finish: "pointer_changed" })
    })

    it("a pause after the claim is visible to the next check, and recorded at finish", async () => {
      const x = await world()
      const { agent } = await governed(x)
      const c = await claimed(agent)
      expect(await pause(x, agent, 1)).toEqual({ ok: true, outcome: "changed" })
      expect(await assertCurrent(c.run_id, c.worker)).toEqual({ current: false, governed: true, reasons: ["agent_disabled"] })
      expect((await finish(c.run_id, c.worker)).data).toBe(true)
      expect((await runRow(c.run_id)).binding_at_finish).toBe("agent_disabled")
    })

    it("re-activation of the same revision is a different activation: an older run is pointer_changed", async () => {
      const x = await world()
      const { agent, rev } = await governed(x)
      const c = await claimed(agent)
      await pause(x, agent, 1)
      expect(await activate(x, agent, rev, 1)).toEqual({ ok: true, outcome: "activated", revision: 1 })
      expect(await assertCurrent(c.run_id, c.worker)).toEqual({ current: false, governed: true, reasons: ["pointer_changed"] })
    })

    it("a clean run records binding_at_finish = current", async () => {
      const x = await world()
      const { agent } = await governed(x)
      const c = await claimed(agent)
      expect((await finish(c.run_id, c.worker)).data).toBe(true)
      expect((await runRow(c.run_id)).binding_at_finish).toBe("current")
    })
  })

  describe("write-once binding and tenant isolation", () => {
    it("binding columns cannot be changed, added to another run, or rewritten at finish", async () => {
      const x = await world()
      const { agent } = await governed(x)
      const c = await claimed(agent)
      const bound = await runRow(c.run_id)
      for (const patch of [{ definition_revision: 5 }, { definition_hash: "e".repeat(64) }, { evaluation_id: randomUUID() }, { memory_pins: [{ source_id: randomUUID(), memory_revision: 1, content_hash: "e".repeat(64) }] }, { activation_event_seq: 99 }, { policy_revision: 77 }, { definition_snapshot: { x: 1 } }]) {
        expect((await db.from("custom_agent_runs").update(patch).eq("id", c.run_id)).error, JSON.stringify(patch)).not.toBeNull()
      }
      // Legacy rows cannot be retro-fitted with a binding.
      const legacyAgent = await newAgent(x.shop, true)
      const lc = await claimed(legacyAgent)
      expect(lc).toMatchObject({ outcome: "claimed" })
      expect((await db.from("custom_agent_runs").update({ definition_revision: 1, evaluation_id: bound.evaluation_id, memory_pins: [], state_version: 1, activation_event_seq: 1, definition_hash: bound.definition_hash }).eq("id", lc.run_id)).error).not.toBeNull()
      await finish(c.run_id, c.worker)
      expect((await db.from("custom_agent_runs").update({ binding_at_finish: "forged" }).eq("id", c.run_id)).error).not.toBeNull()
      expect((await runRow(c.run_id)).binding_at_finish).toBe("current")
    })

    it("the owner's browser session cannot create or forge a bound run", async () => {
      const x = await world()
      const { agent, rev } = await governed(x)
      const base = { agent_id: agent, shop_id: x.shop.shopId, trigger_source: "schedule", trigger_key: `forge-${uniq()}`, fired: false, state: "running", attempt: 1, worker_id: randomUUID(), lease_expires_at: new Date(Date.now() + 60_000).toISOString(), started_at: new Date().toISOString(), definition_snapshot: {}, definition_hash: rev.definitionHash, definition_revision: 1 }
      expect((await x.owner.from("custom_agent_runs").insert(base)).error).not.toBeNull()
      expect((await x.owner.from("custom_agent_runs").insert({ ...base, trigger_source: "manual", trigger_key: null, state: "succeeded", worker_id: null, lease_expires_at: null })).error).not.toBeNull()
      expect(await runCount(agent)).toBe(0)
      for (const fn of ["assert_governed_run_current", "agent_definition_binding_reasons"]) {
        const r = await x.owner.rpc(fn, fn === "assert_governed_run_current" ? { p_run: randomUUID(), p_worker: randomUUID(), p_attempt: 1 } : { p_agent: agent, p_expected_revision: null, p_expected_event_seq: null })
        expect(r.error, fn).not.toBeNull()
      }
    })

    it("a run can never reference another shop's, agent's, revision's or evaluation's evidence", async () => {
      const a = await world()
      const b = await world()
      const ga = await governed(a)
      const gb = await governed(b)
      const evalA = (await db.from("agent_definition_evaluations").select("id").eq("agent_id", ga.agent).single()).data!.id
      const evalB = (await db.from("agent_definition_evaluations").select("id").eq("agent_id", gb.agent).single()).data!.id
      const row = (over: Record<string, unknown>) => ({
        agent_id: ga.agent, shop_id: a.shop.shopId, trigger_source: "schedule", trigger_key: `x-${uniq()}`, fired: false, state: "running", attempt: 1,
        worker_id: randomUUID(), lease_expires_at: new Date(Date.now() + 60_000).toISOString(), started_at: new Date().toISOString(),
        definition_snapshot: {}, definition_hash: ga.rev.definitionHash, definition_revision: 1, evaluation_id: evalA, memory_pins: [],
        state_version: 1, activation_event_seq: 1, policy_revision: 1, knowledge_revision: 1, ...over,
      })
      // Control: a well-formed binding is accepted by the schema (service role writes only inside the claim in practice).
      expect((await db.from("custom_agent_runs").insert(row({}))).error).toBeNull()
      // Another shop's evaluation, another shop's revision hash, a hash that is not this revision's, another shop id.
      expect((await db.from("custom_agent_runs").insert(row({ evaluation_id: evalB }))).error).not.toBeNull()
      expect((await db.from("custom_agent_runs").insert(row({ definition_hash: gb.rev.definitionHash }))).error).not.toBeNull()
      expect((await db.from("custom_agent_runs").insert(row({ definition_hash: "d".repeat(64) }))).error).not.toBeNull()
      expect((await db.from("custom_agent_runs").insert(row({ shop_id: b.shop.shopId }))).error).not.toBeNull()
      expect((await db.from("custom_agent_runs").insert(row({ definition_revision: 2 }))).error).not.toBeNull()
      // Half a binding is refused outright.
      expect((await db.from("custom_agent_runs").insert(row({ evaluation_id: null }))).error).not.toBeNull()
      expect((await db.from("custom_agent_runs").insert(row({ memory_pins: null }))).error).not.toBeNull()
    })
  })

  describe("legacy behavior is unchanged", () => {
    it("a legacy enabled agent claims exactly as before: no binding, no refusal, no governed finish", async () => {
      const x = await world()
      const legacy = await newAgent(x.shop, true)
      const c = await claimed(legacy)
      expect(c).toMatchObject({ outcome: "claimed" })
      expect(c.governed).toBeUndefined()
      const row = await runRow(c.run_id)
      expect(row).toMatchObject({ definition_revision: null, evaluation_id: null, memory_pins: null, state_version: null, activation_event_seq: null })
      expect(await assertCurrent(c.run_id, c.worker)).toEqual({ current: true, governed: false, reasons: [] })
      expect(await claimed(legacy, (row as { trigger_key: string }).trigger_key)).toMatchObject({ outcome: "active_duplicate" })
      expect((await finish(c.run_id, c.worker, 1, "succeeded")).data).toBe(true)
      expect((await runRow(c.run_id)).binding_at_finish).toBeNull()
      expect(await claimed(legacy, (row as { trigger_key: string }).trigger_key)).toMatchObject({ outcome: "terminal_duplicate" })
    })

    it("legacy claims ignore policy, memory and evaluation state (they have none)", async () => {
      const x = await world({ policy: false })
      const legacy = await newAgent(x.shop, true)
      expect(await claimed(legacy)).toMatchObject({ outcome: "claimed" })
    })
  })

  describe("unknown outcomes", () => {
    it("an expired lease becomes unknown, never a free retry; and does not hold a new window forever", async () => {
      const x = await world()
      const { agent } = await governed(x)
      const key = `lease-${uniq()}`
      const c = await claimed(agent, key)
      expect((await db.from("custom_agent_runs").update({ lease_expires_at: new Date(Date.now() - 1000).toISOString() }).eq("id", c.run_id)).error).toBeNull()
      // Same window: unknown, reconcile before retrying.
      expect(await claimed(agent, key)).toMatchObject({ outcome: "unknown", run_id: c.run_id })
      expect(await runRow(c.run_id)).toMatchObject({ state: "unknown", error_code: "lease_expired", wait_reason: "reconciliation_required", fired: false })
      // A late finish from the lost worker can no longer overwrite the unknown outcome.
      expect((await finish(c.run_id, c.worker)).data).toBe(false)

      // A different window whose predecessor expired in flight: the predecessor is marked unknown, the new run proceeds.
      const d = await claimed(agent, `lease-${uniq()}`)
      expect(d.outcome).toBe("claimed")
      expect((await db.from("custom_agent_runs").update({ lease_expires_at: new Date(Date.now() - 1000).toISOString() }).eq("id", d.run_id)).error).toBeNull()
      const e = await claimed(agent, `lease-${uniq()}`)
      expect(e.outcome).toBe("claimed")
      expect((await runRow(d.run_id)).state).toBe("unknown")
    })
  })

  describe("concurrent lifecycle", () => {
    it("claim racing pause: the claim either lands before the pause or is refused, never after it; no half state", async () => {
      const x = await world()
      const { agent, rev } = await governed(x)
      let claimedCount = 0
      let refusedCount = 0
      for (let i = 0; i < 6; i++) {
        const key = `race-${i}-${uniq()}`
        const state = await stateOf(agent)
        const [c, p] = await Promise.all([claim(agent, key), pause(x, agent, state.active_revision as number)])
        expect(p).toEqual({ ok: true, outcome: "changed" })
        const outcome = (c.data as Claimed).outcome
        expect(["claimed", "agent_unavailable"]).toContain(outcome)
        const rows = (await db.from("custom_agent_runs").select("id,definition_revision,state").eq("agent_id", agent).eq("trigger_key", key)).data!
        if (outcome === "claimed") { claimedCount++; expect(rows).toHaveLength(1); expect(rows[0].definition_revision).toBe(1) }
        else { refusedCount++; expect(rows).toHaveLength(0) }
        // After the pause committed, no further claim can land.
        expect((await claimed(agent)).outcome).toBe("agent_unavailable")
        expect(await stateOf(agent)).toMatchObject({ lifecycle: "paused", active_revision: 1 })
        // Settle any in-flight run, then resume with fresh evidence for the next iteration.
        for (const r of (await db.from("custom_agent_runs").select("id,worker_id,attempt").eq("agent_id", agent).eq("state", "running")).data!) await finish(r.id, r.worker_id, r.attempt)
        expect(await activate(x, agent, rev, 1)).toEqual({ ok: true, outcome: "activated", revision: 1 })
      }
      expect(claimedCount + refusedCount).toBe(6)
    })

    it("claim racing a superseding activation binds to ONE consistent revision, hash and activation", async () => {
      const x = await world()
      const { agent, rev } = await governed(x)
      let pointer = 1
      let current = rev
      for (let i = 0; i < 4; i++) {
        const next = await save(x, agent, { ...INTERVAL, job: { roleLabel: `Quote follow-up ${i}`, goal: `Follow up on open quotes politely, round ${i}.`, expectedOutcomes: ["Quote answered"], stopConditions: ["Customer says stop"] } }, current.revision)
        expect((await evaluator(x, agent, next.revision)).ok).toBe(true)
        const key = `sup-${i}-${uniq()}`
        const [c, a] = await Promise.all([claim(agent, key), activate(x, agent, next, pointer)])
        expect(a).toEqual({ ok: true, outcome: "activated", revision: next.revision })
        const outcome = (c.data as Claimed).outcome
        expect(["claimed", "refused"]).toContain(outcome)
        const run = (await db.from("custom_agent_runs").select("*").eq("agent_id", agent).eq("trigger_key", key).maybeSingle()).data
        if (outcome === "claimed") {
          expect(run).not.toBeNull()
          const revision = (await db.from("agent_definition_revisions").select("revision,definition,definition_hash").eq("agent_id", agent).eq("revision", run!.definition_revision).single()).data!
          expect(run!.definition_hash).toBe(revision.definition_hash)
          expect(run!.definition_snapshot).toEqual(revision.definition)
          const ev = (await db.from("agent_definition_events").select("kind,revision").eq("agent_id", agent).eq("seq", run!.activation_event_seq).single()).data!
          expect(ev).toMatchObject({ kind: "activated", revision: run!.definition_revision })
          const evalRow = (await db.from("agent_definition_evaluations").select("revision,definition_hash").eq("id", run!.evaluation_id).single()).data!
          expect(evalRow).toMatchObject({ revision: run!.definition_revision, definition_hash: revision.definition_hash })
          // Whichever side won, the old run is judged against the NEW pointer afterwards.
          if (run!.definition_revision !== next.revision) expect(await assertCurrent(run!.id, run!.worker_id)).toMatchObject({ current: false, reasons: ["pointer_changed"] })
          await finish(run!.id, run!.worker_id)
        } else {
          expect(run).toBeNull()
        }
        pointer = next.revision
        current = next
      }
    })

    it("assert racing pause answers consistently with whichever committed first", async () => {
      const x = await world()
      const { agent, rev } = await governed(x)
      for (let i = 0; i < 4; i++) {
        const c = await claimed(agent)
        expect(c.outcome).toBe("claimed")
        const [a, p] = await Promise.all([assertCurrent(c.run_id, c.worker), pause(x, agent, 1)])
        expect(p).toEqual({ ok: true, outcome: "changed" })
        expect(a.current ? a.reasons : a.reasons).toEqual(a.current ? [] : ["agent_disabled"])
        expect(await assertCurrent(c.run_id, c.worker)).toEqual({ current: false, governed: true, reasons: ["agent_disabled"] })
        await finish(c.run_id, c.worker)
        expect(await activate(x, agent, rev, 1)).toEqual({ ok: true, outcome: "activated", revision: 1 })
      }
    })

    it("concurrent claims for different windows never exceed one run in flight", async () => {
      const x = await world()
      const { agent } = await governed(x)
      const results = await Promise.all(Array.from({ length: 6 }, (_, i) => claim(agent, `many-${i}-${uniq()}`)))
      const outcomes = results.map((r) => r.data as Claimed)
      expect(outcomes.filter((o) => o.outcome === "claimed")).toHaveLength(1)
      for (const o of outcomes.filter((o) => o.outcome !== "claimed")) expect(o).toMatchObject({ outcome: "refused", reasons: ["concurrent_run_active"] })
      expect((await db.from("custom_agent_runs").select("id").eq("agent_id", agent).eq("state", "running")).data).toHaveLength(1)
    })
  })

  describe("runtime", () => {
    const rowFor = async (agentId: string) => (await db.from("custom_agents").select("*").eq("id", agentId).single()).data as CustomAgentRow

    it("a governed agent's tick is claimed, bound, re-verified and finished as skipped; the window never repeats", async () => {
      expect(GOVERNED_EXECUTOR_ENABLED).toBe(false)
      const x = await world()
      const { agent } = await governed(x)
      const now = new Date()
      const ids: unknown[] = []
      const outcome = await runGovernedScheduledAgent(db, await rowFor(agent), { lifecycle: "active", activeRevision: 1 }, now, (c) => ids.push(c))
      expect(outcome).toMatchObject({ fired: false, reason: expect.stringContaining("governed execution is not enabled yet") })
      const run = (await db.from("custom_agent_runs").select("*").eq("agent_id", agent).single()).data!
      expect(run).toMatchObject({ state: "skipped", fired: false, error_code: "governed_executor_disabled", definition_revision: 1, binding_at_finish: "current", trigger_key: governedWindowKey(60, now), pending_action_ids: [] })
      expect(ids).toHaveLength(1)
      const again = await runGovernedScheduledAgent(db, await rowFor(agent), { lifecycle: "active", activeRevision: 1 }, now, () => {})
      expect(again?.reason).toBe("schedule window already handled")
      expect(await runCount(agent)).toBe(1)
      // Nothing was staged or metered by a governed run.
      expect((await db.from("pending_actions").select("id").eq("shop_id", x.shop.shopId)).data).toEqual([])
    })

    it("a refused definition reports why and writes no run", async () => {
      const x = await world()
      const { agent } = await governed(x)
      await newPolicyRevision(x, x.policyRevision)
      const outcome = await runGovernedScheduledAgent(db, await rowFor(agent), { lifecycle: "active", activeRevision: 1 }, new Date(), () => {})
      expect(outcome?.reason).toBe("governed definition not runnable: policy_changed")
      expect(await runCount(agent)).toBe(0)
    })

    it("manual Run now cannot run a governed agent through the legacy path", async () => {
      const x = await world()
      const { agent } = await governed(x)
      const outcome = await runCustomAgent(db, await rowFor(agent))
      expect(outcome).toMatchObject({ fired: false, reason: expect.stringContaining("governed definition") })
      expect((await db.from("pending_actions").select("id").eq("shop_id", x.shop.shopId)).data).toEqual([])
    })
  })
})
