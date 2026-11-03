import { randomUUID } from "node:crypto"

import type { SupabaseClient } from "@supabase/supabase-js"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  claimScheduledAgentRun,
  finishScheduledAgentRun,
  markScheduledAgentRunUnknown,
} from "@/lib/agent-runs"
import type { AgentConfig } from "@/lib/types/database"
import {
  INTEGRATION_WITH_SESSION,
  anonClient,
  cleanup,
  ownerSessionClient,
  seedShop,
  serviceClient,
  type Seeded,
} from "./_db"

const PASSWORD = "Synthetic-Agent-Runs-1029!"

const config = (name = "Scheduled follow-up"): AgentConfig => ({
  name,
  short_description: "Drafts a bounded follow-up for review.",
  trigger: { kind: "schedule", schedule_summary: "every hour" },
  audience: { entity: "leads", filters_summary: ["quoted leads"] },
  action: { kind: "draft_sms", intent_summary: "A warm follow-up." },
  prerequisites_needed: ["Twilio number connected"],
  human_in_the_loop_note: "Every message remains reviewable.",
  recipe: {
    id: "lead_followup_sms",
    params: {
      status: "quoted",
      min_lead_age_days: 7,
      no_inbound_within_days: 3,
    },
  },
  schedule: { cadence: "hourly" },
})

