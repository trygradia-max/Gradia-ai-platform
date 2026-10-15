import { createHmac } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import {
  INTEGRATION,
  anonClient,
  cleanup,
  seedShop,
  serviceClient,
  type Seeded,
} from "./_db"

/**
 * Meta Lead Ads intake against the disposable stack. The shop is the
 * page binding inserted here with the service role. The webhook body
 * cannot name the tenant. The fixture secret is not an app secret.
 */

const SECRET = "fixture-meta-app-secret"
const TOKEN = "fixture-meta-verify-token"
const ROUTE_URL = "https://gradia-int.test/api/intake/meta-lead-ads"
const PHONE = "+15555550111"
const EMAIL = "meta-intake@example.test"

vi.mock("@/lib/supabase/service", async () => {
  const db = await import("./_db")
  return { createServiceClient: () => db.serviceClient() }
})

function sign(raw: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`
}

function leadBody(input: {
  pageId: string
  leadgenId: string
  formId?: string
  createdTime?: number
  shopId?: string
  topShopId?: string
}) {
  const value: Record<string, unknown> = {
    ad_id: "ad100",
    adgroup_id: "ag100",
    leadgen_id: input.leadgenId,
    page_id: input.pageId,
    form_id: input.formId ?? "form100",
    created_time: input.createdTime ?? 1710000001,
    field_data: [
      { name: "full_name", values: ["Fictional Person"] },
      { name: "phone_number", values: [PHONE] },
      { name: "email", values: [EMAIL] },
    ],
  }
  if (input.shopId) value.shop_id = input.shopId
  const body: Record<string, unknown> = {
    object: "page",
    entry: [{
      id: input.pageId,
      time: 1710000000,
      changes: [{ field: "leadgen", value }],
    }],
  }
  if (input.topShopId) body.shop_id = input.topShopId
  return body
}

describe.skipIf(!INTEGRATION)("meta lead ads intake", () => {
  let GET: (request: Request) => Promise<Response>
  let POST: (request: Request) => Promise<Response>
  let db: SupabaseClient
  let shop: Seeded
  let other: Seeded
  let previousSecret: string | undefined
  let previousToken: string | undefined

  async function post(body: unknown, signature?: string | null) {
    const raw = JSON.stringify(body)
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (signature === undefined) headers["x-hub-signature-256"] = sign(raw)
    else if (signature !== null) headers["x-hub-signature-256"] = signature
    const res = await POST(new Request(ROUTE_URL, { method: "POST", headers, body: raw }))
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
    previousSecret = process.env.META_APP_SECRET
    previousToken = process.env.META_WEBHOOK_VERIFY_TOKEN
    process.env.META_APP_SECRET = SECRET
    process.env.META_WEBHOOK_VERIFY_TOKEN = TOKEN
    ;({ GET, POST } = await import("@/app/api/intake/meta-lead-ads/route"))
    db = serviceClient()
    shop = await seedShop(db)
    other = await seedShop(db)
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
  })

  afterAll(async () => {
    if (previousSecret === undefined) delete process.env.META_APP_SECRET
    else process.env.META_APP_SECRET = previousSecret
    if (previousToken === undefined) delete process.env.META_WEBHOOK_VERIFY_TOKEN
    else process.env.META_WEBHOOK_VERIFY_TOKEN = previousToken
    if (shop) await cleanup(db, shop)
    if (other) await cleanup(db, other)
  })

  it("echoes the hub challenge only when the fixture verify token matches", async () => {
    const ok = await GET(new Request(
      `${ROUTE_URL}?hub.mode=subscribe&hub.verify_token=${TOKEN}&hub.challenge=challenge-123`,
    ))
    expect(ok.status).toBe(200)
    expect(await ok.text()).toBe("challenge-123")

    const wrong = await GET(new Request(
      `${ROUTE_URL}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=challenge-123`,
    ))
    expect(wrong.status).toBe(403)
    expect(await wrong.text()).not.toContain("challenge-123")

    delete process.env.META_WEBHOOK_VERIFY_TOKEN
    const unset = await GET(new Request(
      `${ROUTE_URL}?hub.mode=subscribe&hub.verify_token=${TOKEN}&hub.challenge=challenge-123`,
    ))
    expect(unset.status).toBe(403)
    expect(await unset.text()).toBe("Forbidden")
    process.env.META_WEBHOOK_VERIFY_TOKEN = TOKEN
  })

  it("records one envelope and one transition, and the first payload wins", async () => {
    const pageId = `page${Date.now()}`
    const leadgenId = `lead${Date.now()}`
    const bound = await db.from("meta_lead_page_bindings").insert({
      shop_id: shop.shopId,
      page_id: pageId,
    })
    expect(bound.error).toBeNull()
    const clash = await db.from("meta_lead_page_bindings").insert({
      shop_id: other.shopId,
      page_id: pageId,
    })
    expect(clash.error).not.toBeNull()

    const customersBefore = await count("customers")
    const leadsBefore = await count("leads")
    const consentBefore = await count("customer_channel_permissions")
    const approvalsBefore = await count("pending_actions")
    const interactionsBefore = await count("interactions")

    const saved = await post(leadBody({
      pageId,
      leadgenId,
      formId: "form100",
      createdTime: 1710000001,
    }))
    expect(saved.status).toBe(200)
    expect(saved.json).toMatchObject({ ok: true, status: "recorded", count: 1 })

    const envelope = await db
      .from("lead_intake_envelopes")
      .select("shop_id, channel, provider, provider_event_id, thread_key, payload, received_at")
      .eq("id", saved.json.envelope_id!)
      .single()
    expect(envelope.error).toBeNull()
    expect(envelope.data!.payload).toEqual({
      page_id: pageId,
      form_id: "form100",
      leadgen_id: leadgenId,
      created_time: "1710000001",
    })
    expect(envelope.data).toMatchObject({
      shop_id: shop.shopId,
      channel: "meta",
      provider: "meta_lead_ads",
      provider_event_id: leadgenId,
      thread_key: null,
    })
    expect(String(envelope.data!.received_at)).not.toContain("1710000001")
    expect(
      (await db.from("lead_workflow_transitions").select("id").eq("envelope_id", saved.json.envelope_id!)).data,
    ).toHaveLength(1)
    const workflow = await db
      .from("lead_workflows")
      .select("state, handoff_pending, thread_key, channel, provider")
      .eq("id", saved.json.workflow_id!)
      .single()
    expect(workflow.data).toEqual({
      state: "identity_review",
      handoff_pending: true,
      thread_key: null,
      channel: "meta",
      provider: "meta_lead_ads",
    })

    const replay = await post(leadBody({
      pageId,
      leadgenId,
      formId: "form999",
      createdTime: 1710000099,
    }))
    expect(replay.status).toBe(200)
    expect(replay.json).toMatchObject({
      ok: true,
      status: "already_recorded",
      envelope_id: saved.json.envelope_id,
      workflow_id: saved.json.workflow_id,
    })
    const kept = await db
      .from("lead_intake_envelopes")
      .select("payload")
      .eq("id", saved.json.envelope_id!)
      .single()
    expect(kept.data).toEqual({
      payload: {
        page_id: pageId,
        form_id: "form100",
        leadgen_id: leadgenId,
        created_time: "1710000001",
      },
    })
    expect(
      (await db.from("lead_workflow_transitions").select("id").eq("envelope_id", saved.json.envelope_id!)).data,
    ).toHaveLength(1)
    expect(await count("customers")).toBe(customersBefore)
    expect(await count("leads")).toBe(leadsBefore)
    expect(await count("customer_channel_permissions")).toBe(consentBefore)
    expect(await count("pending_actions")).toBe(approvalsBefore)
    expect(await count("interactions")).toBe(interactionsBefore)
  })

  it("does not match a second lead on the same phone, email, or name", async () => {
    const pageId = `pageb${Date.now()}`
    const bound = await db.from("meta_lead_page_bindings").insert({
      shop_id: shop.shopId,
      page_id: pageId,
    })
    expect(bound.error).toBeNull()
    const stamp = `${Date.now()}`
    const first = await post(leadBody({ pageId, leadgenId: `leada${stamp}` }))
    const second = await post(leadBody({ pageId, leadgenId: `leadb${stamp}` }))
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

  it("writes nothing for a bad signature, an unknown page, a foreign shop id, or an unset secret", async () => {
    const pageId = `pagec${Date.now()}`
    const bound = await db.from("meta_lead_page_bindings").insert({
      shop_id: shop.shopId,
      page_id: pageId,
    })
    expect(bound.error).toBeNull()
    const before = await count("lead_intake_envelopes")
    const beforeOther = await count("lead_intake_envelopes", other.shopId)

    const raw = JSON.stringify(leadBody({ pageId, leadgenId: `leadc${Date.now()}` }))
    const tampered = await POST(new Request(ROUTE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sign(raw),
      },
      body: raw.replace("form100", "form999"),
    }))
    expect(tampered.status).toBe(401)

    const missing = await post(leadBody({ pageId, leadgenId: `leadd${Date.now()}` }), null)
    expect(missing.status).toBe(401)

    const malformed = await post(
      leadBody({ pageId, leadgenId: `leade${Date.now()}` }),
      "sha256=abcd",
    )
    expect(malformed.status).toBe(401)

    const unknown = await post(leadBody({
      pageId: `missing${Date.now()}`,
      leadgenId: `leadf${Date.now()}`,
    }))
    expect(unknown.status).toBe(404)
    expect(unknown.json.ok).toBe(false)

    const foreign = await post(leadBody({
      pageId,
      leadgenId: `leadg${Date.now()}`,
      shopId: other.shopId,
    }))
    expect(foreign.status).toBe(403)

    const topForeign = await post(leadBody({
      pageId,
      leadgenId: `leadh${Date.now()}`,
      topShopId: other.shopId,
    }))
    expect(topForeign.status).toBe(403)

    delete process.env.META_APP_SECRET
    const unsigned = await post(leadBody({ pageId, leadgenId: `leadi${Date.now()}` }))
    expect(unsigned.status).toBe(401)
    process.env.META_APP_SECRET = SECRET

    const anon = anonClient()
    const anonInsert = await anon.from("meta_lead_page_bindings").insert({
      shop_id: shop.shopId,
      page_id: `anon${Date.now()}`,
    })
    expect(anonInsert.error).not.toBeNull()

    expect(await count("lead_intake_envelopes")).toBe(before)
    expect(await count("lead_intake_envelopes", other.shopId)).toBe(beforeOther)
    expect(await count("customers")).toBe(1)
    expect(await count("leads")).toBe(0)
    expect(await count("customer_channel_permissions")).toBe(0)
    expect(await count("pending_actions")).toBe(0)
  })

  it("keeps a matching body shop id from becoming the tenant", async () => {
    const pageId = `paged${Date.now()}`
    const bound = await db.from("meta_lead_page_bindings").insert({
      shop_id: shop.shopId,
      page_id: pageId,
    })
    expect(bound.error).toBeNull()
    const saved = await post(leadBody({
      pageId,
      leadgenId: `leadj${Date.now()}`,
      shopId: shop.shopId.toUpperCase(),
    }))
    expect(saved.status).toBe(200)
    expect(saved.json.status).toBe("recorded")
    const envelope = await db
      .from("lead_intake_envelopes")
      .select("shop_id")
      .eq("id", saved.json.envelope_id!)
      .single()
    expect(envelope.data).toEqual({ shop_id: shop.shopId })
  })
})
