import { randomUUID } from "node:crypto"
import { beforeAll, afterAll, describe, expect, it } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { INTEGRATION_WITH_SESSION, serviceClient, ownerSessionClient, anonClient, seedShop, cleanup, type Seeded } from "./_db"

describe.skipIf(!INTEGRATION_WITH_SESSION)("public form intake authority and replay", () => {
  let db: SupabaseClient, owner: SupabaseClient, otherOwner: SupabaseClient, shop: Seeded, other: Seeded
  const origin = "https://fictional-shop.example.test", password = "Synthetic-Form-1008!"
  const configure = (form: string, patch: Record<string, unknown> = {}) => ({ p_shop: shop.shopId, p_form: form, p_origin: origin, p_enabled: true, p_revision: 0, ...patch })
  const args = (form: string, patch: Record<string, unknown> = {}) => ({ p_form: form, p_origin: origin, p_submission: randomUUID(), p_payload: { email: "visitor@example.test", message: "Fictional inquiry" }, ...patch })
  async function form() { const id = randomUUID(); expect((await owner.rpc("configure_public_intake_form", configure(id))).error).toBeNull(); return id }
  beforeAll(async () => {
    db = serviceClient(); shop = await seedShop(db, { password }); other = await seedShop(db, { password })
    owner = await ownerSessionClient(shop.email, password); otherOwner = await ownerSessionClient(other.email, password)
  })
  afterAll(async () => { if (shop) await cleanup(db, shop); if (other) await cleanup(db, other) })
  it("only a live owner session can configure/list; direct tables remain inaccessible", async () => {
    for (const client of [db, anonClient(), otherOwner]) {
      expect((await client.rpc("configure_public_intake_form", configure(randomUUID()))).error).not.toBeNull()
      expect((await client.rpc("list_public_intake_forms", { p_shop: shop.shopId })).error).not.toBeNull()
    }
    const id = await form()
    expect((await owner.rpc("list_public_intake_forms", { p_shop: shop.shopId })).data).toEqual(expect.arrayContaining([expect.objectContaining({ id, revision: 1 })]))
    for (const client of [db, anonClient(), owner]) {
      expect((await client.from("public_intake_forms").select("id")).error).not.toBeNull()
      expect((await client.from("public_intake_forms").update({ enabled: false }).eq("id", id)).error).not.toBeNull()
      expect((await client.from("public_intake_forms").delete().eq("id", id)).error).not.toBeNull()
    }
    for (const client of [anonClient(), owner, otherOwner]) expect((await client.rpc("submit_public_intake_form", args(id))).error).not.toBeNull()
  })
  it("serializes concurrent retries into one review-only workflow and hides internal ids", async () => {
    const id = await form(), input = args(id)
    const results = await Promise.all(Array.from({ length: 8 }, () => db.rpc("submit_public_intake_form", input)))
    for (const result of results) { expect(result.error).toBeNull(); expect(result.data).toEqual({ accepted: true }) }
    const saved = await db.from("lead_intake_envelopes").select("workflow_id,payload,shop_id,thread_key").eq("provider", "public_website_form").eq("provider_event_id", `${id}:${input.p_submission}`)
    expect(saved.error).toBeNull(); expect(saved.data).toHaveLength(1); expect(saved.data![0]).toMatchObject({ shop_id: shop.shopId, thread_key: null })
    const workflow = await db.from("lead_workflows").select("state,customer_id,vehicle_id,handoff_pending").eq("id", saved.data![0].workflow_id).single()
    expect(workflow.data).toEqual({ state: "identity_review", customer_id: null, vehicle_id: null, handoff_pending: true })
    for (const table of ["customers", "customer_channel_permissions", "interactions", "pending_actions", "appointments", "leads"]) expect((await db.from(table).select("id").eq("shop_id", shop.shopId)).data).toEqual([])
    expect((await db.rpc("submit_public_intake_form", { ...input, p_payload: { email: "changed@example.test" } })).error?.code).toBe("PT409")
  })
  it("isolates identical submission ids across forms and shops without contact-based threading", async () => {
    const a = await form(), b = randomUUID(), submission = randomUUID()
    expect((await otherOwner.rpc("configure_public_intake_form", configure(b, { p_shop: other.shopId }))).error).toBeNull()
    for (const id of [a, b]) expect((await db.rpc("submit_public_intake_form", args(id, { p_submission: submission }))).error).toBeNull()
    const saved = await db.from("lead_intake_envelopes").select("shop_id,workflow_id").in("provider_event_id", [`${a}:${submission}`, `${b}:${submission}`])
    expect(new Set(saved.data!.map(r => r.shop_id)).size).toBe(2); expect(new Set(saved.data!.map(r => r.workflow_id)).size).toBe(2)
    expect((await otherOwner.rpc("configure_public_intake_form", configure(a, { p_shop: other.shopId, p_revision: 1 }))).error?.code).toBe("42501")
  })
  it("rejects null/wrong origin, forged fields and disabled bindings even on a retry", async () => {
    const id = await form(), input = args(id)
    for (const patch of [{ p_origin: null }, { p_origin: "https://foreign.example.test" }]) expect((await db.rpc("submit_public_intake_form", { ...input, ...patch })).error?.code).toBe("42501")
    for (const extra of [{ shop_id: other.shopId }, { thread_key: "merge" }, { consent: "yes" }]) expect((await db.rpc("submit_public_intake_form", { ...input, p_payload: { ...input.p_payload, ...extra } })).error?.code).toBe("22023")
    expect((await db.rpc("submit_public_intake_form", input)).error).toBeNull()
    expect((await owner.rpc("configure_public_intake_form", configure(id, { p_enabled: false, p_revision: 1 }))).error).toBeNull()
    expect((await db.rpc("public_intake_form_origin", { p_form: id, p_origin: origin })).data).toBe(false)
    expect((await db.rpc("submit_public_intake_form", input)).error?.code).toBe("42501")
    expect((await owner.rpc("configure_public_intake_form", configure(id, { p_revision: 1 }))).error?.code).toBe("PT409")
  })
  it("enforces shop-wide rate limits under concurrency, including multiple forms", async () => {
    // Dedicated third shop keeps quota assertions independent of earlier cases.
    const limited = await seedShop(db, { password })
    try {
      const session = await ownerSessionClient(limited.email, password), ids = [randomUUID(), randomUUID()]
      for (const id of ids) expect((await session.rpc("configure_public_intake_form", configure(id, { p_shop: limited.shopId }))).error).toBeNull()
      const inputs = Array.from({ length: 36 }, (_, i) => args(ids[i % 2]))
      const results = await Promise.all(inputs.map(a => db.rpc("submit_public_intake_form", a)))
      expect(results.filter(r => !r.error)).toHaveLength(30); expect(results.filter(r => r.error?.code === "PT429")).toHaveLength(6)
      const accepted = inputs[results.findIndex(r => !r.error)]
      expect((await db.rpc("submit_public_intake_form", accepted)).data).toEqual({ accepted: true })
      expect((await db.from("lead_intake_envelopes").select("id", { count: "exact", head: true }).eq("shop_id", limited.shopId)).count).toBe(30)
    } finally { await cleanup(db, limited) }
  })
  it("manager membership cannot grant form configuration authority, before or after revocation", async () => {
    const id = await form()
    const invitation = await owner.rpc("team_invite", { p_shop: shop.shopId, p_email: other.email, p_name: "Fictional manager", p_role: "manager", p_capabilities: ["crm.read"] })
    expect(invitation.error).toBeNull()
    expect((await otherOwner.rpc("team_accept_invite", { p_token: invitation.data.token })).error).toBeNull()
    expect((await otherOwner.rpc("configure_public_intake_form", configure(id, { p_revision: 1 }))).error?.code).toBe("42501")
    expect((await db.from("shop_memberships").update({ active: false }).eq("shop_id", shop.shopId).eq("user_id", other.ownerId)).error).toBeNull()
    expect((await otherOwner.rpc("list_public_intake_forms", { p_shop: shop.shopId })).error?.code).toBe("42501")
    // The existing membership invariant itself forbids deactivating an owner.
    expect((await db.from("shop_memberships").update({ active: false }).eq("shop_id", shop.shopId).eq("user_id", shop.ownerId)).error?.code).toBe("23514")
  })
  it("blocks the rolling daily limit even when the minute window is empty", async () => {
    const limited = await seedShop(db, { password }), id = randomUUID()
    try {
      const session = await ownerSessionClient(limited.email, password)
      expect((await session.rpc("configure_public_intake_form", configure(id, { p_shop: limited.shopId }))).error).toBeNull()
      const received = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
      for (let batch = 0; batch < 20; batch++) {
        const results = await Promise.all(Array.from({ length: 25 }, () => db.rpc("record_lead_intake", {
          p_shop: limited.shopId, p_channel: "website_form", p_provider: "public_website_form", p_event_id: `${id}:${randomUUID()}`,
          p_received_at: received, p_evidence_ref: null, p_thread_key: null, p_payload: { email: "fixture@example.test" },
        })))
        for (const result of results) expect(result.error).toBeNull()
      }
      expect((await db.rpc("submit_public_intake_form", args(id))).error?.code).toBe("PT429")
      expect((await db.from("lead_intake_envelopes").select("id", { count: "exact", head: true }).eq("shop_id", limited.shopId)).count).toBe(500)
    } finally { await cleanup(db, limited) }
  }, 20000)
})
