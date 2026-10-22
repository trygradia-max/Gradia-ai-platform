import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"

import {
  projectOperationsDailyBrief,
  projectOperationsQueue,
  type OperationsAction,
  type OperationsIntake,
} from "@/lib/operations-queue"
import {
  operationsOverviewFromPage,
  readOperationsQueuePage,
} from "@/lib/operations-queue-reader"

const action = (patch: Partial<OperationsAction> = {}): OperationsAction => ({
  id: "action-1",
  shop_id: "shop-1",
  action_type: "send_sms",
  status: "pending",
  result_id: null,
  created_at: "2026-10-21T12:00:00Z",
  delivery: { state: "unspent" },
  deliveryConflict: false,
  linkedWorkflowId: null,
  ...patch,
})
const intake = (patch: Partial<OperationsIntake> = {}): OperationsIntake => ({
  id: "workflow-1",
  shop_id: "shop-1",
  revision: 1,
  last_received_at: "2026-10-21T12:01:00Z",
  ...patch,
})
const queue = (actions: OperationsAction[] = [], intakes: OperationsIntake[] = []) =>
  projectOperationsQueue("shop-1", { status: "ready", actions, intakes, hasMore: true })

describe("operations queue evidence boundary", () => {
  it("does not turn source failure into an empty success", () => {
    expect(projectOperationsQueue("shop-1", { status: "unavailable" }).status).toBe(
      "unavailable"
    )
  })

  it("rejects a mixed tenant source rather than leaking a partial result", () => {
    expect(queue([action(), action({ shop_id: "shop-2" })])).toEqual({
      status: "unavailable",
      items: [],
      reason: "scope_mismatch",
    })
    expect(queue([], [intake({ shop_id: "shop-2" })]).status).toBe("unavailable")
  })

  it("keeps loaded window counts distinct from totals", () => {
    expect(queue([action()])).toMatchObject({
      hasMore: true,
      countsInLoadedWindow: { needsReview: 1, outcomeUnconfirmed: 0 },
    })
  })

  it("does not treat approval as completion", () => {
    expect(queue([action({ status: "approved" })]).items[0].state).toBe(
      "outcome_unconfirmed"
    )
  })

  it.each(["pending", "rejected", "approved"] as const)(
    "preserves uncertain claimed sends in %s",
    (status) => {
      expect(
        queue([
          action({
            status,
            delivery: {
              state: "claimed",
              claimedAt: "2026-10-21T12:00:00Z",
              completedAt: null,
            },
          }),
        ]).items[0].state
      ).toBe("outcome_unconfirmed")
    }
  )

  it("does not expose normal review when message evidence cannot be read", () => {
    expect(queue([action({ delivery: { state: "unavailable" } })]).items[0].state).toBe(
      "outcome_unconfirmed"
    )
  })

  it("keeps terminal provider conflicts visible despite an execution result", () => {
    expect(
      queue([
        action({ status: "approved", result_id: "result", deliveryConflict: true }),
      ]).items
    ).toHaveLength(1)
  })

  it("omits completed execution and rejected unattempted work without claiming delivery", () => {
    expect(
      queue([
        action({ status: "approved", result_id: "result" }),
        action({ status: "rejected" }),
      ]).items
    ).toEqual([])
  })

  it("groups linked action and intake provenance as one work item", () => {
    const result = queue(
      [action({ id: "action-2", linkedWorkflowId: "workflow-1" })],
      [intake()]
    )
    expect(result.status).toBe("ready")
    if (result.status !== "ready") return
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({
      workKey: "lead_workflow:workflow-1",
      state: "needs_review",
      sources: [{ kind: "pending_action" }, { kind: "intake_workflow" }],
    })
  })

  it("does not copy customer payloads into the queue", () => {
    const result = queue([{ ...action(), payload: { body: "private" } } as OperationsAction])
    expect(JSON.stringify(result)).not.toContain("private")
  })
})

describe("operations daily brief contract", () => {
  const observedAt = "2026-10-22T18:00:00.000Z"

  it("keeps unavailable distinct from an empty brief", () => {
    expect(
      projectOperationsDailyBrief(
        { status: "unavailable", items: [], reason: "source_unavailable" },
        observedAt
      )
    ).toEqual({
      status: "unavailable",
      observedAt,
      reason: "source_unavailable",
      sections: [],
    })
  })

  it("reports observation time and partial loaded-window counts without invented totals", () => {
    const brief = projectOperationsDailyBrief(queue([action()], [intake()]), observedAt)
    expect(brief).toMatchObject({
      status: "ready",
      observedAt,
      coverage: "partial",
      countsInLoadedWindow: { needsReview: 2, outcomeUnconfirmed: 0 },
      sections: [
        { kind: "needs_review", countInLoadedWindow: 2 },
        { kind: "outcome_unconfirmed", countInLoadedWindow: 0 },
      ],
    })
    expect(JSON.stringify(brief)).not.toMatch(/revenue|saved|delivered/i)
  })
})

