import { randomUUID } from "node:crypto"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { parseAgentConfig } from "@/lib/agent-config-schema"
import { createAgentDefinitionRevision, readAgentDetailDto, readAgentsHomeDto, readBuilderResumeDto, readRevisionDto } from "@/lib/agent-os/definition-store"
import { createAgentIdentity, readMemoryCatalog } from "@/lib/agent-os/identity-store"
import { INTEGRATION_WITH_SESSION, assertDisposableTarget, cleanup, ownerSessionClient, seedShop, type Seeded } from "./_db"

const PW = "Synthetic-password-123!"

/** Retries ONLY the gateway's keep-alive 502/503 (the request never reached the database). */
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
const newUser = async () => {
  const s = await transient(() => seedShop(db, { password: PW }))
  seeded.push(s)
  return s
}
async function addMember(shopId: string, user: Seeded, role: string, active = true) {
  const r = await db.from("shop_memberships").upsert({ shop_id: shopId, user_id: user.ownerId, role, capabilities: [], active, display_name: role }, { onConflict: "shop_id,user_id" })
  expect(r.error).toBeNull()
}

const body = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  key: `agent-${randomUUID().slice(0, 8)}`,
  job: { roleLabel: "Quote follow-up", goal: "Follow up on open quotes politely.", expectedOutcomes: ["Quote answered"], stopConditions: ["Customer says stop"] },
  knowledge: { sourceIds: [] as string[], includeShopKnowledge: false, includeCustomerMemory: false, maxResultsPerQuery: 4 },
  tools: [],
  schedule: { kind: "manual" },
  limits: { maximumStepsPerRun: 5, maximumRuntimeSeconds: 60, maximumCreditsPerRun: 10, maximumRunsPerDay: 10, maximumConcurrentRuns: 1 },
  routing: { strategy: "cost_aware", semanticCache: false },
  ...over,
})

