import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { INTEGRATION_WITH_SESSION, serviceClient, ownerSessionClient, anonClient, seedShop, cleanup, type Seeded } from "./_db"
import { recordLeadIntake } from "@/lib/lead-intake"
import { qualificationHistorySchema, qualificationListSchema, qualificationSchema, unknownQualificationFields, type QualificationFields } from "@/lib/lead-qualification"

type Lead = Awaited<ReturnType<typeof linkedLead>>
let db: SupabaseClient, owner: SupabaseClient, ownerReload: SupabaseClient, manager: SupabaseClient, foreignOwner: SupabaseClient
let shop: Seeded, other: Seeded, foreign: Seeded

async function customer(shopId = shop.shopId, name = "Fictional Lead") {
  const r = await db.from("customers").insert({ shop_id: shopId, name }).select("id,name,phone,email,updated_at").single()
  expect(r.error).toBeNull()
  return r.data!
}
async function vehicle(customerId: string, shopId = shop.shopId) {
  const r = await db.from("vehicles").insert({ shop_id: shopId, customer_id: customerId, year: 2021, make: "Fictional", model: "Coupe", plate: "SYNTH" }).select("id").single()
  expect(r.error).toBeNull()
  return r.data!.id as string
}
const intake = (threadKey: string, receivedAt = "2026-10-09T00:00:00Z") =>
  recordLeadIntake(db, { shopId: shop.shopId, channel: "synthetic", provider: "synthetic", providerEventId: randomUUID(), threadKey, receivedAt, payload: { service_text: "Fictional ceramic coating request" } })

/** A workflow whose customer, and optionally vehicle, an owner has reviewed and linked. */
async function linkedLead(withVehicle = true) {
  const c = await customer(), thread: string = randomUUID(), w = await intake(thread)
  expect((await owner.rpc("link_intake_customer", { p_shop: shop.shopId, p_workflow: w.workflowId, p_revision: 1, p_customer: c.id, p_snapshot: c, p_command: randomUUID() })).error).toBeNull()
  let vehicleId: string | null = null
  if (withVehicle) {
    vehicleId = await vehicle(c.id)
    const choices = await owner.rpc("intake_vehicle_choices", { p_shop: shop.shopId, p_workflow: w.workflowId, p_revision: 2 })
    expect(choices.error).toBeNull()
    expect((await owner.rpc("link_intake_vehicle", { p_shop: shop.shopId, p_workflow: w.workflowId, p_revision: 2, p_customer: c.id, p_customer_updated_at: choices.data.customer_updated_at, p_vehicle: vehicleId, p_snapshot: choices.data.vehicles[0], p_command: randomUUID() })).error).toBeNull()
  }
  return { workflowId: w.workflowId, customerId: c.id as string, customer: c, vehicleId, thread }
}
const known = (source: "customer" | "staff" = "customer") => ({ status: "reported" as const, source, evidence_revision: null })
function filled(): QualificationFields {
  return {
    service: { ...known(), service_id: shop.serviceId, text: "Full detail with ceramic coating" },
    vehicle_condition: { ...known(), text: "Light swirl marks, no known repaint" },
    timing: { ...known(), earliest: "2026-10-20", latest: "2026-10-31", text: "Weekday mornings" },
    location: { ...known("staff"), type: "shop", area: null },
    constraints: { ...known(), items: [] },
  }
}
const command = (lead: Lead, patch: Record<string, unknown> = {}) => ({
  p_shop: shop.shopId, p_workflow: lead.workflowId, p_command: randomUUID(), p_revision: 0, p_customer: lead.customerId, p_vehicle: lead.vehicleId,
  p_review_state: "in_progress", p_fields: unknownQualificationFields() as unknown, p_open_questions: [] as unknown, ...patch,
})
const update = (c: ReturnType<typeof command>, client = owner) => client.rpc("update_lead_qualification", c)
const read = (workflowId: string, client = owner, shopId = shop.shopId) => client.rpc("read_lead_qualification", { p_shop: shopId, p_workflow: workflowId })
const list = (client = owner, shopId = shop.shopId, offset = 0) => client.rpc("list_lead_qualifications", { p_shop: shopId, p_offset: offset })
const history = (workflowId: string, client = owner, offset = 0) => client.rpc("read_lead_qualification_history", { p_shop: shop.shopId, p_workflow: workflowId, p_offset: offset })
const grant = (capabilities: string[], role = "manager", active = true) =>
  db.from("shop_memberships").update({ active, role, capabilities }).eq("shop_id", shop.shopId).eq("user_id", other.ownerId)