describe("operations queue authorized reader", () => {
  const shopId = randomUUID()
  const row = (patch: Record<string, unknown> = {}) => ({
    source_kind: "pending_action",
    source_id: randomUUID(),
    shop_id: shopId,
    observed_at: "2026-10-21T12:00:00.000Z",
    action_type: "send_sms",
    action_status: "pending",
    result_id: null,
    delivery_state: "unspent",
    claimed_at: null,
    completed_at: null,
    delivery_conflict: false,
    linked_workflow_id: null,
    intake_revision: null,
    ...patch,
  })
  const intakeRow = (patch: Record<string, unknown> = {}) => {
    const sourceId = randomUUID()
    return row({
      source_kind: "intake_workflow",
      source_id: sourceId,
      observed_at: "2026-10-21T12:01:00.000Z",
      action_type: null,
      action_status: null,
      delivery_state: null,
      delivery_conflict: null,
      linked_workflow_id: sourceId,
      intake_revision: 2,
      ...patch,
    })
  }
  const client = (data: unknown, error: unknown = null) => ({
    rpc: async () => ({ data, error }),
  }) as never

  it("turns refused, thrown, and malformed reads into unavailable", async () => {
    expect(await readOperationsQueuePage(client(null, { message: "denied" }), shopId)).toMatchObject(
      { status: "unavailable", nextCursor: null }
    )
    expect(
      await readOperationsQueuePage(
        client({ viewer_role: "owner", items: [{ payload: "private" }] }),
        shopId
      )
    ).toMatchObject({ status: "unavailable" })
    const thrown = { rpc: async () => { throw new Error("offline") } } as never
    expect(await readOperationsQueuePage(thrown, shopId)).toMatchObject({
      status: "unavailable",
    })
  })

  it("returns a minimal mixed-source page and stable cursor", async () => {
    const rows = [
      intakeRow(),
      row({ observed_at: "2026-10-21T12:00:30.000Z" }),
      row(),
    ]
    const result = await readOperationsQueuePage(
      client({ viewer_role: "owner", items: rows }),
      shopId,
      { limit: 2 }
    )
    expect(result).toMatchObject({
      status: "ready",
      viewerRole: "owner",
      hasMore: true,
      nextCursor: {
        observedAt: rows[1].observed_at,
        sourceKind: rows[1].source_kind,
        sourceId: rows[1].source_id,
      },
    })
    expect(result.items).toHaveLength(2)
    expect(JSON.stringify(result)).not.toContain("payload")
  })

  it("keeps unreadable evidence and conflicts unresolved", async () => {
    const unavailable = row({ delivery_state: "claimed", claimed_at: null })
    expect(
      await readOperationsQueuePage(
        client({ viewer_role: "owner", items: [unavailable] }),
        shopId
      )
    ).toMatchObject({ status: "unavailable" })
    const conflict = row({
      action_status: "approved",
      result_id: randomUUID(),
      delivery_state: "provider_accepted",
      claimed_at: "2026-10-21T12:00:00.000Z",
      completed_at: "2026-10-21T12:00:01.000Z",
      delivery_conflict: true,
    })
    const result = await readOperationsQueuePage(
      client({ viewer_role: "manager", items: [conflict] }),
      shopId
    )
    expect(result).toMatchObject({
      status: "ready",
      viewerRole: "manager",
      items: [
        {
          state: "outcome_unconfirmed",
          sources: [{ href: `/team/delivery-reviews?shop=${shopId}` }],
        },
      ],
    })
  })

  it("binds brief and queue to the same observed time", async () => {
    const page = await readOperationsQueuePage(
      client({ viewer_role: "owner", items: [] }),
      shopId
    )
    const overview = operationsOverviewFromPage(page)
    expect(overview.brief.observedAt).toBe(page.observedAt)
    expect(overview.brief).toMatchObject({ status: "ready", coverage: "complete" })
  })

  it("rejects invalid scope, cursor, and page sizes before calling the database", async () => {
    let calls = 0
    const db = { rpc: async () => { calls++; return { data: null, error: null } } } as never
    expect((await readOperationsQueuePage(db, "not-a-shop")).status).toBe("unavailable")
    expect((await readOperationsQueuePage(db, shopId, { limit: 51 })).status).toBe(
      "unavailable"
    )
    expect(
      (
        await readOperationsQueuePage(db, shopId, {
          cursor: {
            observedAt: "no",
            sourceKind: "pending_action",
            sourceId: randomUUID(),
          },
        })
      ).status
    ).toBe("unavailable")
    expect(calls).toBe(0)
  })
})