describe.skipIf(!INTEGRATION_WITH_SESSION)(
  "scheduled agent run lifecycle [integration]",
  () => {
    let db: SupabaseClient
    let db2: SupabaseClient
    let owner: SupabaseClient
    let shop: Seeded
    let agentId: string

    beforeAll(async () => {
      db = serviceClient()
      db2 = serviceClient()
      shop = await seedShop(db, { password: PASSWORD })
      owner = await ownerSessionClient(shop.email, PASSWORD)
      const { data, error } = await db
        .from("custom_agents")
        .insert({
          shop_id: shop.shopId,
          owner_id: shop.ownerId,
          name: "Lifecycle test agent",
          description: "Synthetic only",
          problem_text: "Follow up with quoted leads",
          config: config(),
          enabled: true,
        })
        .select("id")
        .single()
      expect(error).toBeNull()
      agentId = data!.id
    })

    afterAll(async () => {
      if (db && shop) {
        await db.from("custom_agents").delete().eq("id", agentId)
        await cleanup(db, shop)
      }
    })

    const claim = (
      client: SupabaseClient,
      triggerKey: string,
      workerId = randomUUID()
    ) =>
      claimScheduledAgentRun(client, {
        agentId,
        triggerKey,
        workerId,
        leaseSeconds: 120,
      })

    it("gives concurrent workers exactly one schedule-window claim", async () => {
      const key = `hourly:race:${randomUUID()}`
      const worker1 = randomUUID()
      const worker2 = randomUUID()
      const [first, second] = await Promise.all([
        claim(db, key, worker1),
        claim(db2, key, worker2),
      ])
      expect([first.outcome, second.outcome].sort()).toEqual([
        "active_duplicate",
        "claimed",
      ])
      const winner = first.outcome === "claimed" ? first : second
      const winningWorker = first.outcome === "claimed" ? worker1 : worker2
      expect(winner.outcome).toBe("claimed")
      if (winner.outcome !== "claimed") return
      expect(
        await finishScheduledAgentRun(db, {
          runId: winner.runId,
          workerId: winningWorker,
          attempt: 1,
          state: "skipped",
          fired: false,
          reason: "test complete",
        })
      ).toBe(true)
    })

    it("snapshots the claimed definition even if the mutable agent later changes", async () => {
      const workerId = randomUUID()
      const result = await claim(db, `hourly:snapshot:${randomUUID()}`, workerId)
      expect(result.outcome).toBe("claimed")
      if (result.outcome !== "claimed") return
      expect(result.definitionSnapshot.name).toBe("Scheduled follow-up")
      expect(
        (await db
          .from("custom_agents")
          .update({ config: config("Changed after claim") })
          .eq("id", agentId)).error
      ).toBeNull()
      const row = await db
        .from("custom_agent_runs")
        .select("definition_snapshot, definition_hash")
        .eq("id", result.runId)
        .single()
      expect(row.data!.definition_snapshot.name).toBe("Scheduled follow-up")
      expect(row.data!.definition_hash).toBe(result.definitionHash)
      expect(
        await finishScheduledAgentRun(db, {
          runId: result.runId,
          workerId,
          attempt: result.attempt,
          state: "skipped",
          fired: false,
          reason: "test complete",
        })
      ).toBe(true)
    })

    it("requires the current worker and attempt to finish", async () => {
      const workerId = randomUUID()
      const result = await claim(db, `hourly:cas:${randomUUID()}`, workerId)
      expect(result.outcome).toBe("claimed")
      if (result.outcome !== "claimed") return
      expect(
        await finishScheduledAgentRun(db, {
          runId: result.runId,
          workerId: randomUUID(),
          attempt: result.attempt,
          state: "succeeded",
          fired: true,
        })
      ).toBe(false)
      expect(
        await finishScheduledAgentRun(db, {
          runId: result.runId,
          workerId,
          attempt: result.attempt,
          state: "succeeded",
          fired: true,
        })
      ).toBe(true)
    })

    it("turns an expired lease unknown and never reclaims it", async () => {
      const workerId = randomUUID()
      const key = `hourly:expired:${randomUUID()}`
      const result = await claim(db, key, workerId)
      expect(result.outcome).toBe("claimed")
      if (result.outcome !== "claimed") return
      expect(
        (await db
          .from("custom_agent_runs")
          .update({ lease_expires_at: "2000-01-01T00:00:00.000Z" })
          .eq("id", result.runId)).error
      ).toBeNull()
      const afterExpiry = await claim(db2, key)
      expect(afterExpiry).toMatchObject({
        outcome: "unknown",
        runId: result.runId,
        attempt: 1,
      })
      const again = await claim(db, key)
      expect(again).toMatchObject({
        outcome: "terminal_duplicate",
        runId: result.runId,
        state: "unknown",
      })
      const row = await db
        .from("custom_agent_runs")
        .select("state, fired, wait_reason, error_code")
        .eq("id", result.runId)
        .single()
      expect(row.data).toMatchObject({
        state: "unknown",
        fired: false,
        wait_reason: "reconciliation_required",
        error_code: "lease_expired",
      })
    })

    it("marks only expired running claims unknown", async () => {
      const result = await claim(db, `hourly:mark:${randomUUID()}`)
      expect(result.outcome).toBe("claimed")
      if (result.outcome !== "claimed") return
      expect(await markScheduledAgentRunUnknown(db, result.runId)).toBe(false)
      expect(
        (await db
          .from("custom_agent_runs")
          .update({ lease_expires_at: "2000-01-01T00:00:00.000Z" })
          .eq("id", result.runId)).error
      ).toBeNull()
      expect(await markScheduledAgentRunUnknown(db, result.runId)).toBe(true)
      expect(await markScheduledAgentRunUnknown(db, result.runId)).toBe(false)
    })

    it("rejects public claims and owner-forged scheduled history", async () => {
      const args = {
        p_agent: agentId,
        p_trigger_key: `hourly:denied:${randomUUID()}`,
        p_worker: randomUUID(),
        p_lease_seconds: 120,
      }
      expect(
        (await anonClient().rpc("claim_scheduled_agent_run", args)).error
      ).not.toBeNull()
      expect(
        (await owner.rpc("claim_scheduled_agent_run", args)).error
      ).not.toBeNull()
      expect(
        (await owner.from("custom_agent_runs").insert({
          agent_id: agentId,
          shop_id: shop.shopId,
          trigger_source: "schedule",
          trigger_key: args.p_trigger_key,
          fired: false,
          state: "running",
          attempt: 1,
          worker_id: args.p_worker,
          lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
          started_at: new Date().toISOString(),
          definition_snapshot: config(),
          definition_hash: "a".repeat(64),
        })).error
      ).not.toBeNull()
    })
  }
)
