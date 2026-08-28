import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

import { executeApproval, executeRejection, markEditRequested } from "@/lib/approvals"
import { forShop } from "@/lib/supabase/for-shop"
import {
  INTEGRATION,
  cleanup,
  getPending,
  seedShop,
  serviceClient,
  stagePending,
  type Seeded,
} from "./_db"

/**
 * P0-011 — cross-tenant isolation on real Postgres. Two seeded shops; every
 * machine path that P0-011 hardened is exercised from the WRONG tenant and
 * must refuse with zero writes, then from the RIGHT tenant and must work.
 *
 * The service-role client is used deliberately: it bypasses RLS, so these
 * tests prove the CODE-level scoping (the `.eq("shop_id")` claim predicate,
 * forShop) — not the database policies (those are covered by the RLS suite
 * in ledger-idempotency.int.test.ts).
 */

const leadPayload = {
  customer_name: "Isolation Test",
  phone: "+15550100200",
  car_info: "silver 2020 civic",
  pin_notes: null,
  status: "new",
}

describe.skipIf(!INTEGRATION)("tenant isolation [integration]", () => {
  let sb: SupabaseClient
  let shopA: Seeded
  let shopB: Seeded

  beforeAll(async () => {
    sb = serviceClient()
    shopA = await seedShop(sb)
    shopB = await seedShop(sb)
  })

  afterAll(async () => {
    if (!sb) return
    await cleanup(sb, shopA)
    await cleanup(sb, shopB)
  })

  it("cross-tenant approve: B cannot claim A's action through A's id; A still can", async () => {
    const id = await stagePending(sb, shopA.shopId, shopA.ownerId, "create_lead", leadPayload)

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      // Wrong tenant: valid pendingId + B's authorized shop → zero-row claim.
      const crossTenant = await executeApproval(sb, id, shopB.shopId, {
        userId: shopB.ownerId,
      })
      expect(crossTenant).toEqual({ ok: true, status: "already_decided" })

      // The row is UNTOUCHED — still pending, still undecided.
      expect((await getPending(sb, id))?.status).toBe("pending")
      const { data: undecided } = await sb
        .from("pending_actions")
        .select("decided_by_user, decided_by_slack")
        .eq("id", id)
        .single()
      expect(undecided).toEqual({ decided_by_user: null, decided_by_slack: null })

      // Structured attack/bug signal fired (P0-012 pickup channel).
      const logged = errSpy.mock.calls.some((c) =>
        String(c[0]).includes("TENANT_SCOPE_VIOLATION")
      )
      expect(logged).toBe(true)
    } finally {
      errSpy.mockRestore()
    }

    // No lead landed anywhere.
    for (const shop of [shopA, shopB]) {
      const { count } = await sb
        .from("leads")
        .select("id", { count: "exact", head: true })
        .eq("shop_id", shop.shopId)
      expect(count).toBe(0)
    }

    // Right tenant: the claim + execution work exactly as before.
    const legit = await executeApproval(sb, id, shopA.shopId, {
      userId: shopA.ownerId,
    })
    expect(legit.ok).toBe(true)
    if (legit.ok && legit.status === "executed") {
      expect(legit.actionType).toBe("create_lead")
    } else {
      throw new Error("expected executed")
    }
    const { count: aLeads } = await sb
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("shop_id", shopA.shopId)
    expect(aLeads).toBe(1)
  })

  it("cross-tenant reject and edit-request are equally refused", async () => {
    const id = await stagePending(sb, shopA.shopId, shopA.ownerId, "create_lead", leadPayload)

    const reject = await executeRejection(sb, id, shopB.shopId, {
      userId: shopB.ownerId,
    })
    expect(reject).toEqual({ ok: true, status: "already_decided" })
    expect((await getPending(sb, id))?.status).toBe("pending")

    const edit = await markEditRequested(sb, id, shopB.shopId, {
      slackUserId: "U-intruder",
    })
    expect(edit).toEqual({ ok: true, status: "already_decided" })
    expect((await getPending(sb, id))?.status).toBe("pending")

    // The rightful shop can still decide it.
    const legit = await executeRejection(sb, id, shopA.shopId, {
      userId: shopA.ownerId,
    })
    expect(legit.ok).toBe(true)
    expect((await getPending(sb, id))?.status).toBe("rejected")
  })

  it("a forged shopId that owns nothing claims nothing", async () => {
    const id = await stagePending(sb, shopA.shopId, shopA.ownerId, "create_lead", leadPayload)
    const res = await executeApproval(
      sb,
      id,
      "3f9a2b1c-7d4e-4a08-9c21-5b6e8d0f1a23",
      { userId: shopB.ownerId }
    )
    expect(res).toEqual({ ok: true, status: "already_decided" })
    expect((await getPending(sb, id))?.status).toBe("pending")
  })

  it("match_shop_knowledge returns nothing for a mismatched p_shop_id", async () => {
    // Basis-vector embedding: identical query ⇒ cosine similarity 1.
    const embedding = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0))
    const { error: insertErr } = await sb.from("shop_knowledge").insert({
      shop_id: shopA.shopId,
      source_name: "isolation-fixture",
      content: "We only detail DeLoreans.",
      embedding,
    })
    expect(insertErr).toBeNull()

    const { data: foreign, error: foreignErr } = await sb.rpc("match_shop_knowledge", {
      p_shop_id: shopB.shopId,
      p_query_embedding: embedding,
      p_match_count: 4,
      p_min_similarity: 0.1,
    })
    expect(foreignErr).toBeNull()
    expect(foreign).toEqual([])

    const { data: own } = await sb.rpc("match_shop_knowledge", {
      p_shop_id: shopA.shopId,
      p_query_embedding: embedding,
      p_match_count: 4,
      p_min_similarity: 0.1,
    })
    expect((own as unknown[]).length).toBe(1)
  })

  it("forShop: a cross-tenant scoped update matches zero rows (ADR-003 proof)", async () => {
    const id = await stagePending(sb, shopA.shopId, shopA.ownerId, "create_lead", leadPayload)

    // B's scope + A's row id → no-op, even on the RLS-bypassing client.
    const { data: crossed } = await forShop(sb, shopB.shopId)
      .update("pending_actions", { status: "rejected" })
      .eq("id", id)
      .select("id")
    expect(crossed).toEqual([])
    expect((await getPending(sb, id))?.status).toBe("pending")

    // A's scope reaches its own row.
    const { data: owned } = await forShop(sb, shopA.shopId)
      .update("pending_actions", { status: "rejected" })
      .eq("id", id)
      .select("id")
    expect((owned as unknown[]).length).toBe(1)
  })

  it("forShop: insert stamps the authorized tenant over a forged shop_id", async () => {
    const { data, error } = await forShop(sb, shopA.shopId)
      .insert("services", {
        shop_id: shopB.shopId, // forged — must lose
        name: "Isolation Wash",
        price_cents: 5000,
        duration_minutes: 60,
      })
      .select("id, shop_id")
      .single()
    expect(error).toBeNull()
    expect((data as { shop_id: string }).shop_id).toBe(shopA.shopId)
  })

  it("L-1 query shape: a shop-scoped delete for a foreign row deletes nothing", async () => {
    const { data: svc } = await sb
      .from("services")
      .insert({
        shop_id: shopB.shopId,
        name: "B Protected Service",
        price_cents: 9900,
        duration_minutes: 90,
      })
      .select("id")
      .single()
    const svcId = (svc as { id: string }).id

    // The exact deleteService query shape after L-1, run from A's authority.
    await sb.from("services").delete().eq("id", svcId).eq("shop_id", shopA.shopId)

    const { data: still } = await sb
      .from("services")
      .select("id")
      .eq("id", svcId)
      .maybeSingle()
    expect(still).not.toBeNull()
  })
})
