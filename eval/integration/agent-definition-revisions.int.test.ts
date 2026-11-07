import { randomUUID } from "node:crypto"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  activateAgentDefinition,
  createAgentDefinitionRevision,
  readActivationEligibility,
  readAgentDetailDto,
  readAgentsHomeDto,
  readBuilderResumeDto,
  readRevisionDto,
  recordTrustedAgentEvaluation,
  setAgentDefinitionLifecycle,
} from "@/lib/agent-os/definition-store"
import { COMMERCIAL_CATALOG_VERSION, FOUNDER_PILOT_PRICE } from "@/lib/commercial-billing"
import { initialPolicyDraft } from "@/lib/control-center/drafts"
import {
  INTEGRATION_WITH_SESSION,
  anonClient,
  assertDisposableTarget,
  cleanup,
  ownerSessionClient,
  seedShop,
  type Seeded,
} from "./_db"

const PW = "Synthetic-password-123!"
const TABLES = [
  "agent_definition_state",
  "agent_definition_revisions",
  "agent_definition_memory_pins",
  "agent_definition_evaluations",
  "agent_definition_events",
] as const
const WRITERS = [
  "agent_definition_create_revision",
  "agent_definition_record_evaluation",
  "agent_definition_activate",
  "agent_definition_set_lifecycle",
] as const

/**
 * The local gateway occasionally reuses a keep-alive connection PostgREST has just closed
 * (HTTP 502 "Connection reset by peer"). The request never reached the database, so this
 * single-purpose service client retries ONLY that transport failure. Product behavior,
 * including every refusal, is never retried.
 */
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

// Harness transport noise (a keep-alive connection PostgREST just closed) is retried on
// fixture creation only; product behavior is never retried.
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

async function save(w: { shop: Seeded }, agentId: string, over: Record<string, unknown> = {}, extra: { requestId?: string; parent?: number | null; actorId?: string; shopId?: string } = {}) {
  return createAgentDefinitionRevision(
    { service: db },
    {
      shopId: extra.shopId ?? w.shop.shopId,
      actorId: extra.actorId ?? w.shop.ownerId,
      agentId,
      requestId: extra.requestId ?? randomUUID(),
      definition: definition(over),
      parentRevision: extra.parent ?? null,
    }
  )
}
async function saved(w: { shop: Seeded }, agentId: string, over: Record<string, unknown> = {}) {
  const r = await save(w, agentId, over)
  if (!r.ok) throw new Error(`save failed: ${r.code}`)
  return r
}

async function evaluate(w: { shop: Seeded }, agentId: string, rev: { revision: number; definitionHash: string }, patch: { passRate?: number; safetyPassed?: boolean; key?: string } = {}) {
  return recordTrustedAgentEvaluation(
    { service: db },
    {
      shopId: w.shop.shopId, agentId, revision: rev.revision, definitionHash: rev.definitionHash,
      evaluationKey: patch.key ?? `eval-${uniq()}`, suiteVersion: "2026-11-07.test", fixtureSetId: "fixtures-a", fixtureHash: "b".repeat(64),
      passRate: patch.passRate ?? 1, safetyPassed: patch.safetyPassed ?? true, estimatedCredits: 12, costEvidence: { basis: "synthetic" },
      completedAt: new Date(Date.now() - 1000).toISOString(),
    }
  )
}

const fingerprintOf = async (shopId: string) => {
  const r = await db.rpc("agent_definition_connector_fingerprint", { p_shop: shopId })
  expect(r.error).toBeNull()
  return r.data as string
}

const activate = (w: { shop: Seeded }, agentId: string, rev: { revision: number; definitionHash: string }, pointer: number | null = null, actorId?: string) =>
  activateAgentDefinition(
    { service: db },
    { shopId: w.shop.shopId, actorId: actorId ?? w.shop.ownerId, agentId, revision: rev.revision, expectedHash: rev.definitionHash, expectedPointer: pointer }
  )

async function readyRevision(w: World, agentId: string, over: Record<string, unknown> = {}) {
  const rev = await saved(w, agentId, over)
  const ev = await evaluate(w, agentId, rev)
  expect(ev.ok).toBe(true)
  return rev
}

// The DTO readers correctly report `unavailable` on any read error; the local gateway
// occasionally drops a keep-alive connection, so reads that are EXPECTED to succeed retry that.
async function okRead<T extends { status: string }>(fn: () => Promise<T>): Promise<T> {
  let last: T | undefined
  for (let i = 0; i < 4; i++) {
    last = await fn()
    if (last.status !== "unavailable") return last
    await new Promise((r) => setTimeout(r, 250 * (i + 1)))
  }
  return last!
}

const stateOf = async (agentId: string) =>
  (await db.from("agent_definition_state").select("*").eq("agent_id", agentId).maybeSingle()).data as
    | { lifecycle: string; active_revision: number | null; latest_revision: number; version: number }
    | null
const enabledOf = async (agentId: string) => (await db.from("custom_agents").select("enabled").eq("id", agentId).single()).data!.enabled as boolean
const events = async (agentId: string) =>
  (await db.from("agent_definition_events").select("*").eq("agent_id", agentId).order("seq")).data as { seq: number; kind: string; revision: number | null; evidence: Record<string, unknown> }[]

async function publishMemory(owner: SupabaseClient, shopId: string, content = "Deposits are refundable up to 24 hours before service.", retentionUntil: string | null = null) {
  const candidate = await owner.rpc("create_reviewed_memory_candidate", {
    p_shop: shopId, p_source_name: `Policy ${randomUUID()}`, p_content: content, p_chunks: [{ content, embedding: null }],
    p_source: null, p_expected_revision: null, p_valid_from: null, p_valid_until: null, p_retention_until: retentionUntil,
  })
  expect(candidate.error).toBeNull()
  const c = candidate.data as { source_id: string; revision: number }
  expect((await owner.rpc("review_memory_revision", { p_shop: shopId, p_source: c.source_id, p_revision: c.revision })).error).toBeNull()
  const pub = await owner.rpc("publish_memory_revision", { p_shop: shopId, p_source: c.source_id, p_revision: c.revision, p_expected_active: null })
  expect(pub.error).toBeNull()
  return { sourceId: c.source_id, revision: c.revision }
}