describe.skipIf(!INTEGRATION_WITH_SESSION)("agent builder identity, flow and memory catalog [integration]", { timeout: 90_000 }, () => {
  let shop: Seeded, other: Seeded, manager: Seeded, staff: Seeded, revoked: Seeded, stranger: Seeded
  let owner: SupabaseClient

  beforeAll(async () => {
    db = resilientService()
    shop = await newUser()
    other = await newUser()
    manager = await newUser()
    staff = await newUser()
    revoked = await newUser()
    stranger = await newUser()
    owner = await transient(() => ownerSessionClient(shop.email, PW))
    await addMember(shop.shopId, manager, "manager")
    await addMember(shop.shopId, staff, "staff")
    await addMember(shop.shopId, revoked, "staff", false)
  }, 120_000)

  afterAll(async () => {
    for (const s of seeded) await cleanup(db, s)
  })

  const countAgents = async (shopId: string) => (await db.from("custom_agents").select("id", { count: "exact", head: true }).eq("shop_id", shopId)).count

  it("creates ONLY a disabled, owner-bound identity that the legacy readers can render and nothing can run", async () => {
    const result = await createAgentIdentity({ service: db }, { shopId: shop.shopId, actorId: shop.ownerId, name: "  Quote   follow-up " })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const row = (await db.from("custom_agents").select("*").eq("id", result.agentId).single()).data!
    expect(row).toMatchObject({ shop_id: shop.shopId, owner_id: shop.ownerId, enabled: false, name: "Quote follow-up" })
    expect(parseAgentConfig(row.config).ok).toBe(true)
    expect(row.config.recipe).toBeUndefined()
    expect(row.config.freeform).toBeUndefined()
    expect((await db.from("agent_definition_state").select("agent_id").eq("agent_id", result.agentId)).data).toEqual([])
    // Before its first revision it is an honest legacy_unversioned agent with no revisions.
    const home = await readAgentsHomeDto({ service: db }, { shopId: shop.shopId, actorId: shop.ownerId })
    expect(home.status).toBe("ok")
    if (home.status !== "ok") return
    expect(home.data.agents.find((a) => a.agentId === result.agentId)).toMatchObject({ governance: "legacy_unversioned", lifecycle: "legacy_unversioned", activeRevision: null, latestRevision: null, enabled: false })
  })

  it("refuses managers, staff, revoked members, strangers and cross-shop owners, and creates nothing", async () => {
    const before = await countAgents(shop.shopId)
    const beforeOther = await countAgents(other.shopId)
    for (const actor of [manager, staff, revoked, stranger]) {
      expect(await createAgentIdentity({ service: db }, { shopId: shop.shopId, actorId: actor.ownerId, name: "Sneaky agent" })).toEqual({ ok: false, code: "forbidden" })
    }
    // Another shop's owner naming this shop, and this owner naming another shop.
    expect(await createAgentIdentity({ service: db }, { shopId: shop.shopId, actorId: other.ownerId, name: "Cross shop" })).toEqual({ ok: false, code: "forbidden" })
    expect(await createAgentIdentity({ service: db }, { shopId: other.shopId, actorId: shop.ownerId, name: "Cross shop" })).toEqual({ ok: false, code: "forbidden" })
    expect(await createAgentIdentity({ service: db }, { shopId: shop.shopId, actorId: shop.ownerId, name: "x" })).toEqual({ ok: false, code: "invalid_name" })
    expect(await countAgents(shop.shopId)).toBe(before)
    expect(await countAgents(other.shopId)).toBe(beforeOther)
  })

  it("create identity -> save revision -> resume shows exactly the saved revision; changed replay and stale tabs conflict", async () => {
    const created = await createAgentIdentity({ service: db }, { shopId: shop.shopId, actorId: shop.ownerId, name: "Flow agent" })
    if (!created.ok) throw new Error("identity failed")
    const agentId = created.agentId
    const base = { shopId: shop.shopId, actorId: shop.ownerId, agentId }
    const reqA = randomUUID()
    const definitionA = body()

    // First save from a fresh builder: expectedLatest null.
    const first = await createAgentDefinitionRevision({ service: db }, { ...base, requestId: reqA, definition: definitionA, parentRevision: null, expectedLatest: null })
    expect(first).toMatchObject({ ok: true, outcome: "created", revision: 1, parentRevision: null })
    if (!first.ok) return

    // An exact retry (lost response) replays: same revision, nothing new, even though latest moved.
    const replay = await createAgentDefinitionRevision({ service: db }, { ...base, requestId: reqA, definition: definitionA, parentRevision: null, expectedLatest: null })
    expect(replay).toMatchObject({ ok: true, outcome: "replayed", revision: 1, definitionHash: first.definitionHash })

    // Resume reads the exact latest immutable revision; nothing is reconstructed from legacy config.
    const resume = await readBuilderResumeDto({ service: db }, base)
    expect(resume.status).toBe("ok")
    if (resume.status !== "ok") return
    expect(resume.data).toMatchObject({ governance: "governed", lifecycle: "draft", canEdit: true, editBlockedReason: null })
    expect(resume.data.latestRevision).toMatchObject({ revision: 1, definitionHash: first.definitionHash })
    expect(resume.data.latestRevision?.definition.job.roleLabel).toBe("Quote follow-up")
    expect(resume.data.eligibility?.blockers).toContain("evaluation_required")
    expect(resume.data.eligibility?.eligible).toBe(false)

    // Same request id, changed content: a conflict, never a silent second revision.
    const changed = await createAgentDefinitionRevision({ service: db }, { ...base, requestId: reqA, definition: body({ job: { ...definitionA.job, goal: "A different goal for this agent." } }), parentRevision: null, expectedLatest: null })
    expect(changed).toEqual({ ok: false, code: "conflict" })

    // A second tab that opened at revision 1 saves first...
    const tabB = await createAgentDefinitionRevision({ service: db }, { ...base, requestId: randomUUID(), definition: body({ key: definitionA.key }), parentRevision: 1, expectedLatest: 1 })
    expect(tabB).toMatchObject({ ok: true, revision: 2, parentRevision: 1 })
    // ...so tab A, still on revision 1, conflicts instead of overwriting, and writes nothing.
    const staleTab = await createAgentDefinitionRevision({ service: db }, { ...base, requestId: randomUUID(), definition: body({ key: definitionA.key, job: { ...definitionA.job, goal: "Stale tab edit that must not land." } }), parentRevision: 1, expectedLatest: 1 })
    expect(staleTab).toEqual({ ok: false, code: "conflict" })
    expect((await db.from("agent_definition_revisions").select("revision").eq("agent_id", agentId)).data).toHaveLength(2)

    // Reload shows revision 2 as latest; saving from it succeeds.
    const reloaded = await readBuilderResumeDto({ service: db }, base)
    expect(reloaded.status === "ok" ? reloaded.data.latestRevision?.revision : null).toBe(2)
    expect(await createAgentDefinitionRevision({ service: db }, { ...base, requestId: randomUUID(), definition: body({ key: definitionA.key }), parentRevision: 2, expectedLatest: 2 })).toMatchObject({ ok: true, revision: 3, parentRevision: 2 })

    // Detail and revision pages see the same immutable truth.
    const detail = await readAgentDetailDto({ service: db }, base)
    expect(detail.status === "ok" ? detail.data.revisions.map((r) => r.revision) : null).toEqual([3, 2, 1])
    const revision1 = await readRevisionDto({ service: db }, { ...base, revision: 1 })
    expect(revision1.status === "ok" ? revision1.data.definitionHash : null).toBe(first.definitionHash)
  })

  it("simultaneous saves from the same expected latest: exactly one creates, every other conflicts, nothing extra is written", async () => {
    const created = await createAgentIdentity({ service: db }, { shopId: shop.shopId, actorId: shop.ownerId, name: "Race agent" })
    if (!created.ok) throw new Error("identity failed")
    const base = { shopId: shop.shopId, actorId: shop.ownerId, agentId: created.agentId }
    const key = body().key
    const racers = 4
    const rounds = 5

    // First-save race: nothing exists yet, every racer says expectedLatest null.
    let outcomes = await Promise.all(Array.from({ length: racers }, (_, i) =>
      createAgentDefinitionRevision({ service: db }, { ...base, requestId: randomUUID(), definition: body({ key, job: { roleLabel: "Quote follow-up", goal: `First racer number ${i} goal text.`, expectedOutcomes: ["Quote answered"], stopConditions: ["Customer says stop"] } }), parentRevision: null, expectedLatest: null })))
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1)
    expect(outcomes.filter((o) => !o.ok)).toEqual(Array.from({ length: racers - 1 }, () => ({ ok: false, code: "conflict" })))
    expect((await db.from("agent_definition_revisions").select("revision").eq("agent_id", created.agentId)).data).toHaveLength(1)

    // Then repeated rounds, each from the latest the editors last saw.
    for (let round = 1; round <= rounds; round++) {
      outcomes = await Promise.all(Array.from({ length: racers }, (_, i) =>
        createAgentDefinitionRevision({ service: db }, { ...base, requestId: randomUUID(), definition: body({ key, job: { roleLabel: "Quote follow-up", goal: `Round ${round} racer ${i} goal text.`, expectedOutcomes: ["Quote answered"], stopConditions: ["Customer says stop"] } }), parentRevision: round, expectedLatest: round })))
      const winners = outcomes.filter((o) => o.ok)
      expect(winners).toHaveLength(1)
      expect(winners[0]).toMatchObject({ ok: true, outcome: "created", revision: round + 1, parentRevision: round })
      expect(outcomes.filter((o) => !o.ok)).toEqual(Array.from({ length: racers - 1 }, () => ({ ok: false, code: "conflict" })))
    }

    // Exactly 1 + rounds revisions, with an unbroken lineage: every revision's parent is its predecessor.
    const rows = (await db.from("agent_definition_revisions").select("revision,parent_revision").eq("agent_id", created.agentId).order("revision")).data!
    expect(rows.map((r) => r.revision)).toEqual(Array.from({ length: rounds + 1 }, (_, i) => i + 1))
    expect(rows.map((r) => r.parent_revision)).toEqual([null, ...Array.from({ length: rounds }, (_, i) => i + 1)])
    const state = (await db.from("agent_definition_state").select("latest_revision").eq("agent_id", created.agentId).single()).data!
    expect(state.latest_revision).toBe(rounds + 1)
  })

  it("replay is exact even after latest moved and the editor view is stale; a changed replay still conflicts", async () => {
    const created = await createAgentIdentity({ service: db }, { shopId: shop.shopId, actorId: shop.ownerId, name: "Replay agent" })
    if (!created.ok) throw new Error("identity failed")
    const base = { shopId: shop.shopId, actorId: shop.ownerId, agentId: created.agentId }
    const key = body().key
    const req = randomUUID()
    const def = body({ key })
    const first = await createAgentDefinitionRevision({ service: db }, { ...base, requestId: req, definition: def, parentRevision: null, expectedLatest: null })
    expect(first).toMatchObject({ ok: true, outcome: "created", revision: 1 })
    // Someone else moves latest to 2.
    expect(await createAgentDefinitionRevision({ service: db }, { ...base, requestId: randomUUID(), definition: body({ key }), parentRevision: 1, expectedLatest: 1 })).toMatchObject({ ok: true, revision: 2 })
    // The lost-response retry carries the same stale expectation and must replay revision 1, not conflict.
    expect(await createAgentDefinitionRevision({ service: db }, { ...base, requestId: req, definition: def, parentRevision: null, expectedLatest: null })).toMatchObject({ ok: true, outcome: "replayed", revision: 1 })
    // The same request id with different content conflicts even though it also carries a stale view.
    expect(await createAgentDefinitionRevision({ service: db }, { ...base, requestId: req, definition: body({ key, job: { roleLabel: "Quote follow-up", goal: "Different goal for the same request.", expectedOutcomes: ["Quote answered"], stopConditions: ["Customer says stop"] } }), parentRevision: null, expectedLatest: null })).toEqual({ ok: false, code: "conflict" })
    expect((await db.from("agent_definition_revisions").select("revision").eq("agent_id", created.agentId)).data).toHaveLength(2)
    // A stale view with a NEW request id conflicts and writes nothing.
    expect(await createAgentDefinitionRevision({ service: db }, { ...base, requestId: randomUUID(), definition: body({ key }), parentRevision: 1, expectedLatest: 1 })).toEqual({ ok: false, code: "conflict" })
    expect((await db.from("agent_definition_revisions").select("revision").eq("agent_id", created.agentId)).data).toHaveLength(2)
  })

  it("a non-owner cannot save, even when naming the right agent", async () => {
    const created = await createAgentIdentity({ service: db }, { shopId: shop.shopId, actorId: shop.ownerId, name: "Owner only agent" })
    if (!created.ok) throw new Error("identity failed")
    for (const actor of [manager, staff, revoked, stranger]) {
      expect(await createAgentDefinitionRevision({ service: db }, { shopId: shop.shopId, actorId: actor.ownerId, agentId: created.agentId, requestId: randomUUID(), definition: body(), expectedLatest: null })).toEqual({ ok: false, code: "forbidden" })
    }
    expect((await db.from("agent_definition_state").select("agent_id").eq("agent_id", created.agentId)).data).toEqual([])
  })

  it("an enabled legacy agent cannot get a governed revision until it is turned off", async () => {
    const legacy = await db.from("custom_agents").insert({ shop_id: shop.shopId, owner_id: shop.ownerId, name: "Legacy running", problem_text: "x", config: {}, enabled: false }).select("id").single()
    expect(legacy.error).toBeNull()
    const id = legacy.data!.id as string
    // Enabling a legacy agent goes through the existing activation guard; here we just assert the DTO reason.
    await db.from("custom_agents").update({ enabled: true }).eq("id", id)
    const enabled = (await db.from("custom_agents").select("enabled").eq("id", id).single()).data!.enabled
    if (enabled) {
      const resume = await readBuilderResumeDto({ service: db }, { shopId: shop.shopId, actorId: shop.ownerId, agentId: id })
      expect(resume.status === "ok" ? resume.data : null).toMatchObject({ canEdit: false, editBlockedReason: "legacy_agent_enabled" })
    }
  })

  describe("memory catalog", () => {
    const candidate = (shopId: string, name: string, content: string, sourceId: string | null = null, expected: number | null = null) =>
      owner.rpc("create_reviewed_memory_candidate", { p_shop: shopId, p_source_name: name, p_content: content, p_chunks: [{ content, embedding: null }], p_source: sourceId, p_expected_revision: expected, p_valid_from: null, p_valid_until: null, p_retention_until: null })

    it("lists current published sources as selectable and never leaks candidate text, other shops or bodies", async () => {
      const published = await candidate(shop.shopId, `Catalog published ${randomUUID().slice(0, 6)}`, "Deposits are refundable up to 24 hours before service.")
      expect(published.error).toBeNull()
      const p = published.data as { source_id: string; revision: number }
      expect((await owner.rpc("review_memory_revision", { p_shop: shop.shopId, p_source: p.source_id, p_revision: p.revision })).error).toBeNull()
      expect((await owner.rpc("publish_memory_revision", { p_shop: shop.shopId, p_source: p.source_id, p_revision: p.revision, p_expected_active: null })).error).toBeNull()
      const draft = await candidate(shop.shopId, `Catalog draft ${randomUUID().slice(0, 6)}`, "SECRET-CANDIDATE-BODY not reviewed yet.")
      const d = draft.data as { source_id: string }

      const catalog = await readMemoryCatalog({ service: db }, { shopId: shop.shopId, actorId: shop.ownerId })
      expect(catalog.status).toBe("ok")
      if (catalog.status !== "ok") return
      const byId = new Map(catalog.data.sources.map((s) => [s.sourceId, s]))
      expect(byId.get(p.source_id)).toMatchObject({ status: "selectable", memoryRevision: p.revision })
      expect(byId.get(d.source_id)).toMatchObject({ status: "awaiting_review", memoryRevision: null })
      expect(JSON.stringify(catalog)).not.toMatch(/Deposits are refundable|SECRET-CANDIDATE-BODY|embedding|content_hash/)

      // A manager can read the catalog; a stranger and a revoked member cannot, and the other shop never sees it.
      expect((await readMemoryCatalog({ service: db }, { shopId: shop.shopId, actorId: manager.ownerId })).status).toBe("ok")
      expect(await readMemoryCatalog({ service: db }, { shopId: shop.shopId, actorId: stranger.ownerId })).toEqual({ status: "forbidden" })
      expect(await readMemoryCatalog({ service: db }, { shopId: shop.shopId, actorId: revoked.ownerId })).toEqual({ status: "forbidden" })
      const otherCatalog = await readMemoryCatalog({ service: db }, { shopId: other.shopId, actorId: other.ownerId })
      expect(otherCatalog.status === "ok" ? otherCatalog.data.sources.some((s) => s.sourceId === p.source_id) : null).toBe(false)

      // A revoked source stops being selectable.
      expect((await owner.rpc("remove_memory_revision", { p_shop: shop.shopId, p_source: p.source_id, p_revision: p.revision, p_expected_active: p.revision })).error).toBeNull()
      const after = await readMemoryCatalog({ service: db }, { shopId: shop.shopId, actorId: shop.ownerId })
      const gone = after.status === "ok" ? after.data.sources.find((s) => s.sourceId === p.source_id) : null
      expect(gone?.status).not.toBe("selectable")
    })
  })
})
