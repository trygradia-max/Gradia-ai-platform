import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

import { executeApproval, executeRejection } from "@/lib/approvals"
import {
  INTEGRATION,
  serviceClient,
  seedShop,
  stagePending,
  getPending,
  countLeads,
  cleanup,
  type Seeded,
} from "./_db"

/**
 * Approval engine against a real Postgres — the safety-critical path. Proves
 * the properties a mock can't: atomic single-execution, rollback on failure,
 * and that nothing partial lands when an executor bails.
 */
describe.skipIf(!INTEGRATION)("approval engine [integration]", () => {
  let sb: SupabaseClient
  let seed: Seeded

  const leadPayload = {
    customer_name: "Marcus",
    phone: "+15035550188",
    car_info: "2019 Tesla Model 3",
    pin_notes: null,
    status: "new",
  }

  beforeAll(async () => {
    sb = serviceClient()
    seed = await seedShop(sb)
  })
  afterAll(async () => {
    if (seed) await cleanup(sb, seed)
  })

  it("create_lead: approves, writes the lead, stamps result_id", async () => {
    const id = await stagePending(
      sb,
      seed.shopId,
      seed.ownerId,
      "create_lead",
      leadPayload
    )
    const res = await executeApproval(sb, id, { userId: seed.ownerId })

    expect(res.ok).toBe(true)
    expect(res).toMatchObject({ status: "executed", actionType: "create_lead" })

    const p = await getPending(sb, id)
    expect(p?.status).toBe("approved")
    expect(p?.result_id).toBeTruthy()
  })

  it("idempotent: a second approve is a no-op (already_decided), one lead only", async () => {
    const id = await stagePending(
      sb,
      seed.shopId,
      seed.ownerId,
      "create_lead",
      leadPayload
    )
    const before = await countLeads(sb, seed.shopId)

    const first = await executeApproval(sb, id, { userId: seed.ownerId })
    const second = await executeApproval(sb, id, { userId: seed.ownerId })

    expect(first.ok).toBe(true)
    expect(second).toEqual({ ok: true, status: "already_decided" })
    expect(await countLeads(sb, seed.shopId)).toBe(before + 1)
  })

  it("rollback: a failing executor returns the action to pending, no partial writes", async () => {
    // book_appointment with a valid start time but no Aurinko calendar token on
    // the shop fails in the executor *after* the claim — the claim must roll back.
    const before = await countLeads(sb, seed.shopId)
    const id = await stagePending(sb, seed.shopId, seed.ownerId, "book_appointment", {
      customer_name: "X",
      phone: "+15035550133",
      email: "x@example.test",
      car_info: null,
      service: "ceramic",
      iso_start_time: "2030-01-01T17:00:00.000Z",
      duration_minutes: 120,
      timezone: "America/Los_Angeles",
      pin_notes: null,
    })

    const res = await executeApproval(sb, id, { userId: seed.ownerId })

    expect(res.ok).toBe(false)
    const p = await getPending(sb, id)
    expect(p?.status).toBe("pending") // rolled back → re-approvable
    expect(await countLeads(sb, seed.shopId)).toBe(before) // nothing partial
  })

  it("reject: marks rejected and writes nothing", async () => {
    const id = await stagePending(
      sb,
      seed.shopId,
      seed.ownerId,
      "create_lead",
      leadPayload
    )
    const before = await countLeads(sb, seed.shopId)

    const res = await executeRejection(sb, id, { userId: seed.ownerId })

    expect(res.ok).toBe(true)
    const p = await getPending(sb, id)
    expect(p?.status).toBe("rejected")
    expect(await countLeads(sb, seed.shopId)).toBe(before)
  })
})