/** Everything qualification must never create or change. */
async function sideEffects() {
  const tables = ["customers", "vehicles", "leads", "quotes", "appointments", "pending_actions", "interactions", "customer_channel_permissions", "lead_workflows", "lead_workflow_transitions", "lead_intake_envelopes", "usage_events", "service_proof_consumptions"]
  const rows = await Promise.all(tables.map((t) => db.from(t).select("*").eq("shop_id", shop.shopId)))
  rows.forEach((r, i) => expect(r.error, tables[i]).toBeNull())
  return JSON.stringify(rows.map((r) => (r.data ?? []).map((row) => JSON.stringify(row)).sort()))
}

describe.skipIf(!INTEGRATION_WITH_SESSION)("durable lead qualification", () => {
  beforeAll(async () => {
    db = serviceClient()
    const password = randomUUID()
    shop = await seedShop(db, { password }); other = await seedShop(db, { password }); foreign = await seedShop(db, { password })
    owner = await ownerSessionClient(shop.email, password); ownerReload = await ownerSessionClient(shop.email, password)
    manager = await ownerSessionClient(other.email, password); foreignOwner = await ownerSessionClient(foreign.email, password)
    const invite = await owner.rpc("team_invite", { p_shop: shop.shopId, p_email: other.email, p_name: "Fictional Manager", p_role: "manager", p_capabilities: ["crm.read", "leads.qualify"] })
    expect(invite.error).toBeNull()
    expect((await manager.rpc("team_accept_invite", { p_token: invite.data.token })).error).toBeNull()
  })
  afterAll(async () => { for (const s of [shop, other, foreign]) if (s) await cleanup(db, s) })

  describe("unknown versus reviewed completeness", () => {
    it("a linked lead with nothing recorded is explicitly not started, with every field unknown", async () => {
      const lead = await linkedLead()
      const r = await read(lead.workflowId)
      expect(r.error).toBeNull()
      const q = qualificationSchema.parse(r.data)
      expect(q).toMatchObject({ revision: 0, review_state: "not_started", recorded_review_state: null, review_reasons: [], completeness: "incomplete", updated_at: null, updated_by: null, can_update: true })
      expect(q.fields).toEqual(unknownQualificationFields())
      expect(q.missing).toEqual(["service", "vehicle_condition", "timing", "location", "constraints"])
      expect(q.identity).toMatchObject({ state: "identity_linked", customer_id: lead.customerId, vehicle_id: lead.vehicleId, vehicle_status: "confirmed" })
      expect((await db.from("lead_qualifications").select("workflow_id").eq("workflow_id", lead.workflowId)).error).not.toBeNull()
    })
    it("a reviewed record with unknown answers is reviewed, and still incomplete", async () => {
      const lead = await linkedLead()
      const saved = await update(command(lead, { p_review_state: "reviewed" }))
      expect(saved.error).toBeNull()
      qualificationSchema.parse(saved.data)
      expect(saved.data).toMatchObject({ status: "recorded", revision: 1, review_state: "reviewed", completeness: "incomplete", updated_by: { actor_id: shop.ownerId, role: "owner", label: "Owner" } })
      expect(saved.data.missing).toEqual(["service", "vehicle_condition", "timing", "location", "constraints"])
    })
    it("complete requires every answer known, no open question and a confirmed vehicle; review state is separate", async () => {
      const lead = await linkedLead()
      const question = { id: randomUUID(), text: "Is the vehicle garage kept?", status: "open", answer: null }
      const first = await update(command(lead, { p_fields: filled(), p_open_questions: [question] }))
      expect(first.data).toMatchObject({ review_state: "in_progress", completeness: "incomplete", missing: ["open_questions"] })
      const second = await update(command(lead, { p_revision: 1, p_fields: filled(), p_open_questions: [{ ...question, status: "answered", answer: "Yes, garage kept" }] }))
      // Known answers are complete even though nobody has marked the record reviewed.
      expect(second.data).toMatchObject({ revision: 2, review_state: "in_progress", completeness: "complete", missing: [] })
      const third = await update(command(lead, { p_revision: 2, p_review_state: "reviewed", p_fields: filled(), p_open_questions: [{ ...question, status: "dropped" }] }))
      expect(third.data).toMatchObject({ revision: 3, review_state: "reviewed", completeness: "complete" })
      // "No constraints" was reviewed as an empty list; unknown constraints are not the same thing.
      const unknownConstraints = { ...filled(), constraints: unknownQualificationFields().constraints }
      expect((await update(command(lead, { p_revision: 3, p_review_state: "reviewed", p_fields: unknownConstraints }))).data).toMatchObject({ completeness: "incomplete", missing: ["constraints"] })
    })
    it("without a confirmed vehicle the record can be saved but is never complete", async () => {
      const lead = await linkedLead(false)
      const saved = await update(command(lead, { p_review_state: "reviewed", p_fields: filled() }))
      expect(saved.error).toBeNull()
      expect(saved.data).toMatchObject({ review_state: "reviewed", completeness: "incomplete", missing: ["vehicle"], identity: { vehicle_status: "unresolved", vehicle_id: null } })
    })
  })

  describe("unresolved intake stays in identity review", () => {
    it("cannot be qualified, and qualification creates no identity, consent or external effect", async () => {
      const c = await customer(), w = await intake(randomUUID())
      const before = await sideEffects()
      const lead = { workflowId: w.workflowId, customerId: c.id as string, customer: c, vehicleId: null, thread: "" }
      const refused = await update(command(lead, { p_fields: filled() }))
      expect(refused.error).toMatchObject({ code: "PT409", details: "identity_review_required" })
      const r = await read(w.workflowId)
      expect(r.data).toMatchObject({ revision: 0, review_state: "not_started", review_reasons: ["identity_in_review"], identity: { state: "identity_review", customer_id: null, customer_name: null } })
      expect((await list()).data.items.map((x: { workflow_id: string }) => x.workflow_id)).not.toContain(w.workflowId)
      expect(await sideEffects()).toBe(before)
    })
    it("recording and reading a qualification changes nothing outside the qualification tables", async () => {
      const lead = await linkedLead()
      const before = await sideEffects()
      expect((await update(command(lead, { p_review_state: "reviewed", p_fields: filled() }))).error).toBeNull()
      for (const call of [read(lead.workflowId), list(), history(lead.workflowId)]) expect((await call).error).toBeNull()
      expect(await sideEffects()).toBe(before)
    })
  })

  describe("a qualification is only current against what was reviewed", () => {
    it("new evidence reopens identity review and marks the record as needing review without discarding it", async () => {
      const lead = await linkedLead()
      expect((await update(command(lead, { p_review_state: "reviewed", p_fields: filled() }))).data.review_state).toBe("reviewed")
      await intake(lead.thread, "2026-10-09T01:00:00Z")
      const reopened = await read(lead.workflowId)
      expect(reopened.data).toMatchObject({ revision: 1, review_state: "needs_review", recorded_review_state: "reviewed", completeness: "incomplete" })
      expect(reopened.data.review_reasons).toEqual(["identity_in_review", "vehicle_changed", "new_evidence"])
      expect(reopened.data.fields).toEqual(filled())
      expect((await update(command(lead, { p_revision: 1, p_fields: filled() }))).error).toMatchObject({ code: "PT409", details: "identity_review_required" })
      // Relinking the same customer does not by itself make the old review current.
      const w = await db.from("lead_workflows").select("revision").eq("id", lead.workflowId).single()
      const fresh = await db.from("customers").select("id,name,phone,email,updated_at").eq("id", lead.customerId).single()
      expect((await owner.rpc("link_intake_customer", { p_shop: shop.shopId, p_workflow: lead.workflowId, p_revision: w.data!.revision, p_customer: lead.customerId, p_snapshot: fresh.data, p_command: randomUUID() })).error).toBeNull()
      expect((await read(lead.workflowId)).data).toMatchObject({ review_state: "needs_review", review_reasons: ["vehicle_changed", "new_evidence"] })
      // The vehicle link was cleared by the reopen, so the stale vehicle binding is refused.
      expect((await update(command(lead, { p_revision: 1, p_fields: filled() }))).error).toMatchObject({ code: "PT409", details: "vehicle_changed" })
      const again = await update(command({ ...lead, vehicleId: null }, { p_revision: 1, p_review_state: "reviewed", p_fields: filled() }))
      expect(again.data).toMatchObject({ revision: 2, review_state: "reviewed", review_reasons: [], missing: ["vehicle"] })
    })
    it("an edited vehicle, a deleted customer and a merged customer each require a fresh review", async () => {
      const edited = await linkedLead()
      expect((await update(command(edited, { p_review_state: "reviewed", p_fields: filled() }))).error).toBeNull()
      expect((await db.from("vehicles").update({ color: "Fictional red", updated_at: new Date().toISOString() }).eq("id", edited.vehicleId!)).error).toBeNull()
      expect((await read(edited.workflowId)).data).toMatchObject({ review_state: "needs_review", review_reasons: ["vehicle_changed"], identity: { vehicle_status: "needs_review", vehicle: null } })
      expect((await update(command(edited, { p_revision: 1, p_fields: filled() }))).error).toMatchObject({ code: "PT409", details: "vehicle_changed" })

      const merged = await linkedLead(false), survivor = await customer(shop.shopId, "Fictional Survivor")
      expect((await update(command(merged, { p_review_state: "reviewed", p_fields: filled() }))).error).toBeNull()
      expect((await owner.rpc("merge_customers_atomic", { p_shop: shop.shopId, p_winner: survivor.id, p_loser: merged.customerId })).error).toBeNull()
      expect((await read(merged.workflowId)).data).toMatchObject({ review_state: "needs_review", review_reasons: ["customer_changed"], identity: { customer_id: survivor.id } })
      expect((await update(command(merged, { p_revision: 1, p_fields: filled() }))).error).toMatchObject({ code: "42501", details: "customer_unavailable" })
      expect((await update(command({ ...merged, customerId: survivor.id }, { p_revision: 1, p_review_state: "reviewed", p_fields: filled() }))).data).toMatchObject({ revision: 2, review_state: "reviewed", review_reasons: [] })

      const deleted = await linkedLead(false)
      expect((await update(command(deleted, { p_review_state: "reviewed", p_fields: filled() }))).error).toBeNull()
      expect((await db.from("customers").delete().eq("id", deleted.customerId)).error).toBeNull()
      expect((await read(deleted.workflowId)).data).toMatchObject({ review_state: "needs_review", review_reasons: ["identity_in_review"], identity: { customer_id: null }, fields: filled() })
    })
  })

  describe("authority", () => {
    it("delegated manager can record; attribution shows the manager; read-only manager can read but not write", async () => {
      expect((await grant(["crm.read", "leads.qualify"])).error).toBeNull()
      const lead = await linkedLead()
      const saved = await update(command(lead, { p_fields: filled() }), manager)
      expect(saved.error).toBeNull()
      expect(saved.data).toMatchObject({ status: "recorded", can_update: true, updated_by: { actor_id: other.ownerId, role: "manager", label: "Fictional Manager" } })
      const h = qualificationHistorySchema.parse((await history(lead.workflowId, manager)).data)
      expect(h.items).toHaveLength(1)
      expect(h.items[0]).toMatchObject({ revision: 1, actor_id: other.ownerId, actor_role: "manager", reviewed_customer_id: lead.customerId, reviewed_vehicle_id: lead.vehicleId })

      expect((await grant(["crm.read", "assignments.manage", "notes.write", "jobs.progress", "delivery.reconcile", "approvals.messages"])).error).toBeNull()
      expect((await read(lead.workflowId, manager)).data).toMatchObject({ revision: 1, can_update: false })
      expect((await list(manager)).data.can_update).toBe(false)
      expect((await update(command(lead, { p_revision: 1 }), manager)).error?.code).toBe("42501")
      expect((await read(lead.workflowId)).data.revision).toBe(1)
    })
    it("the grant cannot exist without customer read access or on a staff membership", async () => {
      expect((await grant(["leads.qualify"])).error).not.toBeNull()
      expect((await grant(["crm.read", "leads.qualify"], "staff")).error).not.toBeNull()
      const invite = (capabilities: string[]) => owner.rpc("team_invite", { p_shop: shop.shopId, p_email: `qualify-${randomUUID()}@example.test`, p_name: "Fictional Invitee", p_role: "manager", p_capabilities: capabilities })
      expect((await invite(["leads.qualify"])).error).not.toBeNull()
      expect((await invite(["crm.read", "leads.qualify"])).error).toBeNull()
    })
    it("staff, even when assigned to the customer, revoked members, foreign owners, anonymous and service callers get nothing", async () => {
      const lead = await linkedLead()
      expect((await update(command(lead, { p_fields: filled() }))).error).toBeNull()
      const member = await db.from("shop_memberships").select("id").eq("shop_id", shop.shopId).eq("user_id", other.ownerId).single()
      const denied = async (client: SupabaseClient, label: string) => {
        for (const call of [read(lead.workflowId, client), list(client), history(lead.workflowId, client), update(command(lead, { p_revision: 1 }), client)])
          expect((await call).error, label).not.toBeNull()
      }
      expect((await grant([], "staff")).error).toBeNull()
      expect((await db.from("shop_assignments").insert({ shop_id: shop.shopId, member_id: member.data!.id, customer_id: lead.customerId })).error).toBeNull()
      await denied(manager, "assigned staff")
      expect((await db.from("shop_assignments").delete().eq("member_id", member.data!.id)).error).toBeNull()
      expect((await grant(["crm.read", "leads.qualify"], "manager", false)).error).toBeNull()
      await denied(manager, "revoked manager")
      await denied(foreignOwner, "foreign owner")
      await denied(anonClient(), "anonymous")
      await denied(db, "sessionless service role")
      for (const table of ["lead_qualifications", "lead_qualification_revisions"])
        for (const client of [owner, manager, anonClient(), db]) {
          expect((await client.from(table).select("*")).error).not.toBeNull()
          expect((await client.from(table).update({ review_state: "reviewed" }).eq("workflow_id", lead.workflowId)).error).not.toBeNull()
          expect((await client.from(table).delete().eq("workflow_id", lead.workflowId)).error).not.toBeNull()
        }
      expect((await read(lead.workflowId)).data).toMatchObject({ revision: 1, updated_by: { role: "owner" } })
      expect((await grant(["crm.read", "leads.qualify"])).error).toBeNull()
    })
    it("revocation applies to the next command, including an exact retry", async () => {
      expect((await grant(["crm.read", "leads.qualify"])).error).toBeNull()
      const lead = await linkedLead(), c = command(lead, { p_fields: filled() })
      expect((await update(c, manager)).data.status).toBe("recorded")
      expect((await update(c, manager)).data.status).toBe("already_recorded")
      expect((await grant(["crm.read"])).error).toBeNull()
      expect((await update(c, manager)).error?.code).toBe("42501")
      expect((await grant(["crm.read", "leads.qualify"])).error).toBeNull()
    })
  })

  describe("no data crosses shops", () => {
    it("another shop's workflow, customer, vehicle and service are all refused, and nothing leaks into lists", async () => {
      const lead = await linkedLead()
      expect((await update(command(lead, { p_fields: filled() }))).error).toBeNull()
      const foreignCustomer = await customer(foreign.shopId, "Fictional Foreign"), foreignVehicle = await vehicle(foreignCustomer.id, foreign.shopId)
      const elsewhere = await customer(shop.shopId, "Fictional Other Customer"), elsewhereVehicle = await vehicle(elsewhere.id)

      // The foreign owner cannot see or touch this shop's workflow through their own shop id.
      expect((await read(lead.workflowId, foreignOwner, foreign.shopId)).error?.code).toBe("42501")
      expect((await foreignOwner.rpc("update_lead_qualification", { ...command(lead, { p_revision: 1 }), p_shop: foreign.shopId })).error?.code).toBe("42501")
      expect((await list(foreignOwner, foreign.shopId)).data.items).toEqual([])
      expect((await foreignOwner.rpc("read_lead_qualification_history", { p_shop: foreign.shopId, p_workflow: lead.workflowId, p_offset: 0 })).error?.code).toBe("42501")

      const next = (patch: Record<string, unknown>) => update(command(lead, { p_revision: 1, p_fields: filled(), ...patch }))
      expect((await next({ p_customer: foreignCustomer.id })).error).toMatchObject({ code: "42501", details: "customer_unavailable" })
      expect((await next({ p_vehicle: foreignVehicle })).error).toMatchObject({ code: "42501", details: "vehicle_unavailable" })
      // Owned by this shop, but not this customer's vehicle.
      expect((await next({ p_vehicle: elsewhereVehicle })).error).toMatchObject({ code: "42501", details: "vehicle_unavailable" })
      // A real customer of this shop who is not the reviewed link on this workflow.
      expect((await next({ p_customer: elsewhere.id, p_vehicle: null })).error).toMatchObject({ code: "PT409", details: "customer_changed" })
      expect((await next({ p_fields: { ...filled(), service: { ...filled().service, service_id: foreign.serviceId } } })).error).toMatchObject({ code: "42501", details: "service_unavailable" })
      expect((await read(lead.workflowId)).data.revision).toBe(1)
      expect(JSON.stringify((await list(foreignOwner, foreign.shopId)).data)).not.toContain(lead.customerId)
    })
  })

  describe("malformed input", () => {
    it("refuses every invalid document with the path that failed and records nothing", async () => {
      const lead = await linkedLead(), f = filled()
      const bad: Array<[string, Record<string, unknown>]> = [
        ["command", { p_command: null }], ["command", { p_revision: -1 }], ["command", { p_customer: null }],
        ["review_state", { p_review_state: "complete" }], ["review_state", { p_review_state: null }],
        ["fields", { p_fields: null }], ["fields", { p_fields: [] }],
        ["fields", { p_fields: { ...f, extra: f.service } }],
        ["fields", { p_fields: { service: f.service, timing: f.timing, location: f.location, constraints: f.constraints } }],
        ["fields.service", { p_fields: { ...f, service: { ...f.service, price_cents: 100 } } }],
        ["fields.service", { p_fields: { ...f, service: { status: "reported", source: "customer", evidence_revision: null, text: "Detail" } } }],
        ["fields.service.status", { p_fields: { ...f, service: { ...f.service, status: "complete" } } }],
        ["fields.service.source", { p_fields: { ...f, service: { ...f.service, source: "model" } } }],
        ["fields.service.source", { p_fields: { ...f, service: { ...f.service, source: null } } }],
        ["fields.service", { p_fields: { ...f, service: { ...f.service, service_id: null, text: null } } }],
        ["fields.service", { p_fields: { ...f, service: { ...unknownQualificationFields().service, text: "Detail" } } }],
        ["fields.service.service_id", { p_fields: { ...f, service: { ...f.service, service_id: "not-a-uuid" } } }],
        ["fields.service.text", { p_fields: { ...f, service: { ...f.service, text: " padded " } } }],
        ["fields.service.text", { p_fields: { ...f, service: { ...f.service, text: "x".repeat(201) } } }],
        ["fields.service.evidence_revision", { p_fields: { ...f, service: { ...f.service, source: "intake", evidence_revision: null } } }],
        ["fields.service.evidence_revision", { p_fields: { ...f, service: { ...f.service, evidence_revision: 1 } } }],
        ["fields.service.evidence_revision", { p_fields: { ...f, service: { ...f.service, source: "intake", evidence_revision: 99 } } }],
        ["fields.vehicle_condition.text", { p_fields: { ...f, vehicle_condition: { ...f.vehicle_condition, text: null } } }],
        ["fields.vehicle_condition.text", { p_fields: { ...f, vehicle_condition: { ...f.vehicle_condition, text: "hidden\u0001control" } } }],
        ["fields.timing.earliest", { p_fields: { ...f, timing: { ...f.timing, earliest: "next week" } } }],
        ["fields.timing", { p_fields: { ...f, timing: { ...f.timing, earliest: "2026-02-31" } } }],
        ["fields.timing.latest", { p_fields: { ...f, timing: { ...f.timing, earliest: "2026-11-02", latest: "2026-11-01" } } }],
        ["fields.timing", { p_fields: { ...f, timing: { ...f.timing, earliest: null, latest: null, text: null } } }],
        ["fields.location.type", { p_fields: { ...f, location: { ...f.location, type: "anywhere" } } }],
        ["fields.location", { p_fields: { ...f, location: { ...f.location, type: null } } }],
        ["fields.constraints.items", { p_fields: { ...f, constraints: { ...unknownQualificationFields().constraints, items: ["Gate code needed"] } } }],
        ["fields.constraints.items", { p_fields: { ...f, constraints: { ...f.constraints, items: Array(11).fill("Fictional constraint") } } }],
        ["fields.constraints.items", { p_fields: { ...f, constraints: { ...f.constraints, items: [""] } } }],
        ["open_questions", { p_open_questions: null }], ["open_questions", { p_open_questions: {} }],
        ["open_questions", { p_open_questions: Array.from({ length: 21 }, () => ({ id: randomUUID(), text: "Fictional question", status: "open", answer: null })) }],
        ["open_questions", { p_open_questions: [{ id: randomUUID(), text: "Fictional question", status: "open" }] }],
        ["open_questions.id", { p_open_questions: [{ id: "one", text: "Fictional question", status: "open", answer: null }] }],
        ["open_questions.id", { p_open_questions: [1, 2].map(() => ({ id: "00000000-0000-4000-8000-000000000001", text: "Fictional question", status: "open", answer: null })) }],
        ["open_questions.status", { p_open_questions: [{ id: randomUUID(), text: "Fictional question", status: "closed", answer: null }] }],
        ["open_questions.answer", { p_open_questions: [{ id: randomUUID(), text: "Fictional question", status: "answered", answer: null }] }],
        ["open_questions.answer", { p_open_questions: [{ id: randomUUID(), text: "Fictional question", status: "open", answer: "Premature" }] }],
      ]
      for (const [path, patch] of bad) {
        const r = await update(command(lead, { p_fields: f, ...patch }))
        expect(r.error, `${path} ${JSON.stringify(patch).slice(0, 120)}`).toMatchObject({ code: "22023", details: path })
      }
      expect((await read(lead.workflowId)).data).toMatchObject({ revision: 0, review_state: "not_started" })
      for (const call of [list(owner, shop.shopId, -1), history(lead.workflowId, owner, -1), history(lead.workflowId, owner, 100001)]) expect((await call).error?.code).toBe("22023")
    })
    it("accepts intake provenance only for a real submission on this workflow", async () => {
      const lead = await linkedLead(), f = filled()
      const cited = { ...f, service: { ...f.service, source: "intake", evidence_revision: 1 } }
      expect((await update(command(lead, { p_fields: cited }))).data.fields.service).toMatchObject({ source: "intake", evidence_revision: 1 })
      // Revision 2 exists on this workflow but is an identity decision, not a submission.
      const decision = { ...f, service: { ...f.service, source: "intake", evidence_revision: 2 } }
      expect((await update(command(lead, { p_revision: 1, p_fields: decision }))).error).toMatchObject({ code: "22023", details: "fields.service.evidence_revision" })
    })
  })

  describe("concurrency, replay and audit", () => {
    it("an exact retry is recorded once across independent sessions; a changed payload under the same id is refused", async () => {
      const lead = await linkedLead(), c = command(lead, { p_fields: filled() })
      const results = await Promise.all([update(c), update(c, ownerReload)])
      expect(results.map((r) => r.data?.status).sort()).toEqual(["already_recorded", "recorded"])
      expect((await update(c, ownerReload)).data).toMatchObject({ status: "already_recorded", revision: 1 })
      for (const patch of [{ p_review_state: "reviewed" }, { p_open_questions: [{ id: randomUUID(), text: "Changed", status: "open", answer: null }] }, { p_fields: unknownQualificationFields() }, { p_revision: 1 }])
        expect((await update({ ...c, ...patch })).error).toMatchObject({ code: "PT409", details: "command_conflict" })
      // The same id from another reviewer, or aimed at another workflow, is also a conflict.
      expect((await grant(["crm.read", "leads.qualify"])).error).toBeNull()
      expect((await update(c, manager)).error).toMatchObject({ code: "PT409", details: "command_conflict" })
      const elsewhere = await linkedLead()
      expect((await update({ ...command(elsewhere, { p_fields: filled() }), p_command: c.p_command })).error).toMatchObject({ code: "PT409", details: "command_conflict" })
      expect(qualificationHistorySchema.parse((await history(lead.workflowId)).data).items).toHaveLength(1)
      expect((await read(elsewhere.workflowId)).data.revision).toBe(0)
    })
    it("competing edits from the same revision have exactly one winner; the loser must refresh", async () => {
      expect((await grant(["crm.read", "leads.qualify"])).error).toBeNull()
      const lead = await linkedLead()
      const results = await Promise.all([update(command(lead, { p_fields: filled() })), update(command(lead, { p_review_state: "reviewed" }), manager)])
      expect(results.filter((r) => !r.error)).toHaveLength(1)
      expect(results.find((r) => r.error)?.error).toMatchObject({ code: "PT409", details: "revision_conflict" })
      expect((await read(lead.workflowId)).data.revision).toBe(1)
      expect((await update(command(lead, { p_revision: 5 }))).error).toMatchObject({ code: "PT409", details: "revision_conflict" })
      expect((await update(command(lead, { p_revision: 1, p_review_state: "reviewed", p_fields: filled() }))).data.revision).toBe(2)
    })
    it("an audit failure rolls back the record, on first save and on a later edit", async () => {
      const lead = await linkedLead()
      const poisoned = { ...filled(), vehicle_condition: { ...filled().vehicle_condition, text: "INJECT_QUALIFICATION_FAILURE" } }
      expect((await update(command(lead, { p_fields: poisoned }))).error).not.toBeNull()
      expect((await read(lead.workflowId)).data).toMatchObject({ revision: 0, review_state: "not_started" })
      expect(qualificationHistorySchema.parse((await history(lead.workflowId)).data)).toEqual({ revision: 0, items: [] })

      expect((await update(command(lead, { p_fields: filled() }))).data.revision).toBe(1)
      const failed = command(lead, { p_revision: 1, p_review_state: "reviewed", p_fields: poisoned })
      expect((await update(failed)).error).not.toBeNull()
      expect((await read(lead.workflowId)).data).toMatchObject({ revision: 1, review_state: "in_progress", fields: filled() })
      // The failed command left no audit row, so its id is free and the revision is unchanged.
      expect((await update({ ...failed, p_fields: filled() })).data).toMatchObject({ status: "recorded", revision: 2, review_state: "reviewed" })
    })
    it("history is append-only, bounded and newest first, and the list is bounded without documents", async () => {
      const lead = await linkedLead()
      for (let i = 0; i < 23; i++) expect((await update(command(lead, { p_revision: i, p_fields: filled() }))).error, String(i)).toBeNull()
      const first = qualificationHistorySchema.parse((await history(lead.workflowId)).data), second = qualificationHistorySchema.parse((await history(lead.workflowId, owner, 20)).data)
      expect(first.revision).toBe(23); expect(first.items).toHaveLength(21); expect(first.items[0].revision).toBe(23)
      expect(second.items.map((x) => x.revision)).toEqual([3, 2, 1])
      const page = qualificationListSchema.parse((await list()).data)
      expect(page.items.length).toBeLessThanOrEqual(21)
      expect(page.items[0]).toMatchObject({ workflow_id: lead.workflowId, revision: 23 })
      expect(JSON.stringify(page)).not.toContain("Light swirl marks")
      expect((await list(owner, shop.shopId, 100000)).data.items).toEqual([])
    })
  })
})