describe.skipIf(!INTEGRATION_WITH_SESSION)("agent definition revisions [integration]", { timeout: 90_000 }, () => {
  let w: World
  let other: World
  let manager: Seeded, staff: Seeded, revoked: Seeded, stranger: Seeded
  let anon: SupabaseClient

  beforeAll(async () => {
    db = resilientService()
    anon = anonClient()
    w = await world()
    other = await world()
    manager = await newUser()
    staff = await newUser()
    revoked = await newUser()
    stranger = await newUser()
    await addMember(w.shop.shopId, manager, "manager")
    await addMember(w.shop.shopId, staff, "staff")
    await addMember(w.shop.shopId, revoked, "staff", false)
  }, 120_000)

  afterAll(async () => {
    for (const s of seeded) await cleanup(db, s)
  })

  describe("immutable revisions, lineage and replay", () => {
    it("every save is a new immutable revision with lineage and a stable hash", async () => {
      const agent = await newAgent(w.shop)
      const first = await saved(w, agent)
      const second = await save(w, agent, {}, { parent: first.revision })
      expect(first).toMatchObject({ outcome: "created", revision: 1, parentRevision: null })
      expect(second).toMatchObject({ ok: true, outcome: "created", revision: 2, parentRevision: 1 })
      // A save that names no parent descends from the latest revision.
      const third = await save(w, agent)
      expect(third).toMatchObject({ ok: true, revision: 3, parentRevision: 2 })
      const rows = (await db.from("agent_definition_revisions").select("revision,definition,definition_hash,schema_version").eq("agent_id", agent).order("revision")).data!
      expect(rows.map((r) => r.revision)).toEqual([1, 2, 3])
      for (const r of rows) {
        expect(r.definition_hash).toMatch(/^[0-9a-f]{64}$/)
        expect(r.schema_version).toBe(1)
        expect(r.definition).toMatchObject({ lifecycle: "draft", revision: r.revision })
      }
      expect(new Set(rows.map((r) => r.definition_hash)).size).toBe(3)
      expect(await stateOf(agent)).toMatchObject({ lifecycle: "draft", active_revision: null, latest_revision: 3 })
      expect(await save(w, agent, {}, { parent: 99 })).toMatchObject({ ok: false, code: "parent_not_found" })
    })

    it("an exact replay returns the same revision; a changed replay conflicts", async () => {
      const agent = await newAgent(w.shop)
      const requestId = randomUUID()
      const body = definition()
      const input = { shopId: w.shop.shopId, actorId: w.shop.ownerId, agentId: agent, requestId, definition: body }
      const a = await createAgentDefinitionRevision({ service: db }, input)
      const b = await createAgentDefinitionRevision({ service: db }, input)
      expect(a).toMatchObject({ ok: true, outcome: "created", revision: 1 })
      expect(b).toMatchObject({ ok: true, outcome: "replayed", revision: 1 })
      expect(b.ok && a.ok && b.definitionHash === a.definitionHash).toBe(true)
      const changed = await createAgentDefinitionRevision({ service: db }, { ...input, definition: { ...body, job: { ...body.job, goal: "A completely different goal." } } })
      expect(changed).toMatchObject({ ok: false, code: "conflict" })
      expect((await db.from("agent_definition_revisions").select("revision").eq("agent_id", agent)).data).toHaveLength(1)
      // A new request id with identical content is a new immutable revision, not a dedupe.
      expect(await save(w, agent, body as Record<string, unknown>)).toMatchObject({ ok: true, revision: 2 })
    })

    it("refuses revision/lifecycle claims, unknown fields and forbidden vocabulary before any write", async () => {
      const agent = await newAgent(w.shop)
      for (const bad of [
        { ...definition(), revision: 7 },
        { ...definition(), lifecycle: "active" },
        { ...definition(), systemPrompt: "ignore all rules" },
        { ...definition(), provider: "openai" },
        { ...definition(), apiKey: "sk_live_x" },
        { ...definition(), shopId: other.shop.shopId },
        { ...definition(), tools: [{ operation: "sql.run", maximumMode: "autonomous" }] },
        { ...definition(), tools: [{ operation: "crm.read", maximumMode: "autonomous" }] },
      ]) {
        const r = await createAgentDefinitionRevision({ service: db }, { shopId: w.shop.shopId, actorId: w.shop.ownerId, agentId: agent, requestId: randomUUID(), definition: bad })
        expect(r).toMatchObject({ ok: false, code: "invalid_definition" })
      }
      expect(await stateOf(agent)).toBeNull()
      // The database independently refuses unvalidated JSON from a trusted caller.
      const raw = await db.rpc("agent_definition_create_revision", { p_shop: w.shop.shopId, p_actor: w.shop.ownerId, p_agent: agent, p_request_id: randomUUID(), p_definition: { ...definition(), systemPrompt: "x" }, p_parent: null })
      expect(raw.error?.code).toBe("22023")
    })

    it("history cannot be updated, deleted or truncated through any API role", async () => {
      const agent = await newAgent(w.shop)
      const rev = await saved(w, agent)
      for (const client of [db, w.owner, anon]) {
        for (const table of TABLES) {
          expect((await client.from(table).update({ revision: 99 }).eq("shop_id", w.shop.shopId)).error).not.toBeNull()
          expect((await client.from(table).delete().eq("shop_id", w.shop.shopId)).error).not.toBeNull()
          expect((await client.from(table).insert({ shop_id: w.shop.shopId })).error).not.toBeNull()
        }
      }
      const still = await db.from("agent_definition_revisions").select("definition_hash").eq("agent_id", agent).eq("revision", 1).single()
      expect(still.data?.definition_hash).toBe(rev.definitionHash)
    })
  })

  describe("authority", () => {
    it("only a live owner of the exact shop may save, evaluate-bind, activate, pause or block", async () => {
      const agent = await newAgent(w.shop)
      const rev = await readyRevision(w, agent)
      const impostors: [string, string][] = [
        ["manager", manager.ownerId], ["staff", staff.ownerId], ["revoked", revoked.ownerId],
        ["stranger", stranger.ownerId], ["other-shop owner", other.shop.ownerId], ["unknown user", randomUUID()],
      ]
      for (const [label, actorId] of impostors) {
        const create = await save(w, agent, {}, { actorId })
        expect(create, label).toMatchObject({ ok: false, code: "forbidden" })
        const act = await activate(w, agent, rev, null, actorId)
        expect(act.ok, label).toBe(false)
        const lifecycle = await setAgentDefinitionLifecycle({ service: db }, { shopId: w.shop.shopId, actorId, agentId: agent, lifecycle: "paused", reason: "nope", expectedPointer: null })
        expect(lifecycle, label).toMatchObject({ ok: false, code: "forbidden" })
      }
      expect(await stateOf(agent)).toMatchObject({ lifecycle: "draft", active_revision: null, latest_revision: 1 })
      expect(await enabledOf(agent)).toBe(false)
    })

    it("an agent of another shop is not found, never reachable by naming it", async () => {
      const foreign = await newAgent(other.shop)
      expect(await save(w, foreign)).toMatchObject({ ok: false, code: "agent_not_found" })
      expect(await stateOf(foreign)).toBeNull()
      const rev = await saved(other, foreign)
      const ev = await evaluate(w, foreign, rev)
      expect(ev).toMatchObject({ ok: false, code: "agent_not_found" })
    })

    it("browser roles can execute none of the writers and read none of the tables", async () => {
      const agent = await newAgent(w.shop)
      const rev = await readyRevision(w, agent)
      const args: Record<(typeof WRITERS)[number], Record<string, unknown>> = {
        agent_definition_create_revision: { p_shop: w.shop.shopId, p_actor: w.shop.ownerId, p_agent: agent, p_request_id: randomUUID(), p_definition: definition(), p_parent: null },
        agent_definition_record_evaluation: {
          p_shop: w.shop.shopId, p_agent: agent, p_revision: 1, p_definition_hash: rev.definitionHash, p_evaluation_key: "forged", p_suite_version: "x",
          p_fixture_set_id: "x", p_fixture_hash: "c".repeat(64), p_pass_rate: 1, p_safety_passed: true, p_estimated_credits: 0, p_cost_evidence: {},
          p_completed_at: new Date().toISOString(), p_source: "trusted_evaluator",
        },
        agent_definition_activate: { p_shop: w.shop.shopId, p_actor: w.shop.ownerId, p_agent: agent, p_revision: 1, p_expected_hash: rev.definitionHash, p_expected_pointer: null, p_policy_revision: w.policyRevision, p_knowledge_revision: 1, p_ready_operations: ["crm.read"], p_connector_fingerprint: await fingerprintOf(w.shop.shopId) },
        agent_definition_set_lifecycle: { p_shop: w.shop.shopId, p_actor: w.shop.ownerId, p_agent: agent, p_lifecycle: "paused", p_reason: "x", p_expected_pointer: null },
      }
      for (const client of [w.owner, anon]) {
        for (const fn of WRITERS) expect((await client.rpc(fn, args[fn])).error, fn).not.toBeNull()
        expect((await client.rpc("agent_definition_actor_role", { p_shop: w.shop.shopId, p_actor: w.shop.ownerId })).error).not.toBeNull()
        expect((await client.rpc("agent_definition_connector_fingerprint", { p_shop: w.shop.shopId })).error).not.toBeNull()
        for (const table of TABLES) expect((await client.from(table).select("*").limit(1)).error, table).not.toBeNull()
      }
      // A forged evaluation never exists: nothing was recorded by the denied attempts.
      expect((await db.from("agent_definition_evaluations").select("id").eq("agent_id", agent).eq("evaluation_key", "forged")).data).toEqual([])
      // And a source other than the trusted evaluator is refused even for the service role.
      const forged = await db.rpc("agent_definition_record_evaluation", { ...args.agent_definition_record_evaluation, p_source: "client" })
      expect(forged.error?.code).toBe("22023")
    })
  })

  describe("activation", () => {
    it("activates one exact revision atomically: pointer, enabled flag and evidence together", async () => {
      const agent = await newAgent(w.shop)
      const rev = await readyRevision(w, agent)
      const r = await activate(w, agent, rev)
      expect(r).toEqual({ ok: true, outcome: "activated", revision: 1 })
      expect(await stateOf(agent)).toMatchObject({ lifecycle: "active", active_revision: 1 })
      expect(await enabledOf(agent)).toBe(true)
      const log = await events(agent)
      expect(log.map((e) => e.kind)).toEqual(["revision_created", "activated"])
      const evidence = log[1].evidence
      expect(evidence).toMatchObject({
        definition_hash: rev.definitionHash, schema_version: 1, policy_revision: w.policyRevision, knowledge_revision: 1,
        commercial_outcome: "activated", ready_operations: ["crm.read"],
      })
      expect(typeof evidence.evaluation_id).toBe("string")
      expect(typeof evidence.billing_evidence_id).toBe("string")
      // Idempotent: the same pointer + same revision is a no-op, not a second pointer.
      expect(await activate(w, agent, rev, 1)).toEqual({ ok: true, outcome: "already_active", revision: 1 })
      expect((await events(agent)).filter((e) => e.kind === "activated")).toHaveLength(1)
      await db.from("custom_agents").update({ enabled: false }).eq("id", agent)
    })

    it("supersedes by pointer, keeps old revisions untouched and appends history", async () => {
      const x = await world()
      const agent = await newAgent(x.shop)
      const r1 = await readyRevision(x, agent)
      expect((await activate(x, agent, r1)).ok).toBe(true)
      const before = (await db.from("agent_definition_revisions").select("*").eq("agent_id", agent).eq("revision", 1).single()).data
      const r2 = await readyRevision(x, agent, { job: { roleLabel: "Quote follow-up", goal: "A revised goal for the agent.", expectedOutcomes: ["Quote answered"], stopConditions: ["Customer says stop"] } })
      expect(r2.revision).toBe(2)
      // Activating with a stale view of the pointer is refused.
      expect(await activate(x, agent, r2, null)).toMatchObject({ ok: false, code: "pointer_changed" })
      expect(await activate(x, agent, r2, 1)).toEqual({ ok: true, outcome: "activated", revision: 2 })
      expect(await stateOf(agent)).toMatchObject({ lifecycle: "active", active_revision: 2 })
      expect((await events(agent)).map((e) => e.kind)).toEqual(["revision_created", "activated", "revision_created", "superseded", "activated"])
      const after = (await db.from("agent_definition_revisions").select("*").eq("agent_id", agent).eq("revision", 1).single()).data
      expect(after).toEqual(before)
    })

    it("refuses a stale or wrong binding: hash, revision, pointer", async () => {
      const x = await world()
      const agent = await newAgent(x.shop)
      const rev = await readyRevision(x, agent)
      expect(await activate(x, agent, { ...rev, definitionHash: "d".repeat(64) })).toMatchObject({ ok: false, code: "definition_hash_mismatch" })
      expect(await activate(x, agent, { revision: 9, definitionHash: rev.definitionHash })).toMatchObject({ ok: false, code: "revision_not_found" })
      expect(await activate(x, agent, rev, 3)).toMatchObject({ ok: false, code: "pointer_changed" })
      expect(await stateOf(agent)).toMatchObject({ lifecycle: "draft", active_revision: null })
      expect(await enabledOf(agent)).toBe(false)
      // The database refuses the same bindings on its own, independent of the application.
      const fp = await fingerprintOf(x.shop.shopId)
      const raw = (over: Record<string, unknown>) => db.rpc("agent_definition_activate", { p_shop: x.shop.shopId, p_actor: x.shop.ownerId, p_agent: agent, p_revision: 1, p_expected_hash: rev.definitionHash, p_expected_pointer: null, p_policy_revision: x.policyRevision, p_knowledge_revision: 1, p_ready_operations: ["crm.read"], p_connector_fingerprint: fp, ...over })
      expect((await raw({ p_expected_hash: "e".repeat(64) })).data).toMatchObject({ outcome: "blocked", code: "definition_hash_mismatch" })
      expect((await raw({ p_policy_revision: x.policyRevision + 5 })).data).toMatchObject({ outcome: "blocked", reasons: ["policy_stale"] })
      expect((await raw({ p_knowledge_revision: 9 })).data).toMatchObject({ outcome: "blocked", reasons: ["knowledge_stale"] })
      expect((await raw({ p_ready_operations: [] })).data).toMatchObject({ outcome: "blocked", reasons: ["tool_not_ready"] })
      expect((await raw({ p_ready_operations: null })).error?.code).toBe("22023")
      expect(await enabledOf(agent)).toBe(false)
    })

    it("blocks activation when connector evidence changes after it was read (stale readiness)", async () => {
      const x = await world()
      const agent = await newAgent(x.shop)
      const rev = await readyRevision(x, agent)
      const before = await fingerprintOf(x.shop.shopId)
      // The database itself refuses an arbitrary, missing or outdated fingerprint.
      const raw = (fp: unknown) => db.rpc("agent_definition_activate", { p_shop: x.shop.shopId, p_actor: x.shop.ownerId, p_agent: agent, p_revision: 1, p_expected_hash: rev.definitionHash, p_expected_pointer: null, p_policy_revision: x.policyRevision, p_knowledge_revision: 1, p_ready_operations: ["crm.read"], p_connector_fingerprint: fp })
      expect((await raw("0".repeat(64))).data).toMatchObject({ outcome: "blocked", reasons: ["connector_stale"] })
      expect((await raw(null)).error?.code).toBe("22023")

      // Race: the application reads readiness, THEN a connector changes, THEN the activation RPC runs.
      const racing = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop !== "rpc") return Reflect.get(target, prop, receiver)
          return async (fn: string, args: Record<string, unknown>) => {
            if (fn === "agent_definition_activate") {
              const mutate = await db.from("shops").update({ aurinko_account_id: Date.now() }).eq("id", x.shop.shopId)
              expect(mutate.error).toBeNull()
            }
            return (db as unknown as { rpc: (f: string, a: Record<string, unknown>) => unknown }).rpc(fn, args)
          }
        },
      }) as typeof db
      const result = await activateAgentDefinition(
        { service: racing },
        { shopId: x.shop.shopId, actorId: x.shop.ownerId, agentId: agent, revision: 1, expectedHash: rev.definitionHash, expectedPointer: null }
      )
      expect(result).toMatchObject({ ok: false, reasons: ["connector_stale"] })
      expect(await fingerprintOf(x.shop.shopId)).not.toBe(before)
      expect(await enabledOf(agent)).toBe(false)
      expect(await stateOf(agent)).toMatchObject({ lifecycle: "draft", active_revision: null })
      expect((await events(agent)).map((e) => e.kind)).toEqual(["revision_created"])

      // Reading again binds to the new evidence and activation succeeds; the evidence is recorded.
      expect(await activate(x, agent, rev)).toEqual({ ok: true, outcome: "activated", revision: 1 })
      const activated = (await events(agent)).find((e) => e.kind === "activated")
      expect((activated?.evidence as { connector_fingerprint?: string } | undefined)?.connector_fingerprint).toBe(await fingerprintOf(x.shop.shopId))
    })

    it("fails closed without exact-revision evaluation evidence, and on a safety or quality failure", async () => {
      const x = await world()
      const agent = await newAgent(x.shop)
      const rev = await saved(x, agent)
      expect(await activate(x, agent, rev)).toMatchObject({ ok: false, reasons: ["evaluation_required"] })
      // Evidence for a DIFFERENT revision never satisfies this one.
      const rev2 = await saved(x, agent)
      expect((await evaluate(x, agent, rev2)).ok).toBe(true)
      expect(await activate(x, agent, rev)).toMatchObject({ ok: false, reasons: ["evaluation_required"] })
      expect((await evaluate(x, agent, rev, { passRate: 0.9 })).ok).toBe(true)
      expect(await activate(x, agent, rev)).toMatchObject({ ok: false, reasons: ["quality_evaluation_failed"] })
      expect((await evaluate(x, agent, rev, { safetyPassed: false, passRate: 1 })).ok).toBe(true)
      expect(await activate(x, agent, rev)).toMatchObject({ ok: false, reasons: ["safety_evaluation_failed"] })
      // A later passing run is the newest evidence; failures stay in the append-only record.
      expect((await evaluate(x, agent, rev)).ok).toBe(true)
      expect(await activate(x, agent, rev)).toEqual({ ok: true, outcome: "activated", revision: 1 })
      expect((await db.from("agent_definition_evaluations").select("id").eq("agent_id", agent).eq("revision", 1)).data).toHaveLength(3)
    })

    it("evaluation evidence is exact-revision, replay-safe and append-only", async () => {
      const x = await world()
      const agent = await newAgent(x.shop)
      const rev = await saved(x, agent)
      const base = { shopId: x.shop.shopId, agentId: agent, revision: 1, definitionHash: rev.definitionHash, evaluationKey: "k1", suiteVersion: "s", fixtureSetId: "f", fixtureHash: "a".repeat(64), passRate: 1, safetyPassed: true, estimatedCredits: 3, completedAt: new Date(Date.now() - 5000).toISOString() }
      const a = await recordTrustedAgentEvaluation({ service: db }, base)
      const b = await recordTrustedAgentEvaluation({ service: db }, base)
      expect(a).toMatchObject({ ok: true, outcome: "recorded" })
      expect(b).toMatchObject({ ok: true, outcome: "replayed" })
      expect(a.ok && b.ok && a.evaluationId === b.evaluationId).toBe(true)
      expect(await recordTrustedAgentEvaluation({ service: db }, { ...base, passRate: 0.5 })).toMatchObject({ ok: false, code: "conflict" })
      expect(await recordTrustedAgentEvaluation({ service: db }, { ...base, evaluationKey: "k2", definitionHash: "f".repeat(64) })).toMatchObject({ ok: false, code: "definition_hash_mismatch" })
      expect(await recordTrustedAgentEvaluation({ service: db }, { ...base, evaluationKey: "k3", revision: 4 })).toMatchObject({ ok: false, code: "revision_not_found" })
      // Future-dated "completion" is refused by the table.
      const future = await recordTrustedAgentEvaluation({ service: db }, { ...base, evaluationKey: "k4", completedAt: new Date(Date.now() + 3_600_000).toISOString() })
      expect(future.ok).toBe(false)
    })

    it("blocks on a connector that is not ready, naming the tool", async () => {
      const x = await world()
      const agent = await newAgent(x.shop)
      const rev = await readyRevision(x, agent, { tools: [{ operation: "crm.read", maximumMode: "read" }, { operation: "sms.reply", maximumMode: "approval" }] })
      const r = await activate(x, agent, rev)
      expect(r).toMatchObject({ ok: false, reasons: ["tool_not_ready"] })
      const elig = await readActivationEligibility({ service: db }, { shopId: x.shop.shopId, actorId: x.shop.ownerId, agentId: agent, revision: 1 })
      expect(elig).toMatchObject({ status: "ok", data: { eligible: false } })
      expect(elig.status === "ok" && elig.data.sources?.readyOperations).toEqual(["crm.read"])
      expect(await enabledOf(agent)).toBe(false)
    })

    it("blocks on a policy that turns a requested tool off, and when no policy is active", async () => {
      const x = await world()
      const agent = await newAgent(x.shop)
      const rev = await readyRevision(x, agent, { tools: [{ operation: "voice.outbound", maximumMode: "off" }] })
      const r = await activate(x, agent, rev)
      expect(r.ok).toBe(false)
      const noPolicy = await world({ policy: false })
      const a2 = await newAgent(noPolicy.shop)
      const rev2 = await readyRevision(noPolicy, a2)
      expect(await activate(noPolicy, a2, rev2)).toMatchObject({ ok: false, reasons: expect.arrayContaining(["policy_unavailable"]) })
    })

    it("a newer policy revision after the application evaluated blocks (database re-check)", async () => {
      const x = await world()
      const agent = await newAgent(x.shop)
      const rev = await readyRevision(x, agent)
      // Another owner action publishes a new policy revision between evaluation and write.
      const current = await x.owner.from("control_policy_drafts").select("revision").eq("shop_id", x.shop.shopId).single()
      const saveRes = await x.owner.rpc("save_control_policy_draft", { p_shop: x.shop.shopId, p_expected_revision: current.data!.revision, p_definition: { ...initialPolicyDraft(), workspaceCeiling: "approval" } })
      expect(saveRes.error).toBeNull()
      const act = await x.owner.rpc("activate_control_policy", { p_shop: x.shop.shopId, p_revision: saveRes.data, p_expected_active: x.policyRevision })
      expect(act.error).toBeNull()
      const raw = await db.rpc("agent_definition_activate", { p_shop: x.shop.shopId, p_actor: x.shop.ownerId, p_agent: agent, p_revision: 1, p_expected_hash: rev.definitionHash, p_expected_pointer: null, p_policy_revision: x.policyRevision, p_knowledge_revision: 1, p_ready_operations: ["crm.read"], p_connector_fingerprint: await fingerprintOf(x.shop.shopId) })
      expect(raw.data).toMatchObject({ outcome: "blocked", reasons: ["policy_stale"] })
      // The application path reloads the new revision and succeeds.
      expect(await activate(x, agent, rev)).toEqual({ ok: true, outcome: "activated", revision: 1 })
    })

    it("pins reviewed memory exactly; stale, revoked, expired and wrong-shop memory is refused", async () => {
      const x = await world()
      const mem = await publishMemory(x.owner, x.shop.shopId)
      const agent = await newAgent(x.shop)
      const rev = await readyRevision(x, agent, { knowledge: { sourceIds: [mem.sourceId], includeShopKnowledge: true, includeCustomerMemory: false, maxResultsPerQuery: 4 } })
      const pins = (await db.from("agent_definition_memory_pins").select("*").eq("agent_id", agent).eq("revision", 1)).data!
      expect(pins).toMatchObject([{ source_id: mem.sourceId, memory_revision: mem.revision }])

      // Another shop's published memory can never be selected.
      const foreignMem = await publishMemory(other.owner, other.shop.shopId)
      const wrong = await save(x, agent, { knowledge: { sourceIds: [foreignMem.sourceId], includeShopKnowledge: true, includeCustomerMemory: false, maxResultsPerQuery: 4 } })
      expect(wrong).toMatchObject({ ok: false, code: "memory_not_selectable", sourceIds: [foreignMem.sourceId] })
      // Candidate (unreviewed) memory cannot be selected either.
      const cand = await x.owner.rpc("create_reviewed_memory_candidate", { p_shop: x.shop.shopId, p_source_name: `Draft ${randomUUID()}`, p_content: "Not reviewed yet.", p_chunks: [{ content: "Not reviewed yet.", embedding: null }], p_source: null, p_expected_revision: null, p_valid_from: null, p_valid_until: null, p_retention_until: null })
      const candidateSource = (cand.data as { source_id: string }).source_id
      expect(await save(x, agent, { knowledge: { sourceIds: [candidateSource], includeShopKnowledge: true, includeCustomerMemory: false, maxResultsPerQuery: 4 } })).toMatchObject({ ok: false, code: "memory_not_selectable" })

      // Healthy first, then each way memory can go stale.
      const ok = await activate(x, agent, rev)
      expect(ok).toEqual({ ok: true, outcome: "activated", revision: 1 })
      await db.from("custom_agents").update({ enabled: false }).eq("id", agent)
      await setAgentDefinitionLifecycle({ service: db }, { shopId: x.shop.shopId, actorId: x.shop.ownerId, agentId: agent, lifecycle: "paused", reason: "retest", expectedPointer: 1 })

      // 1) A newer reviewed revision is published: the pin is stale (never silently refreshed).
      const next = await x.owner.rpc("create_reviewed_memory_candidate", { p_shop: x.shop.shopId, p_source_name: "ignored", p_content: "Deposits are refundable up to 48 hours before service.", p_chunks: [{ content: "Deposits are refundable up to 48 hours before service.", embedding: null }], p_source: mem.sourceId, p_expected_revision: mem.revision, p_valid_from: null, p_valid_until: null, p_retention_until: null })
      expect(next.error).toBeNull()
      const n = next.data as { source_id: string; revision: number }
      expect((await x.owner.rpc("review_memory_revision", { p_shop: x.shop.shopId, p_source: n.source_id, p_revision: n.revision })).error).toBeNull()
      expect((await x.owner.rpc("publish_memory_revision", { p_shop: x.shop.shopId, p_source: n.source_id, p_revision: n.revision, p_expected_active: mem.revision })).error).toBeNull()
      const stale = await activate(x, agent, rev, 1)
      expect(stale).toMatchObject({ ok: false, reasons: expect.arrayContaining(["memory_stale"]) })

      // 2) The newer revision is revoked: the original pin is no longer the active one.
      expect((await x.owner.rpc("remove_memory_revision", { p_shop: x.shop.shopId, p_source: n.source_id, p_revision: n.revision, p_expected_active: n.revision })).error).toBeNull()
      const revoked = await activate(x, agent, rev, 1)
      expect(revoked).toMatchObject({ ok: false })
      expect(await enabledOf(agent)).toBe(false)
    })

    it("an expired retention window blocks activation", async () => {
      const x = await world()
      // Generous window so a loaded machine can still save the revision before it lapses.
      const lapse = Date.now() + 12_000
      const mem = await publishMemory(x.owner, x.shop.shopId, "Short-lived promotion terms.", new Date(lapse).toISOString())
      const agent = await newAgent(x.shop)
      const rev = await readyRevision(x, agent, { knowledge: { sourceIds: [mem.sourceId], includeShopKnowledge: true, includeCustomerMemory: false, maxResultsPerQuery: 4 } })
      // While the window is open the same evidence is healthy (so the block below is expiry, nothing else).
      const healthy = await okRead(() => readActivationEligibility({ service: db }, { shopId: x.shop.shopId, actorId: x.shop.ownerId, agentId: agent, revision: 1 }))
      expect(healthy.status === "ok" && healthy.data.blockers).toEqual([])
      await new Promise((r) => setTimeout(r, Math.max(0, lapse - Date.now()) + 1500))
      const r = await activate(x, agent, rev)
      expect(r).toMatchObject({ ok: false })
      expect(r.ok === false && r.reasons).toContain("memory_expired")
      expect(await enabledOf(agent)).toBe(false)
    })

    it("revoked memory blocks activation of a revision pinned to it", async () => {
      const x = await world()
      const mem = await publishMemory(x.owner, x.shop.shopId)
      const agent = await newAgent(x.shop)
      const rev = await readyRevision(x, agent, { knowledge: { sourceIds: [mem.sourceId], includeShopKnowledge: true, includeCustomerMemory: false, maxResultsPerQuery: 4 } })
      expect((await x.owner.rpc("remove_memory_revision", { p_shop: x.shop.shopId, p_source: mem.sourceId, p_revision: mem.revision, p_expected_active: mem.revision })).error).toBeNull()
      expect(await activate(x, agent, rev)).toMatchObject({ ok: false, reasons: expect.arrayContaining(["memory_revoked"]) })
      expect(await enabledOf(agent)).toBe(false)
      expect(await stateOf(agent)).toMatchObject({ lifecycle: "draft", active_revision: null })
    })

    it("a missing Founder Pilot subscription blocks activation and writes nothing", async () => {
      const x = await world({ billing: false })
      const agent = await newAgent(x.shop)
      const rev = await readyRevision(x, agent)
      const r = await activate(x, agent, rev)
      expect(r).toMatchObject({ ok: false, code: "billing_not_active" })
      expect(await stateOf(agent)).toMatchObject({ lifecycle: "draft", active_revision: null })
      expect(await enabledOf(agent)).toBe(false)
      expect((await events(agent)).map((e) => e.kind)).toEqual(["revision_created"])
    })
  })

  describe("rollback in both directions", () => {
    it("a pointer/history write failure after the enabling write rolls `enabled` back too", async () => {
      const x = await world()
      const agent = await newAgent(x.shop)
      const rev = await readyRevision(x, agent)
      // The history row is the last write. An oversized evidence payload violates its CHECK
      // AFTER commercial_agent_activate has enabled the agent and the pointer row was updated.
      const flood = Array.from({ length: 2000 }, () => "crm.read")
      const r = await db.rpc("agent_definition_activate", { p_shop: x.shop.shopId, p_actor: x.shop.ownerId, p_agent: agent, p_revision: 1, p_expected_hash: rev.definitionHash, p_expected_pointer: null, p_policy_revision: x.policyRevision, p_knowledge_revision: 1, p_ready_operations: flood, p_connector_fingerprint: await fingerprintOf(x.shop.shopId) })
      expect(r.error).not.toBeNull()
      expect(await enabledOf(agent)).toBe(false)
      expect(await stateOf(agent)).toMatchObject({ lifecycle: "draft", active_revision: null, version: 2 })
      expect((await events(agent)).map((e) => e.kind)).toEqual(["revision_created"])
      expect((await db.from("custom_agents").select("enabled").eq("id", agent).single()).data?.enabled).toBe(false)
      // The same revision then activates normally: nothing was left half-written.
      expect(await activate(x, agent, rev)).toEqual({ ok: true, outcome: "activated", revision: 1 })
    })

    it("a commercial refusal never moves the pointer (billing missing / cap reached)", async () => {
      const x = await world()
      const a1 = await newAgent(x.shop)
      const a2 = await newAgent(x.shop)
      const a3 = await newAgent(x.shop)
      const r1 = await readyRevision(x, a1)
      const r2 = await readyRevision(x, a2)
      const r3 = await readyRevision(x, a3)
      expect((await activate(x, a1, r1)).ok).toBe(true)
      expect((await activate(x, a2, r2)).ok).toBe(true)
      expect(await activate(x, a3, r3)).toMatchObject({ ok: false, code: "active_agent_limit_reached" })
      expect(await stateOf(a3)).toMatchObject({ lifecycle: "draft", active_revision: null })
      expect(await enabledOf(a3)).toBe(false)
      expect((await events(a3)).map((e) => e.kind)).toEqual(["revision_created"])
    })
  })

  describe("concurrency", () => {
    it("concurrent revision saves get deterministic, gapless numbers", async () => {
      const agent = await newAgent(w.shop)
      const results = await Promise.all(Array.from({ length: 8 }, () => save(w, agent)))
      expect(results.every((r) => r.ok)).toBe(true)
      const numbers = results.map((r) => (r.ok ? r.revision : 0)).sort((a, b) => a - b)
      expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
      expect(await stateOf(agent)).toMatchObject({ latest_revision: 8 })
      // Every non-first revision has a lineage parent that precedes it.
      const rows = (await db.from("agent_definition_revisions").select("revision,parent_revision").eq("agent_id", agent).order("revision")).data!
      expect(rows[0].parent_revision).toBeNull()
      for (const r of rows.slice(1)) expect(r.parent_revision).toBeLessThan(r.revision)
      expect((await events(agent)).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    })

    it("concurrent replays of one request id create exactly one revision", async () => {
      const agent = await newAgent(w.shop)
      const requestId = randomUUID()
      const body = definition()
      const results = await Promise.all(
        Array.from({ length: 6 }, () => createAgentDefinitionRevision({ service: db }, { shopId: w.shop.shopId, actorId: w.shop.ownerId, agentId: agent, requestId, definition: body }))
      )
      expect(results.every((r) => r.ok && r.revision === 1)).toBe(true)
      expect(results.filter((r) => r.ok && r.outcome === "created")).toHaveLength(1)
      expect((await db.from("agent_definition_revisions").select("revision").eq("agent_id", agent)).data).toHaveLength(1)
    })

    it("concurrent activations never exceed the two-agent cap and leave one pointer each", async () => {
      const x = await world()
      const agents = await Promise.all([newAgent(x.shop), newAgent(x.shop), newAgent(x.shop), newAgent(x.shop)])
      const revs = await Promise.all(agents.map((a) => readyRevision(x, a)))
      const results = await Promise.all(agents.map((a, i) => activate(x, a, revs[i])))
      expect(results.filter((r) => r.ok)).toHaveLength(2)
      expect(results.filter((r) => !r.ok && r.code === "active_agent_limit_reached")).toHaveLength(2)
      const enabled = (await db.from("custom_agents").select("id").eq("shop_id", x.shop.shopId).eq("enabled", true)).data!
      expect(enabled).toHaveLength(2)
      for (let i = 0; i < agents.length; i++) {
        const st = await stateOf(agents[i])
        const on = enabled.some((e) => e.id === agents[i])
        expect(st).toMatchObject(on ? { lifecycle: "active", active_revision: 1 } : { lifecycle: "draft", active_revision: null })
      }
      expect((await db.from("agent_definition_state").select("agent_id").eq("shop_id", x.shop.shopId)).data).toHaveLength(4)
    })

    it("two simultaneous activations of different revisions of one agent leave exactly one pointer", async () => {
      const x = await world()
      const agent = await newAgent(x.shop)
      const r1 = await readyRevision(x, agent)
      const r2 = await readyRevision(x, agent)
      const results = await Promise.all([activate(x, agent, r1), activate(x, agent, r2)])
      expect(results.filter((r) => r.ok)).toHaveLength(1)
      expect(results.filter((r) => !r.ok && r.code === "pointer_changed")).toHaveLength(1)
      const st = await stateOf(agent)
      expect(st?.lifecycle).toBe("active")
      expect([1, 2]).toContain(st?.active_revision)
      expect((await events(agent)).filter((e) => e.kind === "activated")).toHaveLength(1)
      expect((await db.from("custom_agents").select("id").eq("shop_id", x.shop.shopId).eq("enabled", true)).data).toHaveLength(1)
    })
  })

  describe("lifecycle and run claims", () => {
    const claim = (agentId: string, key = `window-${uniq()}`) =>
      db.rpc("claim_scheduled_agent_run", { p_agent: agentId, p_trigger_key: key, p_worker: randomUUID(), p_lease_seconds: 60 })

    it("paused and blocked definitions cannot create new run claims; resume needs fresh activation", async () => {
      const x = await world()
      const agent = await newAgent(x.shop)
      const rev = await readyRevision(x, agent)
      expect((await activate(x, agent, rev)).ok).toBe(true)
      expect((await claim(agent)).data).toMatchObject({ outcome: "claimed" })

      const pause = await setAgentDefinitionLifecycle({ service: db }, { shopId: x.shop.shopId, actorId: x.shop.ownerId, agentId: agent, lifecycle: "paused", reason: "Holiday", expectedPointer: 1 })
      expect(pause).toEqual({ ok: true, outcome: "changed" })
      expect(await stateOf(agent)).toMatchObject({ lifecycle: "paused", active_revision: 1 })
      expect(await enabledOf(agent)).toBe(false)
      expect((await claim(agent)).data).toEqual({ outcome: "agent_unavailable" })
      // Even a forced enabled flag cannot let a paused definition claim.
      expect((await db.from("custom_agents").update({ enabled: true }).eq("id", agent)).error).not.toBeNull()

      const again = await setAgentDefinitionLifecycle({ service: db }, { shopId: x.shop.shopId, actorId: x.shop.ownerId, agentId: agent, lifecycle: "paused", reason: "Holiday", expectedPointer: 1 })
      expect(again).toEqual({ ok: true, outcome: "unchanged" })
      expect(await setAgentDefinitionLifecycle({ service: db }, { shopId: x.shop.shopId, actorId: x.shop.ownerId, agentId: agent, lifecycle: "paused", reason: "x", expectedPointer: 7 })).toMatchObject({ ok: false, code: "pointer_changed" })

      const block = await setAgentDefinitionLifecycle({ service: db }, { shopId: x.shop.shopId, actorId: x.shop.ownerId, agentId: agent, lifecycle: "blocked", reason: "Compliance hold", expectedPointer: 1 })
      expect(block).toEqual({ ok: true, outcome: "changed" })
      expect((await claim(agent)).data).toEqual({ outcome: "agent_unavailable" })
      expect(await setAgentDefinitionLifecycle({ service: db }, { shopId: x.shop.shopId, actorId: x.shop.ownerId, agentId: agent, lifecycle: "paused", reason: "x", expectedPointer: 1 })).toMatchObject({ ok: false, code: "invalid_transition" })

      // Resuming is an ordinary activation with fresh evidence.
      expect(await activate(x, agent, rev, 1)).toEqual({ ok: true, outcome: "activated", revision: 1 })
      expect((await claim(agent)).data).toMatchObject({ outcome: "claimed" })
      expect((await events(agent)).map((e) => e.kind)).toEqual(["revision_created", "activated", "paused", "blocked", "activated"])
    })

    it("turning a governed agent off directly pauses its pointer; turning it on directly is refused", async () => {
      const x = await world()
      const agent = await newAgent(x.shop)
      const rev = await readyRevision(x, agent)
      expect((await activate(x, agent, rev)).ok).toBe(true)
      const off = await x.owner.from("custom_agents").update({ enabled: false }).eq("id", agent)
      expect(off.error).toBeNull()
      expect(await stateOf(agent)).toMatchObject({ lifecycle: "paused", active_revision: 1 })
      expect((await events(agent)).at(-1)).toMatchObject({ kind: "paused", evidence: { reason: "disabled_directly" } })
      // Neither the owner session nor the service role can enable a governed agent around activation.
      expect((await x.owner.from("custom_agents").update({ enabled: true }).eq("id", agent)).error).not.toBeNull()
      expect((await db.from("custom_agents").update({ enabled: true }).eq("id", agent)).error).not.toBeNull()
      expect(await enabledOf(agent)).toBe(false)
    })

    it("legacy agents are never rewritten: no state row, unchanged claims, and no silent conversion", async () => {
      const x = await world()
      const legacyOff = await newAgent(x.shop)
      const legacyOn = await newAgent(x.shop, true)
      expect(await stateOf(legacyOn)).toBeNull()
      expect((await claim(legacyOn)).data).toMatchObject({ outcome: "claimed" })
      // An enabled legacy agent must be turned off by its owner before it can be governed.
      expect(await save(x, legacyOn)).toMatchObject({ ok: false, code: "legacy_agent_enabled" })
      expect(await stateOf(legacyOn)).toBeNull()
      expect(await enabledOf(legacyOn)).toBe(true)
      const home = await okRead(() => readAgentsHomeDto({ service: db }, { shopId: x.shop.shopId, actorId: x.shop.ownerId }))
      expect(home.status).toBe("ok")
      if (home.status === "ok") {
        const on = home.data.agents.find((a) => a.agentId === legacyOn)!
        expect(on).toMatchObject({ governance: "legacy_unversioned", lifecycle: "legacy_unversioned", activeRevision: null, latestRevision: null, enabled: true })
        const off = home.data.agents.find((a) => a.agentId === legacyOff)!
        expect(off).toMatchObject({ governance: "legacy_unversioned", lifecycle: "legacy_unversioned", enabled: false })
        expect(home.data.activeAgentCount).toBe(1)
      }
      // A legacy agent has nothing to activate: it can never become an active definition by accident.
      const act = await activateAgentDefinition({ service: db }, { shopId: x.shop.shopId, actorId: x.shop.ownerId, agentId: legacyOff, revision: 1, expectedHash: "a".repeat(64), expectedPointer: null })
      expect(act).toMatchObject({ ok: false, code: "definition_not_found" })
    })
  })

  describe("DTOs", () => {
    it("serve the home, builder-resume, detail and revision shapes with truthful states", async () => {
      const x = await world()
      const mem = await publishMemory(x.owner, x.shop.shopId)
      const agent = await newAgent(x.shop)
      const other2 = await newAgent(x.shop)

      // Nothing saved yet.
      const empty = await okRead(() => readBuilderResumeDto({ service: db }, { shopId: x.shop.shopId, actorId: x.shop.ownerId, agentId: agent }))
      expect(empty).toMatchObject({ status: "ok", data: { governance: "legacy_unversioned", latestRevision: null, canEdit: true, eligibility: null } })
      expect(empty.status === "ok" && Object.values(empty.data.steps)).toEqual(Array(7).fill("incomplete"))

      const rev = await readyRevision(x, agent, { knowledge: { sourceIds: [mem.sourceId], includeShopKnowledge: true, includeCustomerMemory: false, maxResultsPerQuery: 4 } })
      const resume = await okRead(() => readBuilderResumeDto({ service: db }, { shopId: x.shop.shopId, actorId: x.shop.ownerId, agentId: agent }))
      expect(resume.status).toBe("ok")
      if (resume.status !== "ok") return
      expect(resume.data).toMatchObject({ governance: "governed", lifecycle: "draft", role: "owner", canEdit: true, editBlockedReason: null })
      expect(resume.data.latestRevision).toMatchObject({ revision: 1, definitionHash: rev.definitionHash, parentRevision: null })
      expect(resume.data.latestRevision?.definition.knowledge.sourceIds).toEqual([mem.sourceId])
      expect(resume.data.latestRevision?.memoryPins).toMatchObject([{ sourceId: mem.sourceId, memoryRevision: mem.revision, status: "current" }])
      expect(resume.data.steps).toEqual({ job: "complete", knowledge: "complete", tools: "complete", limits: "complete", schedule: "complete", test: "complete", activate: "incomplete" })
      expect(resume.data.eligibility).toMatchObject({ eligible: true, alreadyActive: false, blockers: [] })
      expect(resume.data.eligibility?.sources).toMatchObject({ definitionHash: rev.definitionHash, schemaVersion: 1, policyRevision: x.policyRevision, knowledgeRevision: 1, expectedPointer: null, activeAgentLimit: 2, readyOperations: ["crm.read"] })

      expect((await activate(x, agent, rev)).ok).toBe(true)
      await saved(x, agent) // a newer, unactivated draft

      const home = await okRead(() => readAgentsHomeDto({ service: db }, { shopId: x.shop.shopId, actorId: x.shop.ownerId }))
      expect(home.status).toBe("ok")
      if (home.status !== "ok") return
      expect(home.data).toMatchObject({ role: "owner", canManage: true, activeAgentCount: 1, activeAgentLimit: 2 })
      expect(home.data.agents.find((a) => a.agentId === agent)).toMatchObject({
        governance: "governed", lifecycle: "active", enabled: true,
        activeRevision: { revision: 1 }, latestRevision: { revision: 2, parentRevision: 1 }, hasUnactivatedDraft: true,
        lastConfirmedRun: null, needsReviewCount: 0,
      })
      expect(home.data.agents.find((a) => a.agentId === other2)).toMatchObject({ governance: "legacy_unversioned" })

      const detail = await okRead(() => readAgentDetailDto({ service: db }, { shopId: x.shop.shopId, actorId: x.shop.ownerId, agentId: agent }))
      expect(detail).toMatchObject({ status: "ok", data: { governance: "governed", lifecycle: "active", canManage: true, revisions: [{ revision: 2 }, { revision: 1 }] } })

      const revision = await okRead(() => readRevisionDto({ service: db }, { shopId: x.shop.shopId, actorId: x.shop.ownerId, agentId: agent, revision: 1 }))
      expect(revision.status).toBe("ok")
      if (revision.status !== "ok") return
      expect(revision.data).toMatchObject({ isActive: true, lifecycle: "active", schemaVersion: 1, eligibility: { alreadyActive: true, eligible: false } })
      expect(revision.data.evaluations).toHaveLength(1)
      expect(revision.data.evaluations[0]).toMatchObject({ passRate: 1, safetyPassed: true, source: "trusted_evaluator", suiteVersion: "2026-11-07.test" })
      expect(revision.data.activation).toMatchObject({ policyRevision: x.policyRevision, knowledgeRevision: 1, fromRevision: null, readyOperations: ["crm.read"] })
      expect(revision.data.tools).toMatchObject([{ operation: "crm.read", available: true, effectiveMode: "read" }])
      // The DTO never carries memory bodies, provider names or secrets.
      const text = JSON.stringify(revision.data)
      expect(text).not.toMatch(/refundable|sk_|whsec|checkout\.stripe/i)
    })

    it("reads fail as forbidden or unavailable, never empty and never eligible", async () => {
      for (const actorId of [revoked.ownerId, stranger.ownerId, other.shop.ownerId, randomUUID()]) {
        expect(await readAgentsHomeDto({ service: db }, { shopId: w.shop.shopId, actorId })).toEqual({ status: "forbidden" })
        expect(await readBuilderResumeDto({ service: db }, { shopId: w.shop.shopId, actorId, agentId: randomUUID() })).toEqual({ status: "forbidden" })
        expect(await readRevisionDto({ service: db }, { shopId: w.shop.shopId, actorId, agentId: randomUUID(), revision: 1 })).toEqual({ status: "forbidden" })
        expect(await readActivationEligibility({ service: db }, { shopId: w.shop.shopId, actorId, agentId: randomUUID(), revision: 1 })).toEqual({ status: "forbidden" })
      }
      // Unknown agent / revision, and another shop's agent: unavailable, not empty.
      const foreign = await newAgent(other.shop)
      await saved(other, foreign)
      expect(await readAgentDetailDto({ service: db }, { shopId: w.shop.shopId, actorId: w.shop.ownerId, agentId: foreign })).toMatchObject({ status: "unavailable", reason: "agent_not_found" })
      const known = await newAgent(w.shop)
      await saved(w, known)
      expect(await readRevisionDto({ service: db }, { shopId: w.shop.shopId, actorId: w.shop.ownerId, agentId: known, revision: 9 })).toMatchObject({ status: "unavailable", reason: "revision_not_found" })
      // Managers and staff may read, but are told they cannot manage or edit.
      for (const [member, role] of [[manager, "manager"], [staff, "staff"]] as const) {
        const home = await okRead(() => readAgentsHomeDto({ service: db }, { shopId: w.shop.shopId, actorId: member.ownerId }))
        expect(home).toMatchObject({ status: "ok", data: { role, canManage: false } })
        const resume = await okRead(() => readBuilderResumeDto({ service: db }, { shopId: w.shop.shopId, actorId: member.ownerId, agentId: known }))
        expect(resume).toMatchObject({ status: "ok", data: { canEdit: false, editBlockedReason: "owner_required" } })
        if (resume.status === "ok") expect(resume.data.eligibility?.eligible).toBe(false)
        const act = await activate(w, known, { revision: 1, definitionHash: "a".repeat(64) }, null, member.ownerId)
        expect(act.ok).toBe(false)
      }
    })
  })
})
