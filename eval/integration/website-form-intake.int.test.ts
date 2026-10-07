import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import {
  INTEGRATION,
  cleanup,
  seedShop,
  serviceClient,
  type Seeded,
} from "./_db"

/**
 * Website-form intake against the disposable stack. The route resolves the
 * shop from the mocked session binding. The body cannot name the tenant.
 */

const session = vi.hoisted(() => ({
  userId: null as string | null,
  shop: null as { id: string; name: string } | null,
}))

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({
        data: { user: session.userId ? { id: session.userId } : null },
      }),
    },
  }),
}))

vi.mock("@/lib/shop", () => ({
  getOptionalShop: async () => session.shop,
}))

vi.mock("@/lib/supabase/service", async () => {
  const db = await import("./_db")
  return { createServiceClient: () => db.serviceClient() }
})

const PHONE = "+15555550123"
const EMAIL = "form-intake@example.test"
const ROUTE_URL = "https://gradia-int.test/api/intake/website-form"

describe.skipIf(!INTEGRATION)("website form intake", () => {
  let POST: (request: Request) => Promise<Response>
  let db: SupabaseClient
  let shop: Seeded
  let other: Seeded
  let customerId: string

  function bind(target: Seeded | null) {
    if (!target) {
      session.userId = shop.ownerId
      session.shop = null
      return
    }
    session.userId = target.ownerId
    session.shop = { id: target.shopId, name: "Integration Test Shop" }
  }

  async function post(body: unknown, opts?: { user?: boolean }) {
    if (opts?.user === false) session.userId = null
    const res = await POST(new Request(ROUTE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }))
    const json = await res.json() as {
      ok: boolean
      status?: string
      envelope_id?: string
      workflow_id?: string
      error?: string
    }
    return { status: res.status, json }
  }

  async function count(table: string, shopId = shop.shopId): Promise<number> {
    const { count: rows, error } = await db
      .from(table)
      .select("*", { count: "exact", head: true })
      .eq("shop_id", shopId)
    expect(error).toBeNull()
    return rows ?? 0
  }

  beforeAll(async () => {
    ;({ POST } = await import("@/app/api/intake/website-form/route"))
    db = serviceClient()
    shop = await seedShop(db)
    other = await seedShop(db)
    bind(shop)
    const customer = await db
      .from("customers")
      .insert({
        shop_id: shop.shopId,
        name: "Fictional Existing",
        phone: PHONE,
        email: EMAIL,
      })
      .select("id")
      .single()
    expect(customer.error).toBeNull()
    customerId = customer.data!.id
  })

  afterAll(async () => {
    if (shop) await cleanup(db, shop)
    if (other) await cleanup(db, other)
  })

  it("records one envelope and one transition, and the first payload wins", async () => {
    bind(shop)
    const submissionId = `form-${Date.now()}`
    const original = {
      submission_id: submissionId,
      display_name: "Fictional Form",
      phone: ` ${PHONE} `,
      email: EMAIL,
      message: "Original form note",
      vehicle_text: "Blue sedan",
      service_text: "Interior",
    }
    const customersBefore = await count("customers")
    const leadsBefore = await count("leads")
    const consentBefore = await count("customer_channel_permissions")
    const approvalsBefore = await count("pending_actions")

    const saved = await post(original)
    expect(saved.status).toBe(200)
    expect(saved.json).toMatchObject({ ok: true, status: "recorded" })

    const envelope = await db
      .from("lead_intake_envelopes")
      .select("shop_id, channel, provider, provider_event_id, thread_key, payload")
      .eq("id", saved.json.envelope_id!)
      .single()
    expect(envelope.error).toBeNull()
    expect(envelope.data).toEqual({
      shop_id: shop.shopId,
      channel: "website_form",
      provider: "website_form",
      provider_event_id: submissionId,
      thread_key: null,
      payload: {
        display_name: "Fictional Form",
        phone: PHONE,
        email: EMAIL,
        message: "Original form note",
        vehicle_text: "Blue sedan",
        service_text: "Interior",
      },
    })
    expect(
      (await db.from("lead_workflow_transitions").select("id").eq("envelope_id", saved.json.envelope_id!)).data,
    ).toHaveLength(1)
    const workflow = await db
      .from("lead_workflows")
      .select("state, handoff_pending, thread_key")
      .eq("id", saved.json.workflow_id!)
      .single()
    expect(workflow.data).toEqual({
      state: "identity_review",
      handoff_pending: true,
      thread_key: null,
    })

    const replay = await post({
      ...original,
      message: "Retry must not replace the form",
      phone: "+15555550999",
      email: "other-form@example.test",
    })
    expect(replay.status).toBe(200)
    expect(replay.json).toMatchObject({
      ok: true,
      status: "already_recorded",
      envelope_id: saved.json.envelope_id,
      workflow_id: saved.json.workflow_id,
    })
    const kept = await db
      .from("lead_intake_envelopes")
      .select("payload, thread_key")
      .eq("id", saved.json.envelope_id!)
      .single()
    expect(kept.data).toEqual({
      payload: {
        display_name: "Fictional Form",
        phone: PHONE,
        email: EMAIL,
        message: "Original form note",
        vehicle_text: "Blue sedan",
        service_text: "Interior",
      },
      thread_key: null,
    })
    expect(
      (await db.from("lead_workflow_transitions").select("id").eq("envelope_id", saved.json.envelope_id!)).data,
    ).toHaveLength(1)
    expect(await count("customers")).toBe(customersBefore)
    expect(await count("leads")).toBe(leadsBefore)
    expect(await count("customer_channel_permissions")).toBe(consentBefore)
    expect(await count("pending_actions")).toBe(approvalsBefore)
    const customer = await db.from("customers").select("name, phone, email").eq("id", customerId).single()
    expect(customer.data).toEqual({
      name: "Fictional Existing",
      phone: PHONE,
      email: EMAIL,
    })
  })

  it("opens a separate workflow when the phone and email match and no thread key is sent", async () => {
    bind(shop)
    const stamp = `${Date.now()}`
    const first = await post({
      submission_id: `separate-a-${stamp}`,
      phone: PHONE,
      email: EMAIL,
      message: "First fictional form",
    })
    const second = await post({
      submission_id: `separate-b-${stamp}`,
      phone: PHONE,
      email: EMAIL,
      message: "Second fictional form",
    })
    expect(first.json.status).toBe("recorded")
    expect(second.json.status).toBe("recorded")
    expect(second.json.workflow_id).not.toBe(first.json.workflow_id)
    expect(second.json.envelope_id).not.toBe(first.json.envelope_id)
    const rows = await db
      .from("lead_intake_envelopes")
      .select("thread_key")
      .in("id", [first.json.envelope_id!, second.json.envelope_id!])
    expect(rows.data).toEqual([{ thread_key: null }, { thread_key: null }])
  })

  it("shares one workflow only when the caller sends the same thread key", async () => {
    bind(shop)
    const threadKey = `form-thread-${Date.now()}`
    const first = await post({
      submission_id: `thread-a-${threadKey}`,
      thread_key: threadKey,
      phone: PHONE,
      email: EMAIL,
      message: "Threaded fictional form",
    })
    const second = await post({
      submission_id: `thread-b-${threadKey}`,
      thread_key: ` ${threadKey} `,
      phone: PHONE,
      email: EMAIL,
      message: "Second threaded form",
    })
    expect(second.json).toMatchObject({
      status: "recorded",
      workflow_id: first.json.workflow_id,
    })
    expect(second.json.envelope_id).not.toBe(first.json.envelope_id)
    const workflow = await db
      .from("lead_workflows")
      .select("thread_key, revision")
      .eq("id", first.json.workflow_id!)
      .single()
    expect(workflow.data).toEqual({ thread_key: threadKey, revision: 2 })
    expect(
      (await db.from("lead_workflow_transitions").select("id").eq("workflow_id", first.json.workflow_id!)).data,
    ).toHaveLength(2)

    const loose = await post({
      submission_id: `thread-c-${threadKey}`,
      phone: PHONE,
      email: EMAIL,
      display_name: "Fictional Form",
      message: "Same contact, no thread",
    })
    expect(loose.json.workflow_id).not.toBe(first.json.workflow_id)
    const looseRow = await db
      .from("lead_intake_envelopes")
      .select("thread_key")
      .eq("id", loose.json.envelope_id!)
      .single()
    expect(looseRow.data).toEqual({ thread_key: null })
  })

  it("does not write for a foreign shop, a missing shop, or an unsigned body", async () => {
    bind(shop)
    const submissionId = `foreign-${Date.now()}`
    const owned = await post({
      submission_id: submissionId,
      message: "Owned by the session shop",
      phone: PHONE,
    })
    expect(owned.status).toBe(200)
    const beforeShop = await count("lead_intake_envelopes")
    const beforeOther = await count("lead_intake_envelopes", other.shopId)

    const foreign = await post({
      submission_id: `new-${submissionId}`,
      shop_id: other.shopId,
      message: "Must not land in the other shop",
      phone: PHONE,
    })
    expect(foreign.status).toBe(403)
    expect(foreign.json.ok).toBe(false)

    bind(other)
    const claimed = await post({
      submission_id: `owned-by-first-${Date.now()}`,
      shop_id: shop.shopId,
      message: "Session shop must not follow the body",
    })
    expect(claimed.status).toBe(403)

    const crossShop = await post({
      submission_id: submissionId,
      message: "Other shop must not claim this event",
      phone: "+15555550999",
    })
    expect(crossShop.status).toBe(403)
    const kept = await db
      .from("lead_intake_envelopes")
      .select("shop_id, payload")
      .eq("id", owned.json.envelope_id!)
      .single()
    expect(kept.data).toEqual({
      shop_id: shop.shopId,
      payload: { message: "Owned by the session shop", phone: PHONE },
    })

    const missingBinding = await post(
      { submission_id: `missing-${Date.now()}`, shop_id: shop.shopId, message: "No shop" },
      { user: false },
    )
    expect(missingBinding.status).toBe(401)

    bind(null)
    const noShop = await post({
      submission_id: `no-shop-${Date.now()}`,
      shop_id: shop.shopId,
      message: "Session has no shop",
    })
    expect(noShop.status).toBe(403)

    session.userId = shop.ownerId
    session.shop = { id: randomUUID(), name: "Missing shop" }
    const gone = await post({
      submission_id: `gone-${Date.now()}`,
      message: "Shop row is gone",
    })
    expect(gone.status).toBe(403)

    expect(await count("lead_intake_envelopes")).toBe(beforeShop)
    expect(await count("lead_intake_envelopes", other.shopId)).toBe(beforeOther)
    expect(await count("customers")).toBe(1)
    expect(await count("leads")).toBe(0)
    expect(await count("customer_channel_permissions")).toBe(0)
    expect(await count("pending_actions")).toBe(0)
  })

  it("refuses consent text and a missing submission id without writing", async () => {
    bind(shop)
    const before = await count("lead_intake_envelopes")
    const consent = await post({
      submission_id: `consent-${Date.now()}`,
      message: "Fictional form",
      marketing_consent: "yes",
    })
    expect(consent.status).toBe(400)
    const missingId = await post({
      phone: PHONE,
      email: EMAIL,
      message: "No submission id",
    })
    expect(missingId.status).toBe(400)
    const clientTime = await post({
      submission_id: `time-${Date.now()}`,
      message: "Client clock",
      received_at: "2026-10-01T17:00:00.000Z",
    })
    expect(clientTime.status).toBe(400)
    expect(await count("lead_intake_envelopes")).toBe(before)
    expect(await count("customer_channel_permissions")).toBe(0)
    expect(await count("leads")).toBe(0)
    expect(await count("pending_actions")).toBe(0)
  })
})
