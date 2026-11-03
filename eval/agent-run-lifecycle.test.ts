import { describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

import {
  claimScheduledAgentRun,
  finishScheduledAgentRun,
  recordAgentRun,
} from "@/lib/agent-runs"
import { scheduledAgentTriggerKey } from "@/lib/agent-runtime"
import type { AgentConfig } from "@/lib/types/database"

const schedule = (
  cadence: "hourly" | "daily" | "weekly",
  extra: Partial<NonNullable<AgentConfig["schedule"]>> = {}
): NonNullable<AgentConfig["schedule"]> => ({ cadence, ...extra })

function rpcClient(reply: { data: unknown; error: unknown }) {
  return {
    rpc: vi.fn(async () => reply),
  } as unknown as SupabaseClient
}

describe("scheduled agent run lifecycle", () => {
  it("builds one deterministic UTC key per eligible schedule window", () => {
    const now = new Date("2026-10-29T14:22:18.000Z")
    expect(scheduledAgentTriggerKey(schedule("hourly"), now)).toBe(
      "hourly:2026-10-29T14:00Z"
    )
    expect(
      scheduledAgentTriggerKey(
        schedule("daily", { hour_of_day: 14 }),
        now
      )
    ).toBe("daily:2026-10-29:h14")
    expect(
      scheduledAgentTriggerKey(
        schedule("weekly", { day_of_week: 4, hour_of_day: 14 }),
        now
      )
    ).toBe("weekly:2026-10-29:d4:h14")
  })

  it("returns a claimed definition snapshot and never infers missing evidence", async () => {
    const definition = { name: "Snapshot" } as AgentConfig
    const client = rpcClient({
      data: {
        outcome: "claimed",
        run_id: "run-1",
        attempt: 1,
        shop_id: "shop-1",
        definition_snapshot: definition,
        definition_hash: "a".repeat(64),
        policy_revision: null,
        knowledge_revision: null,
      },
      error: null,
    })
    await expect(
      claimScheduledAgentRun(client, {
        agentId: "agent-1",
        triggerKey: "hourly:2026-10-29T14:00Z",
        workerId: "worker-1",
      })
    ).resolves.toEqual({
      outcome: "claimed",
      runId: "run-1",
      attempt: 1,
      shopId: "shop-1",
      definitionSnapshot: definition,
      definitionHash: "a".repeat(64),
      policyRevision: null,
      knowledgeRevision: null,
    })
  })

  it("keeps duplicate and unknown claims non-executable", async () => {
    for (const outcome of [
      "active_duplicate",
      "terminal_duplicate",
      "unknown",
    ] as const) {
      const client = rpcClient({
        data: { outcome, run_id: "run-1", attempt: 1 },
        error: null,
      })
      await expect(
        claimScheduledAgentRun(client, {
          agentId: "agent-1",
          triggerKey: "daily:2026-10-29:h14",
          workerId: "worker-1",
        })
      ).resolves.toMatchObject({ outcome, runId: "run-1", attempt: 1 })
    }
  })

  it("fails closed on database errors or malformed claim responses", async () => {
    await expect(
      claimScheduledAgentRun(
        rpcClient({ data: null, error: { message: "private" } }),
        {
          agentId: "agent-1",
          triggerKey: "daily:2026-10-29:h14",
          workerId: "worker-1",
        }
      )
    ).rejects.toThrow("scheduled claim failed")
    await expect(
      claimScheduledAgentRun(rpcClient({ data: {}, error: null }), {
        agentId: "agent-1",
        triggerKey: "daily:2026-10-29:h14",
        workerId: "worker-1",
      })
    ).rejects.toThrow("invalid response")
  })

  it("finishes only through the lifecycle RPC with explicit terminal truth", async () => {
    const client = rpcClient({ data: true, error: null })
    await expect(
      finishScheduledAgentRun(client, {
        runId: "run-1",
        workerId: "worker-1",
        attempt: 1,
        state: "failed",
        fired: false,
        reason: "recipe crashed",
        errorCode: "runtime_error",
      })
    ).resolves.toBe(true)
    expect(client.rpc).toHaveBeenCalledWith("finish_scheduled_agent_run", {
      p_run: "run-1",
      p_worker: "worker-1",
      p_attempt: 1,
      p_state: "failed",
      p_fired: false,
      p_reason: "recipe crashed",
      p_stats: null,
      p_pending_action_ids: [],
      p_error_code: "runtime_error",
    })
  })

  it("writes manual/event history as terminal rows, never running claims", async () => {
    const insert = vi.fn(async () => ({ error: null }))
    const client = {
      from: vi.fn(() => ({ insert })),
    } as unknown as SupabaseClient
    await recordAgentRun(client, {
      agentId: "agent-1",
      shopId: "shop-1",
      triggerSource: "manual",
      outcome: {
        agentId: "agent-1",
        agentName: "Agent",
        fired: true,
        pendingActionIds: [],
      },
    })
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger_source: "manual",
        state: "succeeded",
        attempt: 1,
      })
    )
  })
})
