import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), page: vi.fn() }))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/shop", () => ({ requireUser: vi.fn(async () => ({ id: "synthetic-user" })), requireShop: vi.fn() }))
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ rpc: mocks.rpc })) }))
vi.mock("@/lib/operations-queue-reader", async (original) => ({
  ...(await original<typeof import("@/lib/operations-queue-reader")>()),
  readOperationsQueuePage: mocks.page,
}))
import { loadOperationsOverviewForWorkspace } from "@/lib/data/operations-queue"
import { OPERATIONS_QUEUE_GRANTS, canReadOperationsQueue, type TeamCapability } from "@/lib/team-permissions"
import { unavailableOperationsQueuePage } from "@/lib/operations-queue-reader"

const A = "4c94ecbf-d4c7-4f9a-8a48-458b7ef8e9aa"
const B = "72e55dc2-fdcd-4e14-b02d-dc7790fad605"
const L = "9a5b1c6e-2d8f-4b0a-9c3e-1f2a3b4c5d6e"
const workspace = (id: string, role: "owner" | "manager" | "staff", capabilities: TeamCapability[] = []) => ({ id, name: "Synthetic shop", role, capabilities, location_id: L })

beforeEach(() => {
  mocks.rpc.mockReset()
  mocks.page.mockReset().mockResolvedValue({ status: "ready", observedAt: "2026-11-18T00:00:00Z", items: [], coverage: [], nextCursor: null, reason: null })
})

describe("who can have an operations queue", () => {
  it("owners always, managers only with a queue grant, staff never", () => {
    expect(canReadOperationsQueue(workspace(A, "owner"))).toBe(true)
    expect(canReadOperationsQueue(workspace(A, "staff", ["crm.read", "approvals.messages", "delivery.reconcile"]))).toBe(false)
    expect(canReadOperationsQueue(workspace(A, "manager", []))).toBe(false)
    expect(canReadOperationsQueue(workspace(A, "manager", ["notes.write", "jobs.progress", "baseline.draft"]))).toBe(false)
    for (const grant of OPERATIONS_QUEUE_GRANTS) expect(canReadOperationsQueue(workspace(A, "manager", [grant]))).toBe(true)
  })
})

describe("Team home operations brief", () => {
  it("is not shown (null) to a staff member or a manager without a queue grant, and never reads the queue for them", async () => {
    for (const ws of [workspace(A, "staff"), workspace(A, "manager", []), workspace(A, "manager", ["notes.write"])]) {
      mocks.rpc.mockResolvedValue({ data: [ws], error: null })
      expect(await loadOperationsOverviewForWorkspace(A, { limit: 8 })).toBeNull()
    }
    expect(mocks.page).not.toHaveBeenCalled()
  })

  it("still reads the queue through the database for an owner and a granted manager", async () => {
    for (const ws of [workspace(A, "owner"), workspace(A, "manager", ["approvals.messages"])]) {
      mocks.rpc.mockResolvedValue({ data: [ws], error: null })
      const overview = await loadOperationsOverviewForWorkspace(A, { limit: 8 })
      expect(overview?.queue.status).toBe("ready")
    }
    expect(mocks.page).toHaveBeenCalledTimes(2)
  })

  it("stays unavailable, never clear and never hidden, when the membership read fails or is malformed", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "boom" } })
    expect((await loadOperationsOverviewForWorkspace(A))?.queue.status).toBe("unavailable")
    mocks.rpc.mockResolvedValue({ data: [{ id: "not-a-uuid" }], error: null })
    expect((await loadOperationsOverviewForWorkspace(A))?.queue.status).toBe("unavailable")
    expect(mocks.page).not.toHaveBeenCalled()
  })

  it("stays unavailable for a workspace the caller has no membership in (a URL selector is not authorization)", async () => {
    mocks.rpc.mockResolvedValue({ data: [workspace(B, "owner")], error: null })
    const overview = await loadOperationsOverviewForWorkspace(A)
    expect(overview?.queue.status).toBe("unavailable")
    expect(overview?.queue).toEqual(expect.objectContaining({ status: unavailableOperationsQueuePage().status }))
    expect(mocks.page).not.toHaveBeenCalled()
  })

  it("does not let a staff role in one workspace hide the queue of another where the caller manages", async () => {
    mocks.rpc.mockResolvedValue({ data: [workspace(A, "staff"), workspace(B, "manager", ["crm.read"])], error: null })
    expect((await loadOperationsOverviewForWorkspace(B))?.queue.status).toBe("ready")
    expect(await loadOperationsOverviewForWorkspace(A)).toBeNull()
  })
})
